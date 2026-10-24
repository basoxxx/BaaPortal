import type { StoreApi } from 'zustand/vanilla';
import { findCpu } from '@baaportal/catalog';
import {
  applyImport,
  blockToMc7File,
  findDevice,
  interfaceHashOf,
  planImport,
  sourceHashOf,
  type Block,
  type Mc7Diagnostic,
  type Member,
  type PlcDevice,
} from '@baaportal/project';
import { readKitZip } from '@baaportal/s7comm';
import type { BaaBridge, FileFilter } from '../../bridge';
import { flushPendingEdits } from '../../flushPendingEdits';
import { t } from '../../i18n';
import type { LineMapRow } from '../../editors/awl/monitorExtension';
import type { AppState, CompileRow, CompileSummary } from '../../state/store';
import { ids, parseNodeId } from '../navigation/treeIds';
import { getProgress, Interrupted, runWithProgress } from '../progress';

export interface CompileCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

export type CompileMode = 'changes' | 'full';

const MAX_LISTED = 10;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const tagOf = (b: Block) => `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}`;
/** Hash di 53 bit (cyrb53) del testo. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const memberKey = (m: Member): unknown => [
  m.name,
  m.type,
  m.initial ?? null,
  m.overrides ?? null,
  (m.members ?? []).map(memberKey),
];

/**
 * Impronta di ciò da cui dipende la compilazione di ogni blocco oltre al suo contenuto: variabili
 * (nome, tipo, indirizzo), costanti, UDT, CPU e, di ogni blocco, nome, tipo, numero e interfaccia
 * (un chiamato che cambia cambia i chiamanti). Prudente: ogni cambiamento ricompila tutto.
 */
export function contextHashOf(dev: PlcDevice): string {
  return hashText(
    JSON.stringify([
      dev.cpu.typeId,
      dev.tagTables.map((tb) => [
        tb.name,
        tb.tags.map((x) => [x.name, x.type, x.address]),
        tb.constants.map((c) => [c.name, c.type, c.value]),
      ]),
      dev.udts.map((u) => [u.name, u.number, u.members.map(memberKey)]),
      dev.blocks.map((b) => [b.kind, b.number, b.name, interfaceHashOf(b)]),
    ]),
  );
}

/** Chiave di compilazione: contenuto del blocco (reti, interfaccia, intestazione) e contesto. */
export const hashOf = (b: Block, context: string) =>
  `${sourceHashOf(b)}:${interfaceHashOf(b)}:${context}`;

function showCompileTab(store: StoreApi<AppState>): void {
  const s = store.getState();
  s.setInspectorTab('info');
  s.setInfoSubTab('compile');
  s.setPanel('inspector', { open: true });
}

const rowOf = (
  deviceId: string,
  b: Block,
  diagnostics: Mc7Diagnostic[],
  hasFile: boolean,
): CompileRow => {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  // le informazioni (es. VALORI_INIZIALI_DA_CAMPIONE) non sono avvisi
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  return {
    deviceId,
    blockId: b.id,
    name: b.name,
    tag: tagOf(b),
    status: errors > 0 || !hasFile ? 'error' : warnings > 0 ? 'warning' : 'ok',
    errors,
    warnings,
    diagnostics,
  };
};

const summaryOf = (rows: CompileRow[]): CompileSummary => ({
  blocks: rows.length,
  errors: rows.reduce((n, r) => n + r.errors, 0),
  warnings: rows.reduce((n, r) => n + r.warnings, 0),
});

function compileFailed(store: StoreApi<AppState>, e: unknown): void {
  store.getState().pushMessage({
    severity: 'error',
    textKey: 'messages.compileFailed',
    params: { message: errorText(e) },
  });
}

/** Cede il turno all'interfaccia, così Interrompi e la barra di avanzamento rispondono. */
let lastYield = 0;
const YIELD_MS = 16;
async function yieldToUi(): Promise<void> {
  if (performance.now() - lastYield < YIELD_MS) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  lastYield = performance.now();
}

/**
 * Compila i blocchi del PLC: `changes` quelli cambiati dall'ultima compilazione riuscita della
 * sessione, `full` tutti; con `only` solo quei blocchi, sempre. La scheda Compila si svuota
 * all'inizio; un'eccezione del compilatore lascia il progetto com'è e finisce in Informazioni.
 * Un passo per blocco, con avanzamento nella barra di stato; Interrompi ferma tra un blocco e
 * l'altro: i blocchi già compilati restano compilati, gli altri da compilare.
 */
export async function compileProgram(
  ctx: CompileCtx,
  deviceId: string,
  mode: CompileMode,
  only?: string[],
): Promise<void> {
  const { store } = ctx;
  if (getProgress()) return; // un'altra operazione lunga è in corso
  // Le bozze negli editor (codice dei segmenti) contano: si confermano prima.
  flushPendingEdits();
  const doc = store.getState().doc;
  const dev = doc && findDevice(doc.project, deviceId);
  if (!dev) return;
  store.getState().beginCompile();
  showCompileTab(store);
  // Se durante la compilazione si chiude il progetto o ne si apre un altro, l'esito si scarta.
  const session = store.getState().docLoadId;
  const sameSession = () => store.getState().docLoadId === session;
  lastYield = performance.now();
  const rows: CompileRow[] = [];
  const compiled: Parameters<AppState['finishCompile']>[0]['compiled'] = {};
  const failed: string[] = [];
  try {
    const known = store.getState().compile.hashes;
    const context = contextHashOf(dev);
    const todo = dev.blocks.filter((b) =>
      only ? only.includes(b.id) : mode === 'full' || known[b.id] !== hashOf(b, context),
    );
    const cpu = findCpu(dev.cpu.typeId);
    const now = new Date();
    const outcome = await runWithProgress('status.compiling', todo.length, async (step, signal) => {
      for (const b of todo) {
        if (signal.aborted) throw new Interrupted();
        await yieldToUi();
        if (signal.aborted) throw new Interrupted();
        const r = blockToMc7File(b, dev, cpu, now);
        const row = rowOf(deviceId, b, r.diagnostics, r.file !== undefined);
        rows.push(row);
        if (row.status !== 'error' && r.file) {
          compiled[b.id] = {
            hash: hashOf(b, context),
            file: r.file,
            diagnostics: r.diagnostics,
            ...(r.lines ? { lines: r.lines } : {}),
          };
        } else failed.push(b.id);
        step();
      }
      if (sameSession())
        store.getState().finishCompile({ rows, summary: summaryOf(rows), compiled, failed });
    });
    if (outcome === 'interrotto' && sameSession()) {
      store.getState().finishCompile({
        rows,
        summary: summaryOf(rows),
        compiled,
        failed,
        interrupted: true,
      });
      store.getState().pushMessage({ severity: 'warning', textKey: 'messages.compileInterrupted' });
    }
  } catch (e) {
    // Un'eccezione a metà: si conservano gli esiti già raccolti, poi si mostra l'errore.
    if (sameSession() && rows.length > 0)
      store.getState().finishCompile({ rows, summary: summaryOf(rows), compiled, failed });
    compileFailed(store, e);
  }
}

/** "Esporta blocco compilato (.blk)…": compila; con errori li mostra nella scheda e non salva. */
export async function exportCompiledBlock(
  ctx: CompileCtx,
  deviceId: string,
  blockId: string,
): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  const dev = findDeviceIn(store, deviceId);
  const block = dev?.blocks.find((b) => b.id === blockId);
  if (!dev || !block) return;
  store.getState().beginCompile();
  let file: Uint8Array | undefined;
  try {
    // Il file compilato in questa sessione vale finché contenuto e contesto non cambiano.
    const key = hashOf(block, contextHashOf(dev));
    const kept = store.getState().compile;
    const reuse = kept.hashes[block.id] === key ? kept.files[block.id] : undefined;
    const r: { file?: Uint8Array; diagnostics: Mc7Diagnostic[]; lines?: LineMapRow[] } = reuse
      ? {
          file: reuse,
          diagnostics: kept.diagnostics[block.id] ?? [],
          ...(kept.lines[block.id] ? { lines: kept.lines[block.id] } : {}),
        }
      : blockToMc7File(block, dev, findCpu(dev.cpu.typeId));
    const row = rowOf(deviceId, block, r.diagnostics, r.file !== undefined);
    store.getState().finishCompile({
      rows: [row],
      summary: summaryOf([row]),
      compiled:
        row.status !== 'error' && r.file
          ? {
              [block.id]: {
                hash: key,
                file: r.file,
                diagnostics: r.diagnostics,
                ...(r.lines ? { lines: r.lines } : {}),
              },
            }
          : {},
      failed: row.status === 'error' ? [block.id] : [],
    });
    showCompileTab(store);
    if (row.status === 'error') return;
    file = r.file;
  } catch (e) {
    compileFailed(store, e);
    return;
  }
  if (!file) return;
  try {
    const path = await bridge.showSaveFileDialog({
      defaultName: `${tagOf(block)}.blk`,
      filters: [{ name: t('compile.filterBlk'), extensions: ['blk'] }],
    });
    if (!path) return;
    await bridge.writeFileAtomic(path, file);
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.blockExported',
      params: { name: block.name, path },
    });
  } catch (e) {
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'messages.blockExportFailed',
      params: { name: block.name, message: errorText(e) },
    });
  }
}

function findDeviceIn(store: StoreApi<AppState>, deviceId: string) {
  const doc = store.getState().doc;
  return doc ? findDevice(doc.project, deviceId) : undefined;
}

/** Id dei blocchi (di un solo PLC) rappresentati dai nodi dell'albero. */
export function blockNodesOf(
  nodeIds: Iterable<string>,
): { deviceId: string; ids: string[] } | null {
  let deviceId: string | null = null;
  const out: string[] = [];
  for (const n of nodeIds) {
    const p = parseNodeId(n);
    if (p.kind !== 'block') continue;
    if (deviceId !== null && p.dev !== deviceId) continue;
    deviceId = p.dev;
    out.push(p.id);
  }
  return deviceId === null ? null : { deviceId, ids: out };
}

// ---- importazione -------------------------------------------------------------------------

const listNames = (names: string[]): string => {
  const listed = names.slice(0, MAX_LISTED);
  if (names.length > MAX_LISTED)
    listed.push(t('objects.deleteMore', { count: names.length - MAX_LISTED }));
  return listed.join('\n');
};

const importFilter = (): FileFilter => ({
  name: t('compile.filterImport'),
  extensions: ['blk', 'zip'],
});

interface Loaded {
  /** Nome mostrato nei messaggi (per i blocchi di uno zip: `zip/blocco`). */
  label: string;
  bytes: Uint8Array;
}

const replacedKey = (replaced: { existing: Block }[]) =>
  replaced
    .map((r) => r.existing.id)
    .sort()
    .join('|');

/**
 * "Importa blocchi (.blk o raccolta del kit)…": legge i file (dagli zip del kit, `blocchi/*`),
 * prepara il piano, chiede conferma se sostituisce blocchi e applica tutto in un solo `edit`.
 */
export async function importBlocks(ctx: CompileCtx, deviceId: string): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  if (!findDeviceIn(store, deviceId)) return;
  const push = store.getState().pushMessage;
  let paths: string[];
  try {
    paths = await bridge.showOpenFileDialog({ filters: [importFilter()], multi: true });
  } catch (e) {
    push({
      severity: 'error',
      textKey: 'messages.fileDialogFailed',
      params: { message: errorText(e) },
    });
    return;
  }
  const loaded: Loaded[] = [];
  for (const path of paths) {
    const name = baseName(path);
    try {
      const bytes = await bridge.readFile(path);
      if (/\.zip$/i.test(name)) {
        let blocks: Record<string, Uint8Array>;
        try {
          blocks = readKitZip(bytes).blocks;
        } catch (e) {
          // Un archivio non valido non ferma gli altri file.
          store.getState().pushMessage({
            severity: 'error',
            textKey: 'messages.importZipInvalid',
            params: { name, message: errorText(e) },
          });
          continue;
        }
        const entries = Object.entries(blocks);
        if (entries.length === 0) {
          store.getState().pushMessage({
            severity: 'warning',
            textKey: 'messages.importZipEmpty',
            params: { name },
          });
        }
        for (const [block, data] of entries)
          loaded.push({ label: `${name}/${block}`, bytes: data });
      } else loaded.push({ label: name, bytes });
    } catch (e) {
      store.getState().pushMessage({
        severity: 'error',
        textKey: 'messages.sourceReadFailed',
        params: { name, message: errorText(e) },
      });
    }
  }
  if (loaded.length === 0) return;

  const failed = (e: unknown) =>
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'messages.importFailed',
      params: { message: errorText(e) },
    });
  const plan = (): ReturnType<typeof planImport> | null => {
    const dev = findDeviceIn(store, deviceId);
    if (!dev) return null;
    try {
      return planImport(
        dev,
        loaded.map((l) => l.bytes),
      );
    } catch (e) {
      failed(e);
      return null;
    }
  };
  let current = plan();
  if (!current) return;
  if (current.replace.length > 0) {
    const shown = current;
    let yes: boolean;
    try {
      yes = await bridge.askQuestion({
        title: t('compile.replaceTitle'),
        message: `${t('compile.replaceMessage')}\n\n${listNames(shown.replace.map((r) => r.existing.name))}`,
        yes: t('objects.yes'),
        no: t('objects.no'),
      });
    } catch (e) {
      failed(e);
      return;
    }
    if (!yes) return;
    // Mentre la domanda era aperta il progetto può essere cambiato: si applica solo ciò che si è confermato.
    current = plan();
    if (!current) return;
    if (replacedKey(current.replace) !== replacedKey(shown.replace)) {
      store
        .getState()
        .pushMessage({ severity: 'warning', textKey: 'messages.importReplaceChanged' });
      return;
    }
  }
  const done = current;
  try {
    store.getState().edit('history.importBlocks', (p) => {
      const d = findDevice(p, deviceId);
      if (d) applyImport(d, done);
    });
  } catch (e) {
    // Una eccezione dentro `edit` lascia il progetto com'era.
    failed(e);
    return;
  }
  const s = store.getState();
  s.pushMessage({
    severity: 'info',
    textKey: 'messages.blocksImported',
    params: {
      created: String(done.create.length),
      replaced: String(done.replace.length),
      refreshed: String(done.refresh.length),
      skipped: String(done.skipped.length),
    },
  });
  for (const k of done.skipped) {
    s.pushMessage({
      severity: 'warning',
      textKey: 'messages.importSkipped',
      params: { file: loaded[k.index]?.label ?? '', reason: k.reason },
    });
  }
  // anche un blocco di cui si aggiornano i metadati, se i controlli del lotto lo rendono di sola
  // lettura
  const incoming = [
    ...done.create,
    ...done.replace.map((r) => r.incoming),
    ...done.refresh
      .filter((r) => r.existing.mc7?.exact && !r.incoming.mc7?.exact)
      .map((r) => r.incoming),
  ];
  for (const n of done.notes) {
    s.pushMessage({
      severity: n.code === 'CALL_RICOSTRUITA_CON_PROGETTO' ? 'info' : 'warning',
      textKey: 'messages.importWarning',
      params: { message: `${n.block}: ${t(`mc7.diag.${n.code}`, n.params ?? {})}` },
    });
  }
  // Le note che spiegano la sola lettura (know-how, genere del DB) sostituiscono l'avviso generico.
  const noted = new Set(
    done.notes
      .filter((n) => n.code === 'BLOCCO_PROTETTO_KNOW_HOW' || n.code === 'DB_GENERE_NON_GESTITO')
      .map((n) => n.block),
  );
  for (const b of incoming) {
    if (b.mc7 && !b.mc7.exact && !noted.has(b.name)) {
      s.pushMessage({
        severity: 'warning',
        textKey: 'messages.importReadOnly',
        params: { name: b.name },
      });
    }
  }
  for (const w of done.warnings) {
    s.pushMessage({
      severity: 'warning',
      textKey: 'messages.importWarning',
      params: { message: w },
    });
  }
  s.setInspectorTab('info');
  s.setInfoSubTab('general');
  s.setPanel('inspector', { open: true });
  const first = done.create[0] ?? done.replace[0]?.incoming;
  if (first) s.select(ids.block(deviceId, first.id));
}
