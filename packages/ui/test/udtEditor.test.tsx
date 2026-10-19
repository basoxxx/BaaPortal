import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GlobalDb } from '@baaportal/project';
import {
  addCells,
  cell,
  dev,
  expander,
  globalDb,
  mem,
  openEditor,
  past,
  rowKeys,
  udt,
} from './blockFixtures';
import type { RenderedApp } from './renderApp';

const get = (app: RenderedApp, id: string) => dev(app).udts.find((u) => u.id === id)!;

describe('editor dei tipi di dati utente', () => {
  it('tabella dei membri senza sezioni, con offset e <Aggiungi>', async () => {
    const a = mem('a', 'Bool');
    const b = mem('b', 'Real', { initial: '1.5' });
    const u = udt('Asse', [a, b]);
    const app = await openEditor('udt', u.id, (p) => void p.udts.push(u));
    expect(screen.getByRole('grid', { name: 'Membri del tipo di dati' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Valore predefinito' })).toBeInTheDocument();
    expect(rowKeys()).toEqual([a.id, b.id]);
    expect(cell(b.id, 'offset')).toHaveTextContent('2.0');
    expect(cell(b.id, 'value')).toHaveTextContent('1.5');
    const before = past(app);
    await app.user.click(addCells('type')[0]!);
    await app.user.keyboard('int{Enter}');
    expect(get(app, u.id).members[2]).toMatchObject({ name: 'Variabile_1', type: 'Int' });
    expect(past(app)).toBe(before + 1);
  });

  it('un membro struct si espande e accetta membri propri; Pointer non è ammesso', async () => {
    const s = mem('s', 'Struct', { members: [] });
    const u = udt('Asse', [s]);
    const app = await openEditor('udt', u.id, (p) => void p.udts.push(u));
    await app.user.click(expander(s.id));
    // Una <Aggiungi> dentro la struct e una per il primo livello.
    expect(addCells('name')).toHaveLength(2);
    await app.user.click(addCells('name')[0]!);
    await app.user.keyboard('p{Enter}');
    expect(get(app, u.id).members[0]!.members).toMatchObject([{ name: 'p', type: 'Bool' }]);
    await app.user.click(cell(get(app, u.id).members[0]!.members![0]!.id, 'type'));
    await app.user.keyboard('{Enter}pointer{Enter}');
    expect(get(app, u.id).members[0]!.members![0]!.type).toBe('Pointer');
    expect(cell(get(app, u.id).members[0]!.members![0]!.id, 'type')).toHaveClass('is-error');
  });

  it('rinominare un membro sposta i valori sostituiti dei membri di quel tipo', async () => {
    const pos = mem('pos', 'Real');
    const u = udt('Asse', [pos]);
    const ax = mem('ax', '"Asse"', { overrides: { '.pos': '1.5' } });
    const d = globalDb('Dati', [ax]);
    const app = await openEditor('udt', u.id, (p) => {
      p.udts.push(u);
      p.blocks.push(d);
    });
    const before = past(app);
    await app.user.click(cell(pos.id, 'name'));
    await app.user.keyboard('{Enter}posizione{Enter}');
    const data = () => dev(app).blocks.find((b) => b.id === d.id) as GlobalDb;
    expect(get(app, u.id).members[0]!.name).toBe('posizione');
    expect(data().members[0]!.overrides).toEqual({ '.posizione': '1.5' });
    expect(past(app)).toBe(before + 1);
    app.store.getState().undo();
    expect(data().members[0]!.overrides).toEqual({ '.pos': '1.5' });
  });
});
