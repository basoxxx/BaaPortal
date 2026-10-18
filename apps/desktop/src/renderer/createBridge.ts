import type { BaaBridge } from '@baaportal/ui';
import { fromIpcResult } from '../shared/ipcResult';
import type { RawBridge } from '../shared/rawBridge';

export function createBridge(raw: RawBridge): BaaBridge {
  return {
    ...raw,
    readFile: async (path) => fromIpcResult(await raw.readFile(path)),
    writeFileAtomic: async (path, data) => fromIpcResult(await raw.writeFileAtomic(path, data)),
  };
}
