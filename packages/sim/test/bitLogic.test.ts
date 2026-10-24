import { describe, expect, it } from 'vitest';
import { decodeInstruction } from '@baaportal/mc7';
import { SimError, wordToStw } from '../src';
import { runAwl, runCode } from './helpers';

const bit = (b: number, n: number): number => (b >> n) & 1;

describe('logica combinatoria a bit', () => {
  it('A I0.0 / A I0.1 / = Q4.0: tabella di verità completa', () => {
    // Manuale AWL, «A (AND)» e «= (assegnazione)»: Q4.0 = I0.0 AND I0.1.
    for (let i = 0; i < 4; i++) {
      const r = runAwl(['\tA %I0.0;\n\tA %I0.1;\n\t= %Q4.0;'], {
        setup: (m) => (m.I[0] = i),
      });
      expect(bit(r.mem.Q[4]!, 0)).toBe(i === 3 ? 1 : 0);
    }
  });

  it('/FC e STA dopo ogni riga di A M0.0 / ON M0.1 / = M1.0', () => {
    // Manuale AWL, «Parola di stato»: A, ON e = con /FC (/ER), RLO, STA e OR.
    const r = runAwl(['\tA %M0.0;\n\tON %M0.1;\n\t= %M1.0;'], { setup: (m) => (m.M[0] = 3) });
    const [a, on, eq] = r.trace.map((t) => wordToStw(t.stw));
    // A M0.0 (=1): inizio catena, /FC = 1, RLO = STA = 1, OR = 0
    expect(a).toMatchObject({ fc: true, rlo: true, sta: true, or: false });
    // ON M0.1 (=1): RLO = 1 OR 0 = 1; OR = 0; STA è il bit interrogato (1)
    expect(on).toMatchObject({ fc: true, rlo: true, sta: true, or: false });
    // = M1.0: fine catena, /FC = 0, RLO invariato, OR = 0
    expect(eq).toMatchObject({ fc: false, rlo: true, sta: true, or: false });
    expect(bit(r.mem.M[1]!, 0)).toBe(1);

    // M0.0 = 0, M0.1 = 1: ON dà 0, RLO = 0 e STA = 1 (bit non negato)
    const r2 = runAwl(['\tA %M0.0;\n\tON %M0.1;\n\t= %M1.0;'], { setup: (m) => (m.M[0] = 2) });
    expect(wordToStw(r2.trace[0]!.stw)).toMatchObject({ fc: true, rlo: false, sta: false });
    expect(wordToStw(r2.trace[1]!.stw)).toMatchObject({ fc: true, rlo: false, sta: true });
    expect(bit(r2.mem.M[1]!, 0)).toBe(0);
  });

  it('A( O … O … ) A …: annidamento come esempio del manuale', () => {
    // Manuale AWL, «A( (AND con apertura di parentesi)»: Q0.0 = (I0.0 OR I0.1) AND I0.2.
    const prog = ['\tA(;\n\tO %I0.0;\n\tO %I0.1;\n\t);\n\tA %I0.2;\n\t= %Q0.0;'];
    for (let i = 0; i < 8; i++) {
      const r = runAwl(prog, { setup: (m) => (m.I[0] = i) });
      const expected = (bit(i, 0) | bit(i, 1)) & bit(i, 2);
      expect(bit(r.mem.Q[0]!, 0)).toBe(expected);
    }
    // /FC e RLO dopo la chiusura
    const r = runAwl(prog, { setup: (m) => (m.I[0] = 1) });
    expect(wordToStw(r.trace[0]!.stw).fc).toBe(false); // A( riapre la catena
    expect(wordToStw(r.trace[3]!.stw)).toMatchObject({ fc: true, rlo: true });
  });

  it('A a / O b / A c = (a|b)&c, tabella completa', () => {
    // Manuale AWL, «Parola di stato» e «O»: con /FC = 1 l'O fa l'OR con l'RLO.
    const prog = ['\tA %I0.0;\n\tO %I0.1;\n\tA %I0.2;\n\t= %Q0.0;'];
    for (let i = 0; i < 8; i++) {
      const r = runAwl(prog, { setup: (m) => (m.I[0] = i) });
      expect(bit(r.mem.Q[0]!, 0)).toBe((bit(i, 0) | bit(i, 1)) & bit(i, 2));
    }
  });

  it('stato dopo `)`, O da solo, X con OR = 1 e S/R/=', () => {
    // Manuale AWL, «Parola di stato»: tabelle di O (AND prima di OR), `)`, X, S, R, =.
    const st = (r: { trace: { stw: number }[] }, k: number) => wordToStw(r.trace[k]!.stw);
    // O da solo: OR := RLO, STA = 1, /FC = 0, RLO invariato
    const o = runAwl(['\tA %I0.0;\n\tO;'], { setup: (m) => (m.I[0] = 1) });
    expect(st(o, 1)).toMatchObject({ or: true, sta: true, fc: false, rlo: true });
    // `)` dopo A(: ripristina OR dall'elemento salvato, STA = 1, /FC = 1
    const c = runAwl(['\tA %I0.0;\n\tO;\n\tA(;\n\tA %I0.1;\n\t);'], {
      setup: (m) => (m.I[0] = 1),
    });
    expect(st(c, 2)).toMatchObject({ or: false, sta: true, fc: false, rlo: true });
    expect(st(c, 4)).toMatchObject({ or: true, sta: true, fc: true, rlo: true });
    // X con OR = 1 dopo O da solo: l'X azzera OR
    const x = runAwl(['\tA %I0.0;\n\tO;\n\tX %I0.1;'], { setup: (m) => (m.I[0] = 3) });
    expect(st(x, 2)).toMatchObject({ or: false, fc: true, rlo: true, sta: true });
    // S, R e = : /FC = 0, OR = 0, RLO invariato; STA = valore scritto / RLO
    const e = runAwl(
      ['\tA %I0.0;\n\tO;\n\tS %M1.0;', '\tA %I0.0;\n\tR %M1.0;\n\tA %I0.0;\n\t= %M1.1;'],
      {
        setup: (m) => (m.I[0] = 1),
      },
    );
    expect(st(e, 2)).toMatchObject({ or: false, fc: false, rlo: true, sta: true });
    expect(st(e, 4)).toMatchObject({ or: false, fc: false, rlo: true, sta: true });
    expect(st(e, 6)).toMatchObject({ or: false, fc: false, rlo: true, sta: true });
  });

  it('operazione non implementata → SimError con offset', () => {
    // Un id senza gestore dà MC7_NON_ESEGUIBILE con blocco, offset e rete.
    let err: unknown;
    try {
      runAwl(['\tA %I0.0;\n\tL MB0;']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SimError);
    expect((err as SimError).code).toBe('MC7_NON_ESEGUIBILE');
    expect((err as SimError).detail).toBe('operazione non implementata: L');
    expect((err as SimError).offset).toBe(2);
    expect((err as SimError).network).toBe(1);
  });

  it('A I0.0 / A I0.1 / O / A I0.2 / A I0.3: AND prima di OR', () => {
    // Manuale AWL, «O (OR di blocchi AND)»: Q0.0 = (I0.0 AND I0.1) OR (I0.2 AND I0.3).
    const prog = ['\tA %I0.0;\n\tA %I0.1;\n\tO;\n\tA %I0.2;\n\tA %I0.3;\n\t= %Q0.0;'];
    for (let i = 0; i < 16; i++) {
      const r = runAwl(prog, { setup: (m) => (m.I[0] = i) });
      const expected = (bit(i, 0) & bit(i, 1)) | (bit(i, 2) & bit(i, 3));
      expect(bit(r.mem.Q[0]!, 0)).toBe(expected);
    }
  });

  it('8 parentesi aperte → STACK_ANNIDAMENTO_PIENO', () => {
    // Manuale AWL, «Stack di annidamento»: 7 livelli; l'ottavo è un errore.
    const open = (n: number): string => '\tA(;\n'.repeat(n);
    const close = (n: number): string => '\t);\n'.repeat(n);
    expect(() => runAwl([open(7) + '\tA %I0.0;\n' + close(7)])).not.toThrow();
    let err: unknown;
    try {
      runAwl([open(8) + close(8)]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SimError);
    expect((err as SimError).code).toBe('STACK_ANNIDAMENTO_PIENO');
    expect((err as SimError).block).toEqual({ kind: 'OB', number: 1 });
    expect((err as SimError).network).toBe(1);
  });

  it('X / XN', () => {
    // Manuale AWL, «X (OR esclusivo)» e «XN».
    for (let i = 0; i < 4; i++) {
      const r = runAwl(
        ['\tX %I0.0;\n\tX %I0.1;\n\t= %Q0.0;\n\tXN %I0.0;\n\tXN %I0.1;\n\t= %Q0.1;'],
        {
          setup: (m) => (m.I[0] = i),
        },
      );
      expect(bit(r.mem.Q[0]!, 0)).toBe(bit(i, 0) ^ bit(i, 1));
      // XN a ~I0.0 e ~I0.1: lo XOR di due negati è uguale allo XOR
      expect(bit(r.mem.Q[0]!, 1)).toBe(bit(i, 0) ^ bit(i, 1));
    }
    const r = runAwl(['\tXN %I0.0;\n\t= %Q0.0;'], { setup: (m) => (m.I[0] = 0) });
    expect(bit(r.mem.Q[0]!, 0)).toBe(1);
  });

  it('S e R agiscono solo con RLO 1 e non cambiano RLO', () => {
    // Manuale AWL, «S (imposta)» e «R (azzera)»: eseguiti solo con RLO = 1.
    const prog = ['\tA %I0.0;\n\tS %M1.0;\n\tA %I0.0;\n\tR %M1.1;'];
    const on = runAwl(prog, {
      setup: (m) => {
        m.I[0] = 1;
        m.M[1] = 0b10;
      },
    });
    expect(on.mem.M[1]).toBe(0b01);
    const s = wordToStw(on.trace[1]!.stw);
    expect(s).toMatchObject({ rlo: true, fc: false });
    const off = runAwl(prog, {
      setup: (m) => {
        m.I[0] = 0;
        m.M[1] = 0b10;
      },
    });
    expect(off.mem.M[1]).toBe(0b10);
    expect(wordToStw(off.trace[1]!.stw)).toMatchObject({ rlo: false, fc: false });
  });

  it('SAVE poi A BR', () => {
    // Manuale AWL, «SAVE» e «A BR»: SAVE copia RLO in BR; CLR azzera RLO.
    const r = runAwl(['\tA %I0.0;\n\tSAVE;\n\tCLR;\n\tA BR;\n\t= %Q0.0;'], {
      setup: (m) => (m.I[0] = 1),
    });
    expect(bit(r.mem.Q[0]!, 0)).toBe(1);
    expect(wordToStw(r.trace[1]!.stw)).toMatchObject({ br: true, rlo: true });
    expect(wordToStw(r.trace[2]!.stw)).toMatchObject({ rlo: false, fc: false, sta: false });
    const r0 = runAwl(['\tA %I0.0;\n\tSAVE;\n\tSET;\n\tA BR;\n\t= %Q0.0;']);
    expect(bit(r0.mem.Q[0]!, 0)).toBe(0);
  });

  it('interrogazioni dei bit di stato: A ==0, A >0, A OV, A UO …', () => {
    // Manuale AWL, «Parola di stato» (CC1/CC0) e «A ==0 … A UO».
    const cc = (cc0: boolean, cc1: boolean, cond: string): number =>
      bit(runAwl([`\tA ${cond};\n\t= %Q0.0;`], { regs: { stw: { cc0, cc1 } } }).mem.Q[0]!, 0);
    expect([cc(false, false, '==0'), cc(false, true, '==0')]).toEqual([1, 0]);
    expect([cc(false, true, '>0'), cc(true, false, '>0')]).toEqual([1, 0]);
    expect([cc(true, false, '<0'), cc(false, false, '<0')]).toEqual([1, 0]);
    expect([cc(true, false, '<>0'), cc(false, true, '<>0'), cc(false, false, '<>0')]).toEqual([
      1, 1, 0,
    ]);
    expect([cc(false, true, '>=0'), cc(true, false, '>=0')]).toEqual([1, 0]);
    expect([cc(true, false, '<=0'), cc(false, true, '<=0')]).toEqual([1, 0]);
    expect([cc(true, true, 'UO'), cc(true, false, 'UO')]).toEqual([1, 0]);
    const ov = runAwl(['\tA OV;\n\t= %Q0.0;'], { regs: { stw: { ov: true } } });
    expect(bit(ov.mem.Q[0]!, 0)).toBe(1);
    const os = runAwl(['\tAN OS;\n\t= %Q0.0;'], { regs: { stw: { os: true } } });
    expect(bit(os.mem.Q[0]!, 0)).toBe(0);
  });

  it('NOT, SET, CLR', () => {
    // Manuale AWL, «NOT», «SET», «CLR»: stato dopo ognuna.
    const r = runAwl(['\tSET;\n\tNOT;\n\tCLR;']);
    expect(wordToStw(r.trace[0]!.stw)).toMatchObject({
      fc: false,
      rlo: true,
      sta: true,
      or: false,
    });
    // NOT: /FC e OR restano come erano (SET ha messo /FC = 0)
    expect(wordToStw(r.trace[1]!.stw)).toMatchObject({ fc: false, rlo: false, sta: true });
    expect(wordToStw(r.trace[2]!.stw)).toMatchObject({ fc: false, rlo: false, sta: false });
    // dopo SET / NOT /FC = 0: il successivo A I0.0 apre una catena nuova
    const n = runAwl(['\tSET;\n\tNOT;\n\tA %I0.0;\n\t= %Q0.0;'], { setup: (m) => (m.I[0] = 1) });
    expect(bit(n.mem.Q[0]!, 0)).toBe(1);
  });

  it('FP: un solo ciclo a 1 sul fronte di salita', () => {
    // Manuale AWL, «FP (fronte di salita)»: l'RLO è 1 solo se prima il merker di fronte era 0.
    const prog = ['\tA %I0.0;\n\tFP %M10.0;\n\t= %Q0.0;'];
    const first = runAwl(prog, { setup: (m) => (m.I[0] = 1) });
    expect(bit(first.mem.Q[0]!, 0)).toBe(1);
    const second = runAwl(prog, { mem: first.mem });
    expect(bit(second.mem.Q[0]!, 0)).toBe(0);
    // I0.0 cade e risale: di nuovo un ciclo a 1
    runAwl(prog, { mem: first.mem, setup: (m) => (m.I[0] = 0) });
    const third = runAwl(prog, { mem: first.mem, setup: (m) => (m.I[0] = 1) });
    expect(bit(third.mem.Q[0]!, 0)).toBe(1);
  });

  it('FN: un solo ciclo a 1 sul fronte di discesa', () => {
    // Manuale AWL, «FN (fronte di discesa)».
    const prog = ['\tA %I0.0;\n\tFN %M10.0;\n\t= %Q0.0;'];
    const up = runAwl(prog, { setup: (m) => (m.I[0] = 1) });
    expect(bit(up.mem.Q[0]!, 0)).toBe(0);
    const down = runAwl(prog, { mem: up.mem, setup: (m) => (m.I[0] = 0) });
    expect(bit(down.mem.Q[0]!, 0)).toBe(1);
    const again = runAwl(prog, { mem: up.mem });
    expect(bit(again.mem.Q[0]!, 0)).toBe(0);
  });

  it('MCR( con RLO 0: = scrive 0', () => {
    // Manuale AWL, «MCR( », «)MCR», «MCRA»: con MCR attivo e RLO dell'MCR a 0 la = scrive 0.
    const prog = [
      '\tMCRA;\n\tA %I0.0;\n\tMCR(;\n\tSET;\n\t= %M1.0;\n\t)MCR;\n\tMCRD;\n\tSET;\n\t= %M1.1;',
    ];
    const off = runAwl(prog, { setup: (m) => (m.M[1] = 0b01) });
    expect(off.mem.M[1]).toBe(0b10); // M1.0 azzerato; fuori zona M1.1 scritto normalmente
    const on = runAwl(prog, { setup: (m) => (m.I[0] = 1) });
    expect(on.mem.M[1]).toBe(0b11);
    // senza MCRA la zona non agisce
    const inactive = runAwl(['\tA %I0.0;\n\tMCR(;\n\tSET;\n\t= %M1.0;\n\t)MCR;']);
    expect(inactive.mem.M[1]).toBe(0b01);
  });

  it('A T1 → NON_SIMULATA_2B', () => {
    // Manuale AWL, «A» su temporizzatore: rinviato al piano 2B.
    expect(() => runAwl(['\tA %T1;'])).toThrowError(/NON_SIMULATA_2B/);
  });

  it('BLD e NOP non fanno niente; BE termina', () => {
    // Manuale AWL, «BLD», «NOP 0», «BE».
    const r = runAwl(['\tBLD 1;\n\tNOP 0;\n\tBE;\n\tSET;']);
    expect(r.trace.map((t) => t.id)).toEqual(['BLD', 'NOP', 'BE']);
  });

  it('byte grezzi → MC7_NON_ESEGUIBILE con offset', () => {
    // Opcode non in tabella: la decodifica dà byte grezzi, l'esecuzione si ferma con l'offset.
    const code = Uint8Array.from([0x80, 0x00, 0x00, 0xff, 0x65, 0x00]);
    expect('raw' in decodeInstruction(code, 2)).toBe(true);
    let err: unknown;
    try {
      runCode(code, [0]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SimError);
    expect((err as SimError).code).toBe('MC7_NON_ESEGUIBILE');
    expect((err as SimError).offset).toBe(2);
    expect((err as SimError).network).toBe(1);
  });
});
