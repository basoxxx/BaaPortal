import {
  buildBlockFile,
  encodeBcdDateTimeShort,
  itemByteLength,
  parseBlockFile,
  remoteTsap,
  type BlockListEntry,
  type BlockType,
  type CpuMode,
  type DiagEntry,
  type ReadItem,
  type Regs,
  type S7DateTime,
  type WriteItem,
} from '@baaportal/s7comm';
import type {
  BackendChange,
  CpuBackend,
  CpuConfig,
  ItemRead,
  MemoryUsage,
  StackData,
  StoredBlock,
} from './backend';
import { bstackEntry, istackBytes, lstackBytes } from './tis';
import { encodeStoredBlockInfo } from './blockInfo';
import { modeByte } from './szlData';
import { checkFaults, type FaultPlan } from './faults';

export type { CpuConfig, ItemRead, StoredBlock };

export interface FakeCpuOptions {
  /** Numero d'ordine (MlFB), 20 caratteri al massimo. */
  orderNumber?: string; // '6ES7 315-2EH14-0AB0'
  /** "V3.2" o "V3.2.7": versione del firmware riportata dalla SZL 0x0011 indice 7. */
  firmware?: string; // 'V3.2'
  asName?: string;
  moduleName?: string;
  serialNumber?: string;
  pduLength?: number; // 240
  maxConnections?: number; // 16
  /** TSAP remoto atteso (proto §2.3): tipo 1, 2 o 3, rack e slot. */
  rack?: number; // 0
  slot?: number; // 2
  mode?: CpuMode; // 'RUN'
  protectionLevel?: 1 | 2 | 3; // 1
  sizes?: {
    inputBytes: number;
    outputBytes: number;
    mBytes: number;
    timers: number;
    counters: number;
  }; // 2048, 2048, 2048, 256, 256
  clock?: () => S7DateTime;
  faults?: FaultPlan;
  /** SDB da seminare, come file di blocco (p.es. `syntheticSdb`). Solo SDB: altrimenti RangeError. */
  systemBlocks?: Uint8Array[];
  /** Memoria di lavoro in byte, per la SZL 0x0013 (predefinito 256 KB). */
  memory?: { workBytes: number };
  /** LED FRCE acceso (forzamento attivo); il server non implementa il forzamento. Default no. */
  forceActive?: boolean;
  /** Funzioni di test v2 (block status): `false` come la CPU del 2010 (proto §7.5.9). Default si'. */
  tisV2?: boolean;
  /**
   * Blocchi FC/FB che il programma chiama (p.es. `['FC10']`): il block status di un FC o FB non
   * elencato non produce risultati (blocco mai chiamato). Gli OB sono sempre eseguiti.
   */
  calledBlocks?: string[];
}

const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function defaultClock(): S7DateTime {
  const d = new Date();
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

function int(name: string, v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} ${v} fuori ${min}-${max}`);
  }
  return v;
}

/**
 * Finto S7-300 (CPU 315-2 PN/DP). Lo stato cambia solo con i metodi di questa classe. Da rete
 * cambia soltanto per le funzioni di scrittura ammesse (write var, stop, warm restart, download di
 * un blocco con _INSE: i metodi `apply*`), mai per le altre: la sessione risponde con un errore a tutto il resto. Gli stessi dati vengono da `serve`/`listen`.
 */
export class FakeCpu implements CpuBackend {
  readonly config: CpuConfig;
  private readonly clockFn: () => S7DateTime;
  private readonly areas: Record<'I' | 'Q' | 'M', Uint8Array>;
  private readonly blockMap = new Map<string, StoredBlock>();
  private cpuMode: CpuMode;
  private modeTime: S7DateTime;
  /** Record da 20 byte del buffer diagnostico, il più recente per primo. */
  private readonly diag: Uint8Array[] = [];
  private readonly sessions = new Set<object>();
  private refCounter = 0;
  private readonly workBytes: number;
  /** LED SF (errore cumulativo): lo imposta il test. */
  faultLed = false;
  /** LED FRCE (forzamento attivo): lo imposta il test. */
  forceActive: boolean;
  readonly tisV2: boolean;
  private readonly called: ReadonlySet<string>;
  private readonly listeners = new Set<(e: BackendChange) => void>();

  constructor(o: FakeCpuOptions = {}) {
    const sizes = o.sizes ?? {
      inputBytes: 2048,
      outputBytes: 2048,
      mBytes: 2048,
      timers: 256,
      counters: 256,
    };
    int('sizes.inputBytes', sizes.inputBytes, 0, 0x1fffff);
    int('sizes.outputBytes', sizes.outputBytes, 0, 0x1fffff);
    int('sizes.mBytes', sizes.mBytes, 0, 0x1fffff);
    int('sizes.timers', sizes.timers, 0, 2048);
    int('sizes.counters', sizes.counters, 0, 2048);
    const rack = int('rack', o.rack ?? 0, 0, 7);
    const slot = int('slot', o.slot ?? 2, 0, 31);
    const firmware = o.firmware ?? 'V3.2';
    const fw = /^V(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?$/.exec(firmware);
    if (!fw || [fw[1], fw[2], fw[3] ?? '0'].some((n) => Number(n) > 255)) {
      throw new RangeError(`firmware "${firmware}" non è nella forma V3.2 o V3.2.7`);
    }
    const level = o.protectionLevel ?? 1;
    if (level !== 1 && level !== 2 && level !== 3) {
      throw new RangeError(`protectionLevel ${String(level)} diverso da 1, 2, 3`);
    }
    const orderNumber = o.orderNumber ?? '6ES7 315-2EH14-0AB0';
    if (orderNumber.length > 20) throw new RangeError('orderNumber oltre 20 caratteri');
    const faults = o.faults ?? {};
    checkFaults(faults);
    this.config = {
      orderNumber,
      firmware,
      firmwareParts: [Number(fw[1]), Number(fw[2]), Number(fw[3] ?? 0)],
      asName: o.asName ?? 'BaaPortal finto PLC',
      moduleName: o.moduleName ?? 'CPU 315-2 PN/DP',
      serialNumber: o.serialNumber ?? 'S C-BAA000000001',
      // Stringa d'identità che una CPU Siemens riporta nella 0x001C indice 4 (fatto di protocollo).
      copyright: 'Original Siemens Equipment',
      pduLength: int('pduLength', o.pduLength ?? 240, 40, 0xffff),
      maxConnections: int('maxConnections', o.maxConnections ?? 16, 1, 0xffff),
      rack,
      slot,
      protectionLevel: level,
      sizes: { ...sizes },
      faults: { ...faults },
      tsaps: [
        remoteTsap('pg', rack, slot),
        remoteTsap('op', rack, slot),
        remoteTsap('basic', rack, slot),
      ],
    };
    this.clockFn = o.clock ?? defaultClock;
    this.areas = {
      I: new Uint8Array(sizes.inputBytes),
      Q: new Uint8Array(sizes.outputBytes),
      M: new Uint8Array(sizes.mBytes),
    };
    this.forceActive = o.forceActive ?? false;
    this.tisV2 = o.tisV2 ?? true;
    this.called = new Set(o.calledBlocks ?? []);
    this.cpuMode = o.mode ?? 'RUN';
    this.modeTime = this.clockFn();
    this.workBytes = int('memory.workBytes', o.memory?.workBytes ?? 256 * 1024, 0, 0x7fffffff);
    for (const file of o.systemBlocks ?? []) {
      if (parseBlockFile(file).header.type !== 'SDB') {
        throw new RangeError('systemBlocks accetta solo file di tipo SDB');
      }
      this.addBlock(file);
    }
  }

  // ---- API di prova: solo in memoria, nessun comando di rete la raggiunge --------------------

  setMemory(area: 'I' | 'Q' | 'M', start: number, bytes: Uint8Array): void {
    const buf = this.areas[area];
    if (!buf) throw new RangeError(`area ${String(area)} diversa da I, Q, M`);
    if (!Number.isInteger(start) || start < 0 || start + bytes.length > buf.length) {
      throw new RangeError(`${area} ${start}+${bytes.length} oltre i ${buf.length} byte dell'area`);
    }
    buf.set(bytes, start);
  }

  /** Un DB è sia memoria leggibile sia un blocco elencato e caricabile (file di proto §13). */
  addDb(number: number, bytes: Uint8Array): void {
    int('numero DB', number, 1, 0xffff);
    if (bytes.length > 0xffff) throw new RangeError(`DB di ${bytes.length} byte oltre 65535`);
    const now = this.clockFn();
    this.addBlock(
      buildBlockFile(
        {
          type: 'DB',
          number,
          language: 5,
          flags: 0x01,
          security: 0,
          codeTime: now,
          interfaceTime: now,
          ssbLength: 0,
          addLength: 0,
          localDataLength: 0,
          mc7Length: bytes.length,
        },
        bytes.slice(),
        { author: 'BaaPort', family: 'DATADB', name: `DB${number}`, version: '1.0', checksum: 0 },
      ),
    );
  }

  /** Aggiunge (o sostituisce) un blocco dato come file nel formato di Task 4. */
  addBlock(file: Uint8Array): void {
    const copy = file.slice();
    const parsed = parseBlockFile(copy);
    if (parsed.header.type === undefined) {
      throw new RangeError(`codice tipo 0x${parsed.header.typeCode.toString(16)} sconosciuto`);
    }
    const type = parsed.header.type;
    this.blockMap.set(`${type}:${parsed.header.number}`, {
      type,
      number: parsed.header.number,
      file: copy,
      parsed,
    });
    this.emit({ kind: 'block', type, number: parsed.header.number });
  }

  setMode(m: CpuMode): void {
    this.cpuMode = m;
    this.modeTime = this.clockFn();
    this.emit({ kind: 'mode' });
  }

  private emit(e: BackendChange): void {
    for (const cb of this.listeners) cb(e);
  }

  /** @internal Per i job di test (proto §18.4.1): modo e blocchi cambiati. */
  onChange(cb: (e: BackendChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** @internal Valori sintetici (scelta del server di prova): STW 0x0106, ACCU1 = offset della riga. */
  blockStatus(
    type: 'OB' | 'FB' | 'FC',
    number: number,
    lines: { offset: number; mask: number }[],
  ): Promise<(Regs | null)[] | undefined> {
    if (type !== 'OB' && !this.called.has(`${type}${number}`)) return Promise.resolve(undefined);
    return Promise.resolve(
      lines.map((l) => ({ stw: 0x0106, accu1: l.offset, accu2: 0, ar1: 0x84000000 })),
    );
  }

  /** @internal Stack sintetici (proto §18.6): BSTACK = OB1 + FC10, ISTACK di 76 byte, LSTACK di 20. */
  stacks(): StackData {
    const t = this.clockFn();
    return {
      bstack: Uint8Array.from([
        ...bstackEntry(0x08, 1, 0x20, { priority: 1, time: t }),
        ...bstackEntry(0x0c, 10, 0x08),
      ]),
      istack: istackBytes({
        resume: [0x08, 1, 0x22],
        interrupted: [0x0c, 10, 0x10],
        stw: 0x0106,
        accu1: 0x11111111,
        accu2: 0x22222222,
        ar1: 0x84000000,
        ar2: 0,
        obStart: [0x11, 0x01, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0],
        time: t,
      }),
      lstack: (priority) => lstackBytes(priority, t),
    };
  }

  addDiagnostic(e: DiagEntry): void {
    const rec = new Uint8Array(20);
    rec[0] = (e.eventId >>> 8) & 0xff;
    rec[1] = e.eventId & 0xff;
    rec.set(e.info.subarray(0, 10), 2);
    if (e.time) rec.set(encodeBcdDateTimeShort(e.time), 12);
    else if (e.rawTime) rec.set(e.rawTime.subarray(0, 8), 12);
    this.diag.unshift(rec);
  }

  /** Sessioni aperte (CC mandato e non ancora chiuse). */
  get connections(): number {
    return this.sessions.size;
  }

  get mode(): CpuMode {
    return this.cpuMode;
  }

  /** Stato osservabile come testo: due snapshot uguali = stato invariato. */
  snapshot(): string {
    return JSON.stringify({
      I: hexOf(this.areas.I),
      Q: hexOf(this.areas.Q),
      M: hexOf(this.areas.M),
      blocks: [...this.blockMap].map(([k, b]) => [k, hexOf(b.file)]),
      mode: this.cpuMode,
      modeTime: this.modeTime,
      diag: this.diag.map(hexOf),
    });
  }

  // ---- uso interno delle sessioni -------------------------------------------------------------

  /** @internal Registra una sessione; `false` se la CPU ha già `maxConnections` sessioni. */
  attach(session: object): boolean {
    if (this.sessions.size >= this.config.maxConnections) return false;
    this.sessions.add(session);
    return true;
  }

  /** @internal */
  detach(session: object): void {
    this.sessions.delete(session);
  }

  /** @internal Riferimento COTP della prossima sessione: 1, 2, ... per questa CPU, quindi ripetibile. */
  nextRef(): number {
    this.refCounter = (this.refCounter % 0xffff) + 1;
    return this.refCounter;
  }

  /** @internal */
  now(): S7DateTime {
    return this.clockFn();
  }

  /** @internal */
  get modeSince(): S7DateTime {
    return this.modeTime;
  }

  /** @internal Record del buffer diagnostico, il più recente per primo. */
  get diagnosticRecords(): readonly Uint8Array[] {
    return this.diag;
  }

  /** @internal Memoria per la SZL 0x0013: lavoro = MC7 dei blocchi (SDB esclusi), caricamento = file. */
  memory(): MemoryUsage {
    let work = 0;
    let load = 0;
    for (const b of this.blockMap.values()) {
      load += b.file.length;
      if (b.type !== 'SDB') work += b.parsed.header.mc7Length;
    }
    return { workBytes: this.workBytes, workUsedBytes: work, loadUsedBytes: load };
  }

  /** Voce di cambio di modo nel buffer (proto §7.6.1): event ID, priorità 0xFF e byte di modo. */
  private modeEntry(eventId: number, from: CpuMode, to: CpuMode): void {
    this.addDiagnostic({
      eventId,
      info: Uint8Array.from([0xff, modeByte(from, to), 0, 0, 0, 0, 0, 0, 0, 0]),
      time: this.clockFn(),
    });
  }

  /** @internal Cancella il blocco; `false` se non c'era. Solo dalla sessione (`_DELE`). */
  deleteBlock(type: BlockType, number: number): boolean {
    const had = this.blockMap.delete(`${type}:${number}`);
    if (had) this.emit({ kind: 'block', type, number });
    return had;
  }

  /** @internal `_MODU`: nel finto PLC non c'è una ROM separata, quindi non cambia nulla. */
  copyRamToRom(): void {}

  /** @internal `_GARB`: nel finto PLC la memoria non si frammenta, quindi non cambia nulla. */
  compressMemory(): void {}

  /** @internal */
  block(type: BlockType, number: number): StoredBlock | undefined {
    return this.blockMap.get(`${type}:${number}`);
  }

  /** @internal */
  blockCounts(): Record<BlockType, number> {
    const out: Record<BlockType, number> = { OB: 0, DB: 0, SDB: 0, FC: 0, SFC: 0, FB: 0, SFB: 0 };
    for (const b of this.blockMap.values()) out[b.type]++;
    return out;
  }

  /** @internal Elenco dei blocchi di un tipo, per numero crescente. */
  blockList(type: BlockType): BlockListEntry[] {
    return [...this.blockMap.values()]
      .filter((b) => b.type === type)
      .sort((a, b) => a.number - b.number)
      .map((b) => ({
        number: b.number,
        flags: b.parsed.header.flags,
        language: b.parsed.header.language,
      }));
  }

  /** @internal Payload (78 byte) della risposta di block info. */
  blockInfo(b: StoredBlock): Uint8Array {
    return encodeStoredBlockInfo(b);
  }

  /** @internal Blocco ricomposto da un download di rete: dentro solo dopo l'_INSE. Solo dalla sessione. */
  applyDownloadedBlock(type: BlockType, number: number, file: Uint8Array): void {
    const copy = file.slice();
    const parsed = parseBlockFile(copy);
    if (parsed.header.type !== type || parsed.header.number !== number) {
      throw new RangeError(`il file non è ${type}${number}`);
    }
    this.blockMap.set(`${type}:${number}`, { type, number, file: copy, parsed });
    this.emit({ kind: 'block', type, number });
  }

  /** @internal Write var: un return code per item (0xFF ok, 0x0A DB mancante, 0x05 fuori campo). Solo dal gestore 0x05. */
  applyWrite(items: WriteItem[]): number[] {
    return items.map((it) => {
      const len = itemByteLength(it);
      // stessa verifica di confini e DB della lettura: se non si legge, non si scrive
      const probe = this.readItem(it);
      if ('rc' in probe) return probe.rc;
      let buf: Uint8Array;
      switch (it.area) {
        case 'I':
        case 'Q':
        case 'M':
          buf = this.areas[it.area];
          break;
        case 'DB':
        case 'DI':
          buf = this.blockMap.get(`DB:${it.db}`)!.parsed.mc7;
          break;
        default:
          // timer e counter non sono scrivibili nel finto PLC
          return 0x05;
      }
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

  /** @internal Stop: 0x00 ok, 0x07 se già in STOP. Solo dal gestore 0x29. */
  applyStop(): number {
    if (this.cpuMode === 'STOP') return 0x07;
    this.modeEntry(0x4304, this.cpuMode, 'STOP'); // STOP da PG
    this.setMode('STOP');
    return 0x00;
  }

  /** @internal Warm restart: 0x00 ok, 0x03 se già in RUN. Solo dal gestore 0x28 P_PROGRAM. */
  applyWarmRestart(): number {
    if (this.cpuMode === 'RUN') return 0x03;
    // STOP → avviamento (0x4301), avviamento → RUN (0x4302): il finto PLC non resta in avviamento
    this.modeEntry(0x4301, this.cpuMode, 'STARTUP');
    this.modeEntry(0x4302, 'STARTUP', 'RUN');
    this.setMode('RUN');
    return 0x00;
  }

  /** @internal Lettura di un item di read var; mai oltre i confini configurati. */
  readItem(it: ReadItem): ItemRead {
    const len = itemByteLength(it);
    switch (it.area) {
      case 'I':
      case 'Q':
      case 'M':
        return sliceOf(this.areas[it.area], it, len);
      case 'DB':
      case 'DI': {
        const b = this.blockMap.get(`DB:${it.db}`);
        return b ? sliceOf(b.parsed.mc7, it, len) : { rc: 0x0a };
      }
      case 'T':
      case 'C': {
        const total = it.area === 'T' ? this.config.sizes.timers : this.config.sizes.counters;
        const n = it.size === 'TIMER' || it.size === 'COUNTER' ? it.count : Math.ceil(len / 2);
        return it.start + n > total ? { rc: 0x05 } : { data: new Uint8Array(len) };
      }
      case 'P':
        return { rc: 0x05 };
      default:
        // L e V non sono raggiungibili dall'esterno
        return { rc: 0x03 };
    }
  }
}

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
