// «Importa da STEP 7…»: sorgenti AWL e SCL e tabelle dei simboli esportate da STEP 7 V5.5.
import {
  applySource,
  findExisting,
  nameOwner,
  readStep7Files,
  STEP7_EXTENSIONS,
  unitKey,
  type Step7Read,
  type SourceUnit,
} from '@baaportal/importers';
import {
  createNamer,
  createTagTable,
  findDevice,
  kopSources,
  renameWithReferences,
  symbolNames,
  type Block,
  type PlcDevice,
  type Udt,
} from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../../bridge';
import { flushPendingEdits } from '../../flushPendingEdits';
import { t } from '../../i18n';
import type { AppState } from '../../state/store';
import { applyTagImport, type ImportSummary } from './tagTableIo';

export interface Step7Ctx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

/** Una voce dell'anteprima: un oggetto da creare o sostituire, un nome di blocco, i simboli. */
export interface Step7Item {
  key: string;
  kind: SourceUnit['kind'] | 'rename' | 'tags';
  name: string;
  number?: number;
  file: string;
  /** Sostituisce un oggetto che c'è già (per le voci `rename`: il nome vecchio). */
  replaces?: string;
  /** Oggetto nuovo col nome di un altro oggetto o simbolo (`FC3`): non si può importare. */
  nameTakenBy?: string;
  /** Sostituisce un oggetto con un altro numero ma lo stesso nome: si può anche rinumerare. */
  canRenumber?: boolean;
  /** Blocco SCL: errori della compilazione del testo importato. */
  sclErrors?: { line: number; message: string }[];
}

export interface Step7Plan {
  read: Step7Read;
  items: Step7Item[];
}

const BLOCK_SYMBOL_KINDS = new Set(['OB', 'FB', 'FC', 'DB', 'UDT']);
const newId = () => globalThis.crypto.randomUUID();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const stemOf = (name: string) =>
  name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;

/** Oggetto del dispositivo col numero e la famiglia di un simbolo di blocco. */
function byNumber(dev: PlcDevice, kind: string, number: number): Udt | Block | undefined {
  if (kind === 'UDT') return dev.udts.find((u) => u.number === number);
  return dev.blocks.find((b) => (b.kind === 'IDB' ? 'DB' : b.kind) === kind && b.number === number);
}

/** Nomi dei blocchi dai simboli: quelli che, dopo le unità, hanno un nome diverso dal simbolo. */
function renamesFor(dev: PlcDevice, read: Step7Read): Step7Item[] {
  const out: Step7Item[] = [];
  for (const b of read.blocks) {
    if (!BLOCK_SYMBOL_KINDS.has(b.kind)) continue;
    const obj = byNumber(dev, b.kind, b.number);
    if (!obj || sameName(obj.name, b.name)) continue;
    out.push({
      key: `rename:${b.kind}${b.number}`,
      kind: 'rename',
      name: b.name,
      number: b.number,
      file: b.file,
      replaces: obj.name,
    });
  }
  return out;
}

/**
 * Prova a vuoto su una copia del dispositivo: le voci dell'anteprima, con ciò che sostituirebbero e
 * gli errori SCL dei blocchi importati. Non tocca il progetto.
 */
export function planStep7Import(
  dev: PlcDevice,
  files: readonly { name: string; bytes: Uint8Array }[],
): Step7Plan {
  const read = readStep7Files(files, dev);
  const items: Step7Item[] = read.units.map(({ unit, file }) => {
    const old = findExisting(dev, unit);
    const owner = old || unit.name === '' ? undefined : nameOwner(dev, unit.name);
    return {
      key: unitKey(unit),
      kind: unit.kind,
      name: unit.name,
      ...(unit.number === undefined ? {} : { number: unit.number }),
      file,
      ...(old
        ? { replaces: old.name, ...(!sameName(old.name, unit.name) ? { canRenumber: true } : {}) }
        : {}),
      ...(owner ? { nameTakenBy: owner } : {}),
    };
  });
  const blocked = new Set(items.filter((i) => i.nameTakenBy).map((i) => i.key));
  const scratch = structuredClone(dev);
  let n = 0;
  try {
    const { created, replaced } = applySource(
      scratch,
      { units: read.units.filter((u) => !blocked.has(unitKey(u.unit))).map((u) => u.unit) },
      () => `dry${++n}`,
    );
    for (const ref of [...created, ...replaced]) {
      if (ref.kind !== 'block') continue;
      const b = scratch.blocks.find((x) => x.id === ref.id);
      if (!b || b.kind === 'DB' || b.kind === 'IDB' || b.language !== 'SCL') continue;
      const errors = kopSources(b, scratch)[0]?.scl?.diagnostics ?? [];
      const item = items.find(
        (i) => i.kind === b.kind && (i.number === b.number || sameName(i.name, b.name)),
      );
      if (item && errors.length > 0) {
        item.sclErrors = errors.map((e) => ({ line: e.line, message: e.message }));
      }
    }
  } catch {
    // Un numero già in uso: lo dirà l'applicazione vera; l'anteprima resta senza errori SCL.
  }
  items.push(...renamesFor(scratch, read));
  if (read.tags.length > 0) {
    items.push({
      key: 'tags',
      kind: 'tags',
      name: tableNameFor(read),
      number: read.tags.length,
      file: read.tags[0]!.file,
    });
  }
  return { read, items };
}

const tableNameFor = (read: Step7Read): string =>
  stemOf(read.tags[0]?.file ?? '') || t('defaults.tagTable');

/**
 * Chiavi selezionate all'apertura: tutto, tranne ciò che sostituisce un oggetto esistente e ciò che
 * ha il nome di un altro oggetto (quello non si può scegliere).
 */
export const defaultSelection = (plan: Step7Plan): Set<string> =>
  new Set(
    plan.items
      .filter((i) => (i.replaces === undefined || i.kind === 'rename') && !i.nameTakenBy)
      .map((i) => i.key),
  );

/** Cosa fare di un'unità che sostituirebbe un oggetto: sostituirlo (predefinito), importarla con un altro nome o con un altro numero. */
export type Step7Choice = 'replace' | 'rename' | 'renumber';

const MAX_NUMBER: Record<string, number> = { OB: 255 };
const familyOf = (kind: string) => (kind === 'IDB' ? 'DB' : kind);

/** Le unità scelte, con nome e numero liberi per quelle da rinominare o rinumerare. */
function withChoices(
  dev: PlcDevice,
  units: SourceUnit[],
  choices: ReadonlyMap<string, Step7Choice>,
): SourceUnit[] {
  const namer = createNamer([
    ...symbolNames(dev),
    ...units.filter((u) => u.name !== '').map((u) => u.name),
  ]);
  const taken = new Set<string>();
  const freeNumber = (kind: string): number | undefined => {
    const fam = familyOf(kind);
    const used = new Set<number>(
      fam === 'UDT'
        ? dev.udts.map((u) => u.number)
        : dev.blocks.filter((b) => familyOf(b.kind) === fam).map((b) => b.number),
    );
    for (let n = 1; n <= (MAX_NUMBER[fam] ?? 65535); n++) {
      if (!used.has(n) && !taken.has(`${fam}${n}`)) {
        taken.add(`${fam}${n}`);
        return n;
      }
    }
    return undefined;
  };
  return units.map((u) => {
    const choice = choices.get(unitKey(u));
    if (!choice || choice === 'replace' || !findExisting(dev, u)) return u;
    const number = freeNumber(u.kind);
    if (number === undefined) return u;
    return { ...u, number, ...(choice === 'rename' ? { name: namer(u.name) } : {}) } as SourceUnit;
  });
}

export interface Step7Result {
  created: number;
  replaced: number;
  renamed: number;
  /** Nomi di blocco non dati: il nome è già usato da un altro simbolo. */
  renameSkipped: string[];
  tags?: ImportSummary;
}

/**
 * Applica le voci scelte al dispositivo, sul posto (dentro un solo `edit`): unità (UDT, poi blocchi,
 * poi DB), nomi dei blocchi dai simboli, poi i simboli nella tabella che ha il nome del file (nuova
 * se non c'è).
 */
export function applyStep7Plan(
  dev: PlcDevice,
  plan: Step7Plan,
  selected: ReadonlySet<string>,
  choices: ReadonlyMap<string, Step7Choice> = new Map(),
): Step7Result {
  const blocked = new Set(plan.items.filter((i) => i.nameTakenBy).map((i) => i.key));
  const units = plan.read.units
    .map((u) => u.unit)
    .filter((u) => selected.has(unitKey(u)) && !blocked.has(unitKey(u)));
  const { created, replaced } = applySource(
    dev,
    { units: withChoices(dev, units, choices) },
    newId,
  );
  const result: Step7Result = {
    created: created.length,
    replaced: replaced.length,
    renamed: 0,
    renameSkipped: [],
  };
  for (const b of plan.read.blocks) {
    if (!selected.has(`rename:${b.kind}${b.number}`)) continue;
    const obj = byNumber(dev, b.kind, b.number);
    if (!obj || sameName(obj.name, b.name)) continue;
    if (symbolNames(dev).some((n) => sameName(n, b.name))) {
      result.renameSkipped.push(b.name);
      continue;
    }
    renameWithReferences(
      dev,
      b.kind === 'UDT'
        ? { kind: 'udt', deviceId: dev.id, id: obj.id }
        : { kind: 'block', deviceId: dev.id, id: obj.id },
      b.name,
    );
    result.renamed++;
  }
  if (selected.has('tags') && plan.read.tags.length > 0) {
    const name = tableNameFor(plan.read);
    const existing = dev.tagTables.find((x) => sameName(x.name, name));
    const table = existing ?? createTagTable(name, newId);
    const others = new Map<string, string>();
    for (const o of dev.tagTables) {
      if (o.id === table.id) continue;
      for (const x of [...o.tags, ...o.constants]) others.set(x.name.toLowerCase(), o.name);
    }
    const res = applyTagImport(table, { tags: plan.read.tags, constants: [], errors: [] }, others);
    result.tags = res.summary;
    if (existing) Object.assign(existing, res.table);
    else if (res.summary.created > 0) dev.tagTables.push(res.table);
  }
  return result;
}

/** Sceglie i file e li legge; null se annullato. Gli errori di lettura vanno in Informazioni. */
export async function pickStep7Files(
  ctx: Step7Ctx,
): Promise<{ name: string; bytes: Uint8Array }[] | null> {
  const { store, bridge } = ctx;
  let paths: string[];
  try {
    paths = await bridge.showOpenFileDialog({
      filters: [{ name: t('step7.filter'), extensions: [...STEP7_EXTENSIONS] }],
      multi: true,
    });
  } catch (e) {
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'messages.fileDialogFailed',
      params: { message: errorText(e) },
    });
    return null;
  }
  return paths.length === 0 ? null : readPaths(ctx, paths);
}

async function readPaths(
  ctx: Step7Ctx,
  paths: string[],
): Promise<{ name: string; bytes: Uint8Array }[]> {
  const { store, bridge } = ctx;
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const path of paths) {
    const name = baseName(path);
    try {
      out.push({ name, bytes: await bridge.readFile(path) });
    } catch (e) {
      store.getState().pushMessage({
        severity: 'error',
        textKey: 'messages.sourceReadFailed',
        params: { name, message: errorText(e) },
      });
    }
  }
  return out;
}

/** Sceglie una cartella e legge i file di STEP 7 che contiene (primo livello); null se annullato. */
export async function pickStep7Folder(
  ctx: Step7Ctx,
): Promise<{ name: string; bytes: Uint8Array }[] | null> {
  const { store, bridge } = ctx;
  let paths: string[] | null;
  try {
    paths = await bridge.showSelectFolderFiles([...STEP7_EXTENSIONS]);
  } catch (e) {
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'messages.fileDialogFailed',
      params: { message: errorText(e) },
    });
    return null;
  }
  return paths && (await readPaths(ctx, paths));
}

/** Applica in un solo passo annullabile e scrive il riepilogo in Informazioni. */
export function runStep7Import(
  store: StoreApi<AppState>,
  deviceId: string,
  plan: Step7Plan,
  selected: ReadonlySet<string>,
  choices: ReadonlyMap<string, Step7Choice> = new Map(),
): Step7Result | null {
  flushPendingEdits();
  let result: Step7Result | null = null;
  try {
    store.getState().edit('history.importStep7', (p) => {
      const dev = findDevice(p, deviceId);
      if (dev) result = applyStep7Plan(dev, plan, selected, choices);
    });
  } catch (e) {
    // Un'eccezione dentro `edit` lascia il progetto com'era.
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'step7.msg.failed',
      params: { message: errorText(e) },
    });
    return null;
  }
  const done = result as Step7Result | null;
  if (!done) return null;
  const s = store.getState();
  s.pushMessage({
    severity:
      done.renameSkipped.length > 0 || (done.tags?.skipped.length ?? 0) > 0 ? 'warning' : 'info',
    textKey: 'step7.msg.done',
    params: {
      created: String(done.created),
      replaced: String(done.replaced),
      renamed: String(done.renamed),
      tags: String((done.tags?.created ?? 0) + (done.tags?.updated ?? 0)),
    },
  });
  for (const name of done.renameSkipped) {
    s.pushMessage({ severity: 'warning', textKey: 'step7.msg.renameSkipped', params: { name } });
  }
  for (const e of done.tags?.skipped ?? []) {
    s.pushMessage({
      severity: 'warning',
      textKey: 'step7.msg.tagSkipped',
      params: {
        line: String(e.line),
        reason: t(`tagIo.err.${e.code}`, { detail: e.detail ?? '' }),
      },
    });
  }
  for (const i of plan.items) {
    if (!selected.has(i.key) || !i.sclErrors) continue;
    s.pushMessage({
      severity: 'warning',
      textKey: 'step7.msg.sclErrors',
      params: { name: i.name, count: String(i.sclErrors.length) },
    });
  }
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
  return done;
}
