import { describe, expect, it } from 'vitest';
import type { DecodedStatement } from '@baaportal/mc7';
import { SimError, SimMemory, memorySizesFor, newRegisters, stwToWord } from '../src';
import type { ExecState } from '../src/executor';
import { OPS } from '../src/ops';
import { runAwl } from './helpers';

const prog = (...lines: string[]): string[] => [lines.map((l) => `\t${l};`).join('\n')];
const errorOf = (fn: () => unknown): SimError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e;
    throw e;
  }
  throw new Error('nessun errore');
};
const openDb = (m: SimMemory, n: number, len: number): void => {
  m.dbs.set(n, { data: new Uint8Array(len), initial: new Uint8Array(len), retentive: false });
};

describe('L e T', () => {
  it('L MW10 / L MW12: ACCU2 = vecchio ACCU1', () => {
    // Manuale AWL, «L»: il contenuto di ACCU1 passa in ACCU2, poi si carica; parola a zero esteso.
    const r = runAwl(prog('L %MW10', 'L %MW12'), {
      setup: (m) => m.M.set([0x12, 0x34, 0xab, 0xcd], 10),
    });
    expect(r.regs.accu1).toBe(0xabcd);
    expect(r.regs.accu2).toBe(0x1234);
    // L non tocca la parola di stato
    expect(stwToWord(r.regs.stw)).toBe(0);
  });

  it('L B#16#FF estende con zeri', () => {
    // Manuale AWL, «L»: i byte e le parole si caricano nella parte bassa, il resto è zero.
    const r = runAwl(prog('L B#16#FF'), { regs: { accu1: 0xffffffff } });
    expect(r.regs.accu1).toBe(0xff);
    expect(r.regs.accu2).toBe(0xffffffff);
  });

  it('L di costanti: INT, DINT, REAL, puntatore', () => {
    const r = runAwl(prog('L 5', 'L L#-5', 'L 2.5', 'L P#M 10.0'));
    expect(r.regs.accu1).toBe(0x83000050);
    expect(r.regs.accu2).toBe(0x40200000);
    expect(runAwl(prog('L L#-5')).regs.accu1).toBe(0xfffffffb);
    expect(runAwl(prog('L 5')).regs.accu1).toBe(5);
  });

  it('T MB su ACCU1 = 0x12345678 scrive 0x78', () => {
    // Manuale AWL, «T»: scrive la parte bassa dell'ACCU1 (byte, parola o doppia parola).
    const r = runAwl(prog('L DW#16#12345678', 'T %MB0', 'T %MW2', 'T %MD4'));
    expect([...r.mem.M.slice(0, 8)]).toEqual([0x78, 0, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78]);
    // T non cambia gli accumulatori
    expect(r.regs.accu1).toBe(0x12345678);
  });

  it('T con MCR spento scrive 0', () => {
    const r = runAwl(prog('MCRA', 'CLR', 'MCR(', 'L B#16#FF', 'T %MB0', ')MCR'), {
      setup: (m) => (m.M[0] = 0x55),
    });
    expect(r.mem.M[0]).toBe(0);
  });

  it('L T / T C → NON_SIMULATA_2B', () => {
    expect(errorOf(() => runAwl(prog('L T 3'))).code).toBe('NON_SIMULATA_2B');
    expect(errorOf(() => runAwl(prog('L C 3'))).code).toBe('NON_SIMULATA_2B');
  });

  it('L STW / T STW andata e ritorno; /FC non scritto', () => {
    // Manuale AWL, «L STW» e «T STW»: bit 0 /FC … bit 8 BR; T STW non scrive /FC.
    const r = runAwl(prog('SET', 'L STW'));
    // SET: RLO = 1, STA = 1, /FC = 0
    expect(r.regs.accu1).toBe(0b000000110);
    const w = runAwl(prog('L W#16#01FF', 'T STW'));
    expect(w.regs.stw).toMatchObject({
      fc: false,
      rlo: true,
      sta: true,
      or: true,
      os: true,
      ov: true,
      cc0: true,
      cc1: true,
      br: true,
    });
    const w2 = runAwl(prog('L W#16#0000', 'T STW'), { regs: { stw: { fc: true, rlo: true } } });
    expect(w2.regs.stw.fc).toBe(true);
    expect(w2.regs.stw.rlo).toBe(false);
  });

  it('OPN DB 5 / L DBLG / L DBNO', () => {
    // Manuale AWL, «OPN», «L DBLG», «L DBNO», «L DILG», «L DINO».
    const r = runAwl(prog('OPN DB 5', 'OPN DI 6', 'L DBLG', 'L DBNO', 'L DILG', 'L DINO'), {
      setup: (m) => {
        openDb(m, 5, 20);
        openDb(m, 6, 12);
      },
    });
    expect(r.regs.db).toBe(5);
    expect(r.regs.di).toBe(6);
    expect(r.regs.accu1).toBe(6);
    expect(r.regs.accu2).toBe(12);
    const r2 = runAwl(prog('OPN DB 5', 'L DBLG', 'L DBNO'), { setup: (m) => openDb(m, 5, 20) });
    expect(r2.regs.accu1).toBe(5);
    expect(r2.regs.accu2).toBe(20);
    // registri chiusi: lunghezza 0
    expect(runAwl(prog('L DBLG')).regs.accu1).toBe(0);
  });

  it('CDB', () => {
    // Manuale AWL, «CDB»: scambia DB e DI.
    const r = runAwl(prog('OPN DB 5', 'OPN DI 6', 'CDB'), {
      setup: (m) => {
        openDb(m, 5, 4);
        openDb(m, 6, 4);
      },
    });
    expect(r.regs.db).toBe(6);
    expect(r.regs.di).toBe(5);
  });

  it('OPN DB non caricato → DB_NON_CARICATO', () => {
    expect(errorOf(() => runAwl(prog('OPN DB 9'))).code).toBe('DB_NON_CARICATO');
  });

  it('L e T su DB aperto', () => {
    const r = runAwl(prog('OPN DB 5', 'L DW#16#01020304', 'T DBD 2', 'L DBB 3'), {
      setup: (m) => openDb(m, 5, 8),
    });
    expect(r.regs.accu1).toBe(2);
    expect([...r.mem.dbs.get(5)!.data.slice(2, 6)]).toEqual([1, 2, 3, 4]);
  });
});

describe('accumulatori e registri di indirizzo', () => {
  it('TAK, PUSH, POP su 2 accumulatori', () => {
    // Manuale AWL, «TAK», «PUSH», «POP» (S7-300: due accumulatori).
    const tak = runAwl(prog('TAK'), { regs: { accu1: 1, accu2: 2 } });
    expect([tak.regs.accu1, tak.regs.accu2]).toEqual([2, 1]);
    const push = runAwl(prog('PUSH'), { regs: { accu1: 1, accu2: 2 } });
    expect([push.regs.accu1, push.regs.accu2]).toEqual([1, 1]);
    const pop = runAwl(prog('POP'), { regs: { accu1: 1, accu2: 2 } });
    expect([pop.regs.accu1, pop.regs.accu2]).toEqual([2, 2]);
  });

  it('ENT → ISTRUZIONE_NON_S7300', () => {
    expect(errorOf(() => runAwl(prog('ENT'))).code).toBe('ISTRUZIONE_NON_S7300');
    expect(errorOf(() => runAwl(prog('LEAVE'))).code).toBe('ISTRUZIONE_NON_S7300');
  });

  it('INC/DEC agiscono solo su ACCU1-LL senza riporto', () => {
    // Manuale AWL, «INC», «DEC»: solo ACCU1-LL, senza riporto, parola di stato invariata.
    const inc = runAwl(prog('INC 1'), { regs: { accu1: 0x1234ffff } });
    expect(inc.regs.accu1).toBe(0x12340000 + 0xff00 + 0x00);
    const dec = runAwl(prog('DEC 3'), { regs: { accu1: 0x12340001 } });
    expect(dec.regs.accu1).toBe(0x123400fe);
    expect(stwToWord(inc.regs.stw)).toBe(0);
  });

  it('LAR1 P#M 10.0 / L [AR1,P#2.0]', () => {
    // Manuale AWL, «LAR1», «Indirizzamento indiretto da registro»: area M, byte 10 + 2.
    const r = runAwl(prog('LAR1 P#M 10.0', 'L B [AR1,P#2.0]', 'L MB [AR1,P#3.0]'), {
      setup: (m) => ((m.M[12] = 0x7b), (m.M[13] = 0x2c)),
    });
    expect(r.regs.ar1).toBe(0x83000050);
    expect(r.regs.accu1).toBe(0x2c);
    expect(r.regs.accu2).toBe(0x7b);
  });

  it('LAR/TAR da ACCU1, memoria e CAR', () => {
    const r = runAwl(prog('L DW#16#00000040', 'LAR1', 'LAR2 P#M 1.0', 'CAR', 'TAR1', 'TAR2 %MD0'), {
      setup: () => undefined,
    });
    expect(r.regs.ar1).toBe(0x83000008);
    expect(r.regs.ar2).toBe(0x40);
    expect(r.regs.accu1).toBe(0x83000008);
    expect([...r.mem.M.slice(0, 4)]).toEqual([0, 0, 0, 0x40]);
    const m = runAwl(prog('LAR1 %MD0', 'TAR1 AR2', 'LAR2 %MD0', 'TAR2'), {
      setup: (mem) => mem.M.set([0x83, 0, 0, 0x10]),
    });
    expect(m.regs.ar1).toBe(0x83000010);
    expect(m.regs.ar2).toBe(0x83000010);
    expect(m.regs.accu1).toBe(0x83000010);
  });

  it('+AR1 P#2.0', () => {
    // Manuale AWL, «+AR1»: somma all'indirizzo (19 bit), area e bit 31 invariati.
    const r = runAwl(prog('+AR1 P#2.0'), { regs: { ar1: 0x83000050 } });
    expect(r.regs.ar1).toBe(0x83000060);
    // senza operando: ACCU1-L con segno
    const neg = runAwl(prog('L -8', '+AR1'), { regs: { ar1: 0x83000050 } });
    expect(neg.regs.ar1).toBe(0x83000050 - 8);
    const ar2 = runAwl(prog('+AR2 P#1.0'), { regs: { ar2: 0x01 } });
    expect(ar2.regs.ar2).toBe(0x09);
    // l'offset si somma ai 24 bit bassi; area e bit 31 restano
    const wrap = runAwl(prog('L 1', '+AR1'), { regs: { ar1: 0x8307ffff } });
    expect(wrap.regs.ar1).toBe(0x83080000);
    const top = runAwl(prog('L 1', '+AR1'), { regs: { ar1: 0x83ffffff } });
    expect(top.regs.ar1).toBe(0x83000000);
  });

  it('TAR1/TAR2 senza operando: ACCU1 passa in ACCU2', () => {
    // Manuale AWL, «TAR1», «TAR2»: l'AR va in ACCU1, il vecchio ACCU1 in ACCU2.
    const r = runAwl(prog('TAR1'), { regs: { ar1: 0x83000010, accu1: 7, accu2: 9 } });
    expect([r.regs.accu1, r.regs.accu2]).toEqual([0x83000010, 7]);
    const r2 = runAwl(prog('TAR2'), { regs: { ar2: 0x20, accu1: 5 } });
    expect([r2.regs.accu1, r2.regs.accu2]).toEqual([0x20, 5]);
  });

  it('LAR1/LAR2 da memoria non a doppia parola → MC7_NON_ESEGUIBILE', () => {
    // La sintassi AWL non le compila: si prova il gestore con un'istruzione costruita a mano.
    const st = { regs: newRegisters(), mem: new SimMemory(memorySizesFor('cpu-315-2-pn-dp')) };
    const frame = { lBase: 0, prevLBase: 0 };
    for (const id of ['LAR1', 'LAR2']) {
      const stmt = {
        id,
        text: id,
        operand: { kind: 'address', area: 'M', size: 'W', byte: 0 },
      } as unknown as DecodedStatement;
      const run = (): unknown => OPS[id]!({ ...st, frame } as unknown as ExecState, stmt);
      expect(errorOf(run).code).toBe('MC7_NON_ESEGUIBILE');
    }
  });

  it('T STW non segue l MCR', () => {
    const r = runAwl(prog('MCRA', 'CLR', 'MCR(', 'L W#16#0020', 'T STW', ')MCR'));
    // T STW scrive OS (bit 5) anche con MCR spento; con zero scritto OS resterebbe 0
    expect(r.trace[4]!.stw & 0x20).toBe(0x20);
  });

  it('L DILG e L DINO, OPN DI non caricato', () => {
    const r = runAwl(prog('OPN DI 6', 'L DILG', 'L DINO'), { setup: (m) => openDb(m, 6, 12) });
    expect([r.regs.accu1, r.regs.accu2]).toEqual([6, 12]);
    expect(errorOf(() => runAwl(prog('OPN DI 9'))).code).toBe('DB_NON_CARICATO');
  });
});

describe('L di costanti, tutte le forme', () => {
  const l = (c: string): number => runAwl(prog(`L ${c}`)).regs.accu1;
  it('forme del manuale AWL, «Formato delle costanti»', () => {
    expect(l('W#16#ABCD')).toBe(0xabcd);
    expect(l('DW#16#DEADBEEF')).toBe(0xdeadbeef);
    expect(l('2#1010101010101010')).toBe(0xaaaa);
    expect(l('B#(1,2)')).toBe(0x0102);
    expect(l('B#(1,2,3,4)')).toBe(0x01020304);
    expect(l('C#123')).toBe(0x0123);
    expect(l('S5T#2S')).toBe(0x0200);
    expect(l("'A'")).toBe(0x41);
    expect(l('D#1990-01-02')).toBe(1);
    expect(l('TOD#0:0:1.5')).toBe(1500);
    expect(l('T#1S')).toBe(1000);
  });
});

describe('scorrimenti a larghezza piena', () => {
  it('SLW 16 / SRW 16: tutto fuori, CC1 = ultimo bit uscito', () => {
    const a = runAwl(prog('SLW'), { regs: { accu1: 0xaaaa0001, accu2: 16 } });
    expect(a.regs.accu1).toBe(0xaaaa0000);
    expect(a.regs.stw.cc1).toBe(true);
    const b = runAwl(prog('SRW'), { regs: { accu1: 0xbbbb8000, accu2: 16 } });
    expect(b.regs.accu1).toBe(0xbbbb0000);
    expect(b.regs.stw.cc1).toBe(true);
  });
  it('SLD 32 / SRD 32 / RLD 32', () => {
    const a = runAwl(prog('SLD'), { regs: { accu1: 1, accu2: 32 } });
    expect([a.regs.accu1, a.regs.stw.cc1]).toEqual([0, true]);
    const b = runAwl(prog('SRD'), { regs: { accu1: 0x80000000, accu2: 32 } });
    expect([b.regs.accu1, b.regs.stw.cc1]).toEqual([0, true]);
    const c = runAwl(prog('RLD'), { regs: { accu1: 0x80000001, accu2: 32 } });
    expect([c.regs.accu1, c.regs.stw.cc1]).toEqual([0x80000001, true]);
  });
});
