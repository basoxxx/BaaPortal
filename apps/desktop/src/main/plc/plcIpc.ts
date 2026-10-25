import type { IpcMainInvokeEvent } from 'electron';
import type {
  PlcAccess,
  PlcClockResult,
  PlcDiagResult,
  PlcConnectResult,
  PlcBlocksResult,
  PlcControlResult,
  PlcDownloadResult,
  PlcScanStartResult,
  PlcUploadAllResult,
  PlcBackupResult,
  PlcUploadBlockResult,
  PlcReadWatchResult,
  PlcWriteVarsResult,
  PlcStatusStartResult,
  PlcStatusWindowResult,
  PlcStatusReadResult,
} from '@baaportal/ui';
import { BlockStatusService } from './blockStatus';
import { memoryJobStore, type TisJobStore } from './tisJobs';
import { BackupService, type PickBackupPath } from './backup';
import type { ConfirmFn } from './confirm';
import { readDiagnostics } from './diagnostics';
import { PlcWriteService, isControlOp } from './plcWrite';
import { isUploadableType, listOnlineBlocks, uploadOneBlock } from './onlineBlocks';
import { PlcService } from './plcService';
import { ScanService } from './scanService';
import { UploadService } from './uploadAll';
import { readWatch } from './watchOnline';

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
  pickBackupPath: PickBackupPath = async () => null,
  appVersion: () => string = () => '',
  jobs: TisJobStore = memoryJobStore(),
): { closeAll(): Promise<void>; writing(): boolean; interruptWrites(): void } {
  const status = new BlockStatusService({ service, jobs });
  handle('plc:connect', async (e, raw): Promise<PlcConnectResult> => {
    const access = parsePlcAccess(raw);
    if (typeof access === 'string') return { ok: false, error: access };
    return service.connect(e.sender, access);
  });
  // Pulizia dei job di test nostri rimasti sulla CPU dopo una chiusura anomala.
  service.onConnect((owner) => void status.cleanup(owner));
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
    // Il servizio controlla i dati (una volta sola) prima di qualunque conferma.
    return writes.download(e.sender, files, opts);
  });
  handle('plc:control', async (e, op): Promise<PlcControlResult> => {
    if (!isControlOp(op)) return { ok: false, error: 'Comando non valido' };
    return writes.control(e.sender, op);
  });
  // Imposta l'ora: il servizio controlla la richiesta prima di qualunque conferma.
  handle('plc:setClock', (e, req): Promise<PlcClockResult> => writes.setClock(e.sender, req));
  // Diagnostica: sola lettura sul collegamento della finestra; le parti le controlla il servizio.
  handle('plc:diagnostics', (e, parts): Promise<PlcDiagResult> => {
    return readDiagnostics(service, e.sender, parts);
  });
  // Tabelle di controllo online: lettura sul collegamento della finestra; scrittura con conferma nativa.
  handle('plc:readWatch', (e, items): Promise<PlcReadWatchResult> =>
    readWatch(service, e.sender, items),
  );
  handle('plc:writeVars', (e, items): Promise<PlcWriteVarsResult> =>
    writes.writeVars(e.sender, items),
  );
  // Osservazione del blocco: bersaglio e CPU li decide il servizio; qui solo la forma della richiesta.
  handle('plc:statusStart', (e, raw): Promise<PlcStatusStartResult> => status.start(e.sender, raw));
  handle('plc:statusWindow', (e, raw): PlcStatusWindowResult => status.window(e.sender, raw));
  handle('plc:statusRead', (e): Promise<PlcStatusReadResult> => status.read(e.sender));
  handle('plc:statusStop', (e) => status.stop(e.sender));
  // Elenco dei blocchi della CPU: sola lettura, sul collegamento della finestra.
  handle('plc:blocks', (e): Promise<PlcBlocksResult> => listOnlineBlocks(service, e.sender));
  // Un solo blocco della CPU collegata: sola lettura, solo OB, FB, FC e DB.
  handle('plc:uploadBlock', (e, type, number): Promise<PlcUploadBlockResult> => {
    if (!isUploadableType(type))
      return Promise.resolve({ ok: false, error: 'Tipo di blocco non valido' });
    if (!int(number, 0, 65535))
      return Promise.resolve({ ok: false, error: 'Numero di blocco non valido' });
    return uploadOneBlock(service, e.sender, type, number);
  });
  // Caricamento dalla CPU: collegamento proprio, in sola lettura, dall'accesso dato dalla finestra.
  handle('plc:uploadAll', async (e, raw): Promise<PlcUploadAllResult> => {
    const access = parsePlcAccess(raw);
    if (typeof access === 'string') return { ok: false, error: access };
    return uploads.start(e.sender, access);
  });
  handle('plc:uploadCancel', (e) => uploads.cancel(e.sender));
  // Backup online: file scelto con la finestra nativa, poi collegamento proprio in sola lettura.
  const backups = new BackupService({
    service,
    uploads,
    pick: pickBackupPath,
    appVersion,
  });
  handle('plc:backup', (e): Promise<PlcBackupResult> => backups.backup(e.sender));
  handle('plc:backupCancel', (e) => backups.cancel(e.sender));
  return {
    closeAll: async () => {
      await Promise.all([
        status.stopAll(),
        scans.cancelAll(),
        (async () => backups.abortAll())(),
        uploads.abortAll(),
        writes.abortAll().then(() => service.closeAll()),
      ]);
    },
    writing: () => writes.writing(),
    interruptWrites: () => writes.interruptAll(),
  };
}
