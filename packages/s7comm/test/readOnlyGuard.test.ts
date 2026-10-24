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
  encodeUserdata,
  encodeWriteRequest,
  guardedSender,
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

const dt = (s7: Uint8Array, eot = true): Uint8Array =>
  encodeTpkt(encodeCotp({ type: 'DT', eot, data: s7 }));

function senderRig(): {
  sends: Uint8Array[];
  refused: () => number;
  send: (b: Uint8Array) => void;
} {
  const sends: Uint8Array[] = [];
  let refused = 0;
  const send = guardedSender({ send: (b) => void sends.push(b) }, undefined, () => refused++);
  return { sends, refused: () => refused, send };
}

describe('il filtro vede ogni frame in uscita', () => {
  async function setup(): Promise<{ conn: S7Connection; sends: Uint8Array[] }> {
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
    new FakeCpu(b, { pdu: 480 });
    const conn = await S7Connection.open({ host: 'x', transport: async () => spy });
    return { conn, sends };
  }

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

  it('ROSCTR 2 e 3, CC, ER, doppio frame, byte in coda e simili: FORBIDDEN, zero invii', () => {
    const { sends, send, refused } = senderRig();
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
      encodeTpkt(Uint8Array.from([0x03, 0xf0, 0x80, 0x00, ...readPdu])),
    ];
    for (const b of bads) {
      expect(() => send(b), `bytes ${b.length}`).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
    expect(sends.length).toBe(0);
    expect(refused()).toBe(bads.length);
    send(good);
    expect(sends.length).toBe(1);
  });
});

describe('forma canonica', () => {
  const rd = encodeReadRequest([{ area: 'DB', db: 1, start: 0, size: 'BYTE', count: 4 }]);
  const withByte = (b: Uint8Array, i: number, v: number): Uint8Array => {
    const c = b.slice();
    c[i] = v;
    return c;
  };
  const cases: [string, S7Pdu][] = [
    ['setup con AmQ 3/3', job(encodeSetup({ amqCalling: 3, amqCalled: 3, pduLength: 480 }))],
    ['setup con AmQ 1/3', job(encodeSetup({ amqCalling: 1, amqCalled: 3, pduLength: 480 }))],
    [
      'setup con byte riservato',
      job(withByte(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }), 1, 1)),
    ],
    ["read var con byte riservato nell'item", job(withByte(rd, 2 + 11 - 11 + 0, 0x13))],
    ['read var con sintassi item diversa', job(withByte(rd, 4, 0x11))],
    ['read var con area sconosciuta', job(withByte(rd, 2 + 8, 0x55))],
    [
      'start upload con tipo ignoto',
      job(encodeStartUpload('_0800001A').map((v, i) => (i === 10 ? 0x5a : v))),
    ],
    [
      'start upload con filesystem Z',
      job(encodeStartUpload('_0800001A').map((v, i) => (i === 16 ? 0x5a : v))),
    ],
    ['start upload con campo ignoto non zero', job(withByte(encodeStartUpload('_0800001A'), 2, 1))],
    ['start upload con upload id non zero', job(withByte(encodeStartUpload('_0800001A'), 7, 1))],
    ['upload con campo riservato', job(withByte(encodeUpload(5), 2, 1))],
    ['end upload con stato non zero', job(withByte(encodeEndUpload(5), 1, 1))],
    [
      'SZL con transport size errato',
      job(reqReadSzl(0x11, 0).param, withByte(reqReadSzl(0x11, 0).data, 1, 0x04), 7),
    ],
    [
      'SZL con return code errato',
      job(reqReadSzl(0x11, 0).param, withByte(reqReadSzl(0x11, 0).data, 0, 0x0a), 7),
    ],
    [
      'SZL con payload di 6 byte',
      job(
        ...(() => {
          const d = reqReadSzl(0x11, 0).data;
          const o = new Uint8Array(d.length + 2);
          o.set(d);
          o[3] = 6;
          return [reqReadSzl(0x11, 0).param, o, 7] as const;
        })(),
      ),
    ],
    [
      'lista blocchi con tipo ignoto',
      job(reqBlockListOfType('DB').param, withByte(reqBlockListOfType('DB').data, 4, 0x5a), 7),
    ],
    [
      'info blocco con numero non cifre',
      job(reqBlockInfo('DB', 1).param, withByte(reqBlockInfo('DB', 1).data, 6, 0x41), 7),
    ],
    ['conteggi con payload', job(reqBlockCounts().param, reqReadSzl(0x11, 0).data, 7)],
    ['orologio con rc 0xff', job(reqReadClock().param, withByte(reqReadClock().data, 0, 0xff), 7)],
    [
      'userdata con method byte 0x12 e plen 4',
      job(withByte(reqBlockCounts().param, 4, 0x12), reqBlockCounts().data, 7),
    ],
    [
      'userdata con type 0',
      job(withByte(reqBlockCounts().param, 5, 0x03), reqBlockCounts().data, 7),
    ],
    [
      'continuazione con payload diverso',
      job(reqContinue(3, 2, 1).param, reqReadSzl(0x11, 0).data, 7),
    ],
    [
      'continuazione con data unit ref 1',
      job(withByte(reqContinue(3, 2, 1).param, 8, 1), reqContinue(3, 2, 1).data, 7),
    ],
    [
      'continuazione con error code',
      job(withByte(reqContinue(3, 2, 1).param, 11, 1), reqContinue(3, 2, 1).data, 7),
    ],
  ];
  it.each(cases)('%s -> FORBIDDEN', (_n, pdu) => {
    expect(() => assertReadOnly(pdu)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('DT con intestazione non canonica e id di ridondanza non zero sono rifiutati', () => {
    const { sends, send } = senderRig();
    const s7 = encodeS7(job(rd));
    const nonzeroRed = s7.slice();
    nonzeroRed[2] = 1;
    expect(() => send(dt(nonzeroRed))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    const credit = dt(s7);
    credit[5] = 0xf1;
    expect(() => send(credit)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    const tpduNr = dt(s7);
    tpduNr[6] = 0x81;
    expect(() => send(tpduNr)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(sends.length).toBe(0);
  });
});

describe('scansioni esaustive', () => {
  const empty = new Uint8Array(0);
  const canon: Record<string, { param: Uint8Array; data: Uint8Array }> = {
    '4/1': reqReadSzl(0x11, 0),
    '3/1': reqBlockCounts(),
    '3/2': reqBlockListOfType('DB'),
    '3/3': reqBlockInfo('DB', 1),
    '7/1': reqReadClock(),
    '7/3': encodeUserdata(
      { method: 'request', group: 7, subfunction: 3, sequence: 0 },
      empty,
      0x0a,
    ),
  };

  it('tutti i 256 byte di funzione ROSCTR 1: passano solo 0x1E e 0x1F con parametro minimo', () => {
    const { sends, send } = senderRig();
    const passed: number[] = [];
    let n = 0;
    for (let fn = 0; fn < 256; fn++) {
      for (const param of [Uint8Array.of(fn), Uint8Array.of(fn, 0, 0, 0, 0, 0, 0, 0)]) {
        n++;
        try {
          send(dt(encodeS7(job(param))));
          passed.push(fn);
        } catch (e) {
          expect((e as { code: string }).code).toBe('FORBIDDEN');
        }
      }
    }
    expect(n).toBe(512);
    expect(passed).toEqual([0x1e, 0x1f]);
    expect(sends.length).toBe(2);
  });

  it('ogni nibble type x gruppo (0-15) x sottofunzione (0-255) per ROSCTR 7: passano solo le 6 forme canoniche', () => {
    const { sends, send } = senderRig();
    let n = 0;
    const passed: string[] = [];
    for (let type = 0; type < 16; type++) {
      for (let group = 0; group < 16; group++) {
        for (let sub = 0; sub < 256; sub++) {
          n++;
          const key = `${group}/${sub}`;
          const c = canon[key];
          const param = Uint8Array.of(0, 1, 0x12, 4, 0x11, (type << 4) | group, sub, 0);
          try {
            send(dt(encodeS7(job(param, c?.data ?? empty, 7))));
            passed.push(`${type}:${key}`);
          } catch (e) {
            expect((e as { code: string }).code).toBe('FORBIDDEN');
          }
        }
      }
    }
    expect(n).toBe(65536);
    expect(passed.sort()).toEqual(
      Object.keys(canon)
        .map((k) => `4:${k}`)
        .sort(),
    );
    expect(sends.length).toBe(6);
  });

  it('method byte (256 valori) dei userdata: passa solo 0x11 nella richiesta iniziale', () => {
    const { sends, send } = senderRig();
    for (let m = 0; m < 256; m++) {
      const param = reqReadSzl(0x11, 0).param.slice();
      param[4] = m;
      const frame = dt(encodeS7(job(param, reqReadSzl(0x11, 0).data, 7)));
      if (m === 0x11) {
        send(frame);
      } else {
        expect(() => send(frame)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
      }
    }
    expect(sends.length).toBe(1);
  });

  it("tutti i 256 valori dei 3 byte COTP DT e dei 2 byte dell'id di ridondanza: passa solo il valore canonico", () => {
    const { sends, send } = senderRig();
    const base = dt(
      encodeS7(job(encodeReadRequest([{ area: 'M', db: 0, start: 0, size: 'BYTE', count: 1 }]))),
    );
    // indici: 4,5,6 = COTP DT; 4+3+2, 4+3+3 = id di ridondanza
    for (const at of [4, 5, 6, 9, 10]) {
      for (let v = 0; v < 256; v++) {
        const f = base.slice();
        f[at] = v;
        try {
          send(f);
        } catch (e) {
          expect((e as { code: string }).code).toBe('FORBIDDEN');
        }
      }
    }
    expect(sends.length).toBe(5);
  });
});

describe('TOCTOU: il registratore non può cambiare i byte approvati', () => {
  const good = dt(encodeS7(job(reqReadSzl(0x11, 0).param, reqReadSzl(0x11, 0).data, 7)));

  it('un registratore che riscrive il suo buffer, subito e dopo un ritardo, non tocca i byte inviati', async () => {
    const received: Uint8Array[] = [];
    const snapshots: Uint8Array[] = [];
    const rec = {
      record(_d: 'tx' | 'rx', bytes: Uint8Array) {
        bytes.fill(0xee);
        setTimeout(() => bytes.fill(0x66), 5);
      },
      frames: () => [],
    };
    const send = guardedSender(
      {
        send: (b) => {
          received.push(b);
          snapshots.push(b.slice());
        },
      },
      rec,
      () => undefined,
    );
    send(good);
    await new Promise((r) => setTimeout(r, 30));
    expect(received[0]).toEqual(good);
    expect(snapshots[0]).toEqual(good);
  });

  it("il chiamante che modifica il proprio buffer dopo l'invio non cambia ciò che ha il trasporto", () => {
    const received: Uint8Array[] = [];
    const send = guardedSender({ send: (b) => void received.push(b) }, undefined, () => undefined);
    const mine = good.slice();
    send(mine);
    mine.fill(0x05);
    expect(received[0]).toEqual(good);
    expect(received[0]).not.toBe(mine);
  });

  it("il registratore riceve il frame solo dopo l'invio; un invio fallito non è registrato", () => {
    const order: string[] = [];
    const rec = {
      record: () => void order.push('rec'),
      frames: () => [],
    };
    const ok = guardedSender({ send: () => void order.push('send') }, rec, () => undefined);
    ok(good);
    expect(order).toEqual(['send', 'rec']);
    const failing = guardedSender(
      {
        send: () => {
          throw new Error('rotto');
        },
      },
      rec,
      () => undefined,
    );
    expect(() => failing(good)).toThrow('rotto');
    expect(order).toEqual(['send', 'rec']);
  });

  it('il registratore riceve una copia senza TPKT; gli errori del registratore sono ignorati', () => {
    const seen: Uint8Array[] = [];
    const rec = {
      record: (_d: 'tx' | 'rx', b: Uint8Array) => {
        seen.push(b);
        throw new Error('registratore rotto');
      },
      frames: () => [],
    };
    const send = guardedSender({ send: () => undefined }, rec, () => undefined);
    expect(() => send(good)).not.toThrow();
    expect(seen[0]).toEqual(good.slice(4));
  });
});

describe('guardedSender e modo', () => {
  const w = encodeWriteRequest([
    { area: 'M', db: 0, start: 0, size: 'BYTE', count: 1, data: Uint8Array.of(1) },
  ]);
  const frame = dt(encodeS7(job(w.param, w.data)));

  it('il modo di default rifiuta la write var e non invia nulla; online-write la invia', () => {
    const r = senderRig();
    expect(() => r.send(frame)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(r.sends).toHaveLength(0);
    expect(r.refused()).toBe(1);
    const sends: Uint8Array[] = [];
    guardedSender(
      { send: (b) => void sends.push(b) },
      undefined,
      () => undefined,
      'online-write',
    )(frame);
    expect(sends).toHaveLength(1);
  });
});
