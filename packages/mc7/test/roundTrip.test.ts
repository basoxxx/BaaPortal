import { formatNetwork } from '@baaportal/awl';
import { fromHex } from './decodeHelpers';
import { describe, expect, it } from 'vitest';
import {
  addEquals,
  decodeCode,
  decodeInstruction,
  encodeCode,
  readBlockFile,
  type Mc7Add,
  type Mc7Diagnostic,
} from '../src';
import { hex } from './decodeHelpers';
import { realBlocks } from './realBlocks';

const codeKinds = new Set(['OB', 'FC', 'FB', 'SFC', 'SFB']);
const codeBlocks = realBlocks()
  .map((b) => ({ b, f: readBlockFile(b.bytes) }))
  .filter(({ f }) => codeKinds.has(f.header.kind ?? '') && f.mc7.length > 0);

describe('MC7 → AWL → MC7 sui blocchi reali (criterio del 1E)', () => {
  it('identico al byte, ADD compresa, su tutti i blocchi di codice', () => {
    if (codeBlocks.length < 10) console.warn(`[roundTrip] solo ${codeBlocks.length} blocchi`);
    const rows: string[] = [];
    for (const { b, f } of codeBlocks) {
      const d = decodeCode(f.mc7, f.add);
      const r = encodeCode(d.networks, d.meta);
      expect(r.diagnostics, b.name).toEqual([]);
      expect(hex(r.mc7), b.name).toBe(hex(f.mc7));
      expect(addEquals(r.add, f.add), `${b.name}: ADD`).toBe(true);
      rows.push(`${b.name}: ${f.mc7.length} byte, ${f.add.networks.length} reti, ADD identica`);
    }
    console.log(`[roundTrip] ${codeBlocks.length}/10 identici\n  ${rows.join('\n  ')}`);
    if (codeBlocks.length >= 10) expect(codeBlocks).toHaveLength(10);
  });

  it('blocco TIA con rete vuota finale (OB1)', ({ skip }) => {
    const ob1 = codeBlocks.find(({ b }) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name));
    if (!ob1) return skip();
    const d = decodeCode(ob1.f.mc7, ob1.f.add);
    expect(d.networks.at(-1)).toBe('');
    const r = encodeCode(d.networks, d.meta);
    expect(hex(r.mc7)).toBe(hex(ob1.f.mc7));
    expect(r.add.networks.at(-1)).toBe(0);
  });

  it('modifica di una rete di un blocco reale: la rete cambia, le altre tengono i byte', ({
    skip,
  }) => {
    const ob1 = codeBlocks.find(({ b }) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name));
    if (!ob1) return skip();
    const d = decodeCode(ob1.f.mc7, ob1.f.add);
    const nets = [...d.networks];
    expect(nets[2]).toContain('R %M0.0');
    nets[2] = nets[2]!.replace('R %M0.0', 'S %M0.0');
    const r = encodeCode(nets, d.meta);
    expect(r.diagnostics).toEqual([]);
    const back = decodeCode(r.mc7, r.add);
    expect(back.networks).toEqual(nets);
    // stesse lunghezze e stessi byte fuori dalla rete 3
    expect(r.add.networks).toEqual(ob1.f.add.networks);
    const start = ob1.f.add.networks.slice(0, 2).reduce((x, y) => x + y, 0);
    const end = start + ob1.f.add.networks[2]!;
    expect(hex(r.mc7.slice(0, start))).toBe(hex(ob1.f.mc7.slice(0, start)));
    expect(hex(r.mc7.slice(end))).toBe(hex(ob1.f.mc7.slice(end)));
    expect(hex(r.mc7.slice(start, end))).not.toBe(hex(ob1.f.mc7.slice(start, end)));
  });
});

/** Salti grezzi di un blocco: rete del salto, offset nella rete, rete e offset della destinazione. */
function rawJumps(
  d: ReturnType<typeof decodeCode>,
): { k: number; at: number; j: number; off: number }[] {
  const lens = d.meta.networkLengths!;
  const starts = lens.map((_, i) => lens.slice(0, i).reduce((x, y) => x + y, 0));
  const out: { k: number; at: number; j: number; off: number }[] = [];
  for (const r of d.meta.raws) {
    const dec = decodeInstruction(fromHex(r.bytes), 0);
    if (!('stmt' in dec) || dec.stmt.jumpTo === undefined) continue;
    const target = starts[r.network]! + r.offset + dec.stmt.jumpTo;
    let j = lens.findIndex((n, i) => n > 0 && target >= starts[i]! && target < starts[i]! + n);
    if (j < 0) j = lens.length - 1;
    out.push({ k: r.network, at: r.offset, j, off: target - starts[j]! });
  }
  return out;
}

describe('salti tra reti nei blocchi reali', () => {
  const decoded = codeBlocks.map(({ b, f }) => ({ b, d: decodeCode(f.mc7, f.add) }));
  it('FC100 non ha più salti grezzi: i salti tra reti sono etichette', ({ skip }) => {
    if (codeBlocks.length < 10) return skip();
    for (const { b, d } of decoded) expect(rawJumps(d), b.name).toEqual([]);
    for (const name of ['FC100']) {
      const d = decoded.find(({ b }) => b.name === name)!.d;
      // c'è almeno un salto la cui etichetta è definita in un'altra rete
      const defs = d.networks.map((t) => new Set([...t.matchAll(/^(\w+):/gm)].map((m) => m[1]!)));
      const cross = d.networks.some((t, k) =>
        [...t.matchAll(/\bJ\w*\s+(\w+)\s*;/g)].some((m) => !defs[k]!.has(m[1]!)),
      );
      expect(cross, name).toBe(true);
    }
  });
  it('modificare una rete qualunque (senza grezzi) riesce e si decodifica nel testo modificato', () => {
    let oks = 0;
    for (const { b, d } of decoded) {
      const hasRaw = (m: number): boolean => d.meta.raws.some((r) => r.network === m);
      for (let m = 0; m < d.networks.length; m++) {
        if (hasRaw(m)) continue;
        const nets = [...d.networks];
        nets[m] = nets[m] + (nets[m] === '' ? '\tNOP 0;' : '\n\tNOP 0;');
        const r = encodeCode(nets, d.meta);
        expect(
          r.diagnostics.filter((x) => x.severity === 'error'),
          `${b.name} rete ${m}`,
        ).toEqual([]);
        const back = decodeCode(r.mc7, r.add);
        expect(normalise(back.networks.join('\n')), `${b.name} rete ${m}`).toBe(
          normalise(nets.map((t) => formatNetwork(t, 'international')).join('\n')),
        );
        oks++;
      }
    }
    if (codeBlocks.length >= 10) expect(oks).toBeGreaterThan(0);
  });
});

// --- fuzz ---------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rinomina le etichette per ordine di definizione e toglie quelle che nessun salto usa. */
function normalise(text: string, referenced?: Set<string>): string {
  const defs: string[] = [];
  for (const m of text.matchAll(/^([A-Za-z_]\w*):/gm)) defs.push(m[1]!);
  const used =
    referenced ?? new Set([...text.matchAll(/\bJ\w*\s+([A-Za-z_]\w*)\s*;/g)].map((m) => m[1]!));
  const keep = defs.filter((n) => used.has(n));
  const names = new Map(keep.map((n, i) => [n, `L${i}`]));
  return text
    .split('\n')
    .map((line) => {
      let l = line.replace(/^([A-Za-z_]\w*):/, (_, n: string) =>
        names.has(n) ? `${names.get(n)}:` : '',
      );
      l = l.replace(
        /(\bJ\w*\s+)([A-Za-z_]\w*)(\s*;)/,
        (_, a: string, n: string, c: string) => `${a}${names.get(n) ?? n}${c}`,
      );
      return l;
    })
    .join('\n');
}

describe('fuzz: 1000 modifiche casuali a reti reali', () => {
  it('mai un’eccezione; o byte che si decodificano nel testo modificato, o errori senza byte', ({
    skip,
  }) => {
    const rand = rng(20261020);
    const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
    const decoded = codeBlocks.map(({ b, f }) => ({ b, f, d: decodeCode(f.mc7, f.add) }));
    if (decoded.length === 0) return skip();
    const pool: string[] = [];
    for (const { d } of decoded) {
      for (const n of d.networks) {
        for (const l of n.split('\n')) {
          const m = /^(?:\w+:)?\t(.*;)$/.exec(l);
          if (m && !/\bJ|LOOP|\/\/|#PAR/.test(m[1]!)) pool.push('\t' + m[1]!);
        }
      }
    }
    const extra = ['\tFOO %M0.0;', '\tA "Sym";', '\tA %M0.0', '\tCALL FC1;', '\tL 70000000000;'];
    let withBytes = 0;
    let withErrors = 0;
    let withWarnings = 0;
    let checkedRaw = 0;
    for (let i = 0; i < 1000; i++) {
      const { d } = pick(decoded);
      const k = Math.floor(rand() * d.networks.length);
      const lines = d.networks[k]! === '' ? [] : d.networks[k]!.split('\n');
      const isInsn = (l: string): boolean => !/^\s*\/\//.test(l);
      const idxs = lines.map((l, j) => (isInsn(l) ? j : -1)).filter((j) => j >= 0);
      const op = pick(['insert', 'delete', 'change', 'jump'] as const);
      let fresh = rand() < 0.04 ? pick(extra) : pick(pool);
      if (op === 'jump') {
        const labels = [...d.networks.join('\n').matchAll(/^(\w+):/gm)].map((m) => m[1]!);
        fresh = labels.length ? `\tJU ${pick(labels)};` : '\tJU M999;';
      }
      const at = idxs.length ? pick(idxs) : 0;
      if (op === 'delete' && idxs.length) lines.splice(at, 1);
      else if (op === 'change' && idxs.length) lines[at] = fresh;
      else lines.splice(at, 0, fresh);
      const nets = [...d.networks];
      nets[k] = lines.join('\n');
      let r: ReturnType<typeof encodeCode> | undefined;
      expect(() => {
        r = encodeCode(nets, d.meta);
      }, `caso ${i}`).not.toThrow();
      const res = r!;
      const errs = res.diagnostics.filter((x: Mc7Diagnostic) => x.severity === 'error');
      if (res.diagnostics.some((x) => x.severity === 'warning')) withWarnings++;
      if (errs.length) {
        withErrors++;
        expect(res.mc7.length, `caso ${i}`).toBe(0);
        const noAdd: Mc7Add = { networks: [], jumps: [], rest: new Uint8Array(0) };
        expect(addEquals(res.add, noAdd), `caso ${i}`).toBe(true);
        continue;
      }
      withBytes++;
      const back = decodeCode(res.mc7, res.add);
      expect(back.networks.length, `caso ${i}`).toBe(nets.length);
      // ogni salto grezzo congelato arriva alla stessa istruzione di destinazione
      const newStarts = res.add.networks.map((_, n) =>
        res.add.networks.slice(0, n).reduce((x, y) => x + y, 0),
      );
      for (const x of rawJumps(d)) {
        if (nets[x.k] !== d.networks[x.k]) continue;
        expect(nets[x.j], `caso ${i}: rete di destinazione`).toBe(d.networks[x.j]);
        const pos = newStarts[x.k]! + x.at;
        const dec = decodeInstruction(res.mc7, pos);
        expect('stmt' in dec && dec.stmt.jumpTo, `caso ${i}: salto grezzo`).toBe(
          newStarts[x.j]! + x.off,
        );
        checkedRaw++;
      }
      // etichette valide in tutto il blocco: si confrontano rinominate sul blocco intero
      const want = normalise(nets.map((t) => formatNetwork(t, 'international')).join('\n'));
      expect(normalise(back.networks.join('\n')), `caso ${i} (${op}: ${fresh})`).toBe(want);
    }
    console.log(
      `[fuzz] 1000 casi: ${withBytes} con byte, ${withErrors} con errori, ${withWarnings} con avvisi`,
    );
    console.log(`[fuzz] salti grezzi verificati dopo la decodifica: ${checkedRaw}`);
    expect(withBytes).toBeGreaterThan(300);
  });
});
