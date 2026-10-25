import { decodeUserdata, type S7Pdu } from '@baaportal/s7comm';

/**
 * Guasti programmabili del finto PLC, per provare la robustezza del client. Tutti sono
 * deterministici: stesse richieste, stessi byte e stessi tempi (il solo caso con un orologio è
 * `delayMs`).
 *
 * Il "numero di funzione" di `ignoreFunction` e `errorFor.function` è, per i job (ROSCTR 1), il
 * primo byte del parametro (0x04 read var, 0xF0 setup, 0x1D start upload...); per gli userdata
 * (ROSCTR 7) è `userdataFunction(gruppo, sottofunzione)`, p.es. 0x1401 per la lettura SZL.
 */
export interface FaultPlan {
  /** Ritardo in ms prima di ogni risposta (CC compreso; i DR di rifiuto no). */
  delayMs?: number;
  /** Dopo N risposte S7 la CPU chiude la connessione. 0: chiude alla prima richiesta, senza rispondere. */
  dropAfterResponses?: number;
  /** Ogni TPKT in uscita viene consegnato al trasporto in pezzi di al più N byte. */
  chunkSize?: number;
  /** Silenzio (nessuna risposta) alla funzione indicata. */
  ignoreFunction?: number;
  /** ID di SZL a cui la CPU risponde 0xD402 ("funzione informativa non disponibile"), qualunque indice. */
  szlUnavailable?: number[];
  /** La funzione indicata riceve sempre questo errore (classe e codice dell'header, come 0x85 0x00). */
  errorFor?: { function: number; errorClass: number; errorCode: number };
  /** I job di test sopravvivono alla chiusura della sessione e si gestiscono da un'altra (proto §18.4.1). */
  orphanJobs?: boolean;
  /** La sottofunzione TIS indicata riceve sempre questo codice d'errore (p.es. `0xD0A1`). */
  tisError?: { sub: number; code: number };
  /** Sottofunzioni TIS che rispondono con dati troncati a 7 byte. */
  tisMalformed?: number[];
}

/** Numero di funzione di un userdata per `FaultPlan`: 0x1000 + gruppo * 0x100 + sottofunzione. */
export function userdataFunction(group: number, subfunction: number): number {
  return 0x1000 + group * 0x100 + subfunction;
}

/** Numero di funzione di una PDU in arrivo (job o userdata), `undefined` se non determinabile. */
export function functionOf(pdu: S7Pdu): number | undefined {
  if (pdu.rosctr === 1) return pdu.param[0];
  if (pdu.rosctr === 7) {
    try {
      const u = decodeUserdata(pdu.param, pdu.data);
      return userdataFunction(u.param.group, u.param.subfunction);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function checkFaults(f: FaultPlan): void {
  const int = (name: string, v: number | undefined, min: number, max = 0xffffffff): void => {
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) {
      throw new RangeError(`faults.${name} ${v} fuori ${min}-${max}`);
    }
  };
  int('delayMs', f.delayMs, 0, 60_000);
  int('dropAfterResponses', f.dropAfterResponses, 0);
  int('chunkSize', f.chunkSize, 1);
  int('ignoreFunction', f.ignoreFunction, 0, 0xffff);
  for (const id of f.szlUnavailable ?? []) int('szlUnavailable', id, 0, 0xffff);
  if (f.tisError) {
    int('tisError.sub', f.tisError.sub, 0, 0xff);
    int('tisError.code', f.tisError.code, 0, 0xffff);
  }
  for (const sub of f.tisMalformed ?? []) int('tisMalformed', sub, 0, 0xff);
  if (f.errorFor) {
    int('errorFor.function', f.errorFor.function, 0, 0xffff);
    int('errorFor.errorClass', f.errorFor.errorClass, 0, 0xff);
    int('errorFor.errorCode', f.errorFor.errorCode, 0, 0xff);
  }
}

/** Spezza un TPKT in pezzi di al più `size` byte. */
export function chunked(frame: Uint8Array, size: number | undefined): Uint8Array[] {
  if (size === undefined || frame.length <= size) return [frame];
  const out: Uint8Array[] = [];
  for (let o = 0; o < frame.length; o += size) out.push(frame.slice(o, o + size));
  return out;
}
