import type { BaaBridge } from '@baaportal/ui';
import type { IpcResult } from './ipcResult';

// Bridge esposto dal preload: contextBridge elimina le proprietà custom degli Error
// (es. `code`), quindi i metodi fs restituiscono dati (IpcResult) e il renderer
// ricostruisce gli errori con createBridge.
export type RawBridge = Omit<BaaBridge, 'readFile' | 'writeFileAtomic'> & {
  readFile(path: string): Promise<IpcResult<Uint8Array>>;
  writeFileAtomic(path: string, data: Uint8Array): Promise<IpcResult<void>>;
};
