import { encodeBcdDateTimeShort, type CpuMode, type SzlList } from '@baaportal/s7comm';
import type { CpuBackend, CycleStats, MemoryUsage } from './backend';

/**
 * Catalogo delle SZL del finto PLC (proto §7.3), con le forme viste sulle CPU vere:
 * - un indice richiesto seleziona il solo record con quell'indice (0x0111/1, 0x011C/2, 0x0131/1...);
 *   l'indice 0 delle liste "piene" (0x0011, 0x001C, 0x00A0, 0x0000) le dà tutte;
 * - 0x0F.. = solo intestazione (record e conteggio della lista piena, nessun record);
 * - id o indice non implementati: `undefined`, la sessione risponde 0xD402.
 */

/** Tutti gli id implementati, ordinati come le CPU vere: per numero di lista, poi per estratto. */
export function szlIdList(): number[] {
  const ids = [
    0x0000, 0x0f00, 0x0011, 0x0111, 0x0f11, 0x001c, 0x011c, 0x0f1c, 0x0424, 0x0f24, 0x0131, 0x0f31,
    0x0132, 0x0232, 0x0f32, 0x00a0, 0x01a0, 0x0fa0, 0x0013, 0x0f13, 0x0019, 0x0f19, 0x0074, 0x0174,
    0x0f74, 0x0124, 0x0222, 0x0f22,
  ];
  return ids.sort((a, b) => (a & 0xff) - (b & 0xff) || a - b);
}

function text(s: string, len: number, fill: number): Uint8Array {
  const out = new Uint8Array(len).fill(fill);
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function record(len: number, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const w = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const d = (v: number): number[] => [
  (v >>> 24) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 8) & 0xff,
  v & 0xff,
];

// ---- 0x0011: identificazione del modulo (record da 28 byte) -------------------------------------

const IDENT_INDEXES = [0x0001, 0x0006, 0x0007, 0x0081];

function ident(cpu: CpuBackend, index: number): Uint8Array {
  const c = cpu.config;
  const [major, minor, patch] = c.firmwareParts;
  switch (index) {
    case 0x0001:
    case 0x0006:
      // indice, MlFB (20, riempito con spazi), BGTyp, Ausbg1, Ausbg2
      return record(28, w(index), text(c.orderNumber, 20, 0x20), w(0x00c0), w(0x0003), w(0x0001));
    case 0x0007:
      // il firmware: 'V' + maggiore, minore + patch (V3.2.7 = 56 03 02 07)
      return record(
        28,
        w(index),
        text('', 20, 0x20),
        w(0x00c0),
        w(0x5600 | major),
        w((minor << 8) | patch),
      );
    default:
      return record(28, w(0x0081), text('Boot Loader', 20, 0x20), w(0x0000), w(0x4120), w(0x0909));
  }
}

// ---- 0x001C: identificazione dei componenti (record da 34 byte) -------------------------------

const COMPONENT_INDEXES = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11];

function component(cpu: CpuBackend, index: number): Uint8Array {
  const c = cpu.config;
  const str = (s: string, max: number): Uint8Array =>
    record(34, w(index), text(s.slice(0, max), 32, 0x00));
  switch (index) {
    case 1:
      return str(c.asName, 24);
    case 2:
      return str(c.moduleName, 24);
    case 3:
      return str('', 32);
    case 4:
      return str(c.copyright, 26);
    case 5:
      return str(c.serialNumber, 24);
    case 7:
      return str(c.moduleName, 32);
    case 9:
      // costruttore e profilo, come la 315 vera: 002a f600 0001
      return record(34, w(9), w(0x002a), w(0xf600), w(0x0001));
    default:
      return str('', 32); // 8 (MMC), 10 (OEM), 11 (luogo)
  }
}

// ---- 0x0131: comunicazione (record da 40 byte) --------------------------------------------------

function comm(cpu: CpuBackend, index: number): Uint8Array {
  if (index === 1) {
    return record(
      40,
      w(1),
      w(cpu.config.pduLength),
      w(cpu.config.maxConnections),
      d(0x00b71b00),
      d(0x0002dc6c),
      d(0x05f5e100),
    );
  }
  // indice 2: costanti delle funzioni di test e messa in servizio (TIS), come una 315 vera
  const bytes = Uint8Array.from(
    '0002befd4f0000000000080000003c01080000007d000005030f00000800000c000a000000010000'
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );
  // senza TIS v2 (CPU del 2010, proto §7.5.9) manca il block status `0x13`: funkt_2 = 0x03
  if (cpu.tisV2 === false) bytes[4] = 0x03;
  return bytes;
}

// ---- 0x0132 / 0x0232 indice 4: protezione (record da 40 byte) ----------------------------------

function protection(cpu: CpuBackend): Uint8Array {
  const level = cpu.config.protectionLevel;
  // posizione del selettore: RUN-P in esercizio, STOP se la CPU è ferma, altrimenti indefinita
  const sel = cpu.mode === 'RUN' ? 2 : cpu.mode === 'STOP' ? 3 : 0;
  return record(40, w(4), w(level), w(level > 1 ? level : 0), w(level), w(sel), w(0));
}

// ---- 0x0424: modo operativo (record da 20 byte) -------------------------------------------------

const MODE_NIBBLE: Record<CpuMode, number> = {
  RUN: 0x8,
  STOP: 0x4,
  STARTUP: 0x5,
  HOLD: 0xa,
  DEFECT: 0xd,
  UNKNOWN: 0x0,
};

/** Byte di modo di un cambio (proto §7.6.1): nibble alto = modo precedente, basso = nuovo. */
export function modeByte(from: CpuMode, to: CpuMode): number {
  // nei cambi di modo l'avviamento è 6 (STOP→avviamento 0x46, avviamento→RUN 0x68), non il 5 di 0x0424
  const nibble = (m: CpuMode): number => (m === 'STARTUP' ? 0x6 : MODE_NIBBLE[m]);
  return (nibble(from) << 4) | nibble(to);
}

function modeRecord(cpu: CpuBackend): Uint8Array {
  // ereig(2), ae(1), bzu-id(1: il nibble basso è il modo), 8 byte a zero, ora breve (8)
  return record(
    20,
    w(0x5144),
    [0xff, MODE_NIBBLE[cpu.mode]],
    new Uint8Array(8),
    encodeBcdDateTimeShort(cpu.modeSince),
  );
}

// ---- 0x0013: aree di memoria (record da 36 byte, proto §7.5.3) --------------------------------

/** MMC inserita e massima inseribile (byte): valori di un 315-2 PN/DP con una MMC da 512 KB. */
const MMC_BYTES = 512 * 1024;
const MMC_MAX_BYTES = 8 * 1024 * 1024;
const BACKUP_BYTES = 1280;
const DEFAULT_WORK_BYTES = 256 * 1024;

function memoryOf(cpu: CpuBackend): MemoryUsage {
  return cpu.memory?.() ?? { workBytes: DEFAULT_WORK_BYTES, workUsedBytes: 0, loadUsedBytes: 0 };
}

/** Un'area: parte volatile (ber1/belegt1) e parte non volatile (ber2/belegt2). */
function area(
  index: number,
  code: number,
  mode: number,
  volatile: { size: number; used: number },
  nonVolatile: { size: number; used: number },
): Uint8Array {
  const free = (a: { size: number; used: number }): number => Math.max(0, a.size - a.used);
  return record(
    36,
    w(index),
    w(code),
    d(volatile.size + nonVolatile.size),
    w(mode),
    w(0),
    d(volatile.size),
    d(Math.min(volatile.used, volatile.size)),
    d(free(volatile)),
    d(nonVolatile.size),
    d(Math.min(nonVolatile.used, nonVolatile.size)),
    d(free(nonVolatile)),
  );
}

function memoryRecords(cpu: CpuBackend): { index: number; bytes: Uint8Array }[] {
  const m = memoryOf(cpu);
  const none = { size: 0, used: 0 };
  return [
    // lavoro: RAM, codice e dati insieme (bit 4) e volatile (bit 0)
    { index: 1, bytes: area(1, 1, 0x0011, { size: m.workBytes, used: m.workUsedBytes }, none) },
    // nessuna memoria di caricamento integrata
    { index: 2, bytes: area(2, 1, 0x0001, none, none) },
    // MMC: non volatile (bit 1)
    { index: 3, bytes: area(3, 2, 0x0002, none, { size: MMC_BYTES, used: m.loadUsedBytes }) },
    { index: 4, bytes: area(4, 2, 0x0002, none, { size: MMC_MAX_BYTES, used: 0 }) },
    // ritentiva: l'indice 5 è un'ipotesi di proto §7.5.3
    { index: 5, bytes: area(5, 2, 0x0002, none, { size: BACKUP_BYTES, used: 0 }) },
  ];
}

// ---- 0x0019 / 0x0074 / 0x0174: LED (record da 4 byte, proto §7.5.4) ----------------------------

const LED_SF = 0x01;
const LED_RUN = 0x04;
const LED_STOP = 0x05;
const LED_FRCE = 0x06;
const LED_IDS = [LED_SF, LED_RUN, LED_STOP, LED_FRCE, 0x0b, 0x0c, 0x15]; // SF RUN STOP FRCE BUS1F BUS2F MAINT

function ledRecords(cpu: CpuBackend): { index: number; bytes: Uint8Array }[] {
  const startup = cpu.mode === 'STARTUP';
  const state = (id: number): [on: number, blink: number] => {
    switch (id) {
      case LED_SF:
        return [cpu.faultLed ? 1 : 0, 0];
      case LED_RUN:
        // in avviamento RUN lampeggia a 2 Hz (lampeggio normale)
        return cpu.mode === 'RUN' ? [1, 0] : startup ? [1, 1] : [0, 0];
      case LED_STOP:
        return cpu.mode === 'STOP' || startup ? [1, 0] : [0, 0];
      case LED_FRCE:
        return [cpu.forceActive ? 1 : 0, 0];
      default:
        return [0, 0];
    }
  };
  return LED_IDS.map((id) => ({ index: id, bytes: Uint8Array.from([...w(id), ...state(id)]) }));
}

// ---- 0x0124: ultimo cambio di modo (record da 20 byte, proto §7.5.5) ---------------------------

/** La voce più recente del buffer con classe 4; senza nessuna, un 0x4302 costruito da `modeSince`. */
function lastModeChange(cpu: CpuBackend): Uint8Array {
  const found = cpu.diagnosticRecords.find((r) => r.length >= 20 && r[0]! >> 4 === 4);
  if (found) return found;
  return record(
    20,
    w(0x4302),
    [0xff, modeByte('STARTUP', cpu.mode)],
    new Uint8Array(8),
    encodeBcdDateTimeShort(cpu.modeSince),
  );
}

// ---- 0x0222: dati dell'interrupt per OB (record da 28 byte, proto §7.5.2) ----------------------

const clampMs = (v: number): number => Math.min(0xffff, Math.max(0, Math.round(v)));
const NO_CYCLES: CycleStats = { lastMs: 0, minMs: 0, maxMs: 0, configMinMs: 0, configMaxMs: 150 };

function obRecord(cpu: CpuBackend, ob: 1 | 0x50): Uint8Array {
  const c = cpu.cycleStats?.() ?? NO_CYCLES;
  if (ob === 1) {
    // OB1: classe 0x11, ciclo normale, priorità 1; ciclo precedente, minimo, massimo, ultimo avvio
    return record(
      28,
      [0x11, 0x03, 0x01, 0x01, 0xc8, 0x58],
      w(clampMs(c.lastMs)),
      w(clampMs(c.minMs)),
      w(clampMs(c.maxMs)),
      encodeBcdDateTimeShort(cpu.now()),
      w(0x0010), // al1: OB caricato
      w(0x0008), // al2: l'interrupt viene solo scartato
    );
  }
  // OB80: byte 8-9 e 10-11 = tempo di ciclo minimo e massimo configurati (sorveglianza)
  return record(
    28,
    [0x35, 0x01, 0x1a, 0x50, 0xc8, 0x58, 0, 0],
    w(clampMs(c.configMinMs)),
    w(clampMs(c.configMaxMs)),
    new Uint8Array(8),
    w(0x0000), // al1: OB80 non caricato
    w(0x0008),
  );
}

// ---- costruzione ---------------------------------------------------------------------------------

interface ListSpec {
  recordLength: number;
  /** Tutti i record della lista piena, con l'indice che li seleziona. */
  records(cpu: CpuBackend, id: number): { index: number; bytes: Uint8Array }[];
}

const EXTRACTS: Record<number, ListSpec> = {
  0x00: {
    recordLength: 2,
    records: () => szlIdList().map((id) => ({ index: id, bytes: Uint8Array.from(w(id)) })),
  },
  0x11: {
    recordLength: 28,
    records: (cpu) => IDENT_INDEXES.map((i) => ({ index: i, bytes: ident(cpu, i) })),
  },
  0x1c: {
    recordLength: 34,
    records: (cpu) => COMPONENT_INDEXES.map((i) => ({ index: i, bytes: component(cpu, i) })),
  },
  0x24: {
    recordLength: 20,
    // 0x0424 = modo attuale, 0x0124 = ultimo cambio di modo
    records: (cpu, id) => [
      { index: 0, bytes: id === 0x0124 ? lastModeChange(cpu) : modeRecord(cpu) },
    ],
  },
  0x13: { recordLength: 36, records: memoryRecords },
  0x19: { recordLength: 4, records: ledRecords },
  0x74: { recordLength: 4, records: ledRecords },
  0x22: {
    recordLength: 28,
    records: (cpu) => [
      { index: 1, bytes: obRecord(cpu, 1) },
      { index: 0x50, bytes: obRecord(cpu, 0x50) },
    ],
  },
  0x31: {
    recordLength: 40,
    records: (cpu) => [1, 2].map((i) => ({ index: i, bytes: comm(cpu, i) })),
  },
  0x32: {
    recordLength: 40,
    records: (cpu) => [{ index: 4, bytes: protection(cpu) }],
  },
  0xa0: {
    recordLength: 20,
    records: (cpu) => cpu.diagnosticRecords.map((bytes) => ({ index: 0, bytes })),
  },
};

const IDS = new Set(szlIdList());

/**
 * La lista SZL `id`/`index` del finto PLC, o `undefined` se la CPU la rifiuterebbe (0xD402).
 * `index` è quello richiesto: torna nell'intestazione, salvo la 0x0424 che risponde sempre 0.
 */
export function buildSzl(cpu: CpuBackend, id: number, index: number): SzlList | undefined {
  if (!IDS.has(id)) return undefined;
  const base = id & 0xff;
  const ex = EXTRACTS[base]!;
  const all = ex.records(cpu, id);
  const list = (records: Uint8Array[], idx = index): SzlList => ({
    id,
    index: idx,
    recordLength: ex.recordLength,
    records,
  });

  const pick = (idx: number): SzlList | undefined => {
    const hit = all.find((r) => r.index === idx);
    return hit ? list([hit.bytes]) : undefined;
  };

  if (id >> 8 === 0xf) {
    // solo intestazione: lunghezza del record e numero di record della lista piena
    return { ...list([]), declaredCount: all.length };
  }
  switch (base) {
    case 0x00:
      return list(all.map((r) => r.bytes));
    case 0x24:
      // 0x0424 e 0x0124 rispondono sempre con l'indice 0
      return list(
        all.map((r) => r.bytes),
        0,
      );
    case 0xa0:
      // 0x01A0: le `index` voci più recenti; 0x00A0: tutte
      return list((id === 0x01a0 ? all.slice(0, index) : all).map((r) => r.bytes));
    case 0x19:
      return list(all.map((r) => r.bytes));
    case 0x74:
      // 0x0074: tutti i LED; 0x0174: quello con l'id nell'indice
      if (id === 0x0074) return list(all.map((r) => r.bytes));
      return pick(index);
    default: {
      // 0x0011/0x001C/0x0013: indice 0 = tutte (solo estratto 0); gli altri: il record con quell'indice
      if (index === 0 && (id === 0x0011 || id === 0x001c || id === 0x0013)) {
        return list(all.map((r) => r.bytes));
      }
      return pick(index);
    }
  }
}
