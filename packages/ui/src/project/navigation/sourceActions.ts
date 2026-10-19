import type { StoreApi } from 'zustand/vanilla';
import type { Mnemonic } from '@baaportal/awl';
import {
  applySource,
  decodeSourceBytes,
  encodeSourceText,
  generateAwlSource,
  parseAwlSource,
  SOURCE_AWL_ERROR_CODES,
  type GenerateWarning,
  type SourceError,
} from '@baaportal/importers';
import {
  addSource,
  findBlock,
  findDevice,
  findSource,
  findUdt,
  type ObjectRef,
  type PlcDevice,
} from '@baaportal/project';
import type { BaaBridge, FileFilter } from '../../bridge';
import { flushPendingEdits } from '../../flushPendingEdits';
import { t } from '../../i18n';
import type { AppState, OpenDoc } from '../../state/store';
import { ids, parseNodeId } from './treeIds';

export interface SourceCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

const MAX_LISTED = 10;
const newId = () => globalThis.crypto.randomUUID();
const awlFilter = (): FileFilter => ({ name: t('source.filter'), extensions: ['awl'] });
const deviceOf = (doc: OpenDoc | null, id: string) =>
  doc ? findDevice(doc.project, id) : undefined;
const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Chiave i18n del messaggio di un codice di errore delle sorgenti. */
export const sourceErrorKey = (code: string): string =>
  (SOURCE_AWL_ERROR_CODES as readonly string[]).includes(code)
    ? `awl.diag.${code}`
    : `source.err.${code}`;

/** Spostamento nel testo mostrato (a capo sempre LF) di riga e colonna da 1; oltre la fine, l'ultima posizione. */
export function offsetOfLineCol(text: string, line: number, col: number): number {
  const shown = text.replace(/\r\n?/g, '\n');
  let start = 0;
  for (let l = 1; l < line; l++) {
    const next = shown.indexOf('\n', start);
    if (next < 0) return shown.length;
    start = next + 1;
  }
  const end = shown.indexOf('\n', start);
  const lineEnd = end < 0 ? shown.length : end;
  return Math.min(start + Math.max(col - 1, 0), lineEnd);
}

function reportErrors(
  store: StoreApi<AppState>,
  deviceId: string,
  sourceId: string,
  name: string,
  errors: SourceError[],
): void {
  const s = store.getState();
  for (const e of errors) {
    s.pushMessage({
      severity: 'error',
      textKey: 'messages.sourceError',
      params: {
        name,
        line: String(e.line),
        col: String(e.col),
        message: t(sourceErrorKey(e.code), e.params ?? {}),
      },
      target: { kind: 'source', deviceId, sourceId, line: e.line, col: e.col },
    });
  }
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
}

/** Apre la sorgente nell'editor, con il cursore alla riga e colonna (da 1) indicate. */
export function openSourceAt(
  store: StoreApi<AppState>,
  deviceId: string,
  sourceId: string,
  line: number,
  col: number,
): void {
  store.getState().openSourceAt({ deviceId, sourceId, line, col });
}

/** "Aggiungi nuovo file esterno": ogni file scelto diventa una sorgente, tutte in un solo passo. */
export async function addSourceFiles(ctx: SourceCtx, deviceId: string): Promise<void> {
  const { store, bridge } = ctx;
  if (!deviceOf(store.getState().doc, deviceId)) return;
  let paths: string[];
  try {
    paths = await bridge.showOpenFileDialog({ filters: [awlFilter()], multi: true });
  } catch (e) {
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'messages.fileDialogFailed',
      params: { message: errorText(e) },
    });
    return;
  }
  const loaded: { name: string; text: string }[] = [];
  for (const path of paths) {
    const name = baseName(path);
    try {
      loaded.push({ name, text: decodeSourceBytes(await bridge.readFile(path)).text });
    } catch (e) {
      store.getState().pushMessage({
        severity: 'error',
        textKey: 'messages.sourceReadFailed',
        params: { name, message: errorText(e) },
      });
    }
  }
  if (loaded.length === 0) return;
  store.getState().edit('history.addSources', (p) => {
    const dev = findDevice(p, deviceId);
    if (dev) for (const l of loaded) addSource(dev, l.name, l.text, newId);
  });
}

/** Al più MAX_LISTED nomi, poi "e altri N". */
function listNames(names: string[], separator = '\n'): string {
  const listed = names.slice(0, MAX_LISTED);
  if (names.length > MAX_LISTED)
    listed.push(t('objects.deleteMore', { count: names.length - MAX_LISTED }));
  return listed.join(separator);
}

const nameOfRef = (dev: PlcDevice, r: ObjectRef): string =>
  (r.kind === 'block'
    ? findBlock(dev, r.id)?.name
    : r.kind === 'udt'
      ? findUdt(dev, r.id)?.name
      : '') ?? '';

interface ApplyPlan {
  dev: PlcDevice;
  name: string;
  source: Extract<ReturnType<typeof parseAwlSource>, { ok: true }>['source'];
  replaced: ObjectRef[];
}

/**
 * Legge la sorgente e la prova a vuoto su una copia del dispositivo: dice che cosa sarebbe
 * sostituito, senza toccare il progetto. Gli errori vanno in Informazioni (e il risultato è null).
 */
function planApply(
  store: StoreApi<AppState>,
  deviceId: string,
  sourceId: string,
): ApplyPlan | null {
  const dev = deviceOf(store.getState().doc, deviceId);
  const src = dev && findSource(dev, sourceId);
  if (!dev || !src) return null;
  const parsed = parseAwlSource(src.text, dev);
  if (!parsed.ok) {
    reportErrors(store, deviceId, sourceId, src.name, parsed.errors);
    return null;
  }
  try {
    let n = 0;
    const { replaced } = applySource(structuredClone(dev), parsed.source, () => `dry${++n}`);
    return { dev, name: src.name, source: parsed.source, replaced };
  } catch (e) {
    applyFailed(store, src.name, e);
    return null;
  }
}

const applyFailed = (store: StoreApi<AppState>, name: string, e: unknown) =>
  store.getState().pushMessage({
    severity: 'error',
    textKey: 'messages.sourceApplyFailed',
    params: { name, message: errorText(e) },
  });

const refKeys = (refs: ObjectRef[]): string =>
  refs
    .map((r) => `${r.kind}:${'id' in r ? r.id : ''}`)
    .sort()
    .join('|');

/** "Genera blocchi dalla sorgente": errori in Informazioni, conferma se sostituisce, poi un solo passo. */
export async function generateBlocksFromSource(
  ctx: SourceCtx,
  deviceId: string,
  sourceId: string,
): Promise<void> {
  const { store, bridge } = ctx;
  // La bozza nell'editor della sorgente conta: si conferma prima.
  flushPendingEdits();
  let plan = planApply(store, deviceId, sourceId);
  if (!plan) return;
  if (plan.replaced.length > 0) {
    const shown = plan;
    let yes: boolean;
    try {
      yes = await bridge.askQuestion({
        title: t('source.replaceTitle'),
        message: `${t('source.replaceMessage')}\n\n${listNames(shown.replaced.map((r) => nameOfRef(shown.dev, r)))}`,
        yes: t('objects.yes'),
        no: t('objects.no'),
      });
    } catch (e) {
      applyFailed(store, shown.name, e);
      return;
    }
    if (!yes) return;
    // Mentre la domanda era aperta il progetto può essere cambiato: si rifà la prova e si applica
    // solo se sostituisce ancora proprio gli oggetti confermati.
    plan = planApply(store, deviceId, sourceId);
    if (!plan) return;
    if (refKeys(plan.replaced) !== refKeys(shown.replaced)) {
      store.getState().pushMessage({
        severity: 'warning',
        textKey: 'messages.sourceReplaceChanged',
        params: { name: shown.name },
      });
      return;
    }
  }
  const { name, source } = plan;
  let result: { created: ObjectRef[]; replaced: ObjectRef[] } | null = null;
  let changed: boolean;
  try {
    changed = store.getState().edit('history.applySource', (p) => {
      const d = findDevice(p, deviceId);
      if (d) result = applySource(d, source, newId);
    });
  } catch (e) {
    // Una eccezione dentro `edit` lascia il progetto com'era.
    applyFailed(store, name, e);
    return;
  }
  const done = result as { created: ObjectRef[]; replaced: ObjectRef[] } | null;
  // Nessun cambiamento (una sorgente senza unità): nessun passo e nessun riepilogo.
  if (!done || !changed) return;
  store.getState().pushMessage({
    severity: 'info',
    textKey: 'messages.sourceApplied',
    params: {
      name,
      created: String(done.created.length),
      replaced: String(done.replaced.length),
    },
  });
}

/** "Esporta…": scrive la sorgente in UTF-8 con BOM e CRLF. */
export async function exportSource(
  ctx: SourceCtx,
  deviceId: string,
  sourceId: string,
): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  const first = findSourceIn(store, deviceId, sourceId);
  if (!first) return;
  try {
    const path = await bridge.showSaveFileDialog({
      defaultName: first.name,
      filters: [awlFilter()],
    });
    if (!path) return;
    // Il testo si rilegge dopo la finestra: è quello di adesso.
    const text = findSourceIn(store, deviceId, sourceId)?.text ?? first.text;
    await bridge.writeFileAtomic(path, encodeSourceText(text));
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.sourceExported',
      params: { name: first.name, path },
    });
  } catch (e) {
    store.getState().pushMessage({
      severity: 'error',
      textKey: 'messages.sourceExportFailed',
      params: { name: first.name, message: errorText(e) },
    });
  }
}

function findSourceIn(store: StoreApi<AppState>, deviceId: string, sourceId: string) {
  const dev = deviceOf(store.getState().doc, deviceId);
  return dev && findSource(dev, sourceId);
}

/** Blocchi e UDT da cui generare: gli oggetti dei nodi, oppure tutti quelli delle cartelle "Blocchi di programma" e "Tipi di dati PLC". */
export function objectsToGenerate(
  doc: OpenDoc | null,
  nodeIds: Iterable<string>,
): { deviceId: string; refs: ObjectRef[] } | null {
  let deviceId: string | null = null;
  const refs: ObjectRef[] = [];
  const seen = new Set<string>();
  const push = (dev: string, r: ObjectRef & { id: string }) => {
    if (seen.has(`${r.kind}:${r.id}`)) return;
    seen.add(`${r.kind}:${r.id}`);
    refs.push(r);
    deviceId ??= dev;
  };
  for (const n of nodeIds) {
    const p = parseNodeId(n);
    if (p.kind === 'static' || p.kind === 'plc' || p.kind === 'group') continue;
    if (deviceId !== null && p.dev !== deviceId) continue;
    const dev = deviceOf(doc, p.dev);
    if (!dev) continue;
    if (p.kind === 'block' && findBlock(dev, p.id)) {
      push(p.dev, { kind: 'block', deviceId: p.dev, id: p.id });
    } else if (p.kind === 'udt' && findUdt(dev, p.id)) {
      push(p.dev, { kind: 'udt', deviceId: p.dev, id: p.id });
    } else if (p.kind === 'folder' && p.folder === 'blocks') {
      for (const b of dev.blocks) push(p.dev, { kind: 'block', deviceId: p.dev, id: b.id });
    } else if (p.kind === 'folder' && p.folder === 'types') {
      for (const u of dev.udts) push(p.dev, { kind: 'udt', deviceId: p.dev, id: u.id });
    }
  }
  return deviceId === null ? null : { deviceId, refs };
}

/** Ciò che la generazione non ha scritto: un avviso in Informazioni per oggetto. */
function reportGenerateWarnings(store: StoreApi<AppState>, warnings: GenerateWarning[]): void {
  if (warnings.length === 0) return;
  const s = store.getState();
  for (const w of warnings) {
    s.pushMessage(
      w.kind === 'startValues'
        ? {
            severity: 'warning',
            textKey: 'messages.sourceStartValuesSkipped',
            params: { name: w.name, members: listNames(w.members, ', ') },
          }
        : {
            severity: 'warning',
            textKey: 'messages.sourceLanguageSkipped',
            params: { name: w.name, language: w.language },
          },
    );
  }
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
}

/** "Genera sorgente dai blocchi": crea `<primo nome>.awl` (unico), la seleziona e la apre. Un solo passo. */
export function generateSourceFromNodes(
  ctx: SourceCtx,
  nodeIds: Iterable<string>,
  mnemonic: Mnemonic,
): string | null {
  const { store } = ctx;
  // Le bozze negli editor (codice dei segmenti, interfaccia) contano: si confermano prima.
  flushPendingEdits();
  const sel = objectsToGenerate(store.getState().doc, nodeIds);
  const dev = sel && deviceOf(store.getState().doc, sel.deviceId);
  if (!sel || !dev || sel.refs.length === 0) return null;
  const { text, warnings } = generateAwlSource(dev, sel.refs, mnemonic);
  reportGenerateWarnings(store, warnings);
  // Solo blocchi in altre lingue: niente da scrivere.
  if (text === '') return null;
  // Il nome è quello del primo oggetto scritto (un blocco in un'altra lingua non c'è); può avere
  // caratteri che un nome di file non ammette.
  const skipped = new Set(
    warnings.flatMap((w) => (w.kind === 'language' && 'id' in w.ref ? [w.ref.id] : [])),
  );
  const firstRef = sel.refs.find((r) => !('id' in r) || !skipped.has(r.id)) ?? sel.refs[0]!;
  const first = nameOfRef(dev, firstRef).replace(/[\\/:*?"<>|]/g, '_') || t('source.defaultName');
  let created: string | null = null;
  store.getState().edit('history.generateSource', (p) => {
    const d = findDevice(p, sel.deviceId);
    if (d) created = addSource(d, `${first}.awl`, text, newId).id;
  });
  const id = created as string | null;
  if (!id) return null;
  store.getState().openEditor({ kind: 'source', deviceId: sel.deviceId, objectId: id });
  return ids.source(sel.deviceId, id);
}
