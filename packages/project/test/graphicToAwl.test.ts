import { readBlockFile } from '@baaportal/mc7';
import type { LadNetwork } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import {
  blockSources,
  blockToMc7File,
  convertGraphicToAwl,
  createCodeBlock,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const box = (op = 'I 0.0'): LadNetwork => ({
  root: {
    id: 'r',
    series: [
      { id: 'c', k: 'contact', neg: false, op },
      {
        id: 'm',
        k: 'box',
        box: 'MOVE',
        instance: '',
        pins: { IN: 'MW 0', OUT: 'MW 2' },
        boolPins: {},
      },
    ],
    outs: [],
  },
});

function kop(dev: PlcDevice, number: number, nets: (LadNetwork | string)[]): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number, name: `F${number}`, language: 'KOP' });
  b.networks = nets.map((n, i) => ({
    id: `n${number}_${i}`,
    title: '',
    comment: '',
    source: typeof n === 'string' ? n : '',
    ...(typeof n === 'string' ? {} : { lad: n }),
  }));
  dev.blocks.push(b);
  const sources = blockSources(b, dev);
  b.networks.forEach((n, i) => (n.source = sources[i]!));
  return b;
}

const code = (b: CodeBlock, dev: PlcDevice) =>
  readBlockFile(blockToMc7File(b, dev, cpu315pn, now).file!).mc7;

describe('convertGraphicToAwl: blocco intero', () => {
  it('il blocco diventa AWL con lo stesso AWL e lo stesso MC7, senza grafici', () => {
    const dev = makeDevice(seq('a'));
    const b = kop(dev, 60, [box(), 'A I 0.1\n= Q 4.0', box('I 0.2')]);
    const sources = blockSources(b, dev);
    const mc7 = code(b, dev);
    expect(convertGraphicToAwl(b, dev)).toBeNull();
    expect(b.language).toBe('AWL');
    expect(b.networks.every((n) => n.lad === undefined)).toBe(true);
    expect(b.networks.map((n) => n.source)).toEqual(sources);
    expect(sources[2]).toContain('_002');
    expect(code(b, dev)).toEqual(mc7);
  });

  it('un blocco che non compila non si converte', () => {
    const dev = makeDevice(seq('a'));
    const b = kop(dev, 61, [box('"NonEsiste"')]);
    const before = structuredClone(b);
    expect(convertGraphicToAwl(b, dev)).toBe('NOT_COMPILABLE');
    expect(b).toEqual(before);
  });
});

describe('convertGraphicToAwl: un segmento', () => {
  it('le etichette automatiche del segmento diventano M001, quelle dopo si rinumerano', () => {
    const dev = makeDevice(seq('a'));
    const b = kop(dev, 62, [box(), box('I 0.2')]);
    const mc7 = code(b, dev);
    expect(convertGraphicToAwl(b, dev, 0)).toBeNull();
    expect(b.language).toBe('KOP');
    expect(b.networks[0]!.lad).toBeUndefined();
    expect(b.networks[0]!.source).toMatch(/JNB\s+M001/);
    expect(b.networks[0]!.source).toMatch(/^M001:/m);
    expect(b.networks[1]!.lad).toBeDefined();
    expect(blockSources(b, dev)[1]).toContain('_001');
    expect(code(b, dev)).toEqual(mc7);
  });

  it('M001 già usata da un altro segmento: si prende M002', () => {
    const dev = makeDevice(seq('a'));
    const b = kop(dev, 63, ['A I 0.1\nJC M001\nM001: NOP 0', box()]);
    expect(convertGraphicToAwl(b, dev, 1)).toBeNull();
    expect(b.networks[1]!.source).toMatch(/JNB\s+M002/);
  });

  it('un salto che dopo la rinumerazione cambierebbe bersaglio: il blocco non cambia', () => {
    const dev = makeDevice(seq('a'));
    const b = kop(dev, 64, ['A I 0.1\nJC _002', box(), box('I 0.2')]);
    const before = structuredClone(b);
    expect(convertGraphicToAwl(b, dev, 1)).toBe('JUMPS');
    expect(b).toEqual(before);
  });

  it('un segmento senza grafico: niente da fare', () => {
    const dev = makeDevice(seq('a'));
    const b = kop(dev, 65, ['A I 0.1\n= Q 4.0', box()]);
    expect(convertGraphicToAwl(b, dev, 0)).toBe('SHAPE');
  });
});
