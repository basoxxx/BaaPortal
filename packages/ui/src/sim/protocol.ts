import type { DiagEntry, MonitorRequest, MonitorStep, SimCpuProps, SimMode } from '@baaportal/sim';

/**
 * Operando già risolto (la risoluzione di simboli e formati è del renderer): area, DB, byte, bit
 * e dimensione. T e C: il numero sta in `byte`. I valori viaggiano come byte grezzi.
 */
export interface WatchItem {
  area: 'I' | 'Q' | 'M' | 'DB' | 'PI' | 'PQ' | 'T' | 'C';
  db?: number;
  byte: number;
  bit?: number;
  size: 'X' | 'B' | 'W' | 'D';
}

/** Valore grezzo (big-endian, come in memoria; per `X` un byte 0/1) oppure il motivo dell'errore. */
export type WatchValue = { bytes: Uint8Array } | { error: string };

/** Voci al più per richiesta `watch` o `write`: la notifica porta al più 4 byte per voce. */
export const MAX_WATCH_ITEMS = 1000;

export interface WriteItemReq extends WatchItem {
  /** Byte da scrivere (dimensione dell'operando; per `X` conta se il byte è diverso da 0). */
  data: Uint8Array;
}

export type WriteResult = { ok: true } | { error: string };

export type SimRequest =
  | { op: 'start'; cpuTypeId: string; props: SimCpuProps }
  | { op: 'download'; files: Uint8Array[] }
  | { op: 'mode'; to: 'RUN' | 'STOP' }
  | { op: 'mres' }
  | { op: 'setInputs'; byte: number; bytes: Uint8Array }
  /** Allarme di diagnostica (OB82) o guasto (OB86); `address` è l'indirizzo logico di base del modulo. */
  | { op: 'interrupt'; ob: 82 | 86; address?: number }
  | { op: 'monitor'; block?: MonitorRequest }
  | { op: 'watch'; items: WatchItem[] }
  | { op: 'write'; items: WriteItemReq[] }
  | { op: 'stop' };

export interface SimWarning {
  code: 'SFC_NON_SIMULATA' | 'SFB_NON_SIMULATA';
  block: string;
  message: string;
}

export interface SimStats {
  last: number;
  min: number;
  max: number;
  cycles: number;
}

export type SimNotice =
  | {
      kind: 'status';
      mode: SimMode;
      stats: SimStats;
      diagnostics: DiagEntry[];
      warnings: SimWarning[];
      /** Ingressi fisici (`physIn`) e uscite fisiche (`physOut`). */
      inputs: Uint8Array;
      outputs: Uint8Array;
    }
  | { kind: 'monitor'; block: MonitorRequest; steps: MonitorStep[] }
  | { kind: 'watch'; values: WatchValue[] }
  /** Errore fatale dell'ospite (eccezione in un timer): la sessione lo considera fallito. */
  | { kind: 'error'; message: string };

/** Messaggio renderer → worker. */
export interface SimWireRequest {
  id: number;
  req: SimRequest;
}

/** Messaggio worker → renderer: risposta a una richiesta, oppure notifica. */
export type SimWireMessage =
  | { type: 'response'; id: number; ok: true; value?: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'notice'; notice: SimNotice };
