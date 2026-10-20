import { parseNetwork } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import {
  buildSsb,
  decodeInstruction,
  encodeInstruction,
  readSsb,
  s5TimeMs,
  s5TimeWord,
} from '../src';
import { realBlocks } from './realBlocks';
import { readBlockFile } from '../src';

const hex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const enc = (src: string, opts?: Parameters<typeof encodeInstruction>[1]): string => {
  const p = parseNetwork(src, 'international');
  expect(p.errors, src).toEqual([]);
  return hex(encodeInstruction(p.statements[0]!, opts));
};
const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(s.split(' ').map((x) => parseInt(x, 16)));
const dec = (h: string) => {
  const r = decodeInstruction(fromHex(h), 0);
  if ('raw' in r) throw new Error(`raw ${h}`);
  return r.stmt;
};

describe('operandi (mc7 §2.2)', () => {
  it('aree, dimensioni e bit in forma lunga', () => {
    expect(enc('A %I0.0;')).toBe('c0 00');
    expect(enc('A %DBX7.3;')).toBe('00 43 00 07');
    expect(enc('AN %DIX2.0;')).toBe('00 d0 00 02');
    expect(enc('O %L4.5;')).toBe('01 65 00 04');
    expect(enc('ON %M9.0;')).toBe('a8 09');
    expect(enc('X %M1.0;')).toBe('05 30 00 01');
    expect(enc('XN %Q1.0;')).toBe('05 a0 00 01');
    expect(enc('S %DBX1.1;')).toBe('09 41 00 01');
    expect(enc('R %DBX7.3;')).toBe('09 c3 00 07');
    expect(enc('FP %M0.0;')).toBe('49 30 00 00');
    expect(enc('FN %M0.1;')).toBe('49 b1 00 00');
    expect(enc('L %PIB4;')).toBe('7e 01 00 04');
    expect(enc('T %PQD4;')).toBe('7e 07 00 04');
    expect(enc('L %LD4;')).toBe('7e 63 00 04');
    expect(enc('T %DID4;')).toBe('7e 57 00 04');
    expect(enc('L %QW200;')).toBe('7e 22 00 c8');
    expect(enc('L %DBB1;')).toBe('7e 41 00 01');
  });

  it('indiretti da registro e da memoria', () => {
    expect(enc('T %DIW[AR2,P#14.0];')).toBe('be 5e 00 70');
    expect(enc('L %MD[AR1,P#2.4];')).toBe('be 33 00 14');
    expect(enc('A %M[AR1,P#0.0];')).toBe('79 30 00 00');
    expect(enc('= %L[AR2,P#1.1];')).toBe('79 ea 00 09');
    expect(enc('L %B[AR1,P#0.0];')).toBe('fb 01 00 00');
    expect(enc('L %D[AR2,P#0.0];')).toBe('fb 0b 00 00');
    expect(enc('T %W[AR1,P#8.0];')).toBe('fb 06 00 40');
    expect(enc('A %[AR1,P#0.0];')).toBe('fb 10 00 00');
    expect(enc('= %[AR2,P#0.0];')).toBe('fb 2a 00 00');
    expect(enc('A %I[MD10];')).toBe('51 31 00 0a');
    expect(enc('= %Q[DBD4];')).toBe('59 42 00 04');
    expect(enc('L %MW[DBD4];')).toBe('bb 43 00 04');
    expect(enc('L %MD[LD4];')).toBe('bb 6b 00 04');
    expect(enc('L %PIB[MD2];')).toBe('ba 30 00 02');
    expect(enc('T %PQB[MD2];')).toBe('ba b0 00 02');
    expect(enc('SP %T[MW2];')).toBe('bf 3e 00 02');
    expect(enc('A %C[LW2];')).toBe('bf e0 00 02');
    expect(enc('OPN %DB[MW2];')).toBe('fb 38 00 02');
    expect(enc('OPN %DI[LW2];')).toBe('fb 69 00 02');
  });

  it('puntatori d area (mc7 §2.2.4) e registri d indirizzo', () => {
    expect(enc('L P#DIX 16.0;')).toBe('38 04 85 00 00 80');
    expect(enc('L P#L 36.0;')).toBe('38 04 86 00 01 20');
    expect(enc('LAR1 P#DBX 0.0;')).toBe('fe 03 84 00 00 00');
    expect(enc('LAR2 P#M 10.3;')).toBe('fe 0b 83 00 00 53');
    expect(enc('L P#0.0;')).toBe('38 04 00 00 00 00');
    expect(enc('+AR1 P#2.0;')).toBe('fe 02 00 10');
    expect(enc('+AR2 P#2.0;')).toBe('fe 0a 00 10');
    expect(enc('+AR1;')).toBe('fe 06');
    expect(enc('TAR1 AR2;')).toBe('fe 09');
    expect(enc('LAR1 AR2;')).toBe('fe 01');
    expect(enc('TAR2 DID8;')).toBe('fe 5f 00 08');
    expect(enc('TAR1 MD8;')).toBe('fe 37 00 08');
    expect(enc('CAR;')).toBe('fe 08');
  });
});

describe('costanti (mc7 §2.3)', () => {
  const rows: [string, string][] = [
    ['L B#16#7F;', '28 7f'],
    ['L 2#0000000000000101;', '30 02 00 05'],
    ['L 2#101;', '30 02 00 05'],
    ['L 2#10000000000000000;', '38 02 00 01 00 00'],
    ['L 300;', '30 03 01 2c'],
    ['L -2;', '30 03 ff fe'],
    ["L 'A';", '30 05 00 41'],
    ["L 'AB';", '30 05 41 42'],
    ["L 'ABCD';", '38 05 41 42 43 44'],
    ['L B#(1,2);', '30 06 01 02'],
    ['L B#(1,2,3,4);', '38 06 01 02 03 04'],
    ['L W#16#BEEF;', '30 07 be ef'],
    ['L C#123;', '30 08 01 23'],
    ['L D#1990-01-02;', '30 0a 00 01'],
    ['L S5T#1S;', '30 0c 01 00'],
    ['L 80.0;', '38 01 42 a0 00 00'],
    ['L -1.5;', '38 01 bf c0 00 00'],
    ['L L#-1;', '38 03 ff ff ff ff'],
    ['L DW#16#DEADBEEF;', '38 07 de ad be ef'],
    ['L T#1S;', '38 09 00 00 03 e8'],
    ['L T#-1S;', '38 09 ff ff fc 18'],
    ['L TOD#00:00:01.000;', '38 0b 00 00 03 e8'],
    ['+ -5;', '58 00 ff fb'],
    ['AW W#16#0F0F;', '68 34 0f 0f'],
    ['OD DW#16#FF;', '68 46 00 00 00 ff'],
    ['XOD DW#16#FF;', '68 56 00 00 00 ff'],
    ['INC 3;', '11 03'],
    ['DEC 255;', '19 ff'],
    ['BLD 103;', '10 67'],
    ['NOP 1;', 'ff ff'],
    ['SSI 3;', '68 31'],
    ['SSD 2;', '71 02'],
    ['SLD 32;', '29 20'],
    ['SRD 32;', 'fe e0'],
  ];
  it.each(rows)('%s → %s', (src, bytes) => {
    expect(enc(src)).toBe(bytes);
  });

  it('il byte di tipo si conserva: un REAL caricato come DINT resta tale (OB1 TIA)', () => {
    const d = dec('38 03 42 a0 00 00');
    expect(d.text).toBe('L L#1117782016');
    expect(d.constantType).toBeUndefined();
    expect(enc(d.text)).toBe('38 03 42 a0 00 00');
    expect(dec('38 01 42 a0 00 00').text).toBe('L 80.0');
  });

  it('tipi senza forma testuale: constantType e testo portatore', () => {
    // tipo 00: W#16# generato dal compilatore (mc7 §2.3, FC100)
    const t0 = dec('30 00 10 02');
    expect(t0.text).toBe('L W#16#1002');
    expect(t0.constantType).toBe(0);
    expect(enc(t0.text, { constantType: 0 })).toBe('30 00 10 02');
    expect(enc(t0.text)).toBe('30 07 10 02');
    // S5TIME con base non minima
    const s = dec('30 0c 20 01');
    expect(s.text).toBe('L W#16#2001');
    expect(s.constantType).toBe(0x0c);
    expect(enc(s.text, { constantType: 0x0c })).toBe('30 0c 20 01');
    // BCD non valido, caratteri non stampabili, REAL non finito, puntatore con area ignota
    expect(dec('30 08 00 ff').constantType).toBe(8);
    expect(dec('30 05 00 00').constantType).toBe(5);
    expect(dec('38 01 7f c0 00 00').constantType).toBe(1);
    expect(dec('38 04 ee 00 00 00').constantType).toBe(4);
    expect(dec('38 05 00 00 41 42').constantType).toBe(5);
    // tipo ignoto: si conserva comunque
    expect(dec('30 0e 12 34').constantType).toBe(0x0e);
    expect(enc(dec('38 0d 00 00 00 05').text, { constantType: 0x0d })).toBe('38 0d 00 00 00 05');
  });

  it('REAL: testo che riproduce i bit', () => {
    for (const bits of [0x3f800000, 0x00000001, 0x7f7fffff, 0x80000000, 0x358637bd, 0x3dcccccd]) {
      const b = Uint8Array.from([
        0x38,
        1,
        bits >>> 24,
        (bits >>> 16) & 255,
        (bits >>> 8) & 255,
        bits & 255,
      ]);
      const r = decodeInstruction(b, 0);
      if ('raw' in r) throw new Error('raw');
      expect(
        enc(
          r.stmt.text,
          r.stmt.constantType !== undefined ? { constantType: r.stmt.constantType } : undefined,
        ),
      ).toBe(hex(b));
    }
  });
});

describe('S5TIME: base di tempo (mc7 §2.3, §1.4.6)', () => {
  it('la base più piccola in cui il valore sta in tre cifre BCD', () => {
    expect(s5TimeWord(10)).toBe(0x0001);
    expect(s5TimeWord(9990)).toBe(0x0999);
    expect(s5TimeWord(10000)).toBe(0x1100); // 10 s = 100 × 100 ms: base 100 ms perché 1000 × 10 ms non entra
    expect(s5TimeWord(1000)).toBe(0x0100);
    expect(s5TimeWord(600000)).toBe(0x2600);
    expect(s5TimeWord(9_990_000)).toBe(0x3999);
    expect(s5TimeWord(0)).toBe(0);
    expect(s5TimeMs(0x0100)).toEqual({ ms: 1000, base: 0, valid: true });
    expect(s5TimeMs(0x2600)).toMatchObject({ ms: 600000, base: 2, valid: true });
    expect(s5TimeMs(0x00ff).valid).toBe(false);
    expect(s5TimeMs(0x4000).valid).toBe(false);
  });

  it('istruzione e valore iniziale SSB usano la stessa funzione', () => {
    for (const ms of [10, 1000, 12340, 600000, 3_720_000, 9_990_000]) {
      const lit = `S5T#${Math.floor(ms / 3_600_000)}H${Math.floor((ms % 3_600_000) / 60_000)}M${Math.floor((ms % 60_000) / 1000)}S${ms % 1000}MS`;
      const word = s5TimeWord(ms);
      const bytes = enc(`L ${lit};`);
      expect(bytes).toBe(`30 0c ${hex([word >> 8, word & 255])}`);
      const ssb = buildSsb(
        {
          in: [],
          out: [],
          inOut: [],
          stat: [{ name: 'f', type: { kind: 'elementary', name: 'S5Time' } }],
          temp: [],
          ret: [],
        },
        { f: lit },
        'FB',
      );
      const el = readSsb(ssb, 'FB').elements[0]!;
      expect(hex(el.initial!), lit).toBe(hex([word & 255, word >> 8]));
    }
  });

  it('nei blocchi reali ogni S5T è nella base minima', () => {
    const seen: string[] = [];
    for (const b of realBlocks()) {
      const f = readBlockFile(b.bytes);
      if (!f.header.kind || f.header.kind === 'DB' || f.header.kind === 'SDB') continue;
      const segs: [number, number][] = [];
      let o = 0;
      for (const n of f.add.networks) {
        segs.push([o, o + n]);
        o += n;
      }
      if (o < f.mc7.length) segs.push([o, f.mc7.length]);
      for (const [a, z] of segs) {
        const code = f.mc7.subarray(a, z);
        let at = 0;
        while (at < code.length) {
          const r = decodeInstruction(code, at);
          if (code[at] === 0x30 && code[at + 1] === 0x0c) {
            const w = (code[at + 2]! << 8) | code[at + 3]!;
            const m = s5TimeMs(w);
            expect(s5TimeWord(m.ms), `${b.name} ${hex(code.subarray(at, at + 4))}`).toBe(w);
            seen.push(
              `${b.name}: ${hex(code.subarray(at + 2, at + 4))} base ${m.base}, ${m.ms} ms`,
            );
          }
          at += r.length;
        }
      }
    }
    console.log(`[constants] S5T nei blocchi reali (${seen.length}):\n  ${seen.join('\n  ')}`);
  });
});
