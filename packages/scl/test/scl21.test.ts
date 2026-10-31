// SCL della versione 2.1: confronti fra BOOL e ordinamento senza segno di BYTE/WORD/DWORD,
// indirizzi di periferia e mnemonici tedeschi, funzioni STRING, DATE_AND_TIME e conversioni,
// potenza. Forma dell'AWL, diagnostiche e risultati nel simulatore con indirizzi in M.
import { describe, expect, it } from 'vitest';
import { checkBlockCode } from '@baaportal/awl';
import { s5TimeMs, s5TimeWord, tempEndByte } from '@baaportal/mc7';
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

describe('SCL 2.1: conversioni di DATE, TOD e S5TIME', () => {
  it('DATE_TO_DINT, DINT_TO_DATE, TOD_TO_DINT, DINT_TO_TOD', () => {
    const v = run(
      [
        'MD0 := DATE_TO_DINT(D#2024-01-01);',
        'MD4 := DATE_TO_DINT(DINT_TO_DATE(L#70000));',
        'M8.0 := DINT_TO_DATE(L#12418) = D#2024-01-01;',
        'M8.1 := DINT_TO_DATE(L#70000) > D#2000-01-01;',
        'MD10 := TOD_TO_DINT(TOD#12:30:00.5);',
        'M8.2 := DINT_TO_TOD(L#45000500) = TOD#12:30:00.5;',
      ].join('\n'),
    );
    expect(v.getInt32(0)).toBe((Date.UTC(2024, 0, 1) - Date.UTC(1990, 0, 1)) / 864e5);
    expect(v.getInt32(4)).toBe(70000 & 0xffff);
    expect(v.getUint8(8) & 7).toBe(0b111);
    expect(v.getInt32(10)).toBe(45_000_500);
  });

  it('TIME_TO_S5TIME: base più piccola e troncamento come L S5T#; fuori campo BR a 0', () => {
    const values = [0, 9, 10, 999, 9990, 9991, 9999, 10000, 99900, 99999, 100000, 999000];
    for (const ms of [
      ...values,
      999999,
      1e6,
      9_990_000,
      9_999_999,
      10_000_000,
      2 ** 31 - 1,
      -1,
      -(2 ** 31),
    ]) {
      const v = run(
        'MD8 := TIME_TO_DINT(S5TIME_TO_TIME(TIME_TO_S5TIME(DINT_TO_TIME(MD4))));',
        (d) => d.setInt32(4, ms),
      );
      const inRange = ms >= 0 && ms <= 9_999_999;
      const word = ms < 0 ? 0 : s5TimeWord(Math.min(ms, 9_999_999));
      expect([v.getInt32(8), br(v)], String(ms)).toEqual([s5TimeMs(word).ms, +inRange]);
    }
    const w = run(
      'M0.0 := TIME_TO_S5TIME(T#2m) = S5T#2m;\nMD4 := TIME_TO_DINT(S5TIME_TO_TIME(S5T#2h46m30s));',
    );
    expect([w.getUint8(0) & 1, w.getInt32(4)]).toEqual([1, 9_990_000]);
  });
});

describe('SCL 2.1: potenza **', () => {
  it('esponente intero esatto, REAL con EXP(LN), precedenza sopra il meno', () => {
    const v = run(
      [
        'MD0 := 2 ** 10;',
        'MD4 := -2.0 ** 2;',
        'MD8 := (-2.0) ** 3;',
        'MD12 := 2.0 ** -2;',
        'MD16 := 0.0 ** 0;',
        'MD20 := 2.0 ** 0.5;',
        'MD24 := MW40 ** MW42;',
        'MD28 := 3 ** MD44;',
        'MD32 := (-1.0) ** MD48;',
        'MD36 := 1.0 ** L#2147483647;',
      ].join('\n'),
      (d) => {
        d.setInt16(40, -3);
        d.setInt16(42, 5);
        d.setInt32(44, -1);
        d.setInt32(48, -(2 ** 31));
      },
    );
    const f = (k: number) => v.getFloat32(k);
    expect([f(0), f(4), f(8), f(12), f(16)]).toEqual([1024, -4, -8, 0.25, 1]);
    expect(f(20)).toBeCloseTo(Math.SQRT2, 6);
    expect([f(24), f(28), f(32), f(36)]).toEqual([-243, Math.fround(1 / 3), 1, 1]);
  });

  it('diagnostiche', () => {
    expect(diag('x := 2 ** 3 ** 2;')).toContain('in catena');
    expect(diag('x := x ** 2;')).toContain('** si usa con');
    expect(diag('w := 2 ** 2;')).toContain('Tipi diversi');
  });
});

describe('SCL 2.1: DATE_AND_TIME', () => {
  const dtc = makeCtx(
    'FC',
    emptyIface({
      temp: [m('d1', { kind: 'dateAndTime' }), m('d2', { kind: 'dateAndTime' })],
      returnType: { kind: 'void' },
    }),
  );
  const runDt = (text: string) => {
    const r = sclToAwl(text, dtc, tempEndByte(dtc.owner.iface.temp, dtc));
    expect(r.diagnostics).toEqual([]);
    expect(checkBlockCode([r.source], dtc, 'international')).toEqual([]);
    return runAwl([r.source]).mem;
  };

  it('costante in BCD col giorno della settimana, copia', () => {
    const mem = runDt('d1 := DT#2024-03-15-12:30:45.678; d2 := d1;');
    expect([...mem.L.subarray(8, 16)]).toEqual([0x24, 0x03, 0x15, 0x12, 0x30, 0x45, 0x67, 0x86]);
  });

  it('confronti: 1990-1999 prima del 2000, millisecondi, senza il giorno della settimana', () => {
    const order = [
      'DT#1990-01-01-00:00:00',
      'DT#1999-12-31-23:59:59.999',
      'DT#2000-01-01-00:00:00',
      'DT#2024-03-15-12:30:45.678',
      'DT#2024-03-15-12:30:45.679',
      'DT#2089-12-31-23:59:59.999',
    ];
    order.forEach((a, i) =>
      order.forEach((b, j) => {
        const mem = runDt(
          `d1 := ${a}; d2 := ${b};\nM0.0 := d1 < d2; M0.1 := d1 = d2; M0.2 := d1 > d2; M0.3 := d1 >= ${b}; M0.4 := ${a} <> d2;`,
        );
        const want =
          +(i < j) | (+(i === j) << 1) | (+(i > j) << 2) | (+(i >= j) << 3) | (+(i !== j) << 4);
        expect(mem.M[0]! & 31, `${a} ? ${b}`).toBe(want);
      }),
    );
  });

  it('diagnostiche', () => {
    const d = (t: string) => sclToAwl(t, dtc, 64).diagnostics[0]?.message ?? '';
    expect(d('MD0 := DT#2024-01-01-00:00:00;')).toContain('DATE_AND_TIME');
    expect(d('M0.0 := d1 < MD0;')).toContain('solo con un DATE_AND_TIME');
    expect(d('d1 := DT#2090-01-01-00:00:00;')).toContain('Costante non valida');
  });
});

describe('SCL 2.1: nomi che sembrano indirizzi tedeschi e IN_OUT di periferia', () => {
  const extra = [
    {
      name: 'Inc',
      kind: 'FC' as const,
      number: 20,
      iface: emptyIface({ inOut: [m('v', el('Int'))], returnType: { kind: 'void' } }),
    },
    {
      name: 'Scala',
      kind: 'FC' as const,
      number: 21,
      iface: emptyIface({
        input: [m('EW1', el('Int'))],
        output: [m('AW1', el('Int'))],
        returnType: { kind: 'void' },
      }),
    },
    {
      name: 'AW1',
      kind: 'FC' as const,
      number: 22,
      iface: emptyIface({ input: [m('X', el('Int'))], returnType: el('Int') }),
    },
  ];
  const withBlocks = (name: string | undefined, iface: Parameters<typeof makeCtx>[1]) => {
    const base = makeCtx('FC', iface);
    return {
      ...base,
      owner: { ...base.owner, ...(name ? { name } : {}) },
      block: (ref: Parameters<typeof base.block>[0]) =>
        extra.find((b) =>
          'name' in ref ? b.name === ref.name : b.kind === ref.kind && b.number === ref.number,
        ) ?? base.block(ref),
    };
  };
  const ctx = withBlocks(
    undefined,
    emptyIface({
      temp: [
        m('x', el('Int')),
        m('s', { kind: 'struct', members: [m('AW1', el('Int')), m('EB2', el('Byte'))] }),
      ],
      returnType: { kind: 'void' },
    }),
  );

  it('una FC di nome AW2 scrive il suo valore di ritorno, non QW2', () => {
    const own = withBlocks('AW2', emptyIface({ returnType: el('Int') }));
    const s = ok('AW2 := 5;', own);
    expect(s).toContain('T #RET_VAL');
    expect(s).not.toContain('QW');
  });

  it('IN_OUT: PIW e PQW rifiutati', () => {
    expect(diag('"Inc"(v := PQW256);', ctx)).toContain('periferia');
    expect(diag('"Inc"(v := PIW256);', ctx)).toContain('periferia');
    expect(ok('"Inc"(v := MW0);', ctx)).toContain('v := %MW0');
  });

  it('mnemonici tedeschi come membri, parametri e FC chiamate senza virgolette', () => {
    expect(ok('#s.AW1 := 1; s.EB2 := B#16#2;', ctx)).toContain('#s.AW1');
    expect(ok('"Scala"(EW1 := 5, AW1 => #x);', ctx)).toContain('AW1 := #x');
    expect(ok('x := AW1(X := 2);', ctx)).toContain('CALL');
    expect(ok('x := AW1(2);', ctx)).toContain('CALL');
  });
});
