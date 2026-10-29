// Tabelle di controllo: modifiche alle righe (copia/incolla, ordine) senza dipendere dalla griglia.
import type { WatchFormat, WatchRow } from '@baaportal/project';
import { parseTsv, toTsv } from '../../grid/tsv';
import { WATCH_FORMATS } from './watchRows';

type NewId = () => string;

export const isWatchFormat = (f: string): f is WatchFormat =>
  (WATCH_FORMATS as readonly string[]).includes(f);

/** Copie con id nuovi; le chiavi sono quelle di `WatchRow`, nient'altro. */
export function cloneWatchRows(rows: readonly WatchRow[], newId: NewId): WatchRow[] {
  return rows.map((r) => ({
    id: newId(),
    operand: r.operand,
    format: r.format,
    ...(r.modify ? { modify: r.modify } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
  }));
}

/** Testo per gli appunti di sistema: operando, formato, valore di comando, commento. */
export const watchRowsToTsv = (rows: readonly WatchRow[]): string =>
  toTsv(rows.map((r) => [r.operand, r.format, r.modify ?? '', r.comment ?? '']));

/**
 * Righe da testo tabulare (anche di Excel). Il formato, se non valido o assente, è quello
 * dell'operando (`formatOf`); le righe senza operando si scartano.
 */
export function watchRowsFromTsv(
  text: string,
  newId: NewId,
  formatOf: (operand: string) => WatchFormat,
): WatchRow[] {
  const out: WatchRow[] = [];
  for (const [operand = '', format = '', modify = '', comment = ''] of parseTsv(text)) {
    const op = operand.trim();
    if (op === '') continue;
    const f = format.trim().toUpperCase();
    out.push({
      id: newId(),
      operand: op,
      format: isWatchFormat(f) ? f : formatOf(op),
      ...(modify.trim() ? { modify: modify.trim() } : {}),
      ...(comment ? { comment } : {}),
    });
  }
  return out;
}

/**
 * Sposta le righe `keys` (nel loro ordine attuale) sulla posizione della riga `targetKey`: dopo di
 * essa se si trascina verso il basso, prima se verso l'alto; `null` = in fondo.
 */
export function moveWatchRows(
  rows: readonly WatchRow[],
  keys: readonly string[],
  targetKey: string | null,
): WatchRow[] {
  const set = new Set(keys);
  const moved = rows.filter((r) => set.has(r.id));
  const rest = rows.filter((r) => !set.has(r.id));
  if (moved.length === 0 || (targetKey !== null && set.has(targetKey))) return [...rows];
  let at = rest.length;
  if (targetKey !== null) {
    const ti = rest.findIndex((r) => r.id === targetKey);
    if (ti < 0) return [...rows];
    const down = rows.findIndex((r) => r.id === targetKey) > rows.findIndex((r) => set.has(r.id));
    at = down ? ti + 1 : ti;
  }
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}
