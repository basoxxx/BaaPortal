import { describe, expect, it } from 'vitest';
import {
  S7Error,
  S7WriteClient,
  encodeCotp,
  encodeInsertBlock,
  encodePlcStop,
  encodeRequestDownload,
  encodeS7,
  encodeTpkt,
  encodeWarmRestart,
  encodeWriteRequest,
  memoryTransportPair,
  type CotpPdu,
  type Transport,
  type TransportFactory,
  type WriteItem,
} from '@baaportal/s7comm';
import { FakeCpu, serve } from '../src';
import { NOTHING, TestPeer, blockFile, seq, settle } from './helpers';

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

/**
 * `dropAfter`: dopo tanti chunk ricevuti dal client (compresa la risposta al setup) è il lato
 * della CPU a chiudere, come una caduta di rete: il client non chiude mai da sé.
 */
async function connect(cpu: FakeCpu, dropAfter?: number, pdu?: number): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    const srv = serve(cpu, b);
    if (dropAfter === undefined) return a;
    let seen = 0;
    const wrapped: Transport = {
      send: (x) => a.send(x),
      onClose: (cb) => a.onClose(cb),
      close: () => a.close(),
      onData: (cb) =>
        a.onData((chunk) => {
          if (++seen > dropAfter) return;
          cb(chunk);
          if (seen === dropAfter) srv.close();
        }),
    };
    return wrapped;
  };
  return S7WriteClient.connect({
    host: 'finto',
    transport,
    timeoutMs: 1500,
    ...(pdu ? { proposedPdu: pdu } : {}),
  });
}

const withTimeout = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('promessa appesa')), ms)),
  ]);

describe('download interrotto a metà', () => {
  const big = blockFile('FC', 9, seq(1500, 3));

  it('la connessione cade tra le fette: CLOSED, nessuna promessa appesa, blocco non inserito', async () => {
    // chunk della CPU: CC, setup, risposta 0x1A, job 0x1B (1ª fetta), job 0x1B (2ª fetta)...
    for (const cut of [3, 4, 5, 6, 7]) {
      const cpu = new FakeCpu();
      const before = cpu.snapshot();
      const c = await withTimeout(connect(cpu, cut));
      const e: unknown = await withTimeout(c.downloadBlock(big)).catch((x: unknown) => x);
      expect(e, `taglio dopo ${cut} chunk`).toBeInstanceOf(S7Error);
      expect((e as S7Error).code, `taglio dopo ${cut} chunk`).toBe('CLOSED');
      // anche una richiesta successiva non resta appesa
      const e2: unknown = await withTimeout(c.mode()).catch((x: unknown) => x);
      expect(e2).toBeInstanceOf(S7Error);
      expect((e2 as S7Error).code).toBe('CLOSED');
      await settle();
      expect(cpu.connections, `sessione chiusa dopo ${cut}`).toBe(0);
      // il finto PLC non ha il blocco, e non è cambiato nulla
      expect(cpu.snapshot()).toBe(before);
      const check = await connect(cpu);
      expect(await check.listBlocks('FC')).toEqual([]);
      const none: unknown = await check.upload('FC', 9).catch((x: unknown) => x);
      expect(none).toBeInstanceOf(S7Error);
      await check.close();
    }
  });

  it('caduta dopo l ultima fetta ma prima dell _INSE: il blocco non è inserito', async () => {
    const cpu = new FakeCpu();
    const before = cpu.snapshot();
    // un blocco piccolo: CC, setup, 0x1A, 0x1B, 0x1C -> tagliamo prima della risposta all'_INSE
    const small = blockFile('FC', 9, seq(40));
    const c = await connect(cpu, 5);
    const e: unknown = await withTimeout(c.downloadBlock(small)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(S7Error);
    expect((e as S7Error).code).toBe('CLOSED');
    await settle();
    expect(cpu.snapshot()).toBe(before);
  });

  it('un _INSE senza download completato è rifiutato e non inserisce nulla', async () => {
    const cpu = new FakeCpu();
    const before = cpu.snapshot();
    const p = await new TestPeer(cpu).open();
    const r = await p.job(encodeInsertBlock('FC', 9, 'P'));
    expect([2, 3]).toContain(r?.rosctr);
    expect(((r!.errorClass << 8) | r!.errorCode) !== 0).toBe(true);
    // _INSE dopo un 0x1A ma senza il trasferimento
    await p.job(encodeRequestDownload('FC', 9, 'P', 500, 400));
    const r2 = await p.job(encodeInsertBlock('FC', 9, 'P'));
    expect(((r2!.errorClass << 8) | r2!.errorCode) !== 0).toBe(true);
    p.close();
    await settle();
    expect(cpu.snapshot()).toBe(before);
  });
});

describe('write var oltre la PDU', () => {
  it('writeArea di 5000 byte (PDU 240) è diviso in più richieste e rilegge identico', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, new Uint8Array(6000));
    const c = await connect(cpu);
    const data = Uint8Array.from({ length: 5000 }, (_, i) => (i * 13 + (i >> 8)) & 0xff);
    await c.writeArea('DB', 1, 100, data);
    expect(await c.readArea('DB', 1, 100, 5000)).toEqual(data);
    // intorno non toccato
    expect(await c.readArea('DB', 1, 0, 100)).toEqual(new Uint8Array(100));
    expect(await c.readArea('DB', 1, 5100, 900)).toEqual(new Uint8Array(900));
    await c.close();
  });

  it('con PDU 480 e 960 i confini delle fette sono corretti per ogni lunghezza vicina al limite', async () => {
    for (const pdu of [240, 480, 960]) {
      const cpu = new FakeCpu();
      cpu.addDb(1, new Uint8Array(4000));
      const c = await connect(cpu, undefined, pdu);
      for (const n of [
        pdu - 36,
        pdu - 35,
        pdu - 34,
        pdu - 20,
        pdu,
        pdu + 1,
        2 * pdu,
        3 * pdu - 7,
      ]) {
        const data = Uint8Array.from({ length: n }, (_, i) => (i + n) & 0xff);
        await c.writeArea('DB', 1, 7, data);
        expect(await c.readArea('DB', 1, 7, n), `pdu ${pdu} n ${n}`).toEqual(data);
      }
      await c.close();
    }
  });

  it('la scrittura oltre la fine del DB dà S7Error e la lettura non cambia oltre i confini', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, new Uint8Array(100));
    const c = await connect(cpu);
    const e: unknown = await c
      .writeArea('DB', 1, 90, new Uint8Array(50).fill(7))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(S7Error);
    expect((e as S7Error).code).toBe('CPU_ERROR');
    const e2: unknown = await c.writeArea('DB', 99, 0, Uint8Array.of(1)).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(S7Error);
    expect(await c.readArea('DB', 1, 0, 100)).toHaveLength(100);
    await c.close();
  });
});

describe('write var con dati più corti della specifica (nessuna lettura oltre il buffer)', () => {
  const spec = (count: number): WriteItem => ({
    area: 'DB',
    db: 1,
    start: 0,
    size: 'BYTE',
    count,
    data: new Uint8Array(count),
  });

  it('la parte dati con meno byte di quanti ne dichiara la specifica è rifiutata, DB intatto', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, new Uint8Array(100).fill(0xaa));
    const before = cpu.snapshot();
    const p = await new TestPeer(cpu).open();
    const good = encodeWriteRequest([spec(10)]);
    const cases: Uint8Array[] = [
      good.data.slice(0, 4 + 5), // dati troncati
      good.data.slice(0, 4), // niente dati
      good.data.slice(0, 2), // intestazione troncata
      Uint8Array.of(0, 4, 0, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), // dichiara 2 byte, la spec ne vuole 10
      Uint8Array.of(0, 4, 0xff, 0xf8, 1, 2, 3), // dichiara 8191 byte
      NOTHING,
    ];
    for (const data of cases) {
      const r = await p.job(good.param, data);
      expect([2, 3]).toContain(r?.rosctr);
      expect((r!.errorClass << 8) | r!.errorCode, 'header di errore').not.toBe(0);
    }
    expect(cpu.snapshot()).toBe(before);
    p.close();
  });
});

describe('fuzz di scrittura e controllo', () => {
  it('2000 PDU di write/stop/avvio/download verso il finto PLC: nessun crash, nessun job anomalo, memoria intatta nelle dimensioni', async () => {
    const rand = rng(0xbadc0de);
    const int = (n: number): number => Math.floor(rand() * n);
    const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(256));
    const pick = <T>(xs: T[]): T => xs[int(xs.length)]!;

    const cpu = new FakeCpu();
    cpu.addDb(1, seq(300));
    cpu.addDb(2, seq(20));
    cpu.setMemory('M', 0, seq(64));

    const wr = (items: WriteItem[]): { param: Uint8Array; data: Uint8Array } =>
      encodeWriteRequest(items);
    const item = (area: WriteItem['area'], db: number, start: number, n: number): WriteItem => ({
      area,
      db,
      start,
      size: 'BYTE',
      count: n,
      data: bytes(n),
    });
    const validJobs: { param: Uint8Array; data: Uint8Array }[] = [
      wr([item('DB', 1, 0, 10)]),
      wr([item('DB', 1, 5, 11), item('M', 0, 3, 4)]),
      wr([{ area: 'M', db: 0, start: 1, bit: 3, size: 'BIT', count: 5, data: bytes(1) }]),
      wr([item('DB', 2, 0, 20)]),
      { param: encodePlcStop(), data: NOTHING },
      { param: encodeWarmRestart(), data: NOTHING },
      { param: encodeInsertBlock('FC', 9, 'P'), data: NOTHING },
      { param: encodeRequestDownload('FC', 9, 'P', 500, 400), data: NOTHING },
      { param: Uint8Array.of(0x1b, 0), data: bytes(8) },
      { param: Uint8Array.of(0x1c), data: NOTHING },
    ];

    const dt = (data: Uint8Array): Uint8Array =>
      encodeTpkt(encodeCotp({ type: 'DT', eot: true, data } as CotpPdu));
    const generate = (): Uint8Array => {
      switch (int(5)) {
        case 0: {
          // job valido con byte alterati o troncati (parametro e dati)
          const v = pick(validJobs);
          const param = v.param.slice();
          const data = v.data.slice();
          for (let k = int(4); k >= 0; k--) {
            if (rand() < 0.6 && param.length) param[int(param.length)] = int(256);
            else if (data.length) data[int(data.length)] = int(256);
          }
          return dt(
            encodeS7({
              rosctr: 1,
              pduRef: int(65536),
              errorClass: 0,
              errorCode: 0,
              param: rand() < 0.15 ? param.slice(0, int(param.length + 1)) : param,
              data: rand() < 0.25 ? data.slice(0, int(data.length + 1)) : data,
            }),
          );
        }
        case 1: {
          // funzione di scrittura/controllo con parametro e dati a caso
          const fn = pick([0x05, 0x28, 0x29, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]);
          return dt(
            encodeS7({
              rosctr: pick([1, 2, 3] as const),
              pduRef: int(65536),
              errorClass: 0,
              errorCode: 0,
              param: Uint8Array.of(fn, ...bytes(int(30))),
              data: bytes(int(60)),
            }),
          );
        }
        case 2: {
          // write var strutturalmente valida, posizioni e lunghezze a caso
          const n = 1 + int(4);
          const items = Array.from({ length: n }, () => {
            const len = 1 + int(40);
            return item(
              pick(['DB', 'M', 'I', 'Q', 'T', 'C', 'DI'] as const),
              pick([0, 1, 2, 3, 200]),
              int(400),
              len,
            );
          });
          const { param, data } = wr(items);
          return dt(
            encodeS7({ rosctr: 1, pduRef: int(65536), errorClass: 0, errorCode: 0, param, data }),
          );
        }
        case 3: {
          // write var con dati più corti/lunghi di quanto dice la specifica
          const { param, data } = wr([item('DB', 1, int(250), 1 + int(40))]);
          const cut = rand() < 0.5 ? data.slice(0, int(data.length)) : cat(data, bytes(int(8)));
          return dt(
            encodeS7({
              rosctr: 1,
              pduRef: int(65536),
              errorClass: 0,
              errorCode: 0,
              param,
              data: cut,
            }),
          );
        }
        default:
          return dt(
            encodeS7({
              rosctr: 1,
              pduRef: int(65536),
              errorClass: 0,
              errorCode: 0,
              ...pick(validJobs),
            }),
          );
      }
    };

    let peer = await new TestPeer(cpu).open();
    let answered = 0;
    const jobsFromCpu = new Set<string>();
    const collect = (p: TestPeer): void => {
      for (const x of p.pdus) {
        if (x.rosctr === 1)
          jobsFromCpu.add(x.param[0]!.toString(16)); // solo i job del download
        else expect([2, 3]).toContain(x.rosctr);
      }
      answered += p.pdus.length;
    };
    let sent = 0;
    for (let i = 0; i < 2000; i++) {
      if (peer.closed) {
        collect(peer);
        peer = await new TestPeer(cpu).open();
      }
      peer.sendRaw(generate());
      sent++;
      await settle();
    }
    collect(peer);
    peer.close();
    await settle();

    expect(sent).toBe(2000);
    expect(cpu.connections).toBe(0);
    expect(answered).toBeGreaterThan(300);
    // i soli job che la CPU può mandare sono quelli del download (0x1B, 0x1C)
    for (const f of jobsFromCpu) expect(['1b', '1c']).toContain(f);

    // il finto PLC è ancora sano e le dimensioni dei DB non sono cambiate
    const c = await connect(cpu);
    expect((await c.readArea('DB', 1, 0, 300)).length).toBe(300);
    expect((await c.readArea('DB', 2, 0, 20)).length).toBe(20);
    expect((await c.upload('DB', 1)).length).toBe(36 + 300 + 36);
    await c.close();
  });

  it('2000 chiamate del client di scrittura con argomenti a caso: solo S7Error', async () => {
    const rand = rng(0xf00d);
    const int = (n: number): number => Math.floor(rand() * n);
    const pick = <T>(xs: T[]): T => xs[int(xs.length)]!;
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(300));
    cpu.addDb(2, seq(20));
    const c = await connect(cpu);
    const good = blockFile('FC', 11, seq(400));
    let okCount = 0;
    let errCount = 0;
    for (let i = 0; i < 2000; i++) {
      try {
        switch (int(6)) {
          case 0:
            await c.writeArea(
              pick(['DB', 'M', 'I', 'Q', 'DI'] as const),
              pick([0, 1, 2, 3, 9999]),
              int(500),
              Uint8Array.from({ length: 1 + int(700) }, () => int(256)),
            );
            break;
          case 1:
            await c.writeItems([
              {
                area: 'DB',
                db: pick([1, 2, 5]),
                start: int(400),
                size: 'BYTE',
                count: 3,
                data: Uint8Array.of(1, 2, 3),
              },
            ]);
            break;
          case 2:
            await c.stop();
            break;
          case 3:
            await c.start();
            break;
          case 4: {
            // blocco troncato o con la testa rovinata
            const f = good.slice(0, int(good.length + 1));
            if (rand() < 0.5 && f.length > 0) f[int(Math.min(f.length, 40))] = int(256);
            await c.downloadBlock(f);
            break;
          }
          default:
            await c.downloadBlock(good);
        }
        okCount++;
      } catch (e) {
        errCount++;
        expect(e, `iterazione ${i}`).toBeInstanceOf(S7Error);
      }
    }
    expect(okCount).toBeGreaterThan(100);
    expect(errCount).toBeGreaterThan(100);
    // il client è ancora vivo
    expect(['RUN', 'STOP']).toContain(await c.mode());
    await c.close();
  });
});

function cat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
