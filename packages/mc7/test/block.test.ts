import { describe, expect, it } from 'vitest';
import { type DataType } from '@baaportal/s7-types';
import {
  blockChecksum,
  compileBlock,
  decodeBlock,
  encodeBlock,
  Mc7Error,
  readBlockFile,
  type Mc7Block,
} from '../src';
import { emptySections, toAwlIface } from './compileHelpers';
import { hex } from './decodeHelpers';
import { realBlocks } from './realBlocks';

const all = realBlocks().map((b) => ({ ...b, f: readBlockFile(b.bytes) }));
const supported = all.filter(({ f }) => f.header.kind !== 'SDB');
const same = (a: Uint8Array, b: Uint8Array): boolean => hex(a) === hex(b);

describe('blocchi completi (Task 6)', () => {
  it('encodeBlock(decodeBlock(x)) identico per i blocchi reali di codice e DB', () => {
    const rows: string[] = [];
    for (const { name, bytes } of supported) {
      const b = decodeBlock(bytes);
      expect(same(encodeBlock(b), bytes), name).toBe(true);
      rows.push(`${name}: identico`);
    }
    console.log(`[block] ${supported.length}/23 identici\n  ${rows.join('\n  ')}`);
    if (all.length >= 31) expect(supported).toHaveLength(23);
  });

  it('gli SDB danno UNSUPPORTED', () => {
    for (const { bytes, f } of all.filter(({ f }) => f.header.kind === 'SDB')) {
      expect(() => decodeBlock(bytes)).toThrow(Mc7Error);
      try {
        decodeBlock(bytes);
      } catch (e) {
        expect((e as Mc7Error).code).toBe('UNSUPPORTED');
      }
      expect(f.header.kind).toBe('SDB');
    }
  });

  it('cambiare una costante in OB1: checksum = blockChecksum del nuovo MC7', ({ skip }) => {
    const ob1 = supported.find(({ name }) => /^OB1 \(.*tia_s300_downloadOb1/.test(name));
    if (!ob1) return skip();
    const b = decodeBlock(ob1.bytes);
    const nets = [...b.networks!];
    const idx = nets.findIndex((n) => n.includes('L L#1117782016;'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const edited = nets[idx]!.replace('L L#1117782016;', 'L L#1117782017;');
    nets[idx] = edited;
    const out = encodeBlock({ ...b, networks: nets });
    const f = readBlockFile(out);
    const expected = blockChecksum(f.header.kindCode, f.mc7);
    expect(f.footer.checksum).toBe(expected);
    expect(edited).not.toBe(b.networks![idx]);
    expect(f.footer.checksum).not.toBe(b.meta.checksum);
    expect(decodeBlock(out).networks![idx]).toBe(edited);
  });

  it('cambiare una costante intera: il testo ricodificato è quello modificato', ({ skip }) => {
    const ob1 = supported.find(({ name }) => /^OB1 \(.*tia_s300_downloadOb1/.test(name));
    if (!ob1) return skip();
    const b = decodeBlock(ob1.bytes);
    const nets = [...b.networks!];
    nets[2] = nets[2]!.replace('R %M0.0', 'S %M0.0');
    const out = encodeBlock({ ...b, networks: nets });
    const f = readBlockFile(out);
    expect(f.footer.checksum).toBe(blockChecksum(f.header.kindCode, f.mc7));
    expect(f.footer.checksum).not.toBe(b.meta.checksum);
    expect(decodeBlock(out).networks).toEqual(nets);
  });

  it('DB: valore attuale cambiato ricalcola il CRC; invariato conserva l’originale', ({ skip }) => {
    const dbs = supported.filter(({ f }) => f.header.kind === 'DB' && f.mc7.length > 0);
    if (dbs.length === 0) return skip();
    let tested = 0;
    for (const { name, bytes } of dbs) {
      const b = decodeBlock(bytes);
      expect(b.data).toBeDefined();
      expect(b.meta.checksum, name).toBe(readBlockFile(bytes).footer.checksum);
      const data = Uint8Array.from(b.data!);
      data[0] = data[0]! ^ 0xff;
      const out = encodeBlock({ ...b, data });
      const f = readBlockFile(out);
      expect(f.footer.checksum, name).toBe(blockChecksum(f.header.kindCode, f.mc7));
      expect(decodeBlock(out).data![0]).toBe(data[0]);
      // rimettendo il valore originale si ritorna ai byte originali
      expect(same(encodeBlock({ ...b, data: b.data! }), bytes), name).toBe(true);
      tested++;
    }
    expect(tested).toBe(dbs.length);
  });

  it('DB di istanza: legame con l’FB', ({ skip }) => {
    const decoded = supported.map(({ name, bytes }) => ({ name, b: decodeBlock(bytes) }));
    const dbs = decoded.filter(({ b }) => b.kind === 'DB');
    const inst = dbs.filter(({ b }) => b.instanceOf !== undefined);
    if (dbs.some(({ name }) => name === 'DB1806')) {
      expect(inst.map(({ name }) => name)).toEqual(['DB1806']);
      expect(inst[0]!.b.instanceOf).toEqual({ kind: 'FB', number: 1806 });
      expect(dbs.filter(({ b }) => b.instanceOf === undefined)).toHaveLength(dbs.length - 1);
    }
    const db = supported.map(({ bytes }) => decodeBlock(bytes)).find((b) => b.kind === 'DB');
    if (!db) return skip();
    const head = Uint8Array.from(db.iface.header);
    head[0] = 0x0a;
    head[1] = 31;
    head[2] = 0;
    const synth = encodeBlock({ ...db, iface: { ...db.iface, header: head } });
    const d1 = decodeBlock(synth);
    expect(d1.instanceOf).toEqual({ kind: 'FB', number: 31 });
    const d2 = decodeBlock(encodeBlock({ ...d1, instanceOf: { kind: 'FB', number: 32 } }));
    expect(d2.instanceOf).toEqual({ kind: 'FB', number: 32 });
    const gl = supported.map(({ bytes }) => decodeBlock(bytes)).find((b) => b.kind === 'DB');
    if (gl && !gl.instanceOf) {
      const f = encodeBlock({ ...gl, instanceOf: { kind: 'FB', number: 7 } });
      // un DB globale non ha legame: il campo non si applica
      expect(f.length).toBe(encodeBlock(gl).length);
    }
  });

  it('know-how (spec): un blocco nostro protetto si legge solo nell’interfaccia e torna identico', () => {
    const el = (name: string): DataType => ({ kind: 'elementary', name }) as DataType;
    const sections = emptySections({
      in: [{ name: 'Start', type: el('Bool') }],
      out: [{ name: 'Ok', type: el('Bool') }],
    });
    const mk = (knowHowProtected: boolean) =>
      compileBlock({
        kind: 'FB',
        number: 7,
        knowHowProtected,
        header: { author: 'Diego', family: 'Prove', name: 'Prot', version: '0.1' },
        sections,
        initials: {},
        networks: ['\tA #Start;\n\t= #Ok;'],
        ctx: {
          owner: { kind: 'FB', iface: toAwlIface(sections) },
          symbol: () => undefined,
          block: () => undefined,
          resolve: () => null,
          allSymbols: () => [],
          allBlocks: () => [],
        },
        now: new Date(2026, 9, 20, 10, 30, 15, 250),
      });
    const open = mk(false);
    const prot = mk(true);
    expect(open.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(prot.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(readBlockFile(prot.file!).header.raw[15]).toBe(3);
    // un blocco non protetto si decodifica nel codice
    expect(decodeBlock(open.file!).networks).toHaveLength(1);
    const b = decodeBlock(prot.file!);
    expect(b.knowHowProtected).toBe(true);
    // il codice non si decodifica né si conserva; l'interfaccia sì
    expect(b.networks).toBeUndefined();
    expect(b.meta.code).toBeUndefined();
    expect(b.iface.elements.map((e) => e.section)).toEqual(['in', 'out']);
    expect(b.diagnostics?.map((d) => [d.severity, d.code])).toEqual([
      ['info', 'BLOCCO_PROTETTO_KNOW_HOW'],
    ]);
    // byte originali conservati: identico al byte
    expect(b.exact).toBe(true);
    expect(same(encodeBlock(b), prot.file!)).toBe(true);
    // togliere la protezione non è possibile senza reti da ricodificare
    expect(() => encodeBlock({ ...b, knowHowProtected: false })).toThrow();
  });

  it('campi dell’header e del footer: si cambia solo ciò che si tocca', ({ skip }) => {
    const r = supported[0];
    if (!r) return skip();
    const b = decodeBlock(r.bytes);
    const out = encodeBlock({
      ...b,
      number: 77,
      header: { ...b.header, name: 'ABC', version: '1.2' },
    });
    const f = readBlockFile(out);
    expect(f.header.number).toBe(77);
    expect(f.footer.name).toBe('ABC');
    expect(f.footer.version).toBe('1.2');
    expect(f.footer.checksum).toBe(b.meta.checksum);
  });

  it('errore di compilazione: Mc7Error COMPILE con diagnostics', ({ skip }) => {
    const r = supported.find(({ f }) => f.header.kind === 'OB');
    if (!r) return skip();
    const b = decodeBlock(r.bytes);
    const nets = [...b.networks!];
    nets[0] = 'QUESTA NON E AWL;';
    try {
      encodeBlock({ ...b, networks: nets });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Mc7Error);
      expect((e as Mc7Error).code).toBe('COMPILE');
      expect(
        ((e as Mc7Error & { diagnostics: unknown[] }).diagnostics as unknown[]).length,
      ).toBeGreaterThan(0);
    }
  });

  it('blocco leggibile ma non ricodificabile: exact=false, byte originali, modifica rifiutata', ({
    skip,
  }) => {
    if (supported.length === 0) return skip();
    let found = 0;
    for (let i = 0; i < 4000 && found === 0; i++) {
      const src = supported[i % supported.length]!.bytes;
      const bytes = Uint8Array.from(src);
      const at = 36 + ((i * 7919) % (bytes.length - 72));
      bytes[at] = bytes[at]! ^ 0x55;
      let b: Mc7Block;
      try {
        b = decodeBlock(bytes);
      } catch {
        continue;
      }
      if (b.exact) continue;
      found++;
      expect(b.warnings.length).toBeGreaterThan(0);
      expect(same(encodeBlock(b), bytes)).toBe(true);
      expect(() => encodeBlock({ ...b, number: b.number + 1 })).toThrow(/modifiche non possibili/);
      try {
        encodeBlock({ ...b, number: b.number + 1 });
      } catch (e) {
        expect((e as Mc7Error).code).toBe('UNSUPPORTED');
      }
    }
    expect(found).toBe(1);
  });

  it('fuzz: 1000 mutazioni seminate dei blocchi reali', ({ skip }) => {
    if (supported.length === 0) return skip();
    let s = 0x1e6a5eed;
    const rnd = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let decoded = 0;
    for (let i = 0; i < 1000; i++) {
      const src = supported[Math.floor(rnd() * supported.length)]!.bytes;
      const bytes = Uint8Array.from(src);
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
      }
      let b: Mc7Block;
      try {
        b = decodeBlock(bytes);
      } catch (e) {
        expect(e instanceof Mc7Error || e instanceof RangeError, String(e)).toBe(true);
        continue;
      }
      decoded++;
      expect(same(encodeBlock(b), bytes), `mutazione ${i}`).toBe(true);
    }
    console.log(`[block] fuzz: ${decoded}/1000 decodificati e ricodificati identici`);
  });
});
