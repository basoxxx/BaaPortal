import { createRoot } from 'react-dom/client';
import { App, type BaaBridge } from '@baaportal/ui';

declare global {
  interface Window {
    baa: BaaBridge;
  }
}

createRoot(document.getElementById('root')!).render(<App bridge={window.baa} />);
