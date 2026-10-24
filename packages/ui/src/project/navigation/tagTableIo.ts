import {
  decodeSourceBytes,
  parseTagsCsv,
  parseTagsXlsx,
  tagsToCsv,
  tagsToXlsx,
  XlsxFormatError,
  type ParsedTags,
  type RowError,
} from '@baaportal/importers';
import {
  createTagTable,
  findDevice,
  findTagTable,
  uniqueName,
  type TagTable,
} from '@baaportal/project';
import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge, FileFilter } from '../../bridge';
import { flushPendingEdits } from '../../flushPendingEdits';
import { t } from '../../i18n';
import type { AppState } from '../../state/store';
import { ids } from './treeIds';

export interface TagIoCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: RowError[];
}

type Format = 'xlsx' | 'csv';

const newId = () => globalThis.crypto.randomUUID();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const extOf = (path: string): string => {
  const n = baseName(path);
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i + 1).toLowerCase();
};
const stemOf = (path: string): string => {
  const n = baseName(path);
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
};
const filters = (first: Format): FileFilter[] => {
  const all: Record<Format, FileFilter> = {
    xlsx: { name: t('tagIo.filterXlsx'), extensions: ['xlsx'] },
    csv: { name: t('tagIo.filterCsv'), extensions: ['csv'] },
  };
  return [all[first], all[first === 'xlsx' ? 'csv' : 'xlsx']];
};

/**
 * Applica righe lette da file a una tabella (senza toccarla): nome già presente (maiuscole
 * indifferenti) aggiornato con lo stesso id, nome nuovo creato. Vale anche per le costanti.
 */
export function applyTagImport(
  table: TagTable,
  parsed: ParsedTags,
): { table: TagTable; summary: ImportSummary } {
  // Copia a mano: dentro `edit` la tabella è una bozza, che structuredClone non copia.
  const out: TagTable = {
    ...table,
    tags: table.tags.map((x) => ({ ...x })),
    constants: table.constants.map((x) => ({ ...x })),
  };
  let created = 0;
  let updated = 0;
  const indexOf = (list: { name: string }[]) =>
    new Map(list.map((x, i) => [x.name.toLowerCase(), i] as const));
  const tagAt = indexOf(out.tags);
  for (const r of parsed.tags) {
    const values = {
      name: r.name,
      type: r.type,
      address: r.address,
      comment: r.comment,
      hmi: r.hmi,
    };
    const i = tagAt.get(r.name.toLowerCase());
    if (i === undefined) {
      tagAt.set(r.name.toLowerCase(), out.tags.length);
      out.tags.push({ id: newId(), ...values });
      created++;
    } else {
      out.tags[i] = { id: out.tags[i]!.id, ...values };
      updated++;
    }
  }
  const constAt = indexOf(out.constants);
  for (const r of parsed.constants) {
    const values = { name: r.name, type: r.type, value: r.value, comment: r.comment };
    const i = constAt.get(r.name.toLowerCase());
    if (i === undefined) {
      constAt.set(r.name.toLowerCase(), out.constants.length);
      out.constants.push({ id: newId(), ...values });
      created++;
    } else {
      out.constants[i] = { id: out.constants[i]!.id, ...values };
      updated++;
    }
  }
  return { table: out, summary: { created, updated, skipped: [...parsed.errors] } };
}

const fail = (store: StoreApi<AppState>, textKey: string, params: Record<string, string>) => {
  const s = store.getState();
  s.pushMessage({ severity: 'error', textKey, params });
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
};

function formatMessage(e: unknown): string {
  return e instanceof XlsxFormatError ? t(`tagIo.formatErr.${e.code}`) : errorText(e);
}

/** "Esporta…": scrive la tabella in xlsx o csv, secondo l'estensione scelta nel dialogo. */
export async function exportTagTable(
  ref: { deviceId: string; id: string },
  format: Format,
  ctx: TagIoCtx,
): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  const find = () => {
    const dev = store.getState().doc && findDevice(store.getState().doc!.project, ref.deviceId);
    return dev ? findTagTable(dev, ref.id) : undefined;
  };
  const first = find();
  if (!first) return;
  try {
    let path = await bridge.showSaveFileDialog({
      defaultName: `${first.name}.${format}`,
      filters: filters(format),
    });
    if (!path) return;
    const chosen: Format = extOf(path) === 'csv' ? 'csv' : extOf(path) === 'xlsx' ? 'xlsx' : format;
    if (extOf(path) !== chosen) path = `${path}.${chosen}`;
    // La tabella si rilegge dopo la finestra: è quella di adesso.
    const table = find() ?? first;
    const bytes =
      chosen === 'csv' ? new TextEncoder().encode(`﻿${tagsToCsv(table)}`) : tagsToXlsx(table);
    await bridge.writeFileAtomic(path, bytes);
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.tagsExported',
      params: { name: table.name, path },
    });
  } catch (e) {
    fail(store, 'messages.tagsExportFailed', { name: first.name, message: errorText(e) });
  }
}

/** "Importa…": legge xlsx o csv e applica le righe valide in un solo passo; poi il riepilogo. */
export async function importTagTable(
  target: { deviceId: string; tableId?: string },
  ctx: TagIoCtx,
): Promise<void> {
  const { store, bridge } = ctx;
  flushPendingEdits();
  const hasDevice = () =>
    store.getState().doc && findDevice(store.getState().doc!.project, target.deviceId);
  if (!hasDevice()) return;
  let path: string | undefined;
  try {
    path = (await bridge.showOpenFileDialog({ filters: filters('xlsx') }))[0];
  } catch (e) {
    fail(store, 'messages.fileDialogFailed', { message: errorText(e) });
    return;
  }
  if (!path) return;
  const name = baseName(path);
  let parsed: ParsedTags;
  try {
    const bytes = await bridge.readFile(path);
    parsed =
      extOf(path) === 'csv' ? parseTagsCsv(decodeSourceBytes(bytes).text) : parseTagsXlsx(bytes);
  } catch (e) {
    fail(store, 'messages.tagsImportFailed', { name, message: formatMessage(e) });
    return;
  }
  const hasRows = parsed.tags.length + parsed.constants.length > 0;
  let summary: ImportSummary = { created: 0, updated: 0, skipped: parsed.errors };
  let tableName = '';
  let tableId: string | undefined = target.tableId;
  if (hasRows) {
    try {
      store.getState().edit('history.importTags', (p) => {
        const dev = findDevice(p, target.deviceId);
        if (!dev) return;
        let table = target.tableId ? findTagTable(dev, target.tableId) : undefined;
        if (target.tableId && !table) return;
        const isNew = !table;
        if (!table) {
          table = createTagTable(
            uniqueName(
              stemOf(path!) || t('defaults.tagTable'),
              dev.tagTables.map((x) => x.name),
            ),
          );
        }
        const res = applyTagImport(table, parsed);
        if (isNew) dev.tagTables.push(res.table);
        else Object.assign(table, res.table);
        summary = res.summary;
        tableName = res.table.name;
        tableId = res.table.id;
      });
    } catch (e) {
      fail(store, 'messages.tagsImportFailed', { name, message: errorText(e) });
      return;
    }
  } else if (target.tableId) {
    const dev = hasDevice();
    tableName = (dev && findTagTable(dev, target.tableId)?.name) || '';
  }
  const s = store.getState();
  if (!target.tableId && tableId && hasRows) s.select(ids.tagTable(target.deviceId, tableId));
  s.pushMessage({
    severity: summary.skipped.length > 0 ? 'warning' : 'info',
    textKey: 'messages.tagsImported',
    params: {
      name,
      created: String(summary.created),
      updated: String(summary.updated),
      skipped: String(summary.skipped.length),
    },
  });
  s.setInspectorTab('info');
  s.setPanel('inspector', { open: true });
  s.openDialog({ kind: 'importTagsReport', fileName: name, tableName, summary });
}
