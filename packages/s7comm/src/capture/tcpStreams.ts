import { FrameReader } from '../tpkt';
import type { CaptureStream, CapturedFrame } from './captureLog';
import type { RawPacket } from './pcap';

const PORT = 102;
const MAX_PENDING = 8;

/** Il pacchetto IPv4 dentro il frame del livello collegamento, o null se non è IPv4. */
function ipv4Of(link: number, d: Uint8Array): Uint8Array | null {
  switch (link) {
    case 1: {
      // Ethernet II, con eventuali tag 802.1Q / 802.1ad
      if (d.length < 14) return null;
      let o = 12;
      let et = (d[o]! << 8) | d[o + 1]!;
      while ((et === 0x8100 || et === 0x88a8 || et === 0x9100) && o + 6 <= d.length) {
        o += 4;
        et = (d[o]! << 8) | d[o + 1]!;
      }
      return et === 0x0800 ? d.subarray(o + 2) : null;
    }
    case 113: // Linux cooked SLL
      return d.length >= 16 && d[14] === 0x08 && d[15] === 0x00 ? d.subarray(16) : null;
    case 276: // Linux cooked SLL2
      return d.length >= 20 && d[0] === 0x08 && d[1] === 0x00 ? d.subarray(20) : null;
    case 0: // BSD loopback
      return d.length >= 4 ? d.subarray(4) : null;
    case 12:
    case 101:
    case 228: // IP grezzo
      return d;
    default:
      return null;
  }
}

interface Seg {
  seq: number;
  data: Uint8Array;
  ns: bigint;
}

/**
 * Un verso di una connessione: ricomposizione TCP in ordine di sequenza e poi TPKT.
 *
 * Le catture pubbliche hanno spesso dei buchi (pacchetti filtrati o persi). Un segmento oltre un
 * buco aspetta qualche segmento (può essere solo fuori ordine); se il buco non si chiude, si
 * riparte da lì: i byte mancanti sono persi e si riprende dal primo segmento che inizia con un
 * header TPKT.
 */
class Direction {
  private next: number | null = null;
  private reader = new FrameReader();
  private pending: Seg[] = [];
  /** True finché non si è sicuri di essere all'inizio di un TPKT (dopo un buco o senza SYN). */
  private needSync = true;
  /** Un frame non può essere "arrivato" prima di quelli che lo precedono nel flusso. */
  private lastNs = 0n;

  constructor(
    private readonly dir: 'tx' | 'rx',
    private readonly out: { ns: bigint; dir: 'tx' | 'rx'; bytes: Uint8Array }[],
  ) {}

  /** SYN: consuma un numero di sequenza; da qui i dati iniziano a un confine di TPKT. */
  syn(seq: number): void {
    this.next = (seq + 1) >>> 0;
    this.needSync = false;
  }

  started(): boolean {
    return this.next !== null;
  }

  segment(seq: number, payload: Uint8Array, ns: bigint): void {
    if (payload.length === 0) return;
    this.next ??= seq;
    this.pending.push({ seq, data: payload, ns });
    this.drain();
    if (this.pending.length > MAX_PENDING) this.finish();
  }

  /** Svuota i segmenti in attesa, accettando i buchi. */
  finish(): void {
    const base = this.next;
    if (base === null) return;
    this.pending.sort((a, b) => ((a.seq - base) | 0) - ((b.seq - base) | 0));
    const rest = this.pending;
    this.pending = [];
    for (const s of rest) {
      const diff = (s.seq - this.next!) | 0;
      if (diff > 0) {
        this.next = s.seq; // buco: i byte mancanti sono persi
        this.reader = new FrameReader();
        this.needSync = true;
      }
      const skip = Math.max(0, -diff);
      if (skip < s.data.length) this.apply(s.data.subarray(skip), s.ns);
    }
  }

  private drain(): void {
    for (let progress = true; progress;) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const s = this.pending[i]!;
        const diff = (s.seq - this.next!) | 0;
        if (diff > 0) continue; // è oltre un buco: aspetta
        this.pending.splice(i, 1);
        const skip = -diff; // parte già vista (ritrasmissione o sovrapposizione)
        if (skip < s.data.length) this.apply(s.data.subarray(skip), s.ns);
        progress = true;
        break;
      }
    }
  }

  private apply(data: Uint8Array, ns: bigint): void {
    this.next = (this.next! + data.length) >>> 0;
    if (this.needSync) {
      if (data[0] !== 3) return; // continuazione di un frame di cui manca l'inizio
      this.needSync = false;
    }
    if (ns > this.lastNs) this.lastNs = ns;
    try {
      for (const bytes of this.reader.push(data)) {
        this.out.push({ ns: this.lastNs, dir: this.dir, bytes });
      }
    } catch {
      // Non è TPKT (o è disallineato): si scartano i byte e si aspetta un nuovo inizio.
      this.reader = new FrameReader();
      this.needSync = true;
    }
  }
}

class Conn {
  readonly frames: { ns: bigint; dir: 'tx' | 'rx'; bytes: Uint8Array }[] = [];
  readonly tx = new Direction('tx', this.frames);
  readonly rx = new Direction('rx', this.frames);
  constructor(
    readonly client: string,
    readonly server: string,
  ) {}
}

/** Connessioni TCP sulla porta 102, in ordine di apparizione, solo quelle con almeno un frame. */
export function extractStreams(packets: RawPacket[]): CaptureStream[] {
  const all: Conn[] = [];
  const live = new Map<string, Conn>();
  for (const pkt of packets) {
    const ip = ipv4Of(pkt.link, pkt.data);
    if (!ip || ip.length < 20 || ip[0]! >> 4 !== 4 || ip[9] !== 6) continue;
    const ihl = (ip[0]! & 15) * 4;
    const total = Math.min((ip[2]! << 8) | ip[3]!, ip.length);
    if (ihl < 20 || total < ihl + 20) continue;
    if (((ip[6]! & 0x1f) << 8) + ip[7]! !== 0 || (ip[6]! & 0x20) !== 0) continue; // frammento
    const tcp = ip.subarray(ihl, total);
    const doff = (tcp[12]! >> 4) * 4;
    if (doff < 20 || doff > tcp.length) continue;
    const sp = (tcp[0]! << 8) | tcp[1]!;
    const dp = (tcp[2]! << 8) | tcp[3]!;
    if (sp !== PORT && dp !== PORT) continue;
    const a = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}:${sp}`;
    const b = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}:${dp}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const flags = tcp[13]!;
    const seq = ((tcp[4]! << 24) | (tcp[5]! << 16) | (tcp[6]! << 8) | tcp[7]!) >>> 0;
    const pureSyn = (flags & 0x12) === 0x02;

    let conn = live.get(key);
    // Un SYN su una quadrupla già usata apre un'altra connessione.
    if (pureSyn && conn && (conn.tx.started() || conn.rx.started())) conn = undefined;
    if (!conn) {
      // Il server è l'estremo sulla porta 102; se lo sono entrambi, il destinatario del primo pacchetto.
      const toServer = dp === PORT;
      conn = toServer ? new Conn(a, b) : new Conn(b, a);
      live.set(key, conn);
      all.push(conn);
    }
    const fromClient = a === conn.client;
    const dir = fromClient ? conn.tx : conn.rx;
    if (flags & 0x02) {
      if (pureSyn || !dir.started()) dir.syn(seq);
      continue;
    }
    dir.segment(seq, tcp.subarray(doff), pkt.ns);
  }

  const out: CaptureStream[] = [];
  for (const c of all) {
    c.tx.finish();
    c.rx.finish();
    // I frame di un buco escono con ritardo: l'ordine è quello dell'istante di arrivo (sort stabile).
    c.frames.sort((x, y) => (x.ns < y.ns ? -1 : x.ns > y.ns ? 1 : 0));
    if (c.frames.length === 0) continue;
    const t0 = c.frames[0]!.ns;
    const frames: CapturedFrame[] = c.frames.map((f) => ({
      t: Number((f.ns - t0) / 1000n) / 1000, // ms, al microsecondo
      dir: f.dir,
      bytes: f.bytes,
    }));
    out.push({ client: c.client, server: c.server, frames });
  }
  return out;
}
