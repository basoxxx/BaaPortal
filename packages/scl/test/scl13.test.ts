// SCL della versione 1.3: indici variabili negli ARRAY (AR1, accesso `[AR1,P#…]` interno all'area).
// Forma dell'AWL, diagnostiche e, con TEMP e indici in M, risultati nel simulatore (FB, multi-istanze
// e DB si eseguono in `project/test/sclBlock.test.ts`).
import { describe, expect, it } from 'vitest';
import { checkBlockCode } from '@baaportal/awl';
import { tempEndByte } from '@baaportal/mc7';
import type { DataType, TypedMember } from '@baaportal/s7-types';
import { sclToAwl } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';
import { runAwl } from '../../sim/test/helpers.js';

const arr = (element: DataType, ...dims: [number, number][]): DataType => ({
  kind: 'array',
  dims: dims.map(([lo, hi]) => ({ lo, hi })),
  element,
});

const fb = makeCtx(
  'FB',
  emptyIface({
    input: [m('i', el('Int'))],
    inOut: [m('io', arr(el('Int'), [1, 3]))],
    static: [
      m('d', el('DInt')),
      m('x', el('Bool')),
      m('v', arr(el('Int'), [1, 5])),
      m('b', arr(el('Bool'), [0, 15])),
      m('mm', arr(el('DInt'), [1, 3], [0, 2])),
      m('s', { kind: 'struct', members: [m('k', el('Bool')), m('n', arr(el('Real'), [0, 2]))] }),
      m('sv', arr({ kind: 'struct', members: [m('z', el('Int'))] }, [1, 2])),
    ],
  }),
);
const ok = (text: string) => {
  const out = sclToAwl(text, fb, 0);
  expect(out.diagnostics).toEqual([]);
  expect(checkBlockCode([out.source], fb, 'international')).toEqual([]);
  return out.source;
};
const diag = (text: string) => {
  const out = sclToAwl(text, fb, 0);
  expect(out.source).toBe('');
  return out.diagnostics[0]!;
};
const has = (s: string, ...parts: string[]) => {
  const flat = s.replace(/\s+/g, ' ');
  for (const t of parts) expect(flat).toContain(t);
};

describe('sclToAwl 1.3: AWL degli indici variabili', () => {
  it('nei dati d istanza: AR2 + indice, accesso DI interno all area', () => {
    const s = ok('v[i] := v[i + 1] + 1; x := b[i]; mm[i, 2] := d; s.n[i] := 1.5;');
    has(s, 'ITD', 'TAK', '>D', '<D', 'TAR2', '+D', 'LAR1', 'SAVE');
    // i, io (puntatore di 6 byte), d, x: v dal byte 14 a passo 16 bit, b dal byte 24 a passo 1 bit
    has(s, 'DIW[AR1,P#14.0]', 'DIX[AR1,P#24.0]', 'DID[AR1,P#26.0]', 'DID[AR1,P#64.0]');
    has(s, 'L L#16; *D', 'L L#32; *D');
  });

  it('indici annidati: l indice interno si legge prima, in una TEMP', () => {
    const s = ok('d := INT_TO_DINT(v[v[i]]);');
    expect(s.match(/LAR1/g)).toHaveLength(2);
  });

  it('un indice costante dentro un indice variabile si controlla subito', () => {
    expect(diag('d := mm[i, 3];').message).toContain('fuori da [0..2]');
  });

  it('diagnostiche', () => {
    expect(diag('d := mm[i];').message).toContain('2 dimensioni');
    expect(diag('d := INT_TO_DINT(v[1.5]);').message).toContain('INT o DINT');
    expect(diag('d := INT_TO_DINT(v[x]);').message).toContain('INT o DINT');
    expect(ok('d := INT_TO_DINT(sv[i].z);')).toContain('LAR1');
    expect(diag('d := io[i];').message).toContain('IN_OUT');
    expect(diag('FOR v[i] := 1 TO 2 DO END_FOR;').message).toContain('FOR');
    expect(diag('d := x[i];').message).toContain('non è un ARRAY');
  });
});

// ---- esecuzione nel simulatore: TEMP di una FC (al massimo 64 byte), indici e risultati in M ----

it('un membro di tipo sconosciuto nell interfaccia dà una diagnostica, non un eccezione', () => {
  const broken = makeCtx(
    'FB',
    emptyIface({
      input: [m('i', el('Int'))],
      static: [m('v', arr(el('Int'), [1, 5])), m('z', { kind: 'named', name: 'Mancante' })],
    }),
  );
  const out = sclToAwl('v[i] := 1;', broken, 0);
  expect(out.source).toBe('');
  expect(out.diagnostics[0]!.message).toMatch(/Mancante/);
});

const fcOf = (temp: TypedMember[]) => ({
  ctx: makeCtx('FC', emptyIface({ temp, returnType: { kind: 'void' } })),
  temp,
});
const T1 = fcOf([
  m('t', arr(el('Int'), [1, 10])),
  m('g', arr(el('DInt'), [0, 2], [1, 2])),
  m('f', arr(el('Bool'), [-2, 13])),
]);
const T2 = fcOf([
  m('r', arr(el('Real'), [1, 4])),
  m('w', arr(el('Word'), [1, 2])),
  m('y', arr(el('Byte'), [1, 3])),
  m('q', arr(el('DWord'), [1, 2])),
]);
/** Con `br`, BR a 1 prima del testo e copiato in M6.0 dopo. */
const run = (
  text: string,
  setup: (v: DataView) => void = () => undefined,
  { ctx, temp } = T1,
  br = false,
) => {
  const out = sclToAwl(text, ctx, tempEndByte(temp, ctx));
  expect(out.diagnostics.map((d) => d.message)).toEqual([]);
  const nets = br ? ['SET\nSAVE', `${out.source}\nA BR\n= M 6.0`] : [out.source];
  const r = runAwl(nets, {
    setup: (mem) => setup(new DataView(mem.M.buffer, mem.M.byteOffset, mem.M.byteLength)),
  });
  return new DataView(r.mem.M.buffer, r.mem.M.byteOffset, r.mem.M.byteLength);
};

describe('sclToAwl 1.3: indici variabili nel simulatore', () => {
  it('FOR riempie e somma un ARRAY di INT', () => {
    const v = run(
      'FOR MW0 := 1 TO 10 DO t[MW0] := MW0 * 2; END_FOR; MW2 := 0; FOR MW0 := 1 TO 10 DO MW2 := MW2 + t[MW0]; END_FOR; MW4 := t[MW6 + 1];',
      (v) => v.setInt16(6, 4),
    );
    expect(v.getInt16(2)).toBe(110);
    expect(v.getInt16(4)).toBe(10);
  });

  it('ARRAY a due dimensioni di DINT, riga per riga', () => {
    const v = run(
      'FOR MW0 := 0 TO 2 DO FOR MW2 := 1 TO 2 DO g[MW0, MW2] := INT_TO_DINT(MW0 * 10 + MW2); END_FOR; END_FOR; MD4 := g[MW8, MW10]; MD12 := g[2, MW10] + g[MW8, 1]; MD16 := g[MW8, MW10 + 1];',
      (v) => {
        v.setInt16(8, 1);
        v.setInt16(10, 2);
      },
    );
    expect(v.getInt32(4)).toBe(12);
    expect(v.getInt32(12)).toBe(22 + 11);
    // [1, 3] non è [2, 1]: ogni dimensione ha i suoi limiti
    expect(v.getInt32(16)).toBe(0);
  });

  it('indici annidati e indice calcolato', () => {
    const v = run(
      'FOR MW0 := 1 TO 10 DO t[MW0] := 11 - MW0; END_FOR; MW2 := t[t[MW4]]; MW6 := t[t[MW4] + 1];',
      (v) => v.setInt16(4, 3),
    );
    // t[3] = 8, t[8] = 3, t[9] = 2
    expect([v.getInt16(2), v.getInt16(6)]).toEqual([3, 2]);
  });

  it('ARRAY di BOOL, un bit per elemento, col limite basso negativo', () => {
    const v = run(
      'FOR MW0 := -2 TO 13 DO f[MW0] := MW0 > 5; END_FOR; M2.0 := f[MW4]; M2.1 := f[MW6] AND NOT f[MW4 - 7]; M2.2 := f[MW4 + 8];',
      (v) => {
        v.setInt16(4, 5);
        v.setInt16(6, 6);
      },
    );
    expect(v.getUint8(2) & 7).toBe(0b110);
  });

  it('REAL, BYTE, WORD, DWORD', () => {
    const v = run(
      'r[MW0] := 1.5; FOR MW0 := 2 TO 4 DO r[MW0] := r[MW0 - 1] * 2.0; END_FOR; MD20 := r[MW2 + 2];' +
        'FOR MW0 := 1 TO 3 DO y[MW0] := WORD_TO_BYTE(INT_TO_WORD(MW0)); END_FOR; w[MW2] := W#16#BEEF; q[MW2] := DW#16#12345678; MB4 := y[MW2 + 1]; MW6 := w[MW2]; MD8 := q[MW2];',
      (v) => {
        v.setInt16(0, 1);
        v.setInt16(2, 2);
      },
      T2,
    );
    expect(v.getFloat32(20)).toBe(12);
    expect(v.getUint8(4)).toBe(3);
    expect(v.getUint16(6)).toBe(0xbeef);
    expect(v.getUint32(8)).toBe(0x12345678);
  });

  it('tag globale di tipo ARRAY in M', () => {
    const tag = {
      name: 'Vm',
      kind: 'tag' as const,
      type: arr(el('Int'), [1, 4]),
      address: 'MW 20',
    };
    const ctx = { ...T1.ctx, symbol: (n: string) => (n === 'Vm' ? tag : T1.ctx.symbol(n)) };
    const v = run(
      'FOR MW0 := 1 TO 4 DO "Vm"[MW0] := MW0 * 7; END_FOR; MW2 := "Vm"[MW4];',
      (v) => v.setInt16(4, 3),
      { ...T1, ctx },
    );
    expect([v.getInt16(20), v.getInt16(26), v.getInt16(2)]).toEqual([7, 28, 21]);
  });

  it('un parametro ARRAY di FC resta fuori (è un puntatore)', () => {
    const fcp = makeCtx(
      'FC',
      emptyIface({ input: [m('p', arr(el('Int'), [1, 3]))], returnType: { kind: 'void' } }),
    );
    expect(sclToAwl('MW0 := p[MW2];', fcp, 0).diagnostics[0]!.message).toContain('parametro di FC');
  });

  it('indice fuori dai limiti: la scrittura si salta, la lettura dà 0, BR va a 0', () => {
    const v = run(
      't[MW8] := 7; t[MW0] := 99; MW2 := t[MW0]; MW4 := t[MW8]; MW10 := t[MW0 - 1];',
      (v) => {
        v.setInt16(0, 11);
        v.setInt16(8, 10);
      },
      T1,
      true,
    );
    expect([v.getInt16(2), v.getInt16(4), v.getInt16(10)]).toEqual([0, 7, 7]);
    expect(v.getUint8(6) & 1).toBe(0);
    for (const i of [0, -1, -32768, 32767, 11])
      expect(run('t[MW0] := 1;', (v) => v.setInt16(0, i), T1, true).getUint8(6) & 1).toBe(0);
    // dentro i limiti BR non cambia; i limiti stessi sono validi
    for (const i of [1, 10]) {
      const r = run('t[MW0] := 5; MW2 := t[MW0];', (v) => v.setInt16(0, i), T1, true);
      expect([r.getUint8(6) & 1, r.getInt16(2)]).toEqual([1, 5]);
    }
  });
});
