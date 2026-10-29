import { describe, expect, it } from 'vitest';
import {
  checkDevice,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  addWatchTable,
  createUdt,
  renameMemberWithOverrides,
  renameWithReferences,
  type CodeBlock,
  type GlobalDb,
  type InstanceDb,
  type Member,
  type PlcDevice,
  type Udt,
} from '../src/index';
import { cpu315pn, seq } from './fixtures';

const newId = seq('r');
const m = (name: string, type: string, extra: Partial<Member> = {}): Member => ({
  id: newId(),
  name,
  type,
  comment: '',
  ...extra,
});

function fresh(): PlcDevice {
  return createPlcDevice({
    cpu: cpu315pn,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Standard' },
    newId,
  });
}
const fbOf = (d: PlcDevice, name: string, i: Partial<CodeBlock['interface']>): CodeBlock => {
  const b = createCodeBlock({
    kind: 'FB',
    number: d.blocks.length + 1,
    name,
    language: 'AWL',
    newId,
  });
  Object.assign(b.interface, i);
  d.blocks.push(b);
  return b;
};
const idbOf = (d: PlcDevice, name: string, of: string, overrides: Record<string, string>) => {
  const b: InstanceDb = createInstanceDb({
    number: d.blocks.length + 1,
    name,
    instanceOf: of,
    newId,
  });
  b.overrides = overrides;
  d.blocks.push(b);
  return b;
};
const udtOf = (d: PlcDevice, name: string, members: Member[]): Udt => {
  const u = createUdt({ name, number: d.udts.length + 1, newId });
  u.members = members;
  d.udts.push(u);
  return u;
};
const dbOf = (d: PlcDevice, name: string, members: Member[]): GlobalDb => {
  const b = createGlobalDb({ number: d.blocks.length + 1, name, newId });
  b.members = members;
  d.blocks.push(b);
  return b;
};
const valueErrors = (d: PlcDevice) =>
  checkDevice(d, cpu315pn).filter((x) => x.code === 'VALUE_INVALID');

describe('renameMemberWithOverrides', () => {
  it('membro di un FB: i valori dei DB di istanza seguono, anche nelle multi-istanze', () => {
    const d = fresh();
    const speed = m('Speed', 'Int');
    const quote = m('Quote', 'Array[1..3] of Int');
    const pos = m('Pos', 'Struct', { members: [m('X', 'Real')] });
    const motore = fbOf(d, 'Motore', { input: [speed, quote], static: [pos] });
    const m1 = m('M1', '"Motore"', { overrides: { '.Speed': '3', '.Pos.X': '1.0' } });
    fbOf(d, 'Linea', { static: [m1] });
    const l = m('L', '"Linea"', { overrides: { '.M1.Speed': '4' } });
    fbOf(d, 'Impianto', { static: [l] });
    const i1 = idbOf(d, 'Motore_DB', 'Motore', { Speed: '5', 'Quote[2]': '7', 'Pos.X': '2.0' });
    const i2 = idbOf(d, 'Linea_DB', 'Linea', { 'M1.Speed': '6', 'M1.Quote[1]': '1' });
    const i3 = idbOf(d, 'Impianto_DB', 'Impianto', { 'L.M1.Speed': '8' });
    expect(valueErrors(d)).toEqual([]);

    renameMemberWithOverrides(d, { kind: 'block', id: motore.id }, speed.id, 'Velocita');
    renameMemberWithOverrides(d, { kind: 'block', id: motore.id }, quote.id, 'Quota');
    renameMemberWithOverrides(d, { kind: 'block', id: motore.id }, pos.id, 'Posizione');

    expect(speed.name).toBe('Velocita');
    expect(i1.overrides).toEqual({ Velocita: '5', 'Quota[2]': '7', 'Posizione.X': '2.0' });
    expect(i2.overrides).toEqual({ 'M1.Velocita': '6', 'M1.Quota[1]': '1' });
    expect(i3.overrides).toEqual({ 'L.M1.Velocita': '8' });
    expect(m1.overrides).toEqual({ '.Velocita': '3', '.Posizione.X': '1.0' });
    expect(l.overrides).toEqual({ '.M1.Velocita': '4' });
    expect(valueErrors(d)).toEqual([]);
  });

  it('membro di un UDT: seguono i valori dei membri di quel tipo, diretti, in array e annidati', () => {
    const d = fresh();
    const pos = m('Pos', 'Struct', { members: [m('X', 'Real')] });
    const quote = m('Quote', 'Array[1..3] of Int');
    const asse = udtOf(d, 'Asse', [pos, quote]);
    udtOf(d, 'Macchina', [m('asse', '"Asse"')]);
    const a = m('A', '"Asse"', { overrides: { '.Pos.X': '1.0', '.Quote[2]': '2' } });
    const lista = m('Lista', 'Array[1..2] of "Asse"', { overrides: { '[1].Pos.X': '3.0' } });
    const mac = m('Mac', '"Macchina"', { overrides: { '.asse.Pos.X': '4.0' } });
    dbOf(d, 'Dati', [a, lista, mac]);
    fbOf(d, 'Nastro', { input: [m('cfg', '"Asse"')] });
    const idb = idbOf(d, 'Nastro_DB', 'Nastro', { 'cfg.Pos.X': '5.0', 'cfg.Quote[3]': '6' });

    renameMemberWithOverrides(d, { kind: 'udt', id: asse.id }, pos.id, 'Posizione');
    renameMemberWithOverrides(d, { kind: 'udt', id: asse.id }, quote.id, 'Quota');

    expect(a.overrides).toEqual({ '.Posizione.X': '1.0', '.Quota[2]': '2' });
    expect(lista.overrides).toEqual({ '[1].Posizione.X': '3.0' });
    expect(mac.overrides).toEqual({ '.asse.Posizione.X': '4.0' });
    expect(idb.overrides).toEqual({ 'cfg.Posizione.X': '5.0', 'cfg.Quota[3]': '6' });
  });

  it('un membro annidato in una struct e i percorsi che non passano dal membro', () => {
    const d = fresh();
    const x = m('X', 'Real');
    const fb = fbOf(d, 'Motore', {
      static: [m('Pos', 'Struct', { members: [x] }), m('X', 'Real')],
    });
    fbOf(d, 'Altro', { static: [m('Pos', 'Struct', { members: [m('X', 'Real')] })] });
    const own = idbOf(d, 'Motore_DB', 'Motore', { 'Pos.X': '1.0', X: '2.0', 'Nope.X': '3' });
    const other = idbOf(d, 'Altro_DB', 'Altro', { 'Pos.X': '4.0' });
    renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, x.id, 'Y');
    expect(own.overrides).toEqual({ 'Pos.Y': '1.0', X: '2.0', 'Nope.X': '3' });
    expect(other.overrides).toEqual({ 'Pos.X': '4.0' });
  });

  it('un valore già presente al nuovo percorso non viene sovrascritto', () => {
    const d = fresh();
    const a = m('A', 'Int');
    const fb = fbOf(d, 'Motore', { input: [a, m('B', 'Int')] });
    const idb = idbOf(d, 'Motore_DB', 'Motore', { A: '1', B: '2' });
    renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, a.id, 'B');
    expect(a.name).toBe('B');
    expect(idb.overrides).toEqual({ A: '1', B: '2' });
  });

  it('un nome che non si può scrivere in un percorso cambia solo il nome', () => {
    const d = fresh();
    const a = m('A', 'Int');
    const fb = fbOf(d, 'Motore', { input: [a] });
    const idb = idbOf(d, 'Motore_DB', 'Motore', { A: '1' });
    for (const bad of ['', 'A.B', 'A[1]']) {
      renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, a.id, bad);
      expect(a.name).toBe(bad);
      expect(idb.overrides).toEqual({ A: '1' });
    }
    // Tornando al nome di prima i valori ritrovano il membro.
    renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, a.id, 'A');
    renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, a.id, 'C');
    expect(idb.overrides).toEqual({ C: '1' });
  });

  it('renameWithReferences per un membro aggiorna anche i valori', () => {
    const d = fresh();
    const a = m('A', 'Int');
    const fb = fbOf(d, 'Motore', { input: [a] });
    const idb = idbOf(d, 'Motore_DB', 'Motore', { A: '1' });
    renameWithReferences(
      d,
      { kind: 'member', deviceId: d.id, ownerKind: 'block', ownerId: fb.id, memberId: a.id },
      'Z',
    );
    expect(idb.overrides).toEqual({ Z: '1' });
  });

  it('le righe delle tabelle di controllo seguono membri di DB, di UDT e di FB', () => {
    const d = fresh();
    const vel = m('Velocita', 'Int');
    const db = dbOf(d, 'Dati', [vel, m('Asse', '"Asse"')]);
    const x = m('Pos', 'Real');
    const asse = udtOf(d, 'Asse', [x]);
    const st = m('Giri', 'Int');
    const fb = fbOf(d, 'Motore', { static: [st] });
    idbOf(d, 'Motore_DB', 'Motore', {});
    const w = addWatchTable(d, 'W', newId);
    w.rows = [
      '"Dati".Velocita',
      '"Dati".Asse.Pos',
      '"Motore_DB".Giri',
      '"Dati".Velocita2',
      'MW 0',
    ].map((operand) => ({ id: newId(), operand, format: 'DEC' as const }));

    renameMemberWithOverrides(d, { kind: 'block', id: db.id }, vel.id, 'Rpm');
    renameMemberWithOverrides(d, { kind: 'udt', id: asse.id }, x.id, 'Quota');
    renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, st.id, 'Cicli');

    expect(w.rows.map((r) => r.operand)).toEqual([
      '"Dati".Rpm',
      '"Dati".Asse.Quota',
      '"Motore_DB".Cicli',
      '"Dati".Velocita2',
      'MW 0',
    ]);
    expect(d.blocks.map((b) => b.name)).toEqual(['Main', 'Dati', 'Motore', 'Motore_DB']);
  });
});
