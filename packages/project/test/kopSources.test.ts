import type { LadElem, LadNetwork, LadNode, LadOut } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import {
  blockSources,
  createCodeBlock,
  kopCallParams,
  kopSources,
  tempEnd,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { makeDevice, seq } from './fixtures';

let n = 0;
const id = (p: string) => `${p}${++n}`;
const contact = (op: string): LadElem => ({ id: id('c'), k: 'contact', neg: false, op });
const coil = (op: string): LadOut => ({ id: id('o'), k: 'coil', op });
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: id('N'),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNetwork => ({
  root: node(series, outs),
});

function kopFc(dev: PlcDevice, number = 20): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number, name: `K${number}`, language: 'KOP' });
  dev.blocks.push(b);
  return b;
}

const member = (name: string, type: string) => ({ id: id('m'), name, type, comment: '' });

describe('kopSources', () => {
  it('i bit automatici ripartono dopo i TEMP dichiarati (ramo a T: L 3.0)', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev);
    b.interface.temp.push(member('a', 'Byte'), member('b', 'Byte'), member('c', 'Byte'));
    b.networks[0]!.lad = net(
      [contact('I 0.0')],
      [coil('Q 4.0'), node([contact('I 0.1')], [coil('Q 4.1')])],
    );
    expect(tempEnd(b, dev)).toBe(3);
    const [r] = kopSources(b, dev);
    expect(r!.diagnostics).toEqual([]);
    expect(r!.source).toContain('%L3.0');
    expect(r!.lines.length).toBeGreaterThan(0);
  });

  it('un TEMP Int dopo i byte si allinea a parola: L 6.0', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev);
    b.interface.temp.push(
      member('a', 'Byte'),
      member('b', 'Byte'),
      member('c', 'Byte'),
      member('d', 'Int'),
    );
    b.networks[0]!.lad = net(
      [contact('I 0.0')],
      [coil('Q 4.0'), node([contact('I 0.1')], [coil('Q 4.1')])],
    );
    expect(tempEnd(b, dev)).toBe(6);
    expect(blockSources(b, dev)[0]).toContain('%L6.0');
  });

  it('un segmento senza lad usa la sua sorgente', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev);
    delete b.networks[0]!.lad;
    b.networks[0]!.source = 'A I 0.0;\n= Q 4.0;';
    expect(blockSources(b, dev)).toEqual(['A I 0.0;\n= Q 4.0;']);
    expect(kopSources(b, dev)[0]!.diagnostics).toEqual([]);
  });

  it('un blocco AWL restituisce le sorgenti delle sue reti', () => {
    const dev = makeDevice(seq('k'));
    const b = createCodeBlock({ kind: 'FC', number: 21, name: 'Aw', language: 'AWL' });
    b.networks[0]!.source = 'NOP 0;';
    expect(blockSources(b, dev)).toEqual(['NOP 0;']);
  });

  it('i diagnostici di un segmento non toccano gli altri', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev);
    b.networks.push({
      id: 'n2',
      title: '',
      comment: '',
      source: '',
      lad: net([contact('I 0.0')], [coil('Q 4.0')]),
    });
    const r = kopSources(b, dev);
    expect(r[0]!.diagnostics.map((d) => d.code)).toEqual(['EMPTY_OPERAND']);
    expect(r[0]!.source).toBe('');
    expect(r[1]!.diagnostics).toEqual([]);
    expect(r[1]!.source).toContain('A %I0.0');
  });

  it('un box CALL riceve i parametri nell ordine dell interfaccia del chiamato', () => {
    const dev = makeDevice(seq('k'));
    const callee = createCodeBlock({ kind: 'FC', number: 30, name: 'Dest', language: 'AWL' });
    callee.interface.input.push(member('Zeta', 'Bool'));
    callee.interface.output.push(member('Alfa', 'Bool'));
    dev.blocks.push(callee);
    const b = kopFc(dev);
    const call: LadElem = {
      id: id('b'),
      k: 'box',
      box: 'CALL',
      instance: 'FC 30',
      pins: { Alfa: 'Q 4.1', Zeta: 'I 0.0' },
      boolPins: {},
    };
    b.networks[0]!.lad = net([call], [coil('Q 4.2')]);
    const src = blockSources(b, dev)[0]!;
    expect(src.indexOf('Zeta')).toBeGreaterThan(-1);
    expect(src.indexOf('Zeta')).toBeLessThan(src.indexOf('Alfa'));
  });

  it('kopCallParams: nome, direzione e tipo dall interfaccia, RET_VAL è un uscita', () => {
    const dev = makeDevice(seq('k'));
    const fc = createCodeBlock({ kind: 'FC', number: 32, name: 'Cp', language: 'AWL' });
    fc.interface.input.push(member('In1', 'Bool'));
    fc.interface.output.push(member('Out1', 'Int'));
    fc.interface.inOut.push(member('Io1', 'Word'));
    fc.interface.returnType = 'Int';
    dev.blocks.push(fc);
    const b = kopFc(dev);
    const params = kopCallParams(b, dev);
    expect(params('FC 32')).toEqual([
      { name: 'In1', dir: 'in', type: 'Bool' },
      { name: 'RET_VAL', dir: 'out', type: 'Int' },
      { name: 'Out1', dir: 'out', type: 'Int' },
      { name: 'Io1', dir: 'inout', type: 'Word' },
    ]);
    expect(params('"Cp"')).toHaveLength(4);
    expect(params('FC 99')).toBeUndefined();
  });

  it('multi-instance FB40 assoluta, RET_VAL dopo gli ingressi, #"quotato"', () => {
    const dev = makeDevice(seq('k'));
    const fb = createCodeBlock({ kind: 'FB', number: 40, name: 'Fb40', language: 'AWL' });
    fb.interface.input.push(member('Zeta', 'Bool'));
    fb.interface.output.push(member('Alfa', 'Bool'));
    dev.blocks.push(fb);
    const fc = createCodeBlock({ kind: 'FC', number: 31, name: 'Ret', language: 'AWL' });
    fc.interface.input.push(member('In1', 'Bool'));
    fc.interface.output.push(member('Out1', 'Bool'));
    fc.interface.returnType = 'Int';
    dev.blocks.push(fc);
    const b = kopFc(dev, 20);
    b.interface.static.push(member('inst', 'FB40'));
    const call = (instance: string, pins: Record<string, string>): LadNetwork =>
      net([{ id: id('b'), k: 'box', box: 'CALL', instance, pins, boolPins: {} }], [coil('Q 4.2')]);
    b.networks[0]!.lad = call('#inst', { Alfa: 'Q 4.1', Zeta: 'I 0.0' });
    let src = blockSources(b, dev)[0]!;
    expect(src.indexOf('Zeta')).toBeGreaterThan(-1);
    expect(src.indexOf('Zeta')).toBeLessThan(src.indexOf('Alfa'));
    b.networks[0]!.lad = call('#"inst"', { Alfa: 'Q 4.1', Zeta: 'I 0.0' });
    src = blockSources(b, dev)[0]!;
    expect(src.indexOf('Zeta')).toBeLessThan(src.indexOf('Alfa'));
    b.networks[0]!.lad = call('FC 31', { Out1: 'Q 4.1', RET_VAL: 'MW 10', In1: 'I 0.0' });
    src = blockSources(b, dev)[0]!;
    expect(src.indexOf('In1')).toBeLessThan(src.indexOf('RET_VAL'));
    expect(src.indexOf('RET_VAL')).toBeLessThan(src.indexOf('Out1'));
  });
});
