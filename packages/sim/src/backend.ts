import {
  S7WriteClient,
  encodeBcdDateTimeShort,
  itemByteLength,
  memoryTransportPair,
  parseBlockFile,
  remoteTsap,
  type BlockListEntry,
  type BlockType,
  type ReadItem,
  type S7DateTime,
  type TransportFactory,
  type WriteItem,
} from '@baaportal/s7comm';
import {
  encodeStoredBlockInfo,
  serve,
  type CpuBackend,
  type CpuConfig,
  type ItemRead,
  type StoredBlock,
} from '@baaportal/s7-server';
import type { SimCpu } from './cpu';
import type { DiagEntry } from './diagnostics';

const BLOCK_TYPES: readonly BlockType[] = ['OB', 'DB', 'SDB', 'FC', 'SFC', 'FB', 'SFB'];

/** Id evento sintetici (0x9000 + n) per i codici della diagnostica simulata: non sono id Siemens. */
const EVENT_BASE = 0x9000;
const CODE_ORDER: readonly DiagEntry['code'][] = [
  'AVVIO',
  'STOP_RICHIESTO',
  'CANCELLAZIONE_TOTALE',
  'AREA_LUNGHEZZA',
  'DB_NON_CARICATO',
  'DB_NON_APERTO',
  'BLOCCO_NON_CARICATO',
  'STACK_BLOCCHI_PIENO',
  'STACK_ANNIDAMENTO_PIENO',
  'STACK_L_PIENO',
  'ISTRUZIONE_NON_S7300',
  'MC7_NON_ESEGUIBILE',
  'BCD_NON_VALIDO',
  'TEMPO_CICLO_SUPERATO',
  'NON_SIMULATA_2B',
];

function dateTimeOf(ms: number, fallback: S7DateTime): S7DateTime {
  if (!Number.isFinite(ms) || ms < 1e11) return fallback; // orologio non da calendario (test)
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    ms: d.getMilliseconds(),
    weekday: d.getDay() + 1,
  };
}

function wallClock(): S7DateTime {
  return dateTimeOf(Date.now(), {
    year: 2000,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    ms: 0,
    weekday: 7,
  });
}

/** Legge `len` byte (o i bit) di `buf` secondo `it`; `rc` 0x05 se fuori area. */
function sliceOf(buf: Uint8Array, it: ReadItem, len: number): ItemRead {
  if (it.size === 'BIT') {
    const first = it.start * 8 + (it.bit ?? 0);
    if (first + it.count > buf.length * 8) return { rc: 0x05 };
    const out = new Uint8Array(len);
    for (let i = 0; i < it.count; i++) {
      const at = first + i;
      if (((buf[at >> 3]! >> (at & 7)) & 1) !== 0) out[i >> 3] = out[i >> 3]! | (1 << (i & 7));
    }
    return { data: out };
  }
  if ((it.bit ?? 0) !== 0 || it.start + len > buf.length) return { rc: 0x05 };
  return { data: buf.slice(it.start, it.start + len) };
}

/**
 * Mostra una `SimCpu` al server S7 (`serve`): download, stop/start, lettura e scrittura passano
 * per lo stesso percorso del PLC, sulla memoria della CPU simulata.
 *
 * Periferia: la lettura dell'area P vede gli ingressi fisici (`physIn`), la scrittura le uscite
 * fisiche (`physOut`). T e C: zero in lettura e rifiuto in scrittura fino al piano 2B.
 */
export function simBackend(cpu: SimCpu, o: { orderNumber?: string } = {}): CpuBackend {
  const m = cpu.memory;
  const orderNumber = o.orderNumber ?? '6ES7 315-2EH14-0AB0';
  if (orderNumber.length > 20) throw new RangeError('orderNumber oltre 20 caratteri');
  const config: CpuConfig = {
    orderNumber,
    firmware: 'V3.2',
    firmwareParts: [3, 2, 0],
    asName: 'BaaPortal CPU simulata',
    moduleName: 'CPU 315-2 PN/DP',
    serialNumber: 'S C-BAA000000002',
    copyright: 'Original Siemens Equipment',
    pduLength: 240,
    maxConnections: 16,
    rack: 0,
    slot: 2,
    protectionLevel: 1,
    sizes: {
      inputBytes: m.I.length,
      outputBytes: m.Q.length,
      mBytes: m.M.length,
      timers: cpu.timers.count,
      counters: cpu.counters.length,
    },
    faults: {},
    tsaps: [remoteTsap('pg', 0, 2), remoteTsap('op', 0, 2), remoteTsap('basic', 0, 2)],
  };
  const sessions = new Set<object>();
  let refCounter = 0;
  let modeSince = wallClock();
  cpu.onEvent((e) => {
    if (e.type === 'mode') modeSince = wallClock();
  });
  /** File dei blocchi scaricati dal server: servono a upload e block info. */
  const files = new Map<string, StoredBlock>();
  const keyOf = (type: string, number: number): string => `${type}:${number}`;

  const present = (type: BlockType, number: number): boolean =>
    type === 'DB' ? m.dbs.has(number) : cpu.program.get(type, number) !== undefined;

  const bufferOf = (it: ReadItem | WriteItem, write: boolean): Uint8Array | undefined => {
    switch (it.area) {
      case 'I':
        return m.I;
      case 'Q':
        return m.Q;
      case 'M':
        return m.M;
      case 'P':
        return write ? m.physOut : m.physIn;
      case 'DB':
      case 'DI':
        return m.dbs.get(it.db)?.data;
      default:
        return undefined;
    }
  };

  function readItem(it: ReadItem): ItemRead {
    const len = itemByteLength(it);
    switch (it.area) {
      case 'I':
      case 'Q':
      case 'M':
      case 'P':
        return sliceOf(bufferOf(it, false)!, it, len);
      case 'DB':
      case 'DI': {
        const buf = bufferOf(it, false);
        return buf ? sliceOf(buf, it, len) : { rc: 0x0a };
      }
      case 'T':
      case 'C': {
        const total = it.area === 'T' ? config.sizes.timers : config.sizes.counters;
        const n = it.size === 'TIMER' || it.size === 'COUNTER' ? it.count : Math.ceil(len / 2);
        if (it.start + n > total) return { rc: 0x05 };
        const data = new Uint8Array(len);
        // ⚠️ Formato sul filo non verificato: per T, la parola BCD con la base (come `LC`), big-endian.
        if (it.area === 'T')
          for (let i = 0; i < n && 2 * i + 1 < len; i++) {
            const w = cpu.timers.bcd(it.start + i);
            data[2 * i] = w >> 8;
            data[2 * i + 1] = w & 255;
          }
        return { data };
      }
      default:
        // L e V non sono raggiungibili dall'esterno
        return { rc: 0x03 };
    }
  }

  function applyWrite(items: WriteItem[]): number[] {
    return items.map((it) => {
      const len = itemByteLength(it);
      if (it.area === 'T' || it.area === 'C') return 0x05; // fino al piano 2B
      const buf = bufferOf(it, true);
      if (!buf) return it.area === 'DB' || it.area === 'DI' ? 0x0a : 0x03;
      // stessa verifica di confini della lettura: se non si legge, non si scrive
      const probe = sliceOf(buf, it, len);
      if ('rc' in probe) return probe.rc;
      if (it.size === 'BIT') {
        const first = it.start * 8 + (it.bit ?? 0);
        for (let i = 0; i < it.count; i++) {
          const at = first + i;
          const on = ((it.data[i >> 3]! >> (i & 7)) & 1) !== 0;
          buf[at >> 3] = on ? buf[at >> 3]! | (1 << (at & 7)) : buf[at >> 3]! & ~(1 << (at & 7));
        }
      } else {
        buf.set(it.data.subarray(0, len), it.start);
      }
      return 0xff;
    });
  }

  return {
    config,
    get mode() {
      return cpu.mode;
    },
    get modeSince() {
      return modeSince;
    },
    get diagnosticRecords() {
      const fallback = wallClock();
      return [...cpu.diagnostics].reverse().map((e: DiagEntry) => {
        const rec = new Uint8Array(20);
        const index = CODE_ORDER.indexOf(e.code);
        if (index < 0) throw new RangeError(`codice di diagnostica sconosciuto: ${e.code}`);
        const id = EVENT_BASE + index;
        rec[0] = id >>> 8;
        rec[1] = id & 0xff;
        rec.set(encodeBcdDateTimeShort(dateTimeOf(e.time, fallback)), 12);
        return rec;
      });
    },
    nextRef() {
      refCounter = (refCounter % 0xffff) + 1;
      return refCounter;
    },
    attach(session) {
      if (sessions.size >= config.maxConnections) return false;
      sessions.add(session);
      return true;
    },
    detach(session) {
      sessions.delete(session);
    },
    now: wallClock,
    readItem,
    applyWrite,
    applyStop() {
      if (cpu.mode === 'STOP') return 0x07;
      cpu.stop('richiesto dal PG');
      return 0x00;
    },
    applyWarmRestart() {
      if (cpu.mode === 'RUN') return 0x03;
      cpu.run();
      return 0x00;
    },
    applyDownloadedBlock(type, number, file) {
      const copy = file.slice();
      const parsed = parseBlockFile(copy);
      if (parsed.header.type !== type || parsed.header.number !== number) {
        throw new RangeError(`il file non è ${type}${number}`);
      }
      cpu.loadBlock(copy); // un blocco non caricabile lancia: la sessione risponde con un errore
      files.set(keyOf(type, number), { type, number, file: copy, parsed });
    },
    block(type, number) {
      return present(type, number) ? files.get(keyOf(type, number)) : undefined;
    },
    blockCounts() {
      const out = Object.fromEntries(BLOCK_TYPES.map((t) => [t, 0])) as Record<BlockType, number>;
      for (const b of cpu.program.list()) out[b.kind]++;
      out.DB += m.dbs.size;
      return out;
    },
    blockList(type) {
      const numbers =
        type === 'DB'
          ? [...m.dbs.keys()]
          : cpu.program
              .list()
              .filter((b) => b.kind === type)
              .map((b) => b.number);
      return numbers
        .sort((a, b) => a - b)
        .map((number): BlockListEntry => {
          const h = files.get(keyOf(type, number))?.parsed.header;
          return { number, flags: h?.flags ?? 0, language: h?.language ?? 0 };
        });
    },
    blockInfo: encodeStoredBlockInfo,
  };
}

/** Collega un client S7 alla CPU simulata con un trasporto in memoria (stesso percorso di rete del PLC). */
export function connectToSim(cpu: SimCpu): Promise<S7WriteClient> {
  const backend = simBackend(cpu);
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(backend, b);
    return a;
  };
  return S7WriteClient.connect({ host: 'sim', transport, timeoutMs: 3000 });
}
