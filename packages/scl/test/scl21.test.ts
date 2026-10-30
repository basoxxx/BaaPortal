// SCL della versione 2.1: confronti fra BOOL e ordinamento senza segno di BYTE/WORD/DWORD,
// indirizzi di periferia e mnemonici tedeschi, funzioni STRING, DATE_AND_TIME e conversioni,
// potenza. Forma dell'AWL, diagnostiche e risultati nel simulatore con indirizzi in M.
import { describe, expect, it } from 'vitest';
import { checkBlockCode } from '@baaportal/awl';
import { tempEndByte } from '@baaportal/mc7';
import { sclToAwl } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';
import { runAwl } from '../../sim/test/helpers.js';

const fc = makeCtx(
  'FC',
  emptyIface({
    temp: [m('w', el('Word')), m('dw', el('DWord')), m('x', el('Bool'))],
    returnType: { kind: 'void' },
  }),
);
const out = (text: string, ctx = fc) => sclToAwl(text, ctx, tempEndByte(ctx.owner.iface.temp, ctx));
const ok = (text: string, ctx = fc) => {
  const r = out(text, ctx);
  expect(r.diagnostics).toEqual([]);
  expect(checkBlockCode([r.source], ctx, 'international')).toEqual([]);
  return r.source.replace(/\s+/g, ' ');
};
const diag = (text: string, ctx = fc) => {
  const r = out(text, ctx);
  expect(r.source).toBe('');
  return r.diagnostics[0]!.message;
};

const abs = makeCtx('FC', emptyIface({ returnType: { kind: 'void' } }));
/** BR a 1 prima del testo, copiato in M 50.0 dopo. */
const run = (text: string, setup: (v: DataView) => void = () => undefined): DataView => {
  const r = sclToAwl(text, abs, 0);
  expect(r.diagnostics).toEqual([]);
  expect(checkBlockCode([r.source], abs, 'international')).toEqual([]);
  const res = runAwl(['SET\nSAVE', `${r.source}\nA BR\n= M 50.0`], {
    setup: (mem) => setup(new DataView(mem.M.buffer, mem.M.byteOffset, mem.M.byteLength)),
  });
  return new DataView(res.mem.M.buffer, res.mem.M.byteOffset, res.mem.M.byteLength);
};
const br = (v: DataView) => v.getUint8(50) & 1;

describe('SCL 2.1: confronti fra BOOL e stringhe di bit senza segno', () => {
  it('BOOL = e <> con XOR, in ogni combinazione', () => {
    const v = run(
      [
        'M2.0 := M0.0 = M0.1;',
        'M2.1 := M0.0 <> M0.1;',
        'M2.2 := (M0.0 = TRUE) AND (M0.1 <> FALSE);',
        'M2.3 := NOT (M0.0 = M0.1) OR M0.2;',
      ].join('\n'),
      (v) => v.setUint8(0, 0b001),
    );
    expect(v.getUint8(2) & 15).toBe(0b1010);
    for (const [a, b] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const r = run('M2.0 := M0.0 = M0.1;\nM2.1 := M0.0 <> M0.1;', (v) =>
        v.setUint8(0, a | (b << 1)),
      );
      expect(r.getUint8(2) & 3).toBe(a === b ? 1 : 2);
    }
    expect(ok('x := x = M0.0;')).toContain('X %M0.0');
    expect(diag('x := x < M0.0;')).toContain('non si usa con BOOL');
  });

  it('BYTE, WORD e DWORD: < > <= >= senza segno', () => {
    const v = run(
      [
        'M10.0 := MW0 > W#16#7FFF;',
        'M10.1 := MW0 < W#16#7FFF;',
        'M10.2 := MD2 > DW#16#7FFFFFFF;',
        'M10.3 := MD2 >= DW#16#FFFFFFFF;',
        'M10.4 := MD2 < DW#16#1;',
        'M10.5 := MB6 > B#16#7F;',
        'M10.6 := MW0 <= W#16#8000;',
        'M10.7 := MW8 < W#16#FFFF AND MW8 > W#16#0;',
      ].join('\n'),
      (v) => {
        v.setUint16(0, 0x8000);
        v.setUint32(2, 0xffffffff);
        v.setUint8(6, 0x80);
        v.setUint16(8, 0x0001);
      },
    );
    expect(v.getUint8(10)).toBe(0b11101101);
    expect(br(v)).toBe(1);
    expect(ok('x := w < W#16#5;')).toContain('XOW W#16#8000');
    expect(ok('x := dw >= DW#16#1;')).toContain('XOD DW#16#80000000');
    expect(ok('x := w = W#16#1;')).not.toContain('XOW');
    expect(diag('w := w + 1;')).toContain('solo i confronti');
  });
});

describe('SCL 2.1: periferia e mnemonici tedeschi negli indirizzi', () => {
  it('forma AWL internazionale', () => {
    expect(ok('MW0 := PIW256 + PEW258;')).toMatch(/L %PIW256; L %PIW258/);
    expect(ok('PQW256 := MW0; PAB260 := MB2; PQD262 := MD4;')).toMatch(
      /T %PQW256.*T %PQB260.*T %PQD262/,
    );
    expect(ok('A1.0 := E0.1 AND NOT M0.0; AW4 := EW2; AD8 := ED4; AB3 := EB1;')).toMatch(
      /A %I0.1; AN %M0.0; = %Q1.0; L %IW2; T %QW4; L %ID4; T %QD8; L %IB1; T %QB3/,
    );
  });

  it('PI si legge e PQ si scrive soltanto', () => {
    expect(diag('PIW256 := 1;')).toContain('si legge soltanto');
    expect(diag('MW0 := PQW256;')).toContain('si scrive soltanto');
  });

  it('una variabile con il nome di un indirizzo tedesco resta la variabile', () => {
    const ctx = makeCtx(
      'FC',
      emptyIface({
        temp: [m('AD1', el('Int')), m('EW2', el('Int'))],
        returnType: { kind: 'void' },
      }),
    );
    expect(ok('AD1 := EW2 + 1;', ctx)).toMatch(/L #EW2; L 1; \+I; T #AD1/);
    expect(ok('AD1 := %EW2;', ctx)).toContain('L %IW2');
  });

  it('nel simulatore: E/A come I/Q, PEW legge la periferia, PAW la scrive', () => {
    const r = sclToAwl('A0.0 := E0.0; MW0 := PEW0; PAW2 := MW0;', abs, 0);
    expect(r.diagnostics).toEqual([]);
    const res = runAwl([r.source], {
      setup: (mem) => {
        mem.I[0] = 1;
        mem.physIn[0] = 0x12;
        mem.physIn[1] = 0x34;
      },
    });
    expect(res.mem.Q[0]! & 1).toBe(1);
    expect([res.mem.M[0], res.mem.M[1]]).toEqual([0x12, 0x34]);
    expect([res.mem.physOut[2], res.mem.physOut[3]]).toEqual([0x12, 0x34]);
  });
});
