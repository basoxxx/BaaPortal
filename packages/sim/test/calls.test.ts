import { describe, expect, it } from 'vitest';
import { Program, SimError, SimMemory, type LoadedBlock } from '../src';
import { encodeCode } from '@baaportal/mc7';
import {
  buildProgram,
  el,
  m,
  named,
  runProgram,
  sec,
  setWord,
  word,
  type BlockSpec,
} from './programHelpers';

const emptyIface = {
  input: [],
  output: [],
  inOut: [],
  static: [],
  temp: [],
  returnType: { kind: 'void' },
};
const ob = (...networks: string[]): BlockSpec => ({ kind: 'OB', number: 1, networks });

function errorOf(fn: () => unknown): SimError {
  try {
    fn();
  } catch (e) {
    return e as SimError;
  }
  throw new Error('nessun errore');
}

describe('richiami di FC', () => {
  const fc1 = sec({
    in: [m('A', el('Int'))],
    out: [m('R', el('Int'))],
    inOut: [m('IO', el('Int'))],
  });
  const FC1: BlockSpec = {
    kind: 'FC',
    number: 1,
    sections: fc1,
    networks: ['\tL #A;\n\tL 1;\n\t+I;\n\tT #R;\n\tL #IO;\n\tL #A;\n\t+I;\n\tT #IO;'],
  };

  it('OB1 chiama FC1 con IN/OUT/IN_OUT: valori giusti', () => {
    const p = buildProgram([ob('\tCALL FC 1 (A := MW 2, R => MW 4, IO := MW 6);'), FC1]);
    const r = runProgram(p, {
      setup: (mem) => {
        setWord(mem, 2, 10);
        setWord(mem, 6, 100);
      },
    });
    expect(word(r.mem, 4)).toBe(11);
    expect(word(r.mem, 6)).toBe(110);
  });

  it('FC1 passa il proprio IN a FC2', () => {
    const FC2: BlockSpec = {
      kind: 'FC',
      number: 2,
      sections: sec({ in: [m('A', el('Int'))], out: [m('R', el('Int'))] }),
      networks: ['\tL #A;\n\tL 2;\n\t*I;\n\tT #R;'],
    };
    const FCOUT: BlockSpec = {
      kind: 'FC',
      number: 3,
      sections: sec({ in: [m('A', el('Int'))], out: [m('R', el('Int'))] }),
      networks: ['\tCALL FC 2 (A := #A, R => #R);'],
    };
    const p = buildProgram([ob('\tCALL FC 3 (A := MW 2, R => MW 4);'), FCOUT, FC2]);
    const r = runProgram(p, { setup: (mem) => setWord(mem, 2, 21) });
    expect(word(r.mem, 4)).toBe(42);
  });

  it('DB aperto prima del richiamo è ripristinato al ritorno', () => {
    const FC3: BlockSpec = { kind: 'FC', number: 3, networks: ['\tOPN DB 8;'] };
    const p = buildProgram([ob('\tOPN DB 7;\n\tUC FC 3;\n\tL DBNO;\n\tT MW 0;'), FC3]);
    const r = runProgram(p, { dbs: { 7: 4, 8: 4 } });
    expect(word(r.mem, 0)).toBe(7);
    expect(r.regs.db).toBe(7);
  });

  it('BEC con RLO 0 non termina', () => {
    const FC4: BlockSpec = {
      kind: 'FC',
      number: 4,
      networks: ['\tA M 0.0;\n\tBEC;\n\tL 5;\n\tT MW 2;'],
    };
    const p = buildProgram([ob('\tUC FC 4;'), FC4]);
    expect(word(runProgram(p).mem, 2)).toBe(5);
    const r = runProgram(p, { setup: (mem) => (mem.M[0] = 1) });
    expect(word(r.mem, 2)).toBe(0);
  });

  it('richiamo di FC non caricata → BLOCCO_NON_CARICATO', () => {
    const p = buildProgram([ob('\tUC FC 77;')], {}, [
      { name: 'Mancante', kind: 'FC', number: 77, iface: emptyIface } as never,
    ]);
    expect(errorOf(() => runProgram(p)).code).toBe('BLOCCO_NON_CARICATO');
  });

  it('ricorsione oltre MAX_BLOCK_STACK → STACK_BLOCCHI_PIENO', () => {
    const FC9: BlockSpec = { kind: 'FC', number: 9, networks: ['\tUC FC 9;'] };
    const p = buildProgram([ob('\tUC FC 9;'), FC9]);
    expect(errorOf(() => runProgram(p)).code).toBe('STACK_BLOCCHI_PIENO');
  });

  it('UC SFC 20 → NON_SIMULATA_2B', () => {
    const p = buildProgram([ob('\tCALL SFC 20;')], {}, [
      { name: 'SFC20', kind: 'SFC', number: 20, iface: emptyIface } as never,
    ]);
    expect(errorOf(() => runProgram(p)).code).toBe('NON_SIMULATA_2B');
  });

  it('UC SFB e temporizzatori → NON_SIMULATA_2B', () => {
    const p = new Program();
    const put = (text: string) => {
      const r = encodeCode([text]);
      p.put({
        kind: 'OB',
        number: 1,
        code: r.mc7,
        localBytes: 0,
        networkStarts: [0],
      } as LoadedBlock);
    };
    for (const t of ['\tUC SFB 4;', '\tA M 0.0;\n\tL S5T#1S;\n\tSP T 1;'] as const) {
      put(t);
      expect(errorOf(() => runProgram(p)).code).toBe('NON_SIMULATA_2B');
    }
  });
});

describe('richiami di FB', () => {
  const fb1 = sec({ in: [m('X', el('Int'))], stat: [m('Cnt', el('Int'))] });
  const FB1: BlockSpec = {
    kind: 'FB',
    number: 1,
    sections: fb1,
    networks: ['\tL #Cnt;\n\tL #X;\n\t+I;\n\tT #Cnt;'],
  };

  it('FB1 con DI 1: statici persistono fra due chiamate', () => {
    const p = buildProgram(
      [ob('\tCALL FB 1, DB 5 (X := MW 2);\n\tCALL FB 1, DB 5 (X := MW 2);'), FB1],
      { 5: 1 },
    );
    const r = runProgram(p, { dbs: { 5: 8 }, setup: (mem) => setWord(mem, 2, 7) });
    const d = r.mem.dbs.get(5)!.data;
    expect((d[2]! << 8) | d[3]!).toBe(14);
  });

  it('multi-istanza: FB2 dentro FB1 usa AR2 + offset', () => {
    const FB2: BlockSpec = {
      kind: 'FB',
      number: 2,
      sections: sec({ stat: [m('I1', named('FB1')), m('I2', named('FB1'))] }),
      networks: [
        '\tCALL #I1 (X := 1);\n\tCALL #I2 (X := 10);\n\tCALL #I1 (X := 1);\n\tCALL #I2 (X := 10);',
      ],
    };
    const p = buildProgram([ob('\tCALL FB 2, DB 6;'), FB1, FB2], { 6: 2 });
    const r = runProgram(p, { dbs: { 6: 16 } });
    const d = r.mem.dbs.get(6)!.data;
    const w = (i: number) => (d[i]! << 8) | d[i + 1]!;
    // I1 a 0..3 (X, Cnt), I2 a 4..7.
    expect(w(2)).toBe(2);
    expect(w(6)).toBe(20);
  });
});

describe('stack di annidamento, MCR e stack L per blocco', () => {
  it('il richiamato parte con MCR inattivo; il chiamante ritrova il suo stato', () => {
    const FC5: BlockSpec = { kind: 'FC', number: 5, networks: ['\tSET;\n\t= M 1.0;'] };
    const p = buildProgram([
      ob('\tCLR;\n\tMCRA;\n\tMCR(;\n\tUC FC 5;\n\tSET;\n\t= M 1.1;\n\t)MCR;\n\tMCRD;'),
      FC5,
    ]);
    const r = runProgram(p);
    expect(r.mem.M[1]! & 1).toBe(1); // scritto dal richiamato
    expect(r.mem.M[1]! & 2).toBe(0); // nel chiamante MCR spegne la scrittura
  });

  it('lo stack di annidamento del chiamante sopravvive al richiamo', () => {
    const FC6: BlockSpec = {
      kind: 'FC',
      number: 6,
      networks: ['\tA(;\n\tO M 5.0;\n\tO M 5.1;\n\t);\n\t= M 5.2;'],
    };
    const p = buildProgram([
      ob('\tSET;\n\tA(;\n\tA M 0.0;\n\tUC FC 6;\n\tA M 0.0;\n\t);\n\t= M 1.0;'),
      FC6,
    ]);
    const r = runProgram(p, { setup: (mem) => (mem.M[0] = 1) });
    expect(r.mem.M[1]! & 1).toBe(1);
  });

  it('L fuori dalla finestra del blocco → AREA_LUNGHEZZA', () => {
    const p = new Program();
    const r = encodeCode(['\tL LD 2;']);
    p.put({ kind: 'OB', number: 1, code: r.mc7, localBytes: 4, networkStarts: [0] });
    expect(errorOf(() => runProgram(p)).code).toBe('AREA_LUNGHEZZA');
  });

  it('V nell’OB (nessun chiamante) → AREA_LUNGHEZZA', () => {
    const p = new Program();
    const r = encodeCode(['\tL P#V 0.0;\n\tLAR1;\n\tL B [AR1,P#0.0];'].map((x) => x));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    p.put({ kind: 'OB', number: 1, code: r.mc7, localBytes: 8, networkStarts: [0] });
    expect(errorOf(() => runProgram(p)).code).toBe('AREA_LUNGHEZZA');
  });

  it('stack L esaurito alla chiamata → STACK_L_PIENO', () => {
    const p = new Program();
    const call = encodeCode(['\tUC FC 1;']);
    const be = encodeCode(['\tBE;']);
    p.put({ kind: 'OB', number: 1, code: call.mc7, localBytes: 64, networkStarts: [0] });
    p.put({ kind: 'FC', number: 1, code: be.mc7, localBytes: 64, networkStarts: [0] });
    const mem = new SimMemory({ inputs: 8, outputs: 8, flags: 8, localBytes: 100 });
    expect(errorOf(() => runProgram(p, { mem })).code).toBe('STACK_L_PIENO');
  });
});
