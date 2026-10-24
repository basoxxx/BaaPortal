import { describe, expect, it } from 'vitest';
import { SimError } from '../src';
import { runAwl, runCode } from './helpers';

const m = (r: { mem: { M: Uint8Array } }, i: number) => r.mem.M[i]!;

describe('salti condizionati e incondizionati', () => {
  it('JC/JCN: bit di stato dopo il salto', () => {
    // JC con RLO 1: salta; /FC = 0, STA = 1, RLO = 1.
    const a = runAwl(['\tSET;\n\tJC fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;'], {
      regs: { stw: { os: true } },
    });
    expect(m(a, 0)).toBe(0);
    expect(a.regs.stw).toMatchObject({ fc: false, sta: true, rlo: true, or: false, os: true });
    // JC con RLO 0: non salta, ma RLO diventa 1.
    const b = runAwl(['\tCLR;\n\tJC fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(m(b, 0)).toBe(1);
    // JCN con RLO 0: salta.
    const c = runAwl(['\tCLR;\n\tJCN fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(m(c, 0)).toBe(0);
    expect(c.regs.stw).toMatchObject({ fc: false, sta: true, rlo: true });
    // JU non tocca lo stato.
    const d = runAwl(['\tCLR;\n\tJU fine;\n\tSET;\nfine: NOP 0;']);
    expect(d.regs.stw.rlo).toBe(false);
  });

  it('JCB/JNB copiano RLO in BR; JBI/JNBI leggono BR', () => {
    const a = runAwl(['\tSET;\n\tJCB fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(a.regs.stw.br).toBe(true);
    expect(m(a, 0)).toBe(0);
    const b = runAwl(['\tCLR;\n\tJNB fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(b.regs.stw.br).toBe(false);
    expect(m(b, 0)).toBe(0);
    const c = runAwl(['\tSET;\n\tJBI fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;'], {
      regs: { stw: { br: true } },
    });
    expect(m(c, 0)).toBe(0);
    const d = runAwl(['\tSET;\n\tJNBI fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;'], {
      regs: { stw: { br: true } },
    });
    expect(m(d, 0)).toBe(1);
  });

  it('JL con 3 voci e valore fuori campo', () => {
    const src = (v: number) =>
      `\tL ${v};\n\tJL fine;\n\tJU a0;\n\tJU a1;\n\tJU a2;\nfine: JU nul;\n` +
      `a0: L 10;\n\tT MB 0;\n\tJU esc;\na1: L 11;\n\tT MB 0;\n\tJU esc;\n` +
      `a2: L 12;\n\tT MB 0;\n\tJU esc;\nnul: L 99;\n\tT MB 0;\nesc: NOP 0;`;
    expect(m(runAwl([src(0)]), 0)).toBe(10);
    expect(m(runAwl([src(1)]), 0)).toBe(11);
    expect(m(runAwl([src(2)]), 0)).toBe(12);
    expect(m(runAwl([src(3)]), 0)).toBe(99);
    expect(m(runAwl([src(200)]), 0)).toBe(99);
    // Conta solo ACCU1-LL: 256 vale 0.
    expect(m(runAwl([src(256)]), 0)).toBe(10);
  });

  it('LOOP 5 volte', () => {
    const r = runAwl([
      '\tL 5;\nc: T MW 10;\n\tL MW 0;\n\tL 1;\n\t+I;\n\tT MW 0;\n\tL MW 10;\n\tLOOP c;',
    ]);
    expect(r.mem.M[1]).toBe(5);
    expect(r.regs.accu1 & 0xffff).toBe(0);
  });

  it('JO/JOS dopo overflow', () => {
    const ov = '\tL 32767;\n\tL 1;\n\t+I;\n';
    const a = runAwl([ov + '\tJO fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(m(a, 0)).toBe(0);
    const b = runAwl([ov + '\tJOS fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(m(b, 0)).toBe(0);
    expect(b.regs.stw.os).toBe(false);
    expect(b.regs.stw.ov).toBe(true);
    const c = runAwl(['\tJO fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(m(c, 0)).toBe(1);
  });

  it('JZ/JN/JP/JM/JPZ/JMZ/JUO dopo confronto e aritmetica', () => {
    // CC1/CC0 dopo ==I, >I, <I (confronti) e dopo -I.
    const sub = (a: number, b: number, jump: string): boolean =>
      m(
        runAwl([`\tL ${a};\n\tL ${b};\n\t-I;\n\t${jump} fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;`]),
        0,
      ) === 0;
    // 3 - 5 = -2 → <0
    expect(sub(3, 5, 'JM')).toBe(true);
    expect(sub(3, 5, 'JMZ')).toBe(true);
    expect(sub(3, 5, 'JN')).toBe(true);
    expect(sub(3, 5, 'JP')).toBe(false);
    expect(sub(3, 5, 'JPZ')).toBe(false);
    expect(sub(3, 5, 'JZ')).toBe(false);
    expect(sub(5, 3, 'JP')).toBe(true);
    expect(sub(5, 3, 'JPZ')).toBe(true);
    expect(sub(5, 3, 'JMZ')).toBe(false);
    expect(sub(5, 5, 'JZ')).toBe(true);
    expect(sub(5, 5, 'JPZ')).toBe(true);
    expect(sub(5, 5, 'JMZ')).toBe(true);
    expect(sub(5, 5, 'JN')).toBe(false);
    expect(sub(5, 5, 'JUO')).toBe(false);
    // UO (CC1 = CC0 = 1, p. es. dopo un confronto reale con NaN).
    const uo = runAwl(['\tJUO fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;'], {
      regs: { stw: { cc0: true, cc1: true } },
    });
    expect(m(uo, 0)).toBe(0);
    const nouo = runAwl(['\tJUO fine;\n\tSET;\n\t= M 0.0;\nfine: NOP 0;']);
    expect(m(nouo, 0)).toBe(1);
  });

  it('salto fuori dal blocco o a metà istruzione → MC7_NON_ESEGUIBILE', () => {
    // JU +1 parola cade a metà della JU stessa; JU +64 parole esce dal blocco.
    for (const jjjj of [0x01, 0x40]) {
      const code = new Uint8Array([0x70, 0x0b, 0x00, jjjj, 0x65, 0x00]);
      let err: unknown;
      try {
        runCode(code, [0]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SimError);
      expect((err as SimError).code).toBe('MC7_NON_ESEGUIBILE');
    }
  });
});

describe('LOOP e JL: effetti collaterali', () => {
  it('LOOP conserva ACCU1-H', () => {
    const r = runAwl(['\tL L#1048579;\nc: LOOP c;']); // 0x00100003
    expect(r.regs.accu1).toBe(0x00100000);
  });

  it('JL non tocca la parola di stato', () => {
    const r = runAwl(['\tL 5;\n\tJL fine;\n\tJU fine;\nfine: NOP 0;'], {
      regs: { stw: { fc: true, rlo: false, sta: true, or: true, os: true, br: true } },
    });
    expect(r.regs.stw).toMatchObject({
      fc: true,
      rlo: false,
      sta: true,
      or: true,
      os: true,
      br: true,
    });
  });

  it('JBI/JNBI lasciano RLO invariato (OR 0, STA 1, /FC 0)', () => {
    const r = runAwl(['\tCLR;\n\tJBI fine;\nfine: NOP 0;'], {
      regs: { stw: { br: true, fc: true, or: true } },
    });
    expect(r.regs.stw).toMatchObject({ rlo: false, or: false, sta: true, fc: false });
  });
});
