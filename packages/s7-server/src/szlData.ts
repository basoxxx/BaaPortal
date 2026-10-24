import { encodeBcdDateTimeShort, type CpuMode, type SzlList } from '@baaportal/s7comm';
import type { CpuBackend } from './backend';

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
    0x0132, 0x0232, 0x0f32, 0x00a0, 0x01a0, 0x0fa0,
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
  return Uint8Array.from(
    '0002befd4f0000000000080000003c01080000007d000005030f00000800000c000a000000010000'
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );
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

// ---- costruzione ---------------------------------------------------------------------------------

interface ListSpec {
  recordLength: number;
  /** Tutti i record della lista piena, con l'indice che li seleziona. */
  records(cpu: CpuBackend): { index: number; bytes: Uint8Array }[];
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
    records: (cpu) => [{ index: 0, bytes: modeRecord(cpu) }],
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
  const all = ex.records(cpu);
  const list = (records: Uint8Array[], idx = index): SzlList => ({
    id,
    index: idx,
    recordLength: ex.recordLength,
    records,
  });

  if (id >> 8 === 0xf) {
    // solo intestazione: lunghezza del record e numero di record della lista piena
    return { ...list([]), declaredCount: all.length };
  }
  switch (base) {
    case 0x00:
      return list(all.map((r) => r.bytes));
    case 0x24:
      return list(
        all.map((r) => r.bytes),
        0,
      );
    case 0xa0:
      // 0x01A0: le `index` voci più recenti; 0x00A0: tutte
      return list((id === 0x01a0 ? all.slice(0, index) : all).map((r) => r.bytes));
    default: {
      // 0x0011/0x001C: indice 0 = tutte (solo estratto 0); gli altri: il record con quell'indice
      if (index === 0 && (id === 0x0011 || id === 0x001c)) return list(all.map((r) => r.bytes));
      const hit = all.find((r) => r.index === index);
      return hit ? list([hit.bytes]) : undefined;
    }
  }
}
