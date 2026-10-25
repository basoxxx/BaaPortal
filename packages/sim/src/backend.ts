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
  type Regs,
  type S7DateTime,
  type TransportFactory,
  type WriteItem,
} from '@baaportal/s7comm';
import {
  bstackEntry,
  encodeStoredBlockInfo,
  istackBytes,
  modeByte,
  serve,
  type BackendChange,
  type CpuBackend,
  type CpuConfig,
  type ItemRead,
  type StoredBlock,
} from '@baaportal/s7-server';
import type { SimCpu } from './cpu';
import type { MonitorStep } from './executor';
import { isDiagError, type DiagEntry } from './diagnostics';

const BLOCK_TYPES: readonly BlockType[] = ['OB', 'DB', 'SDB', 'FC', 'SFC', 'FB', 'SFB'];

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

const EPOCH_2000: S7DateTime = {
  year: 2000,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0,
  ms: 0,
  weekday: 7,
};

/** Quanti record di diagnostica e di cambi di modo il buffer tiene (come i 100 della CPU). */
const MAX_LOG = 200;

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
export function simBackend(
  cpu: SimCpu,
  o: {
    orderNumber?: string;
    /** SDB da esporre in sola lettura, come file di blocco (p.es. `syntheticSdb`). */
    systemBlocks?: Uint8Array[];
  } = {},
): CpuBackend {
  /** L'ora della CPU: l'orologio di sistema più lo scarto di SET_CLK. */
  const clock = (): S7DateTime => dateTimeOf(cpu.clockMs(), EPOCH_2000);
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
      counters: cpu.counters.count,
    },
    faults: {},
    tsaps: [remoteTsap('pg', 0, 2), remoteTsap('op', 0, 2), remoteTsap('basic', 0, 2)],
  };
  const sessions = new Set<object>();
  let refCounter = 0;
  let modeSince = clock();
  /** SDB sintetici: blob opachi in sola lettura (nessun download né cancellazione). */
  const sdbs = new Map<number, StoredBlock>();
  for (const file of o.systemBlocks ?? []) {
    const parsed = parseBlockFile(file.slice());
    if (parsed.header.type !== 'SDB') throw new RangeError('systemBlocks accetta solo file SDB');
    sdbs.set(parsed.header.number, { type: 'SDB', number: parsed.header.number, file, parsed });
  }

  // Buffer diagnostico: le voci della CPU e i cambi di modo (proto §7.6.1), dal più vecchio. I cambi
  // di modo hanno gli event ID 0x4301/0x4302/0x4304 e il byte di modo (nibble alto = prima).
  const log: Uint8Array[] = [];
  const push = (rec: Uint8Array): void => {
    log.push(rec);
    if (log.length > MAX_LOG) log.shift();
  };
  const diagRecord = (e: DiagEntry): Uint8Array => {
    const rec = new Uint8Array(20);
    // Id del manuale quando c'è (16#25xx, 16#29xx, 16#35xx…), altrimenti sintetico (⚠️).
    rec[0] = e.eventId >>> 8;
    rec[1] = e.eventId & 0xff;
    rec.set(encodeBcdDateTimeShort(dateTimeOf(e.time, EPOCH_2000)), 12);
    return rec;
  };
  const modeRecord = (id: number, from: SimCpu['mode'], to: SimCpu['mode']): Uint8Array => {
    const rec = new Uint8Array(20);
    rec[0] = id >>> 8;
    rec[1] = id & 0xff;
    rec[2] = 0xff; // nessun OB coinvolto
    rec[3] = modeByte(from, to);
    rec.set(encodeBcdDateTimeShort(clock()), 12);
    return rec;
  };
  for (const e of cpu.diagnostics) push(diagRecord(e));
  let lastMode = cpu.mode;
  cpu.onEvent((e) => {
    if (e.type === 'diagnostic') push(diagRecord(e.entry));
    if (e.type !== 'mode') return;
    modeSince = clock();
    const from = lastMode;
    lastMode = e.mode;
    if (e.mode === 'STARTUP') push(modeRecord(0x4301, from, e.mode));
    else if (e.mode === 'RUN') push(modeRecord(0x4302, from, e.mode));
    else push(modeRecord(0x4304, from, e.mode));
  });
  /** File dei blocchi scaricati dal server: servono a upload e block info. */
  const files = new Map<string, StoredBlock>();
  const keyOf = (type: string, number: number): string => `${type}:${number}`;

  // Job di test (proto §18): cambi di modo e di blocco per la tabella dei job del server.
  const listeners = new Set<(e: BackendChange) => void>();
  const emit = (e: BackendChange): void => {
    for (const cb of listeners) cb(e);
  };
  cpu.onEvent((e) => {
    if (e.type === 'mode') emit({ kind: 'mode' });
  });
  /** Un'osservazione alla volta: il monitor della CPU e' uno solo. */
  let observing: Promise<unknown> = Promise.resolve();

  /** Registri della riga dal passo del monitor, secondo la maschera chiesta. */
  const regsOf = (s: MonitorStep, mask: number): Regs => {
    const r: Regs = {};
    if (mask & 0x01) r.stw = s.stw;
    if (mask & 0x02) r.accu1 = s.accu1;
    if (mask & 0x04) r.accu2 = s.accu2;
    if (mask & 0x08) r.ar1 = s.ar1;
    return r;
  };

  /** Osserva `type`/`number` per il **prossimo** ciclo: alla fine del ciclo legge le righe richieste. */
  const observe = (
    type: 'OB' | 'FB' | 'FC',
    number: number,
    lines: { offset: number; mask: number }[],
  ): Promise<(Regs | null)[] | undefined> =>
    new Promise((resolve) => {
      if (cpu.mode !== 'RUN') return resolve(undefined);
      cpu.setMonitor({ kind: type, number });
      const off = cpu.onEvent((e) => {
        if (e.type !== 'cycle' && e.type !== 'mode') return;
        off();
        const steps = e.type === 'cycle' ? cpu.monitorSnapshot() : undefined;
        cpu.setMonitor(undefined);
        // nessun passo = blocco non eseguito nel ciclo; riga senza passo = riga non eseguita (null)
        if (!steps || steps.length === 0) return resolve(undefined);
        resolve(
          lines.map((l) => {
            const st = steps.find((x) => x.offset === l.offset);
            return st ? regsOf(st, l.mask) : null;
          }),
        );
      });
    });

  const present = (type: BlockType, number: number): boolean =>
    type === 'SDB'
      ? sdbs.has(number)
      : type === 'DB'
        ? m.dbs.has(number)
        : cpu.program.get(type, number) !== undefined;

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
        // ⚠️ Per C, la parola BCD (come `LC C`), big-endian.
        else
          for (let i = 0; i < n && 2 * i + 1 < len; i++) {
            const w = cpu.counters.bcd(it.start + i);
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
      if (it.area === 'T' || it.area === 'C') return 0x05; // scrittura di T e C non supportata
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
      return [...log].reverse();
    },
    get faultLed() {
      // come nel pannello della CPU (2C): l'ultima voce del buffer è un errore
      const last = cpu.diagnostics.at(-1);
      return !!last && isDiagError(last);
    },
    cycleStats() {
      const st = cpu.stats();
      const cfg = cpu.cycleConfig;
      return {
        lastMs: st.last,
        minMs: st.min,
        maxMs: st.max,
        configMinMs: cfg.minMs,
        configMaxMs: cfg.maxMs,
      };
    },
    memory() {
      // solo i blocchi che il server ha ricevuto (download): gli altri non hanno un file
      let work = 0;
      let load = 0;
      for (const b of [...files.values(), ...sdbs.values()]) {
        if (!present(b.type, b.number)) continue;
        load += b.file.length;
        if (b.type !== 'SDB') work += b.parsed.header.mc7Length;
      }
      return { workBytes: cpu.workMemoryBytes, workUsedBytes: work, loadUsedBytes: load };
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
    now: clock,
    setClock(t) {
      cpu.setClock(
        new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second, t.ms).getTime(),
      );
    },
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
      if (type === 'SDB') throw new RangeError('gli SDB non si scrivono');
      const copy = file.slice();
      const parsed = parseBlockFile(copy);
      if (parsed.header.type !== type || parsed.header.number !== number) {
        throw new RangeError(`il file non è ${type}${number}`);
      }
      cpu.loadBlock(copy); // un blocco non caricabile lancia: la sessione risponde con un errore
      files.set(keyOf(type, number), { type, number, file: copy, parsed });
      emit({ kind: 'block', type, number });
    },
    deleteBlock(type, number) {
      if (type === 'SDB' || !present(type, number)) return false;
      cpu.deleteBlock(type, number);
      files.delete(keyOf(type, number));
      emit({ kind: 'block', type, number });
      return true;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    blockExists: present,
    blockStatus(type, number, lines) {
      const run = observing.then(() => observe(type, number, lines));
      observing = run.catch(() => undefined);
      return run;
    },
    stacks() {
      // solo in STOP (la sessione lo controlla): BSTACK = OB1 se esiste, ISTACK e LSTACK a zero
      const t = clock();
      return {
        bstack: present('OB', 1)
          ? Uint8Array.from(bstackEntry(0x08, 1, 0, { priority: 1, time: t }))
          : new Uint8Array(0),
        istack: istackBytes({
          resume: [0, 0, 0],
          interrupted: [0, 0, 0],
          stw: 0,
          accu1: 0,
          accu2: 0,
          ar1: 0,
          ar2: 0,
          obStart: new Array<number>(12).fill(0),
          time: t,
        }),
        lstack: () => new Uint8Array(20),
      };
    },
    // la CPU simulata non ha ROM né memoria da compattare: restano senza effetto
    copyRamToRom() {},
    compressMemory() {},
    block(type, number) {
      if (type === 'SDB') return sdbs.get(number);
      return present(type, number) ? files.get(keyOf(type, number)) : undefined;
    },
    blockCounts() {
      const out = Object.fromEntries(BLOCK_TYPES.map((t) => [t, 0])) as Record<BlockType, number>;
      for (const b of cpu.program.list()) out[b.kind]++;
      out.DB += m.dbs.size;
      out.SDB = sdbs.size;
      return out;
    },
    blockList(type) {
      const numbers =
        type === 'SDB'
          ? [...sdbs.keys()]
          : type === 'DB'
            ? [...m.dbs.keys()]
            : cpu.program
                .list()
                .filter((b) => b.kind === type)
                .map((b) => b.number);
      return numbers
        .sort((a, b) => a - b)
        .map((number): BlockListEntry => {
          const h = (type === 'SDB' ? sdbs.get(number) : files.get(keyOf(type, number)))?.parsed
            .header;
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
