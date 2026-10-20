import { describe, expect, it } from 'vitest';
import { Mc7Error, blockChecksum, readBlockFile, writeBlockFile } from '../src';
import { realBlocks } from './realBlocks';

const byName = (re: RegExp) => realBlocks().find((b) => re.test(b.name));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('file di blocco S7-300 (mc7 §1)', () => {
  it('ogni blocco reale disponibile: writeBlockFile(readBlockFile(x)) identico', () => {
    const blocks = realBlocks();
    const lines: string[] = [];
    for (const b of blocks) {
      const f = readBlockFile(b.bytes);
      const again = writeBlockFile(f);
      expect(hex(again), b.name).toBe(hex(b.bytes));
      lines.push(`${b.name} ${b.bytes.length} B OK`);
    }
    console.log(`[roundtrip] ${blocks.length}/31\n${lines.join('\n')}`);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some((b) => /^SDB/.test(b.name) || /SDB/.test(b.name))).toBe(true);
  });

  it('lunghezze come in §1.1 e campi dell’header', () => {
    for (const b of realBlocks()) {
      const f = readBlockFile(b.bytes);
      expect(36 + f.mc7.length + f.ssb.length + f.addRaw.length + 36, b.name).toBe(b.bytes.length);
      expect(f.header.mc7Length).toBe(f.mc7.length);
      expect(f.header.ssbLength).toBe(f.ssb.length);
      expect(f.header.addLength).toBe(f.addRaw.length);
      expect(f.header.raw.length).toBe(36);
      expect(f.footer.raw.length).toBe(36);
    }
  });

  it('OB1 TIA reale: header e footer', ({ skip }) => {
    const b = byName(/^OB1 \(.*tia_s300_downloadOb1/);
    if (!b) return skip();
    const f = readBlockFile(b.bytes);
    expect(f.header).toMatchObject({
      kind: 'OB',
      kindCode: 0x08,
      number: 1,
      language: 3,
      flags: 1,
      knowHowProtected: false,
      mc7Length: 212,
      ssbLength: 28,
      addLength: 20,
      localDataLength: 26,
    });
    expect(hex(f.header.codeTime)).toBe('04d1d4e02dce');
    expect(hex(f.header.interfaceTime)).toBe('03a16383' + '21a7');
    expect(blockChecksum(f.header.kindCode, f.mc7)).toBe(0x5935);
    expect(f.footer.checksum).toBe(0x5935);
  });

  it('know-how: header[15] = 3 riconosciuto, il byte grezzo si conserva', () => {
    const any = realBlocks()[0]!;
    const f = readBlockFile(any.bytes);
    expect(f.header.knowHowProtected).toBe(false);
    f.header.knowHowProtected = true;
    const w = writeBlockFile(f);
    expect(w[15]).toBe(3);
    expect(readBlockFile(w).header.knowHowProtected).toBe(true);
    f.header.knowHowProtected = false;
    expect(writeBlockFile(f)[15]).toBe(0);
  });

  it('byte 15 con un valore diverso da 3 si conserva grezzo', () => {
    const src = Uint8Array.from(realBlocks()[0]!.bytes);
    src[15] = 0x7f;
    const f = readBlockFile(src);
    expect(f.header.knowHowProtected).toBe(false);
    expect(hex(writeBlockFile(f))).toBe(hex(src));
  });

  it('tipo ignoto: kind undefined con kindCode, nessun errore', () => {
    const src = Uint8Array.from(realBlocks()[0]!.bytes);
    src[5] = 0x55;
    const f = readBlockFile(src);
    expect(f.header.kind).toBeUndefined();
    expect(f.header.kindCode).toBe(0x55);
    expect(hex(writeBlockFile(f))).toBe(hex(src));
  });

  it('il writer cambia solo i campi che il chiamante ha cambiato', () => {
    const b = realBlocks()[0]!;
    const f = readBlockFile(b.bytes);
    f.header.number = 77;
    f.header.localDataLength = 12;
    f.footer.name = 'ABC';
    f.footer.version = '2.5';
    const out = writeBlockFile(f);
    const diffs: number[] = [];
    out.forEach((v, i) => v !== b.bytes[i] && diffs.push(i));
    expect(diffs.every((i) => i < 36 || i >= out.length - 36)).toBe(true);
    expect(diffs.every((i) => (i < 36 ? [6, 7, 32, 33].includes(i) : true))).toBe(true);
    const g = readBlockFile(out);
    expect(g.header.number).toBe(77);
    expect(g.header.localDataLength).toBe(12);
    expect(g.footer.name).toBe('ABC');
    expect(g.footer.version).toBe('2.5');
    expect(g.footer.author).toBe(f.footer.author);
  });

  it('cambiando le lunghezze delle sezioni, header e L seguono', () => {
    const f = readBlockFile(realBlocks()[0]!.bytes);
    f.mc7 = new Uint8Array([0x65, 0x00]);
    const g = readBlockFile(writeBlockFile(f));
    expect(g.header.mc7Length).toBe(2);
    expect(g.mc7.length).toBe(2);
  });

  it('errori di struttura: Mc7Error FORMAT', () => {
    const good = Uint8Array.from(realBlocks()[0]!.bytes);
    const fmt = (b: Uint8Array): void => {
      try {
        readBlockFile(b);
        throw new Error('non ha lanciato');
      } catch (e) {
        expect(e).toBeInstanceOf(Mc7Error);
        expect((e as Mc7Error).code).toBe('FORMAT');
      }
    };
    fmt(new Uint8Array(0));
    fmt(good.subarray(0, 71));
    fmt(good.subarray(0, good.length - 1)); // L non coincide con il file
    const badMagic = Uint8Array.from(good);
    badMagic[0] = 0x71;
    fmt(badMagic);
    const badLen = Uint8Array.from(good);
    badLen[35] = (badLen[35]! + 2) & 0xff; // M non coerente con L
    fmt(badLen);
  });

  it('5000 buffer casuali: solo Mc7Error o RangeError', () => {
    let seed = 0x1e5eed;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const base = realBlocks().map((b) => b.bytes);
    let parsed = 0;
    for (let i = 0; i < 5000; i++) {
      let buf: Uint8Array;
      const mode = i % 3;
      if (mode === 0) {
        buf = Uint8Array.from({ length: Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256));
      } else {
        // un blocco reale mutato o troncato: arriva più in profondità
        const src = base[Math.floor(rnd() * base.length)]!;
        buf = Uint8Array.from(
          src.subarray(0, mode === 1 ? src.length : Math.floor(rnd() * src.length)),
        );
        for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
          if (buf.length) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256);
        }
      }
      try {
        const f = readBlockFile(buf);
        parsed++;
        // quando si legge, si riscrive identico
        expect(hex(writeBlockFile(f))).toBe(hex(buf));
      } catch (e) {
        if (!(e instanceof Mc7Error) && !(e instanceof RangeError)) throw e;
      }
    }
    expect(parsed).toBeGreaterThan(0);
  });
});
