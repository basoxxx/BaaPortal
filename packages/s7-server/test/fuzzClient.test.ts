import { describe, expect, it } from 'vitest';
import {
  S7Client,
  S7Error,
  memoryTransportPair,
  type BlockType,
  type Transport,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve } from '../src';
import { blockFile, seq } from './helpers';

/** Generatore deterministico (mulberry32): un fallimento si ripete con lo stesso seme. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world(): FakeCpu {
  const cpu = new FakeCpu({
    clock: () => ({
      year: 2026,
      month: 10,
      day: 20,
      hour: 1,
      minute: 2,
      second: 3,
      ms: 4,
      weekday: 3,
    }),
  });
  cpu.addDb(1, seq(1500, 5));
  cpu.addDb(2, seq(30));
  cpu.addBlock(blockFile('OB', 1, seq(70)));
  cpu.addBlock(blockFile('FC', 5, seq(20)));
  cpu.setMemory('M', 0, seq(400, 2));
  for (let i = 0; i < 12; i++) {
    cpu.addDiagnostic({
      eventId: 0x4300 + i,
      info: new Uint8Array(10).fill(i),
      time: { year: 2025, month: 1, day: 2, hour: 3, minute: 4, second: i, ms: 5, weekday: 5 },
    });
  }
  return cpu;
}

const TYPES: BlockType[] = ['OB', 'DB', 'SDB', 'FC', 'SFC', 'FB', 'SFB'];

const METHODS: { name: string; run(c: S7Client, r: () => number): Promise<unknown> }[] = [
  { name: 'identity', run: (c) => c.identity() },
  { name: 'mode', run: (c) => c.mode() },
  { name: 'protection', run: (c) => c.protection() },
  { name: 'communication', run: (c) => c.communication() },
  { name: 'diagnosticBuffer', run: (c) => c.diagnosticBuffer() },
  {
    name: 'readSzl',
    run: (c, r) => c.readSzl([0x0000, 0x0011, 0x001c, 0x00a0][Math.floor(r() * 4)]!, 0),
  },
  { name: 'blockCounts', run: (c) => c.blockCounts() },
  { name: 'listBlocks', run: (c, r) => c.listBlocks(TYPES[Math.floor(r() * TYPES.length)]!) },
  { name: 'blockInfo', run: (c, r) => c.blockInfo(r() < 0.5 ? 'DB' : 'OB', 1) },
  { name: 'readClock', run: (c) => c.readClock() },
  {
    name: 'readItems',
    run: (c) =>
      c.readItems([
        { area: 'M', db: 0, start: 0, size: 'BYTE', count: 4 },
        { area: 'DB', db: 2, start: 0, size: 'WORD', count: 3 },
        { area: 'M', db: 0, start: 1, bit: 3, size: 'BIT', count: 1 },
      ]),
  },
  { name: 'readArea', run: (c) => c.readArea('DB', 1, 0, 1500) },
  { name: 'upload', run: (c) => c.upload('DB', 1) },
  { name: 'uploadWithInfo', run: (c) => c.uploadWithInfo('OB', 1) },
];

const HDR = 7; // TPKT (4) + COTP DT (3)

/** TPKT valido attorno a un payload qualunque. */
function tpkt(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 3;
  out[2] = (out.length >> 8) & 0xff;
  out[3] = out.length & 0xff;
  out.set(payload, 4);
  return out;
}

/** Un frame del finto PLC, rovinato in uno dei modi di sotto. `undefined` = non consegnarlo. */
function mutate(frame: Uint8Array, r: () => number): Uint8Array[] | undefined {
  const pick = r();
  const f = frame.slice();
  const n = f.length;
  const at = (lo: number): number => lo + Math.floor(r() * Math.max(n - lo, 1));
  if (pick < 0.2) return [f]; // intatto
  if (pick < 0.4) {
    // qualche byte cambiato, nel payload
    for (let k = 1 + Math.floor(r() * 4); k > 0; k--) f[at(4)] = Math.floor(r() * 256);
    return [f];
  }
  if (pick < 0.5) {
    // payload troncato, TPKT coerente
    return [tpkt(f.subarray(4, 4 + Math.floor(r() * (n - 4))))];
  }
  if (pick < 0.58) {
    // byte in più in coda, TPKT coerente
    const extra = Uint8Array.from({ length: 1 + Math.floor(r() * 20) }, () =>
      Math.floor(r() * 256),
    );
    const out = new Uint8Array(n + extra.length);
    out.set(f);
    out.set(extra, n);
    return [tpkt(out.subarray(4))];
  }
  if (pick < 0.66) {
    // payload tutto a caso
    return [tpkt(Uint8Array.from({ length: Math.floor(r() * 120) }, () => Math.floor(r() * 256)))];
  }
  if (pick < 0.71) {
    // byte a caso con un TPKT che non lo è
    return [Uint8Array.from({ length: 1 + Math.floor(r() * 60) }, () => Math.floor(r() * 256))];
  }
  if (pick < 0.77 && n > HDR + 8) {
    f[HDR + 4] = Math.floor(r() * 256); // pduRef sbagliato
    f[HDR + 5] = Math.floor(r() * 256);
    return [f];
  }
  if (pick < 0.82 && n > HDR + 2) {
    f[HDR + 1] = [0, 1, 2, 3, 7, 9, 0xff][Math.floor(r() * 7)]!; // ROSCTR diverso
    return [f];
  }
  if (pick < 0.88 && n > HDR + 10) {
    // lunghezze di parametro e dati dell'header sbagliate
    f[HDR + 6] = Math.floor(r() * 256);
    f[HDR + 7] = Math.floor(r() * 256);
    f[HDR + 8] = Math.floor(r() * 256);
    f[HDR + 9] = Math.floor(r() * 256);
    return [f];
  }
  if (pick < 0.92) return undefined; // risposta persa
  if (pick < 0.95) return [f, f.slice()]; // doppia
  // a pezzi di lunghezza casuale (valido: deve funzionare)
  const parts: Uint8Array[] = [];
  for (let o = 0; o < n;) {
    const len = 1 + Math.floor(r() * 9);
    parts.push(f.slice(o, o + len));
    o += len;
  }
  return parts;
}

/** `only`: si rovina soltanto la risposta numero `only` (dopo CC e setup); senza, tutte. */
function hostile(cpu: FakeCpu, r: () => number, only?: number): TransportFactory {
  return async () => {
    const [fakeEnd, serverEnd] = memoryTransportPair();
    serve(cpu, serverEnd);
    let dataCb: ((c: Uint8Array) => void) | undefined;
    let closeCb: ((e?: Error) => void) | undefined;
    let frames = 0;
    fakeEnd.onData((chunk) => {
      frames++;
      if (frames <= 2) return void dataCb?.(chunk); // CC e risposta al setup: integri
      if (only !== undefined && frames - 2 !== only) return void dataCb?.(chunk);
      for (const part of mutate(chunk, r) ?? []) dataCb?.(part);
    });
    fakeEnd.onClose((e) => closeCb?.(e));
    const t: Transport = {
      send: (b) => fakeEnd.send(b),
      onData: (cb) => {
        dataCb = cb;
      },
      onClose: (cb) => {
        closeCb = cb;
      },
      close: () => fakeEnd.close(),
    };
    return t;
  };
}

describe('fuzz: 2000 risposte rovinate verso il client', () => {
  it(
    'solo S7Error, nessuna sospensione, il timeout è rispettato',
    { timeout: 120_000 },
    async () => {
      const cpu = world();
      const timeoutMs = 40;
      const tally = new Map<string, { ok: number; err: Record<string, number> }>();
      let slowest = 0;
      for (let i = 0; i < 2000; i++) {
        const r = rng(0xc0ffee + i);
        const m = METHODS[i % METHODS.length]!;
        const client = await S7Client.connect({
          host: 'finto',
          // metà dei casi rovina tutte le risposte, l'altra metà una sola (così i metodi lunghi arrivano in fondo)
          transport: hostile(
            cpu,
            r,
            Math.floor(i / METHODS.length) % 2 === 0 ? undefined : 1 + Math.floor(r() * 12),
          ),
          timeoutMs,
          proposedPdu: [240, 480, 960][i % 3],
        });
        const t0 = Date.now();
        let outcome = 'ok';
        try {
          const res = await Promise.race([
            m.run(client, r),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error(`SOSPESO: ${m.name} seme ${i}`)), 5000),
            ),
          ]);
          expect(res, `${m.name} seme ${i}`).toBeDefined();
        } catch (e) {
          if (!(e instanceof S7Error)) {
            throw new Error(`${m.name} seme ${i}: errore non S7Error: ${String(e)}`, { cause: e });
          }
          outcome = e.code;
        }
        slowest = Math.max(slowest, Date.now() - t0);
        await client.close();
        const row = tally.get(m.name) ?? { ok: 0, err: {} };
        if (outcome === 'ok') row.ok++;
        else row.err[outcome] = (row.err[outcome] ?? 0) + 1;
        tally.set(m.name, row);
      }
      await new Promise((res) => setImmediate(res));
      expect(cpu.connections).toBe(0);
      // ogni metodo è stato provato 142 volte o più, e a volte la risposta rovinata è ancora valida
      expect([...tally.keys()].sort()).toEqual(METHODS.map((m) => m.name).sort());
      const okTotal = [...tally.values()].reduce((n, x) => n + x.ok, 0);
      expect(okTotal).toBeGreaterThan(100);
      expect(okTotal).toBeLessThan(2000);
      // la più lenta: al più poche richieste in fila, ciascuna col suo timeout
      console.log(
        `più lenta ${slowest} ms ok=${okTotal} ${JSON.stringify(Object.fromEntries(tally))}`,
      );
      expect(slowest).toBeLessThan(timeoutMs * 1.5 + 1000);
    },
  );
});
