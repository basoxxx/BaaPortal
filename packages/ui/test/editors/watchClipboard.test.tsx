import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addWatchTable, createWatchRow, findDevice, type WatchRow } from '@baaportal/project';
import {
  cloneWatchRows,
  moveWatchRows,
  watchRowsFromTsv,
  watchRowsToTsv,
} from '../../src/editors/watch/watchEdit';
import { peekClipboardPayload } from '../../src/services/clipboard';
import {
  copyWatchTables,
  exportWatchTable,
  importWatchTable,
  pasteWatchTables,
} from '../../src/project/navigation/watchTableCommands';
import { ids } from '../../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from '../renderApp';

const PLC = 'id1';
const row = (id: string, operand = id): WatchRow => ({
  ...createWatchRow(operand, 'DEC', () => id),
});
const order = (rows: WatchRow[]) => rows.map((r) => r.id).join('');

describe('righe di tabella di controllo', () => {
  const rows = ['a', 'b', 'c', 'd'].map((i) => row(i));
  it('spostamento: verso il basso dopo il bersaglio, verso l’alto prima, null in fondo', () => {
    expect(order(moveWatchRows(rows, ['a'], 'c'))).toBe('bcad');
    expect(order(moveWatchRows(rows, ['d'], 'b'))).toBe('adbc');
    expect(order(moveWatchRows(rows, ['a', 'b'], null))).toBe('cdab');
    expect(order(moveWatchRows(rows, ['b', 'c'], 'c'))).toBe('abcd');
  });

  it('testo tabulare: andata e ritorno, formato non valido dedotto dall’operando', () => {
    const src: WatchRow[] = [{ ...row('a', '%MW10'), format: 'HEX', modify: '5', comment: 'c\td' }];
    const back = watchRowsFromTsv(
      watchRowsToTsv(src),
      () => 'n',
      () => 'DEC',
    );
    expect(back).toEqual([
      { id: 'n', operand: '%MW10', format: 'HEX', modify: '5', comment: 'c\td' },
    ]);
    expect(
      watchRowsFromTsv(
        'MB1\tXX\n\n',
        () => 'n',
        () => 'BIN',
      ),
    ).toMatchObject([{ operand: 'MB1', format: 'BIN' }]);
  });

  it('clona con id nuovi', () => {
    let n = 0;
    expect(cloneWatchRows([row('a')], () => `x${++n}`)).toEqual([row('x1', 'a')]);
  });
});

async function open(): Promise<RenderedApp> {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addWatchTable', (p) => {
      const t = addWatchTable(findDevice(p, PLC)!, 'Prova', () => 'wt1');
      t.rows.push(row('r1', '%MW10'), { ...row('r2', '%MW12'), modify: '=1' });
    });
  });
  return app;
}
const tables = (app: RenderedApp) =>
  findDevice(app.store.getState().doc!.project, PLC)!.watchTables;

describe('tabelle di controllo nell’albero', () => {
  it('copia e incolla: tabella nuova con nome univoco e id nuovi', async () => {
    const app = await open();
    const ctx = { store: app.store, bridge: app.bridge };
    expect(copyWatchTables(ctx, [ids.watchTable(PLC, 'wt1')])).toBe(true);
    expect(peekClipboardPayload()?.kind).toBe('watchTables');
    await pasteWatchTables(ctx, ids.folder(PLC, 'watch'));
    await pasteWatchTables(ctx, ids.watchTable(PLC, 'wt1'));
    const t = tables(app);
    expect(t.map((x) => x.name)).toEqual(['Prova', 'Prova_1', 'Prova_2']);
    expect(t[1]!.rows.map((r) => r.operand)).toEqual(['%MW10', '%MW12']);
    expect(t[1]!.rows[1]!.modify).toBe('=1');
    expect(new Set(t.flatMap((x) => x.rows.map((r) => r.id))).size).toBe(6);
    expect(app.store.getState().selection).toBe(ids.watchTable(PLC, t[2]!.id));
  });

  it('esporta in csv e importa in una tabella nuova e in una esistente', async () => {
    const app = await open();
    const ctx = { store: app.store, bridge: app.bridge };
    app.bridge.saveFileResults.push('/tmp/prova.csv');
    await exportWatchTable({ deviceId: PLC, id: 'wt1' }, ctx);
    const csv = new TextDecoder().decode(app.bridge.files.get('/tmp/prova.csv'));
    expect(csv).toContain("'=1");

    app.bridge.openFileResults.push(['/tmp/prova.csv']);
    await importWatchTable({ deviceId: PLC }, ctx);
    expect(tables(app).map((x) => x.name)).toEqual(['Prova', 'prova_1']);
    expect(tables(app)[1]!.rows.map((r) => [r.operand, r.modify])).toEqual([
      ['%MW10', undefined],
      ['%MW12', '=1'],
    ]);

    app.bridge.openFileResults.push(['/tmp/prova.csv']);
    await importWatchTable({ deviceId: PLC, tableId: 'wt1' }, ctx);
    expect(tables(app)[0]!.rows).toHaveLength(4);
  });
});
