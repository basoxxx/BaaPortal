import type { Project } from '@baaportal/project';
import type { FindOptions, Hit } from './types';

/** Il risultato dell'ultima ricerca, legato al progetto su cui è stata fatta. */
export type FindOutcome =
  | { kind: 'hits'; hits: Hit[]; project: Project; options: FindOptions }
  | { kind: 'error'; detail: string };

/** Stato dell'interfaccia "Trova e sostituisci": vive nello store, così sopravvive al cambio di scheda. */
export interface FindUi {
  query: string;
  replacement: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Rinominando una variabile con Sostituisci, si aggiornano anche i riferimenti nel codice. */
  updateRefs: boolean;
  scope: 'project' | 'active';
  outcome: FindOutcome | null;
  /** Indice del risultato selezionato in `outcome.hits`. */
  selected: number | null;
}

export const initialFindUi = (): FindUi => ({
  query: '',
  replacement: '',
  matchCase: false,
  wholeWord: false,
  regex: false,
  updateRefs: true,
  scope: 'project',
  outcome: null,
  selected: null,
});

export interface FindRequest {
  field: 'find' | 'replace';
  n: number;
}

/** Richiesta all'editor delle variabili di selezionare la riga di una variabile. */
export interface TagReveal {
  deviceId: string;
  tableId: string;
  tagId: string;
  n: number;
}
