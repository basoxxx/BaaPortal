import {
  FrameReader,
  decodeCotp,
  decodeS7,
  decodeUserdata,
  encodeCotp,
  encodeS7,
  encodeSetup,
  encodeTpkt,
  memoryTransportPair,
  parseSzl,
  reqContinue,
  reqReadSzl,
  type CotpPdu,
  type DecodedUserdata,
  type S7Pdu,
  type SzlList,
  type Transport,
  type UserdataFrame,
} from '@baaportal/s7comm';
import { serve, type FakeCpu } from '../src';

export const NOTHING = new Uint8Array(0);

/** Lascia girare le microtask e i timer a zero ritardo (la consegna in memoria è asincrona). */
export const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Estremità cliente di una sessione `serve` su un trasporto in memoria. */
export class TestPeer {
  readonly cotp: CotpPdu[] = [];
  readonly pdus: S7Pdu[] = [];
  /** Byte di ogni chiamata `send` del server, come arrivati. */
  readonly chunks: Uint8Array[] = [];
  closed = false;
  pdu = 240;
  private ref = 0;
  private readonly reader = new FrameReader();
  private readonly parts: Uint8Array[] = [];
  readonly end: Transport;
  readonly server: { close(): void };

  constructor(cpu: FakeCpu) {
    const [a, b] = memoryTransportPair();
    this.end = a;
    this.server = serve(cpu, b);
    a.onData((chunk) => {
      this.chunks.push(chunk);
      for (const payload of this.reader.push(chunk)) {
        const c = decodeCotp(payload);
        this.cotp.push(c);
        if (c.type !== 'DT') continue;
        this.parts.push(c.data);
        if (!c.eot) continue;
        const whole = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of this.parts.splice(0)) {
          whole.set(p, at);
          at += p.length;
        }
        this.pdus.push(decodeS7(whole));
      }
    });
    a.onClose(() => {
      this.closed = true;
    });
  }

  sendCotp(p: CotpPdu): void {
    this.end.send(encodeTpkt(encodeCotp(p)));
  }

  sendRaw(bytes: Uint8Array): void {
    this.end.send(bytes);
  }

  async connect(
    o: { dstTsap?: number; srcTsap?: number; tpduSize?: number } = {},
  ): Promise<CotpPdu | undefined> {
    this.sendCotp({
      type: 'CR',
      dstRef: 0,
      srcRef: 0x0100,
      tpduSize: o.tpduSize ?? 0x0a,
      srcTsap: o.srcTsap ?? 0x0100,
      dstTsap: o.dstTsap ?? 0x0102,
    });
    await settle();
    return this.cotp.at(-1);
  }

  /** Invia una PDU S7 e restituisce l'ultima risposta arrivata (o undefined). */
  async send(p: Omit<S7Pdu, 'pduRef' | 'errorClass' | 'errorCode'> & { pduRef?: number }) {
    const before = this.pdus.length;
    const pduRef = p.pduRef ?? ++this.ref;
    this.sendCotp({
      type: 'DT',
      eot: true,
      data: encodeS7({ errorClass: 0, errorCode: 0, ...p, pduRef }),
    });
    await settle();
    return this.pdus.length > before ? this.pdus.at(-1) : undefined;
  }

  job(param: Uint8Array, data: Uint8Array = NOTHING, pduRef?: number) {
    return this.send({ rosctr: 1, param, data, pduRef });
  }

  userdata(frame: UserdataFrame, pduRef?: number) {
    return this.send({ rosctr: 7, param: frame.param, data: frame.data, pduRef });
  }

  async setup(pdu = 480, amq = 1) {
    const r = await this.job(encodeSetup({ amqCalling: amq, amqCalled: amq, pduLength: pdu }));
    return r;
  }

  /** Connessione completa: CR, CC, setup. */
  async open(pdu = 480): Promise<TestPeer> {
    await this.connect();
    const s = await this.setup(pdu);
    if (!s) throw new Error('nessuna risposta al setup');
    this.pdu = (s.param[6]! << 8) | s.param[7]!;
    return this;
  }

  /** Legge una SZL completa con le richieste di continuazione, come il client. */
  async readSzl(
    id: number,
    index: number,
  ): Promise<{ list?: SzlList; pieces: DecodedUserdata[]; error?: DecodedUserdata }> {
    const pieces: DecodedUserdata[] = [];
    let r = await this.userdata(reqReadSzl(id, index));
    for (;;) {
      if (!r) throw new Error('nessuna risposta');
      const u = decodeUserdata(r.param, r.data);
      if ((u.param.errorCode ?? 0) !== 0 || u.returnCode !== 0xff) return { pieces, error: u };
      pieces.push(u);
      if (u.param.lastDataUnit) {
        r = await this.userdata(reqContinue(4, 1, u.param.sequence));
        continue;
      }
      return { list: parseSzl(pieces.map((p) => p.payload)), pieces };
    }
  }

  close(): void {
    this.end.close();
  }
}

export function u16(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildBlockFile,
  decodeSzlRequest,
  dissect,
  hex,
  readPcap,
  type BlockType,
} from '@baaportal/s7comm';

const CISAGOV = resolve(__dirname, '../../s7comm/test/captures/cisagov');

/**
 * SZL complete di una cattura reale del repository (cisagov, BSD-3): i pezzi del payload per
 * "id/indice" richiesto (esadecimale), nell'ordine di arrivo.
 */
export function realSzl(file: 'snap7.pcap' | 's7ident.pcap'): Map<string, Uint8Array[]> {
  const out = new Map<string, Uint8Array[]>();
  for (const s of readPcap(readFileSync(resolve(CISAGOV, file)))) {
    let req = '';
    let frags: Uint8Array[] = [];
    for (const fr of s.frames) {
      const d = dissect(fr.bytes);
      if (d.kind !== 'szl' || !d.s7) continue;
      const u = decodeUserdata(d.s7.param, d.s7.data);
      if (u.param.method === 'request') {
        if (u.payload.length === 4) {
          const r = decodeSzlRequest(u.payload);
          req = `${r.id.toString(16)}/${r.index.toString(16)}`;
          frags = [];
        }
        continue;
      }
      frags.push(u.payload);
      if (!u.param.lastDataUnit) {
        if (!out.has(req)) out.set(req, frags);
        frags = [];
      }
    }
  }
  return out;
}

export const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };

/** File di blocco nel formato di proto §13, per `addBlock`. */
export function blockFile(
  type: BlockType,
  number: number,
  mc7: Uint8Array,
  language = 1,
  flags = 0x01,
): Uint8Array {
  return buildBlockFile(
    {
      type,
      number,
      language,
      flags,
      security: 0,
      codeTime: T0,
      interfaceTime: T0,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: mc7.length,
    },
    mc7,
    {
      author: 'BAA',
      family: 'TEST',
      name: `${type}${number}`.slice(0, 8),
      version: '1.1',
      checksum: 0x1234,
    },
  );
}

export const seq = (n: number, from = 0): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);

export { hex };
