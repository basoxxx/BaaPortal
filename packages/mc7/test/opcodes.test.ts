import { INSTRUCTIONS, formatNetwork, parseNetwork } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import {
  MC7_FORMS,
  Mc7Error,
  decodeInstruction,
  encodeDecoded,
  encodeInstruction,
  encodeJump,
  matchForm,
  readBlockFile,
  type DecodedStatement,
  type FormalParam,
} from '../src';
import { realBlocks } from './realBlocks';

const hex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .filter((x) => x)
      .map((x) => parseInt(x, 16)),
  );

type Decoded = { stmt: DecodedStatement; length: number };
function dec(h: string): Decoded {
  const r = decodeInstruction(fromHex(h), 0);
  if ('raw' in r) throw new Error(`raw: ${h}`);
  return r;
}

/** Ricodifica un'istruzione decodificata come fa il compilatore: testo → parser → codificatore. */
function reencode(d: DecodedStatement): Uint8Array {
  if (d.jumpWords !== undefined) return encodeJump(d.id, d.jumpWords);
  if (d.extended) return encodeDecoded(d);
  const parsed = parseNetwork(d.text, 'international');
  expect(parsed.errors, d.text).toEqual([]);
  expect(parsed.statements.length, d.text).toBe(1);
  const formal = d.formal;
  return encodeInstruction(parsed.statements[0]!, {
    ...(d.constantType !== undefined ? { constantType: d.constantType } : {}),
    ...(d.pointers ? { pointers: d.pointers } : {}),
    ...(formal
      ? {
          formal: (name: string): FormalParam | undefined =>
            name === formal.name ? { offset: formal.offset, type: formal.type } : undefined,
        }
      : {}),
  });
}

describe('MC7_FORMS (mc7 §2.6)', () => {
  it('ogni id di INSTRUCTIONS ha almeno una forma; elenco degli id non verificati', () => {
    const ids = new Set(MC7_FORMS.map((f) => f.id));
    const missing = INSTRUCTIONS.filter((i) => !ids.has(i.id)).map((i) => i.id);
    expect(missing).toEqual([]);
    expect(INSTRUCTIONS.length).toBe(155);
    const verifiedIds = new Set(MC7_FORMS.filter((f) => f.verified).map((f) => f.id));
    const unverified = INSTRUCTIONS.filter((i) => !verifiedIds.has(i.id)).map((i) => i.id);
    console.log(
      `[opcodes] ${MC7_FORMS.length} forme; id verificati ${verifiedIds.size}/155; ` +
        `non verificati (${unverified.length}): ${unverified.join(' ')}`,
    );
    // mc7 §6.1: 82 id senza verifica su blocco reale (CALL è una macro)
    expect(unverified.length).toBe(82);
  });

  it('le forme sono ben formate e non si sovrappongono sui primi due byte', () => {
    for (const f of MC7_FORMS) {
      expect(f.length, f.id).toBeGreaterThanOrEqual(0);
      expect(f.bytes.length, f.id).toBeLessThanOrEqual(Math.max(f.length, f.bytes.length));
      if (f.mask) expect(f.mask.length, f.id).toBe(f.bytes.length);
    }
    const claim = new Map<number, string[]>();
    for (const f of MC7_FORMS) {
      if (f.length === 0) continue; // CALL: macro, nessun byte propri
      for (let b0 = 0; b0 < 256; b0++) {
        const m0 = f.mask?.[0] ?? 0xff;
        if ((b0 & m0) !== f.bytes[0]) continue;
        for (let b1 = 0; b1 < 256; b1++) {
          if (f.bytes.length > 1) {
            const m1 = f.mask?.[1] ?? 0xff;
            if ((b1 & m1) !== f.bytes[1]) continue;
          }
          const k = (b0 << 8) | b1;
          const l = claim.get(k) ?? [];
          l.push(f.id);
          claim.set(k, l);
        }
      }
    }
    const dup = [...claim.entries()].filter(([, v]) => v.length > 1);
    expect(dup.map(([k, v]) => `${k.toString(16)}: ${v.join(',')}`)).toEqual([]);
  });

  it('encode → decode → encode identico per ogni forma (byte di esempio per ogni forma)', () => {
    const variants = [0x00, 0x01, 0x05, 0x22, 0x55, 0x7f, 0x80, 0xaa, 0xff];
    const exercised = new Set<number>();
    const nonCanonical = new Set<string>();
    MC7_FORMS.forEach((f, fi) => {
      if (f.length === 0) return;
      for (const v of variants) {
        for (const salt of [0, 1]) {
          const bytes: number[] = [];
          for (let i = 0; i < f.length; i++) {
            const free = i < f.bytes.length ? ~(f.mask?.[i] ?? 0xff) & 0xff : 0xff;
            const fill = (v + (salt ? i * 0x13 : 0)) & 0xff;
            bytes.push(((f.bytes[i] ?? 0) & ~free & 0xff) | (fill & free));
          }
          if (f.variable) {
            // gli ultimi due byte della forma base sono jjjj; poi i puntatori
            bytes[f.length - 2] = 0;
            bytes[f.length - 1] = 4;
            bytes.push(0x87, 0, 0, 8);
          }
          const code = Uint8Array.from(bytes);
          const r = decodeInstruction(code, 0);
          if ('raw' in r) continue;
          const g = matchForm(code, 0);
          expect(g?.id, hex(code)).toBe(r.stmt.id);
          exercised.add(fi);
          const again = reencode(r.stmt);
          if (r.stmt.nonCanonical) {
            nonCanonical.add(`${r.stmt.id} ${hex(code.subarray(0, r.length))}`);
            // la forma canonica si decodifica nello stesso testo e ricodifica a se stessa
            const r2 = decodeInstruction(again, 0);
            expect('raw' in r2, hex(code)).toBe(false);
            if (!('raw' in r2)) {
              expect(r2.stmt.text, hex(code)).toBe(r.stmt.text);
              expect(r2.stmt.nonCanonical, hex(code)).toBeFalsy();
              expect(hex(reencode(r2.stmt)), hex(code)).toBe(hex(again));
            }
          } else {
            expect(hex(again), `${r.stmt.text} <- ${hex(code)}`).toBe(
              hex(code.subarray(0, r.length)),
            );
          }
        }
      }
    });
    const notExercised = MC7_FORMS.filter((f, i) => f.length > 0 && !exercised.has(i)).map(
      (f) => `${f.id} ${hex(f.bytes)}`,
    );
    expect(notExercised).toEqual([]);
    console.log(
      `[opcodes] ${nonCanonical.size} byte di esempio non canonici (forma lunga/alternativa)`,
    );
  });
});

describe('decodeInstruction: vettori (mc7 §2)', () => {
  const vectors: [string, string][] = [
    ['80 05', 'A %M5.0'],
    ['83 0a', 'A %M10.3'],
    ['a2 05', 'AN %M5.2'],
    ['c2 14', 'A %I20.2'],
    ['c2 94', 'A %Q20.2'],
    ['98 10', '= %M16.0'],
    ['09 c3 00 07', 'R %DBX7.3'],
    ['41 60 00 00', '= %L0.0'],
    ['12 0a', 'L %MW10'],
    ['0a 05', 'L %MB5'],
    ['1a 04', 'L %MD4'],
    ['13 0a', 'T %MW10'],
    ['7e 42 00 04', 'L %DBW4'],
    ['7e 02 00 08', 'L %PIW8'],
    ['be 5e 00 70', 'T %DIW[AR2,P#14.0]'],
    ['be 32 00 08', 'L %MW[AR1,P#1.0]'],
    ['79 38 00 00', 'A %M[AR2,P#0.0]'],
    ['fb 05 00 00', 'T %B[AR1,P#0.0]'],
    ['51 33 00 0a', 'A %M[MD10]'],
    ['30 03 00 01', 'L 1'],
    ['30 03 ff ff', 'L -1'],
    ['30 07 12 34', 'L W#16#1234'],
    ['28 ff', 'L B#16#FF'],
    ['38 03 42 a0 00 00', 'L L#1117782016'],
    ['38 01 3f 80 00 00', 'L 1.0'],
    ['38 07 00 00 00 01', 'L DW#16#1'],
    ['30 0c 01 00', 'L S5T#1S'],
    ['30 0c 26 00', 'L S5T#10M'],
    ['30 02 00 05', 'L 2#0000_0000_0000_0101'],
    ['38 04 86 00 01 20', 'L P#L 36.0'],
    ['65 00', 'BE'],
    ['65 01', 'BEU'],
    ['05 00', 'BEC'],
    ['68 2d', 'NOT'],
    ['68 1d', 'SET'],
    ['21 80', '==I'],
    ['39 20', '>D'],
    ['31 40', '<R'],
    ['ff e0', 'A BR'],
    ['ff 11', 'AN OV'],
    ['10 01', 'BLD 1'],
    ['00 00', 'NOP 0'],
    ['ff ff', 'NOP 1'],
    ['fe 03 86 00 01 20', 'LAR1 P#L 36.0'],
    ['fe 04', 'LAR1'],
    ['fe 01', 'LAR1 AR2'],
    ['fe 63 00 10', 'LAR1 %LD16'],
    ['fe 4b 00 08', 'LAR2 %DBD8'],
    ['fb 79 00 02', 'OPN %DI2'],
    ['20 05', 'OPN %DB5'],
    ['fb 78 01 00', 'OPN %DB256'],
    ['fb 68 00 10', 'OPN %DB[LW16]'],
    ['58 00 00 05', '+ 5'],
    ['60 05 00 00 01 00', '+ L#256'],
    ['75 01', 'UC %FB1'],
    ['fb 76 00 00', 'UC %SFB0'],
    ['f8 05', 'A %T5'],
    ['fb e0 01 01', 'A %T257'],
    ['fb ec 01 01', 'SD %T257'],
    ['34 03', 'SP %T3'],
    ['6c 02', 'CU %C2'],
    ['3c 02', 'R %T2'],
    ['68 12', 'SLW'],
    ['61 03', 'SLW 3'],
    ['fe c5', 'SRD 5'],
    ['41 00', 'AW'],
    ['68 34 ff 00', 'AW W#16#FF00'],
    ['70 06', 'L STW'],
    ['fb 3c', 'L DBLG'],
    ['fb 7c', 'CDB'],
  ];
  it.each(vectors)('%s → %s', (h, text) => {
    const d = dec(h);
    expect(d.length).toBe(fromHex(h).length);
    expect(d.stmt.text).toBe(text);
    expect(d.stmt.nonCanonical).toBeFalsy();
    expect(hex(reencode(d.stmt))).toBe(hex(fromHex(h)));
    // il testo è nella forma canonica di formatNetwork
    if (!d.stmt.extended) {
      const line = `\t${d.stmt.text};`;
      expect(formatNetwork(line, 'international')).toBe(line);
    }
  });

  it('salti: spostamento in parole dall istruzione di salto (mc7 §2.4)', () => {
    // FC21: ff f8 00 1b a byte 46 → byte 100
    const code = new Uint8Array(60);
    code.set(fromHex('ff f8 00 1b'), 46);
    const r = decodeInstruction(code, 46);
    if ('raw' in r) throw new Error('raw');
    expect(r.length).toBe(4);
    expect(r.stmt.id).toBe('JC');
    expect(r.stmt.jumpTo).toBe(100);
    expect(r.stmt.jumpWords).toBe(0x1b);
    expect(hex(encodeJump('JC', 0x1b))).toBe('ff f8 00 1b');
    // all indietro
    const back = decodeInstruction(fromHex('00 00 70 0b ff fd'), 2);
    if ('raw' in back) throw new Error('raw');
    expect(back.stmt.jumpTo).toBe(2 - 6);
    expect(hex(encodeJump('JU', -3))).toBe('70 0b ff fd');
    expect(() => encodeJump('JU', 40000)).toThrow(RangeError);
    for (const [id, bytes] of [
      ['JU', '70 0b'],
      ['JL', '70 09'],
      ['JCN', 'ff b8'],
      ['JNB', 'ff 98'],
      ['JZ', 'ff 88'],
      ['LOOP', '70 08'],
      ['JOS', 'ff 08'],
    ] as const) {
      expect(hex(encodeJump(id, 1))).toBe(`${bytes} 00 01`);
    }
    // JL: jjjj = numero di voci, uscita a +4+4n
    const jl = decodeInstruction(fromHex('70 09 00 03'), 0);
    if ('raw' in jl) throw new Error('raw');
    expect(jl.stmt.jumpTo).toBe(4 + 12);
    expect(jl.stmt.jumpWords).toBe(3);
  });

  it('chiamate: UC FC con lista di puntatori (mc7 §2.5)', () => {
    const h = '3d 60 70 0b 00 04 87 00 00 08';
    const d = dec(h);
    expect(d.length).toBe(10);
    expect(d.stmt.text).toBe('UC %FC96');
    expect(d.stmt.pointers?.map((p) => hex(p))).toEqual(['87 00 00 08']);
    expect(hex(reencode(d.stmt))).toBe(h);
    // senza parametri
    const d0 = dec('3d 05 70 0b 00 02');
    expect(d0.length).toBe(6);
    expect(d0.stmt.pointers).toEqual([]);
    expect(hex(reencode(d0.stmt))).toBe('3d 05 70 0b 00 02');
    // ≥ 256 e SFC
    expect(dec('fb 70 01 f6 70 0b 00 06 87 00 00 08 87 00 00 10').length).toBe(16);
    expect(dec('fb 74 00 14 70 0b 00 02').stmt.text).toBe('UC %SFC20');
    expect(dec('1d 05 70 0b 00 02').stmt.text).toBe('CC %FC5');
    expect(dec('55 07').stmt.text).toBe('CC %FB7');
    // un UC senza JU, o con puntatori troncati, non si decodifica
    expect('raw' in decodeInstruction(fromHex('3d 05 00 00 00 00'), 0)).toBe(true);
    expect('raw' in decodeInstruction(fromHex('3d 05 70 0b 00 06 87 00'), 0)).toBe(true);
    // forma indiretta: testo esteso, riproduzione con encodeDecoded
    const ind = dec('fb 60 00 10 70 0b 00 02');
    expect(ind.length).toBe(8);
    expect(ind.stmt.extended).toBe(true);
    expect(hex(encodeDecoded(ind.stmt))).toBe('fb 60 00 10 70 0b 00 02');
  });

  it('parametri formali di FC: nome generato e risoluzione dal chiamante (mc7 §2.2.6)', () => {
    const d = dec('fb c2 00 04');
    expect(d.stmt.text).toBe('L #PAR1');
    expect(d.stmt.formal).toEqual({ name: 'PAR1', offset: 4, type: 'Word' });
    expect(hex(reencode(d.stmt))).toBe('fb c2 00 04');
    const uc = dec('fb d0 00 02 70 0b 00 02');
    expect(uc.stmt.text).toBe('UC #PAR0');
    expect(uc.stmt.formal?.type).toBe('Block_FC');
    expect(hex(reencode(uc.stmt))).toBe('fb d0 00 02 70 0b 00 02');
    expect(hex(reencode(dec('fb d2 00 06').stmt))).toBe('fb d2 00 06');
    // senza risolutore un locale è simbolico
    const p = parseNetwork('L #x;', 'international');
    expect(() => encodeInstruction(p.statements[0]!)).toThrow(/simbolico/);
    // con il risolutore
    const out = encodeInstruction(p.statements[0]!, {
      formal: (n) => (n === 'x' ? { offset: 2, type: 'DWord' } : undefined),
    });
    expect(hex(out)).toBe('fb c3 00 02');
  });
});

describe('codifica canonica e forme non uniche (mc7 §3.3)', () => {
  const enc = (src: string): string => {
    const p = parseNetwork(src, 'international');
    expect(p.errors, src).toEqual([]);
    return hex(encodeInstruction(p.statements[0]!));
  };

  it('forme corte dove esistono; la lunga solo se serve', () => {
    expect(enc('A %M5.0;')).toBe('80 05');
    expect(enc('A %M300.0;')).toBe('00 30 01 2c');
    expect(enc('A %I127.7;')).toBe('c7 7f');
    expect(enc('A %I128.0;')).toBe('00 10 00 80');
    expect(enc('A %Q3.1;')).toBe('c1 83');
    expect(enc('= %M2.1;')).toBe('99 02');
    expect(enc('L %MW10;')).toBe('12 0a');
    expect(enc('L %MW256;')).toBe('7e 32 01 00');
    expect(enc('L %IW10;')).toBe('52 0a');
    expect(enc('T %QB4;')).toBe('4b 84');
    expect(enc('OPN %DB5;')).toBe('20 05');
    expect(enc('OPN %DB256;')).toBe('fb 78 01 00');
    expect(enc('OPN %DI5;')).toBe('fb 79 00 05');
    expect(enc('A %T5;')).toBe('f8 05');
    expect(enc('A %T256;')).toBe('fb e0 01 00');
    expect(enc('A( ;')).toBe('ba 00');
    expect(enc('O( ;')).toBe('bb 00');
    expect(enc('UC %FC5;')).toBe('3d 05 70 0b 00 02');
    expect(enc('UC %FC300;')).toBe('fb 70 01 2c 70 0b 00 02');
    expect(enc('UC %FB5;')).toBe('75 05');
    expect(enc('UC %FB300;')).toBe('fb 72 01 2c');
    expect(enc('+ 5;')).toBe('58 00 00 05');
    expect(enc('+ L#5;')).toBe('60 05 00 00 00 05');
    expect(enc('L 5;')).toBe('30 03 00 05');
    expect(enc('L L#5;')).toBe('38 03 00 00 00 05');
    expect(enc('L B#16#5;')).toBe('28 05');
  });

  it('le forme alternative (non generate da STEP 7) si decodificano ma sono marcate', () => {
    const alt: [string, string, string][] = [
      ['00 30 00 05', 'A %M5.0', '80 05'],
      ['7e 32 00 0a', 'L %MW10', '12 0a'],
      ['fb 78 00 05', 'OPN %DB5', '20 05'],
      ['fb 70 00 05 70 0b 00 02', 'UC %FC5', '3d 05 70 0b 00 02'],
      ['fb 71 00 05 70 0b 00 02', 'CC %FC5', '1d 05 70 0b 00 02'],
      ['fb 72 00 05', 'UC %FB5', '75 05'],
      ['fb e0 00 05', 'A %T5', 'f8 05'],
      ['fb f0 00 05', 'A %C5', 'b8 05'],
    ];
    for (const [h, text, canon] of alt) {
      const d = dec(h);
      expect(d.stmt.text, h).toBe(text);
      expect(d.stmt.nonCanonical, h).toBe(true);
      expect(hex(reencode(d.stmt)), h).toBe(canon);
    }
    // costanti: tre sintassi, tre codifiche, tutte canoniche
    for (const h of ['30 03 00 05', '38 03 00 00 00 05', '28 05']) {
      expect(dec(h).stmt.nonCanonical).toBeFalsy();
    }
  });
});

describe('opcode sconosciuti e finestre troncate', () => {
  it('un opcode sconosciuto dà { raw } della lunghezza minima, mai un errore', () => {
    for (const h of ['fb 0c 00 00', '0f 00', '60 ff', '70 ff 00 00', 'ff 30']) {
      const r = decodeInstruction(fromHex(h), 0);
      expect('raw' in r, h).toBe(true);
      if ('raw' in r) {
        expect(r.length).toBeGreaterThanOrEqual(1);
        expect(r.length).toBeLessThanOrEqual(4);
        expect(hex(r.raw)).toBe(hex(fromHex(h).subarray(0, r.length)));
      }
    }
    for (const [h, n] of [
      ['fb ca 00 05 00 00', 4],
      ['fb cb 12 34 65 00', 4],
      ['fb d9 00 02 65 00', 4],
      ['fb d1 00 02 65 00', 4],
      ['fb 01 11 22 65 00', 4],
      ['fb 7d 11 22 65 00', 4],
      ['fb 3e 11 22 65 00', 4],
      ['ff 38 00 08 65 00', 4],
      ['70 ff 00 00 65 00', 2],
      ['fe 3a 12 34 65 00', 4],
      ['fe 7f 12 34 65 00', 2],
      ['68 ff 65 00', 2],
      ['60 05 00 00 00 01', 6],
    ] as const) {
      const r = decodeInstruction(fromHex(h), 0);
      // se è grezzo, la lunghezza è quella della famiglia; l'operando non è mai un'istruzione a sé
      if ('raw' in r) expect(r.length, h).toBe(n);
    }
    for (const h of ['fb ca 00 05', 'fb cb 12 34', 'fb d9 00 02', 'fb d1 00 02']) {
      const r = decodeInstruction(fromHex(h), 0);
      expect('raw' in r, h).toBe(true);
      expect(r.length, h).toBe(4);
    }
    const t = decodeInstruction(fromHex('7e'), 0);
    expect(t).toMatchObject({ length: 1 });
    expect('raw' in t).toBe(true);
    const t2 = decodeInstruction(fromHex('7e 42 00'), 0);
    expect('raw' in t2).toBe(true);
    expect(decodeInstruction(new Uint8Array(0), 0).length).toBe(0);
  });

  it('20000 finestre casuali (seme fisso): mai un errore, lunghezza ≥ 1', () => {
    let s = 0x2545f491;
    const rnd = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) & 0xff;
    };
    const interesting = [0x30, 0x38, 0x3d, 0x1d, 0x70, 0xfb, 0xfe, 0xff, 0x68, 0x60, 0x7e, 0xbe];
    let raws = 0;
    let stmts = 0;
    for (let n = 0; n < 20000; n++) {
      const len = 1 + (rnd() % 24);
      const w = Uint8Array.from({ length: len }, () => rnd());
      if (n % 2 === 0) w[0] = interesting[rnd() % interesting.length]!;
      if (n % 4 === 0 && len > 4) w[2] = 0x70;
      if (n % 4 === 0 && len > 4) w[3] = 0x0b;
      let r;
      try {
        r = decodeInstruction(w, 0);
      } catch (e) {
        throw new Error(`eccezione su ${hex(w)}: ${String(e)}`);
      }
      expect(r.length, hex(w)).toBeGreaterThanOrEqual(1);
      expect(r.length, hex(w)).toBeLessThanOrEqual(len);
      if ('raw' in r) raws++;
      else {
        stmts++;
        expect(r.stmt.text.length).toBeGreaterThan(0);
      }
    }
    console.log(`[opcodes] fuzz: ${stmts} istruzioni, ${raws} grezze`);
    expect(stmts).toBeGreaterThan(1000);
  });
});

describe('codifica: errori', () => {
  const stmt = (src: string) => parseNetwork(src, 'international').statements[0]!;
  it('operandi simbolici non risolti', () => {
    for (const src of ['A "Motor";', 'L #tmp;', 'A "DB".x;', 'L P##x;']) {
      expect(() => encodeInstruction(stmt(src)), src).toThrow(Mc7Error);
      try {
        encodeInstruction(stmt(src));
      } catch (e) {
        expect((e as Mc7Error).code).toBe('UNSUPPORTED');
        expect((e as Mc7Error).message).toMatch(/operando simbolico non risolto/);
      }
    }
  });
  it('salti senza spostamento e CALL', () => {
    expect(() => encodeInstruction(stmt('JU M001;'))).toThrow(/encodeJump/);
    expect(() => encodeInstruction(stmt('CALL FC 5;'))).toThrow(Mc7Error);
  });
  it('operando fuori forma', () => {
    expect(() => encodeInstruction(stmt('A %M70000.0;'))).toThrow(Mc7Error);
    expect(() => encodeInstruction(stmt('SLW 99;'))).toThrow(Mc7Error);
    expect(() => encodeInstruction(stmt('L 70000;'))).toThrow(Mc7Error);
  });
  it('accesso qualificato a un DB: OPN e istruzione', () => {
    expect(hex(encodeInstruction(stmt('L %DB10.DBW4;')))).toBe('20 0a 7e 42 00 04');
    expect(hex(encodeInstruction(stmt('A %DI3.DIX0.1;')))).toBe('fb 79 00 03 00 51 00 00');
  });
});

const PROTECTED_ONLY_FORMS = [
  'NOT 68 2d',
  'ITB 68 08',
  'NEGR 60 06',
  'RND 68 5c',
  '-R 60 0b',
  '*R 60 07',
  '/R 60 03',
  'BEU 65 01',
  'TAK 70 02',
  'LAR2 fe 0c',
  '<=I 21 c0',
  '>=R 31 a0',
  '<=R 31 c0',
  'A 79 50',
  'AN 79 51',
  'O 79 52',
  '= 79 d2',
  'L 7e 41',
  'L be 40',
  'T be 44',
  'L fb 3c',
];

describe('blocchi reali: decodifica e ricodifica (mc7 §3.4)', () => {
  const kinds = new Set(['OB', 'FC', 'FB', 'SFC', 'SFB']);
  const blocks = realBlocks()
    .map((b) => ({ b, f: readBlockFile(b.bytes) }))
    .filter(({ f }) => kinds.has(f.header.kind ?? '') && f.mc7.length > 0);

  it('tutte le istruzioni delle reti si decodificano senza grezzi e si ricodificano uguali', () => {
    if (blocks.length < 10) console.warn(`[opcodes] solo ${blocks.length} blocchi di codice`);
    let total = 0;
    const distinct = new Set<string>();
    const nonCanonical: string[] = [];
    let jumps = 0;
    const perBlock: string[] = [];
    for (const { b, f } of blocks) {
      const segs: [number, number][] = [];
      let o = 0;
      for (const n of f.add.networks) {
        segs.push([o, o + n]);
        o += n;
      }
      if (o < f.mc7.length) segs.push([o, f.mc7.length]); // BE finale fuori dalle reti, o blocco senza ADD
      let count = 0;
      for (const [a, z] of segs) {
        const code = f.mc7.subarray(a, z);
        let at = 0;
        while (at < code.length) {
          const r = decodeInstruction(code, at);
          if ('raw' in r) throw new Error(`${b.name}: grezzo a ${a + at}: ${hex(r.raw)}`);
          expect(r.length).toBeGreaterThan(0);
          const bytes = code.subarray(at, at + r.length);
          expect(at + r.length, `${b.name} @${a + at}`).toBeLessThanOrEqual(code.length);
          const key = hex(bytes);
          distinct.add(key);
          if (r.stmt.nonCanonical) nonCanonical.push(`${b.name}: ${key}`);
          if (r.stmt.jumpTo !== undefined) jumps++;
          expect(hex(reencode(r.stmt)), `${b.name} @${a + at}: ${r.stmt.text}`).toBe(key);
          at += r.length;
          count++;
        }
        expect(at, `${b.name}: rete ${a}..${z} consumata esattamente`).toBe(code.length);
      }
      total += count;
      perBlock.push(`${b.name}:${count}`);
    }
    console.log(
      `[opcodes] blocchi reali: ${blocks.length} blocchi di codice, ${total} istruzioni, ` +
        `${distinct.size} sequenze distinte, ${jumps} salti\n  ${perBlock.join(' ')}`,
    );
    expect(nonCanonical).toEqual([]);
    if (blocks.length >= 10) {
      expect(total).toBe(1422);
      expect(distinct.size).toBe(658);
    }
  });

  it('le forme viste nei blocchi reali sono tutte e sole quelle marcate verificate', ({ skip }) => {
    const seen = new Set<number>();
    for (const { f } of blocks) {
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
          const idx = MC7_FORMS.findIndex((x) => x === matchForm(code, at));
          if (idx >= 0) seen.add(idx);
          at += r.length;
        }
      }
    }
    if (blocks.length < 10) return skip();
    const verified = new Set(MC7_FORMS.map((f, i) => (f.verified ? i : -1)).filter((i) => i >= 0));
    const label = (i: number): string => `${MC7_FORMS[i]!.id} ${hex(MC7_FORMS[i]!.bytes)}`;
    expect([...seen].filter((i) => !verified.has(i)).map(label)).toEqual([]);
    // Forme viste solo in FB41 e FB80, protetti know-how: la spec li esclude dai test (non si
    // decodificano), quindi qui non compaiono. Restano `verified` per la ricerca (docs mc7 §5.1).
    expect([...verified].filter((i) => !seen.has(i)).map(label)).toEqual(PROTECTED_ONLY_FORMS);
    console.log(`[opcodes] forme verificate: ${verified.size}/${MC7_FORMS.length}`);
  });
});
