import type { IpcMainInvokeEvent } from 'electron';
import type {
  PlcAccess,
  PlcConnectResult,
  PlcBlocksResult,
  PlcControlResult,
  PlcDownloadResult,
  PlcScanStartResult,
  PlcUploadAllResult,
} from '@baaportal/ui';
import type { ConfirmFn } from './confirm';
import { PlcWriteService, isControlOp, parseDownloadRequest } from './plcWrite';
import { listOnlineBlocks } from './onlineBlocks';
import { PlcService } from './plcService';
import { ScanService } from './scanService';
import { UploadService } from './uploadAll';

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
  confirm: ConfirmFn,
  service = new PlcService(),
  scans = new ScanService(),
  writes = new PlcWriteService({ service, confirm }),
  uploads = new UploadService(),
): { closeAll(): Promise<void>; writing(): boolean } {
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
  // Scritture: la conferma nativa la chiede il servizio, qualunque cosa faccia il renderer.
  handle('plc:download', async (e, files, opts): Promise<PlcDownloadResult> => {
    const req = parseDownloadRequest(files, opts);
    if (typeof req === 'string') return { ok: false, loaded: [], deleted: [], error: req };
    return writes.download(e.sender, req.files, { deleteBlocks: req.deleteBlocks });
  });
  handle('plc:control', async (e, op): Promise<PlcControlResult> => {
    if (!isControlOp(op)) return { ok: false, error: 'Comando non valido' };
    return writes.control(e.sender, op);
  });
  // Elenco dei blocchi della CPU: sola lettura, sul collegamento della finestra.
  handle('plc:blocks', (e): Promise<PlcBlocksResult> => listOnlineBlocks(service, e.sender));
  // Caricamento dalla CPU: collegamento proprio, in sola lettura, dall'accesso dato dalla finestra.
  handle('plc:uploadAll', async (e, raw): Promise<PlcUploadAllResult> => {
    const access = parsePlcAccess(raw);
    if (typeof access === 'string') return { ok: false, error: access };
    return uploads.start(e.sender, access);
  });
  handle('plc:uploadCancel', (e) => uploads.cancel(e.sender));
  return {
    closeAll: async () => {
      await Promise.all([
        scans.cancelAll(),
        uploads.abortAll(),
        writes.abortAll().then(() => service.closeAll()),
      ]);
    },
    writing: () => writes.writing(),
  };
}
