import { act, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTagTable, findDevice, type Tag } from '@baaportal/project';
import { dropVerdict } from '../src/project/navigation/objectCommands';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const PLC = 'id1';
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const table = (app: RenderedApp, i = 0) => dev(app).tagTables[i]!;
const tag = (name: string, type: string, address: string, extra: Partial<Tag> = {}): Tag => ({
  id: `t-${name}`,
  name,
  type,
  address,
  hmi: true,
  comment: '',
  ...extra,
});

async function open(
  kind: 'tagTable' | 'allTags' = 'tagTable',
  tags: Tag[] = [],
  setup?: (d: ReturnType<typeof dev>) => void,
) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addRow', (p) => {
      const d = findDevice(p, PLC)!;
      d.tagTables[0]!.tags.push(...tags);
      setup?.(d);
    });
    app.store.getState().openEditor({
      kind,
      deviceId: PLC,
      objectId: kind === 'tagTable' ? table(app).id : PLC,
    });
  });
  return app;
}

const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-col-id="${col}"]`)!;
const addCell = (col: string) =>
  document.querySelector<HTMLElement>(`.is-add [data-col-id="${col}"]`)!;
const rowNum = (row: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-rownum]`)!;
const past = (app: RenderedApp) => app.store.getState().history.past.length;

describe('editor della tabella delle variabili', () => {
  it('scrivere nella riga <Aggiungi> crea un tag con valori proposti', async () => {
    const app = await open('tagTable', [tag('A', 'Int', '%MW4')]);
    expect(screen.getByRole('grid', { name: 'Variabili' })).toBeInTheDocument();
    const before = past(app);
    await app.user.click(addCell('name'));
    await app.user.keyboard('Start{Enter}');
    const added = table(app).tags[1]!;
    expect(added).toMatchObject({
      name: 'Start',
      type: 'Int',
      address: '%MW6',
      hmi: true,
      comment: '',
    });
    expect(past(app)).toBe(before + 1);
    // Iniziando da un'altra colonna il nome è proposto.
    await app.user.click(addCell('comment'));
    await app.user.keyboard('nota{Enter}');
    expect(table(app).tags[2]).toMatchObject({ name: 'Variabile_1', comment: 'nota' });
  });

  it('la riga <Aggiungi> parte da Bool %M0.0 se la tabella è vuota; il nome è unico nel PLC', async () => {
    const app = await open('tagTable', [], (d) => {
      d.blocks[0]!.name = 'Variabile_1';
    });
    await app.user.click(addCell('type'));
    await app.user.keyboard('word{Enter}');
    expect(table(app).tags[0]).toMatchObject({
      name: 'Variabile_2',
      type: 'Word',
      address: '%MW0',
    });
  });

  it('ogni cella confermata normalizza tipo e indirizzo, il nome resta com’è e viene segnato', async () => {
    const app = await open('tagTable', [tag('A', 'Int', '%MW4')]);
    await app.user.click(cell('t-A', 'type'));
    await app.user.keyboard('{Enter}dint{Enter}');
    await app.user.click(cell('t-A', 'address'));
    await app.user.keyboard('{Enter}md 8{Enter}');
    expect(table(app).tags[0]).toMatchObject({ type: 'DInt', address: '%MD8' });
    const before = past(app);
    await app.user.click(cell('t-A', 'name'));
    await app.user.keyboard('{Enter}a"b{Enter}');
    expect(table(app).tags[0]!.name).toBe('a"b');
    expect(past(app)).toBe(before + 1);
    expect(cell('t-A', 'name')).toHaveClass('is-error');
  });

  it('nome doppio e indirizzo sovrapposto sono evidenziati con il testo giusto', async () => {
    await open('tagTable', [
      tag('A', 'Int', '%MW0'),
      tag('a', 'Int', '%MW1'),
      tag('B', 'Bool', 'xyz'),
    ]);
    const text = (c: HTMLElement) => document.getElementById(c.getAttribute('aria-describedby')!);
    expect(cell('t-A', 'name')).toHaveClass('is-error');
    expect(text(cell('t-A', 'name'))).toHaveTextContent('Il nome è già in uso.');
    expect(cell('t-A', 'address')).toHaveClass('is-warning');
    expect(text(cell('t-A', 'address'))).toHaveTextContent("L'indirizzo si sovrappone a a");
    expect(cell('t-a', 'address')).toHaveClass('is-warning');
    expect(cell('t-B', 'address')).toHaveClass('is-error');
    expect(text(cell('t-B', 'address'))).toHaveTextContent("L'indirizzo non è valido.");
  });

  it('la ritenzione è di sola lettura e segue le proprietà della CPU', async () => {
    await open('tagTable', [tag('A', 'Int', '%MW14'), tag('B', 'Int', '%MW16')]);
    const check = (row: string) =>
      cell(row, 'retentive').querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(check('t-A')).toHaveAttribute('aria-checked', 'true');
    expect(check('t-B')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('columnheader', { name: 'Ritenzione' })).toHaveAttribute(
      'title',
      'Si imposta nelle proprietà della CPU',
    );
  });

  it('la casella HMI cambia il tag con un solo passo di annulla', async () => {
    const app = await open('tagTable', [tag('A', 'Int', '%MW0')]);
    const before = past(app);
    await app.user.click(cell('t-A', 'hmi').querySelector('[role="checkbox"]')!);
    expect(table(app).tags[0]!.hmi).toBe(false);
    expect(past(app)).toBe(before + 1);
  });

  it('elimina, copia come TSV e incolla le righe con id nuovi', async () => {
    const app = await open('tagTable', [
      tag('A', 'Int', '%MW0', { comment: 'x' }),
      tag('B', 'Bool', '%M9.0'),
    ]);
    await app.user.click(rowNum('t-A'));
    await app.user.keyboard('{Control>}c{/Control}');
    expect(app.bridge.clipboard).toBe('A\tInt\t%MW0\tTRUE\tTRUE\tx');
    await app.user.click(cell('t-B', 'name'));
    await app.user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(table(app).tags).toHaveLength(3));
    // Incolla dopo la riga attiva: ordine B, A_1.
    expect(table(app).tags.map((t) => t.name)).toEqual(['A', 'B', 'A_1']);
    expect(new Set(table(app).tags.map((t) => t.id)).size).toBe(3);
    await app.user.click(rowNum('t-A'));
    await app.user.keyboard('{Delete}');
    await waitFor(() => expect(table(app).tags.map((t) => t.name)).toEqual(['B', 'A_1']));
  });

  it('1000 righe incollate da testo in un solo passo di annulla', async () => {
    const app = await open('tagTable', [tag('A', 'Int', '%MW0')]);
    app.bridge.clipboard = Array.from(
      { length: 1000 },
      (_, i) => `V${i}\tInt\t%MW${i * 2 + 2}`,
    ).join('\r\n');
    await app.user.click(cell('t-A', 'name'));
    const before = past(app);
    await app.user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(table(app).tags).toHaveLength(1001));
    expect(past(app)).toBe(before + 1);
    app.store.getState().undo();
    expect(table(app).tags).toHaveLength(1);
  }, 30_000);

  it('1000 nomi incollati senza indirizzo: indirizzi distinti e modifiche successive rapide', async () => {
    const app = await open('tagTable', [tag('A', 'Bool', '%M0.0')]);
    app.bridge.clipboard = Array.from({ length: 1000 }, (_, i) => `N${i}`).join('\r\n');
    await app.user.click(cell('t-A', 'name'));
    await app.user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(table(app).tags).toHaveLength(1001));
    const addresses = table(app).tags.map((t) => t.address);
    expect(addresses.slice(0, 3)).toEqual(['%M0.0', '%M0.1', '%M0.2']);
    expect(new Set(addresses).size).toBe(1001);
    // Una modifica dopo l'incolla resta rapida (soglia larga: jsdom disegna 1000 righe).
    const c = cell('t-A', 'comment');
    act(() => c.focus());
    fireEvent.keyDown(c, { key: 'Enter' });
    const input = c.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'nota' } });
    const t0 = performance.now();
    fireEvent.keyDown(input, { key: 'Enter' });
    const ms = performance.now() - t0;
    expect(table(app).tags[0]!.comment).toBe('nota');
    // jsdom è molto più lento di Chromium e i runner Windows della CI sono i più lenti; il test blocca la esplosione quadratica della diagnostica di sovrapposizione, che impiegava decine di secondi.
    expect(ms).toBeLessThan(5000);
  }, 30_000);

  it('incollare testo vuoto non fa nulla', async () => {
    const app = await open('tagTable', [tag('A', 'Int', '%MW0')]);
    app.bridge.clipboard = '  \r\n';
    await app.user.click(cell('t-A', 'name'));
    const before = past(app);
    await app.user.keyboard('{Control>}v{/Control}');
    await new Promise((r) => setTimeout(r, 20));
    expect(past(app)).toBe(before);
    expect(table(app).tags).toHaveLength(1);
  });

  it('il riempimento automatico crea i tag con nomi e indirizzi incrementati', async () => {
    const app = await open('tagTable', [
      tag('Motore_1', 'Int', '%MW10'),
      tag('Motore_3', 'Int', '%MW40'),
    ]);
    await app.user.click(cell('t-Motore_1', 'name'));
    const before = past(app);
    fireEvent.pointerDown(document.querySelector('[data-fill-handle]')!);
    fireEvent.pointerEnter(document.querySelector('[data-row-key="t-Motore_3"]')!);
    fireEvent.pointerEnter(document.querySelector('.is-add')!);
    fireEvent.pointerUp(document.body);
    expect(table(app).tags.map((t) => [t.name, t.address])).toEqual([
      ['Motore_1', '%MW10'],
      ['Motore_2', '%MW12'],
      ['Motore_4', '%MW14'],
      ['Motore_3', '%MW40'],
    ]);
    expect(past(app)).toBe(before + 1);
  });

  it('le righe si trascinano verso un’altra tabella (moveTags)', async () => {
    const app = await open('tagTable', [tag('A', 'Int', '%MW0')], (d) => {
      d.tagTables.push(createTagTable('Altra', () => 'tab2'));
    });
    const data: Record<string, string> = {};
    const start = createEvent.dragStart(rowNum('t-A'));
    Object.defineProperty(start, 'dataTransfer', {
      value: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: '' },
    });
    fireEvent(rowNum('t-A'), start);
    const doc = app.store.getState().doc;
    expect(dropVerdict(doc, ids.tagTable(PLC, 'tab2'))).toBe('move');
    expect(data['text/plain']).toBe('A');
    fireEvent.dragEnd(rowNum('t-A'));
    expect(dropVerdict(doc, ids.tagTable(PLC, 'tab2'))).toBeNull();
  });

  it('le schede si usano da tastiera: frecce, Home e Fine', async () => {
    const app = await open();
    const tags = screen.getByRole('tab', { name: 'Variabili' });
    const consts = screen.getByRole('tab', { name: 'Costanti utente' });
    act(() => tags.focus());
    await app.user.keyboard('{ArrowRight}');
    expect(consts).toHaveFocus();
    expect(consts).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('grid', { name: 'Costanti utente' })).toBeInTheDocument();
    await app.user.keyboard('{ArrowRight}');
    expect(tags).toHaveFocus();
    await app.user.keyboard('{End}');
    expect(consts).toHaveAttribute('aria-selected', 'true');
    await app.user.keyboard('{Home}');
    expect(tags).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('grid', { name: 'Variabili' })).toBeInTheDocument();
    await app.user.keyboard('{ArrowLeft}');
    expect(consts).toHaveFocus();
  });

  it('scheda Costanti utente: aggiunta e valore non valido segnato', async () => {
    const app = await open();
    await app.user.click(screen.getByRole('tab', { name: 'Costanti utente' }));
    expect(screen.getByRole('tab', { name: 'Costanti utente' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await app.user.click(addCell('name'));
    await app.user.keyboard('Max{Enter}');
    const c = table(app).constants[0]!;
    expect(c).toMatchObject({ name: 'Max', type: 'Int', value: '0' });
    await app.user.click(cell(c.id, 'value'));
    await app.user.keyboard('{Enter}abc{Enter}');
    expect(table(app).constants[0]!.value).toBe('abc');
    expect(cell(c.id, 'value')).toHaveClass('is-error');
    expect(
      document.getElementById(cell(c.id, 'value').getAttribute('aria-describedby')!),
    ).toHaveTextContent('Il valore non è valido');
    // Nuova costante da un'altra colonna: nome proposto, tipo della precedente.
    await app.user.click(addCell('comment'));
    await app.user.keyboard('c{Enter}');
    expect(table(app).constants[1]).toMatchObject({
      name: 'Costante_1',
      type: 'Int',
      comment: 'c',
    });
  });
});

describe('Mostra tutte le variabili', () => {
  it('colonna tabella e modifica che arriva alla tabella giusta', async () => {
    const app = await open('allTags', [tag('A', 'Int', '%MW0')], (d) => {
      const t2 = createTagTable('Motori', () => 'tab2');
      t2.tags.push(tag('M1', 'Bool', '%M10.0'));
      d.tagTables.push(t2);
    });
    expect(screen.getByRole('grid', { name: 'Variabili PLC' })).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Tabella delle variabili' }),
    ).toBeInTheDocument();
    expect(cell('t-A', 'table')).toHaveTextContent(table(app, 0).name);
    expect(cell('t-M1', 'table')).toHaveTextContent('Motori');
    // La colonna della tabella è di sola lettura.
    await app.user.dblClick(cell('t-M1', 'table'));
    expect(screen.queryByRole('textbox')).toBeNull();
    await app.user.click(cell('t-M1', 'comment'));
    await app.user.keyboard('{Enter}ciao{Enter}');
    expect(table(app, 1).tags[0]!.comment).toBe('ciao');
    expect(table(app, 0).tags[0]!.comment).toBe('');
    // <Aggiungi> va alla tabella standard.
    await app.user.click(addCell('name'));
    await app.user.keyboard('Nuova{Enter}');
    expect(table(app, 0).tags.map((t) => t.name)).toEqual(['A', 'Nuova']);
    expect(table(app, 1).tags).toHaveLength(1);
    // Incolla nella tabella della riga attiva.
    app.bridge.clipboard = 'Z\tBool\t%M20.0';
    await app.user.click(cell('t-M1', 'name'));
    await app.user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(table(app, 1).tags.map((t) => t.name)).toEqual(['M1', 'Z']));
  });
});
