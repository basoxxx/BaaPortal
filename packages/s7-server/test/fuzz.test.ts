import { describe, expect, it } from 'vitest';
import {
  encodeCotp,
  encodeReadRequest,
  encodeS7,
  encodeSetup,
  encodeStartUpload,
  encodeTpkt,
  encodeUpload,
  reqBlockCounts,
  reqBlockInfo,
  reqBlockListOfType,
  reqContinue,
  reqReadClock,
  reqReadSzl,
  type CotpPdu,
} from '@baaportal/s7comm';
import { FakeCpu } from '../src';
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

function populated(): FakeCpu {
  const cpu = new FakeCpu({
    clock: () => ({ year: 2026, month: 10, day: 20, hour: 9, minute: 0, second: 0, ms: 0 }),
  });
  cpu.addDb(1, seq(300));
  cpu.addDb(2, seq(20));
  cpu.addBlock(blockFile('OB', 1, seq(50)));
  cpu.addBlock(blockFile('SFC', 6, seq(8)));
  cpu.setMemory('M', 0, seq(64));
  cpu.addDiagnostic({
    eventId: 0x4302,
    info: new Uint8Array(10),
    time: { year: 2024, month: 1, day: 2, hour: 3, minute: 4, second: 5, ms: 6 },
  });
  return cpu;
}

describe('fuzz: 2000 PDU a caso', () => {
  it('nessun crash, il finto PLC risponde o chiude, e il suo stato non cambia', async () => {
    const rand = rng(0x5eed);
    const int = (n: number): number => Math.floor(rand() * n);
    const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(256));
    const pick = <T>(xs: T[]): T => xs[int(xs.length)]!;

    // Orologio fisso: lo snapshot contiene l'ora dell'ultimo cambio di modo, quindi con l'orologio
    // vero sarebbe stabile solo perché nessun comando di rete la tocca; così è esplicito.
    const cpu = populated();
    const before = cpu.snapshot();

    // richieste valide da cui partire per le mutazioni
    const valid: Uint8Array[] = [
      ...[
        reqReadSzl(0x0011, 0),
        reqReadSzl(0x001c, 0),
        reqBlockCounts(),
        reqReadClock(),
        reqBlockListOfType('DB'),
        reqBlockInfo('DB', 1),
        reqContinue(4, 1, 1),
      ].map((f) =>
        encodeS7({
          rosctr: 7,
          pduRef: 5,
          errorClass: 0,
          errorCode: 0,
          param: f.param,
          data: f.data,
        }),
      ),
      ...[
        encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }),
        encodeReadRequest([{ area: 'DB', db: 1, start: 0, size: 'BYTE', count: 100 }]),
        encodeStartUpload('_0A00001A'),
        encodeUpload(7),
        Uint8Array.of(0x05, 0x01, 0x12, 0x0a, 0x10, 0x02, 0, 1, 0, 0, 0x83, 0, 0, 0),
        // (niente stop 0x29 valido: da allowlist cambia il modo, quindi non è una richiesta "che non cambia stato")
      ].map((param) =>
        encodeS7({ rosctr: 1, pduRef: 6, errorClass: 0, errorCode: 0, param, data: NOTHING }),
      ),
    ];

    const dt = (data: Uint8Array, eot = true): Uint8Array =>
      encodeTpkt(encodeCotp({ type: 'DT', eot, data }));
    const generate = (): Uint8Array => {
      switch (int(6)) {
        case 0:
          return dt(bytes(int(300))); // S7 a caso
        case 1: {
          // intestazione S7 valida, parametro e dati a caso
          const rosctr = pick([1, 2, 3, 7] as const);
          return dt(
            encodeS7({
              rosctr,
              pduRef: int(65536),
              errorClass: int(256),
              errorCode: int(256),
              param: bytes(int(40)),
              data: bytes(int(60)),
            }),
          );
        }
        case 2: {
          // richiesta valida con byte alterati o troncata
          const m = pick(valid).slice();
          for (let k = int(4); k >= 0; k--) m[int(m.length)] = int(256);
          return dt(rand() < 0.2 ? m.slice(0, int(m.length)) : m);
        }
        case 3: {
          const c: CotpPdu = pick<CotpPdu>([
            {
              type: 'CR',
              dstRef: int(65536),
              srcRef: int(65536),
              tpduSize: int(16),
              srcTsap: int(65536),
              dstTsap: int(65536),
            },
            { type: 'CC', dstRef: 1, srcRef: 2, tpduSize: 10 },
            { type: 'DR', dstRef: 1, srcRef: 2, reason: int(256) },
            { type: 'ER', dstRef: 1, cause: int(256) },
            { type: 'DT', eot: false, data: bytes(int(50)) },
          ]);
          return encodeTpkt(encodeCotp(c));
        }
        case 4:
          return bytes(int(40)); // niente TPKT valido
        default:
          return dt(pick(valid)); // richiesta valida intatta
      }
    };

    let peer = await new TestPeer(cpu).open();
    let answered = 0;
    let closed = 0;
    const seenCotp = new Set<string>();
    const collect = (p: TestPeer): void => {
      for (const c of p.cotp) seenCotp.add(c.type);
      // la CPU non manda mai job (ROSCTR 1)
      for (const x of p.pdus) expect(x.rosctr).not.toBe(1);
      answered += p.pdus.length;
    };
    for (let i = 0; i < 2000; i++) {
      if (peer.closed) {
        collect(peer);
        closed++;
        peer = await new TestPeer(cpu).open();
      }
      peer.sendRaw(generate());
      await settle();
    }
    collect(peer);
    peer.close();
    await settle();

    expect(cpu.snapshot()).toBe(before);
    expect(cpu.connections).toBe(0);
    expect(answered).toBeGreaterThan(300);
    expect(closed).toBeGreaterThan(20);
    expect([...seenCotp].every((t) => ['CC', 'DT', 'DR'].includes(t))).toBe(true);
  });
});
