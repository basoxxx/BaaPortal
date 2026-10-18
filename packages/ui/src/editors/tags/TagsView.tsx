import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  findDevice,
  findTagTable,
  symbolNames,
  uniqueName,
  type PlcDevice,
  type Tag,
} from '@baaportal/project';
import { ELEMENTARY_TYPES } from '@baaportal/s7-types';
import { DataGrid, type DataGridProps, type GridColumn } from '../../grid/DataGrid';
import { parseTsv } from '../../grid/tsv';
import { beginDrag, endDrag } from '../../project/navigation/objectCommands';
import { useAppStore, useServices } from '../../state/AppContext';
import { cellKey, useCellDiagnostics } from '../../state/diagnostics';
import {
  addressAfter,
  cloneTags,
  fillTags,
  isRetentive,
  newTagAfter,
  normalizeAddress,
  normalizeType,
  tagsFromTsv,
  tagsToTsv,
} from './tagRows';

interface TagRow {
  tag: Tag;
  tableId: string;
  tableName: string;
}

const TAG_TYPES = [...ELEMENTARY_TYPES, 'Timer', 'Counter'];
const rowKey = (r: TagRow) => r.tag.id;
const newId = () => globalThis.crypto.randomUUID();

/** Tabelle in cui cercare: quella dell'editor, o tutte in "Mostra tutte le variabili". */
function scopeTables(dev: PlcDevice, tableId: string | null) {
  return tableId === null ? dev.tagTables : dev.tagTables.filter((t) => t.id === tableId);
}
function locate(dev: PlcDevice, tableId: string | null, id: string) {
  for (const table of scopeTables(dev, tableId)) {
    const index = table.tags.findIndex((t) => t.id === id);
    if (index >= 0) return { table, index };
  }
  return null;
}

interface Props {
  deviceId: string;
  /** null = tutte le tabelle del PLC. */
  tableId: string | null;
}

export function TagsView({ deviceId, tableId }: Props) {
  const { t } = useTranslation();
  const { store } = useServices();
  const device = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const tables = device?.tagTables;
  const props = device?.properties;
  const diagnostics = useCellDiagnostics(deviceId, 'tag', t);

  const rows = useMemo<TagRow[]>(
    () =>
      (tableId === null ? (tables ?? []) : (tables ?? []).filter((x) => x.id === tableId)).flatMap(
        (table) => table.tags.map((tag) => ({ tag, tableId: table.id, tableName: table.name })),
      ),
    [tables, tableId],
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.tag.id, r])), [rows]);

  const columns = useMemo<GridColumn<TagRow>[]>(() => {
    const cols: GridColumn<TagRow>[] = [
      {
        id: 'name',
        headerKey: 'tags.col.name',
        width: 200,
        editor: 'text',
        get: (r) => r.tag.name,
      },
      {
        id: 'type',
        headerKey: 'tags.col.type',
        width: 130,
        editor: 'type',
        get: (r) => r.tag.type,
        suggestions: () => TAG_TYPES,
      },
      {
        id: 'address',
        headerKey: 'tags.col.address',
        width: 110,
        editor: 'text',
        get: (r) => r.tag.address,
      },
      {
        id: 'retentive',
        headerKey: 'tags.col.retentive',
        headerTitleKey: 'tags.col.retentiveHint',
        width: 90,
        editor: 'checkbox',
        get: (r) => (props ? isRetentive(r.tag, props) : false),
        readOnly: () => true,
      },
      {
        id: 'hmi',
        headerKey: 'tags.col.hmi',
        width: 150,
        editor: 'checkbox',
        get: (r) => r.tag.hmi,
      },
    ];
    if (tableId === null)
      cols.push({
        id: 'table',
        headerKey: 'tags.col.table',
        width: 200,
        editor: 'none',
        get: (r) => r.tableName,
      });
    cols.push({
      id: 'comment',
      headerKey: 'tags.col.comment',
      width: 240,
      editor: 'text',
      get: (r) => r.tag.comment,
    });
    return cols;
  }, [props, tableId]);

  const edit = useCallback(
    (label: string, recipe: (dev: PlcDevice) => void) =>
      store.getState().edit(label, (p) => {
        const dev = findDevice(p, deviceId);
        if (dev) recipe(dev);
      }),
    [store, deviceId],
  );

  const onCommit = useCallback<DataGridProps<TagRow>['onCommit']>(
    (key, columnId, value) =>
      edit('history.editCell', (dev) => {
        const found = locate(dev, tableId, key);
        const tag = found?.table.tags[found.index];
        if (!tag) return;
        if (typeof value === 'boolean') {
          if (columnId === 'hmi') tag.hmi = value;
          return;
        }
        // Il nome si salva come scritto: se non è valido lo segna la diagnostica.
        if (columnId === 'name') tag.name = value;
        else if (columnId === 'type') tag.type = normalizeType(value);
        else if (columnId === 'address') tag.address = normalizeAddress(value);
        else if (columnId === 'comment') tag.comment = value;
      }),
    [edit, tableId],
  );

  const addRow = useMemo<NonNullable<DataGridProps<TagRow>['addRow']>>(
    () => [
      {
        afterKey: null,
        labelKey: 'grid.addRow',
        onAdd: (columnId, value) =>
          edit('history.addRow', (dev) => {
            // In "Mostra tutte le variabili" si aggiunge alla tabella standard (la prima).
            const table = tableId === null ? dev.tagTables[0] : findTagTable(dev, tableId);
            if (!table) return;
            const prev = table.tags[table.tags.length - 1];
            const name =
              columnId === 'name' ? value : uniqueName(t('defaults.tag'), symbolNames(dev));
            const tag = newTagAfter(prev, name, newId);
            if (columnId === 'type') {
              tag.type = normalizeType(value);
              tag.address = addressAfter(prev, tag.type);
            } else if (columnId === 'address') tag.address = normalizeAddress(value);
            else if (columnId === 'comment') tag.comment = value;
            table.tags.push(tag);
          }),
      },
    ],
    [edit, tableId, t],
  );

  const onDeleteRows = useCallback(
    (keys: string[]) =>
      edit('history.deleteRows', (dev) => {
        const gone = new Set(keys);
        for (const table of scopeTables(dev, tableId))
          if (table.tags.some((x) => gone.has(x.id)))
            table.tags = table.tags.filter((x) => !gone.has(x.id));
      }),
    [edit, tableId],
  );

  const copyRows = useCallback<NonNullable<DataGridProps<TagRow>['copyRows']>>(
    (keys) => {
      const tags = keys.flatMap((k) => byKey.get(k)?.tag ?? []);
      return {
        text: tagsToTsv(tags, (x) => (props ? isRetentive(x, props) : false)),
        payload: { kind: 'rows', rowKind: 'tag', rows: tags },
      };
    },
    [byKey, props],
  );

  const onPaste = useCallback<NonNullable<DataGridProps<TagRow>['onPaste']>>(
    (text, payload, atKey) => {
      let make: (taken: string[], prev: Tag | undefined) => Tag[];
      if (payload) {
        // Righe di altro genere (o oggetti dell'albero) qui non si incollano.
        if (payload.kind !== 'rows' || payload.rowKind !== 'tag') return;
        make = (taken) => cloneTags(payload.rows, taken, newId);
      } else {
        if (text.trim() === '') return;
        const parsed = parseTsv(text);
        make = (taken, prev) => tagsFromTsv(parsed, taken, newId, prev);
      }
      edit('history.pasteRows', (dev) => {
        // Dopo la riga attiva, nella sua tabella; senza riga attiva in fondo alla tabella standard.
        const at = atKey === null ? null : locate(dev, tableId, atKey);
        const table =
          at?.table ?? (tableId === null ? dev.tagTables[0] : findTagTable(dev, tableId));
        if (!table) return;
        const index = at ? at.index + 1 : table.tags.length;
        const fresh = make(symbolNames(dev), table.tags[index - 1]);
        if (fresh.length > 0) table.tags.splice(index, 0, ...fresh);
      });
    },
    [edit, tableId],
  );

  const onFill = useCallback(
    (sourceKey: string, count: number) =>
      edit('history.fillRows', (dev) => {
        const at = locate(dev, tableId, sourceKey);
        const source = at?.table.tags[at.index];
        if (!at || !source) return;
        at.table.tags.splice(at.index + 1, 0, ...fillTags(source, count, symbolNames(dev), newId));
      }),
    [edit, tableId],
  );

  const diagnostic = useCallback(
    (key: string, columnId: string) => diagnostics.get(cellKey(key, columnId)),
    [diagnostics],
  );

  const onRowDragStart = useCallback<NonNullable<DataGridProps<TagRow>['onRowDragStart']>>(
    (keys, e) => {
      if (!e.dataTransfer) return;
      const refs = keys.flatMap((k) => {
        const r = byKey.get(k);
        return r ? [{ kind: 'tag' as const, deviceId, tableId: r.tableId, id: k }] : [];
      });
      beginDrag(e.dataTransfer, store.getState().doc, deviceId, refs);
    },
    [byKey, store, deviceId],
  );

  if (!device) return null;
  return (
    <DataGrid<TagRow>
      label={tableId === null ? t('editor.allTags') : t('tags.tab.tags')}
      rows={rows}
      rowKey={rowKey}
      columns={columns}
      onCommit={onCommit}
      addRow={addRow}
      onDeleteRows={onDeleteRows}
      copyRows={copyRows}
      onPaste={onPaste}
      onFill={onFill}
      diagnostic={diagnostic}
      onRowDragStart={onRowDragStart}
      onRowDragEnd={endDrag}
    />
  );
}
