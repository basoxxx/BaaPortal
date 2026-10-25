import type { StoreApi } from 'zustand/vanilla';
import { CPU_CATALOG, findCpu, findCpuByOrderNumber, type CpuType } from '@baaportal/catalog';
import {
  applyImport,
  createPlcDevice,
  createProject,
  validateProjectName,
  planImport,
  type ImportNote,
  type PlcDevice,
  type Project,
} from '@baaportal/project';
import type { BaaBridge } from '../bridge';
import { t } from '../i18n';
import type { ProjectService } from '../services/projectService';
import { ids } from '../project/navigation/treeIds';
import type { AppState } from '../state/store';
import type { PlcAccess, PlcIdentity, PlcUploadedFile } from './plcTypes';

/** CPU usata quando il numero di ordinazione non è nel catalogo e la famiglia non è nota. */
const FALLBACK_CPU = 'cpu-315-2-pn-dp';
const TYPE_ORDER = { OB: 0, FB: 1, FC: 2, DB: 3 } as const;
const normFw = (s: string) => s.trim().replace(/^v/i, '').toUpperCase();
/** Motivo breve per il commento del progetto: una riga, al più 80 caratteri. */
const shortReason = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
};
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** Un blocco che il progetto non ha preso (illeggibile): `label` è `OB1`, `DB10`… */
export interface UploadSkipped {
  label: string;
  reason: string;
}

export interface UploadedProject {
  /** La CPU ha dato una versione di firmware non presente nel catalogo (si usa la più recente). */
  firmwareUnknown: boolean;
  project: Project;
  device: PlcDevice;
  /** false: il numero di ordinazione non è nel catalogo, la CPU è generica della stessa famiglia. */
  cpuFound: boolean;
  created: number;
  /** Quanti blocchi mancano (rifiutati dalla CPU o non decodificabili). */
  missing: number;
  skipped: UploadSkipped[];
  notes: ImportNote[];
  warnings: string[];
  /** Nomi dei blocchi importati in sola lettura (non ricodificabili identici). */
  readOnly: string[];
}

/** CPU del catalogo per il numero di ordinazione; altrimenti una della stessa famiglia (6ES7 31x). */
export function cpuFor(orderNumber: string): { cpu: CpuType; orderNumber: string; found: boolean } {
  const hit = findCpuByOrderNumber(orderNumber);
  if (hit) return { cpu: hit.cpu, orderNumber: hit.version.orderNumber, found: true };
  const family = norm(orderNumber).slice(0, 7);
  const same =
    family.length === 7
      ? CPU_CATALOG.find((c) => c.versions.some((v) => norm(v.orderNumber).startsWith(family)))
      : undefined;
  const cpu = same ?? findCpu(FALLBACK_CPU) ?? CPU_CATALOG[0]!;
  return { cpu, orderNumber: cpu.versions[0]?.orderNumber ?? '', found: false };
}

/** Nome del progetto: «Caricato da <modulo> <indirizzo>», ripulito perché sia anche un nome di file. */
export function uploadedProjectName(
  identity: PlcIdentity,
  access: PlcAccess,
  prefix: string,
): string {
  const module = identity.moduleName?.trim() || identity.orderNumber;
  let name = `${prefix} ${module} ${access.host}`.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-');
  name = name.replace(/[. ]+$/, '').slice(0, 128);
  return validateProjectName(name).ok ? name : `${prefix} ${access.host}`.replace(/[. ]+$/, '');
}

/**
 * Dai file della CPU a un progetto nuovo: la CPU del catalogo, i blocchi importati in AWL con
 * `planImport`/`applyImport`, l'accesso salvato nella CPU. Un blocco che non si decodifica non
 * ferma nulla: finisce in `skipped`. Funzione pura (niente rete, niente archivio).
 */
export function buildUploadedProject(input: {
  files: PlcUploadedFile[];
  identity: PlcIdentity;
  access: PlcAccess;
  now: Date;
  /** Blocchi che la CPU non ha dato (errore della CPU), da segnare nel commento del progetto. */
  failed?: { type: string; number: number; error: string }[];
  texts: { defaultTagTable: string; plc: string; namePrefix: string; missing: string };
}): UploadedProject {
  const { files, identity, access } = input;
  const { cpu, orderNumber, found } = cpuFor(identity.orderNumber);
  const known = cpu.versions.find((v) => v.orderNumber === orderNumber)?.firmware ?? [];
  // Il firmware letto dalla CPU, se è nel catalogo (con o senza «V»); altrimenti il più recente.
  const wanted = identity.firmware ? normFw(identity.firmware) : undefined;
  const match = wanted ? known.find((f) => normFw(f) === wanted) : undefined;
  const firmware = match ?? known[0] ?? '';
  const firmwareUnknown = wanted !== undefined && match === undefined;
  const device = createPlcDevice({
    cpu,
    orderNumber,
    firmware,
    name: input.texts.plc,
    texts: { defaultTagTable: input.texts.defaultTagTable },
  });
  device.blocks = []; // il progetto nuovo ha solo i blocchi della CPU (niente OB1 vuoto)
  device.properties.access = { ...access };
  const sorted = [...files].sort(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.number - b.number,
  );
  const plan = planImport(
    device,
    sorted.map((f) => f.bytes),
  );
  applyImport(device, plan);
  const skipped = plan.skipped.map((s) => ({
    label: `${sorted[s.index]!.type}${sorted[s.index]!.number}`,
    reason: s.reason,
  }));
  // Un blocco mancante deve restare scritto nel progetto, anche dopo salvataggio e riapertura.
  const missing = [
    ...(input.failed ?? []).map((f) => `${f.type}${f.number} (${shortReason(f.error)})`),
    ...skipped.map((k) => `${k.label} (${shortReason(k.reason)})`),
  ];
  const project = createProject(
    {
      name: uploadedProjectName(identity, access, input.texts.namePrefix),
      author: '',
      comment: missing.length > 0 ? `${input.texts.missing}: ${missing.join(', ')}` : '',
    },
    input.now,
  );
  project.devices.push(device);
  return {
    firmwareUnknown,
    missing: missing.length,
    project,
    device,
    cpuFound: found,
    created: plan.create.length,
    skipped,
    notes: plan.notes,
    warnings: plan.warnings,
    readOnly: plan.create.filter((b) => b.mc7 && !b.mc7.exact).map((b) => b.name),
  };
}

export interface UploadCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
  service: ProjectService;
}

export type UploadOutcome = 'done' | 'cancelled' | 'failed';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * «Carica dal dispositivo»: carica i blocchi dalla CPU dell'`access` (collegamento proprio, in sola
 * lettura), costruisce un progetto nuovo e lo apre non salvato. Se c'è un progetto con modifiche
 * compare prima la domanda di salvataggio di sempre; se l'utente annulla, il caricato si scarta.
 */
export async function uploadFromDevice(ctx: UploadCtx, access: PlcAccess): Promise<UploadOutcome> {
  const { store, bridge, service } = ctx;
  const push = store.getState().pushMessage;
  let res: Awaited<ReturnType<BaaBridge['plcUploadAll']>>;
  try {
    res = await bridge.plcUploadAll(access);
  } catch (e) {
    res = { ok: false, error: errorText(e) };
  }
  if (!res.ok) {
    if ('cancelled' in res) {
      push({ severity: 'info', textKey: 'messages.uploadCancelled' });
      return 'cancelled';
    }
    push({ severity: 'error', textKey: 'messages.uploadFailed', params: { message: res.error } });
    return 'failed';
  }
  let built: UploadedProject;
  try {
    built = buildUploadedProject({
      files: res.files,
      identity: res.identity,
      access,
      now: new Date(),
      failed: res.failed,
      texts: {
        defaultTagTable: t('defaults.defaultTagTable'),
        plc: t('defaults.plc'),
        namePrefix: t('upload.namePrefix'),
        missing: t('upload.missingComment'),
      },
    });
  } catch (e) {
    push({
      severity: 'error',
      textKey: 'messages.uploadFailed',
      params: { message: errorText(e) },
    });
    return 'failed';
  }
  // Niente è arrivato dalla CPU: non si chiude il progetto aperto né se ne crea uno vuoto.
  if (built.created === 0 && built.missing > 0) {
    const first = res.failed[0]
      ? `${res.failed[0].type}${res.failed[0].number}: ${res.failed[0].error}`
      : `${built.skipped[0]!.label}: ${built.skipped[0]!.reason}`;
    push({ severity: 'error', textKey: 'messages.uploadNothing', params: { reason: first } });
    return 'failed';
  }
  // Sostituire il progetto aperto: la domanda di salvataggio è quella esistente.
  if (!(await service.close())) return 'cancelled';
  let filePath: string;
  try {
    filePath = await freePath(bridge, built.project.meta.name);
  } catch (e) {
    push({
      severity: 'error',
      textKey: 'messages.uploadFailed',
      params: { message: errorText(e) },
    });
    return 'failed';
  }
  // Mai salvato: revisione 1 contro 0 salvata. La storia delle modifiche parte vuota (setDoc).
  store
    .getState()
    .setDoc({ project: built.project, filePath, dirty: true, revision: 1, savedRevision: 0 });
  const s = store.getState();
  s.setView('project');
  s.select(ids.plc(built.device.id));
  if (built.missing > 0) {
    push({
      severity: 'warning',
      textKey: 'messages.uploadDonePartial',
      params: { count: String(built.created), missing: String(built.missing) },
    });
  } else {
    push({
      severity: 'info',
      textKey: 'messages.uploadDone',
      params: { count: String(built.created), name: built.project.meta.name },
    });
  }
  if (built.firmwareUnknown) {
    push({
      severity: 'warning',
      textKey: 'messages.uploadFirmwareUnknown',
      params: { firmware: res.identity.firmware ?? '', used: built.device.cpu.firmware },
    });
  }
  if (!built.cpuFound) {
    push({
      severity: 'warning',
      textKey: 'messages.uploadCpuUnknown',
      params: { order: res.identity.orderNumber, cpu: built.device.cpu.orderNumber },
    });
  }
  for (const f of res.failed) {
    push({
      severity: 'warning',
      textKey: 'messages.uploadBlockFailed',
      params: { block: `${f.type}${f.number}`, message: f.error },
    });
  }
  for (const k of built.skipped) {
    push({
      severity: 'warning',
      textKey: 'messages.uploadBlockSkipped',
      params: { block: k.label, reason: k.reason },
    });
  }
  for (const n of built.notes) {
    push({
      severity: n.code === 'CALL_RICOSTRUITA_CON_PROGETTO' ? 'info' : 'warning',
      textKey: 'messages.importWarning',
      params: { message: `${n.block}: ${t(`mc7.diag.${n.code}`, n.params ?? {})}` },
    });
  }
  for (const w of built.warnings) {
    push({ severity: 'warning', textKey: 'messages.importWarning', params: { message: w } });
  }
  const noted = new Set(
    built.notes
      .filter((n) => n.code === 'BLOCCO_PROTETTO_KNOW_HOW' || n.code === 'DB_GENERE_NON_GESTITO')
      .map((n) => n.block),
  );
  for (const name of built.readOnly) {
    if (!noted.has(name)) {
      push({ severity: 'warning', textKey: 'messages.importReadOnly', params: { name } });
    }
  }
  return 'done';
}

/** Un percorso in «Documenti/BaaPortal» che non esiste: salvando non si sovrascrive nulla. */
async function freePath(bridge: BaaBridge, name: string): Promise<string> {
  const dir = await bridge.defaultProjectDir();
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const base = dir.endsWith(sep) ? dir : dir + sep;
  for (let n = 1; ; n++) {
    const path = `${base}${n === 1 ? name : `${name} (${n})`}.baap`;
    if (!(await bridge.fileExists(path))) return path;
  }
}
