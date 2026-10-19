import { S7Error } from './errors';

/** Proto §1: lunghezza totale (header incluso) minima 7, massima teorica 65535. */
const TPKT_MIN = 7;
const TPKT_MAX = 0xffff;

export function encodeTpkt(payload: Uint8Array): Uint8Array {
  const total = payload.length + 4;
  if (total > TPKT_MAX) throw new RangeError(`TPKT troppo lungo: ${total}`);
  const out = new Uint8Array(total);
  out[0] = 3;
  out[1] = 0;
  out[2] = (total >>> 8) & 0xff;
  out[3] = total & 0xff;
  out.set(payload, 4);
  return out;
}

export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);

  /**
   * Restituisce i payload (senza header TPKT) completi. Dopo un S7Error il lettore
   * non è più utilizzabile: il chiamante chiude la connessione.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const out: Uint8Array[] = [];
    let pos = 0;
    while (this.buf.length - pos >= 4) {
      const version = this.buf[pos]!;
      if (version !== 3) throw new S7Error('PROTOCOL', `TPKT: versione ${version} non valida`);
      const len = (this.buf[pos + 2]! << 8) | this.buf[pos + 3]!;
      if (len < TPKT_MIN || len > TPKT_MAX) {
        throw new S7Error('PROTOCOL', `TPKT: lunghezza ${len} non valida`);
      }
      if (this.buf.length - pos < len) break;
      out.push(this.buf.slice(pos + 4, pos + len));
      pos += len;
    }
    this.buf = this.buf.slice(pos);
    return out;
  }
}
