// Configurazione hardware del rack S7-300 (tappa 6A): inserimento, spostamento e controllo dei moduli.
// Si salva nel progetto ma non si carica nella CPU (formato SDB non documentato, vedi docs/limiti-noti.md).
import {
  FIRST_IO_SLOT,
  MAX_RACKS,
  RACK_SLOTS,
  defaultStartAddress,
  findModule,
  slotAccepts,
  type CpuType,
  type ModuleType,
} from '@baaportal/catalog';
import type { HwModule, PlcDevice } from './model';

export type HwIssueCode =
  | 'HW_MODULE_UNKNOWN'
  | 'HW_SLOT_INVALID'
  | 'HW_SLOT_TAKEN'
  | 'HW_RACK_NOT_CONNECTED'
  | 'HW_ADDRESS_OVERLAP'
  | 'HW_ADDRESS_OUT_OF_RANGE';

export interface HwIssue {
  moduleId: string;
  code: HwIssueCode;
  /** Per gli indirizzi: area e, nella sovrapposizione, il nome dell'altro modulo. */
  area?: 'I' | 'Q';
  other?: string;
}

export interface IoRange {
  moduleId: string;
  name: string;
  from: number;
  /** Ultimo byte compreso. */
  to: number;
}

export const moduleAt = (dev: PlcDevice, rack: number, slot: number): HwModule | undefined =>
  dev.hardware?.modules.find((m) => m.rack === rack && m.slot === slot);

/** Il posto è libero e accetta il modulo (la CPU occupa sempre il posto 2 del rack 0). */
export function canPlace(
  dev: PlcDevice,
  type: ModuleType,
  rack: number,
  slot: number,
  ignoreId?: string,
): boolean {
  if (rack < 0 || rack >= MAX_RACKS) return false;
  const there = moduleAt(dev, rack, slot);
  return slotAccepts(type, rack, slot) && (!there || there.id === ignoreId);
}

/** Il primo posto libero che accetta il modulo nel rack, se c'è. */
export function firstFreeSlot(dev: PlcDevice, type: ModuleType, rack: number): number | undefined {
  for (let s = 1; s <= RACK_SLOTS; s++) if (canPlace(dev, type, rack, s)) return s;
  return undefined;
}

function defaults(type: ModuleType, rack: number, slot: number) {
  const start = defaultStartAddress(type, rack, slot);
  return {
    ...(type.inputBytes > 0 ? { inputStart: start } : {}),
    ...(type.outputBytes > 0 ? { outputStart: start } : {}),
  };
}

/** Inserisce un modulo del catalogo (su una bozza); falso se il posto non va bene. */
export function insertModule(
  dev: PlcDevice,
  orderNumber: string,
  rack: number,
  slot: number,
  id: string,
): boolean {
  const type = findModule(orderNumber);
  if (!type || !canPlace(dev, type, rack, slot)) return false;
  dev.hardware ??= { modules: [] };
  dev.hardware.modules.push({
    id,
    rack,
    slot,
    orderNumber: type.orderNumber,
    name: type.name,
    comment: '',
    ...defaults(type, rack, slot),
  });
  return true;
}

/** Sposta un modulo; gli indirizzi che erano quelli fissi del posto seguono il nuovo posto. */
export function moveModule(dev: PlcDevice, id: string, rack: number, slot: number): boolean {
  const m = dev.hardware?.modules.find((x) => x.id === id);
  const type = m && findModule(m.orderNumber);
  if (!m || !type || !canPlace(dev, type, rack, slot, id)) return false;
  const before = defaults(type, m.rack, m.slot);
  const after = defaults(type, rack, slot);
  if (m.inputStart === before.inputStart) m.inputStart = after.inputStart;
  if (m.outputStart === before.outputStart) m.outputStart = after.outputStart;
  m.rack = rack;
  m.slot = slot;
  return true;
}

export function deleteModule(dev: PlcDevice, id: string): boolean {
  const list = dev.hardware?.modules;
  const i = list?.findIndex((m) => m.id === id) ?? -1;
  if (!list || i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Intervalli di byte di ingresso (I) e di uscita (Q) occupati dai moduli, per indirizzo. */
export function ioRanges(dev: PlcDevice): { I: IoRange[]; Q: IoRange[] } {
  const out = { I: [] as IoRange[], Q: [] as IoRange[] };
  for (const m of dev.hardware?.modules ?? []) {
    const type = findModule(m.orderNumber);
    if (!type) continue;
    const add = (list: IoRange[], start: number | undefined, bytes: number) => {
      if (start !== undefined && bytes > 0) {
        list.push({ moduleId: m.id, name: m.name, from: start, to: start + bytes - 1 });
      }
    };
    add(out.I, m.inputStart, type.inputBytes);
    add(out.Q, m.outputStart, type.outputBytes);
  }
  out.I.sort((a, b) => a.from - b.from);
  out.Q.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * Se il byte `byte` dell'area è coperto da un modulo; undefined se non c'è una configurazione con
 * almeno un modulo di I/O (progetti vecchi o rack solo con PS e IM: nessun avviso).
 */
export function ioCoverage(
  dev: PlcDevice,
): ((area: 'I' | 'Q', byte: number) => boolean) | undefined {
  const r = ioRanges(dev);
  if (r.I.length === 0 && r.Q.length === 0) return undefined;
  return (area, byte) => r[area].some((x) => byte >= x.from && byte <= x.to);
}

/** Problemi della configurazione: posti, collegamento dei rack, indirizzi sovrapposti o oltre la CPU. */
export function checkHardware(dev: PlcDevice, cpu: CpuType | undefined): HwIssue[] {
  const mods = dev.hardware?.modules ?? [];
  const out: HwIssue[] = [];
  const seen = new Set<string>();
  const imRole = (rack: number) => {
    const m = mods.find((x) => x.rack === rack && x.slot === 3);
    return m ? findModule(m.orderNumber)?.im : undefined;
  };
  const rack0 = imRole(0);
  for (const m of mods) {
    const type = findModule(m.orderNumber);
    if (!type) {
      out.push({ moduleId: m.id, code: 'HW_MODULE_UNKNOWN' });
      continue;
    }
    const key = `${m.rack}/${m.slot}`;
    if (
      !Number.isInteger(m.rack) ||
      m.rack < 0 ||
      m.rack >= MAX_RACKS ||
      !slotAccepts(type, m.rack, m.slot)
    ) {
      out.push({ moduleId: m.id, code: 'HW_SLOT_INVALID' });
    } else if (seen.has(key)) {
      out.push({ moduleId: m.id, code: 'HW_SLOT_TAKEN' });
    }
    seen.add(key);
    if (m.rack > 0) {
      // IM 360 nel rack 0 con IM 361 negli altri, oppure la coppia IM 365 (solo rack 1).
      const here = imRole(m.rack);
      const ok = (rack0 === 'im360' && here === 'im361') || (rack0 === 'im365' && here === 'im365');
      if (!ok && m.slot >= FIRST_IO_SLOT) {
        out.push({ moduleId: m.id, code: 'HW_RACK_NOT_CONNECTED' });
      }
    }
  }
  const ranges = ioRanges(dev);
  for (const area of ['I', 'Q'] as const) {
    const list = ranges[area];
    const limit = area === 'I' ? cpu?.limits.inputBytes : cpu?.limits.outputBytes;
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (r.from < 0 || (limit !== undefined && r.to >= limit)) {
        out.push({ moduleId: r.moduleId, code: 'HW_ADDRESS_OUT_OF_RANGE', area });
      }
      // Ordinati per inizio: basta guardare i precedenti che finiscono dopo l'inizio di questo.
      const prev = list.slice(0, i).find((p) => p.to >= r.from);
      if (prev) {
        out.push({ moduleId: r.moduleId, code: 'HW_ADDRESS_OVERLAP', area, other: prev.name });
      }
    }
  }
  return out;
}
