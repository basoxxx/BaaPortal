import { describe, expect, it } from 'vitest';
import { networkToAwl, validateNetwork } from '../src/index.js';
import type { BoxKind, LadBox, LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';

const c = (id: string, op = 'I 0.0'): LadElem => ({ id, k: 'contact', neg: false, op });
const coil = (id: string, op = 'Q 4.0'): LadOut => ({ id, k: 'coil', op });
const net = (series: LadElem[], outs: (LadOut | LadNode)[], label?: string): LadNetwork => ({
  root: { id: 'root', series, outs },
  ...(label === undefined ? {} : { label }),
});

describe('validateNetwork', () => {
  it('rete completa: nessuna diagnostica', () => {
    expect(validateNetwork(net([c('a')], [coil('q')], 'M1'))).toEqual([]);
  });

  it('NO_OUTPUT: nodo senza uscite, anche in un ramo a T', () => {
    expect(validateNetwork(net([c('a')], []))).toEqual([{ elemId: 'root', code: 'NO_OUTPUT' }]);
    const t: LadNode = { id: 't', series: [c('b')], outs: [] };
    expect(validateNetwork(net([c('a')], [coil('q'), t]))).toEqual([
      { elemId: 't', code: 'NO_OUTPUT' },
    ]);
  });

  it('EMPTY_OPERAND: contatto, confronto, bobine, temporizzatore e salto senza operando', () => {
    const diags = validateNetwork(
      net(
        [c('a', ''), { id: 'k', k: 'cmp', fn: '>I', in1: 'MW 10', in2: '' }],
        [
          coil('q', ''),
          { id: 't', k: 'tcoil', fn: 'SD', timer: 'T 1', value: '' },
          { id: 'z', k: 'ccoil', fn: 'CU', counter: 'C 1', value: '' },
          { id: 'j', k: 'jmp', label: '' },
        ],
      ),
    );
    expect(diags).toEqual([
      { elemId: 'a', code: 'EMPTY_OPERAND' },
      { elemId: 'k', code: 'EMPTY_OPERAND' },
      { elemId: 'q', code: 'EMPTY_OPERAND' },
      { elemId: 't', code: 'EMPTY_OPERAND' },
      { elemId: 'j', code: 'EMPTY_OPERAND' },
    ]);
  });

  it('EMPTY_BRANCH: ramo parallelo vuoto', () => {
    const p: LadElem = { id: 'p', k: 'parallel', branches: [[c('a')], []] };
    expect(validateNetwork(net([p], [coil('q')]))).toEqual([
      { elemId: 'p', code: 'EMPTY_BRANCH', params: { branch: '2' } },
    ]);
    // il numero è 1-based anche per il primo ramo
    const first: LadElem = { id: 'p', k: 'parallel', branches: [[], [c('a')]] };
    expect(validateNetwork(net([first], [coil('q')]))).toEqual([
      { elemId: 'p', code: 'EMPTY_BRANCH', params: { branch: '1' } },
    ]);
  });

  it('MIDLINE_ON_RAIL: (#) primo sulla barra o all’apertura di un ramo', () => {
    const m: LadElem = { id: 'm', k: 'midline', op: 'M 0.0' };
    expect(validateNetwork(net([m, c('a')], [coil('q')]))).toEqual([
      { elemId: 'm', code: 'MIDLINE_ON_RAIL' },
    ]);
    const p: LadElem = { id: 'p', k: 'parallel', branches: [[c('a')], [m, c('b')]] };
    expect(validateNetwork(net([p], [coil('q')]))).toEqual([
      { elemId: 'm', code: 'MIDLINE_ON_RAIL' },
    ]);
  });

  it('RET_ON_RAIL: RET senza logica davanti', () => {
    expect(validateNetwork(net([], [{ id: 'r', k: 'ret' }]))).toEqual([
      { elemId: 'r', code: 'RET_ON_RAIL' },
    ]);
    // in un ramo a T la logica davanti è quella del nodo
    const t: LadNode = { id: 't', series: [], outs: [{ id: 'r', k: 'ret' }] };
    expect(validateNetwork(net([c('a')], [coil('q'), t]))).toEqual([]);
  });

  it('EDGE_ON_RAIL: fronte senza logica davanti', () => {
    const e: LadElem = { id: 'e', k: 'edge', dir: 'P', mem: 'M 0.0' };
    expect(validateNetwork(net([e], [coil('q')]))).toEqual([{ elemId: 'e', code: 'EDGE_ON_RAIL' }]);
    const p: LadElem = { id: 'p', k: 'parallel', branches: [[c('a')], [e]] };
    expect(validateNetwork(net([p], [coil('q')]))).toEqual([{ elemId: 'e', code: 'EDGE_ON_RAIL' }]);
  });

  it('NOT_ON_RAIL: NOT senza logica davanti', () => {
    const n: LadElem = { id: 'n', k: 'not' };
    expect(validateNetwork(net([n, c('a')], [coil('q')]))).toEqual([
      { elemId: 'n', code: 'NOT_ON_RAIL' },
    ]);
  });

  it('FLOW_IN_BRANCH: NOT, (#) o fronte in un ramo parallelo con logica davanti', () => {
    const n: LadElem = { id: 'n', k: 'not' };
    const p: LadElem = { id: 'p', k: 'parallel', branches: [[c('a')], [c('b'), n]] };
    expect(validateNetwork(net([c('x'), p], [coil('q')]))).toEqual([
      { elemId: 'n', code: 'FLOW_IN_BRANCH' },
    ]);
    // sulla barra il ramo parte dalla barra: ammesso
    expect(validateNetwork(net([p], [coil('q')]))).toEqual([]);
    // dopo il nodo di un ramo a T la logica davanti esiste sempre
    const t: LadNode = { id: 't', series: [p], outs: [coil('q2')] };
    expect(validateNetwork(net([c('x')], [coil('q'), t]))).toEqual([
      { elemId: 'n', code: 'FLOW_IN_BRANCH' },
    ]);
  });

  it('MUST_BE_ALONE: OPN, )MCR, MCRA, MCRD solo come unica uscita sulla barra', () => {
    const kinds = ['opn', 'mcrClose', 'mcra', 'mcrd'] as const;
    for (const k of kinds) {
      const o = (k === 'opn' ? { id: 'o', k, db: 'DB 1' } : { id: 'o', k }) as LadOut;
      expect(validateNetwork(net([], [o]))).toEqual([]);
      expect(validateNetwork(net([c('a')], [o]))).toEqual([{ elemId: 'o', code: 'MUST_BE_ALONE' }]);
      expect(validateNetwork(net([], [o, coil('q')]))).toEqual([
        { elemId: 'o', code: 'MUST_BE_ALONE' },
      ]);
      const t: LadNode = { id: 't', series: [], outs: [o] };
      expect(validateNetwork(net([], [t, coil('q')]))).toEqual([
        { elemId: 'o', code: 'MUST_BE_ALONE' },
      ]);
    }
  });

  it('BAD_LABEL: etichetta del segmento o del salto non valida', () => {
    for (const label of ['1AB', 'ABCDE', '_001', 'A-B'])
      expect(validateNetwork(net([c('a')], [coil('q')], label))).toEqual([
        { elemId: 'root', code: 'BAD_LABEL', params: { label } },
      ]);
    for (const label of ['M', 'm001', 'Ab9z', ' M1 ', ''])
      expect(validateNetwork(net([c('a')], [coil('q')], label))).toEqual([]);
    expect(validateNetwork(net([c('a')], [{ id: 'j', k: 'jmp', label: '_001' }]))).toEqual([
      { elemId: 'j', code: 'BAD_LABEL', params: { label: '_001' } },
    ]);
  });
});

const box = (
  id: string,
  kind: BoxKind,
  instance = '',
  pins: Record<string, string> = {},
  boolPins: Record<string, LadElem[]> = {},
): LadBox => ({ id, k: 'box', box: kind, instance, pins, boolPins });
const move = (id: string) => box(id, 'MOVE', '', { IN: 'MW 10', OUT: 'MW 12' });

describe('validateNetwork: box', () => {
  it('un box alla fine della serie basta come uscita', () => {
    expect(validateNetwork(net([c('a'), move('m')], []))).toEqual([]);
    const t: LadNode = { id: 't', series: [move('m')], outs: [] };
    expect(validateNetwork(net([c('a')], [coil('q'), t]))).toEqual([]);
    expect(validateNetwork(net([move('m'), c('a')], []))).toEqual([
      { elemId: 'root', code: 'NO_OUTPUT' },
    ]);
  });

  it('BOX_IN_PARALLEL: box in un ramo parallelo, anche annidato; BOX_IN_PIN nella logica di un pin', () => {
    const p: LadElem = { id: 'p', k: 'parallel', branches: [[c('a')], [move('m')]] };
    expect(validateNetwork(net([p], [coil('q')]))).toEqual([
      { elemId: 'm', code: 'BOX_IN_PARALLEL' },
    ]);
    const inner: LadElem = { id: 'p2', k: 'parallel', branches: [[move('m2')], [c('b')]] };
    const outer: LadElem = { id: 'p1', k: 'parallel', branches: [[c('a'), inner], [c('d')]] };
    expect(validateNetwork(net([outer], [coil('q')]))).toEqual([
      { elemId: 'm2', code: 'BOX_IN_PARALLEL' },
    ]);
    const sr = box('s', 'SR', 'M 0.0', {}, { R: [c('a'), move('m3')] });
    expect(validateNetwork(net([c('b'), sr], []))).toEqual([{ elemId: 'm3', code: 'BOX_IN_PIN' }]);
    // anche dentro un parallelo della logica del pin
    const pp: LadElem = { id: 'pp', k: 'parallel', branches: [[c('e')], [move('m4')]] };
    const call = box('k', 'CALL', 'FC 1', {}, { START: [pp] });
    expect(validateNetwork(net([c('b'), call], []))).toEqual([
      { elemId: 'm4', code: 'BOX_IN_PIN' },
    ]);
  });

  it('BOX_IN_TBRANCH: in un ramo a T il box sta solo all’inizio della serie', () => {
    const t: LadNode = { id: 't', series: [c('b'), move('m')], outs: [coil('q2')] };
    expect(validateNetwork(net([c('a')], [coil('q'), t]))).toEqual([
      { elemId: 'm', code: 'BOX_IN_TBRANCH' },
    ]);
    const ok: LadNode = { id: 't', series: [move('m'), c('b')], outs: [coil('q2')] };
    expect(validateNetwork(net([c('a')], [coil('q'), ok]))).toEqual([]);
  });

  it('BAD_INSTANCE: istanza vuota o di forma sbagliata', () => {
    const cases: [BoxKind, string, boolean][] = [
      ['S_ODT', 'T 1', true],
      ['S_ODT', 'T1', true],
      ['S_ODT', '"Ritardo"', true],
      ['S_ODT', '', false],
      ['S_ODT', 'C 1', false],
      ['S_CU', 'C 10', true],
      ['S_CU', 'T 10', false],
      ['SR', 'M 0.0', true],
      ['SR', 'DB10.DBX 2.0', true],
      ['SR', '#Bit', true],
      ['SR', 'MW 0', false],
      ['SR', 'M 0.8', false],
      ['CALL', 'FC 1', true],
      ['CALL', 'SFC 46', true],
      ['CALL', 'FB 1, DB 1', true],
      ['CALL', '"Nastro", "Nastro_DB"', true],
      ['CALL', '#Motore', true],
      ['CALL', 'FB 1', false],
      // FB trascinato dall'albero senza DB di istanza: `"Nome", ` con il DB vuoto
      ['CALL', '"Nastro", ', false],
      ['CALL', 'DB 1', false],
      ['CALL', '', false],
      // la forma con % che scrive formatNetwork
      ['S_ODT', '%T1', true],
      ['S_CU', '%C1', true],
      ['SR', '%M0.0', true],
      ['SR', '%DB10.%DBX2.0', true],
      ['CALL', '%FC1', true],
      ['CALL', '%FB1, %DB1', true],
      ['CALL', '%SFC46', true],
      ['CALL', '%%FC1', false],
    ];
    for (const [kind, instance, ok] of cases) {
      const b = box('b', kind, instance, { TV: 'S5T#1S' });
      expect(validateNetwork(net([c('a'), b], []))).toEqual(
        ok ? [] : [{ elemId: 'b', code: 'BAD_INSTANCE' }],
      );
    }
    // i box che non hanno istanza non la guardano
    const m = { ...move('m'), instance: 'xyz' };
    expect(validateNetwork(net([c('a'), m], []))).toEqual([]);
  });

  it('EMPTY_OPERAND sui pin di dati obbligatori, con il nome del pin', () => {
    const add = box('b', 'ADD_I', '', { IN1: 'MW 0', IN2: '', OUT: ' ' });
    expect(validateNetwork(net([c('a'), add], []))).toEqual([
      { elemId: 'b', code: 'EMPTY_OPERAND', params: { pin: 'IN2' } },
      { elemId: 'b', code: 'EMPTY_OPERAND', params: { pin: 'OUT' } },
    ]);
    expect(validateNetwork(net([c('a'), box('t', 'S_ODT', 'T 1')], []))).toEqual([
      { elemId: 't', code: 'EMPTY_OPERAND', params: { pin: 'TV' } },
    ]);
    // PV serve solo se il pin S ha logica; BI, BCD, CV e i pin di una CALL sono facoltativi
    expect(validateNetwork(net([c('a'), box('z', 'S_CU', 'C 1')], []))).toEqual([]);
    expect(
      validateNetwork(net([c('a'), box('z', 'S_CU', 'C 1', {}, { S: [c('s')] })], [])),
    ).toEqual([{ elemId: 'z', code: 'EMPTY_OPERAND', params: { pin: 'PV' } }]);
    expect(validateNetwork(net([c('a'), box('k', 'CALL', 'FC 1', { IN1: '' })], []))).toEqual([]);
  });

  it('la logica dei pin BOOL parte dalla barra: NOT davanti è un errore', () => {
    const sr = box('s', 'SR', 'M 0.0', {}, { R: [{ id: 'n', k: 'not' }, c('b')] });
    expect(validateNetwork(net([c('a'), sr], []))).toEqual([{ elemId: 'n', code: 'NOT_ON_RAIL' }]);
  });
});

describe('networkToAwl con errori', () => {
  it('non dà AWL parziale', () => {
    const r = networkToAwl(net([c('a', ''), c('b')], [coil('q')]), { tempEnd: 20, firstLabel: 3 });
    expect(r).toEqual({
      source: '',
      lines: [],
      diagnostics: [{ elemId: 'a', code: 'EMPTY_OPERAND' }],
      nextLabel: 3,
    });
  });
});
