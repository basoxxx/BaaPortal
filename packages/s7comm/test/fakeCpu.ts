import {
  FrameReader,
  decodeCotp,
  decodeS7,
  decodeSetup,
  encodeCotp,
  encodeS7,
  encodeSetup,
  encodeTpkt,
  type CotpPdu,
  type S7Pdu,
  type Transport,
} from '../src';

export interface FakeCpuOptions {
  pdu?: number;
  amq?: number;
  /** Come risponde alla CR. */
  connect?: 'cc' | 'dr' | 'er' | 'silent';
  /** Risposta al setup: 'silent' non risponde. */
  setup?: 'ok' | 'silent';
  /** Per ogni PDU S7 diversa dal setup. */
  onPdu?: (pdu: S7Pdu, cpu: FakeCpu) => void;
}

/** Finto PLC minimo, solo per i test della connessione: guida un'estremità del trasporto in memoria. */
export class FakeCpu {
  readonly cotp: CotpPdu[] = [];
  readonly pdus: S7Pdu[] = [];
  private readonly reader = new FrameReader();

  constructor(
    readonly end: Transport,
    private readonly opts: FakeCpuOptions = {},
  ) {
    end.onData((chunk) => {
      for (const payload of this.reader.push(chunk)) this.handle(payload);
    });
    end.onClose(() => undefined);
  }

  sendCotp(p: CotpPdu): void {
    this.end.send(encodeTpkt(encodeCotp(p)));
  }

  sendPdu(p: S7Pdu): void {
    this.sendCotp({ type: 'DT', eot: true, data: encodeS7(p) });
  }

  /** Risposta (ROSCTR 3) con lo stesso riferimento. */
  ack(ref: number, param: Uint8Array, data = new Uint8Array(0)): void {
    this.sendPdu({ rosctr: 3, pduRef: ref, errorClass: 0, errorCode: 0, param, data });
  }

  private handle(payload: Uint8Array): void {
    const c = decodeCotp(payload);
    this.cotp.push(c);
    if (c.type === 'CR') {
      const mode = this.opts.connect ?? 'cc';
      if (mode === 'cc') {
        this.sendCotp({
          type: 'CC',
          dstRef: c.srcRef,
          srcRef: 0x0001,
          tpduSize: c.tpduSize,
          srcTsap: c.srcTsap,
          dstTsap: c.dstTsap,
        });
      } else if (mode === 'dr') {
        this.sendCotp({ type: 'DR', dstRef: c.srcRef, srcRef: 1, reason: 0x03 });
      } else if (mode === 'er') {
        this.sendCotp({ type: 'ER', dstRef: c.srcRef, cause: 0x01 });
      }
      return;
    }
    if (c.type !== 'DT') return;
    const pdu = decodeS7(c.data);
    if (pdu.rosctr === 1 && pdu.param[0] === 0xf0) {
      this.pdus.push(pdu);
      if ((this.opts.setup ?? 'ok') === 'ok') {
        const req = decodeSetup(pdu.param);
        this.ack(
          pdu.pduRef,
          encodeSetup({
            amqCalling: this.opts.amq ?? req.amqCalling,
            amqCalled: this.opts.amq ?? req.amqCalled,
            pduLength: this.opts.pdu ?? 240,
          }),
        );
      }
      return;
    }
    this.pdus.push(pdu);
    this.opts.onPdu?.(pdu, this);
  }
}
