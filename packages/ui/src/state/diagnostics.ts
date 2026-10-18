import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import { findCpu } from '@baaportal/catalog';
import { checkDevice, findDevice, type Diagnostic, type PlcDevice } from '@baaportal/project';
import type { GridDiagnostic } from '../grid/DataGrid';
import { useAppStore } from './AppContext';

const NONE: Diagnostic[] = [];
// Il progetto è immutabile: finché il dispositivo è lo stesso oggetto, la diagnostica non cambia.
const cache = new WeakMap<PlcDevice, Diagnostic[]>();

function diagnosticsOf(device: PlcDevice): Diagnostic[] {
  let out = cache.get(device);
  if (!out) {
    out = checkDevice(device, findCpu(device.cpu.typeId));
    cache.set(device, out);
  }
  return out;
}

/** Diagnostica del dispositivo, ricalcolata solo quando il dispositivo cambia. */
export function useDeviceDiagnostics(deviceId: string): Diagnostic[] {
  const device = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  return device ? diagnosticsOf(device) : NONE;
}

export function diagnosticText(d: Diagnostic, t: TFunction): string {
  return t(`diag.${d.code}`, d.params);
}

/**
 * Diagnostica di tag o costanti per cella: chiave `${id}\u0000${colonna}`. Su una stessa cella gli
 * errori vengono prima degli avvisi e i testi si uniscono con " · ".
 */
export function diagnosticCells(
  diagnostics: Diagnostic[],
  kind: 'tag' | 'constant' | 'member',
  t: TFunction,
): Map<string, GridDiagnostic> {
  const grouped = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    if (d.ref.kind !== kind || !d.field) continue;
    const id = d.ref.kind === 'member' ? d.ref.memberId : 'id' in d.ref ? d.ref.id : '';
    const key = cellKey(id, d.field);
    const list = grouped.get(key);
    if (list) list.push(d);
    else grouped.set(key, [d]);
  }
  const out = new Map<string, GridDiagnostic>();
  for (const [key, list] of grouped) {
    const sorted = [...list].sort(
      (a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'),
    );
    out.set(key, {
      severity: sorted[0]!.severity,
      text: sorted.map((d) => diagnosticText(d, t)).join(' · '),
    });
  }
  return out;
}

export const cellKey = (id: string, columnId: string): string => `${id}\u0000${columnId}`;

/** Per i componenti: mappa delle diagnostiche per cella, ricalcolata se cambiano dispositivo o lingua. */
export function useCellDiagnostics(deviceId: string, kind: 'tag' | 'constant', t: TFunction) {
  const diagnostics = useDeviceDiagnostics(deviceId);
  return useMemo(() => diagnosticCells(diagnostics, kind, t), [diagnostics, kind, t]);
}
