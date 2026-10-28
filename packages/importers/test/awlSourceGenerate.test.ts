import { createCodeBlock, createGlobalDb, createInstanceDb, createUdt } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { applySource, generateAwlSource, parseAwlSource } from '../src/index';
import { allRefs, emptyDevice, fixture, seq } from './helpers';

const line = (s: string, text: string) => s.split('\n').indexOf(text);

describe('generateAwlSource', () => {
  it('generate mette gli UDT e gli FB richiamati prima dei chiamanti', () => {
    const d = emptyDevice();
    const newId = seq('g');
    // Ordine di memorizzazione volutamente capovolto.
    const main = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL', newId });
    main.networks[0]!.source = '\tCALL "Linea", "Linea_DB";';
    const linea = createCodeBlock({ kind: 'FB', number: 2, name: 'Linea', language: 'AWL', newId });
    linea.interface.static.push({ id: newId(), name: 'P', type: '"Nastro"', comment: '' });
    const nastro = createCodeBlock({
      kind: 'FB',
      number: 1,
      name: 'Nastro',
      language: 'AWL',
      newId,
    });
    nastro.networks[0]!.source = '\tCALL FC 5;';
    const fc = createCodeBlock({ kind: 'FC', number: 5, name: 'Calcola', language: 'AWL', newId });
    const dati = createGlobalDb({ number: 1, name: 'Dati', newId });
    dati.members.push({ id: newId(), name: 'A', type: '"Asse"', comment: '' });
    const idb = createInstanceDb({ number: 2, name: 'Linea_DB', instanceOf: 'Linea', newId });
    const asse = createUdt({ name: 'Asse', number: 1, newId });
    const assi = createUdt({ name: 'Assi', number: 2, newId });
    assi.members.push({ id: newId(), name: 'L', type: 'Array[1..2] of "Asse"', comment: '' });
    d.udts.push(assi, asse);
    d.blocks.push(idb, dati, main, linea, nastro, fc);
    const text = generateAwlSource(d, allRefs(d), 'international').text;
    const order = text
      .split('\n')
      .filter((l) => /^(TYPE|ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK) /.test(l));
    expect(order).toEqual([
      'TYPE "Asse"',
      'TYPE "Assi"',
      'FUNCTION "Calcola" : Void',
      'FUNCTION_BLOCK "Nastro"',
      'FUNCTION_BLOCK "Linea"',
      'ORGANIZATION_BLOCK OB 1',
      'DATA_BLOCK "Linea_DB"',
      'DATA_BLOCK "Dati"',
    ]);
  });

  it('cicli di chiamate: ordine stabile, nessun blocco perso', () => {
    const d = emptyDevice();
    const newId = seq('g');
    const a = createCodeBlock({ kind: 'FC', number: 1, name: 'A', language: 'AWL', newId });
    const b = createCodeBlock({ kind: 'FC', number: 2, name: 'B', language: 'AWL', newId });
    a.networks[0]!.source = '\tCALL "B";';
    b.networks[0]!.source = '\tCALL "A";';
    d.blocks.push(a, b);
    const text = generateAwlSource(d, allRefs(d), 'international').text;
    expect(line(text, 'FUNCTION "A" : Void')).toBeGreaterThan(-1);
    expect(line(text, 'FUNCTION "B" : Void')).toBeGreaterThan(-1);
  });

  it('solo gli oggetti richiesti, senza duplicati', () => {
    const d = emptyDevice();
    applySource(d, parseOk(fixture('tutto.awl')), seq('n'));
    const refs = allRefs(d).filter((r) => r.kind === 'udt');
    const text = generateAwlSource(d, [...refs, ...refs], 'international').text;
    expect(text.match(/^TYPE /gm)).toHaveLength(1);
    expect(text).not.toContain('FUNCTION');
  });

  it('VERSION sempre presente, valori e attributi solo se impostati', () => {
    const d = emptyDevice();
    const db = createGlobalDb({ number: 1, name: 'D', newId: seq('g') });
    db.members.push({ id: 'm', name: 'a', type: 'Int', comment: '' });
    d.blocks.push(db);
    const text = generateAwlSource(d, allRefs(d), 'international').text;
    expect(text).toBe(
      'DATA_BLOCK "D"\nTITLE =\nVERSION : 0.1\n\nSTRUCT\n  a : Int;\nEND_STRUCT;\n\nBEGIN\nEND_DATA_BLOCK\n',
    );
  });

  it('i blocchi SCL e FUP non si scrivono: avviso "lingua X"; un blocco KOP si scrive con l AWL generato', () => {
    const d = emptyDevice();
    const newId = seq('g');
    const scl = createCodeBlock({ kind: 'FB', number: 1, name: 'Calc', language: 'SCL', newId });
    scl.networks[0]!.source = '#nonesiste := 1;';
    const fup = createCodeBlock({ kind: 'FC', number: 2, name: 'Fu', language: 'FUP', newId });
    const awl = createCodeBlock({ kind: 'FC', number: 3, name: 'Aw', language: 'AWL', newId });
    const kop = createCodeBlock({ kind: 'FC', number: 4, name: 'Ko', language: 'KOP', newId });
    kop.networks[0]!.lad = {
      root: {
        id: 'r',
        series: [{ id: 'c', k: 'contact', neg: false, op: 'I 0.0' }],
        outs: [{ id: 'o', k: 'coil', op: 'Q 4.0' }],
      },
    };
    const bad = createCodeBlock({ kind: 'FC', number: 5, name: 'Rotto', language: 'KOP', newId });
    d.blocks.push(scl, fup, awl, kop, bad);
    const { text, warnings } = generateAwlSource(d, allRefs(d), 'international');
    expect(text).not.toContain('"Calc"');
    expect(text).not.toContain('"Fu"');
    expect(text).toContain('FUNCTION "Aw" : Void');
    expect(text).toContain('FUNCTION "Ko" : Void');
    expect(text).toContain('A %I0.0;');
    expect(text).toContain('= %Q4.0;');
    expect(warnings).toEqual([
      { kind: 'kop', ref: { kind: 'block', deviceId: d.id, id: scl.id }, name: 'Calc' },
      {
        kind: 'language',
        ref: { kind: 'block', deviceId: d.id, id: fup.id },
        name: 'Fu',
        language: 'FUP',
      },
      { kind: 'kop', ref: { kind: 'block', deviceId: d.id, id: bad.id }, name: 'Rotto' },
    ]);
    expect(text).not.toContain('"Rotto"');
    // Solo blocchi non AWL: nessuna unità, testo vuoto.
    expect(generateAwlSource(d, allRefs(d).slice(0, 2), 'international').text).toBe('');
  });

  it('mnemonico tedesco richiesto', () => {
    const d = emptyDevice();
    applySource(d, parseOk(fixture('tutto.awl')), seq('n'));
    const text = generateAwlSource(d, allRefs(d), 'german').text;
    expect(text).toContain('\tU #Avvio;');
    expect(text).not.toContain('\tA #Avvio;');
  });
});

function parseOk(text: string) {
  const r = parseAwlSource(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.source;
}
