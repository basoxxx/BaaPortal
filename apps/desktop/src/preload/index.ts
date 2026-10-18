import { contextBridge, ipcRenderer } from 'electron';
import type { BaaBridge } from '@baaportal/ui';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: BaaBridge = {
  platform: process.platform as BaaBridge['platform'],
  appVersion: () => ipcRenderer.invoke('app:version'),
  defaultProjectDir: () => ipcRenderer.invoke('app:default-project-dir'),
  showOpenProjectDialog: () => ipcRenderer.invoke('dialog:open-project'),
  showSaveProjectDialog: (name) => ipcRenderer.invoke('dialog:save-project', name),
  showSelectFolderDialog: () => ipcRenderer.invoke('dialog:select-folder'),
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
  rendererReady: () => ipcRenderer.send('app:renderer-ready'),
};

contextBridge.exposeInMainWorld('baa', bridge);
