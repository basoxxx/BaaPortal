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
  type PlcDevice,
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

const sameFields = (a: object, b: object): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Applica righe lette da file a una tabella (senza toccarla): nome già presente (maiuscole
 * indifferenti) aggiornato con lo stesso id, nome nuovo creato. Vale anche per le costanti.
 * `otherNames`: nomi (in minuscolo) di variabili e costanti delle ALTRE tabelle del PLC, con il
 * nome della tabella: un nome già lì non si crea (i nomi sono unici per CPU) e va negli scartati.
 */
export function applyTagImport(
  table: TagTable,
  parsed: ParsedTags,
  otherNames: ReadonlyMap<string, string> = new Map(),
): { table: TagTable; summary: ImportSummary } {
  // Copia a mano: dentro `edit` la tabella è una bozza, che structuredClone non copia.
  const out: TagTable = {
    ...table,
    tags: table.tags.map((x) => ({ ...x })),
    constants: table.constants.map((x) => ({ ...x })),
  };
  let created = 0;
  let updated = 0;
  const skipped: RowError[] = [...parsed.errors];
  const clash = (line: number, name: string, sheet?: 'constants'): boolean => {
    const other = otherNames.get(name.toLowerCase());
    if (other === undefined) return false;
    skipped.push({
      line,
      ...(sheet ? { sheet } : {}),
      code: 'NOME_IN_ALTRA_TABELLA',
      detail: other,
    });
    return true;
  };
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
    if (clash(r.line, r.name)) continue;
    const i = tagAt.get(r.name.toLowerCase());
    if (i === undefined) {
      tagAt.set(r.name.toLowerCase(), out.tags.length);
      out.tags.push({ id: newId(), ...values });
      created++;
    } else {
      const next = { id: out.tags[i]!.id, ...values };
      if (!sameFields(out.tags[i]!, next)) updated++;
      out.tags[i] = next;
    }
  }
  const constAt = indexOf(out.constants);
  for (const r of parsed.constants) {
    const values = { name: r.name, type: r.type, value: r.value, comment: r.comment };
    if (clash(r.line, r.name, 'constants')) continue;
    const i = constAt.get(r.name.toLowerCase());
    if (i === undefined) {
      constAt.set(r.name.toLowerCase(), out.constants.length);
      out.constants.push({ id: newId(), ...values });
      created++;
    } else {
      const next = { id: out.constants[i]!.id, ...values };
      if (!sameFields(out.constants[i]!, next)) updated++;
      out.constants[i] = next;
    }
  }
  return { table: out, summary: { created, updated, skipped } };
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
    const bytes = chosen === 'csv' ? new TextEncoder().encode(tagsToCsv(table)) : tagsToXlsx(table);
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
  const dev0 = hasDevice();
  // Nome che avrebbe la tabella nuova (mostrato anche se non si crea nulla).
  const newName = () =>
    uniqueName(
      stemOf(path!) || t('defaults.tagTable'),
      (hasDevice() as PlcDevice).tagTables.map((x) => x.name),
    );
  let tableName = target.tableId
    ? ((dev0 && findTagTable(dev0, target.tableId)?.name) ?? '')
    : newName();
  let tableId: string | undefined = target.tableId;
  if (hasRows) {
    try {
      store.getState().edit('history.importTags', (p) => {
        const dev = findDevice(p, target.deviceId);
        if (!dev) return;
        const existing = target.tableId ? findTagTable(dev, target.tableId) : undefined;
        if (target.tableId && !existing) return;
        const table = existing ?? createTagTable(newName());
        const others = new Map<string, string>();
        for (const o of dev.tagTables) {
          if (o.id === table.id) continue;
          for (const x of [...o.tags, ...o.constants]) others.set(x.name.toLowerCase(), o.name);
        }
        const res = applyTagImport(table, parsed, others);
        summary = res.summary;
        tableName = res.table.name;
        if (existing) {
          // Nulla è cambiato: nessuna assegnazione, quindi nessun passo di annullamento.
          if (res.summary.created > 0 || res.summary.updated > 0)
            Object.assign(existing, res.table);
        } else if (res.summary.created > 0) {
          dev.tagTables.push(res.table);
          tableId = res.table.id;
        }
      });
    } catch (e) {
      fail(store, 'messages.tagsImportFailed', { name, message: errorText(e) });
      return;
    }
  }
  const s = store.getState();
  if (!target.tableId && tableId) s.select(ids.tagTable(target.deviceId, tableId));
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
