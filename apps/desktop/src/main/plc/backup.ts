import { createHash } from 'node:crypto';
import type { PlcBackupResult, PlcIdentity } from '@baaportal/ui';
import {
  backupFileName,
  encodeBackup,
  type BackupBlockEntry,
  type BackupManifest,
} from '@baaportal/project';
import { writeFileAtomic } from '../fsAtomic';
import type { PlcOwner, PlcService } from './plcService';
import { BACKUP_TYPES, type UploadOwner, type UploadService } from './uploadAll';

export type BackupOwner = UploadOwner & PlcOwner;

/** Finestra di salvataggio nativa: il percorso scelto, o `null` se l'utente annulla. */
export type PickBackupPath = (owner: BackupOwner, defaultName: string) => Promise<string | null>;

export interface BackupServiceOptions {
  service: PlcService;
  uploads: UploadService;
  pick: PickBackupPath;
  appVersion?: () => string;
  now?: () => Date;
  write?: (path: string, data: Uint8Array) => Promise<void>;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `‹modulo›_AAAAMMGG-hhmm.baapbak`, con il nome del modulo ripulito per il file system. */
export function suggestedBackupName(identity: PlcIdentity, at: Date): string {
  const module = (identity.moduleName ?? identity.orderNumber)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `${module || 'CPU'}_${stamp}.baapbak`;
}

const sameCpu = (a: PlcIdentity, b: PlcIdentity): boolean =>
  a.orderNumber === b.orderNumber &&
  a.serial === b.serial &&
  a.moduleName === b.moduleName &&
  a.firmware === b.firmware;

/**
 * Backup online (solo esportazione): OB, FB, FC, DB e SDB della CPU collegata alla finestra in un
 * file `.baapbak`. Collegamento proprio in sola lettura (la sorveglianza non si ferma); il file si
 * scrive solo a caricamento finito, in un temporaneo accanto e poi rinominato.
 */
export class BackupService {
  private readonly running = new Map<BackupOwner, { cancelled: boolean }>();

  constructor(private readonly o: BackupServiceOptions) {}

  /** Interrompe anche mentre la finestra di salvataggio è aperta (prima del collegamento). */
  cancel(owner: BackupOwner): void {
    const st = this.running.get(owner);
    if (st) st.cancelled = true;
    this.o.uploads.cancel(owner);
  }

  /** Uscita dall'app: nessun backup prosegue dopo la finestra di salvataggio. */
  abortAll(): void {
    for (const owner of [...this.running.keys()]) this.cancel(owner);
  }

  async backup(owner: BackupOwner): Promise<PlcBackupResult> {
    if (this.running.has(owner)) return { ok: false, error: 'Un backup è già in corso' };
    const state = { cancelled: false };
    this.running.set(owner, state);
    try {
      return await this.run(owner, state);
    } finally {
      this.running.delete(owner);
    }
  }

  private async run(owner: BackupOwner, state: { cancelled: boolean }): Promise<PlcBackupResult> {
    const target = this.o.service.target(owner);
    if (!target) return { ok: false, error: 'Nessun collegamento online' };
    const at = (this.o.now ?? (() => new Date()))();
    const path = await this.o.pick(owner, suggestedBackupName(target.identity, at));
    if (path === null || state.cancelled || owner.isDestroyed())
      return { ok: false, cancelled: true };
    // Durante la finestra il collegamento può essere caduto o cambiato: si rilegge il bersaglio.
    const now = this.o.service.target(owner);
    if (!now || now.linkId !== target.linkId)
      return { ok: false, error: 'Nessun collegamento online' };

    const r = await this.o.uploads.collect(owner, target.access, {
      types: BACKUP_TYPES,
      verifyIdentity: (id) =>
        sameCpu(id, target.identity)
          ? undefined
          : 'La CPU raggiunta è diversa da quella del collegamento online: backup annullato',
    });
    if (!r.ok) return r;
    if (r.files.length === 0) {
      const first = r.failed
        .slice(0, 3)
        .map((f) => `${f.type}${f.number}: ${f.error}`)
        .join('; ');
      return {
        ok: false,
        error: `Nessun blocco copiato${first ? `: ${first}` : ': la CPU non ne ha elencati'}`,
      };
    }

    const entries: BackupBlockEntry[] = [];
    const files: Record<string, Uint8Array> = {};
    for (const f of r.files) {
      const file = backupFileName(f.type, f.number);
      files[file] = f.bytes;
      entries.push({
        type: f.type,
        number: f.number,
        file,
        length: f.bytes.length,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
      });
    }
    const id = target.identity;
    const manifest: BackupManifest = {
      format: 'baaportal-backup',
      version: 1,
      createdAt: at.toISOString(),
      app: (this.o.appVersion ?? (() => ''))(),
      cpu: {
        orderNumber: id.orderNumber,
        ...(id.serial !== undefined ? { serial: id.serial } : {}),
        ...(id.moduleName !== undefined ? { moduleName: id.moduleName } : {}),
        ...(id.firmware !== undefined ? { firmware: id.firmware } : {}),
        host: target.access.host,
        port: target.access.port ?? 102,
        rack: target.access.rack,
        slot: target.access.slot,
      },
      mode: this.o.service.modeOf(owner) ?? 'UNKNOWN',
      blocks: entries,
      failed: r.failed,
    };
    try {
      await (this.o.write ?? writeFileAtomic)(path, encodeBackup(manifest, files));
    } catch (e) {
      return {
        ok: false,
        error: `Scrittura del file non riuscita: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true, path, count: entries.length, failed: r.failed };
  }
}
