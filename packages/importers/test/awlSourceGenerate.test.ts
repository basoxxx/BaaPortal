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
    const text = generateAwlSource(d, allRefs(d), 'international');
    const order = text
      .split('\n')
      .filter((l) => /^(TYPE|ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK) /.test(l));
    expect(order).toEqual([
      'TYPE "Asse"',
      'TYPE "Assi"',
      'FUNCTION "Calcola" : Void',
      'FUNCTION_BLOCK "Nastro"',
      'FUNCTION_BLOCK "Linea"',
      'ORGANIZATION_BLOCK "Main"',
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
    const text = generateAwlSource(d, allRefs(d), 'international');
    expect(line(text, 'FUNCTION "A" : Void')).toBeGreaterThan(-1);
    expect(line(text, 'FUNCTION "B" : Void')).toBeGreaterThan(-1);
  });

  it('solo gli oggetti richiesti, senza duplicati', () => {
    const d = emptyDevice();
    applySource(d, parseOk(fixture('tutto.awl')), seq('n'));
    const refs = allRefs(d).filter((r) => r.kind === 'udt');
    const text = generateAwlSource(d, [...refs, ...refs], 'international');
    expect(text.match(/^TYPE /gm)).toHaveLength(1);
    expect(text).not.toContain('FUNCTION');
  });

  it('VERSION sempre presente, valori e attributi solo se impostati', () => {
    const d = emptyDevice();
    const db = createGlobalDb({ number: 1, name: 'D', newId: seq('g') });
    db.members.push({ id: 'm', name: 'a', type: 'Int', comment: '' });
    d.blocks.push(db);
    const text = generateAwlSource(d, allRefs(d), 'international');
    expect(text).toBe(
      'DATA_BLOCK "D"\nTITLE =\nVERSION : 0.1\n\nSTRUCT\n  a : Int;\nEND_STRUCT;\n\nBEGIN\nEND_DATA_BLOCK\n',
    );
  });

  it('mnemonico tedesco richiesto', () => {
    const d = emptyDevice();
    applySource(d, parseOk(fixture('tutto.awl')), seq('n'));
    const text = generateAwlSource(d, allRefs(d), 'german');
    expect(text).toContain('\tU #Avvio;');
    expect(text).not.toContain('\tA #Avvio;');
  });
});

function parseOk(text: string) {
  const r = parseAwlSource(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.source;
}
