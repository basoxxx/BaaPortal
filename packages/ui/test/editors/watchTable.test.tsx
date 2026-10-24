import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addWatchTable,
  createWatchRow,
  findDevice,
  readBaap,
  writeBaap,
  type PlcDevice,
  type WatchRow,
} from '@baaportal/project';
import { deleteNodes, renameNode, checkRename } from '../../src/project/navigation/objectCommands';
import { ids } from '../../src/project/navigation/treeIds';
import { SimController } from '../../src/sim/simController';
import { renderApp, type RenderedApp } from '../renderApp';

const PLC = 'id1';
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const tables = (app: RenderedApp) => dev(app).watchTables;
const past = (app: RenderedApp) => app.store.getState().history.past.length;

afterEach(() => vi.restoreAllMocks());

async function open(setup?: (d: PlcDevice) => void) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addWatchTable', (p) => {
      const d = findDevice(p, PLC)!;
      d.tagTables[0]!.tags.push({
        id: 'tg1',
        name: 'Vel',
        type: 'Int',
        address: '%MW20',
        hmi: false,
        comment: '',
      });
      const t = addWatchTable(d, 'Prova', () => 'wt1');
      t.rows.push({ ...createWatchRow('"Vel"', 'DEC', () => 'r1'), modify: '12' });
      t.rows.push(createWatchRow('"Sconosciuto"', 'DEC', () => 'r2'));
      setup?.(d);
    });
    app.store.getState().openEditor({ kind: 'watchTable', deviceId: PLC, objectId: 'wt1' });
  });
  return app;
}

const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-col-id="${col}"]`)!;
const addCell = (col: string) =>
  document.querySelector<HTMLElement>(`.is-add [data-col-id="${col}"]`)!;
const text = (c: HTMLElement) => document.getElementById(c.getAttribute('aria-describedby')!);
const simOn = (app: RenderedApp) =>
  act(() => app.store.getState().setSim({ phase: 'on', deviceId: PLC }));

describe("tabelle di controllo nell'albero", () => {
  it('«Aggiungi nuova tabella di controllo» crea, apre e seleziona; annulla e ripristina', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await app.user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:watch-add`));
    expect(tables(app).map((t) => t.name)).toEqual(['Tabella di controllo_1']);
    const id = tables(app)[0]!.id;
    expect(app.store.getState().selection).toBe(ids.watchTable(PLC, id));
    expect(app.store.getState().workArea.panes[0]).toBe(`watchTable:${PLC}:${id}`);
    expect(screen.getByTestId(`tree-node-${ids.watchTable(PLC, id)}`)).toHaveTextContent(
      'Tabella di controllo_1 [0]',
    );
    // una seconda ha un nome libero
    await app.user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:watch-add`));
    expect(tables(app).map((t) => t.name)).toEqual([
      'Tabella di controllo_1',
      'Tabella di controllo_2',
    ]);
    act(() => app.store.getState().undo());
    expect(tables(app)).toHaveLength(1);
    act(() => app.store.getState().redo());
    expect(tables(app)).toHaveLength(2);
  });

  it('rinomina (nome libero, non vuoto) e annulla; elimina con conferma e annulla', async () => {
    const app = await open();
    const node = ids.watchTable(PLC, 'wt1');
    act(() => void addSecondTable(app));
    expect(checkRename(app.store.getState().doc, node, '  ')).toBe('INVALID');
    expect(checkRename(app.store.getState().doc, node, 'altra')).toBe('DUPLICATE');
    expect(renameNode(app.store, node, 'Motori')).toBeNull();
    expect(tables(app).map((t) => t.name)).toEqual(['Motori', 'Altra']);
    act(() => app.store.getState().undo());
    expect(tables(app).map((t) => t.name)).toEqual(['Prova', 'Altra']);

    await act(async () => {
      await deleteNodes({ store: app.store, bridge: app.bridge }, [node]);
    });
    expect(tables(app).map((t) => t.name)).toEqual(['Altra']);
    expect(app.store.getState().selection).not.toBe(node);
    act(() => app.store.getState().undo());
    expect(tables(app).map((t) => t.name)).toEqual(['Prova', 'Altra']);
    expect(tables(app)[0]!.rows).toHaveLength(2);
  });

  it('le tabelle vanno nel file e si riaprono', async () => {
    const app = await open();
    const project = app.store.getState().doc!.project;
    const back = readBaap(writeBaap(project, { appVersion: 'x' }));
    expect(back.devices[0]!.watchTables).toEqual(tables(app));
  });
});

function addSecondTable(app: RenderedApp) {
  app.store.getState().edit('history.addWatchTable', (p) => {
    addWatchTable(findDevice(p, PLC)!, 'Altra', () => 'wt2');
  });
}

describe('editor della tabella di controllo', () => {
  it('righe con indirizzo risolto e formato predefinito; operando sconosciuto segnalato', async () => {
    await open();
    expect(screen.getByRole('grid', { name: 'Prova' })).toBeInTheDocument();
    expect(cell('r1', 'address')).toHaveTextContent('MW 20');
    expect(cell('r1', 'format')).toHaveTextContent('DEC');
    expect(cell('r1', 'modify')).toHaveTextContent('12');
    expect(cell('r2', 'operand')).toHaveClass('is-error');
    expect(text(cell('r2', 'operand'))).toHaveTextContent('Simbolo o membro sconosciuto.');
    expect(cell('r2', 'address')).toHaveTextContent('');
  });

  it('simulazione spenta: messaggio e pulsanti disattivati', async () => {
    await open();
    expect(screen.getByTestId('watch-bar')).toHaveTextContent('Avvia la simulazione');
    expect(screen.getByRole('button', { name: 'Osserva tutto' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Comanda' })).toBeDisabled();
  });

  it('scrivere nella riga <Aggiungi> crea una riga con il formato del tipo; un solo passo di annulla', async () => {
    const app = await open();
    const before = past(app);
    await app.user.click(addCell('operand'));
    await app.user.keyboard('"Vel"{Enter}');
    const rows = tables(app)[0]!.rows;
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ operand: '"Vel"', format: 'DEC' });
    expect(past(app)).toBe(before + 1);
    await app.user.click(addCell('operand'));
    await app.user.keyboard('M 4.1{Enter}');
    expect(tables(app)[0]!.rows[3]).toMatchObject({ operand: 'M 4.1', format: 'BOOL' });
  });

  it('modificare l operando riporta il formato predefinito; il formato e il comando si modificano', async () => {
    const app = await open();
    await app.user.dblClick(cell('r1', 'operand'));
    await app.user.keyboard('{Control>}a{/Control}MD 8{Enter}');
    expect(tables(app)[0]!.rows[0]).toMatchObject({ operand: 'MD 8', format: 'DEC' });
    await app.user.dblClick(cell('r1', 'format'));
    await app.user.keyboard('{Control>}a{/Control}float{Enter}');
    expect(tables(app)[0]!.rows[0]!.format).toBe('FLOAT');
    // comando non valido per il formato: segnalato subito
    await app.user.dblClick(cell('r1', 'modify'));
    await app.user.keyboard('{Control>}a{/Control}abc{Enter}');
    expect(cell('r1', 'modify')).toHaveClass('is-error');
    expect(text(cell('r1', 'modify'))).toHaveTextContent('Valore non valido per il formato.');
    await app.user.dblClick(cell('r1', 'modify'));
    await app.user.keyboard('{Control>}a{/Control}1.5{Enter}');
    expect(cell('r1', 'modify')).not.toHaveClass('is-error');
    // formato che non si addice alla dimensione: segnalato sul formato
    await app.user.dblClick(cell('r1', 'format'));
    await app.user.keyboard('{Control>}a{/Control}s5time{Enter}');
    expect(cell('r1', 'format')).toHaveClass('is-error');
  });

  it('mostra i valori di stato nel formato della riga', async () => {
    const app = await open();
    simOn(app);
    act(() =>
      app.store.getState().setSim({
        watch: { deviceId: PLC, tableId: 'wt1' },
        watchValues: { r1: { bytes: Uint8Array.of(0xff, 0xfb) } },
      }),
    );
    expect(cell('r1', 'status')).toHaveTextContent('-5');
    act(() =>
      app.store.getState().edit('history.editCell', (p) => {
        findDevice(p, PLC)!.watchTables[0]!.rows[0]!.format = 'HEX';
      }),
    );
    expect(cell('r1', 'status')).toHaveTextContent('16#FFFB');
    act(() => app.store.getState().setSim({ watchValues: { r1: { error: 'DB9 non caricato' } } }));
    expect(cell('r1', 'status')).toHaveClass('is-error');
    expect(text(cell('r1', 'status'))).toHaveTextContent('DB9 non caricato');
  });

  it('«Osserva tutto» e «Comanda» chiamano il controllore; gli errori per riga compaiono nelle celle', async () => {
    const app = await open();
    simOn(app);
    const toggle = vi.spyOn(SimController.prototype, 'toggleWatch').mockImplementation(() => {});
    const command = vi.spyOn(SimController.prototype, 'commandWatch').mockResolvedValue({
      written: 1,
      errors: { r1: { key: 'RANGE', params: { min: '-32768', max: '32767' } } },
    });
    await app.user.click(screen.getByRole('button', { name: 'Osserva tutto' }));
    expect(toggle).toHaveBeenCalledWith(PLC, 'wt1');
    await app.user.click(screen.getByRole('button', { name: 'Comanda' }));
    expect(command).toHaveBeenCalledWith(PLC, 'wt1');
    await waitFor(() =>
      expect(screen.getByTestId('watch-bar')).toHaveTextContent(
        'Comando eseguito: 1 righe scritte, 1 con errore.',
      ),
    );
    expect(cell('r1', 'modify')).toHaveClass('is-error');
    expect(text(cell('r1', 'modify'))).toHaveTextContent(
      'Valore fuori dai limiti (-32768 … 32767).',
    );
    // modificare il comando toglie l'errore della riga
    await app.user.dblClick(cell('r1', 'modify'));
    await app.user.keyboard('{Control>}a{/Control}13{Enter}');
    expect(cell('r1', 'modify')).not.toHaveClass('is-error');
  });

  it('elimina righe con un solo passo di annulla', async () => {
    const app = await open();
    const before = past(app);
    await app.user.click(document.querySelector<HTMLElement>('[data-row-key="r2"] [data-rownum]')!);
    await app.user.keyboard('{Delete}');
    const rows: WatchRow[] = tables(app)[0]!.rows;
    expect(rows.map((r) => r.id)).toEqual(['r1']);
    expect(past(app)).toBe(before + 1);
  });
});
