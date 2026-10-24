import type { SimError, SimErrorCode } from './errors';

/** Voce del buffer di diagnostica della CPU simulata. */
export interface DiagEntry {
  /** Istante (ms, orologio della CPU). */
  time: number;
  code: SimErrorCode | 'STOP_RICHIESTO' | 'AVVIO' | 'CANCELLAZIONE_TOTALE';
  /** Blocco in cui è avvenuto l'errore, per esempio `FC2`. */
  block?: string;
  /** Offset MC7 (byte) dell'istruzione. */
  offset?: number;
  /** Rete (da 1) del blocco. */
  network?: number;
  detail?: string;
}

/** Voce di diagnostica per un errore di programmazione. */
export function diagFromError(time: number, e: SimError): DiagEntry {
  const d: DiagEntry = { time, code: e.code };
  if (e.block) d.block = `${e.block.kind}${e.block.number}`;
  if (e.offset !== undefined) d.offset = e.offset;
  if (e.network !== undefined) d.network = e.network;
  if (e.detail !== undefined) d.detail = e.detail;
  return d;
}
