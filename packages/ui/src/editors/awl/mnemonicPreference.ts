import { useSyncExternalStore } from 'react';
import type { Mnemonic } from '@baaportal/awl';

const KEY = 'baa.mnemonic';
const listeners = new Set<() => void>();
// Se il localStorage non è disponibile la scelta vale comunque per questa sessione.
let memory: Mnemonic = 'international';

function read(): Mnemonic {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'german' ? 'german' : 'international';
  } catch {
    return memory;
  }
}

function write(m: Mnemonic): void {
  memory = m;
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* storage non disponibile: resta la scelta in memoria */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** La mnemonica mostrata nei segmenti AWL: una sola per tutte le finestre dello stesso processo. */
export function useMnemonic(): [Mnemonic, (m: Mnemonic) => void] {
  return [useSyncExternalStore(subscribe, read, () => 'international'), write];
}

/**
 * La mnemonica scelta adesso, nella forma che usa la ricerca. Unico punto da cambiare quando la
 * preferenza passerà alle impostazioni.
 */
export function currentMnemonic(): 'de' | 'int' {
  return read() === 'german' ? 'de' : 'int';
}
