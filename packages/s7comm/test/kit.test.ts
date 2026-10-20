import { strFromU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  S7Error,
  collect,
  pacedFactory,
  kitZip,
  readKitZip,
  type KitResult,
  type KitSummary,
  type Transport,
  type TransportFactory,
} from '../src';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const summary = (over: Partial<KitSummary> = {}): KitSummary => ({
  kitFormat: 1,
  baaportalVersion: 'dev',
  startedAt: '2026-10-20T10:00:00.000Z',
  finishedAt: '2026-10-20T10:00:05.000Z',
  host: '10.0.0.5',
  szlRead: 2,
  blocksListed: 1,
  blocksUploaded: 1,
  refusedCount: 0,
  warnings: [],
  errors: [],
  ...over,
});

const sample = (): KitResult => ({
  summary: summary(),
  files: {
    'capture.jsonl': enc('{"t":0,"dir":"tx","hex":"0300000b06e00000000000"}\n'),
    'szl/0011-0000.json': enc('{"id":17}'),
    'blocchi/DB1.blk': Uint8Array.from([0x70, 0x70, 1, 2, 3]),
    'blockinfo/DB1.json': enc('{}'),
  },
});

describe('kitZip / readKitZip', () => {
  it('readKitZip(kitZip(x)) restituisce riepilogo, frame e blocchi', () => {
    const r = readKitZip(kitZip(sample()));
    expect(r.summary).toEqual(sample().summary);
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]!.dir).toBe('tx');
    expect(r.blocks['DB1']).toEqual(Uint8Array.from([0x70, 0x70, 1, 2, 3]));
    expect(r.szl['0011-0000']).toEqual({ id: 17 });
  });

  it('lo zip è deterministico e ha le voci in ordine', () => {
    const a = kitZip(sample());
    const b = kitZip({
      summary: sample().summary,
      files: Object.fromEntries(Object.entries(sample().files).reverse()),
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('LEGGIMI.txt è in italiano: nulla scritto nel PLC, contiene il programma, solo a persone fidate', () => {
    const files = readKitFiles(kitZip(sample()));
    const t = files['LEGGIMI.txt']!;
    expect(t).toMatch(/NULLA È STATO SCRITTO NEL PLC/);
    expect(t).toMatch(/PROGRAMMA DEL TUO PLC/);
    expect(t).toMatch(/persone di cui ti fidi/);
    expect(t).toMatch(/capture\.jsonl/);
  });

  it('zip non valido: PROTOCOL con messaggio chiaro', () => {
    const z = (o: Record<string, Uint8Array>): Uint8Array => zipSync(o);
    const good = {
      'LEGGIMI.txt': enc('x'),
      'summary.json': enc(JSON.stringify(summary())),
      'capture.jsonl': enc(''),
    };
    const cases: [Uint8Array, RegExp][] = [
      [Uint8Array.from([1, 2, 3]), /zip/],
      [z({ ...good, 'summary.json': enc('{') }), /summary\.json/],
      [z({ ...good, 'summary.json': enc('{"kitFormat":2}') }), /kitFormat/],
      [
        z({
          ...good,
          'summary.json': enc(JSON.stringify({ ...summary(), refusedCount: undefined })),
        }),
        /refusedCount/,
      ],
      [
        z({ ...good, 'summary.json': enc(JSON.stringify({ ...summary(), refusedCount: '0' })) }),
        /refusedCount/,
      ],
      [z({ ...good, 'summary.json': enc(JSON.stringify({ ...summary(), host: 5 })) }), /host/],
      [
        z({
          ...good,
          'summary.json': enc(JSON.stringify({ ...summary(), errors: [{ step: 1 }] })),
        }),
        /errors/,
      ],
      [
        z({ ...good, 'summary.json': enc(JSON.stringify({ ...summary(), warnings: 'x' })) }),
        /warnings/,
      ],
      [
        z({ 'LEGGIMI.txt': good['LEGGIMI.txt'], 'summary.json': good['summary.json'] }),
        /capture\.jsonl/,
      ],
      [z({ ...good, '../evil.txt': enc('x') }), /inatteso/],
      [z({ ...good, 'capture.jsonl': enc('non json\n') }), /riga 1/],
    ];
    for (const [bytes, re] of cases) {
      expect(() => readKitZip(bytes)).toThrowError(re);
      try {
        readKitZip(bytes);
      } catch (e) {
        expect(e).toBeInstanceOf(S7Error);
        expect((e as S7Error).code).toBe('PROTOCOL');
      }
    }
  });
});

function readKitFiles(zip: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  // readKitZip non restituisce LEGGIMI: si apre lo zip direttamente
  for (const [k, v] of Object.entries(unzipSync(zip))) out[k] = strFromU8(v);
  return out;
}

describe('trasporto con pause (pacedFactory)', () => {
  const fake = (): {
    t: Transport;
    sent: { at: number; b: Uint8Array }[];
    closed: () => boolean;
    push: (b: Uint8Array) => void;
  } => {
    const sent: { at: number; b: Uint8Array }[] = [];
    let data: (c: Uint8Array) => void = () => undefined;
    let closed = false;
    const t: Transport = {
      send(b) {
        if (closed) throw new S7Error('CLOSED', 'chiuso');
        sent.push({ at: Date.now(), b: b.slice() });
      },
      onData(cb) {
        data = cb;
      },
      onClose: () => undefined,
      close() {
        closed = true;
      },
    };
    return { t, sent, closed: () => closed, push: (b) => data(b) };
  };
  const open = async (f: ReturnType<typeof fake>): Promise<Transport> =>
    pacedFactory(() => Promise.resolve(f.t), 30)('h', 1, 100);

  it('ordine dei frame uguale a quello di invio; la copia non cambia se il buffer viene modificato; si usa il ritardo', async () => {
    const f = fake();
    const t = await open(f);
    t.onData(() => undefined);
    f.push(Uint8Array.of(9)); // risposta: da qui contano 30 ms
    const t0 = Date.now();
    const a = Uint8Array.of(1);
    t.send(a);
    a[0] = 99; // il filtro riusa il buffer
    t.send(Uint8Array.of(2));
    t.send(Uint8Array.of(3));
    expect(f.sent).toHaveLength(0); // niente è partito subito: il percorso ritardato è usato
    await new Promise((r) => setTimeout(r, 200));
    expect(f.sent.map((s) => s.b[0])).toEqual([1, 2, 3]);
    expect(f.sent[0]!.at - t0).toBeGreaterThanOrEqual(20);
    expect(f.sent[1]!.at - f.sent[0]!.at).toBeGreaterThanOrEqual(20);
  });

  it("close() svuota subito i frame in coda, nell'ordine, poi chiude; dopo la chiusura non parte nulla", async () => {
    const f = fake();
    const t = await open(f);
    t.onData(() => undefined);
    f.push(Uint8Array.of(9));
    t.send(Uint8Array.of(1));
    t.send(Uint8Array.of(0xdd)); // il DR
    t.close();
    expect(f.sent.map((s) => s.b[0])).toEqual([1, 0xdd]);
    expect(f.closed()).toBe(true);
    expect(() => t.send(Uint8Array.of(5))).toThrowError(/chiuso/);
    await new Promise((r) => setTimeout(r, 100));
    expect(f.sent).toHaveLength(2);
  });
});

describe('collect (trasporti scritti nel test)', () => {
  const refuse: TransportFactory = () =>
    Promise.reject(new S7Error('CONNECT_REFUSED', 'rifiutata'));

  it('prima connessione fallita: un solo nuovo tentativo, poi lo zip c’è comunque', async () => {
    let calls = 0;
    const r = await collect(
      {
        host: 'x',
        includeBlocks: true,
        minIntervalMs: 0,
        reconnectDelayMs: 0,
        transport: (...a) => {
          calls++;
          return refuse(...a);
        },
      },
      () => undefined,
    );
    expect(calls).toBe(2);
    expect(r.summary.errors.map((e) => e.code)).toEqual(['CONNECT_REFUSED', 'CONNECT_REFUSED']);
    expect(r.summary.errors[0]!.step).toBe('connect');
    expect(r.summary.refusedCount).toBe(0);
    expect(r.summary.kitFormat).toBe(1);
    expect(r.summary.baaportalVersion).toBe('dev');
    const back = readKitZip(kitZip(r));
    expect(back.summary.errors).toHaveLength(2);
    expect(back.frames).toEqual([]);
  });

  it('segnale già annullato: ABORTED subito, nessuna connessione', async () => {
    let calls = 0;
    const ac = new AbortController();
    ac.abort();
    const r = await collect(
      {
        host: 'x',
        includeBlocks: false,
        transport: (...a) => {
          calls++;
          return refuse(...a);
        },
      },
      () => undefined,
      ac.signal,
      '1.2.3',
    );
    expect(calls).toBe(0);
    expect(r.summary.errors[0]!.code).toBe('ABORTED');
    expect(r.summary.baaportalVersion).toBe('1.2.3');
  });

  it('senza trasporto: errore di programmazione, non un zip', async () => {
    await expect(collect({ host: 'x', includeBlocks: false }, () => undefined)).rejects.toThrow(
      /trasporto/,
    );
  });
});
