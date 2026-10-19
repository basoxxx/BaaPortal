// Dichiarazioni di variabili: `nome : tipo := iniziale; // commento`, con STRUCT annidati.
import { formatType, parseType } from '@baaportal/s7-types';
import type { Member } from '@baaportal/project';
import type { Reader } from './reader';
import { cleanLine, indexOutside, parsePath, pathKey } from './text';

const STRUCT_OPEN = /^(ARRAY\s*\[[^\]]*\]\s*OF\s+)?STRUCT$/i;
const END_STRUCT = /^END_STRUCT\b\s*;?$/i;
const ABSOLUTE_TYPE = /\b(FB|UDT|SFB)\s*(\d+)\b/gi;
const BARE_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** Tipo in forma canonica, oppure null se non valido. `FB 1` / `UDT 1` diventano `"@FB:1"` (risolti all'applicazione). */
export function normalizeType(text: string): string | null {
  let t = text.trim();
  // I riferimenti assoluti fuori da virgolette: il testo tra virgolette resta com'è.
  t = t
    .split(/("[^"]*")/)
    .map((part, n) =>
      n % 2 === 1
        ? part
        : part.replace(
            ABSOLUTE_TYPE,
            (_, kw: string, num: string) => `"@${kw.toUpperCase()}:${num}"`,
          ),
    )
    .join('');
  let parsed = parseType(t);
  if (!parsed.ok && BARE_NAME.test(t)) parsed = parseType(`"${t}"`);
  return parsed.ok ? formatType(parsed.type) : null;
}

function splitNames(text: string): string[] | null {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const comma = indexOutside(rest, ',');
    const piece = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    const path = parsePath(piece);
    if (!path || path.length !== 1 || path[0]!.index !== undefined) return null;
    parts.push(path[0]!.name);
    if (comma < 0) return parts;
    rest = rest.slice(comma + 1);
  }
}

/** Indice di `:` che non fa parte di `:=`. */
const colonAt = (text: string): number => indexOutside(text, ':', (t, i) => t[i + 1] === '=');

const assignAt = (text: string): number => {
  let q = '';
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]!;
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === ':' && text[i + 1] === '=') return i;
  }
  return -1;
};

/**
 * Legge dichiarazioni dalla riga corrente finché `stop` non riconosce una riga; quella riga non si consuma.
 * Le righe vuote, i commenti e le righe tra graffe si saltano.
 */
export function readMembers(r: Reader, stop: (code: string) => boolean): Member[] {
  const out: Member[] = [];
  while (!r.done) {
    const start = r.i;
    const first = cleanLine(r.lines[start]!);
    if (first.code === '') {
      r.i++;
      continue;
    }
    if (stop(first.code)) return out;
    let text = first.code;
    let comment = first.comment;
    r.i++;
    const open = (): boolean => {
      const c = colonAt(text);
      if (c < 0) return false;
      const a = assignAt(text);
      return a < 0 && STRUCT_OPEN.test(text.slice(c + 1).trim());
    };
    const structOpen = open();
    // Un valore iniziale può continuare sulle righe seguenti fino al ';'.
    while (!structOpen && !text.endsWith(';') && assignAt(text) >= 0 && !r.done) {
      const next = cleanLine(r.lines[r.i]!);
      if (next.code === '' || stop(next.code)) break;
      text = `${text} ${next.code}`;
      comment = next.comment ?? comment;
      r.i++;
    }
    const col = r.indent(start);
    const c = colonAt(text);
    if (c < 0) {
      r.error(start, col, 'BAD_DECLARATION');
      continue;
    }
    const names = splitNames(text.slice(0, c));
    if (!names) {
      r.error(start, col, 'BAD_DECLARATION');
      continue;
    }
    if (structOpen) {
      const typeText = text.slice(c + 1).trim();
      const type = normalizeType(typeText);
      const members = readMembers(r, (code) => END_STRUCT.test(code));
      let endComment = comment;
      if (!r.done && END_STRUCT.test(cleanLine(r.lines[r.i]!).code)) {
        endComment = cleanLine(r.lines[r.i]!).comment ?? comment;
        r.i++;
      } else r.error(start, col, 'MISSING_END', { expected: 'END_STRUCT' });
      if (type === null) {
        r.error(start, col, 'BAD_TYPE', { type: typeText });
        continue;
      }
      for (const name of names) {
        const m: Member = {
          id: '',
          name,
          type,
          comment: endComment ?? '',
          members: structuredClone(members),
        };
        out.push(m);
      }
      continue;
    }
    if (!text.endsWith(';')) {
      r.error(start, col, 'BAD_DECLARATION', { reason: 'missing-semicolon' });
      continue;
    }
    const body = text.slice(c + 1, -1);
    const a = assignAt(body);
    const typeText = (a >= 0 ? body.slice(0, a) : body).trim();
    const initial = a >= 0 ? body.slice(a + 2).trim() : undefined;
    const type = normalizeType(typeText);
    if (type === null) {
      r.error(start, col + Math.max(0, text.indexOf(typeText, c)), 'BAD_TYPE', { type: typeText });
      continue;
    }
    for (const name of names) {
      const m: Member = { id: '', name, type, comment: comment ?? '' };
      if (initial !== undefined && initial !== '') m.initial = initial;
      out.push(m);
    }
  }
  return out;
}

/** Applica `percorso := valore` ai membri di un DB globale; restituisce false se il percorso non esiste. */
export function assignToMembers(members: Member[], path: string, value: string): boolean {
  const segs = parsePath(path);
  if (!segs) return false;
  let list = members;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!;
    const key = seg.name.normalize('NFC').toLowerCase();
    const m = list.find((x) => x.name.normalize('NFC').toLowerCase() === key);
    if (!m) return false;
    const rest = segs.slice(k + 1);
    if (rest.length === 0 && seg.index === undefined) {
      m.initial = value;
      return true;
    }
    const parsed = parseType(m.type);
    if (!parsed.ok) return false;
    const isArray = parsed.type.kind === 'array';
    const base = parsed.type.kind === 'array' ? parsed.type.element : parsed.type;
    if (base.kind === 'struct' && !isArray) {
      if (seg.index !== undefined) return false;
      list = m.members ?? [];
      continue;
    }
    if (seg.index !== undefined && !isArray) return false;
    if (seg.index === undefined && isArray) return false;
    const tail = rest.length > 0 ? `.${pathKey(rest)}` : '';
    const ov = seg.index !== undefined ? `[${seg.index}]${tail}` : tail;
    (m.overrides ??= {})[ov] = value;
    return true;
  }
  return false;
}
