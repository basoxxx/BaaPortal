import type { IpcMainInvokeEvent } from 'electron';
import { listMpiNodesSerial, listSerialPorts } from '@baaportal/s7comm/node';
import {
  MPI_BUS_SPEEDS,
  MPI_HIGHEST_ADDRESSES,
  type MpiBusSpeed,
  type PlcLink,
} from '@baaportal/project';
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
  PlcHmiArmResult,
  PlcStatusStartResult,
  PlcStatusWindowResult,
  PlcStatusReadResult,
  PlcStacksResult,
  PlcRestorePlanResult,
  PlcRestoreResult,
  PlcMpiNodesResult,
} from '@baaportal/ui';
import { BlockStatusService } from './blockStatus';
import { memoryJobStore, type TisJobStore } from './tisJobs';
import { BackupService, type PickBackupPath } from './backup';
import type { ConfirmFn } from './confirm';
import type { RestoreFileIo } from './plcWrite';
import { readStacks } from './stacks';
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
const MPI_SAME_ADDRESS = 'L’indirizzo MPI della CPU deve essere diverso da quello dell’adattatore';

function int(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Controlla ciò che arriva dal renderer: oltre ai tipi, anche gli intervalli. */
export function parsePlcAccess(raw: unknown): PlcAccess | string {
  if (typeof raw !== 'object' || raw === null) return 'Dati di accesso non validi';
  const r = raw as Record<string, unknown>;
  const mpi =
    typeof r['link'] === 'object' &&
    r['link'] !== null &&
    'kind' in r['link'] &&
    r['link'].kind === 'mpi';
  // Con l'adattatore MPI l'host non si usa: può restare vuoto.
  if (typeof r['host'] !== 'string' || (!mpi && r['host'].length === 0) || r['host'].length > 255) {
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
  if (r['link'] !== undefined) {
    const link = parseLink(r['link']);
    if (typeof link === 'string') return link;
    // non in `parseLink`: «Cerca» non ha ancora un indirizzo della CPU
    if (link.kind === 'mpi' && link.localAddress === link.cpuAddress) return MPI_SAME_ADDRESS;
    out.link = link;
  }
  return out;
}

/** Stessi intervalli dello schema del file `.baap`. */
function parseLink(raw: unknown): PlcLink | string {
  if (typeof raw !== 'object' || raw === null) return 'Tipo di collegamento non valido';
  const l = raw as Record<string, unknown>;
  if (l['kind'] === 'tcp') return { kind: 'tcp' };
  if (l['kind'] !== 'mpi') return 'Tipo di collegamento non valido';
  const port = l['port'];
  if (typeof port !== 'string' || port.length === 0 || port.length > 255) {
    return 'Porta seriale non valida';
  }
  if (!int(l['baudRate'], 1, Number.MAX_SAFE_INTEGER)) return 'Velocità di trasmissione non valida';
  const parity = l['parity'];
  if (parity !== 'odd' && parity !== 'even' && parity !== 'none') return 'Parità non valida';
  if (!int(l['localAddress'], 0, 126) || !int(l['cpuAddress'], 0, 126)) {
    return 'Indirizzo MPI non valido';
  }
  const hsa = l['highestAddress'];
  if (!(MPI_HIGHEST_ADDRESSES as readonly unknown[]).includes(hsa)) {
    return 'Indirizzo più alto (HSA) non valido';
  }
  const busSpeed = l['busSpeed'];
  if (!(MPI_BUS_SPEEDS as readonly unknown[]).includes(busSpeed)) {
    return 'Velocità del bus non valida';
  }
  const variant = l['variant'];
  if (variant !== 'auto' && variant !== 'v1' && variant !== 'v2') return 'Variante MPI non valida';
  return {
    kind: 'mpi',
    port,
    baudRate: l['baudRate'] as number,
    parity,
    localAddress: l['localAddress'] as number,
    cpuAddress: l['cpuAddress'] as number,
    highestAddress: hsa as number,
    busSpeed: busSpeed as MpiBusSpeed,
    variant,
  };
}

/** «Cerca» sul bus MPI: apre l'adattatore, legge i nodi attivi e lo chiude. Mai eccezioni. */
export async function mpiNodes(
  raw: unknown,
  list: typeof listMpiNodesSerial = listMpiNodesSerial,
): Promise<PlcMpiNodesResult> {
  const link = parseLink(raw);
  if (typeof link === 'string') return { ok: false, error: link };
  if (link.kind !== 'mpi') return { ok: false, error: 'Tipo di collegamento non valido' };
  try {
    const nodes = await list(
      { path: link.port, baudRate: link.baudRate, parity: link.parity },
      {
        localAddress: link.localAddress,
        highestAddress: link.highestAddress,
        busSpeed: link.busSpeed,
        variant: link.variant,
      },
    );
    return { ok: true, nodes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  restoreFile?: RestoreFileIo,
): {
  closeAll(): Promise<void>;
  writing(): boolean;
  busy(): boolean;
  /** Annulla `closeAll`: scritture, ripristini, caricamenti e backup possono ripartire. */
  resume(): void;
  interruptWrites(): void;
} {
  const status = new BlockStatusService({ service, jobs, blocked: (a) => writes.restoringOn(a) });
  if (restoreFile) writes.setRestoreFile(restoreFile);
  writes.beforeRestore = (owner) => status.stopForCpu(owner);
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
  handle('plc:serialPorts', () => listSerialPorts());
  handle('plc:mpiNodes', (_e, raw) => mpiNodes(raw));
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
  // Runtime HMI: una conferma nativa all'avvio in scrittura, poi scritture senza conferma con il
  // token di quell'avvio, finché il runtime non lo revoca o il collegamento cambia (lo controlla il servizio).
  handle('plc:hmiArm', (e): Promise<PlcHmiArmResult> => writes.hmiArm(e.sender));
  handle('plc:hmiDisarm', (e, token) => writes.hmiDisarm(e.sender, token));
  handle('plc:hmiWrite', (e, token, items, jog): Promise<PlcWriteVarsResult> =>
    writes.hmiWrite(e.sender, token, items, jog),
  );
  // Osservazione del blocco: bersaglio e CPU li decide il servizio; qui solo la forma della richiesta.
  handle('plc:statusStart', (e, raw): Promise<PlcStatusStartResult> => status.start(e.sender, raw));
  handle('plc:statusWindow', (e, raw): PlcStatusWindowResult => status.window(e.sender, raw));
  handle('plc:statusRead', (e): Promise<PlcStatusReadResult> => status.read(e.sender));
  handle('plc:statusStop', (e) => status.stop(e.sender));
  // Stack di chiamata (sperimentale): il servizio rifiuta se l'impostazione non è proprio `true`.
  handle('plc:readStacks', (e, experimental): Promise<PlcStacksResult> =>
    readStacks(service, e.sender, { experimental: experimental === true }),
  );
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
  // Ripristino di un backup (sperimentale): il piano resta nel main, il renderer riceve righe e token.
  handle('plc:restorePlan', (e): Promise<PlcRestorePlanResult> => writes.restorePlan(e.sender));
  handle('plc:restore', (e, raw): Promise<PlcRestoreResult> => writes.restore(e.sender, raw));
  handle('plc:restoreInterrupt', (e) => writes.interrupt(e.sender));
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
    // Operazioni che un aggiornamento non deve interrompere: scrittura, ripristino, caricamento dalla CPU, backup.
    // Le osservazioni invece si fermano in modo pulito (`closeAll`).
    resume: () => {
      writes.resume();
      uploads.resume();
      backups.resume();
    },
    busy: () => writes.writing() || writes.restoring() || uploads.active() || backups.active(),
    interruptWrites: () => writes.interruptAll(),
  };
}
