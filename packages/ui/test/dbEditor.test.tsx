import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GlobalDb, InstanceDb } from '@baaportal/project';
import {
  addCells,
  cell,
  dev,
  expander,
  fb,
  globalDb,
  instanceDb,
  mem,
  openEditor,
  past,
  rowKeys,
  udt,
} from './blockFixtures';
import type { RenderedApp } from './renderApp';

const db = <T extends GlobalDb | InstanceDb>(app: RenderedApp, id: string) =>
  dev(app).blocks.find((b) => b.id === id) as T;

describe('editor dei DB', () => {
  it('DB globale: una sezione Static con offset, valore iniziale e <Aggiungi>', async () => {
    const x = mem('x', 'Bool');
    const arr = mem('arr', 'Array[1..3] of Int');
    const d = globalDb('Dati', [x, arr]);
    const app = await openEditor('block', d.id, (p) => void p.blocks.push(d));
    expect(screen.getByRole('grid', { name: 'Dati del blocco dati' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Valore iniziale' })).toBeInTheDocument();
    expect(rowKeys()).toEqual(['section:members', x.id, arr.id]);
    expect(cell('section:members', 'name')).toHaveTextContent('Static');
    expect(cell(arr.id, 'offset')).toHaveTextContent('2.0');
    const before = past(app);
    await app.user.click(addCells('name')[0]!);
    await app.user.keyboard('Pos{Enter}');
    expect(db<GlobalDb>(app, d.id).members.map((m) => m.name)).toEqual(['x', 'arr', 'Pos']);
    expect(past(app)).toBe(before + 1);
    // Valore iniziale di un membro.
    await app.user.click(cell(x.id, 'value'));
    await app.user.keyboard('{Enter}true{Enter}');
    expect(db<GlobalDb>(app, d.id).members[0]!.initial).toBe('true');
  });

  it('DB di istanza: valori iniziali modificabili, nomi in sola lettura', async () => {
    const speed = mem('speed', 'Int');
    const st = mem('st', 'Struct', { members: [mem('x', 'Bool')] });
    const asse = udt('Asse', [mem('pos', 'Real')]);
    const ax = mem('ax', '"Asse"');
    const f = fb('Nastro', { input: [speed], static: [st, ax] });
    const i = instanceDb('Nastro_DB', 'Nastro');
    const app = await openEditor('block', i.id, (p) => {
      p.udts.push(asse);
      p.blocks.push(f, i);
    });
    expect(rowKeys()).toEqual([
      'section:input',
      speed.id,
      'section:output',
      'section:inOut',
      'section:static',
      st.id,
      ax.id,
    ]);
    // Niente <Aggiungi>: l'interfaccia è dell'FB.
    expect(addCells('name')).toHaveLength(0);
    expect(cell(speed.id, 'name')).toHaveAttribute('aria-readonly', 'true');
    expect(cell(speed.id, 'type')).toHaveAttribute('aria-readonly', 'true');
    expect(cell(speed.id, 'comment')).toHaveAttribute('aria-readonly', 'true');
    const before = past(app);
    await app.user.click(cell(speed.id, 'value'));
    await app.user.keyboard('{Enter}9{Enter}');
    expect(db<InstanceDb>(app, i.id).overrides).toEqual({ speed: '9' });
    expect(past(app)).toBe(before + 1);
    // Dentro una struct e in un UDT il percorso parte dalla radice del DB.
    await app.user.click(expander(st.id));
    await app.user.click(cell('m-x', 'value'));
    await app.user.keyboard('{Enter}true{Enter}');
    await app.user.click(expander(ax.id));
    await app.user.click(cell(`${ax.id}/pos`, 'value'));
    await app.user.keyboard('{Enter}1.5{Enter}');
    expect(db<InstanceDb>(app, i.id).overrides).toEqual({
      speed: '9',
      'st.x': 'true',
      'ax.pos': '1.5',
    });
    // Svuotare toglie il valore sostituito.
    await app.user.click(cell(speed.id, 'value'));
    await app.user.keyboard('{Enter}{Backspace}{Enter}');
    expect(db<InstanceDb>(app, i.id).overrides).not.toHaveProperty('speed');
    // Un valore errato è segnalato sopra la tabella, con il percorso.
    await app.user.click(cell(speed.id, 'value'));
    await app.user.keyboard('{Enter}abc{Enter}');
    expect(screen.getByRole('list', { name: 'Problemi' })).toHaveTextContent(
      'Il valore non è valido per il tipo di dati. (speed)',
    );
  });

  it('DB di istanza: un valore rimasto su un membro che non esiste più si rimuove dai problemi', async () => {
    const speed = mem('speed', 'Int');
    const f = fb('Nastro', { input: [speed] });
    const i = instanceDb('Nastro_DB', 'Nastro');
    i.overrides = { speed: 'abc', vecchio: '3' };
    const app = await openEditor('block', i.id, (p) => void p.blocks.push(f, i));
    const problems = screen.getByRole('list', { name: 'Problemi' });
    const items = within(problems).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Un valore errato su un membro che esiste si corregge nella tabella: niente pulsante.
    expect(within(items[0]!).queryByRole('button')).toBeNull();
    const remove = within(items[1]!).getByRole('button', { name: 'Rimuovi il valore di vecchio' });
    expect(remove).toHaveTextContent('Rimuovi');
    const before = past(app);
    await app.user.click(remove);
    expect(db<InstanceDb>(app, i.id).overrides).toEqual({ speed: 'abc' });
    expect(past(app)).toBe(before + 1);
    expect(
      within(screen.getByRole('list', { name: 'Problemi' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it("DB di istanza senza l'FB: riquadro d'errore e nessuna tabella", async () => {
    const i = instanceDb('Nastro_DB', 'Nastro');
    await openEditor('block', i.id, (p) => void p.blocks.push(i));
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Il DB di istanza si riferisce all'FB Nastro, che non esiste",
    );
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });
});
