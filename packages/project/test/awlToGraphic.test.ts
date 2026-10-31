import { formatNetwork } from '@baaportal/awl';
import type { LadNetwork } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import {
  blockFromMc7,
  blockSources,
  blockToMc7File,
  convertBlockToGraphic,
  convertNetworkToGraphic,
  createCodeBlock,
  planImport,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const fmt = (s: string) => formatNetwork(s, 'international');
const AND = 'A I 0.0\nA I 0.1\n= Q 4.0';
const MOVE = 'A I 0.2\nJNB M001\nL MW 10\nT MW 12\nM001: NOP 0';
const XOR_AFTER_AND = 'A I 0.0\nX I 0.1\n= Q 4.0';

function fc(dev: PlcDevice, number: number, language: CodeBlock['language'], sources: string[]) {
  const b = createCodeBlock({ kind: 'FC', number, name: `F${number}`, language });
  b.networks = sources.map((source, i) => ({
    id: `n${number}_${i}`,
    title: '',
    comment: '',
    source,
  }));
  dev.blocks.push(b);
  return b;
}

describe('convertBlockToGraphic', () => {
  it('ogni segmento si converte: il blocco diventa KOP con lo stesso AWL', () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 30, 'AWL', [AND, MOVE, '']);
    expect(convertBlockToGraphic(b, dev, 'KOP', seq('x'))).toEqual([]);
    expect(b.language).toBe('KOP');
    expect(b.networks.map((n) => n.lad !== undefined)).toEqual([true, true, false]);
    expect(blockSources(b, dev)).toEqual([fmt(AND), fmt(MOVE.replace(/M001/g, '_001')), '']);
  });

  it('un segmento senza forma KOP: il blocco non cambia e il motivo dice quale', () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 31, 'AWL', [AND, XOR_AFTER_AND]);
    const before = structuredClone(b);
    const r = convertBlockToGraphic(b, dev, 'FUP', seq('x'));
    expect(r).toEqual([{ network: 2, reason: { code: 'SHAPE', line: expect.any(Number) } }]);
    expect(b).toEqual(before);
  });
});

describe('convertNetworkToGraphic', () => {
  const lad: LadNetwork = {
    root: {
      id: 'r',
      series: [
        { id: 'c', k: 'contact', neg: false, op: 'I 0.0' },
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
  };

  it('le etichette automatiche continuano quelle dei segmenti grafici prima', () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 32, 'KOP', ['', MOVE.replace(/M001/g, '_002')]);
    b.networks[0]!.lad = structuredClone(lad);
    expect(convertNetworkToGraphic(b, dev, 1, seq('x'))).toBeNull();
    expect(b.networks[1]!.lad).toBeDefined();
    expect(blockSources(b, dev)[1]).toBe(fmt(MOVE.replace(/M001/g, '_002')));
  });

  it("un'etichetta usata da un altro segmento non si rinomina", () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 33, 'KOP', [MOVE, 'JU M001']);
    expect(convertNetworkToGraphic(b, dev, 0, seq('x'))).toMatchObject({ code: 'SHAPE' });
    expect(b.networks[0]!.lad).toBeUndefined();
  });
});

describe('caricamento dalla CPU: lingua 0x02/0x03', () => {
  /** Un FC compilato in un dispositivo e riletto in un altro, vuoto. */
  function roundTrip(language: CodeBlock['language'], sources: string[], lad?: LadNetwork) {
    const dev = makeDevice(seq('s'));
    const b = fc(dev, 40, language, sources);
    if (lad) b.networks[0]!.lad = lad;
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const target = makeDevice(seq('t'));
    return { file: r.file!, sources: blockSources(b, dev), target };
  }

  it('un FC KOP torna KOP, con lo stesso AWL e gli stessi byte', () => {
    const { file, sources, target } = roundTrip('KOP', [AND, MOVE]);
    const r = blockFromMc7(target, file, seq('i'));
    const b = r.block as CodeBlock;
    expect(b.language).toBe('KOP');
    expect(b.networks.every((n) => n.lad)).toBe(true);
    expect(r.notes.filter((n) => n.code === 'AWL_NON_CONVERTITO')).toEqual([]);
    target.blocks.push(b);
    expect(blockSources(b, target)).toEqual(sources.map((s) => fmt(s.replace(/M001/g, '_001'))));
    expect(blockToMc7File(b, target, cpu315pn, now).file).toEqual(file);
  });

  it('FUP con planImport', () => {
    const { file, target } = roundTrip('FUP', [AND]);
    const plan = planImport(target, [file], seq('i'));
    expect((plan.create[0] as CodeBlock).language).toBe('FUP');
  });

  it('un segmento senza forma KOP: resta AWL con la nota', () => {
    const { file, target } = roundTrip('KOP', [AND, XOR_AFTER_AND]);
    const r = blockFromMc7(target, file, seq('i'));
    expect((r.block as CodeBlock).language).toBe('AWL');
    expect(r.notes).toContainEqual({
      code: 'AWL_NON_CONVERTITO',
      params: { language: 'KOP', networks: '2' },
    });
  });

  it('un blocco AWL resta AWL', () => {
    const { file, target } = roundTrip('AWL', [AND]);
    expect((blockFromMc7(target, file, seq('i')).block as CodeBlock).language).toBe('AWL');
  });
});

describe('convertNetworkToGraphic: altri segmenti', () => {
  const box: LadNetwork = {
    root: {
      id: 'r',
      series: [
        { id: 'c', k: 'contact', neg: false, op: 'I 0.0' },
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
  };
  const compiles = (b: CodeBlock, dev: PlcDevice) =>
    expect(
      blockToMc7File(b, dev, cpu315pn, now).diagnostics.filter((d) => d.severity === 'error'),
    ).toEqual([]);

  it('le etichette automatiche di un grafico dopo si rinumerano: il segmento si converte', () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 50, 'KOP', [MOVE, '']);
    b.networks[1]!.lad = structuredClone(box);
    expect(convertNetworkToGraphic(b, dev, 0, seq('x'))).toBeNull();
    const src = blockSources(b, dev);
    expect(src[0]).toContain('_001');
    expect(src[1]).toContain('_002');
    compiles(b, dev);
  });

  it("un salto da un segmento AWL all'etichetta di un grafico porta ancora lì", () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 51, 'KOP', ['A I 0.1\nJC DEST', MOVE, '']);
    b.networks[2]!.lad = { ...structuredClone(box), label: 'DEST' };
    expect(convertNetworkToGraphic(b, dev, 1, seq('x'))).toBeNull();
    expect(blockSources(b, dev)[2]).toMatch(/^DEST:/m);
    compiles(b, dev);
  });

  it('un salto che dopo la rinumerazione cambierebbe bersaglio: resta AWL', () => {
    const dev = makeDevice(seq('a'));
    const b = fc(dev, 52, 'KOP', ['A I 0.1\nJC _002', MOVE, '']);
    b.networks[2]!.lad = structuredClone(box);
    const before = structuredClone(b);
    expect(convertNetworkToGraphic(b, dev, 1, seq('x'))).toEqual({ code: 'SHAPE' });
    expect(b).toEqual(before);
  });

  it('un bit L letto da un altro segmento non diventa il bit nascosto di un ramo a T', () => {
    const seg = 'A I 0.0\n= L 0.0\nA L 0.0\n= Q 0.0\nA L 0.0\n= Q 0.1';
    for (const other of ['AWL', 'KOP'] as const) {
      const dev = makeDevice(seq('a'));
      const b = fc(dev, 53, 'KOP', [seg, 'A L 0.0\n= Q 1.0']);
      if (other === 'KOP')
        b.networks[1]!.lad = {
          root: {
            id: 'r',
            series: [{ id: 'c', k: 'contact', neg: false, op: 'L 0.0' }],
            outs: [{ id: 'q', k: 'coil', op: 'Q 1.0' }],
          },
        };
      expect(convertNetworkToGraphic(b, dev, 0, seq('x'))).toBeNull();
      // L 0.0 resta scritto nella rete: non dipende da dove finiscono i TEMP
      expect(JSON.stringify(b.networks[0]!.lad)).toContain('L0.0');
    }
  });
});
