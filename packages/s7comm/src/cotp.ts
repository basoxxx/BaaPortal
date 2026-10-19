import { S7Error } from './errors';

export type CotpPdu =
  | {
      type: 'CR' | 'CC';
      dstRef: number;
      srcRef: number;
      tpduSize?: number;
      srcTsap?: number;
      dstTsap?: number;
    }
  | { type: 'DT'; eot: boolean; data: Uint8Array }
  | { type: 'DR'; dstRef: number; srcRef: number; reason: number }
  | { type: 'ER'; dstRef: number; cause: number };

const CODE = { CR: 0xe0, CC: 0xd0, DT: 0xf0, DR: 0x80, ER: 0x70 } as const;

export function encodeCotp(p: CotpPdu): Uint8Array {
  switch (p.type) {
    case 'DT': {
      const out = new Uint8Array(3 + p.data.length);
      out[0] = 0x02;
      out[1] = CODE.DT;
      out[2] = p.eot ? 0x80 : 0x00;
      out.set(p.data, 3);
      return out;
    }
    case 'CR':
    case 'CC': {
      const params: number[] = [];
      const size = (): void => {
        if (p.tpduSize !== undefined) params.push(0xc0, 1, p.tpduSize & 0xff);
      };
      const src = (): void => {
        if (p.srcTsap !== undefined)
          params.push(0xc1, 2, (p.srcTsap >>> 8) & 0xff, p.srcTsap & 0xff);
      };
      const dst = (): void => {
        if (p.dstTsap !== undefined)
          params.push(0xc2, 2, (p.dstTsap >>> 8) & 0xff, p.dstTsap & 0xff);
      };
      // Ordine di proto §17.1: CR = C1 C2 C0, CC = C0 C1 C2.
      if (p.type === 'CR') {
        src();
        dst();
        size();
      } else {
        size();
        src();
        dst();
      }
      const out = new Uint8Array(7 + params.length);
      out[0] = 6 + params.length;
      out[1] = CODE[p.type];
      out[2] = (p.dstRef >>> 8) & 0xff;
      out[3] = p.dstRef & 0xff;
      out[4] = (p.srcRef >>> 8) & 0xff;
      out[5] = p.srcRef & 0xff;
      out[6] = 0x00; // classe 0, nessuna opzione (S7 vuole 0x00)
      out.set(params, 7);
      return out;
    }
    case 'DR':
      return Uint8Array.of(
        6,
        CODE.DR,
        (p.dstRef >>> 8) & 0xff,
        p.dstRef & 0xff,
        (p.srcRef >>> 8) & 0xff,
        p.srcRef & 0xff,
        p.reason & 0xff,
      );
    case 'ER':
      return Uint8Array.of(4, CODE.ER, (p.dstRef >>> 8) & 0xff, p.dstRef & 0xff, p.cause & 0xff);
  }
}

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `COTP: ${msg}`);
}

export function decodeCotp(b: Uint8Array): CotpPdu {
  if (b.length < 2) throw bad('PDU troppo corta');
  const li = b[0]!;
  const hdrEnd = 1 + li; // primo byte dopo l'header
  if (b.length < hdrEnd) throw bad('header troncato');
  const code = b[1]! & 0xf0; // il nibble basso è il credito
  switch (code) {
    case CODE.DT: {
      if (li < 2) throw bad('DT: LI troppo corto');
      return { type: 'DT', eot: (b[2]! & 0x80) !== 0, data: b.slice(hdrEnd) };
    }
    case CODE.CR:
    case CODE.CC: {
      if (li < 6) throw bad('CR/CC: LI troppo corto');
      const pdu: CotpPdu = {
        type: code === CODE.CR ? 'CR' : 'CC',
        dstRef: (b[2]! << 8) | b[3]!,
        srcRef: (b[4]! << 8) | b[5]!,
      };
      let i = 7; // b[6] = classe/opzioni, accettato qualunque valore
      while (i < hdrEnd) {
        if (i + 2 > hdrEnd) throw bad('parametro troncato');
        const pc = b[i]!;
        const pl = b[i + 1]!;
        if (i + 2 + pl > hdrEnd) throw bad('parametro troncato');
        const v = i + 2;
        if (pc === 0xc0 && pl === 1) pdu.tpduSize = b[v]!;
        else if (pc === 0xc1 && pl === 2) pdu.srcTsap = (b[v]! << 8) | b[v + 1]!;
        else if (pc === 0xc2 && pl === 2) pdu.dstTsap = (b[v]! << 8) | b[v + 1]!;
        // parametri sconosciuti o con lunghezza inattesa: saltati
        i += 2 + pl;
      }
      return pdu;
    }
    case CODE.DR: {
      if (li < 6) throw bad('DR: LI troppo corto');
      return {
        type: 'DR',
        dstRef: (b[2]! << 8) | b[3]!,
        srcRef: (b[4]! << 8) | b[5]!,
        reason: b[6]!,
      };
    }
    case CODE.ER: {
      if (li < 4) throw bad('ER: LI troppo corto');
      return { type: 'ER', dstRef: (b[2]! << 8) | b[3]!, cause: b[4]! };
    }
    default:
      throw bad(`tipo PDU 0x${b[1]!.toString(16)} non supportato`);
  }
}
