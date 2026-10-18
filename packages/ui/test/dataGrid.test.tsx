import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataGrid, type DataGridProps, type GridColumn } from '../src/grid/DataGrid';
import { toTsv } from '../src/grid/tsv';
import { useShortcuts } from '../src/commands/useShortcuts';
import { AppProvider } from '../src/state/AppContext';
import { createAppStore } from '../src/state/store';
import { FakeBridge } from './fakeBridge';

interface Row {
  key: string;
  name: string;
  type: string;
  flag: boolean;
  locked?: boolean;
  section?: boolean;
}

const TYPES = ['Bool', 'DInt', 'DWord', 'Int'];
const columns: GridColumn<Row>[] = [
  { id: 'name', headerKey: 'tree.project', width: 160, editor: 'text', get: (r) => r.name },
  {
    id: 'type',
    headerKey: 'tree.project',
    width: 100,
    editor: 'type',
    get: (r) => r.type,
    suggestions: () => TYPES,
  },
  {
    id: 'flag',
    headerKey: 'tree.project',
    width: 60,
    editor: 'checkbox',
    get: (r) => r.flag,
    readOnly: (r) => !!r.locked,
  },
  { id: 'info', headerKey: 'tree.project', width: 60, editor: 'none', get: () => 'i' },
];
const makeRows = (n = 5): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `r${i + 1}`,
    name: `Var${i + 1}`,
    type: 'Int',
    flag: false,
  }));

function setup(over: Partial<DataGridProps<Row>> = {}, rows: Row[] = makeRows()) {
  const store = createAppStore();
  const bridge = new FakeBridge();
  const props = {
    label: 'Tabella di prova',
    rows,
    rowKey: (r: Row) => r.key,
    columns,
    onCommit: vi.fn(),
    ...over,
  } satisfies DataGridProps<Row>;
  function Harness() {
    useShortcuts();
    return <DataGrid<Row> {...props} />;
  }
  const user = userEvent.setup();
  const view = render(
    <AppProvider value={{ store, bridge, service: null as never }}>
      <Harness />
    </AppProvider>,
  );
  return { store, bridge, user, props, view };
}

const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-col-id="${col}"]`)!;
const rowNum = (row: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-rownum]`)!;

describe('DataGrid', () => {
  it('struttura accessibile: grid, righe, celle, intestazioni, numeri di riga, rientro', () => {
    setup({ depth: (r) => (r.key === 'r2' ? 2 : 0) }, makeRows(3));
    const grid = screen.getByRole('grid', { name: 'Tabella di prova' });
    expect(within(grid).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(4);
    expect(within(grid).getAllByRole('row')).toHaveLength(4);
    expect(rowNum('r3')).toHaveTextContent('3');
    expect(cell('r1', 'name')).toHaveAttribute('role', 'gridcell');
    expect(cell('r2', 'name').querySelector<HTMLElement>('[data-indent]')!.style.paddingLeft).toBe(
      '32px',
    );
    // Roving tabindex: una sola cella è raggiungibile con Tab.
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('frecce, F2, Invio conferma e scende', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'name'));
    await user.keyboard('{ArrowDown}');
    expect(cell('r2', 'name')).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowLeft}{F2}');
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Var2');
    await user.keyboard('Nuovo{Enter}');
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith('r2', 'name', 'Nuovo');
    expect(cell('r3', 'name')).toHaveFocus();
  });

  it('Home, Fine, Pag giù e Pag su', async () => {
    const { user } = setup({}, makeRows(30));
    await user.click(cell('r1', 'name'));
    await user.keyboard('{End}');
    expect(cell('r1', 'info')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(cell('r1', 'name')).toHaveFocus();
    await user.keyboard('{PageDown}');
    expect(cell('r11', 'name')).toHaveFocus();
    await user.keyboard('{PageUp}');
    expect(cell('r1', 'name')).toHaveFocus();
  });

  it('Esc annulla la modifica e il focus torna alla cella', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'name'));
    await user.keyboard('{Enter}');
    await user.keyboard('x{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(cell('r1', 'name')).toHaveFocus();
  });

  it('scrivere un carattere inizia la modifica sostituendo il testo', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'name'));
    await user.keyboard('M');
    expect(screen.getByRole('textbox')).toHaveValue('M');
    await user.keyboard('otore{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('r1', 'name', 'Motore');
  });

  it('AltGr (tastiera italiana) e Opzione su macOS scrivono un carattere: la modifica inizia', async () => {
    const { user, bridge } = setup();
    const typeAt = (init: KeyboardEventInit & { modifierAltGraph?: boolean }) => {
      fireEvent.keyDown(cell('r1', 'name'), init);
      const box = screen.queryByRole('textbox') as HTMLInputElement | null;
      const value = box?.value ?? null;
      if (box) fireEvent.keyDown(box, { key: 'Escape' });
      return value;
    };
    await user.click(cell('r1', 'name'));
    // Windows: AltGr arriva come Ctrl+Alt, con o senza lo stato AltGraph.
    expect(typeAt({ key: '@', ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe('@');
    expect(typeAt({ key: '#', ctrlKey: true, altKey: true })).toBe('#');
    // Le scorciatoie restano scorciatoie.
    expect(typeAt({ key: 'c', ctrlKey: true })).toBeNull();
    expect(typeAt({ key: 'x', altKey: true })).toBeNull();
    bridge.platform = 'darwin';
    expect(typeAt({ key: '[', altKey: true })).toBe('[');
    expect(typeAt({ key: 'z', metaKey: true })).toBeNull();
    expect(typeAt({ key: 'a', ctrlKey: true, altKey: true })).toBeNull();
  });

  it('due griglie (riquadri divisi) non si tolgono a vicenda la destinazione di Modifica', () => {
    const store = createAppStore();
    const bridge = new FakeBridge();
    const grid = (label: string) => (
      <DataGrid<Row>
        label={label}
        rows={makeRows(2)}
        rowKey={(r) => r.key}
        columns={columns}
        onCommit={() => undefined}
      />
    );
    render(
      <AppProvider value={{ store, bridge, service: null as never }}>
        {grid('Prima')}
        {grid('Seconda')}
      </AppProvider>,
    );
    const nameCell = (label: string) =>
      within(screen.getByRole('grid', { name: label })).getAllByRole('gridcell')[0]!;
    act(() => nameCell('Seconda').focus());
    const second = store.getState().editTarget;
    expect(second).not.toBeNull();
    // Il focus passa alla griglia che viene prima: la seconda non deve togliere la destinazione nuova.
    act(() => nameCell('Prima').focus());
    expect(store.getState().editTarget).not.toBeNull();
    expect(store.getState().editTarget?.id).not.toBe(second?.id);
  });

  it('nessuna chiamata se il valore non cambia', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'name'));
    await user.keyboard('{Enter}{Enter}');
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('Tab conferma e va a destra, Maiusc+Tab a sinistra', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'name'));
    await user.keyboard('A{Tab}');
    expect(props.onCommit).toHaveBeenCalledWith('r1', 'name', 'A');
    expect(cell('r1', 'type')).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(cell('r1', 'name')).toHaveFocus();
  });

  it('il clic altrove conferma la modifica', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'name'));
    await user.keyboard('Z');
    await user.click(cell('r3', 'name'));
    expect(props.onCommit).toHaveBeenCalledWith('r1', 'name', 'Z');
    expect(cell('r3', 'name')).toHaveFocus();
  });

  it('le celle di sola lettura e senza editor non si modificano', async () => {
    const rows = makeRows(2);
    rows[0]!.locked = true;
    const { user, props } = setup({}, rows);
    await user.click(cell('r1', 'flag'));
    await user.keyboard(' ');
    await user.click(cell('r1', 'info'));
    await user.keyboard('{Enter}x');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('Spazio commuta la casella', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'flag'));
    await user.keyboard(' ');
    expect(props.onCommit).toHaveBeenCalledWith('r1', 'flag', true);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('il clic sulla casella la commuta', async () => {
    const { user, props } = setup();
    await user.click(within(cell('r2', 'flag')).getByRole('checkbox'));
    expect(props.onCommit).toHaveBeenCalledWith('r2', 'flag', true);
  });

  it('riga <Aggiungi>: scrivere un nome chiama onAdd e resta pronta per la successiva', async () => {
    const onAdd = vi.fn();
    const { user, props } = setup(
      { addRow: [{ afterKey: null, labelKey: 'grid.addRow', onAdd }] },
      makeRows(2),
    );
    expect(screen.getByText('<Aggiungi>')).toBeInTheDocument();
    const addRowEl = screen.getByText('<Aggiungi>').closest('[role="row"]')!;
    expect(addRowEl).toBe(screen.getAllByRole('row').at(-1));
    await user.click(screen.getByText('<Aggiungi>'));
    await user.keyboard('Motore{Enter}');
    expect(onAdd).toHaveBeenCalledWith('name', 'Motore');
    expect(props.onCommit).not.toHaveBeenCalled();
    const active = document.activeElement as HTMLElement;
    expect(active).toHaveAttribute('data-col-id', 'name');
    expect(active.closest('[role="row"]')).toBe(addRowEl);
  });

  it('riga <Aggiungi> con testo vuoto non aggiunge nulla', async () => {
    const onAdd = vi.fn();
    const { user } = setup({ addRow: [{ afterKey: 'r1', labelKey: 'grid.addRow', onAdd }] });
    await user.click(screen.getByText('<Aggiungi>'));
    await user.keyboard('{Enter}{Enter}');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('selezione righe con Maiusc+clic, Canc elimina', async () => {
    const onDeleteRows = vi.fn();
    const { user, store } = setup({ onDeleteRows });
    await user.click(rowNum('r1'));
    await user.keyboard('{Shift>}');
    await user.click(rowNum('r3'));
    await user.keyboard('{/Shift}');
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(3);
    expect(store.getState().editTarget?.can.delete).toBe(true);
    await user.keyboard('{Delete}');
    expect(onDeleteRows).toHaveBeenCalledTimes(1);
    expect(onDeleteRows).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
  });

  it('Ctrl+clic aggiunge una riga alla selezione e la toglie se già presente', async () => {
    const { user } = setup({ onDeleteRows: vi.fn() });
    await user.click(rowNum('r1'));
    await user.keyboard('{Control>}');
    await user.click(rowNum('r4'));
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(2);
    await user.click(rowNum('r1'));
    await user.keyboard('{/Control}');
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(1);
    // Un clic semplice su una cella azzera la selezione.
    await user.click(cell('r2', 'name'));
    expect(screen.queryAllByRole('row', { selected: true })).toHaveLength(0);
  });

  it('senza selezione Canc elimina la riga della cella attiva', async () => {
    const onDeleteRows = vi.fn();
    const { user } = setup({ onDeleteRows });
    await user.click(cell('r2', 'name'));
    await user.keyboard('{Delete}');
    expect(onDeleteRows).toHaveBeenCalledWith(['r2']);
  });

  it('Mod+A seleziona solo le righe selezionabili', async () => {
    const { user } = setup({
      onDeleteRows: vi.fn(),
      rowSelectable: (r) => r.key !== 'r1',
    });
    await user.click(cell('r2', 'name'));
    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(4);
    await user.click(rowNum('r1'));
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(4);
  });

  it('Mod+C copia le righe come TSV negli appunti del bridge; Mod+V chiama onPaste', async () => {
    const rows = makeRows(3);
    const copyRows = vi.fn((keys: string[]) => {
      const sel = rows.filter((r) => keys.includes(r.key));
      return {
        text: toTsv(sel.map((r) => [r.name, r.type])),
        payload: { kind: 'rows' as const, rowKind: 'tag' as const, rows: sel },
      };
    });
    const onPaste = vi.fn();
    const onDeleteRows = vi.fn();
    const { user, bridge } = setup({ copyRows, onPaste, onDeleteRows }, rows);
    await user.click(rowNum('r1'));
    await user.keyboard('{Shift>}');
    await user.click(rowNum('r2'));
    await user.keyboard('{/Shift}{Control>}c{/Control}');
    expect(copyRows).toHaveBeenCalledWith(['r1', 'r2']);
    expect(bridge.clipboard).toBe('Var1\tInt\r\nVar2\tInt');
    // Taglia: copia e poi elimina.
    await user.keyboard('{Control>}x{/Control}');
    await waitFor(() => expect(onDeleteRows).toHaveBeenCalledWith(['r1', 'r2']));
    // Incolla sulla riga attiva, con il payload se gli appunti sono ancora i nostri.
    await user.click(cell('r3', 'name'));
    await user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(onPaste).toHaveBeenCalledTimes(1));
    expect(onPaste.mock.calls[0]![0]).toBe('Var1\tInt\r\nVar2\tInt');
    expect(onPaste.mock.calls[0]![1]).toMatchObject({ kind: 'rows', rowKind: 'tag' });
    expect(onPaste.mock.calls[0]![2]).toBe('r3');
    // Testo esterno: payload nullo.
    bridge.clipboard = 'a\tb';
    await user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(onPaste).toHaveBeenCalledTimes(2));
    expect(onPaste.mock.calls[1]).toEqual(['a\tb', null, 'r3']);
  });

  it('durante la modifica Mod+C resta al campo di testo e la destinazione si toglie', async () => {
    const copyRows = vi.fn(() => ({
      text: 'x',
      payload: { kind: 'rows' as const, rowKind: 'tag' as const, rows: [] },
    }));
    const { user, store } = setup({ copyRows });
    await user.click(cell('r1', 'name'));
    expect(store.getState().editTarget?.can.copy).toBe(true);
    await user.keyboard('{Enter}');
    expect(store.getState().editTarget).toBeNull();
    await user.keyboard('{Control>}c{/Control}');
    expect(copyRows).not.toHaveBeenCalled();
  });

  it('la destinazione dei comandi sparisce quando il focus esce dalla griglia', async () => {
    const { user, store } = setup({ onDeleteRows: vi.fn() });
    await user.click(cell('r1', 'name'));
    expect(store.getState().editTarget).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
    await waitFor(() => expect(store.getState().editTarget).toBeNull());
  });

  it('riempimento automatico su 3 righe chiama onFill(r1, 3)', async () => {
    const onFill = vi.fn();
    const { user } = setup({ onFill });
    await user.click(cell('r1', 'name'));
    const handle = document.querySelector<HTMLElement>('[data-fill-handle]')!;
    expect(cell('r1', 'name')).toContainElement(handle);
    fireEvent.pointerDown(handle);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r2"]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r3"]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r4"]')!);
    expect(document.querySelectorAll('.is-fill-target')).toHaveLength(3);
    fireEvent.pointerUp(document.body);
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(onFill).toHaveBeenCalledWith('r1', 3);
    expect(document.querySelectorAll('.is-fill-target')).toHaveLength(0);
  });

  it('il trascinamento del riempimento si annulla con Esc', async () => {
    const onFill = vi.fn();
    const { user } = setup({ onFill });
    await user.click(cell('r1', 'name'));
    fireEvent.pointerDown(document.querySelector('[data-fill-handle]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r2"]')!);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerUp(document.body);
    expect(onFill).not.toHaveBeenCalled();
  });

  it('senza onFill non c’è il quadratino', async () => {
    const { user } = setup();
    await user.click(cell('r1', 'name'));
    expect(document.querySelector('[data-fill-handle]')).toBeNull();
  });

  it('la diagnostica è leggibile (title e aria-describedby)', () => {
    setup({
      diagnostic: (k, c) =>
        k === 'r1' && c === 'name'
          ? { severity: 'error', text: 'Nome duplicato' }
          : k === 'r2' && c === 'name'
            ? { severity: 'warning', text: 'Nome lungo' }
            : undefined,
    });
    const c = cell('r1', 'name');
    expect(c).toHaveClass('is-error');
    expect(c).toHaveAttribute('title', 'Nome duplicato');
    const id = c.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)).toHaveTextContent('Nome duplicato');
    expect(cell('r2', 'name')).toHaveClass('is-warning');
    expect(cell('r3', 'name')).not.toHaveAttribute('aria-describedby');
  });

  it('suggerimenti di tipo filtrati mentre si scrive', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'type'));
    await user.keyboard('Di');
    let options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['DInt']);
    await user.keyboard('{Backspace}');
    options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['DInt', 'DWord']);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('r1', 'type', 'DInt');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Esc chiude prima l’elenco, il secondo Esc annulla; il testo libero è ammesso', async () => {
    const { user, props } = setup();
    await user.click(cell('r1', 'type'));
    await user.keyboard('Di');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(props.onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}UDT_Motore{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('r1', 'type', 'UDT_Motore');
  });

  it('righe espandibili: freccia con aria-expanded e tastiera', async () => {
    const onToggleExpand = vi.fn();
    const rows = makeRows(2);
    const expanded = new Set<string>(['r2']);
    const { user } = setup({ expandable: () => true, expanded, onToggleExpand }, rows);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true');
    await user.click(buttons[0]!);
    expect(onToggleExpand).toHaveBeenLastCalledWith('r1');
    await user.click(cell('r1', 'name'));
    await user.keyboard('{ArrowRight}');
    expect(onToggleExpand).toHaveBeenLastCalledWith('r1');
    // Su una riga già espansa ArrowRight si sposta a destra; ArrowLeft la comprime.
    await user.click(cell('r2', 'name'));
    await user.keyboard('{ArrowRight}');
    expect(cell('r2', 'type')).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(onToggleExpand).toHaveBeenLastCalledWith('r2');
  });

  it('il doppio clic su una cella modificabile avvia la modifica; su una di sola lettura no', async () => {
    const { user } = setup({}, [{ key: 'r1', name: 'A', type: 'Int', flag: false }]);
    await user.dblClick(cell('r1', 'name'));
    expect(screen.getByRole('textbox')).toHaveValue('A');
    await user.keyboard('{Escape}');
    await user.dblClick(cell('r1', 'info'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('il campo del tipo è un combobox collegato all’elenco, che ha un nome', async () => {
    const { user } = setup();
    await user.click(cell('r1', 'type'));
    await user.keyboard('D');
    const input = screen.getByRole('combobox');
    const list = screen.getByRole('listbox', { name: 'Suggerimenti' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', list.id);
  });

  it('il riempimento conta la riga <Aggiungi> una sola volta e nulla oltre', async () => {
    const onFill = vi.fn();
    const { user } = setup({
      onFill,
      addRow: [{ afterKey: 'r2', labelKey: 'grid.addRow', onAdd: vi.fn() }],
    });
    await user.click(cell('r1', 'name'));
    fireEvent.pointerDown(document.querySelector('[data-fill-handle]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r2"]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r3"]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="r4"]')!);
    fireEvent.pointerUp(document.body);
    // r2 + <Aggiungi>; r3 e r4 stanno oltre la riga di aggiunta.
    expect(onFill).toHaveBeenCalledWith('r1', 2);
  });

  it('2000 righe in meno di 3 s', () => {
    const six: GridColumn<Row>[] = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      headerKey: 'tree.project',
      width: 80,
      editor: 'text' as const,
      get: (r: Row) => r.name,
    }));
    const t0 = performance.now();
    setup({ columns: six }, makeRows(2000));
    const ms = performance.now() - t0;
    expect(document.querySelectorAll('[role="row"]')).toHaveLength(2001);
    // Target sulla macchina di sviluppo sotto 1 s; soglia 3× perché i runner della CI sono più lenti e il test blocca solo regressioni patologiche.
    expect(ms).toBeLessThan(3000);
  });
});
