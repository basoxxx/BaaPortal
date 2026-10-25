// Traduzione KOP → AWL di contatti, rami e uscite: ogni test cita il paragrafo di
// docs/linguaggi/kop-awl.md da cui viene l'AWL atteso.
import { describe, expect, it } from 'vitest';
import { formatNetwork, parseNetwork } from '@baaportal/awl';
import { networkToAwl } from '../src/index.js';
import type { CmpFn, LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;
const c = (op: string): LadElem => ({ id: nid('c'), k: 'contact', neg: false, op });
const nc = (op: string): LadElem => ({ id: nid('c'), k: 'contact', neg: true, op });
const par = (...branches: LadElem[][]): LadElem => ({ id: nid('p'), k: 'parallel', branches });
const not = (): LadElem => ({ id: nid('n'), k: 'not' });
const cmp = (fn: CmpFn, in1: string, in2: string): LadElem => ({
  id: nid('k'),
  k: 'cmp',
  fn,
  in1,
  in2,
});
const coil = (op: string): LadOut => ({ id: nid('o'), k: 'coil', op });
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
const out = (o: NoId<LadOut>): LadOut => ({ id: nid('o'), ...o }) as LadOut;
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: nid('N'),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[], label?: string): LadNetwork => ({
  root: node(series, outs),
  ...(label === undefined ? {} : { label }),
});

const fmt = (...lines: string[]) => formatNetwork(lines.join('\n'), 'international');

/** Traduce e controlla gli invarianti comuni: niente diagnostiche, AWL valido e canonico, righe. */
function awl(n: LadNetwork, tempEnd = 20): string {
  const r = networkToAwl(n, { tempEnd, firstLabel: 1 });
  expect(r.diagnostics).toEqual([]);
  expect(parseNetwork(r.source, 'international').errors).toEqual([]);
  expect(formatNetwork(r.source, 'international')).toBe(r.source);
  expect(r.lines.map((l) => l.line)).toEqual(r.source.split('\n').map((_, i) => i));
  expect(r.nextLabel).toBe(1);
  return r.source;
}

describe('contatti e rami (§2.1–§2.7)', () => {
  it('§2.1 contatti in serie', () => {
    expect(awl(net([c('I 0.0'), nc('I 0.1')], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'AN I 0.1', '= Q 4.0'),
    );
  });

  it('§2.2 parallelo sulla barra: O per ogni ramo (regola 1), ON per il contatto NC', () => {
    expect(awl(net([par([c('I 0.0')], [nc('I 0.1')])], [coil('Q 4.0')]))).toBe(
      fmt('O I 0.0', 'ON I 0.1', '= Q 4.0'),
    );
  });

  it('§2.3 rami in serie: O senza operando (regola 2)', () => {
    const n = net([par([c('I 0.0'), c('I 0.1')], [c('I 0.2'), c('I 0.3')])], [coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('A I 0.0', 'A I 0.1', 'O', 'A I 0.2', 'A I 0.3', '= Q 4.0'));
  });

  it('§2.4 parallelo seguito da serie: A( … ) (regola 4)', () => {
    const n = net([par([c('I 0.0')], [c('I 0.1')]), c('I 0.2')], [coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('A(', 'O I 0.0', 'O I 0.1', ')', 'A I 0.2', '= Q 4.0'));
  });

  it('§2.5 parallelo in mezzo alla serie', () => {
    const n = net([c('I 0.0'), par([c('I 0.1')], [c('I 0.2')])], [coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('A I 0.0', 'A(', 'O I 0.1', 'O I 0.2', ')', '= Q 4.0'));
  });

  it('§2.6 rami annidati, forma A (regola 3)', () => {
    const n = net(
      [par([c('I 0.0')], [c('I 0.1'), par([c('I 0.2')], [c('I 0.3')])])],
      [coil('Q 4.0')],
    );
    expect(awl(n)).toBe(
      fmt('O I 0.0', 'O(', 'A I 0.1', 'A(', 'O I 0.2', 'O I 0.3', ')', ')', '= Q 4.0'),
    );
  });

  it('rami misti: un contatto con O, una serie di contatti in O( … ) accanto a un ramo complesso', () => {
    const n = net(
      [par([c('I 0.0')], [c('I 0.1'), c('I 0.2')], [cmp('>I', 'MW 10', 'MW 12')])],
      [coil('Q 4.0')],
    );
    expect(awl(n)).toBe(
      fmt(
        'O I 0.0',
        'O(',
        'A I 0.1',
        'A I 0.2',
        ')',
        'O(',
        'L MW 10',
        'L MW 12',
        '>I',
        ')',
        '= Q 4.0',
      ),
    );
  });

  it('§2.7 NOT', () => {
    expect(awl(net([c('I 0.0'), c('I 0.1'), not()], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'A I 0.1', 'NOT', '= Q 4.0'),
    );
  });

  it('§2.7 NOT dopo un parallelo: A( … ) NOT', () => {
    expect(awl(net([par([c('I 0.0')], [c('I 0.1')]), not()], [coil('Q 4.0')]))).toBe(
      fmt('A(', 'O I 0.0', 'O I 0.1', ')', 'NOT', '= Q 4.0'),
    );
  });

  it('§2.15 contatti di stato come contatti normali', () => {
    expect(awl(net([c('OV'), nc('BR'), par([c('==0')], [c('>=0')])], [coil('Q 4.0')]))).toBe(
      fmt('A OV', 'AN BR', 'A(', 'O ==0', 'O >=0', ')', '= Q 4.0'),
    );
  });

  it('operandi simbolici, locali e di DB passano come scritti', () => {
    expect(awl(net([c('"Avvio"'), nc('#locale'), c('DB10.DBX2.0')], [coil('Q 4.0')]))).toBe(
      fmt('A "Avvio"', 'AN #locale', 'A DB10.DBX2.0', '= Q 4.0'),
    );
  });
});

describe('uscite (§2.8–§2.14)', () => {
  it('§2.8 uscite multiple sullo stesso nodo: = consecutivi, anche con S e R', () => {
    const n = net(
      [c('I 0.0')],
      [
        coil('Q 4.0'),
        coil('Q 4.1'),
        out({ k: 'set', op: 'M 1.0' }),
        out({ k: 'reset', op: 'M 1.1' }),
      ],
    );
    expect(awl(n)).toBe(fmt('A I 0.0', '= Q 4.0', '= Q 4.1', 'S M 1.0', 'R M 1.1'));
  });

  it('§2.9 uscita intermedia (#): = op seguito da A op', () => {
    const n = net(
      [c('I 0.0'), { id: 'mid', k: 'midline', op: 'M 0.0' }, c('I 0.1')],
      [coil('Q 4.0')],
    );
    expect(awl(n)).toBe(fmt('A I 0.0', '= M 0.0', 'A M 0.0', 'A I 0.1', '= Q 4.0'));
  });

  it('§2.10 ramo a T con logica: bit L dopo i TEMP, senza BLD', () => {
    const n = net([c('I 0.0'), c('I 0.1')], [coil('Q 4.0'), node([c('I 0.2')], [coil('Q 4.1')])]);
    expect(awl(n)).toBe(
      fmt(
        'A I 0.0',
        'A I 0.1',
        '= L 20.0',
        'A L 20.0',
        '= Q 4.0',
        'A L 20.0',
        'A I 0.2',
        '= Q 4.1',
      ),
    );
  });

  it('§2.11 set e reset, anche su temporizzatori e contatori', () => {
    const n = net(
      [c('I 0.0')],
      [
        out({ k: 'set', op: 'M 0.0' }),
        out({ k: 'reset', op: 'T 1' }),
        out({ k: 'reset', op: 'C 1' }),
      ],
    );
    expect(awl(n)).toBe(fmt('A I 0.0', 'S M 0.0', 'R T 1', 'R C 1'));
  });

  it('§2.13 fronti (P) e (N) in linea', () => {
    const p = net(
      [c('I 0.0'), c('I 0.1'), { id: 'e', k: 'edge', dir: 'P', mem: 'M 0.0' }],
      [coil('Q 4.0')],
    );
    expect(awl(p)).toBe(fmt('A I 0.0', 'A I 0.1', 'FP M 0.0', '= Q 4.0'));
    const n = net([c('I 0.0'), { id: 'e', k: 'edge', dir: 'N', mem: 'M 0.1' }], [coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('A I 0.0', 'FN M 0.1', '= Q 4.0'));
  });

  it('§2.13 box POS in serie (ipotesi H8)', () => {
    const n = net(
      [c('I 0.0'), { id: 'pp', k: 'posneg', dir: 'P', bit: 'I 0.3', mem: 'M 0.0' }, c('I 0.4')],
      [coil('Q 4.0')],
    );
    expect(awl(n)).toBe(fmt('A I 0.0', 'A(', 'A I 0.3', 'FP M 0.0', ')', 'A I 0.4', '= Q 4.0'));
  });

  it('§2.14 SAVE', () => {
    expect(awl(net([c('I 0.0')], [out({ k: 'save' })]))).toBe(fmt('A I 0.0', 'SAVE'));
  });
});

describe('temporizzatori, contatori, confronti (§3)', () => {
  it('§3.1 bobina temporizzatore: L valore, poi avvio', () => {
    const n = net([c('I 0.0')], [out({ k: 'tcoil', fn: 'SD', timer: 'T 1', value: 'S5T#5S' })]);
    expect(awl(n)).toBe(fmt('A I 0.0', 'L S5T#5S', 'SD T 1'));
  });

  it('§3.3 bobine contatore SC, CU, CD', () => {
    const sc = net([c('I 0.0')], [out({ k: 'ccoil', fn: 'SC', counter: 'C 10', value: 'C#100' })]);
    expect(awl(sc)).toBe(fmt('A I 0.0', 'L C#100', 'S C 10'));
    const cu = net([c('I 0.1')], [out({ k: 'ccoil', fn: 'CU', counter: 'C 10', value: '' })]);
    expect(awl(cu)).toBe(fmt('A I 0.1', 'CU C 10'));
    const cd = net([c('I 0.2')], [out({ k: 'ccoil', fn: 'CD', counter: 'C 10', value: '' })]);
    expect(awl(cd)).toBe(fmt('A I 0.2', 'CD C 10'));
  });

  it('§3.5 confronto con logica davanti: A( … )', () => {
    const n = net([c('I 0.0'), cmp('>I', 'MW 10', 'MW 12')], [coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('A I 0.0', 'A(', 'L MW 10', 'L MW 12', '>I', ')', '= Q 4.0'));
  });

  it('§3.5 confronto primo elemento sulla barra: senza parentesi (ipotesi H10)', () => {
    const n = net([cmp('>I', 'MW 10', 'MW 12'), c('I 0.1')], [coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('L MW 10', 'L MW 12', '>I', 'A I 0.1', '= Q 4.0'));
  });

  it('§3.5 confronto in un ramo parallelo: O( … )', () => {
    const n = net([c('I 0.0'), par([c('I 0.1')], [cmp('==R', 'MD 4', '1.5')])], [coil('Q 4.0')]);
    expect(awl(n)).toBe(
      fmt('A I 0.0', 'A(', 'O I 0.1', 'O(', 'L MD 4', 'L 1.5', '==R', ')', ')', '= Q 4.0'),
    );
  });
});

describe('salti, RET, MCR, OPN, CALL (§4.11–§4.14)', () => {
  it('§4.12 JMP sulla barra: JU', () => {
    expect(awl(net([], [out({ k: 'jmp', label: 'DEST' })]))).toBe(fmt('JU DEST'));
  });

  it('§4.12 logica + JMP: JC; logica + JMPN: JCN', () => {
    expect(awl(net([c('I 0.0')], [out({ k: 'jmp', label: 'DEST' })]))).toBe(
      fmt('A I 0.0', 'JC DEST'),
    );
    expect(awl(net([c('I 0.0')], [out({ k: 'jmpn', label: 'DEST' })]))).toBe(
      fmt('A I 0.0', 'JCN DEST'),
    );
  });

  it('§4.12 etichetta del segmento davanti alla prima istruzione', () => {
    expect(awl(net([c('I 0.0')], [coil('Q 4.0')], 'DEST'))).toBe(fmt('DEST: A I 0.0', '= Q 4.0'));
  });

  it('§4.13 RET: SAVE; BEC', () => {
    expect(awl(net([c('I 0.0')], [out({ k: 'ret' })]))).toBe(fmt('A I 0.0', 'SAVE', 'BEC'));
  });

  it('§4.14 OPN e MCR', () => {
    expect(awl(net([], [out({ k: 'opn', db: 'DB 10' })]))).toBe(fmt('OPN DB 10'));
    expect(awl(net([], [out({ k: 'opn', db: 'DI 5' })]))).toBe(fmt('OPN DI 5'));
    expect(awl(net([c('I 0.0')], [out({ k: 'mcrOpen' })]))).toBe(fmt('A I 0.0', 'MCR('));
    expect(awl(net([], [out({ k: 'mcrClose' })]))).toBe(fmt(')MCR'));
    expect(awl(net([], [out({ k: 'mcra' })]))).toBe(fmt('MCRA'));
    expect(awl(net([], [out({ k: 'mcrd' })]))).toBe(fmt('MCRD'));
  });

  it('§4.11 bobina CALL sulla barra: UC (ipotesi H16); con logica: CC', () => {
    expect(awl(net([], [out({ k: 'callCoil', block: 'FC 11' })]))).toBe(fmt('UC FC 11'));
    expect(awl(net([c('I 0.1')], [out({ k: 'callCoil', block: 'SFC 46' })]))).toBe(
      fmt('A I 0.1', 'CC SFC 46'),
    );
  });

  it('bobina sulla barra (ipotesi H7): SET davanti', () => {
    expect(awl(net([], [coil('Q 4.0'), coil('Q 4.1')]))).toBe(fmt('SET', '= Q 4.0', '= Q 4.1'));
  });
});

describe('nodi condivisi (bit L)', () => {
  it('JMP non ultimo sul nodo: il nodo si salva in un bit L', () => {
    const n = net([c('I 0.0')], [out({ k: 'jmp', label: 'DEST' }), coil('Q 4.0')]);
    expect(awl(n)).toBe(fmt('A I 0.0', '= L 20.0', 'A L 20.0', 'JC DEST', 'A L 20.0', '= Q 4.0'));
  });

  it('JMP ultimo dopo le bobine: forma consecutiva', () => {
    const n = net([c('I 0.0')], [coil('Q 4.0'), out({ k: 'jmp', label: 'DEST' })]);
    expect(awl(n)).toBe(fmt('A I 0.0', '= Q 4.0', 'JC DEST'));
  });

  it('due rami a T nello stesso segmento: L 20.0 e L 20.1', () => {
    const inner = node([c('I 0.2')], [coil('Q 4.1'), node([c('I 0.3')], [coil('Q 4.2')])]);
    const n = net([c('I 0.0')], [coil('Q 4.0'), inner]);
    expect(awl(n)).toBe(
      fmt(
        'A I 0.0',
        '= L 20.0',
        'A L 20.0',
        '= Q 4.0',
        'A L 20.0',
        'A I 0.2',
        '= L 20.1',
        'A L 20.1',
        '= Q 4.1',
        'A L 20.1',
        'A I 0.3',
        '= Q 4.2',
      ),
    );
  });

  it('i bit L passano al byte successivo dopo .7', () => {
    let inner: LadNode = node([c('I 1.0')], [coil('Q 5.0')]);
    for (let i = 0; i < 9; i++) inner = node([c(`I 0.${i % 8}`)], [coil(`Q 4.${i % 8}`), inner]);
    const src = awl(net([], [inner]), 4);
    expect(src).toContain('= %L4.7;');
    expect(src).toContain('= %L5.0;');
    expect(src).not.toContain('%L5.1');
  });

  it('una sola uscita che è un nodo: la serie continua senza bit L', () => {
    const n = net([c('I 0.0')], [node([c('I 0.1')], [coil('Q 4.0')])]);
    expect(awl(n)).toBe(fmt('A I 0.0', 'A I 0.1', '= Q 4.0'));
  });

  it('rami a T sulla barra: ogni ramo riparte da capo, senza bit L', () => {
    const n = net(
      [],
      [node([c('I 0.0')], [coil('Q 4.0')]), node([cmp('==I', 'MW 2', '5')], [coil('Q 4.1')])],
    );
    expect(awl(n)).toBe(fmt('A I 0.0', '= Q 4.0', 'L MW 2', 'L 5', '==I', '= Q 4.1'));
  });
});

describe('mappa delle righe', () => {
  it('ogni riga punta all’elemento che l’ha generata', () => {
    const a = c('I 0.0');
    const p = par([c('I 0.1')], [c('I 0.2')]);
    const q = coil('Q 4.0');
    const t = node([c('I 0.3')], [out({ k: 'ret' })]);
    const n = net([a, p], [q, t]);
    const r = networkToAwl(n, { tempEnd: 20, firstLabel: 1 });
    const pb = (p as Extract<LadElem, { k: 'parallel' }>).branches;
    expect(r.lines).toEqual(
      [
        a.id, // A I 0.0
        p.id, // A(
        pb[0]![0]!.id, // O I 0.1
        pb[1]![0]!.id, // O I 0.2
        p.id, // )
        n.root.id, // = L 20.0
        q.id, // A L 20.0
        q.id, // = Q 4.0
        t.id, // A L 20.0
        t.series[0]!.id, // A I 0.3
        t.outs[0]!.id, // SAVE
        t.outs[0]!.id, // BEC
      ].map((elemId, line) => ({ line, elemId })),
    );
  });
});
