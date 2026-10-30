import { contextBridge, ipcRenderer } from 'electron';
import type {
  BaaBridge,
  KitProgress,
  PlcEvent,
  PlcScanEvent,
  PlcWriteProgress,
  PlcUploadProgress,
  UpdateEvent,
} from '@baaportal/ui';
import type { RawBridge } from '../shared/rawBridge';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: RawBridge = {
  platform: process.platform as BaaBridge['platform'],
  appVersion: () => ipcRenderer.invoke('app:version'),
  defaultProjectDir: () => ipcRenderer.invoke('app:default-project-dir'),
  showOpenProjectDialog: () => ipcRenderer.invoke('dialog:open-project'),
  showSaveProjectDialog: (name) => ipcRenderer.invoke('dialog:save-project', name),
  showSelectFolderDialog: () => ipcRenderer.invoke('dialog:select-folder'),
  showOpenFileDialog: (opts) => ipcRenderer.invoke('dialog:open-file', opts),
  showSaveFileDialog: (opts) => ipcRenderer.invoke('dialog:save-file', opts),
  readFile: (path) => ipcRenderer.invoke('fs:read', path),
  writeFileAtomic: (path, data) => ipcRenderer.invoke('fs:write-atomic', path, data),
  fileExists: (path) => ipcRenderer.invoke('fs:exists', path),
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentAdd: (path, name) => ipcRenderer.invoke('recent:add', path, name),
  recentRemove: (path) => ipcRenderer.invoke('recent:remove', path),
  setWindowTitle: (title) => ipcRenderer.send('window:set-title', title),
  confirmUnsaved: (texts) => ipcRenderer.invoke('dialog:confirm-unsaved', texts),
  showError: (title, message) => ipcRenderer.invoke('dialog:error', title, message),
  onOpenFileRequest: (cb) => subscribe<[string]>('app:open-file', cb),
  onCloseRequest: (cb) => subscribe<[]>('app:close-requested', cb),
  closeWindowConfirmed: () => ipcRenderer.send('window:close-confirmed'),
  closeWindowCancelled: () => ipcRenderer.send('window:close-cancelled'),
  rendererReady: () => ipcRenderer.send('app:renderer-ready'),
  clipboardWriteText: (text) => ipcRenderer.send('clipboard:write-text', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  askQuestion: (texts) => ipcRenderer.invoke('dialog:question', texts),
  recoveryWrite: (key, data, info) => ipcRenderer.invoke('recovery:write', key, data, info),
  recoveryList: () => ipcRenderer.invoke('recovery:list'),
  recoveryRead: (key) => ipcRenderer.invoke('recovery:read', key),
  recoveryDelete: (key) => ipcRenderer.invoke('recovery:delete', key),
  startKit: (opts) => ipcRenderer.invoke('kit:start', opts),
  cancelKit: () => {
    ipcRenderer.invoke('kit:cancel').catch(() => undefined);
  },
  saveKitResult: async () => {
    const r = (await ipcRenderer.invoke('kit:save')) as
      { ok: true; path: string | null } | { ok: false; error: string };
    if (!r.ok) throw new Error(r.error);
    return r.path;
  },
  kitUnsavedSummary: () => ipcRenderer.invoke('kit:hasUnsaved'),
  onKitProgress: (cb) => subscribe<[KitProgress]>('kit:progress', cb),
  plcConnect: (access) => ipcRenderer.invoke('plc:connect', access),
  plcDisconnect: () => ipcRenderer.invoke('plc:disconnect'),
  plcStatus: () => ipcRenderer.invoke('plc:status'),
  onPlcEvent: (cb) => subscribe<[PlcEvent]>('plc:event', cb),
  plcInterfaces: () => ipcRenderer.invoke('plc:interfaces'),
  plcSerialPorts: () => ipcRenderer.invoke('plc:serialPorts'),
  plcMpiNodes: (link) => ipcRenderer.invoke('plc:mpiNodes', link),
  plcScanStart: (address) => ipcRenderer.invoke('plc:scanStart', address),
  plcScanCancel: () => ipcRenderer.invoke('plc:scanCancel'),
  onPlcScanEvent: (cb) => subscribe<[PlcScanEvent]>('plc:scanEvent', cb),
  plcDownload: (files, opts) => ipcRenderer.invoke('plc:download', files, opts),
  plcControl: (op) => ipcRenderer.invoke('plc:control', op),
  plcDiagnostics: (parts) => ipcRenderer.invoke('plc:diagnostics', parts),
  plcSetClock: (req) => ipcRenderer.invoke('plc:setClock', req),
  plcReadWatch: (items) => ipcRenderer.invoke('plc:readWatch', items),
  plcWriteVars: (items) => ipcRenderer.invoke('plc:writeVars', items),
  plcHmiArm: () => ipcRenderer.invoke('plc:hmiArm'),
  plcHmiDisarm: (token) => ipcRenderer.invoke('plc:hmiDisarm', token),
  plcHmiWrite: (token, items, jog) => ipcRenderer.invoke('plc:hmiWrite', token, items, jog),
  plcStatusStart: (req) => ipcRenderer.invoke('plc:statusStart', req),
  plcStatusWindow: (req) => ipcRenderer.invoke('plc:statusWindow', req),
  plcStatusRead: () => ipcRenderer.invoke('plc:statusRead'),
  plcStatusStop: () => ipcRenderer.invoke('plc:statusStop'),
  plcReadStacks: (experimental) => ipcRenderer.invoke('plc:readStacks', experimental),
  plcBlocks: () => ipcRenderer.invoke('plc:blocks'),
  plcUploadBlock: (type, number) => ipcRenderer.invoke('plc:uploadBlock', type, number),
  onPlcWriteProgress: (cb) => subscribe<[PlcWriteProgress]>('plc:writeProgress', cb),
  plcUploadAll: (access) => ipcRenderer.invoke('plc:uploadAll', access),
  plcUploadCancel: () => ipcRenderer.invoke('plc:uploadCancel'),
  onPlcUploadProgress: (cb) => subscribe<[PlcUploadProgress]>('plc:uploadProgress', cb),
  plcBackup: () => ipcRenderer.invoke('plc:backup'),
  plcBackupCancel: () => ipcRenderer.invoke('plc:backupCancel'),
  plcRestorePlan: () => ipcRenderer.invoke('plc:restorePlan'),
  plcRestore: (req) => ipcRenderer.invoke('plc:restore', req),
  plcRestoreInterrupt: () => ipcRenderer.invoke('plc:restoreInterrupt'),
  updateInfo: () => ipcRenderer.invoke('update:info'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateSetPrefs: (p) => ipcRenderer.invoke('update:prefs', p),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateCancelDownload: () => ipcRenderer.invoke('update:cancelDownload'),
  updateCanInstall: () => ipcRenderer.invoke('update:canInstall'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateShowInFolder: () => ipcRenderer.invoke('update:showInFolder'),
  updateLater: (version) => ipcRenderer.invoke('update:later', version),
  updateOpenNotes: (version) => ipcRenderer.invoke('update:openNotes', version),
  onUpdateEvent: (cb) => subscribe<[UpdateEvent]>('update:event', cb),
  printDocument: (req) => ipcRenderer.invoke('print:document', req),
  testOverrides: () => ipcRenderer.invoke('app:test-overrides'),
};

contextBridge.exposeInMainWorld('baaRaw', bridge);
