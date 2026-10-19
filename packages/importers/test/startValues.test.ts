import { createCodeBlock, createUdt, type CodeBlock, type PlcDevice } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { applySource, generateAwlSource, parseAwlSource } from '../src/index';
import { allRefs, emptyDevice, seq } from './helpers';

// Valori iniziali dei membri composti (`Member.overrides`) di interfacce e UDT: la sorgente non ha una
// forma verificata per scriverli. Si tengono quando la sorgente sostituisce l'oggetto nello stesso
// progetto, e la generazione dice quali non ha scritto.

function device(): PlcDevice {
  const d = emptyDevice();
  const newId = seq('g');
  const asse = createUdt({ name: 'Asse', number: 1, newId });
  asse.members.push({ id: newId(), name: 'Pos', type: 'Real', comment: '' });
  const linea = createUdt({ name: 'Linea', number: 2, newId });
  linea.members.push({
    id: newId(),
    name: 'A',
    type: '"Asse"',
    comment: 'asse',
    overrides: { '.Pos': '2.5' },
  });
  const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Misura', language: 'AWL', newId });
  fb.networks[0]!.source = '\tA #Avvio;';
  fb.interface.input.push({ id: newId(), name: 'Avvio', type: 'Bool', comment: '' });
  fb.interface.static.push(
    { id: newId(), name: 'T1', type: '"TON"', comment: '', overrides: { '.PT': 'T#5S' } },
    { id: newId(), name: 'Dati', type: '"Asse"', comment: '', overrides: { '.Pos': '1.5' } },
    {
      id: newId(),
      name: 'arr',
      type: 'Array[1..3] of Int',
      comment: '',
      overrides: { '[1]': '7' },
    },
    {
      id: newId(),
      name: 'S',
      type: 'Struct',
      comment: '',
      members: [
        { id: newId(), name: 'In', type: '"Asse"', comment: '', overrides: { '.Pos': '3.0' } },
      ],
    },
  );
  d.udts.push(asse, linea);
  d.blocks.push(fb);
  return d;
}

const misura = (d: PlcDevice) => d.blocks.find((b) => b.name === 'Misura') as CodeBlock;

function reimport(d: PlcDevice, text: string): void {
  const p = parseAwlSource(text, d);
  if (!p.ok) throw new Error(JSON.stringify(p.errors));
  applySource(d, p.source, seq('n'));
}

describe('valori iniziali dei membri composti', () => {
  it('genera e reimporta nello stesso dispositivo: ogni valore resta', () => {
    const d = device();
    reimport(d, generateAwlSource(d, allRefs(d), 'international').text);
    const st = misura(d).interface.static;
    expect(st.map((m) => [m.name, m.overrides])).toEqual([
      ['T1', { '.PT': 'T#5S' }],
      ['Dati', { '.Pos': '1.5' }],
      ['arr', { '[1]': '7' }],
      ['S', undefined],
    ]);
    expect(st[3]!.members![0]!.overrides).toEqual({ '.Pos': '3.0' });
    expect(d.udts.find((u) => u.name === 'Linea')!.members[0]!.overrides).toEqual({
      '.Pos': '2.5',
    });
    // Identificatori nuovi per i membri, valori copiati (non condivisi con l'oggetto sostituito).
    expect(st[0]!.id.startsWith('n')).toBe(true);
  });

  it('la generazione elenca, per oggetto, i membri con valori non scritti', () => {
    const d = device();
    const { warnings } = generateAwlSource(d, allRefs(d), 'international');
    const linea = d.udts.find((u) => u.name === 'Linea')!;
    expect(warnings).toEqual([
      {
        kind: 'startValues',
        ref: { kind: 'udt', deviceId: d.id, id: linea.id },
        name: 'Linea',
        members: ['A'],
      },
      {
        kind: 'startValues',
        ref: { kind: 'block', deviceId: d.id, id: misura(d).id },
        name: 'Misura',
        members: ['T1', 'Dati', 'arr', 'S.In'],
      },
    ]);
  });

  it('senza valori composti nessun avviso', () => {
    const d = emptyDevice();
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'A', language: 'AWL', newId: seq() });
    fb.interface.static.push({ id: 'x', name: 'v', type: 'Int', comment: '', initial: '5' });
    d.blocks.push(fb);
    expect(generateAwlSource(d, allRefs(d), 'international').warnings).toEqual([]);
  });

  it('reimportata in un dispositivo nuovo non lancia (i valori non scritti mancano)', () => {
    const d = device();
    const { text } = generateAwlSource(d, allRefs(d), 'international');
    const fresh = emptyDevice();
    expect(() => reimport(fresh, text)).not.toThrow();
    expect(misura(fresh).interface.static[0]).toMatchObject({ name: 'T1', type: '"TON"' });
    expect(misura(fresh).interface.static[0]!.overrides).toBeUndefined();
  });

  it('un tipo cambiato nella sorgente non riceve i valori del tipo vecchio', () => {
    const d = device();
    const text = generateAwlSource(d, allRefs(d), 'international').text.replace(
      'T1 : "TON";',
      'T1 : "TOF";',
    );
    reimport(d, text);
    const st = misura(d).interface.static;
    expect(st[0]).toMatchObject({ name: 'T1', type: '"TOF"' });
    expect(st[0]!.overrides).toBeUndefined();
    expect(st[1]!.overrides).toEqual({ '.Pos': '1.5' });
  });

  it("un array con valori iniziali nella sorgente non riprende gli elementi dell'oggetto vecchio", () => {
    const d = device();
    const text = generateAwlSource(d, allRefs(d), 'international').text.replace(
      'arr : Array[1..3] of Int;',
      'arr : Array[1..3] of Int := 1, 2, 3;',
    );
    reimport(d, text);
    const arr = misura(d).interface.static[2]!;
    expect(arr.initial).toBe('1, 2, 3');
    expect(arr.overrides).toBeUndefined();
  });
});
