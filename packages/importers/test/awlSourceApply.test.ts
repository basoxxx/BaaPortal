import { findOb } from '@baaportal/catalog';
import { createCodeBlock, createGlobalDb, createUdt, type CodeBlock } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { applySource, parseAwlSource } from '../src/index';
import { emptyDevice, fixture, seq } from './helpers';

function parse(text: string) {
  const r = parseAwlSource(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.source;
}

describe('applySource', () => {
  it('crea oggetti nuovi con numeri liberi, lingua AWL e identificatori nuovi', () => {
    const d = emptyDevice();
    const r = applySource(d, parse(fixture('tutto.awl')), seq('n'));
    expect(r.replaced).toEqual([]);
    expect(r.created).toHaveLength(8);
    expect(d.udts.map((u) => [u.name, u.number])).toEqual([['Asse', 1]]);
    expect(d.blocks.map((b) => [b.kind, b.name, b.number])).toEqual([
      ['OB', 'Main', 1],
      ['FC', 'Somma', 1],
      ['FB', 'Nastro', 1],
      ['FB', 'Linea', 2],
      ['DB', 'Dati', 1],
      ['IDB', 'Nastro_DB', 2],
      ['IDB', 'Linea_DB', 3],
    ]);
    const fb = d.blocks[1] as CodeBlock;
    expect(fb.language).toBe('AWL');
    const ids = [fb.id, ...fb.networks.map((n) => n.id), ...fb.interface.input.map((m) => m.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i.startsWith('n'))).toBe(true);
  });

  it('un nome già presente sostituisce l oggetto, tenendo id, gruppo e numero', () => {
    const d = emptyDevice();
    const old = createCodeBlock({
      kind: 'FB',
      number: 7,
      name: 'nastro',
      language: 'SCL',
      newId: seq('o'),
    });
    old.group = 'A/B';
    d.blocks.push(old);
    const r = applySource(d, parse(fixture('tutto.awl')), seq('n'));
    expect(r.replaced).toEqual([{ kind: 'block', deviceId: d.id, id: old.id }]);
    const now = d.blocks.find((b) => b.id === old.id) as CodeBlock;
    expect(now).toMatchObject({ number: 7, group: 'A/B', name: 'Nastro', language: 'AWL' });
    expect(d.blocks.filter((b) => b.kind === 'FB')).toHaveLength(2);
    expect(r.created).toHaveLength(7);
  });

  it('un FB 1 senza nome sostituisce FB1 esistente e ne tiene il nome', () => {
    const d = emptyDevice();
    const old = createCodeBlock({
      kind: 'FB',
      number: 1,
      name: 'Vecchio',
      language: 'AWL',
      newId: seq('o'),
    });
    d.blocks.push(old);
    const r = applySource(d, parse(fixture('tedesco.awl')), seq('n'));
    expect(r.replaced).toHaveLength(1);
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({ id: old.id, name: 'Vecchio', number: 1 });
  });

  it('un numero senza oggetto esistente prende il nome predefinito', () => {
    const d = emptyDevice();
    applySource(
      d,
      parse(
        'FUNCTION_BLOCK FB 12\nBEGIN\nEND_FUNCTION_BLOCK\nORGANIZATION_BLOCK OB 35\nBEGIN\nEND_ORGANIZATION_BLOCK\nTYPE UDT 4\nSTRUCT\nEND_STRUCT;\nEND_TYPE\n',
      ),
      seq('n'),
    );
    expect(d.blocks.map((b) => [b.kind, b.name, b.number])).toEqual([
      ['FB', 'FB12', 12],
      ['OB', findOb(35)!.defaultName, 35],
    ]);
    expect(d.udts.map((u) => [u.name, u.number])).toEqual([['UDT4', 4]]);
  });

  it('un nome nuovo non prende un numero già occupato da un numero esplicito della stessa sorgente', () => {
    const d = emptyDevice();
    applySource(
      d,
      parse(
        'FUNCTION_BLOCK "A"\nBEGIN\nEND_FUNCTION_BLOCK\nFUNCTION_BLOCK FB 1\nBEGIN\nEND_FUNCTION_BLOCK\n',
      ),
      seq('n'),
    );
    expect(d.blocks.map((b) => [b.name, b.number]).sort()).toEqual([
      ['A', 2],
      ['FB1', 1],
    ]);
  });

  it('riferimenti FB n e UDT n sono risolti sui nomi', () => {
    const d = emptyDevice();
    d.blocks.push(
      createCodeBlock({ kind: 'FB', number: 3, name: 'Pompa', language: 'AWL', newId: seq('o') }),
    );
    d.udts.push(createUdt({ name: 'Quota', number: 2, newId: seq('u') }));
    applySource(
      d,
      parse(
        'DATA_BLOCK DB 7\nFB 3\nBEGIN\nEND_DATA_BLOCK\n\nFUNCTION_BLOCK FB 9\nVAR\n  x : UDT 2;\n  y : Array[1..2] of FB 3;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
      ),
      seq('n'),
    );
    const fb = d.blocks.find((b) => b.number === 9) as CodeBlock;
    expect(fb.interface.static.map((m) => m.type)).toEqual(['"Quota"', 'Array[1..2] of "Pompa"']);
    expect(d.blocks.find((b) => b.kind === 'IDB')).toMatchObject({
      instanceOf: 'Pompa',
      number: 7,
    });
  });

  it('i membri di avvio dell OB sono marcati in sola lettura', () => {
    const d = emptyDevice();
    applySource(
      d,
      parse(
        'ORGANIZATION_BLOCK OB 1\nVAR_TEMP\n  OB1_EV_CLASS : Byte;\n  Mio : Int;\nEND_VAR\nBEGIN\nEND_ORGANIZATION_BLOCK\n',
      ),
      seq('n'),
    );
    const ob = d.blocks[0] as CodeBlock;
    expect(ob.interface.temp.map((m) => m.readOnly)).toEqual([true, undefined]);
  });

  it('un DB sostituisce un DB con lo stesso nome e tiene il numero', () => {
    const d = emptyDevice();
    const db = createGlobalDb({ number: 9, name: 'Dati', newId: seq('o') });
    d.blocks.push(db);
    applySource(d, parse(fixture('db.awl')), seq('n'));
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({ id: db.id, number: 9, kind: 'DB' });
  });
});
