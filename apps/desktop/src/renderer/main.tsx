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

// Un file rilasciato sulla finestra non deve far navigare la pagina altrove. Il testo e i dati
// dell'app (albero, dettagli) si trascinano normalmente: si blocca solo ciò che porta file.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes('Files')) e.preventDefault();
  });
}

window.baa = createBridge(window.baaRaw);

createRoot(document.getElementById('root')!).render(<App bridge={window.baa} />);
