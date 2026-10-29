import {
  FrameReader,
  MpiFrameDecoder,
  decodeCotp,
  encodeCotp,
  encodeMpiFrame,
  encodeTpkt,
  hex,
  memoryTransportPair,
  type Transport,
} from '@baaportal/s7comm';
import type { CpuBackend } from './backend';
import { serve } from './session';

export interface FakeMpiAdapterOptions {
  /** Variante che l'adattatore parla; all'altra non risponde. Default `v1`. */
  variant?: 'v1' | 'v2';
  /** Indirizzo MPI della CPU finta. Default 2. */
  cpuAddress?: number;
  /** Stazioni attive nell'elenco dei nodi. Default `[0, cpuAddress]`. */
  nodes?: number[];
  /** Chiude la porta (cavo staccato) appena arriva dal PC una PDU per cui è vera. */
  dropOn?: (s7: Uint8Array) => boolean;
  /** Smette di rispondere (adattatore spento, cavo RS232 staccato) dopo una PDU per cui è vera. */
  muteOn?: (s7: Uint8Array) => boolean;
}

export interface FakeMpiAdapter {
  /** Byte arrivati dal PC, un elemento per `send`. */
  readonly received: Uint8Array[];
  close(): void;
}

const STX = 0x02;
const DLE = 0x10;
/** Numero di connessione dell'adattatore verso il PC: 0x10, così il PC lo riceve raddoppiato. */
const OUR_CN = 0x10;
const VERSION_TEXT = [0x56, 0x30, 0x30, 0x2e, 0x38, 0x33]; // "V00.83"

/**
 * PC Adapter MPI finto (lato adattatore del protocollo di `@baaportal/s7comm`, scheda in
 * `mpi/adapter.ts`): init, elenco dei nodi, connessione e telegrammi F1/B0. Le PDU S7 vanno a
 * una sessione `serve(cpu)` vera attraverso ISO-on-TCP in memoria, come le prove in TCP.
 */
export function serveMpiAdapter(
  cpu: CpuBackend,
  t: Transport,
  o: FakeMpiAdapterOptions = {},
): FakeMpiAdapter {
  const variant = o.variant ?? 'v1';
  const cpuAddress = o.cpuAddress ?? 2;
  const nodes = o.nodes ?? [0, cpuAddress];
  const h = variant === 'v1' ? 6 : 4;
  const received: Uint8Array[] = [];
  const dec = new MpiFrameDecoder();
  const out: Uint8Array[] = [];
  let state: 'idle' | 'rx' | 'tx1' | 'tx2' = 'idle';
  let closed = false;
  let mute = false;
  let pcCn = 0;
  let rnr = 0;
  let iso: Transport | undefined;

  const put = (b: Uint8Array): void => {
    if (closed || mute) return;
    try {
      t.send(b);
    } catch {
      shutdown();
    }
  };
  const kick = (): void => {
    if (state !== 'idle' || out.length === 0) return;
    state = 'tx1';
    put(Uint8Array.of(STX));
  };
  const reply = (p: number[] | Uint8Array): void => {
    out.push(Uint8Array.from(p));
    kick();
  };
  const header = (): number[] =>
    variant === 'v1'
      ? [0x04, 0x80 | cpuAddress, 0x80, 0x0c, pcCn, OUR_CN]
      : [0x00, 0x0c, pcCn, OUR_CN];

  function shutdown(): void {
    if (closed) return;
    closed = true;
    iso?.close();
    iso = undefined;
    try {
      t.close();
    } catch {
      // già chiuso
    }
  }

  /** ISO-on-TCP verso la sessione: CR, poi le DT riassemblate diventano telegrammi F1. */
  function openIso(): void {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    iso = a;
    const reader = new FrameReader();
    const parts: number[] = [];
    a.onData((chunk) => {
      for (const payload of reader.push(chunk)) {
        const c = decodeCotp(payload);
        if (c.type === 'CC') {
          reply([...header(), 0xd0, ...confirmTail()]);
        } else if (c.type === 'DT') {
          parts.push(...c.data);
          if (!c.eot) continue;
          rnr = rnr === 0xff ? 1 : rnr + 1;
          reply([...header(), 0xf1, rnr, ...parts.splice(0)]);
        } else {
          shutdown();
        }
      }
    });
    a.onClose(() => {
      if (iso === a) shutdown();
    });
    a.send(
      encodeTpkt(
        encodeCotp({
          type: 'CR',
          dstRef: 0,
          srcRef: 0x0100,
          tpduSize: 0x0a,
          srcTsap: 0x0100,
          dstTsap: 0x0102,
        }),
      ),
    );
  }

  const confirmTail = (): number[] =>
    variant === 'v1'
      ? [0x04, 0x00, 0x80, 0x00, 0x02, 0x00, 0x02, 0x01, 0x00, 0x01, 0x00]
      : [
          0x04,
          0x00,
          0x80,
          0x01,
          0x06,
          0x00,
          0x02,
          0x00,
          0x01,
          0x02,
          cpuAddress,
          0x01,
          0x00,
          0x01,
          0x00,
        ];

  function onFrame(p: Uint8Array): void {
    const k = hex(p);
    if (k === '010d02') {
      if (variant === 'v1') reply([0x01, 0x0d, 0x20, ...VERSION_TEXT]);
      return;
    }
    if (k.startsWith('010302')) {
      if (p[3] === (variant === 'v1' ? 0x27 : 0x17)) reply([0x01, 0x03, 0x20, ...VERSION_TEXT]);
      return;
    }
    if (k === '010702') {
      const list = new Uint8Array(133).fill(0x10);
      list.set([0x01, 0x07, 0x20, 0, 0, 0]);
      for (const n of nodes) list[6 + n] = 0x30;
      reply(list);
      return;
    }
    if (k === '010402') {
      reply([0x01, 0x04, 0x20]);
      return;
    }
    const isConnect =
      variant === 'v1' ? p[0] === 0x04 && p[3] === 0x0d : p[0] === 0x00 && p[1] === 0x0d;
    if (isConnect) {
      const addr = variant === 'v1' ? p[1]! & 0x7f : p[17];
      if (addr !== cpuAddress || iso) return; // nessuna CPU a quell'indirizzo: silenzio
      pcCn = p[h - 1]!;
      openIso();
      return;
    }
    switch (p[h]) {
      case 0x05:
        reply([...header(), 0x05, 0x01]);
        return;
      case 0xf1: {
        const s7 = p.slice(h + 2);
        if (o.dropOn?.(s7)) return shutdown();
        if (o.muteOn?.(s7)) {
          mute = true;
          return;
        }
        reply([...header(), 0xb0, 0x01, p[h + 1]!]);
        iso?.send(encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: s7 })));
        return;
      }
      case 0x80:
        reply([...header(), 0xc0]);
        iso?.close();
        iso = undefined;
        return;
      default:
        return; // B0 del PC e il resto
    }
  }

  t.onClose(() => shutdown());
  t.onData((chunk) => {
    if (closed) return;
    received.push(chunk.slice());
    let items;
    try {
      items = dec.push(chunk);
    } catch {
      return shutdown();
    }
    for (const it of items) {
      if (closed) return;
      if (it === 'STX') {
        // collisione: vince l'adattatore, lo STX del PC si ignora finché il nostro frame non passa
        if (state === 'idle') {
          state = 'rx';
          put(Uint8Array.of(DLE));
        }
      } else if (it === 'DLE') {
        if (state === 'tx1') {
          state = 'tx2';
          put(encodeMpiFrame(out[0]!));
        } else if (state === 'tx2') {
          out.shift();
          state = 'idle';
          kick();
        }
      } else if (state === 'rx') {
        put(Uint8Array.of(DLE));
        state = 'idle';
        onFrame(it);
        kick();
      }
    }
  });
  return { received, close: shutdown };
}
