const NEEDS_QUOTES = /[\t\n\r"]/;

/** Righe di celle → testo con tab e \r\n; i campi con tab, a capo o virgolette vanno tra virgolette. */
export function toTsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => (NEEDS_QUOTES.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t'))
    .join('\r\n');
}

/** Testo tabulare (anche di Excel) → righe di celle. Accetta \n e \r\n e ignora l'ultima riga vuota. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  const endField = () => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (ch === '\t') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
      atFieldStart = false;
    }
  }
  // L'ultimo a capo non apre una riga nuova.
  if (field !== '' || row.length > 0 || quoted) endRow();
  return rows;
}
