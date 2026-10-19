import { describe, expect, it } from 'vitest';
import {
  AREA_MNEMONICS,
  INSTRUCTIONS,
  STATUS_CONDITIONS,
  findInstruction,
  type InstructionCategory,
} from '../src';

const byId = (id: string) => INSTRUCTIONS.find((i) => i.id === id);

describe('tabella delle istruzioni', () => {
  it('ogni istruzione ha id unico, mnemonico tedesco e almeno una classe di operando', () => {
    expect(new Set(INSTRUCTIONS.map((i) => i.id)).size).toBe(INSTRUCTIONS.length);
    expect(new Set(INSTRUCTIONS.map((i) => i.german)).size).toBe(INSTRUCTIONS.length);
    for (const i of INSTRUCTIONS) {
      expect(i.german).not.toBe('');
      expect(i.operands.length).toBeGreaterThan(0);
    }
  });

  it('coppie note internazionale/tedesco', () => {
    const g = (id: string) => byId(id)!.german;
    expect(
      [
        'A',
        'AN',
        'A(',
        'JU',
        'JC',
        'JCN',
        'SP',
        'SE',
        'SD',
        'SF',
        'CU',
        'CD',
        'OPN',
        'CDB',
        'BEU',
        'CAW',
        'CAR',
        'AW',
        'AD',
        'BEC',
        'SS',
        'JUO',
        'JOS',
        'JNBI',
        'CAD',
      ].map(g),
    ).toEqual([
      'U',
      'UN',
      'U(',
      'SPA',
      'SPB',
      'SPBN',
      'SI',
      'SV',
      'SE',
      'SA',
      'ZV',
      'ZR',
      'AUF',
      'TDB',
      'BEA',
      'TAW',
      'TAR',
      'UW',
      'UD',
      'BEB',
      'SS',
      'SPU',
      'SPS',
      'SPBIN',
      'TAD',
    ]);
  });

  it('findInstruction non distingue maiuscole e rispetta il mnemonico', () => {
    expect(findInstruction('a', 'international')?.id).toBe('A');
    expect(findInstruction('u', 'german')?.id).toBe('A');
    expect(findInstruction('U', 'international')).toBeUndefined();
    expect(findInstruction('SE', 'international')?.id).toBe('SE');
    expect(findInstruction('SE', 'german')?.id).toBe('SD');
    expect(findInstruction('sv', 'german')?.id).toBe('SE');
  });

  it('findInstruction non cade nelle chiavi del prototipo', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(findInstruction(k, 'international')).toBeUndefined();
      expect(findInstruction(k, 'german')).toBeUndefined();
    }
  });

  it('simboli e istruzioni speciali', () => {
    for (const id of [
      '==I',
      '<=R',
      'A(',
      ')',
      '=',
      '+',
      '+AR1',
      'MCR(',
      ')MCR',
      'RND+',
      'RND-',
      'NOP',
    ]) {
      expect(byId(id), id).toBeDefined();
      expect(findInstruction(id, 'international')?.id).toBe(id);
    }
    expect(byId('BEC')?.german).toBe('BEB');
    expect(byId('BEB')).toBeUndefined();
    // ENT e LEAVE non esistono sull'S7-300 (solo CPU a quattro ACCU)
    expect(byId('ENT')).toBeUndefined();
    expect(byId('LEAVE')).toBeUndefined();
  });

  it('classi di operando, parentesi e fine blocco', () => {
    expect(byId('A')?.operands).toEqual(expect.arrayContaining(['bit', 'status']));
    expect(byId('O')?.operands).toEqual(expect.arrayContaining(['bit', 'status', 'none']));
    expect(byId('S')?.operands).toEqual(expect.arrayContaining(['bit', 'timer', 'counter']));
    expect(byId('L')?.operands).toContain('loadSource');
    expect(byId('T')?.operands).toContain('transferTarget');
    expect(byId('SD')?.operands).toEqual(['timer']);
    expect(byId('CU')?.operands).toEqual(['counter']);
    expect(byId('FR')?.operands).toEqual(expect.arrayContaining(['timer', 'counter']));
    expect(byId('NOP')?.operands).toEqual(['nopValue']);
    expect(byId('JU')?.operands).toEqual(['label']);
    expect(byId('LAR1')?.operands).toEqual(expect.arrayContaining(['none', 'pointerOrDword']));
    expect(byId('TAR1')?.operands).toEqual(expect.arrayContaining(['none', 'dwordLocation']));
    expect(byId('SLW')?.operands).toEqual(expect.arrayContaining(['none', 'shiftCount']));
    expect(byId('INC')?.operands).toEqual(['byteConstant']);
    expect(byId('TAK')?.operands).toEqual(['none']);
    const open = INSTRUCTIONS.filter((i) => i.opensBracket).map((i) => i.id);
    expect(open.sort()).toEqual(['A(', 'AN(', 'O(', 'ON(', 'X(', 'XN(']);
    expect(INSTRUCTIONS.filter((i) => i.closesBracket).map((i) => i.id)).toEqual([')']);
    expect(byId('BE')?.endsBlock).toBe('always');
    expect(byId('BEU')?.endsBlock).toBe('always');
    expect(byId('BEC')?.endsBlock).toBe('conditional');
  });

  it('copre tutte le categorie della tabella del piano', () => {
    const cats: InstructionCategory[] = [
      'bitLogic',
      'comparison',
      'conversion',
      'counter',
      'db',
      'jump',
      'integer',
      'float',
      'loadTransfer',
      'control',
      'shift',
      'timer',
      'wordLogic',
      'accumulator',
    ];
    for (const c of cats) {
      expect(INSTRUCTIONS.filter((i) => i.category === c).length, c).toBeGreaterThan(0);
    }
    expect(INSTRUCTIONS.filter((i) => i.category === 'comparison')).toHaveLength(18);
    expect(INSTRUCTIONS.filter((i) => i.category === 'jump')).toHaveLength(18);
    expect(INSTRUCTIONS.length).toBeGreaterThanOrEqual(150);
  });
});

describe('aree e condizioni di stato', () => {
  it('prefissi di area internazionali e tedeschi, anche con dimensione', () => {
    const a = (k: string) => AREA_MNEMONICS.get(k);
    expect(a('I')).toEqual({ international: 'I', german: 'E' });
    expect(a('E')).toEqual({ international: 'I', german: 'E' });
    expect(a('QW')).toEqual({ international: 'QW', german: 'AW' });
    expect(a('PIB')).toEqual({ international: 'PIB', german: 'PEB' });
    expect(a('PQD')).toEqual({ international: 'PQD', german: 'PAD' });
    expect(a('C')).toEqual({ international: 'C', german: 'Z' });
    expect(a('MW')).toEqual({ international: 'MW', german: 'MW' });
    expect(a('DBX')).toEqual({ international: 'DBX', german: 'DBX' });
    expect(a('constructor')).toBeUndefined();
  });

  it('condizioni di stato', () => {
    expect(STATUS_CONDITIONS.map((s) => s.international)).toEqual([
      '==0',
      '<>0',
      '>0',
      '<0',
      '>=0',
      '<=0',
      'OV',
      'OS',
      'UO',
      'BR',
    ]);
    expect(STATUS_CONDITIONS.find((s) => s.international === 'BR')?.german).toBe('BIE');
  });
});
