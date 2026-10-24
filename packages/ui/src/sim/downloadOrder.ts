export interface Orderable {
  kind: string;
  number: number;
}

/** DB e DB di istanza, poi FC, FB e infine gli OB; dentro ogni gruppo per numero. */
const GROUP: Record<string, number> = { DB: 0, IDB: 0, FC: 1, FB: 2, OB: 3 };

/** Ordine di caricamento nel dispositivo (stabile: a pari gruppo e numero resta l'ordine dato). */
export function downloadOrder<T extends Orderable>(items: readonly T[]): T[] {
  const group = (k: string) => GROUP[k] ?? 4;
  return [...items].sort((a, b) => group(a.kind) - group(b.kind) || a.number - b.number);
}
