import { createRoot } from 'react-dom/client';
import { App, type BaaBridge } from '@baaportal/ui';
import type { RawBridge } from '../shared/rawBridge';
import { createBridge } from './createBridge';

declare global {
  interface Window {
    baa: BaaBridge;
    baaRaw: RawBridge;
  }
}

window.baa = createBridge(window.baaRaw);

createRoot(document.getElementById('root')!).render(<App bridge={window.baa} />);
