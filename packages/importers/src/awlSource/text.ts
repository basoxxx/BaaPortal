// Funzioni di testo comuni a lettura e scrittura delle sorgenti.

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const splitLines = (text: string): string[] => text.replace(/^﻿/, '').split(/\r\n|\n|\r/);

/** Nome senza virgolette se è un identificatore semplice, altrimenti tra virgolette. */
export const quoteName = (name: string): string => (PLAIN_NAME.test(name) ? name : `"${name}"`);

/** Nome di blocco o tipo: sempre tra virgolette. */
export const quoted = (name: string): string => `"${name}"`;

/** Indice del carattere `ch` fuori da virgolette doppie e apici, -1 se manca. `skip` esclude le posizioni per cui è vero. */
export function indexOutside(
  text: string,
  ch: string,
  skip?: (text: string, i: number) => boolean,
): number {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ch && !skip?.(text, i)) return i;
  }
  return -1;
}

/** Divide una riga in codice e commento `//` (fuori da virgolette e apici). */
export function splitComment(line: string): { code: string; comment?: string } {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '/' && line[i + 1] === '/') {
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() };
    }
  }
  return { code: line };
}

/** Toglie gli attributi tra graffe `{ ... }` di TIA (fuori da virgolette e apici). */
export function stripBraces(code: string): string {
  let out = '';
  let quote = '';
  let depth = 0;
  for (const c of code) {
    if (quote) {
      out += c;
      if (c === quote) quote = '';
    } else if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    } else if (c === '{') depth = 1;
    else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

/** Riga pulita da commento e graffe, senza spazi ai bordi. */
export function cleanLine(line: string): { code: string; comment?: string } {
  const { code, comment } = splitComment(line);
  const cleaned = stripBraces(code).trim();
  return comment === undefined ? { code: cleaned } : { code: cleaned, comment };
}

/** Righe di commento `//` come testo: toglie `//` e un solo spazio. */
export const commentText = (line: string): string => line.slice(2).replace(/^ /, '').trimEnd();

/** Righe di un commento in blocco, ciascuna al margine sinistro. */
export const commentLines = (comment: string): string[] =>
  comment === '' ? [] : comment.split('\n').map((l) => (l === '' ? '//' : `// ${l}`));

/** Segmenti di un percorso come `Asse.Pos."Nome x"[2].Y`; null se non è ben formato. */
export function parsePath(text: string): { name: string; index?: string }[] | null {
  const out: { name: string; index?: string }[] = [];
  let i = 0;
  const t = text.trim();
  for (;;) {
    let name: string;
    if (t[i] === '"') {
      const end = t.indexOf('"', i + 1);
      if (end < 0) return null;
      name = t.slice(i + 1, end);
      i = end + 1;
    } else {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(t.slice(i));
      if (!m) return null;
      name = m[0];
      i += name.length;
    }
    if (name === '') return null;
    const seg: { name: string; index?: string } = { name };
    if (t[i] === '[') {
      const end = t.indexOf(']', i);
      if (end < 0) return null;
      const index = t.slice(i + 1, end).replace(/\s+/g, '');
      if (!/^-?\d+(,-?\d+)*$/.test(index)) return null;
      seg.index = index;
      i = end + 1;
    }
    out.push(seg);
    if (i >= t.length) return out;
    if (t[i] !== '.') return null;
    i++;
  }
}

/** Percorso con i nomi senza virgolette (la forma delle chiavi di `overrides`). */
export const pathKey = (segs: { name: string; index?: string }[]): string =>
  segs.map((s) => `${s.name}${s.index === undefined ? '' : `[${s.index}]`}`).join('.');

/** Chiave di `overrides` (nomi senza virgolette) riscritta con le virgolette dove servono. */
export function quotePathKey(key: string): string {
  return key.replace(/(^|\.)([^.[\]]+)/g, (_, dot: string, name: string) => dot + quoteName(name));
}
