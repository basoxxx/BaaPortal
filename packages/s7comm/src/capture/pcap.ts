import { S7Error } from '../errors';
import type { CaptureStream } from './captureLog';
import { extractStreams } from './tcpStreams';

/** Un pacchetto grezzo: tipo di collegamento (LINKTYPE_*), istante in ns e byte catturati. */
export interface RawPacket {
  link: number;
  ns: bigint;
  data: Uint8Array;
}

const bad = (msg: string): S7Error => new S7Error('PROTOCOL', `cattura: ${msg}`);

/** Un pacchetto troncato in fondo non è un errore: si tengono quelli prima. */
export function readPackets(bytes: Uint8Array): RawPacket[] {
  if (bytes.length < 4) throw bad('file troppo corto');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, false);
  if (magic === 0x0a0d0d0a) return readPcapng(bytes, dv);
  if (
    magic === 0xa1b2c3d4 ||
    magic === 0xd4c3b2a1 ||
    magic === 0xa1b23c4d ||
    magic === 0x4d3cb2a1
  ) {
    return readClassic(bytes, dv, magic);
  }
  throw bad('non è un file pcap né pcapng');
}

function readClassic(bytes: Uint8Array, dv: DataView, magic: number): RawPacket[] {
  if (bytes.length < 24) throw bad('intestazione pcap troncata');
  const le = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
  const nano = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
  const link = dv.getUint32(20, le) & 0x0fffffff; // i bit alti sono flag FCS
  const out: RawPacket[] = [];
  for (let o = 24; o + 16 <= bytes.length;) {
    const sec = dv.getUint32(o, le);
    const frac = dv.getUint32(o + 4, le);
    const incl = dv.getUint32(o + 8, le);
    if (o + 16 + incl > bytes.length) break; // ultimo pacchetto troncato
    const ns = BigInt(sec) * 1_000_000_000n + BigInt(frac) * (nano ? 1n : 1000n);
    out.push({ link, ns, data: bytes.subarray(o + 16, o + 16 + incl) });
    o += 16 + incl;
  }
  return out;
}

interface Iface {
  link: number;
  /** Tick al secondo. */
  perSec: bigint;
}

function readPcapng(bytes: Uint8Array, dv: DataView): RawPacket[] {
  const out: RawPacket[] = [];
  let le = true;
  let ifaces: Iface[] = [];
  let lastNs = 0n;
  let first = true;
  for (let o = 0; o + 12 <= bytes.length;) {
    const type0 = dv.getUint32(o, false);
    if (first && type0 !== 0x0a0d0d0a) throw bad('pcapng: manca la Section Header');
    if (type0 === 0x0a0d0d0a) {
      // Section Header: l'ordine dei byte della sezione sta nel suo magic.
      if (o + 12 > bytes.length) break;
      const bom = dv.getUint32(o + 8, false);
      if (bom === 0x4d3c2b1a) le = true;
      else if (bom === 0x1a2b3c4d) le = false;
      else throw bad('pcapng: ordine dei byte non riconosciuto');
      ifaces = [];
    }
    first = false;
    const type = dv.getUint32(o, le);
    const len = dv.getUint32(o + 4, le);
    if (len < 12 || len % 4 !== 0) throw bad(`pcapng: lunghezza di blocco ${len} non valida`);
    if (o + len > bytes.length) break; // ultimo blocco troncato
    if (dv.getUint32(o + len - 4, le) !== len)
      throw bad('pcapng: lunghezza finale del blocco diversa');
    const bodyEnd = o + len - 4;
    if (type === 1) {
      if (len < 20) throw bad('pcapng: Interface Description troppo corto');
      let perSec = 1_000_000n;
      for (let p = o + 16; p + 4 <= bodyEnd;) {
        const code = dv.getUint16(p, le);
        const olen = dv.getUint16(p + 2, le);
        if (code === 0) break;
        if (p + 4 + olen > bodyEnd) break;
        if (code === 9 && olen >= 1) {
          const r = bytes[p + 4]!;
          const exp = BigInt(r & 0x7f);
          if (exp > 62n) throw bad('pcapng: risoluzione del tempo non supportata');
          perSec = r & 0x80 ? 1n << exp : 10n ** exp;
        }
        p += 4 + ((olen + 3) & ~3);
      }
      ifaces.push({ link: dv.getUint16(o + 8, le), perSec });
    } else if (type === 6) {
      if (len < 32) throw bad('pcapng: Enhanced Packet troppo corto');
      const iface = ifaces[dv.getUint32(o + 8, le)];
      if (!iface) throw bad("pcapng: pacchetto di un'interfaccia sconosciuta");
      const ticks = (BigInt(dv.getUint32(o + 12, le)) << 32n) | BigInt(dv.getUint32(o + 16, le));
      const cap = dv.getUint32(o + 20, le);
      if (28 + cap > len - 4) throw bad('pcapng: lunghezza catturata oltre il blocco');
      lastNs = (ticks * 1_000_000_000n) / iface.perSec;
      out.push({ link: iface.link, ns: lastNs, data: bytes.subarray(o + 28, o + 28 + cap) });
    } else if (type === 3) {
      const iface = ifaces[0];
      if (!iface) throw bad('pcapng: Simple Packet senza interfaccia');
      if (len < 16) throw bad('pcapng: Simple Packet troppo corto');
      const orig = dv.getUint32(o + 8, le);
      const cap = Math.min(orig, len - 16);
      out.push({ link: iface.link, ns: lastNs, data: bytes.subarray(o + 12, o + 12 + cap) });
    }
    o += len;
  }
  return out;
}

/**
 * Legge pcap (µs o ns, i due ordini dei byte) e pcapng (SHB, IDB, EPB, SPB, più interfacce) e
 * ne ricava le connessioni TCP sulla porta 102 con i frame TPKT ricomposti. File non valido:
 * S7Error('PROTOCOL').
 */
export function readPcap(bytes: Uint8Array): CaptureStream[] {
  return extractStreams(readPackets(bytes));
}
