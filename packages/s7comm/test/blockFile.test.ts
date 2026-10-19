import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S7Error,
  buildBlockFile,
  encodeBlockTimestamp,
  fromHex,
  hex,
  parseBlockFile,
  type BlockHeader,
} from '../src';

/** Blocco reale (SDB 0, 216 byte) da cisa/snap7.pcap, vedi il commento in testa al file. */
const REAL = fromHex(
  readFileSync(join(__dirname, 'fixtures/snap7-sdb0-upload.hex'), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(''),
);

const T = { year: 2020, month: 5, day: 17, hour: 10, minute: 30, second: 15, ms: 250, weekday: 1 };

function header(over: Partial<BlockHeader> = {}): Parameters<typeof buildBlockFile>[0] {
  return {
    attr: 1,
    type: 'DB',
    number: 1,
    language: 5,
    flags: 1,
    security: 0,
    codeTime: T,
    interfaceTime: T,
    ssbLength: 0,
    addLength: 0,
    localDataLength: 0,
    mc7Length: 4,
    ...over,
  };
}

const FOOTER = {
  author: 'TWI',
  family: 'TestHMI',
  name: 'DATADB',
  version: '1.0',
  checksum: 0xc0df,
};

describe('parseBlockFile sul blocco reale caricato', () => {
  it('magic "pp", tipo e numero coerenti con il nome _0B00000A', () => {
    expect(hex(REAL.subarray(0, 2))).toBe('7070');
    const b = parseBlockFile(REAL);
    expect(b.header.type).toBe('SDB');
    expect(b.header.number).toBe(0);
    expect(b.header.language).toBe(7);
    expect(b.header.flags).toBe(2);
    expect(b.header.attr).toBe(3);
    expect(b.header.loadLength).toBe(216);
    expect(b.header.security).toBe(0x80000000);
    expect(b.header.mc7Length).toBe(144);
    expect(b.header.ssbLength).toBe(0);
    expect(hex(encodeBlockTimestamp(b.header.codeTime!))).toBe('003921002d98');
    expect(hex(encodeBlockTimestamp(b.header.interfaceTime!))).toBe('04ef6d80122c');
  });
  it("MC7 dalla lunghezza dell'header, nessuna sezione in mezzo, footer da 36 byte", () => {
    const b = parseBlockFile(REAL);
    expect(b.mc7.length).toBe(144);
    expect(hex(b.mc7)).toBe(hex(REAL.subarray(36, 180)));
    expect(b.rest.length).toBe(0);
    expect(b.footer).toMatchObject({ author: 'STEP 7 #', family: '', name: '', checksum: 0xd1cc });
    expect(b.header.loadLength).toBe(36 + b.mc7.length + b.rest.length + 36);
  });
  it('buildBlockFile(parse(x)) riproduce i byte reali', () => {
    const b = parseBlockFile(REAL);
    expect(hex(buildBlockFile(b.header, b.mc7, b.footer!, b.rest))).toBe(hex(REAL));
  });
  it("non modifica l'ingresso e restituisce copie", () => {
    const copy = REAL.slice();
    const b = parseBlockFile(copy);
    b.mc7.fill(0xee);
    expect(hex(copy)).toBe(hex(REAL));
  });
});

describe('buildBlockFile', () => {
  it("build → parse restituisce gli stessi campi e l'MC7", () => {
    const mc7 = Uint8Array.of(1, 2, 3, 4);
    const f = buildBlockFile(header(), mc7, FOOTER);
    const p = parseBlockFile(f);
    expect(p.header).toMatchObject({ ...header(), loadLength: 76, typeCode: 0x0a });
    expect(p.warnings).toEqual([]);
    expect(hex(p.mc7)).toBe('01020304');
    expect(p.footer).toMatchObject(FOOTER);
    expect(p.rest.length).toBe(0);
    expect(f.length).toBe(76);
  });
  it('con SSB e ADD: rest di ssb+add byte, loadLength = 36 + MC7 + rest + 36', () => {
    const mc7 = new Uint8Array(10).fill(7);
    const f = buildBlockFile(header({ ssbLength: 28, addLength: 20, mc7Length: 10 }), mc7, FOOTER);
    const p = parseBlockFile(f);
    expect(p.rest.length).toBe(48);
    expect(p.header.loadLength).toBe(36 + 10 + 48 + 36);
    expect(f.length).toBe(p.header.loadLength);
  });
  it('rest esplicito', () => {
    const rest = Uint8Array.of(9, 8, 7);
    const f = buildBlockFile(header({ ssbLength: 3 }), new Uint8Array(4), FOOTER, rest);
    expect(hex(parseBlockFile(f).rest)).toBe('090807');
  });
  it("mc7Length incoerente con l'MC7 dato: RangeError", () => {
    expect(() => buildBlockFile(header({ mc7Length: 5 }), new Uint8Array(4), FOOTER)).toThrow(
      RangeError,
    );
  });
  it('stringhe oltre 8 caratteri e versione non x.y: RangeError', () => {
    const m = new Uint8Array(4);
    expect(() => buildBlockFile(header(), m, { ...FOOTER, author: 'NOVECARAT' })).toThrow(
      RangeError,
    );
    expect(() => buildBlockFile(header(), m, { ...FOOTER, version: '1' })).toThrow(RangeError);
  });
});

describe('parseBlockFile su input rovinati', () => {
  it('ogni prefisso del blocco reale: footer null o S7Error PROTOCOL, mai altro', () => {
    for (let n = 0; n <= REAL.length; n++) {
      try {
        const b = parseBlockFile(REAL.subarray(0, n));
        if (n < REAL.length) expect(b.footer).toBeNull();
        else expect(b.footer).not.toBeNull();
        expect(n).toBeGreaterThanOrEqual(180);
      } catch (e) {
        expect(e).toBeInstanceOf(S7Error);
        expect((e as S7Error).code).toBe('PROTOCOL');
        expect(n).toBeLessThan(180);
      }
    }
  });
  it('magic sbagliato o MC7 oltre la fine: PROTOCOL', () => {
    const bad = (mut: (b: Uint8Array) => void): void => {
      const b = REAL.slice();
      mut(b);
      expect(() => parseBlockFile(b)).toThrow(S7Error);
    };
    bad((b) => (b[0] = 0x71));
    bad((b) => (b[34] = 0xff));
  });
  it('con meno di 36 byte restano i byte, nessun altro errore', () => {
    expect(() => parseBlockFile(new Uint8Array(0))).toThrow(S7Error);
    expect(() => parseBlockFile(REAL.subarray(0, 35))).toThrow(S7Error);
  });
  it('coda tra MC7 e footer più corta di 36: footer null e rest con i byte', () => {
    const b = parseBlockFile(REAL.subarray(0, 190));
    expect(b.footer).toBeNull();
    expect(b.rest.length).toBe(10);
  });
});

describe('parseBlockFile tollerante: campi strani si conservano e si ricostruiscono esatti', () => {
  const mc7 = Uint8Array.of(1, 2, 3, 4);
  const exact = (bytes: Uint8Array) => {
    const p = parseBlockFile(bytes);
    expect(hex(buildBlockFile(p.header, p.mc7, p.footer, p.rest))).toBe(hex(bytes));
    return p;
  };
  const base = (): Uint8Array => buildBlockFile(header(), mc7, FOOTER);

  it.each([0x00, 0x42, 0xff])('byte di tipo 0x%s: type undefined, typeCode grezzo', (code) => {
    const b = base();
    b[5] = code;
    const p = exact(b);
    expect(p.header.type).toBeUndefined();
    expect(p.header.typeCode).toBe(code);
    expect(p.warnings.length).toBe(1);
  });
  it('timestamp non valido (ms = 0xFFFFFFFF): undefined, byte grezzi', () => {
    const b = base();
    b.fill(0xff, 16, 20);
    const p = exact(b);
    expect(p.header.codeTime).toBeUndefined();
    expect(hex(p.header.codeTimeRaw)).toBe(hex(b.subarray(16, 22)));
    expect(p.header.interfaceTime).toBeDefined();
    b.fill(0xff, 22, 26);
    expect(exact(b).header.interfaceTime).toBeUndefined();
  });
  it('security 3 (know-how protect)', () => {
    const b = base();
    b[15] = 3;
    const p = exact(b);
    expect(p.header.security).toBe(3);
    expect(p.warnings).toEqual([]);
  });
  it('footer di soli 0xFF', () => {
    const b = base();
    b.fill(0xff, b.length - 36);
    const p = exact(b);
    expect(p.footer).not.toBeNull();
    expect(p.footer!.checksum).toBe(0xffff);
    expect(p.footer!.version).toBe('15.15');
  });
  it('loadLength diverso dal file: avviso e byte identici', () => {
    const b = base();
    b[11] = 0x99;
    const p = exact(b);
    expect(p.warnings.some((w) => w.includes('loadLength'))).toBe(true);
  });
  it('coda corta (footer null): avviso e ricostruzione esatta', () => {
    const p = exact(base().subarray(0, 36 + 4 + 10));
    expect(p.footer).toBeNull();
    expect(p.warnings.length).toBeGreaterThan(0);
  });
  it('rest di lunghezza diversa da SSB+ADD: avviso', () => {
    const b = buildBlockFile(header(), mc7, FOOTER, Uint8Array.of(1, 2, 3));
    expect(exact(b).warnings.some((w) => w.includes('SSB'))).toBe(true);
  });
  it('sui blocchi reali nessun avviso', () => {
    expect(parseBlockFile(REAL).warnings).toEqual([]);
  });
});
