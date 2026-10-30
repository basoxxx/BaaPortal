import type { WatchTable } from '@baaportal/project';
import { detectSeparator, escapeFormula, parseCsv, quote, unescapeFormula } from '../tags/csv';

export const WATCH_COLUMNS = ['Operando', 'Formato', 'Valore di comando', 'Commento'] as const;

export interface ParsedWatchRow {
  line: number;
  operand: string;
  /** Come scritto nel file: chi importa lo valida. */
  format: string;
  modify: string;
  comment: string;
}

export interface ParsedWatch {
  rows: ParsedWatchRow[];
  errors: { line: number; code: 'COLONNA_MANCANTE' | 'RIGA_ILLEGGIBILE' | 'OPERANDO_VUOTO' }[];
}

/** Esporta le righe di una tabella di controllo in csv (formule neutralizzate come per le variabili). */
export function watchToCsv(table: WatchTable): string {
  const sep = ';';
  const lines: string[][] = [[...WATCH_COLUMNS]];
  for (const r of table.rows)
    lines.push([r.operand, r.format, r.modify ?? '', r.comment ?? ''].map(escapeFormula));
  return '﻿' + lines.map((l) => l.map((v) => quote(v, sep)).join(sep)).join('\r\n') + '\r\n';
}

/** Legge un csv di tabella di controllo: le colonne si trovano per nome, l'operando è obbligatorio. */
export function parseWatchCsv(text: string): ParsedWatch {
  const records = parseCsv(text, detectSeparator(text.replace(/^﻿/, '')));
  const [header, ...body] = records;
  const out: ParsedWatch = { rows: [], errors: [] };
  const names = header?.cells.map((c) => c.trim().toLowerCase()) ?? [];
  const [iOp, iFmt, iMod, iCom] = WATCH_COLUMNS.map((c) => names.indexOf(c.toLowerCase())) as [
    number,
    number,
    number,
    number,
  ];
  if (iOp < 0) {
    out.errors.push({ line: header?.line ?? 1, code: 'COLONNA_MANCANTE' });
    return out;
  }
  for (const r of body) {
    if (r.unreadable) {
      out.errors.push({ line: r.line, code: 'RIGA_ILLEGGIBILE' });
      continue;
    }
    const raw = (i: number) => (i < 0 ? '' : unescapeFormula(r.cells[i] ?? ''));
    const operand = raw(iOp).trim();
    if (operand === '') {
      out.errors.push({ line: r.line, code: 'OPERANDO_VUOTO' });
      continue;
    }
    out.rows.push({
      line: r.line,
      operand,
      format: raw(iFmt).trim(),
      modify: raw(iMod).trim(),
      comment: raw(iCom),
    });
  }
  return out;
}
