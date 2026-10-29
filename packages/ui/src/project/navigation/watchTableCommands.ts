// Tabelle di controllo nell'albero: copia e incolla di tabelle intere, importazione ed esportazione csv.
import type { StoreApi } from 'zustand/vanilla';
import { decodeSourceBytes, parseWatchCsv, watchToCsv } from '@baaportal/importers';
import { findCpu } from '@baaportal/catalog';
import {
  createWatchTable,
  findDevice,
  findWatchTable,
  uniqueName,
  watchResolverFor,
  type WatchFormat,
  type WatchTable,
} from '@baaportal/project';
import type { BaaBridge } from '../../bridge';
import { cloneWatchRows, isWatchFormat } from '../../editors/watch/watchEdit';
import { flushPendingEdits } from '../../flushPendingEdits';
import { t } from '../../i18n';
import { copyToClipboard, readClipboard } from '../../services/clipboard';
import type { AppState } from '../../state/store';
import { ids, parseNodeId } from './treeIds';

interface Ctx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

const newId = () => globalThis.crypto.randomUUID();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const deviceOf = (store: StoreApi<AppState>, id: string) => {
  const doc = store.getState().doc;
  return doc ? findDevice(doc.project, id) : undefined;
};
const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const stemOf = (path: string) => baseName(path).replace(/\.[^.]*$/, '');

/** Copia le tabelle di controllo dei nodi (tutte dello stesso PLC). false se non ce n'erano. */
export function copyWatchTables(ctx: Ctx, nodeIds: Iterable<string>): boolean {
  const refs = [...nodeIds].flatMap((n) => {
    const p = parseNodeId(n);
    return p.kind === 'watchTable' ? [{ dev: p.dev, id: p.id }] : [];
  });
  const dev = refs[0] && deviceOf(ctx.store, refs[0].dev);
  if (!dev) return false;
  const tables = refs.flatMap((r) => (r.dev === dev.id ? (findWatchTable(dev, r.id) ?? []) : []));
  if (tables.length === 0) return false;
  // Copia a mano: le tabelle dello store possono essere bozze.
  const plain = tables.map((x) => ({ ...x, rows: x.rows.map((r) => ({ ...r })) }));
  copyToClipboard(ctx.bridge, plain.map((x) => x.name).join('\n'), {
    kind: 'watchTables',
    deviceId: dev.id,
    tables: plain,
  });
  return true;
}

/** Il nodo accetta tabelle incollate: la cartella «Tabelle di controllo» o una tabella. */
export const watchPasteDevice = (nodeId: string): string | null => {
  const p = parseNodeId(nodeId);
  return (p.kind === 'folder' && p.folder === 'watch') || p.kind === 'watchTable' ? p.dev : null;
};

/** Incolla le tabelle copiate nel PLC del nodo (anche di un altro PLC); i nomi doppi si numerano. */
export async function pasteWatchTables(ctx: Ctx, nodeId: string): Promise<void> {
  const { store } = ctx;
  const devId = watchPasteDevice(nodeId);
  const { payload } = await readClipboard(ctx.bridge);
  if (!devId || payload?.kind !== 'watchTables') return;
  let last: string | undefined;
  store.getState().edit('history.pasteWatchTable', (p) => {
    const dev = findDevice(p, devId);
    if (!dev) return;
    for (const src of payload.tables) {
      const copy = createWatchTable(
        uniqueName(
          src.name,
          dev.watchTables.map((w) => w.name),
        ),
        newId,
      );
      copy.rows = cloneWatchRows(src.rows, newId);
      dev.watchTables.push(copy);
      last = copy.id;
    }
  });
  if (last) store.getState().select(ids.watchTable(devId, last));
}

const fail = (store: StoreApi<AppState>, textKey: string, params: Record<string, string>) => {
  const s = store.getState();
  s.pushMessage({ severity: 'error', textKey, params });
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
};

/** «Esporta…»: scrive la tabella in csv. */
export async function exportWatchTable(
  ref: { deviceId: string; id: string },
  ctx: Ctx,
): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  const find = () => {
    const dev = deviceOf(store, ref.deviceId);
    return dev && findWatchTable(dev, ref.id);
  };
  const first = find();
  if (!first) return;
  try {
    const path = await bridge.showSaveFileDialog({
      defaultName: `${first.name}.csv`,
      filters: [{ name: t('watchIo.filterCsv'), extensions: ['csv'] }],
    });
    if (!path) return;
    const table = find() ?? first;
    await bridge.writeFileAtomic(path, new TextEncoder().encode(watchToCsv(table)));
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.watchExported',
      params: { name: table.name, path },
    });
  } catch (e) {
    fail(store, 'messages.watchExportFailed', { name: first.name, message: errorText(e) });
  }
}

/**
 * «Importa…»: legge un csv e aggiunge le righe alla tabella (`tableId`), o a una tabella nuova
 * col nome del file. Le righe scartate sono nel messaggio.
 */
export async function importWatchTable(
  target: { deviceId: string; tableId?: string },
  ctx: Ctx,
): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  if (!deviceOf(store, target.deviceId)) return;
  let path: string | undefined;
  try {
    path = (
      await bridge.showOpenFileDialog({
        filters: [{ name: t('watchIo.filterCsv'), extensions: ['csv'] }],
      })
    )[0];
  } catch (e) {
    fail(store, 'messages.fileDialogFailed', { message: errorText(e) });
    return;
  }
  if (!path) return;
  const name = baseName(path);
  let parsed: ReturnType<typeof parseWatchCsv>;
  try {
    parsed = parseWatchCsv(decodeSourceBytes(await bridge.readFile(path)).text);
  } catch (e) {
    fail(store, 'messages.watchImportFailed', { name, message: errorText(e) });
    return;
  }
  let tableName = '';
  let tableId: string | undefined;
  if (parsed.rows.length > 0) {
    store.getState().edit('history.importWatch', (p) => {
      const dev = findDevice(p, target.deviceId);
      if (!dev) return;
      const table: WatchTable | undefined = target.tableId
        ? findWatchTable(dev, target.tableId)
        : createWatchTable(
            uniqueName(
              stemOf(path!) || t('defaults.watchTable'),
              dev.watchTables.map((w) => w.name),
            ),
            newId,
          );
      if (!table) return;
      const resolve = watchResolverFor(dev, findCpu(dev.cpu.typeId));
      for (const r of parsed.rows) {
        const known = resolve(r.operand);
        const wanted = r.format.toUpperCase();
        const format: WatchFormat = isWatchFormat(wanted)
          ? wanted
          : known.ok
            ? known.format
            : 'DEC';
        table.rows.push({
          id: newId(),
          operand: r.operand,
          format,
          ...(r.modify ? { modify: r.modify } : {}),
          ...(r.comment ? { comment: r.comment } : {}),
        });
      }
      tableName = table.name;
      if (!target.tableId) {
        dev.watchTables.push(table);
        tableId = table.id;
      }
    });
  }
  const s = store.getState();
  if (tableId) s.select(ids.watchTable(target.deviceId, tableId));
  const detail = parsed.errors
    .slice(0, 5)
    .map(
      (e) =>
        `; ${t('tagIo.skippedRow', { line: e.line, sheet: '', reason: t(`watchIo.err.${e.code}`) })}`,
    )
    .join('');
  s.pushMessage({
    severity: parsed.errors.length > 0 ? 'warning' : 'info',
    textKey: 'messages.watchImported',
    params: {
      name,
      count: String(parsed.rows.length),
      table: tableName,
      skipped: String(parsed.errors.length),
      detail,
    },
  });
}
