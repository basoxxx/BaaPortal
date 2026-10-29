import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { findCpu } from '@baaportal/catalog';
import {
  createWatchRow,
  findDevice,
  findWatchTable,
  watchResolverFor,
  type PlcDevice,
  type WatchFormat,
  type WatchRow,
} from '@baaportal/project';
import {
  DataGrid,
  type DataGridProps,
  type GridColumn,
  type GridDiagnostic,
} from '../../grid/DataGrid';
import { WatchOnlineController } from '../../online/watchOnline';
import { MAX_WATCH_ITEMS } from '../../sim/protocol';
import { simControllerFor } from '../../sim/simController';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import {
  ONLINE_MAX_ITEMS,
  WATCH_FORMATS,
  addressText,
  parseCommand,
  planCommand,
  resolveRows,
  statusOf,
  watchPlan,
  type WatchSource,
  type RowInfo,
  type WatchRowError,
} from './watchRows';
import { cloneWatchRows, moveWatchRows, watchRowsFromTsv, watchRowsToTsv } from './watchEdit';
import './watch.css';

interface ViewRow {
  row: WatchRow;
  info: RowInfo;
  status: string;
  /** Errore da segnalare sulla cella di stato (valore illeggibile). */
  statusError: WatchRowError | undefined;
  /** Errore del valore di comando: scritto adesso o dell'ultimo «Comanda». */
  commandError: WatchRowError | undefined;
}

const newId = () => globalThis.crypto.randomUUID();
// Durante dragover i dati del trascinamento non sono leggibili: si ricordano qui.
let dragging: { tableId: string; keys: string[] } | null = null;
const rowKey = (r: ViewRow) => r.row.id;

function errorText(e: WatchRowError, t: TFunction): string {
  return t(`watch.err.${e.key}`, e.params);
}

/** Tabella di controllo: operandi, valori di stato dal simulatore e valori di comando. */
export function WatchTableView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const { deviceId, objectId: tableId } = editor;
  const device = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const table = device && findWatchTable(device, tableId);
  const simOn = useAppStore((s) => s.sim.phase === 'on' && s.sim.deviceId === deviceId);
  const plcOn = useAppStore((s) => s.online.status === 'on' && s.online.deviceId === deviceId);
  // La sorgente: il simulatore se è attivo, il PLC se si è online, altrimenti nessuna.
  const source: WatchSource | null = simOn ? 'sim' : plcOn ? 'plc' : null;
  const online = useMemo(() => new WatchOnlineController(store, bridge), [store, bridge]);
  const onlineState = useSyncExternalStore(online.subscribe, online.getState);
  const simWatching = useAppStore(
    (s) => s.sim.watch?.deviceId === deviceId && s.sim.watch.tableId === tableId,
  );
  const watching = source === 'plc' ? onlineState.running : source === 'sim' && simWatching;
  const simValues = useAppStore((s) => (simWatching ? s.sim.watchValues : null));
  const values = source === 'plc' ? onlineState.values : source === 'sim' ? simValues : null;
  const [busy, setBusy] = useState(false);
  // Errori dell'ultimo «Comanda», per riga; si azzerano quando il valore di comando cambia.
  const [commandErrors, setCommandErrors] = useState<Record<string, WatchRowError>>({});
  const [lastWritten, setLastWritten] = useState<number | null>(null);

  const infos = useMemo(() => {
    if (!device || !table) return new Map<string, RowInfo>();
    const resolve = watchResolverFor(device, findCpu(device.cpu.typeId));
    return source === 'plc'
      ? resolveRows(resolve, table.rows, ONLINE_MAX_ITEMS, 'plc')
      : resolveRows(resolve, table.rows, MAX_WATCH_ITEMS, 'sim');
  }, [device, table, source]);

  // Il piano di lettura sul PLC segue le righe; fuori dal PLC o a tabella chiusa l'osservazione si ferma.
  useEffect(() => {
    if (source !== 'plc' || !table) {
      online.stop();
      return;
    }
    const plan = watchPlan(table.rows, (row) => infos.get(row.id)!);
    online.setPlan(plan.rowIds, plan.items);
  }, [online, source, table, infos]);
  useEffect(() => () => online.stop(), [online]);
  // Cambiata la sorgente, i risultati dell'ultimo comando non valgono più.
  useEffect(() => {
    setCommandErrors({});
    setLastWritten(null);
  }, [source]);

  // Una riga nuova solo se qualcosa è cambiato: la griglia non ridisegna le righe uguali.
  const cache = useRef(new Map<string, ViewRow>());
  const rows = useMemo<ViewRow[]>(() => {
    if (!table) return [];
    const next = new Map<string, ViewRow>();
    const out = table.rows.map((row) => {
      const info = infos.get(row.id)!;
      const st = statusOf(info, values?.[row.id]);
      const unavailable = source === 'plc' && !info.ok && info.error.key === 'ONLINE_UNSUPPORTED';
      const status = unavailable ? t('watch.unavailable') : st && 'text' in st ? st.text : '';
      const statusError =
        info.ok && !info.formatError && st && 'error' in st ? st.error : undefined;
      let commandError = commandErrors[row.id];
      const text = row.modify?.trim() ?? '';
      if (!commandError && text !== '' && info.ok && !info.formatError) {
        const p = parseCommand(text, info.format, info.target.size, info.sign);
        if (!p.ok) commandError = p.error;
      }
      const old = cache.current.get(row.id);
      if (
        old &&
        old.row === row &&
        old.info === info &&
        old.status === status &&
        old.statusError === statusError &&
        old.commandError === commandError
      ) {
        next.set(row.id, old);
        return old;
      }
      const made = { row, info, status, statusError, commandError };
      next.set(row.id, made);
      return made;
    });
    cache.current = next;
    return out;
  }, [table, infos, values, commandErrors, source, t]);

  const edit = useCallback(
    (label: string, recipe: (dev: PlcDevice) => void) =>
      store.getState().edit(label, (p) => {
        const dev = findDevice(p, deviceId);
        if (dev) recipe(dev);
      }),
    [store, deviceId],
  );

  const columns = useMemo<GridColumn<ViewRow>[]>(
    () => [
      {
        id: 'operand',
        headerKey: 'watch.col.name',
        width: 220,
        editor: 'text',
        get: (r) => r.row.operand,
      },
      {
        id: 'address',
        headerKey: 'watch.col.address',
        width: 110,
        editor: 'none',
        get: (r) => (r.info.ok ? addressText(r.info.target) : ''),
      },
      {
        id: 'format',
        headerKey: 'watch.col.format',
        width: 100,
        editor: 'type',
        get: (r) => r.row.format,
        suggestions: () => [...WATCH_FORMATS],
      },
      {
        id: 'status',
        headerKey: 'watch.col.status',
        width: 150,
        editor: 'none',
        get: (r) => r.status,
      },
      {
        id: 'modify',
        headerKey: 'watch.col.modify',
        width: 150,
        editor: 'text',
        get: (r) => r.row.modify ?? '',
      },
      {
        id: 'comment',
        headerKey: 'watch.col.comment',
        width: 240,
        editor: 'text',
        get: (r) => r.row.comment ?? '',
      },
    ],
    [],
  );

  const onCommit = useCallback<DataGridProps<ViewRow>['onCommit']>(
    (key, columnId, value) => {
      if (typeof value === 'boolean') return;
      // L'errore dell'ultimo «Comanda» vale per il vecchio contenuto della riga.
      if (columnId === 'modify' || columnId === 'operand' || columnId === 'format')
        setCommandErrors((e) => {
          if (!(key in e)) return e;
          const rest = { ...e };
          delete rest[key];
          return rest;
        });
      edit('history.editCell', (dev) => {
        const row = findWatchTable(dev, tableId)?.rows.find((r) => r.id === key);
        if (!row) return;
        if (columnId === 'operand') {
          row.operand = value.trim();
          // Il formato predefinito segue il tipo del nuovo operando.
          const r = watchResolverFor(dev, findCpu(dev.cpu.typeId))(row.operand);
          if (r.ok) row.format = r.format;
        } else if (columnId === 'format') {
          const f = value.trim().toUpperCase();
          if ((WATCH_FORMATS as readonly string[]).includes(f)) row.format = f as WatchFormat;
        } else if (columnId === 'modify') {
          if (value.trim() === '') delete row.modify;
          else row.modify = value.trim();
        } else if (columnId === 'comment') {
          if (value === '') delete row.comment;
          else row.comment = value;
        }
      });
    },
    [edit, tableId],
  );

  const addRow = useMemo<NonNullable<DataGridProps<ViewRow>['addRow']>>(
    () => [
      {
        afterKey: null,
        labelKey: 'grid.addRow',
        onAdd: (columnId, value) =>
          edit('history.addRow', (dev) => {
            const tb = findWatchTable(dev, tableId);
            if (!tb) return;
            const row = createWatchRow('', 'DEC', newId);
            if (columnId === 'operand') {
              row.operand = value.trim();
              const r = watchResolverFor(dev, findCpu(dev.cpu.typeId))(row.operand);
              if (r.ok) row.format = r.format;
            } else if (columnId === 'comment' && value !== '') row.comment = value;
            tb.rows.push(row);
          }),
      },
    ],
    [edit, tableId],
  );

  const onDeleteRows = useCallback(
    (keys: string[]) =>
      edit('history.deleteRows', (dev) => {
        const tb = findWatchTable(dev, tableId);
        if (!tb) return;
        const gone = new Set(keys);
        tb.rows = tb.rows.filter((r) => !gone.has(r.id));
      }),
    [edit, tableId],
  );

  const copyRows = useCallback<NonNullable<DataGridProps<ViewRow>['copyRows']>>(
    (keys) => {
      const gone = new Set(keys);
      const picked = (table?.rows ?? []).filter((r) => gone.has(r.id)).map((r) => ({ ...r }));
      return {
        text: watchRowsToTsv(picked),
        payload: { kind: 'rows', rowKind: 'watch', rows: picked },
      };
    },
    [table],
  );

  const onPaste = useCallback<NonNullable<DataGridProps<ViewRow>['onPaste']>>(
    (text, payload, atKey) => {
      // Righe di altro genere (o oggetti dell'albero) qui non si incollano.
      if (payload && (payload.kind !== 'rows' || payload.rowKind !== 'watch')) return;
      edit('history.pasteRows', (dev) => {
        const tb = findWatchTable(dev, tableId);
        if (!tb) return;
        const fresh = payload
          ? cloneWatchRows(payload.rows as WatchRow[], newId)
          : watchRowsFromTsv(text, newId, (op) => {
              const r = watchResolverFor(dev, findCpu(dev.cpu.typeId))(op);
              return r.ok ? r.format : 'DEC';
            });
        const at = atKey === null ? -1 : tb.rows.findIndex((r) => r.id === atKey);
        tb.rows.splice(at < 0 ? tb.rows.length : at + 1, 0, ...fresh);
      });
    },
    [edit, tableId],
  );

  const onRowDragStart = useCallback<NonNullable<DataGridProps<ViewRow>['onRowDragStart']>>(
    (keys, e) => {
      dragging = { tableId, keys };
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', keys.join('\n'));
        e.dataTransfer.effectAllowed = 'move';
      }
    },
    [tableId],
  );
  // Si accettano solo righe di questa tabella: l'ordine cambia, nulla viene copiato.
  const onDragOverRow = useCallback(
    (e: DragEvent) => {
      if (dragging?.tableId !== tableId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    },
    [tableId],
  );
  const onDropOnRow = useCallback(
    (_e: DragEvent, rowKey: string | null) => {
      const d = dragging;
      dragging = null;
      if (d?.tableId !== tableId) return;
      edit('history.moveRows', (dev) => {
        const tb = findWatchTable(dev, tableId);
        if (tb) tb.rows = moveWatchRows(tb.rows, d.keys, rowKey);
      });
    },
    [edit, tableId],
  );

  const diagnostic = useCallback(
    (key: string, columnId: string): GridDiagnostic | undefined => {
      const r = cache.current.get(key);
      if (!r) return undefined;
      const err = (e: WatchRowError | undefined): GridDiagnostic | undefined =>
        e ? { severity: 'error', text: errorText(e, t) } : undefined;
      switch (columnId) {
        case 'operand':
          // Una riga vuota è solo un segnaposto.
          return !r.info.ok && r.info.error.key !== 'row.EMPTY' ? err(r.info.error) : undefined;
        case 'format':
          return r.info.ok ? err(r.info.formatError) : undefined;
        case 'status':
          return err(r.statusError);
        case 'modify':
          return err(r.commandError);
      }
      return undefined;
    },
    [t],
  );

  if (!device || !table) return null;
  const controller = simControllerFor(store);
  const command = () => {
    if (source === 'plc') {
      const plan = planCommand(table.rows, (row) => infos.get(row.id)!, 'plc');
      const writes = plan.writes.map(({ rowId, req }) => {
        const { data, ...target } = req;
        return { rowId, target, data };
      });
      if (writes.length === 0) {
        setCommandErrors(plan.errors);
        setLastWritten(0);
        return;
      }
      setBusy(true);
      void online.command(writes).then((res) => {
        setBusy(false);
        if (res.kind === 'cancelled') return; // l'utente ha detto «Annulla»: nessun messaggio
        if (res.kind === 'error') {
          const failed = Object.fromEntries(
            writes.map((w) => [w.rowId, { key: 'HOST', params: { message: res.message } }]),
          );
          setCommandErrors({ ...plan.errors, ...failed });
          setLastWritten(0);
          return;
        }
        setCommandErrors({ ...plan.errors, ...res.errors });
        setLastWritten(res.written);
      });
      return;
    }
    void controller.commandWatch(deviceId, tableId).then((res) => {
      if (!res) return;
      setCommandErrors(res.errors);
      setLastWritten(res.written);
    });
  };
  const failed = Object.keys(commandErrors).length;
  return (
    <div className="baa-editor-body baa-watch-editor" data-testid={`editor-body-${editor.key}`}>
      <div
        className={`baa-watch-bar${source ? '' : ' is-unavailable'}`}
        role={source ? 'status' : 'alert'}
        data-testid="watch-bar"
      >
        <span className="baa-watch-msg">
          {!source ? t('watch.plcOff') : t(watching ? 'watch.on' : 'watch.off')}
          {source && lastWritten !== null
            ? ` ${t('watch.commanded', { count: lastWritten, failed })}`
            : ''}
        </span>
        <button
          type="button"
          className="baa-panel-btn"
          aria-pressed={watching}
          disabled={!source}
          onClick={() => {
            setLastWritten(null);
            if (source === 'plc') {
              if (onlineState.running) online.stop();
              else online.start();
            } else controller.toggleWatch(deviceId, tableId);
          }}
        >
          {t('watch.watchAll')}
        </button>
        <button
          type="button"
          className="baa-panel-btn"
          disabled={!source || busy}
          onClick={command}
        >
          {t('watch.command')}
        </button>
      </div>
      <div className="baa-watch-grid">
        <DataGrid<ViewRow>
          label={table.name}
          rows={rows}
          rowKey={rowKey}
          columns={columns}
          onCommit={onCommit}
          addRow={addRow}
          onDeleteRows={onDeleteRows}
          copyRows={copyRows}
          onPaste={onPaste}
          onRowDragStart={onRowDragStart}
          onRowDragEnd={() => (dragging = null)}
          onDragOverRow={onDragOverRow}
          onDropOnRow={onDropOnRow}
          diagnostic={diagnostic}
        />
      </div>
    </div>
  );
}
