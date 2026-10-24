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

  it('UC SFB → NON_SIMULATA_2B', () => {
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
    for (const t of ['\tUC SFB 4;'] as const) {
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

describe('parola di stato nei richiami e a fine blocco', () => {
  const stw = (r: { regs: { stw: object } }) => r.regs.stw;

  it('dopo il ritorno la parola di stato è quella di fine blocco (/FC = 0)', () => {
    // Il richiamato termina con /FC = 1 (A M 0.0): il chiamante riparte da una catena nuova.
    const FC7: BlockSpec = { kind: 'FC', number: 7, networks: ['\tA M 0.0;'] };
    const p = buildProgram([ob('\tSET;\n\tUC FC 7;\n\tA M 2.0;\n\t= M 2.1;'), FC7]);
    for (const x of [0, 1]) {
      const r = runProgram(p, { setup: (mem) => (mem.M[2] = x) });
      expect(r.mem.M[2]! >> 1).toBe(x);
    }
    const r = runProgram(p);
    expect(stw(r)).toMatchObject({ os: false });
  });

  it('BE, BEU e BEC (che termina) lasciano OS = OR = 0, STA = 1, /FC = 0 e RLO/BR invariati', () => {
    for (const end of ['BE', 'BEU', 'BEC']) {
      const FC8: BlockSpec = { kind: 'FC', number: 8, networks: [`\tCLR;\n\tSET;\n\t${end};`] };
      const p = buildProgram([ob('\tUC FC 8;'), FC8]);
      const r = runProgram(p, { regs: { stw: { os: true, br: true } } });
      expect(stw(r)).toMatchObject({ os: false, or: false, sta: true, fc: false, rlo: true });
    }
  });

  it('CC con RLO 0: non chiama e imposta OR 0, STA 1, RLO 1, /FC 0', () => {
    const FC9: BlockSpec = { kind: 'FC', number: 9, networks: ['\tSET;\n\t= M 3.0;'] };
    const p = buildProgram([ob('\tCLR;\n\tCC FC 9;'), FC9]);
    const r = runProgram(p);
    expect(r.mem.M[3]).toBe(0);
    expect(stw(r)).toMatchObject({ or: false, sta: true, rlo: true, fc: false, os: false });
  });

  it('CC con RLO 1: chiama', () => {
    const FC9: BlockSpec = { kind: 'FC', number: 9, networks: ['\tSET;\n\t= M 3.0;'] };
    const p = buildProgram([ob('\tSET;\n\tCC FC 9;'), FC9]);
    expect(runProgram(p).mem.M[3]).toBe(1);
  });

  it('BEC con RLO 0 continua con OR 0, STA 1, RLO 1, /FC 0 e BR invariato', () => {
    const FC4: BlockSpec = {
      kind: 'FC',
      number: 4,
      networks: ['\tCLR;\n\tBEC;\n\t= M 4.0;'],
    };
    const p = buildProgram([ob('\tUC FC 4;'), FC4]);
    const r = runProgram(p, { regs: { stw: { br: true } } });
    expect(r.mem.M[4]).toBe(1); // RLO = 1 dopo BEC non eseguita
    expect(r.regs.stw.br).toBe(true);
  });
});

describe('profondità dei blocchi e richiamo indiretto', () => {
  const chain = (n: number): ReturnType<typeof buildProgram> => {
    const specs: BlockSpec[] = [ob('\tUC FC 1;')];
    for (let i = 1; i <= n; i++)
      specs.push({
        kind: 'FC',
        number: i,
        networks: [i < n ? `\tUC FC ${i + 1};` : '\tSET;\n\t= M 0.0;'],
      });
    return buildProgram(specs);
  };

  it('16 FC annidate (OB = profondità 0) riescono, 17 danno STACK_BLOCCHI_PIENO', () => {
    expect(runProgram(chain(16)).mem.M[0]).toBe(1);
    expect(errorOf(() => runProgram(chain(17))).code).toBe('STACK_BLOCCHI_PIENO');
  });

  it('UC FC [MW n]: il numero viene dalla memoria', () => {
    const FC3: BlockSpec = { kind: 'FC', number: 3, networks: ['\tSET;\n\t= M 9.0;'] };
    const p = buildProgram([ob('\tNOP 0;'), FC3]);
    // fb 30 aaaa 70 0b 00 02 = UC FC [MW 2]; 65 00 = BE.
    p.put({
      kind: 'OB',
      number: 1,
      code: Uint8Array.from([0xfb, 0x30, 0x00, 0x02, 0x70, 0x0b, 0x00, 0x02, 0x65, 0x00]),
      localBytes: 0,
      networkStarts: [0],
    });
    const r = runProgram(p, { setup: (mem) => setWord(mem, 2, 3) });
    expect(r.mem.M[9]).toBe(1);
    expect(errorOf(() => runProgram(p, { setup: (mem) => setWord(mem, 2, 4) })).code).toBe(
      'BLOCCO_NON_CARICATO',
    );
  });
});
