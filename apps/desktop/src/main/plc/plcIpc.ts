import type { IpcMainInvokeEvent } from 'electron';
import type { PlcAccess, PlcConnectResult, PlcScanStartResult } from '@baaportal/ui';
import { PlcService } from './plcService';
import { ScanService } from './scanService';

type Handle = (
  channel: string,
  listener: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

const TYPES = ['PG', 'OP', 'S7_BASIC'];

function int(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Controlla ciò che arriva dal renderer: oltre ai tipi, anche gli intervalli. */
export function parsePlcAccess(raw: unknown): PlcAccess | string {
  if (typeof raw !== 'object' || raw === null) return 'Dati di accesso non validi';
  const r = raw as Record<string, unknown>;
  if (typeof r['host'] !== 'string' || r['host'].length === 0 || r['host'].length > 255) {
    return 'Indirizzo non valido';
  }
  if (r['port'] !== undefined && !int(r['port'], 1, 65535)) return 'Porta non valida';
  if (!int(r['rack'], 0, 7)) return 'Rack non valido';
  if (!int(r['slot'], 0, 31)) return 'Slot non valido';
  if (typeof r['connectionType'] !== 'string' || !TYPES.includes(r['connectionType'])) {
    return 'Tipo di collegamento non valido';
  }
  if (r['remoteTsap'] !== undefined && !int(r['remoteTsap'], 0, 0xffff)) return 'TSAP non valido';
  const out: PlcAccess = {
    host: r['host'],
    rack: r['rack'],
    slot: r['slot'],
    connectionType: r['connectionType'] as PlcAccess['connectionType'],
  };
  if (r['port'] !== undefined) out.port = r['port'] as number;
  if (r['remoteTsap'] !== undefined) out.remoteTsap = r['remoteTsap'] as number;
  return out;
}

/** Canali del collegamento online; il servizio tiene un collegamento per finestra (`e.sender`). */
export function registerPlc(
  handle: Handle,
  service = new PlcService(),
  scans = new ScanService(),
): { closeAll(): Promise<void> } {
  handle('plc:connect', async (e, raw): Promise<PlcConnectResult> => {
    const access = parsePlcAccess(raw);
    if (typeof access === 'string') return { ok: false, error: access };
    return service.connect(e.sender, access);
  });
  handle('plc:disconnect', (e) => service.disconnect(e.sender));
  handle('plc:status', (e) => service.status(e.sender));
  // Ricerca: parte solo da questo canale, su richiesta; l'indirizzo deve essere di un'interfaccia reale.
  handle('plc:interfaces', () => scans.listInterfaces());
  handle('plc:scanStart', (e, address): PlcScanStartResult => {
    if (typeof address !== 'string') return { ok: false, error: 'Indirizzo non valido' };
    return scans.start(e.sender, address);
  });
  handle('plc:scanCancel', (e) => scans.cancel(e.sender));
  return {
    closeAll: async () => {
      await Promise.all([scans.cancelAll(), service.closeAll()]);
    },
  };
}
