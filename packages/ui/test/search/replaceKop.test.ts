import { describe, expect, it } from 'vitest';
import type { LadNetwork } from '@baaportal/ladfbd';
import { blockSources, type CodeBlock, type Project } from '@baaportal/project';
import { findInProject } from '../../src/search/findInProject';
import { replaceInProject } from '../../src/search/replaceInProject';
import { opts, withBlocks } from './fixtures';
import { fb } from '../blockFixtures';

function kopBlock(name: string, language: 'KOP' | 'FUP', lad: LadNetwork): CodeBlock {
  const b = fb(name);
  b.language = language;
  b.networks = [{ id: `${name}-n0`, title: '', comment: '', source: '', lad }];
  return b;
}

const net = (): LadNetwork => ({
  root: {
    id: 'r',
    series: [
      { id: 'c1', k: 'contact', neg: false, op: '"Motore"' },
      { id: 'c2', k: 'contact', neg: false, op: '"Motore2"' },
      {
        id: 'cmp',
        k: 'cmp',
        fn: '==I',
        in1: 'MW 10',
        in2: '"Motore"',
      },
    ],
    outs: [{ id: 'o', k: 'coil', op: 'M 10.1' }],
  },
});

/** Il progetto con la sorgente generata allineata al grafico, come dopo una modifica dell'editor. */
function project(): Project {
  const p = withBlocks([kopBlock('K', 'KOP', net()), kopBlock('F', 'FUP', net())]);
  const d = p.devices[0]!;
  for (const b of d.blocks as CodeBlock[]) {
    if (b.name !== 'K' && b.name !== 'F') continue;
    blockSources(b, d).forEach((s, i) => (b.networks[i]!.source = s));
  }
  return p;
}
const lad = (p: Project, name: string) =>
  (p.devices[0]!.blocks.find((b) => b.name === name) as CodeBlock).networks[0]!.lad!;

describe('Sostituisci negli operandi KOP e FUP', () => {
  it('un risultato dentro un operando è modificabile; il testo solo generato no', () => {
    const p = project();
    const hits = findInProject(p, opts('Motore')) as { editable: boolean; reason?: string }[];
    expect(hits.length).toBeGreaterThanOrEqual(6);
    expect(hits.every((h) => h.editable)).toBe(true);
    // `==I` è solo testo generato.
    const gen = findInProject(p, opts('==I')) as { editable: boolean; reason?: string }[];
    expect(gen).toHaveLength(2); // uno per blocco
    expect(gen.every((h) => !h.editable && h.reason === 'KOP')).toBe(true);
    const only = findInProject(p, opts('L ')) as { editable: boolean; reason?: string }[];
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((h) => !h.editable && h.reason === 'KOP')).toBe(true);
  });

  it('Sostituisci tutto riscrive gli operandi del grafico e rigenera la sorgente', () => {
    const p = project();
    const r = replaceInProject(p, opts('"Motore"'), '"Pompa"');
    const l = lad(r.project, 'K').root;
    expect(l.series[0]).toMatchObject({ id: 'c1', op: '"Pompa"' });
    expect(l.series[1]).toMatchObject({ op: '"Motore2"' });
    expect(l.series[2]).toMatchObject({ in1: 'MW 10', in2: '"Pompa"' });
    expect(lad(r.project, 'F').root.series[0]).toMatchObject({ op: '"Pompa"' });
    const k = r.project.devices[0]!.blocks.find((b) => b.name === 'K') as CodeBlock;
    expect(k.networks[0]!.source).toContain('"Pompa"');
    expect(k.networks[0]!.source).toContain('"Motore2"');
    expect(r.skipped).toBe(0);
    // il progetto di ingresso non cambia
    expect(lad(p, 'K').root.series[0]).toMatchObject({ op: '"Motore"' });
  });

  it('più risultati nello stesso operando e un testo di sostituzione con a capo', () => {
    const p = project();
    const r = replaceInProject(p, opts('o'), '0');
    const c = lad(r.project, 'K').root.series[0]!;
    expect(c).toMatchObject({ op: '"M0t0re"' });
    const bad = replaceInProject(p, opts('Motore'), 'a\nb');
    expect(lad(bad.project, 'K').root.series[0]).toMatchObject({ op: '"Motore"' });
    expect(bad.replaced).toBe(0);
    expect(bad.skipped).toBeGreaterThan(0);
  });

  // Un operando scritto su più righe generate (SD/R/L/A %T1, `= "Fl"` e `A "Fl"`) si sostituisce una volta.
  const one = (series: LadNetwork['root']['series']): Project => {
    const p = withBlocks([
      kopBlock('K', 'KOP', {
        root: { id: 'r', series, outs: [{ id: 'o', k: 'coil', op: 'Q 0.0' }] },
      }),
    ]);
    const d = p.devices[0]!;
    const b = d.blocks.find((x) => x.name === 'K') as CodeBlock;
    blockSources(b, d).forEach((s, i) => (b.networks[i]!.source = s));
    return p;
  };
  const c0 = { id: 'c1', k: 'contact', neg: false, op: '%I0.0' } as const;
  const box = (
    kind: 'S_ODT' | 'SR' | 'S_CU',
    instance: string,
    pins: Record<string, string>,
    bools: string[],
  ) =>
    ({
      id: 'b',
      k: 'box',
      box: kind,
      instance,
      pins,
      boolPins: Object.fromEntries(
        bools.map((n, i) => [n, [{ id: `p${i}`, k: 'contact', neg: false, op: `%I1.${i}` }]]),
      ),
    }) as const;
  it.each([
    ['timer', box('S_ODT', '%T1', { TV: 'S5T#2S', BI: 'MW 2', BCD: '' }, ['R']), '%T1', '%T12'],
    [
      'timer, più corto',
      box('S_ODT', '%T12', { TV: 'S5T#2S', BI: 'MW 2', BCD: '' }, ['R']),
      '%T12',
      '%T1',
    ],
    ['SR', box('SR', '%M0.0', {}, ['R']), '%M0.0', '%M10.0'],
    ['contatore', box('S_CU', '%C3', { PV: 'C#5', CV: '', CV_BCD: '' }, ['S', 'R']), '%C3', '%C33'],
    [
      'contatore, più corto',
      box('S_CU', '%C33', { PV: 'C#5', CV: '', CV_BCD: '' }, ['S', 'R']),
      '%C33',
      '%C3',
    ],
  ])("%s: l'istanza su più righe si sostituisce una volta", (_n, b, from, to) => {
    const p = one([c0, b as never]);
    const hits = findInProject(p, opts(from)) as { editable: boolean }[];
    expect(hits).toHaveLength(1);
    const r = replaceInProject(p, opts(from), to);
    expect(lad(r.project, 'K').root.series[1]).toMatchObject({ instance: to });
    expect(r.replaced).toBe(1);
  });

  it('(#) scritto su due righe si sostituisce una volta, anche più corto', () => {
    const p = one([
      c0,
      { id: 'm', k: 'midline', op: '"Fl"' },
      { id: 'c2', k: 'contact', neg: false, op: '%I0.1' },
    ]);
    expect(findInProject(p, opts('Fl'))).toHaveLength(1);
    const r = replaceInProject(p, opts('Fl'), 'Flag');
    expect(lad(r.project, 'K').root.series[1]).toMatchObject({ op: '"Flag"' });
    expect(r.replaced).toBe(1);
    const s = replaceInProject(p, opts('"Fl"'), '"F"');
    expect(lad(s.project, 'K').root.series[1]).toMatchObject({ op: '"F"' });
  });
});
