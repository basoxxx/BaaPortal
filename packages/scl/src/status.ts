// Osservazione di un blocco SCL: dallo stato per riga dell'AWL generato (simulatore o CPU) allo
// stato di ogni riga SCL. Il valore di una riga viene solo dall'istruzione che lo porta
// (`SclLine.value`): senza cella è sconosciuto (fuori finestra, in attesa), con cella `null` la riga
// non è elaborata. Nei cicli le celle sono quelle dell'ultima esecuzione nel ciclo del PLC.
import type { SclLine, SclType } from './toAwl.js';

/** Stato dopo un'istruzione; `null` = chiesta ma non elaborata in questo ciclo. */
export type SclCell = { rlo: boolean; accu1: number } | null;

/** Un valore della riga: `cell` assente = sconosciuto, `null` = non elaborato. */
export type SclValue = { ty: SclType; cell?: { rlo: boolean; accu1: number } | null };

export type SclLineStatus = {
  /** `unknown`: l'istruzione che decide non ha cella (fuori finestra, in attesa). */
  state: 'run' | 'notRun' | 'unknown';
  /** I valori della riga, in ordine (più istruzioni sulla stessa riga danno più valori). */
  values: SclValue[];
};

/**
 * Stato di ogni riga SCL (da 1) che ha AWL. Con valori, la riga è elaborata se lo è almeno uno,
 * non elaborata se tutti sono `null`; senza valori (chiamate, EXIT, etichette di CASE) decide la
 * sua prima istruzione. `nullUnknown`: una cella `null` non dice «non elaborata» (risposta
 * parziale della CPU, finestra in attesa di risposta) e vale come assente.
 */
export function sclLineStatus(
  lines: readonly SclLine[],
  cells: ReadonlyMap<number, SclCell>,
  opts: { nullUnknown?: boolean } = {},
): Map<number, SclLineStatus> {
  const cellOf = (line: number): SclCell | undefined => {
    const c = cells.get(line);
    return c === null && opts.nullUnknown ? undefined : c;
  };
  const owned = new Map<number, SclLine[]>();
  for (const l of lines) {
    const list = owned.get(l.sclLine);
    if (list) list.push(l);
    else owned.set(l.sclLine, [l]);
  }
  const out = new Map<number, SclLineStatus>();
  for (const [scl, own] of owned) {
    const values: SclValue[] = own.flatMap((l) => {
      if (!l.value) return [];
      const c = cellOf(l.line);
      return [c === undefined ? { ty: l.value } : { ty: l.value, cell: c }];
    });
    const states = values.length ? values.map((v) => v.cell) : [cellOf(own[0]!.line)];
    const state = states.some((c) => c)
      ? 'run'
      : states.every((c) => c === null)
        ? 'notRun'
        : 'unknown';
    out.set(scl, { state, values });
  }
  return out;
}
