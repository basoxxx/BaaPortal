import { describe, expect, it } from 'vitest';
import { runAwl } from './helpers';

const prog = (...lines: string[]): string[] => [lines.map((l) => `\t${l};`).join('\n')];

describe('logica a parola', () => {
  it('AW W#16#0F0F: CC1 e OV', () => {
    // Manuale AWL, «Logica a parola» (AW): ACCU1-L AND costante; CC1 = (risultato ≠ 0), CC0 = OV = 0.
    const r = runAwl(prog('AW W#16#0F0F'), {
      regs: { accu1: 0xaabb1234, stw: { cc0: true, ov: true } },
    });
    expect(r.regs.accu1).toBe(0xaabb0204);
    expect(r.regs.stw).toMatchObject({ cc1: true, cc0: false, ov: false });
    const z = runAwl(prog('AW W#16#0F0F'), { regs: { accu1: 0x0000f0f0 } });
    expect(z.regs.accu1).toBe(0);
    expect(z.regs.stw.cc1).toBe(false);
  });

  it('AW, OW, XOW senza operando: ACCU1 con ACCU2', () => {
    const base = { accu1: 0x1234ff00, accu2: 0xffff0ff0 };
    expect(runAwl(prog('AW'), { regs: base }).regs.accu1).toBe(0x12340f00);
    expect(runAwl(prog('OW'), { regs: base }).regs.accu1).toBe(0x1234fff0);
    expect(runAwl(prog('XOW'), { regs: base }).regs.accu1).toBe(0x1234f0f0);
    expect(runAwl(prog('AW'), { regs: base }).regs.accu2).toBe(0xffff0ff0);
  });

  it('AD, OD, XOD su doppia parola', () => {
    const base = { accu1: 0xf0f0f0f0, accu2: 0xff00ff00 };
    expect(runAwl(prog('AD'), { regs: base }).regs.accu1).toBe(0xf000f000);
    expect(runAwl(prog('OD'), { regs: base }).regs.accu1).toBe(0xfff0fff0);
    expect(runAwl(prog('XOD'), { regs: base }).regs.accu1).toBe(0x0ff00ff0);
    const c = runAwl(prog('OD DW#16#000000FF'), { regs: { accu1: 0x100 } });
    expect(c.regs.accu1).toBe(0x1ff);
  });
});

describe('scorrimenti e rotazioni', () => {
  it('SLW 3: CC1 = ultimo bit uscito', () => {
    // Manuale AWL, «SLW»: ACCU1-L a sinistra, zeri a destra, CC1 = ultimo bit uscito, CC0 = OV = 0.
    const r = runAwl(prog('SLW 3'), { regs: { accu1: 0xaaaa9001 } });
    // 0x9001 << 3 = 0x8008 (bit usciti 100: l'ultimo è 0)
    expect(r.regs.accu1).toBe(0xaaaa8008);
    expect(r.regs.stw.cc1).toBe(false);
    const r2 = runAwl(prog('SLW 1'), { regs: { accu1: 0x8001 } });
    expect(r2.regs.accu1).toBe(0x0002);
    expect(r2.regs.stw).toMatchObject({ cc1: true, cc0: false, ov: false });
    // oltre 16 posizioni: tutto a zero
    const big = runAwl(prog('SLW'), { regs: { accu1: 0xffff, accu2: 20 } });
    expect(big.regs.accu1).toBe(0);
    expect(big.regs.stw.cc1).toBe(false);
  });

  it('SRW 0: niente cambia', () => {
    // Manuale AWL, «SRW»: con 0 posizioni l'istruzione non agisce.
    const r = runAwl(prog('SRW 0'), { regs: { accu1: 0x8001, stw: { cc1: true, ov: true } } });
    expect(r.regs.accu1).toBe(0x8001);
    expect(r.regs.stw).toMatchObject({ cc1: true, ov: true });
    const s = runAwl(prog('SRW 4'), { regs: { accu1: 0x123438ff } });
    expect(s.regs.accu1).toBe(0x1234038f);
    expect(s.regs.stw.cc1).toBe(true);
  });

  it('SLD, SRD e conteggio da ACCU2-LL', () => {
    expect(runAwl(prog('SLD 4'), { regs: { accu1: 0x0f000001 } }).regs.accu1).toBe(0xf0000010);
    const r = runAwl(prog('SRD'), { regs: { accu1: 0x80000003, accu2: 0x1234_0002 } });
    expect(r.regs.accu1).toBe(0x20000000);
    expect(r.regs.stw.cc1).toBe(true);
    expect(runAwl(prog('SLD'), { regs: { accu1: 0xffffffff, accu2: 33 } }).regs.accu1).toBe(0);
  });

  it('SSI: segno conservato', () => {
    // Manuale AWL, «SSI», «SSD»: scorrimento a destra col bit di segno.
    const r = runAwl(prog('SSI 4'), { regs: { accu1: 0x1234_8000 } });
    expect(r.regs.accu1).toBe(0x1234_f800);
    expect(r.regs.stw.cc1).toBe(false);
    const big = runAwl(prog('SSI'), { regs: { accu1: 0x00018000, accu2: 40 } });
    expect(big.regs.accu1).toBe(0x0001ffff);
    expect(big.regs.stw.cc1).toBe(true);
    const pos = runAwl(prog('SSI'), { regs: { accu1: 0x00017fff, accu2: 20 } });
    expect(pos.regs.accu1).toBe(0x00010000);
    expect(pos.regs.stw.cc1).toBe(false);
    expect(runAwl(prog('SSD 31'), { regs: { accu1: 0x80000000 } }).regs.accu1).toBe(0xffffffff);
    expect(runAwl(prog('SSD 2'), { regs: { accu1: 0x40000005 } }).regs.accu1).toBe(0x10000001);
  });

  it('RLD, RRD', () => {
    // Manuale AWL, «RLD», «RRD»: ruotano ACCU1 a 32 bit; CC1 = ultimo bit ruotato.
    const l = runAwl(prog('RLD 4'), { regs: { accu1: 0x81000001 } });
    expect(l.regs.accu1).toBe(0x10000018);
    expect(l.regs.stw.cc1).toBe(false);
    const r = runAwl(prog('RRD 1'), { regs: { accu1: 0x00000003 } });
    expect(r.regs.accu1).toBe(0x80000001);
    expect(r.regs.stw.cc1).toBe(true);
  });

  it('RLDA attraverso CC1', () => {
    // Manuale AWL, «RLDA», «RRDA»: rotazione di 1 posizione attraverso CC1.
    const l = runAwl(prog('RLDA'), { regs: { accu1: 0x80000000, stw: { cc1: true } } });
    expect(l.regs.accu1).toBe(1);
    expect(l.regs.stw.cc1).toBe(true);
    const l2 = runAwl(prog('RLDA'), { regs: { accu1: 0x80000000, stw: { cc1: false } } });
    expect(l2.regs.accu1).toBe(0);
    expect(l2.regs.stw.cc1).toBe(true);
    const r = runAwl(prog('RRDA'), { regs: { accu1: 1, stw: { cc1: false } } });
    expect(r.regs.accu1).toBe(0);
    expect(r.regs.stw.cc1).toBe(true);
    const r2 = runAwl(prog('RRDA'), { regs: { accu1: 0, stw: { cc1: true } } });
    expect(r2.regs.accu1).toBe(0x80000000);
    expect(r2.regs.stw.cc1).toBe(false);
  });
});
