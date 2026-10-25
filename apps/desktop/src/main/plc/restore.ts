import { isRestorableSdb, parseBlockFile } from '@baaportal/s7comm';
import type { BackupManifest } from '@baaportal/project';
import type { RestoreRow } from '@baaportal/ui';

export type RestoreType = 'OB' | 'FB' | 'FC' | 'DB' | 'SDB';

export interface RestoreStep {
  kind: 'deleteSdb' | 'load';
  type: RestoreType;
  number: number;
  /** Il file del blocco da caricare (solo `load`). */
  file?: Uint8Array;
}

export interface RestorePlan {
  steps: RestoreStep[];
  /** Blocchi che il ripristino non tocca, con il motivo. */
  skipped: { type: RestoreType; number: number; why: string }[];
  /** Blocchi utente presenti solo sulla CPU: restano. */
  cpuOnly: { type: RestoreType; number: number }[];
}

const USER_ORDER: RestoreType[] = ['DB', 'FC', 'FB', 'OB'];

/** Nome come nelle righe di conferma: gli SDB con lo spazio (`SDB 7`), gli altri attaccati (`OB1`). */
export const stepName = (type: RestoreType, number: number): string =>
  type === 'SDB' ? `SDB ${number}` : `${type}${number}`;

const byNumberLastFirst = (last: number) => (a: number, b: number) =>
  (a === last ? 1 : 0) - (b === last ? 1 : 0) || a - b;

/**
 * Piano del ripristino (proto §19.5), puro: nessuna rete. `files` ha i byte dei blocchi per
 * percorso (come `decodeBackup`); `online` sono i blocchi che la CPU ha adesso (SDB compresi).
 * Dà il piano o il motivo del rifiuto.
 */
export function planRestore(
  manifest: BackupManifest,
  files: Record<string, Uint8Array>,
  online: readonly { type: string; number: number }[],
): RestorePlan | string {
  // Un blocco non letto dal backup non è un blocco assente: non si ripristina niente (§19.5)
  const failedSdb = manifest.failed.find((f) => f.type === 'SDB');
  if (failedSdb) {
    return `SDB ${failedSdb.number} non letto durante il backup: ripristino non possibile`;
  }
  if (manifest.failed.length > 0) {
    const list = manifest.failed.map((f) => stepName(f.type, f.number)).join(', ');
    return `Backup incompleto: blocchi non letti durante il backup (${list}). Ripristino non possibile`;
  }
  const backup = new Map<string, { type: RestoreType; number: number; file: Uint8Array }>();
  const skipped: RestorePlan['skipped'] = [];
  for (const b of manifest.blocks) {
    const bytes = files[b.file];
    if (!bytes) return `File mancante nel backup (${b.file})`;
    try {
      const h = parseBlockFile(bytes).header;
      if (h.type !== b.type || h.number !== b.number) {
        return `${b.file} contiene ${h.type ?? '?'}${h.number} ma il manifest dice ${b.type}${b.number}: backup non coerente`;
      }
    } catch (e) {
      return `${b.file} non è un file di blocco valido: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (b.type === 'SDB') {
      if (b.number === 2) {
        skipped.push({ type: 'SDB', number: 2, why: 'creato dalla CPU' });
        continue;
      }
      if (!isRestorableSdb(b.number)) {
        return `SDB ${b.number} fuori dagli intervalli documentati: ripristino non possibile`;
      }
    }
    backup.set(`${b.type}${b.number}`, { type: b.type, number: b.number, file: bytes });
  }

  // Senza SDB 0 nel backup, quello della CPU resterebbe cancellato o scollegato dal resto
  if (!backup.has('SDB0') && online.some((o) => o.type === 'SDB' && o.number === 0)) {
    return 'La CPU ha SDB 0 ma il backup no: ripristino non possibile';
  }
  const steps: RestoreStep[] = [];
  const cpuSdb = online
    .filter((o) => o.type === 'SDB')
    .map((o) => o.number)
    .sort((a, b) => a - b);
  for (const n of cpuSdb) {
    if (backup.has(`SDB${n}`) || n === 2) continue;
    if (isRestorableSdb(n)) steps.push({ kind: 'deleteSdb', type: 'SDB', number: n });
    else {
      skipped.push({
        type: 'SDB',
        number: n,
        why: 'fuori dagli intervalli documentati: lasciato sulla CPU',
      });
    }
  }
  const sdbs = [...backup.values()].filter((b) => b.type === 'SDB');
  for (const n of sdbs.map((b) => b.number).sort(byNumberLastFirst(0))) {
    steps.push({ kind: 'load', type: 'SDB', number: n, file: backup.get(`SDB${n}`)!.file });
  }
  for (const type of USER_ORDER) {
    const nums = [...backup.values()]
      .filter((b) => b.type === type)
      .map((b) => b.number)
      .sort(type === 'OB' ? byNumberLastFirst(1) : (a, b) => a - b);
    for (const n of nums) {
      steps.push({ kind: 'load', type, number: n, file: backup.get(`${type}${n}`)!.file });
    }
  }
  // SDB 2 lo crea la CPU: se c'è solo online, si dice lo stesso che non si tocca
  if (cpuSdb.includes(2) && !skipped.some((k) => k.type === 'SDB' && k.number === 2)) {
    skipped.push({ type: 'SDB', number: 2, why: 'creato dalla CPU' });
  }
  const cpuOnly: RestorePlan['cpuOnly'] = [];
  for (const o of online) {
    if (!USER_ORDER.includes(o.type as RestoreType) || backup.has(`${o.type}${o.number}`)) continue;
    cpuOnly.push({ type: o.type as RestoreType, number: o.number });
  }
  cpuOnly.sort(
    (a, b) => USER_ORDER.indexOf(a.type) - USER_ORDER.indexOf(b.type) || a.number - b.number,
  );
  return { steps, skipped, cpuOnly };
}

/** Le righe della conferma, costruite dal piano: mai dal renderer. */
export function restoreLines(plan: RestorePlan): string[] {
  return [
    ...plan.steps.map((s) =>
      s.kind === 'deleteSdb'
        ? `Cancella ${stepName(s.type, s.number)}`
        : `Carica ${stepName(s.type, s.number)}`,
    ),
    ...plan.skipped.map((k) => `Non toccato: ${stepName(k.type, k.number)} (${k.why})`),
    ...plan.cpuOnly.map((b) => `Restano nella CPU: ${b.type} ${b.number}`),
  ];
}

/** Le righe che vede l'utente prima di decidere. */
export function restoreRows(plan: RestorePlan): RestoreRow[] {
  return [
    ...plan.steps.map<RestoreRow>((s) => ({
      name: stepName(s.type, s.number),
      action: s.kind === 'deleteSdb' ? 'delete' : 'load',
    })),
    ...plan.skipped.map<RestoreRow>((s) => ({
      name: stepName(s.type, s.number),
      action: 'skip',
      why: s.why,
    })),
    ...plan.cpuOnly.map<RestoreRow>((b) => ({ name: stepName(b.type, b.number), action: 'keep' })),
  ];
}
