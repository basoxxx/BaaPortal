import { describe, expect, it } from 'vitest';
import { completeAt } from '../src';
import { makeCtx } from './ctx';

const ctx = makeCtx();
/** `|` segna il cursore nell'ultima riga della rete indicata. */
function at(
  src: string,
  mnemonic: 'international' | 'german' = 'international',
  nets: string[] = [],
) {
  const offset = src.indexOf('|');
  const text = src.replace('|', '');
  const all = [...nets, text];
  const r = completeAt(all, all.length - 1, offset, ctx, mnemonic);
  return { ...r, text, labels: r.options.map((o) => o.label) };
}

describe('completeAt', () => {
  it('istruzioni a inizio riga e dopo un etichetta', () => {
    const a = at('A|');
    expect(a.from).toBe(0);
    expect(a.labels).toEqual(expect.arrayContaining(['A', 'AN', 'A(', 'AW', 'AD']));
    expect(a.labels).not.toContain('L');
    expect(a.options.every((o) => o.kind === 'instruction')).toBe(true);
    const b = at('M1: S|');
    expect(b.from).toBe(4);
    expect(b.labels).toEqual(
      expect.arrayContaining(['S', 'SP', 'SE', 'SD', 'SS', 'SF', 'SET', 'SLW']),
    );
    const c = at('M1: JC|');
    expect(c.from).toBe(4);
    expect(c.labels).toEqual(['JC', 'JCB', 'JCN']);
    expect(at('  |').labels.length).toBeGreaterThan(100);
    const g = at('SP|', 'german');
    expect(g.labels).toEqual(expect.arrayContaining(['SPA', 'SPB', 'SPBN']));
    expect(g.labels).not.toContain('JU');
  });

  it('dopo " e in posizione di operando: tag, costanti, DB, con virgolette', () => {
    const r = at('A "|');
    expect(r.from).toBe(2);
    expect(r.options.map((o) => [o.kind, o.label, o.apply])).toEqual([
      ['tag', 'Avvio', '"Avvio"'],
      ['tag', 'Ignoto', '"Ignoto"'],
      ['tag', 'Macchina', '"Macchina"'],
      ['tag', 'Reale', '"Reale"'],
      ['tag', 'Temporizzatore', '"Temporizzatore"'],
      ['tag', 'Velocità nastro', '"Velocità nastro"'],
      ['constant', 'MAXV', '"MAXV"'],
      ['block', 'Dati', '"Dati"'],
      ['block', 'Motore_DB', '"Motore_DB"'],
      ['block', 'Nastro_DB', '"Nastro_DB"'],
    ]);
    const p = at('L Vel|');
    expect(p.from).toBe(2);
    expect(p.options.map((o) => o.apply)).toEqual(['"Velocità nastro"']);
    const q = at('L "vel|');
    expect(q.from).toBe(2);
    expect(q.options.map((o) => o.apply)).toEqual(['"Velocità nastro"']);
    expect(at('A |').options.length).toBe(10);
    expect(at('A |').from).toBe(2);
  });

  it('operando di CALL, OPN e UC', () => {
    expect(at('CALL "|').options.map((o) => o.label)).toEqual([
      'Calcola',
      'ConRet',
      'Motore',
      'Nastro',
      'Prese',
      'READ_CLK',
    ]);
    expect(at('OPN "|').options.map((o) => o.label)).toEqual(['Dati', 'Motore_DB', 'Nastro_DB']);
    expect(at('UC "|').options.map((o) => o.label)).toEqual([
      'Calcola',
      'ConRet',
      'Motore',
      'Nastro',
      'Prese',
      'READ_CLK',
    ]);
    expect(at('CALL "Nastro", "|').options.map((o) => o.label)).toEqual(['Nastro_DB']);
  });

  it('dopo #: locali', () => {
    const r = at('L #|');
    expect(r.from).toBe(3);
    expect(r.options.every((o) => o.kind === 'local')).toBe(true);
    const names = [
      'a b',
      'Buffer',
      'Cplx',
      'Contatore',
      'Fatto',
      'Pos',
      'Start',
      'Sub',
      'Tmp',
      'Valore',
    ];
    expect(r.options.map((o) => o.label)).toEqual(names.sort((a, b) => a.localeCompare(b)));
    expect(r.options.find((o) => o.label === 'a b')!.apply).toBe('"a b"');
    expect(r.options.find((o) => o.label === 'Pos')!.apply).toBe('Pos');
    const p = at('L #Co|');
    expect(p.from).toBe(3);
    expect(p.options.map((o) => o.label)).toEqual(['Contatore']);
    const q = at('L #"a|');
    expect(q.from).toBe(3);
    expect(q.options.map((o) => o.apply)).toEqual(['"a b"']);
  });

  it('dopo "Dati".Asse. e #x.: i membri di quel livello', () => {
    const a = at('L "Dati".Asse.|');
    expect(a.from).toBe(14);
    expect(a.options.map((o) => [o.kind, o.label, o.detail])).toEqual([['member', 'Pos', 'Real']]);
    const b = at('L "Dati".|');
    expect(b.options.map((o) => o.label)).toEqual(
      ['Altro valore', 'Asse', 'Cnt', 'Vet'].sort((x, y) => x.localeCompare(y)),
    );
    expect(b.options.find((o) => o.label === 'Altro valore')!.apply).toBe('"Altro valore"');
    const c = at('L #Sub.|');
    expect(c.options.map((o) => o.label)).toEqual(['Buf', 'Cnt', 'Ok', 'Vel']);
    const d = at('L "Nastro_DB".|');
    expect(d.options.map((o) => o.label)).toEqual(['Buf', 'Cnt', 'Ok', 'Vel']);
    expect(at('L "Dati".As|').options.map((o) => o.label)).toEqual(['Asse']);
    expect(at('L "Dati".As|').from).toBe(9);
    expect(at('L #Buffer.|').options.map((o) => o.label)).toEqual(['a']);
    expect(at('L "Macchina".|').options.map((o) => o.label)).toEqual(['X']);
    expect(at('L "Avvio".|').options).toEqual([]);
    expect(at('L "Nulla".|').options).toEqual([]);
  });

  it('dopo un salto: le etichette di tutto il blocco', () => {
    const r = at('JU |', 'international', ['M1: NOP 0\nFINE: NOP 0']);
    expect(r.from).toBe(3);
    expect(r.options.map((o) => [o.kind, o.label])).toEqual([
      ['label', 'FINE'],
      ['label', 'M1'],
    ]);
    const p = at('JC M|', 'international', ['M1: NOP 0\nFINE: NOP 0']);
    expect(p.from).toBe(3);
    expect(p.options.map((o) => o.label)).toEqual(['M1']);
    expect(at('SPA |', 'german', ['X1: NOP 0']).options.map((o) => o.label)).toEqual(['X1']);
  });

  it('dentro i parametri di CALL: i nomi non ancora assegnati', () => {
    const a = at('CALL "Calcola" (|');
    expect(a.from).toBe(16);
    expect(a.options.map((o) => [o.kind, o.label])).toEqual([
      ['param', 'A'],
      ['param', 'R'],
    ]);
    const b = at('CALL "Calcola"\n(A := 1,\n  |');
    expect(b.options.map((o) => o.label)).toEqual(['R']);
    expect(b.from).toBe(b.text.length);
    const c = at('CALL "ConRet"\n(X := 1, RE|');
    expect(c.options.map((o) => o.label)).toEqual(['RET_VAL']);
    expect(c.from).toBe(c.text.length - 2);
    const d = at('CALL "Nastro", "Nastro_DB" (Vel := 1, |');
    expect(d.options.map((o) => o.label)).toEqual(['Buf', 'Ok']);
    // dopo := si completa un operando
    const e = at('CALL "Calcola" (A := #|');
    expect(e.options.every((o) => o.kind === 'local')).toBe(true);
    const f = at('CALL "Calcola" (A := 1, R := "Av|');
    expect(f.options.map((o) => o.apply)).toEqual(['"Avvio"']);
    expect(at('CALL "Calcola" (A := 1, R := 2) |').options).toEqual([]);
  });

  it('nessun suggerimento nei commenti o dopo l operando completo', () => {
    expect(at('A "Avvio" // Av|').options).toEqual([]);
    expect(at('A "Avvio" |').options).toEqual([]);
    expect(at('// qualcosa|').options).toEqual([]);
  });

  it('apertura con ritorno a capo e CRLF', () => {
    const r = at('A M0.0\r\nL "Av|');
    expect(r.from).toBe(r.text.length - 3);
    expect(r.options.map((o) => o.label)).toEqual(['Avvio']);
  });
});
