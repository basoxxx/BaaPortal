import { describe, expect, it } from 'vitest';
import { networkToAwl, validateNetwork } from '../src/index.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';

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
