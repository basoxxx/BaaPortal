import type { SourceError } from './types';

/** Cursore sulle righe del file (0-based) con l'elenco degli errori raccolti. */
export class Reader {
  i = 0;
  readonly errors: SourceError[] = [];
  constructor(readonly lines: string[]) {}

  get done(): boolean {
    return this.i >= this.lines.length;
  }

  /** Aggiunge un errore alla riga `line` (0-based), colonna `col` (0-based). */
  error(line: number, col: number, code: string, params?: Record<string, string>): void {
    const e: SourceError = { line: line + 1, col: col + 1, code };
    if (params) e.params = params;
    this.errors.push(e);
  }

  /** Colonna (0-based) del primo carattere non vuoto della riga. */
  indent(line: number): number {
    const l = this.lines[line] ?? '';
    return l.length - l.trimStart().length;
  }
}
