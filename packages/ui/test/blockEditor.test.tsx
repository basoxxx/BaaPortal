import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CodeBlock } from '@baaportal/project';
import { beginDrag, endDrag } from '../src/project/navigation/objectCommands';
import type { RenderedApp } from './renderApp';
import {
  addCells,
  cell,
  dev,
  expander,
  fb,
  fc,
  mem,
  udt,
  fakeDataTransfer,
  openEditor,
  past,
  rowKeys,
  rowNum,
  PLC,
} from './blockFixtures';

const block = (app: RenderedApp, id: string) =>
  dev(app).blocks.find((b) => b.id === id) as CodeBlock;

describe('editor di blocco: interfaccia', () => {
  it('scrivere Struct crea una struct espandibile con <Aggiungi> interno', async () => {
    const f = fb('Nastro');
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(screen.getByRole('grid', { name: 'Interfaccia del blocco' })).toBeInTheDocument();
    // Una riga <Aggiungi> per sezione: Input, Output, InOut, Static, Temp.
    expect(addCells('name')).toHaveLength(5);
    const before = past(app);
    await app.user.click(addCells('type')[3]!);
    await app.user.keyboard('struct{Enter}');
    const added = block(app, f.id).interface.static[0]!;
    expect(added).toMatchObject({ name: 'Variabile_1', type: 'Struct', members: [] });
    expect(past(app)).toBe(before + 1);
    expect(expander(added.id)).toHaveAttribute('aria-expanded', 'true');
    // Una <Aggiungi> in più, dentro la struct.
    expect(addCells('name')).toHaveLength(6);
    await app.user.click(addCells('name')[3]!);
    await app.user.keyboard('Velocita{Enter}');
    expect(block(app, f.id).interface.static[0]!.members).toMatchObject([
      { name: 'Velocita', type: 'Bool' },
    ]);
    expect(past(app)).toBe(before + 2);
    expect(rowKeys()).toContain(block(app, f.id).interface.static[0]!.members![0]!.id);
  });

  it('cambiare il tipo di una struct in un tipo semplice ne toglie i membri', async () => {
    const s = mem('s', 'Struct', { members: [mem('p', 'Bool')], overrides: { x: '1' } });
    const f = fb('Nastro', { static: [s] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    await app.user.click(cell(s.id, 'type'));
    await app.user.keyboard('{Enter}int{Enter}');
    expect(block(app, f.id).interface.static[0]).toEqual({
      id: s.id,
      name: 's',
      type: 'Int',
      comment: '',
    });
  });

  it("trascinare un FB dall'albero in Static crea Nastro_Instance; altrove è vietato", async () => {
    const nastro = fb('Nastro');
    const linea = fb('Linea');
    const app = await openEditor('block', linea.id, (d) => void d.blocks.push(nastro, linea));
    const dt = fakeDataTransfer();
    act(() =>
      beginDrag(dt, app.store.getState().doc, PLC, [
        { kind: 'block', deviceId: PLC, id: nastro.id },
      ]),
    );
    // Su Input: rifiutato (l'evento non viene annullato e l'effetto è 'none').
    expect(fireEvent.dragOver(cell('section:input', 'name'), { dataTransfer: dt })).toBe(true);
    expect(dt.dropEffect).toBe('none');
    const before = past(app);
    fireEvent.drop(cell('section:input', 'name'), { dataTransfer: dt });
    expect(past(app)).toBe(before);
    // Su Static: accettato.
    expect(fireEvent.dragOver(cell('section:static', 'name'), { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe('copy');
    fireEvent.drop(cell('section:static', 'name'), { dataTransfer: dt });
    expect(block(app, linea.id).interface.static).toMatchObject([
      { name: 'Nastro_Instance', type: '"Nastro"' },
    ]);
    expect(past(app)).toBe(before + 1);
    // Di nuovo: il nome resta unico.
    fireEvent.drop(cell('section:static', 'name'), { dataTransfer: dt });
    expect(block(app, linea.id).interface.static.map((m) => m.name)).toEqual([
      'Nastro_Instance',
      'Nastro_Instance_1',
    ]);
    act(() => endDrag());
    // Un FB non si trascina su se stesso.
    act(() =>
      beginDrag(dt, app.store.getState().doc, PLC, [
        { kind: 'block', deviceId: PLC, id: linea.id },
      ]),
    );
    expect(fireEvent.dragOver(cell('section:static', 'name'), { dataTransfer: dt })).toBe(true);
    act(() => endDrag());
  });

  it('trascinare un UDT in Input aggiunge un membro <nome>_1', async () => {
    const asse = udt('Asse', [mem('pos', 'Real')]);
    const f = fb('Nastro');
    const app = await openEditor('block', f.id, (d) => {
      d.blocks.push(f);
      d.udts.push(asse);
    });
    const dt = fakeDataTransfer();
    act(() =>
      beginDrag(dt, app.store.getState().doc, PLC, [{ kind: 'udt', deviceId: PLC, id: asse.id }]),
    );
    expect(fireEvent.dragOver(cell('section:input', 'name'), { dataTransfer: dt })).toBe(false);
    fireEvent.drop(cell('section:input', 'name'), { dataTransfer: dt });
    expect(block(app, f.id).interface.input).toMatchObject([{ name: 'Asse_1', type: '"Asse"' }]);
    act(() => endDrag());
  });

  it('Pointer in Input di un FB è segnato come non ammesso', async () => {
    const a = mem('a', 'Int');
    const f = fb('Nastro', { input: [a] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(cell(a.id, 'type')).not.toHaveClass('is-error');
    await app.user.click(cell(a.id, 'type'));
    await app.user.keyboard('{Enter}pointer{Enter}');
    expect(block(app, f.id).interface.input[0]!.type).toBe('Pointer');
    expect(cell(a.id, 'type')).toHaveClass('is-error');
    expect(
      document.getElementById(cell(a.id, 'type').getAttribute('aria-describedby')!),
    ).toHaveTextContent('Il tipo di dati non è ammesso qui.');
  });

  it('nome doppio e valore errato sono segnati nelle celle', async () => {
    const a = mem('a', 'Int', { initial: 'x' });
    const b = mem('A', 'Int');
    const f = fb('Nastro', { input: [a, b] });
    await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(cell(a.id, 'name')).toHaveClass('is-error');
    expect(cell(a.id, 'value')).toHaveClass('is-error');
    expect(cell(b.id, 'value')).not.toHaveClass('is-error');
  });

  it('valore predefinito: grigio se vuoto, un solo edit per scrittura, svuotare lo toglie', async () => {
    const a = mem('a', 'Int');
    const f = fb('Nastro', { input: [a], temp: [mem('t', 'Int')] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(cell(a.id, 'value')).toHaveClass('is-placeholder');
    expect(cell(a.id, 'value')).toHaveTextContent('0');
    // In Temp non c'è.
    expect(cell('m-t', 'value')).toHaveTextContent('');
    const before = past(app);
    await app.user.click(cell(a.id, 'value'));
    await app.user.keyboard('{Enter}5{Enter}');
    expect(block(app, f.id).interface.input[0]!.initial).toBe('5');
    expect(past(app)).toBe(before + 1);
    expect(cell(a.id, 'value')).not.toHaveClass('is-placeholder');
    await app.user.click(cell(a.id, 'value'));
    await app.user.keyboard('{Enter}{Backspace}{Enter}');
    expect(block(app, f.id).interface.input[0]).not.toHaveProperty('initial');
    expect(cell('m-t', 'value')).toHaveAttribute('aria-readonly', 'true');
  });

  it('array: gli elementi si aprono e il valore sostituito va in overrides[i]', async () => {
    const arr = mem('arr', 'Array[1..3] of Int');
    const f = fb('Nastro', { input: [arr] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(rowKeys()).not.toContain(`${arr.id}[1]`);
    await app.user.click(expander(arr.id));
    expect(rowKeys()).toContain(`${arr.id}[1]`);
    expect(cell(`${arr.id}[2]`, 'offset')).toHaveTextContent('2.0');
    await app.user.click(cell(`${arr.id}[2]`, 'value'));
    await app.user.keyboard('{Enter}5{Enter}');
    expect(block(app, f.id).interface.input[0]!.overrides).toEqual({ '[2]': '5' });
    expect(cell(`${arr.id}[2]`, 'value')).toHaveTextContent('5');
    // Nome e tipo degli elementi non si modificano.
    expect(cell(`${arr.id}[2]`, 'name')).toHaveAttribute('aria-readonly', 'true');
    await app.user.click(cell(`${arr.id}[2]`, 'value'));
    await app.user.keyboard('{Enter}{Backspace}{Enter}');
    expect(block(app, f.id).interface.input[0]).not.toHaveProperty('overrides');
  });

  it('UDT in un membro: i membri derived sono in sola lettura, il valore va in overrides[.membro]', async () => {
    const asse = udt('Asse', [mem('pos', 'Real'), mem('speed', 'Int')]);
    const ax = mem('ax', '"Asse"');
    const f = fb('Nastro', { static: [ax] });
    const app = await openEditor('block', f.id, (d) => {
      d.blocks.push(f);
      d.udts.push(asse);
    });
    await app.user.click(expander(ax.id));
    expect(cell(`${ax.id}/speed`, 'name')).toHaveAttribute('aria-readonly', 'true');
    expect(cell(`${ax.id}/speed`, 'comment')).toHaveAttribute('aria-readonly', 'true');
    await app.user.click(cell(`${ax.id}/speed`, 'value'));
    await app.user.keyboard('{Enter}7{Enter}');
    expect(block(app, f.id).interface.static[0]!.overrides).toEqual({ '.speed': '7' });
    expect(cell(`${ax.id}/speed`, 'offset')).toHaveTextContent('4.0');
  });

  it('OB1: informazioni di avvio grigie, senza modifica né eliminazione', async () => {
    const app = await openEditor(
      'block',
      (d) => d.blocks[0]!.id,
      () => {},
    );
    const ob = dev(app).blocks[0]!;
    const first = (ob as CodeBlock).interface.temp[0]!;
    expect(cell(first.id, 'name')).toHaveAttribute('aria-readonly', 'true');
    expect(cell(first.id, 'name').closest('[data-row-key]')).toHaveClass('is-muted');
    await app.user.click(rowNum(first.id));
    expect(cell(first.id, 'name').closest('[data-row-key]')).not.toHaveClass('is-selected');
    await app.user.click(cell(first.id, 'name'));
    await app.user.keyboard('{Delete}');
    expect(block(app, ob.id).interface.temp).toHaveLength(10);
  });

  it('FC: Return con Ret_Val, solo il tipo si modifica', async () => {
    const c = fc('Calcola');
    const app = await openEditor('block', c.id, (d) => void d.blocks.push(c));
    expect(cell('return', 'name')).toHaveTextContent('Ret_Val');
    expect(cell('return', 'name')).toHaveAttribute('aria-readonly', 'true');
    expect(cell('return', 'type')).toHaveTextContent('Void');
    await app.user.click(cell('return', 'type'));
    await app.user.keyboard('{Enter}real{Enter}');
    expect(block(app, c.id).interface.returnType).toBe('Real');
  });

  it('elimina, copia e incolla righe con nomi resi unici, ognuna in un passo', async () => {
    const a = mem('a', 'Int', { initial: '3', comment: 'c' });
    const f = fb('Nastro', { input: [a], output: [mem('o', 'Bool')] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    await app.user.click(rowNum(a.id));
    await app.user.keyboard('{Control>}c{/Control}');
    expect(app.bridge.clipboard).toBe('a\tInt\t3\tc');
    await app.user.click(cell('m-o', 'name'));
    const before = past(app);
    await app.user.keyboard('{Control>}v{/Control}');
    await screen.findByText('a_1');
    expect(block(app, f.id).interface.output.map((m) => [m.name, m.type, m.initial])).toEqual([
      ['o', 'Bool', undefined],
      ['a_1', 'Int', '3'],
    ]);
    expect(block(app, f.id).interface.output[1]!.id).not.toBe(a.id);
    expect(past(app)).toBe(before + 1);
    await app.user.click(rowNum(a.id));
    await app.user.keyboard('{Delete}');
    expect(block(app, f.id).interface.input).toEqual([]);
    expect(past(app)).toBe(before + 2);
  });

  it('incollare testo TSV crea membri normalizzati', async () => {
    const f = fb('Nastro', { static: [mem('x', 'Int')] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    app.bridge.clipboard = 'A\tdint\t5\tnota\r\nx\tbool';
    await app.user.click(cell('m-x', 'name'));
    await app.user.keyboard('{Control>}v{/Control}');
    await screen.findByText('nota');
    expect(
      block(app, f.id).interface.static.map((m) => [m.name, m.type, m.initial, m.comment]),
    ).toEqual([
      ['x', 'Int', undefined, ''],
      ['A', 'DInt', '5', 'nota'],
      ['x_1', 'Bool', undefined, ''],
    ]);
  });

  it('la sezione si comprime con la freccia e le sue righe spariscono', async () => {
    const a = mem('a', 'Int');
    const f = fb('Nastro', { input: [a] });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(rowKeys()).toContain(a.id);
    await app.user.click(expander('section:input'));
    expect(rowKeys()).not.toContain(a.id);
  });
});

describe('editor di blocco: intestazione e segmenti', () => {
  it('segmenti: inserisci, titolo, elimina, ognuno un passo di annulla', async () => {
    const f = fb('Nastro');
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    const before = past(app);
    expect(screen.getByText('Segmento 1')).toBeInTheDocument();
    await app.user.click(screen.getByRole('button', { name: 'Inserisci segmento' }));
    expect(block(app, f.id).networks).toHaveLength(2);
    expect(screen.getByText('Segmento 2')).toBeInTheDocument();
    expect(past(app)).toBe(before + 1);

    const title = screen.getByRole('textbox', { name: 'Titolo del segmento 2' });
    await app.user.type(title, 'Avvio{Enter}');
    expect(block(app, f.id).networks[1]!.title).toBe('Avvio');
    expect(past(app)).toBe(before + 2);
    await app.user.type(screen.getByRole('textbox', { name: 'Codice del segmento 2' }), 'A I 0.0');
    await app.user.tab();
    expect(block(app, f.id).networks[1]!.source).toBe('A I 0.0');
    expect(past(app)).toBe(before + 3);

    await app.user.click(screen.getByRole('button', { name: 'Menu del segmento 2' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Elimina segmento' }));
    expect(block(app, f.id).networks).toHaveLength(1);
    expect(past(app)).toBe(before + 4);

    // L'ultimo segmento non si elimina.
    await app.user.click(screen.getByRole('button', { name: 'Menu del segmento 1' }));
    expect(screen.getByRole('menuitem', { name: 'Elimina segmento' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await app.user.keyboard('{Escape}');

    for (let i = 4; i > 0; i--) act(() => app.store.getState().undo());
    expect(block(app, f.id).networks).toHaveLength(1);
    expect(block(app, f.id).networks[0]!.title).toBe('');
    expect(past(app)).toBe(before);
  });

  it('"Inserisci segmento" va dopo il segmento che ha il focus', async () => {
    const f = fb('Nastro');
    f.networks.push({ id: 'n2', title: 'due', comment: '', source: '' });
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    await app.user.click(screen.getByRole('textbox', { name: 'Codice del segmento 1' }));
    await app.user.click(screen.getByRole('button', { name: 'Inserisci segmento' }));
    expect(block(app, f.id).networks.map((n) => n.title)).toEqual(['', '', 'due']);
  });

  it('titolo e commento del blocco sono campi a conferma; il codice ha il suggerimento', async () => {
    const f = fb('Nastro');
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    const before = past(app);
    await app.user.type(
      screen.getByRole('textbox', { name: 'Titolo del blocco' }),
      'Nastro 1{Enter}',
    );
    await app.user.type(screen.getByRole('textbox', { name: 'Commento' }), 'nota');
    await app.user.tab();
    expect(block(app, f.id).header).toMatchObject({ title: 'Nastro 1', comment: 'nota' });
    expect(past(app)).toBe(before + 2);
    const src = screen.getByRole('textbox', { name: 'Codice del segmento 1' });
    expect(src.parentElement).toHaveClass('baa-network-source');
    expect(src.parentElement).toHaveAttribute('title', expect.stringContaining('editor AWL'));
    expect(within(document.body).getAllByText('Segmento 1')).toHaveLength(1);
  });
});
