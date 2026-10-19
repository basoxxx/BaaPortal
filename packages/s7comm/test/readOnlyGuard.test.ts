import { describe, expect, it } from 'vitest';
import {
  MAX_ITEMS_PER_REQUEST,
  S7Connection,
  assertReadOnly,
  encodeCotp,
  encodeEndUpload,
  encodeReadRequest,
  encodeS7,
  encodeSetup,
  encodeStartUpload,
  encodeTpkt,
  encodeUpload,
  memoryTransportPair,
  reqBlockCounts,
  reqBlockInfo,
  reqBlockListOfType,
  reqContinue,
  reqReadClock,
  reqReadSzl,
  type S7Pdu,
  type Transport,
} from '../src';
import { FakeCpu } from './fakeCpu';

const hexb = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    s
      .replace(/\s+/g, '')
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );

const job = (
  param: Uint8Array,
  data: Uint8Array = new Uint8Array(0),
  rosctr: 1 | 2 | 3 | 7 = 1,
): S7Pdu => ({
  rosctr,
  pduRef: 7,
  errorClass: 0,
  errorCode: 0,
  param,
  data,
});

const item12 = '12 0a 10 02 00 04 00 01 84 00 00 00';

/** PDU vietate scritte a mano: i codificatori si rifiutano di produrle. */
const FORBIDDEN: [string, S7Pdu][] = [
  ['write var 0x05', job(hexb(`05 01 ${item12}`), hexb('00 04 00 08 aa'))],
  ['download request 0x1A', job(hexb('1a 00 00 00 00 00 00 fd 00 09 5f 30 41 30 31 30 30 30'))],
  ['download block 0x1B', job(hexb('1b 00 00 00 00 00 00 01 00'))],
  ['download ended 0x1C', job(hexb('1c 00 00 00 00 00 00 01 00'))],
  ['PLC control 0x28', job(hexb('28 00 00 00 00 00 00 fd 00 00 09 50 5f 50 52 4f 47 52 41 4d'))],
  ['PLC stop 0x29', job(hexb('29 00 00 00 00 00 09 50 5f 50 52 4f 47 52 41 4d'))],
  ['funzione sconosciuta 0x77', job(hexb('77 00 00 00'))],
  ['parametro vuoto', job(new Uint8Array(0))],
  ['userdata gruppo 1 (programmatore)', job(hexb('00 01 12 04 11 41 01 00'), new Uint8Array(0), 7)],
  ['userdata gruppo 2 (ciclici)', job(hexb('00 01 12 04 11 42 01 00'), new Uint8Array(0), 7)],
  ['userdata gruppo 5 (sicurezza)', job(hexb('00 01 12 04 11 45 01 00'), new Uint8Array(0), 7)],
  [
    'userdata gruppo 7 sub 2 (set clock)',
    job(hexb('00 01 12 04 11 47 02 00'), hexb('ff 09 00 00'), 7),
  ],
  [
    'userdata gruppo 7 sub 4 (set clock)',
    job(hexb('00 01 12 04 11 47 04 00'), hexb('ff 09 00 00'), 7),
  ],
  ['userdata gruppo 4 sub 2 (non SZL)', job(hexb('00 01 12 04 11 44 02 00'), new Uint8Array(0), 7)],
  ['userdata gruppo 3 sub 4', job(hexb('00 01 12 04 11 43 04 00'), new Uint8Array(0), 7)],
  [
    'userdata risposta (type 8) con gruppo ammesso',
    job(hexb('00 01 12 04 12 84 01 00'), new Uint8Array(0), 7),
  ],
  ['userdata param storto', job(hexb('00 01 12 04'), new Uint8Array(0), 7)],
  ['ROSCTR 2 (ack)', job(hexb('04 01'), new Uint8Array(0), 2)],
  ['ROSCTR 3 (ack-data)', job(hexb('f0 00 00 01 00 01 00 f0'), new Uint8Array(0), 3)],
  ['read var con zero item', job(hexb('04 00'))],
  [
    'read var con troppi item',
    job(
      Uint8Array.from([
        0x04,
        MAX_ITEMS_PER_REQUEST + 1,
        ...Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, () => [...hexb(item12)]).flat(),
      ]),
    ),
  ],
  ['read var con byte in coda', job(hexb(`04 01 ${item12} 00`))],
  ['read var con dati', job(hexb(`04 01 ${item12}`), hexb('00 04 00 08 aa'))],
  ['setup troncato', job(hexb('f0 00 00 01'))],
  ['setup con dati', job(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }), hexb('01'))],
  ['start upload troncato', job(hexb('1d 00 00'))],
];

describe('assertReadOnly: classi vietate', () => {
  it.each(FORBIDDEN)('%s -> FORBIDDEN', (_name, pdu) => {
    expect(() => assertReadOnly(pdu)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('il messaggio dice cosa è stato rifiutato', () => {
    expect(() => assertReadOnly(FORBIDDEN[0]![1])).toThrowError(
      'funzione 0x05 non ammessa: BaaPortal 1D è in sola lettura',
    );
  });
});

describe('assertReadOnly: allowlist', () => {
  const item = { area: 'DB', db: 1, start: 0, size: 'BYTE', count: 4 } as const;
  const ok: [string, S7Pdu][] = [
    ['setup', job(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }))],
    ['read var', job(encodeReadRequest([item]))],
    [
      'read var al massimo',
      job(encodeReadRequest(Array.from({ length: MAX_ITEMS_PER_REQUEST }, () => item))),
    ],
    ['start upload', job(encodeStartUpload('_0800001A'))],
    ['upload', job(encodeUpload(5))],
    ['end upload', job(encodeEndUpload(5))],
    ...(
      [
        ['SZL', reqReadSzl(0x0011, 0)],
        ['conteggi blocchi', reqBlockCounts()],
        ['lista blocchi', reqBlockListOfType('DB')],
        ['info blocco', reqBlockInfo('DB', 1)],
        ['leggi orologio', reqReadClock()],
        ['continuazione lista', reqContinue(3, 2, 1)],
        ['continuazione SZL', reqContinue(4, 1, 1)],
      ] as const
    ).map(([n, f]): [string, S7Pdu] => [n, job(f.param, f.data, 7)]),
  ];

  it.each(ok)('%s passa', (_n, pdu) => {
    expect(() => assertReadOnly(pdu)).not.toThrow();
  });
});

describe('il filtro vede ogni frame in uscita', () => {
  async function setup(): Promise<{
    conn: S7Connection;
    sends: Uint8Array[];
    cpu: FakeCpu;
    sendFrame: (b: Uint8Array) => void;
  }> {
    const [a, b] = memoryTransportPair();
    const sends: Uint8Array[] = [];
    const spy: Transport = {
      send: (x) => {
        sends.push(x);
        a.send(x);
      },
      onData: (cb) => a.onData(cb),
      onClose: (cb) => a.onClose(cb),
      close: () => a.close(),
    };
    const cpu = new FakeCpu(b, { pdu: 480 });
    const conn = await S7Connection.open({ host: 'x', transport: async () => spy });
    const raw = conn as unknown as { sendFrame(b: Uint8Array): void };
    return { conn, sends, cpu, sendFrame: (x) => raw.sendFrame(x) };
  }

  const dt = (s7: Uint8Array, eot = true): Uint8Array =>
    encodeTpkt(encodeCotp({ type: 'DT', eot, data: s7 }));

  it('una PDU vietata data a request() non arriva al trasporto', async () => {
    const { conn, sends } = await setup();
    const before = sends.length;
    for (const [, pdu] of FORBIDDEN) {
      if (pdu.rosctr === 2 || pdu.rosctr === 3) continue;
      await expect(conn.request(pdu.param, pdu.data, pdu.rosctr)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    expect(sends.length).toBe(before);
    expect(conn.refusedCount).toBe(
      FORBIDDEN.filter(([, p]) => p.rosctr === 1 || p.rosctr === 7).length,
    );
    expect(conn.closed).toBe(false);
  });

  it('ROSCTR 2 e 3, CC, ER, doppio frame e byte in coda sui byte finali: FORBIDDEN, zero invii', async () => {
    const { conn, sends, sendFrame } = await setup();
    const before = sends.length;
    const readPdu = encodeS7(
      job(encodeReadRequest([{ area: 'M', db: 0, start: 0, size: 'BYTE', count: 1 }])),
    );
    const good = dt(readPdu);
    const bads: Uint8Array[] = [
      dt(encodeS7(job(hexb('04 01'), new Uint8Array(0), 2))),
      dt(encodeS7(job(hexb('f0 00 00 01 00 01 00 f0'), new Uint8Array(0), 3))),
      encodeTpkt(encodeCotp({ type: 'CC', dstRef: 1, srcRef: 1 })),
      encodeTpkt(encodeCotp({ type: 'ER', dstRef: 1, cause: 1 })),
      Uint8Array.from([...good, ...good]),
      Uint8Array.from([...good, 0]),
      good.slice(0, good.length - 1),
      dt(readPdu, false),
      dt(Uint8Array.from([...readPdu, 0])),
      dt(hexb('ffff')),
      new Uint8Array(0),
      hexb('030000'),
      encodeTpkt(Uint8Array.from([0x02, 0xf0, 0x80, ...readPdu]).slice(0, 2)),
      // DT con LI 3 (byte extra nell'header) che nasconderebbe dati
      encodeTpkt(Uint8Array.from([0x03, 0xf0, 0x80, 0x00, ...readPdu])),
    ];
    for (const b of bads) {
      expect(() => sendFrame(b), `bytes ${b.length}`).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
    expect(sends.length).toBe(before);
    expect(conn.refusedCount).toBe(bads.length);
    // il frame buono passa
    sendFrame(good);
    expect(sends.length).toBe(before + 1);
  });
});
