import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  findDevice,
  findTagTable,
  renameWithReferences,
  symbolNames,
  uniqueName,
  type PlcDevice,
  type TagTable,
  type UserConstant,
} from '@baaportal/project';
import { ELEMENTARY_TYPES } from '@baaportal/s7-types';
import { DataGrid, type DataGridProps, type GridColumn } from '../../grid/DataGrid';
import { parseTsv, toTsv } from '../../grid/tsv';
import { useShownTexts, type ShownTexts } from '../../state/shownText';
import { useAppStore, useServices } from '../../state/AppContext';
import { cellKey, useCellDiagnostics } from '../../state/diagnostics';
import {
  cloneConstants,
  constantsFromTsv,
  defaultValueOf,
  fillConstants,
  newConstantAfter,
  normalizeType,
} from './tagRows';

const TYPES = [...ELEMENTARY_TYPES];
const rowKey = (c: UserConstant) => c.id;
const newId = () => globalThis.crypto.randomUUID();

const columnsFor = (deviceId: string, tx: ShownTexts): GridColumn<UserConstant>[] => [
  { id: 'name', headerKey: 'tags.col.name', width: 200, editor: 'text', get: (c) => c.name },
  {
    id: 'type',
    headerKey: 'tags.col.type',
    width: 130,
    editor: 'type',
    get: (c) => c.type,
    suggestions: () => TYPES,
  },
  { id: 'value', headerKey: 'tags.col.value', width: 160, editor: 'text', get: (c) => c.value },
  {
    id: 'comment',
    headerKey: 'tags.col.comment',
    width: 280,
    editor: 'text',
    get: (c) => tx.shown(deviceId, c.id, 'comment', c.comment),
    readOnly: () => tx.lang !== null,
  },
];

export function ConstantsView({ deviceId, tableId }: { deviceId: string; tableId: string }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const table = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, deviceId) : undefined;
    return dev ? findTagTable(dev, tableId) : undefined;
  });
  const diagnostics = useCellDiagnostics(deviceId, 'constant', t);
  const tx = useShownTexts();
  const columns = useMemo(() => columnsFor(deviceId, tx), [deviceId, tx]);
  const rows = table?.constants ?? [];
  const byKey = useMemo(() => new Map(rows.map((c) => [c.id, c])), [rows]);

  const edit = useCallback(
    (label: string, recipe: (table: TagTable, names: string[], dev: PlcDevice) => void) =>
      store.getState().edit(label, (p) => {
        const dev = findDevice(p, deviceId);
        const tbl = dev && findTagTable(dev, tableId);
        if (dev && tbl) recipe(tbl, symbolNames(dev), dev);
      }),
    [store, deviceId, tableId],
  );

  const onCommit = useCallback<DataGridProps<UserConstant>['onCommit']>(
    (key, columnId, value) =>
      edit('history.editCell', (tbl, _names, dev) => {
        const c = tbl.constants.find((x) => x.id === key);
        if (!c || typeof value === 'boolean') return;
        // Il nome cambia anche nel codice AWL che lo usa, nello stesso passo.
        if (columnId === 'name')
          renameWithReferences(dev, { kind: 'constant', deviceId, tableId, id: c.id }, value);
        else if (columnId === 'type') c.type = normalizeType(value);
        else if (columnId === 'value') c.value = value;
        else if (columnId === 'comment') c.comment = value;
      }),
    [edit, deviceId, tableId],
  );

  const addRow = useMemo<NonNullable<DataGridProps<UserConstant>['addRow']>>(
    () => [
      {
        afterKey: null,
        labelKey: 'grid.addRow',
        onAdd: (columnId, value) =>
          edit('history.addRow', (tbl, names) => {
            const prev = tbl.constants[tbl.constants.length - 1];
            const name = columnId === 'name' ? value : uniqueName(t('defaults.constant'), names);
            const c = newConstantAfter(prev, name, newId);
            if (columnId === 'type') {
              c.type = normalizeType(value);
              c.value = defaultValueOf(c.type);
            } else if (columnId === 'value') c.value = value;
            else if (columnId === 'comment') c.comment = value;
            tbl.constants.push(c);
          }),
      },
    ],
    [edit, t],
  );

  const onDeleteRows = useCallback(
    (keys: string[]) =>
      edit('history.deleteRows', (tbl) => {
        const gone = new Set(keys);
        tbl.constants = tbl.constants.filter((c) => !gone.has(c.id));
      }),
    [edit],
  );

  const copyRows = useCallback<NonNullable<DataGridProps<UserConstant>['copyRows']>>(
    (keys) => {
      const items = keys.flatMap((k) => byKey.get(k) ?? []);
      return {
        text: toTsv(items.map((c) => [c.name, c.type, c.value, c.comment])),
        payload: { kind: 'rows', rowKind: 'constant', rows: items },
      };
    },
    [byKey],
  );

  const onPaste = useCallback<NonNullable<DataGridProps<UserConstant>['onPaste']>>(
    (text, payload, atKey) => {
      let make: (taken: string[]) => UserConstant[];
      if (payload) {
        if (payload.kind !== 'rows' || payload.rowKind !== 'constant') return;
        make = (taken) => cloneConstants(payload.rows, taken, newId);
      } else {
        if (text.trim() === '') return;
        const parsed = parseTsv(text);
        make = (taken) => constantsFromTsv(parsed, taken, newId);
      }
      edit('history.pasteRows', (tbl, names) => {
        const at = atKey === null ? -1 : tbl.constants.findIndex((c) => c.id === atKey);
        const fresh = make(names);
        if (fresh.length > 0)
          tbl.constants.splice(at >= 0 ? at + 1 : tbl.constants.length, 0, ...fresh);
      });
    },
    [edit],
  );

  const onFill = useCallback(
    (sourceKey: string, count: number) =>
      edit('history.fillRows', (tbl, names) => {
        const at = tbl.constants.findIndex((c) => c.id === sourceKey);
        const source = tbl.constants[at];
        if (source) tbl.constants.splice(at + 1, 0, ...fillConstants(source, count, names, newId));
      }),
    [edit],
  );

  const diagnostic = useCallback(
    (key: string, columnId: string) => diagnostics.get(cellKey(key, columnId)),
    [diagnostics],
  );

  if (!table) return null;
  return (
    <DataGrid<UserConstant>
      label={t('tags.tab.constants')}
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
    />
  );
}
