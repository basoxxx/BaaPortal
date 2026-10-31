// Conversione AWL → KOP: andata e ritorno. Ogni rete tradotta in AWL e riconvertita deve dare la
// stessa sorgente; una sorgente che nessuna rete KOP genera resta AWL con un motivo.
import { formatNetwork } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { awlToLad, blockAwlToLad, networkToAwl, validateNetwork } from '../src/index.js';
import type { BoxKind, CmpFn, LadBox, LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';
import { BOX_CATALOG, BOX_KINDS, CMP_FNS } from '../src/index.js';

let seq = 0;
const nid = () => `x${++seq}`;
const c = (op: string): LadElem => ({ id: nid(), k: 'contact', neg: false, op });
const nc = (op: string): LadElem => ({ id: nid(), k: 'contact', neg: true, op });
const par = (...branches: LadElem[][]): LadElem => ({ id: nid(), k: 'parallel', branches });
const not = (): LadElem => ({ id: nid(), k: 'not' });
const mid = (op: string): LadElem => ({ id: nid(), k: 'midline', op });
const edge = (dir: 'P' | 'N', mem: string): LadElem => ({ id: nid(), k: 'edge', dir, mem });
const posneg = (dir: 'P' | 'N', bit: string, mem: string): LadElem => ({
  id: nid(),
  k: 'posneg',
  dir,
  bit,
  mem,
});
const cmp = (fn: CmpFn, in1 = 'MW 10', in2 = 'MW 12'): LadElem => ({
  id: nid(),
  k: 'cmp',
  fn,
  in1,
  in2,
});
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
const out = (o: NoId<LadOut>): LadOut => ({ id: nid(), ...o }) as LadOut;
const coil = (op: string) => out({ k: 'coil', op });
const box = (
  kind: BoxKind,
  pins: Record<string, string>,
  instance = '',
  boolPins: Record<string, LadElem[]> = {},
): LadBox => ({ id: nid(), k: 'box', box: kind, instance, pins, boolPins });
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: nid(),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[], label?: string): LadNetwork => ({
  root: node(series, outs),
  ...(label === undefined ? {} : { label }),
});

const OPTS = { tempEnd: 20, firstLabel: 1 };
const awl = (n: LadNetwork, opts = OPTS) => {
  const r = networkToAwl(n, opts);
  expect(r.diagnostics).toEqual([]);
  return r.source;
};
const convert = (src: string, extra: Partial<Parameters<typeof awlToLad>[1]> = {}) =>
  awlToLad(src, { ...OPTS, newId: nid, ...extra });

/** AWL della rete → rete → AWL: stessa sorgente. */
function roundTrip(n: LadNetwork, opts = OPTS): void {
  const src = awl(n, opts);
  const r = awlToLad(src, { ...opts, newId: nid });
  if (!r.ok) throw new Error(`non convertita (${JSON.stringify(r.reason)}):\n${src}`);
  expect(networkToAwl(r.network, opts).source).toBe(src);
  expect(r.nextLabel).toBe(networkToAwl(n, opts).nextLabel);
}

const mathPins = (kind: BoxKind): Record<string, string> => {
  const d = BOX_CATALOG[kind];
  const pins: Record<string, string> = {};
  [...d.dataInputs, ...d.outputs].forEach((p, i) => (pins[p.name] = `MW ${10 + 2 * i}`));
  return pins;
};

describe('awlToLad: forme di networkToAwl', () => {
  const cases: [string, LadNetwork][] = [
    ['contatti in serie', net([c('I 0.0'), nc('I 0.1')], [coil('Q 4.0')])],
    ['parallelo sulla barra (regola 1)', net([par([c('I 0.0')], [nc('I 0.1')])], [coil('Q 4.0')])],
    [
      'rami in serie (regola 2)',
      net([par([c('I 0.0'), c('I 0.1')], [nc('I 0.2'), c('I 0.3')])], [coil('Q 4.0')]),
    ],
    [
      'parallelo in A( con rami misti (regole 3 e 4)',
      net(
        [c('I 1.0'), par([c('I 0.0')], [c('I 0.1'), par([c('I 0.2')], [c('I 0.3')])])],
        [coil('Q 4.0')],
      ),
    ],
    [
      'NOT, fronti, (#)',
      net([c('I 0.0'), not(), edge('P', 'M 1.0'), mid('M 2.0'), c('I 0.1')], [coil('Q 4.0')]),
    ],
    [
      'NOT, fronti e (#) nei rami con logica davanti (H21), anche annidati',
      net(
        [
          c('I 0.0'),
          par(
            [not()],
            [c('I 0.1'), edge('P', 'M 1.0')],
            [mid('M 2.0'), par([not()], [c('I 0.2')])],
          ),
          c('I 0.3'),
        ],
        [coil('Q 4.0')],
      ),
    ],
    [
      'box POS con logica davanti',
      net([c('I 0.0'), posneg('N', 'I 0.3', 'M 1.1')], [coil('Q 4.0')]),
    ],
    [
      'confronto sulla barra e dopo logica',
      net([cmp('>=I'), c('I 0.0'), cmp('<>R', 'MD 0', 'MD 4')], [coil('Q 4.0')]),
    ],
    [
      'uscite S, R, temporizzatore, contatori',
      net(
        [c('I 0.0')],
        [
          out({ k: 'set', op: 'M 0.0' }),
          out({ k: 'reset', op: 'M 0.1' }),
          out({ k: 'tcoil', fn: 'SE', timer: 'T 1', value: 'S5T#2S' }),
          out({ k: 'ccoil', fn: 'SC', counter: 'C 1', value: 'C#10' }),
          out({ k: 'ccoil', fn: 'CU', counter: 'C 2', value: '' }),
        ],
      ),
    ],
    ['salti, etichetta del segmento', net([c('I 0.0')], [out({ k: 'jmpn', label: 'END' })], 'ANF')],
    ['salto incondizionato sulla barra', net([], [out({ k: 'jmp', label: 'M1' })])],
    ['RET', net([c('I 0.0')], [coil('Q 4.0'), out({ k: 'ret' })])],
    [
      'SAVE e chiamata',
      net([c('I 0.0')], [out({ k: 'save' }), out({ k: 'callCoil', block: 'FC 3' })]),
    ],
    ['UC sulla barra', net([], [out({ k: 'callCoil', block: 'FC 3' })])],
    ['OPN da sola', net([], [out({ k: 'opn', db: 'DB 10' })])],
    ['MCR(', net([c('I 0.0')], [out({ k: 'mcrOpen' })])],
    [')MCR', net([], [out({ k: 'mcrClose' })])],
    ['MCRA', net([], [out({ k: 'mcra' })])],
    ['bobine sulla barra (SET)', net([], [coil('Q 4.0'), coil('Q 4.1')])],
    [
      'rami a T: nodo salvato in un bit L',
      net(
        [c('I 0.0')],
        [
          coil('Q 4.0'),
          node([c('I 0.1')], [coil('Q 4.1')]),
          node([nc('I 0.2')], [out({ k: 'jmp', label: 'X' })]),
        ],
      ),
    ],
    [
      'rami a T dalla barra',
      net([], [node([c('I 0.0')], [coil('Q 4.0')]), node([c('I 0.1')], [coil('Q 4.1')])]),
    ],
    [
      'rami a T annidati',
      net(
        [c('I 0.0')],
        [coil('Q 4.0'), node([c('I 0.1')], [coil('Q 4.1'), node([c('I 0.2')], [coil('Q 4.2')])])],
      ),
    ],
    [
      'SR con pin R',
      net([c('I 0.0'), box('SR', {}, 'M 0.0', { R: [c('I 0.1')] })], [coil('Q 4.0')]),
    ],
    ['RS sulla barra', net([box('RS', {}, 'M 0.0', { S: [par([c('I 0.1')], [c('I 0.2')])] })], [])],
    [
      'S_ODT con tutti i pin',
      net(
        [
          c('I 0.0'),
          box('S_ODT', { TV: 'S5T#5S', BI: 'MW 10', BCD: 'MW 12' }, 'T 1', { R: [c('I 0.1')] }),
        ],
        [coil('Q 4.0')],
      ),
    ],
    [
      'S_CUD con tutti i pin',
      net(
        [
          c('I 0.0'),
          box('S_CUD', { PV: 'C#5', CV: 'MW 10', CV_BCD: 'MW 12' }, 'C 1', {
            CD: [c('I 0.1')],
            S: [c('I 0.2')],
            R: [c('I 0.3')],
          }),
        ],
        [coil('Q 4.0')],
      ),
    ],
    ['S_CU senza uscite', net([c('I 0.0'), box('S_CU', {}, 'C 2')], [])],
    ['box sulla barra, ENO libero', net([box('ADD_I', mathPins('ADD_I'))], [])],
    ['box sulla barra, ENO collegato', net([box('MUL_R', mathPins('MUL_R'))], [coil('Q 4.0')])],
    [
      'MOVE sulla barra, ENO collegato',
      net([box('MOVE', { IN: 'MW 10', OUT: 'MW 12' })], [coil('Q 4.0')]),
    ],
    [
      'cascata ADD_I → MOVE e logica dopo',
      net(
        [
          c('I 0.0'),
          box('ADD_I', mathPins('ADD_I')),
          box('MOVE', { IN: 'MW 14', OUT: 'MW 16' }),
          c('I 0.1'),
        ],
        [coil('Q 4.0')],
      ),
    ],
    [
      'scorrimento',
      net([c('I 0.0'), box('SHL_W', { IN: 'MW 10', N: 'W#16#3', OUT: 'MW 12' })], []),
    ],
    [
      'box in un ramo a T',
      net([c('I 0.0')], [node([box('MOVE', { IN: 'MW 10', OUT: 'MW 12' })], []), coil('Q 4.0')]),
    ],
    [
      'CALL con parametri e pin BOOL con logica',
      net(
        [
          c('I 0.0'),
          box('CALL', { IN1: 'MW 10', OUT1: 'MW 12' }, 'FC 1', { EN2: [c('I 0.5'), nc('I 0.6')] }),
        ],
        [coil('Q 4.0')],
      ),
    ],
    ['FB con DB, sulla barra', net([box('CALL', { X: 'MW 10' }, 'FB 1, DB 1')], [])],
    ['CALL senza parametri', net([box('CALL', {}, 'FC 3')], [coil('Q 4.0')])],
    [
      'CALL con pin BOOL in un ramo a T',
      net([c('I 0.0')], [coil('Q 4.0'), node([box('CALL', {}, 'FC 2', { B: [c('I 0.7')] })], [])]),
    ],
  ];
  it.each(cases)('%s', (_, n) => roundTrip(n));

  it('ogni box con EN/ENO, con logica davanti e sulla barra', () => {
    for (const kind of BOX_KINDS) {
      const d = BOX_CATALOG[kind];
      if (!d.en || kind === 'CALL') continue;
      roundTrip(net([c('I 0.0'), box(kind, mathPins(kind))], [coil('Q 4.0')]));
      roundTrip(net([box(kind, mathPins(kind))], [coil('Q 4.0')]));
      roundTrip(net([nc('I 0.0'), box(kind, mathPins(kind))], []));
    }
  });

  it('ogni temporizzatore e ogni confronto', () => {
    for (const kind of ['S_PULSE', 'S_PEXT', 'S_ODT', 'S_ODTS', 'S_OFFDT'] as const)
      roundTrip(net([c('I 0.0'), box(kind, { TV: 'S5T#1S' }, 'T 2')], []));
    for (const fn of CMP_FNS) roundTrip(net([c('I 0.0'), cmp(fn)], [coil('Q 4.0')]));
  });

  it('etichette automatiche da firstLabel', () => {
    roundTrip(net([c('I 0.0'), box('MOVE', { IN: 'MW 10', OUT: 'MW 12' })], []), {
      tempEnd: 4,
      firstLabel: 7,
    });
  });
});

// ---- reti casuali ----

/** Generatore pseudo-casuale con seme (mulberry32): le reti sono sempre le stesse. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNetwork(rand: () => number): LadNetwork {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const bit = () => `${pick(['I', 'M', 'Q'])} ${Math.floor(rand() * 4)}.${Math.floor(rand() * 8)}`;
  const contact = () => (rand() < 0.3 ? nc(bit()) : c(bit()));
  const flowElem = (): LadElem =>
    pick([not, () => edge(pick(['P', 'N']), bit()), () => mid(bit())])();
  const branch = (depth: number): LadElem[] =>
    Array.from({ length: 1 + Math.floor(rand() * 2) }, () => {
      const r = rand();
      return depth > 0 && r < 0.3 ? parallel(depth - 1) : r < 0.4 ? flowElem() : contact();
    });
  const parallel = (depth: number): LadElem => {
    const p = par(...Array.from({ length: 2 + Math.floor(rand() * 2) }, () => branch(depth)));
    const contacts = p.k === 'parallel' && p.branches.flat().every((e) => e.k === 'contact');
    return contacts && rand() < 0.5 ? { ...p, plain: true } : p;
  };
  const elem = (): LadElem => {
    const r = rand();
    if (r < 0.45) return contact();
    if (r < 0.6) return parallel(1);
    if (r < 0.65) return not();
    if (r < 0.7) return edge(pick(['P', 'N']), bit());
    if (r < 0.75) return posneg(pick(['P', 'N']), bit(), bit());
    if (r < 0.8) return mid(bit());
    if (r < 0.88) return cmp(pick(CMP_FNS));
    if (r < 0.92) return box('SR', {}, 'M 9.0', rand() < 0.5 ? { R: [contact()] } : {});
    if (r < 0.95)
      return box('S_PEXT', { TV: 'S5T#1S', BI: rand() < 0.5 ? 'MW 20' : '' }, 'T 3', {
        R: rand() < 0.5 ? [contact()] : [],
      });
    return box(pick(['ADD_I', 'MOVE', 'ROUND', 'SHR_W', 'WAND_W']), {
      IN: 'MW 10',
      IN1: 'MW 10',
      IN2: 'MW 12',
      N: 'MW 14',
      OUT: 'MW 16',
    });
  };
  const output = (): LadOut => {
    const r = rand();
    if (r < 0.5) return coil(bit());
    if (r < 0.65) return out({ k: 'set', op: bit() });
    if (r < 0.75) return out({ k: 'reset', op: bit() });
    if (r < 0.82) return out({ k: 'tcoil', fn: pick(['SP', 'SD']), timer: 'T 4', value: 'S5T#1S' });
    if (r < 0.88) return out({ k: 'jmp', label: 'L1' });
    if (r < 0.92) return out({ k: 'save' });
    if (r < 0.96) return out({ k: 'callCoil', block: 'FC 5' });
    return out({ k: 'ccoil', fn: 'CU', counter: 'C 3', value: '' });
  };
  const series = (n: number) => Array.from({ length: n }, elem);
  const mkNode = (depth: number, root: boolean): LadNode => {
    const s = series(root ? Math.floor(rand() * 4) : 1 + Math.floor(rand() * 2));
    const outs: (LadOut | LadNode)[] = Array.from({ length: 1 + Math.floor(rand() * 2) }, output);
    if (depth > 0 && rand() < 0.4) outs.push(mkNode(depth - 1, false));
    return node(s, outs);
  };
  return { root: mkNode(2, true) };
}

describe('awlToLad: reti casuali valide', () => {
  it('andata e ritorno su 400 reti', () => {
    const rand = rng(42);
    let checked = 0;
    for (let i = 0; checked < 400 && i < 5000; i++) {
      const n = randomNetwork(rand);
      if (validateNetwork(n).length > 0) continue;
      roundTrip(n);
      checked++;
    }
    expect(checked).toBe(400);
  });
});

describe('awlToLad: forme di STEP 7', () => {
  /** La rete trovata rigenera la sorgente (senza BLD), e il risultato rigenerato non cambia più. */
  const same = (src: string, expected = src) => {
    const r = convert(src);
    if (!r.ok) throw new Error(`non convertita (${JSON.stringify(r.reason)}):\n${src}`);
    expect(networkToAwl(r.network, OPTS).source).toBe(formatNetwork(expected, 'international'));
    return r.network;
  };

  it('OR di serie senza parentesi: A x; O y e A a; A b; O; A c; ON d', () => {
    const n = same('A I 0.0\nO I 0.1\n= Q 4.0');
    expect(n.root.series).toMatchObject([{ k: 'parallel', plain: true, branches: [[{}], [{}]] }]);
    same('A I 0.0\nA I 0.1\nO\nA I 0.2\nAN I 0.3\nON I 0.4\n= Q 4.0');
    // con logica dopo e davanti: dentro A( … )
    same('A I 1.0\nA(\nA I 0.0\nO I 0.1\n)\nA I 1.1\n= Q 4.0');
  });

  it('i BLD si ignorano: la rete rigenera lo stesso AWL senza di loro', () => {
    same('BLD 1\nA I 0.0\n= Q 4.0', 'A I 0.0\n= Q 4.0');
    same(
      'A I 0.0\nBLD 102\n= L 20.0\nA L 20.0\n= Q 4.0\nA L 20.0\nA I 0.1\n= Q 4.1',
      'A I 0.0\n= L 20.0\nA L 20.0\n= Q 4.0\nA L 20.0\nA I 0.1\n= Q 4.1',
    );
  });

  it('etichette fra segmenti: salto in avanti verso l’etichetta del segmento dopo', () => {
    const segs = ['A I 0.0\nJC M1', 'A I 0.1\n= Q 4.0', 'M1: A I 0.2\n= Q 4.1'];
    const r = blockAwlToLad(segs, { tempEnd: 20, newId: nid });
    expect(r.map((x) => x.ok)).toEqual([true, true, true]);
    if (r[2]!.ok) expect(r[2]!.network.label).toBe('M1');
    // un salto seguito da altra logica nello stesso segmento resta AWL (due reti in una)
    expect(
      blockAwlToLad(['A I 0.0\nJC M1\nA I 0.1\n= Q 4.0', segs[2]!], { tempEnd: 20, newId: nid })[0]!
        .ok,
    ).toBe(false);
  });
});

describe('awlToLad: resta AWL', () => {
  it('X e XN: nessun elemento KOP le rappresenta', () => {
    expect(convert('A I 0.0\nX I 0.1\n= Q 4.0').ok).toBe(false);
    expect(convert('X I 0.0\nXN I 0.1\n= Q 4.0').ok).toBe(false);
  });

  it('L e T sciolti, salti verso etichette interne, BLD con etichetta', () => {
    for (const src of [
      'L MW 10\nT MW 12',
      'A I 0.0\nJC M1\n= Q 4.0\nM1: NOP 0',
      'M1: BLD 1\nA I 0.0\n= Q 4.0',
    ])
      expect(convert(src).ok).toBe(false);
  });

  it('errori di sintassi e segmento vuoto', () => {
    expect(convert('A I 0.0\nXYZ 3')).toEqual({ ok: false, reason: { code: 'SYNTAX' } });
    expect(convert('// solo un commento\n')).toEqual({ ok: false, reason: { code: 'EMPTY' } });
  });

  it('con un altro tempEnd il bit L è un operando qualsiasi: cambia la rete, non l’AWL', () => {
    const src = awl(net([c('I 0.0')], [node([c('I 0.1')], [coil('Q 4.0')]), coil('Q 4.1')]));
    const opts = { tempEnd: 30, firstLabel: 1 };
    const r = convert(src, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(networkToAwl(r.network, opts).source).toBe(src);
  });
});

describe('awlToLad: etichette', () => {
  const src = 'A I 0.0\nJNB M001\nL MW 10\nT MW 12\nM001: NOP 0';

  it("l'etichetta di un box si rinomina in quella automatica", () => {
    const r = convert(src);
    expect(r.ok).toBe(true);
    if (r.ok) expect(networkToAwl(r.network, OPTS).source).toContain('_001');
  });

  it('non si rinomina se un altro segmento la usa', () => {
    expect(convert(src, { foreignLabels: new Set(['M001']) }).ok).toBe(false);
    expect(convert(src, { foreignLabels: new Set(['_001']) }).ok).toBe(false);
  });

  it('commenti, spazi e maiuscole non contano', () => {
    const r = convert('  a i 0.0 // avvio\n\n  an I0.1;\n  = q 4.0');
    expect(r.ok).toBe(true);
  });

  it('blockAwlToLad: le etichette crescono nel blocco', () => {
    const r = blockAwlToLad([src, src.replace(/M001/g, 'M002')], { tempEnd: 20, newId: nid });
    expect(r.map((x) => x.ok && x.nextLabel)).toEqual([2, 3]);
  });
});

describe('awlToLad: limiti di tempo e memoria', () => {
  const contacts = (n: number, tail: string) =>
    Array.from({ length: n }, (_, i) => `A M ${i}.0`).join('\n') + `\n${tail}`;

  it.each([
    [1200, '= Q 0.0'],
    [5000, '= Q 0.0'],
    [299, '= Q 0.0'],
    [299, 'X M 1.0'],
    [5000, 'X M 1.0'],
  ])('%i contatti e «%s»: risponde subito, convertito o TOO_COMPLEX', (n, tail) => {
    const t = performance.now();
    const r = convert(contacts(n, tail));
    expect(performance.now() - t).toBeLessThan(1000);
    if (!r.ok) expect(['TOO_COMPLEX', 'SHAPE']).toContain(r.reason.code);
    if (tail.startsWith('X ')) expect(r.ok).toBe(false);
  });
});

describe('awlToLad: bit L usati da altri segmenti', () => {
  const seg1 = 'A I 0.0\n= L 0.0\nA L 0.0\n= Q 0.0\nA L 0.0\n= Q 0.1';
  /** L'AWL della rete con i TEMP più lunghi: cambia se la rete nasconde un bit L. */
  const moved = (r: ReturnType<typeof awlToLad>) =>
    r.ok && networkToAwl(r.network, { tempEnd: 10, firstLabel: 1 }).source;

  it.each(['A L 0.0\n= Q 1.0', 'L LW 0\nT MW 0'])(
    'il bit L che «%s» legge resta un operando della rete',
    (other) => {
      const [r] = blockAwlToLad([seg1, other], { tempEnd: 0, newId: nid });
      expect(r!.ok).toBe(true);
      expect(moved(r!)).toBe(formatNetwork(seg1, 'international'));
    },
  );

  it('senza altri lettori il bit L è quello del ramo a T', () => {
    const [r] = blockAwlToLad([seg1, 'A L 1.0\n= Q 1.0'], { tempEnd: 0, newId: nid });
    expect(r!.ok).toBe(true);
    expect(moved(r!)).toContain('L10.0');
  });
});
