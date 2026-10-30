// Sorgente SCL di STEP 7 V5.5: intestazione e dichiarazioni come la sorgente AWL, corpo come testo SCL.
import type { PlcDevice } from '@baaportal/project';
import { parseAwlSource } from '../awlSource/parse';
import { cleanLine, splitLines } from '../awlSource/text';
import type { ParsedSource, SourceError } from '../awlSource/types';

const CODE_START = /^(ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION)\b/i;
const ANY_START = /^(TYPE|ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK)\b/i;
const MOVED_SECTION = /^(CONST|LABEL)\b/i;

/** Avvisi della lettura SCL: il testo non si perde, ma va dove il modello lo può tenere. */
export const SCL_WARNING_CODES = ['SCL_SECTION_MOVED'] as const;

/**
 * Commenti `(* … *)` (anche su più righe) riscritti come `//` in fondo alla riga, come li legge la
 * sorgente AWL; una riga di solo commento resta al margine (commento del blocco nell'intestazione).
 */
function lineComments(lines: string[]): string[] {
  let open = false;
  return lines.map((line) => {
    let code = '';
    let comment = '';
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (open) {
        if (c === '*' && line[i + 1] === ')') {
          open = false;
          i++;
        } else comment += c;
      } else if (quote) {
        code += c;
        if (c === quote) quote = '';
      } else if (c === '(' && line[i + 1] === '*') {
        open = true;
        i++;
      } else if (c === '/' && line[i + 1] === '/') {
        comment += line.slice(i + 2);
        break;
      } else {
        if (c === '"' || c === "'") quote = c;
        code += c;
      }
    }
    const text = comment.trim();
    if (text === '') return code.trimEnd();
    return code.trim() === '' ? `// ${text}` : `${code.trimEnd()} // ${text}`;
  });
}

/** Toglie gli spazi iniziali comuni e le righe vuote ai bordi. */
function dedent(lines: string[]): string {
  const body = [...lines];
  while (body.length > 0 && body[0]!.trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  const indent = Math.min(
    ...body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
  );
  return body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join('\n');
}

const unquote = (v: string): string => {
  const t = v.trim();
  return t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t;
};

/**
 * Legge una sorgente SCL di STEP 7 (FUNCTION, FUNCTION_BLOCK, ORGANIZATION_BLOCK, DATA_BLOCK, TYPE).
 * Intestazione, sezioni VAR, UDT e DB si leggono come nella sorgente AWL; il corpo fra BEGIN e la fine
 * del blocco diventa il testo del blocco SCL così com'è, anche con costrutti che BaaPortal non
 * compila (li segnala la compilazione). Le sezioni CONST e LABEL, che il modello non ha, finiscono
 * come commento in testa al corpo, con un avviso. Gli errori hanno le righe del file.
 */
export function parseSclSource(
  text: string,
  device?: PlcDevice,
):
  | { ok: true; source: ParsedSource; warnings: SourceError[] }
  | { ok: false; errors: SourceError[] } {
  const raw = splitLines(text);
  const lines = lineComments(raw);
  const masked = [...lines];
  const bodies: string[] = [];
  const warnings: SourceError[] = [];
  /** Righe di commento fuori dalle unità: vanno nel commento dell'unità seguente. */
  const leading: string[][] = [];
  let pending: string[] = [];
  let unit: string | null = null;
  let inCode: string | null = null;
  let moved: string[] = [];
  let hadBody = false;
  for (let i = 0; i < lines.length; i++) {
    const code = cleanLine(lines[i]!).code;
    if (unit === null) {
      const start = ANY_START.exec(code);
      if (start && !/^\w+\s*(:=|\.|\[)/.test(code)) {
        unit = start[1]!.toUpperCase();
        inCode = CODE_START.test(code) ? unit : null;
        moved = [];
        hadBody = false;
        leading.push(pending);
        pending = [];
      } else if (code === '' && lines[i]!.startsWith('//')) {
        pending.push(lines[i]!.slice(2).trim());
        masked[i] = '';
      }
      continue;
    }
    if (inCode === null) {
      if (new RegExp(`^END_${unit}\\b`, 'i').test(code)) unit = null;
      continue;
    }
    const end = new RegExp(`^END_${inCode}\\b`, 'i');
    const section = MOVED_SECTION.exec(code);
    if (section) {
      const close = new RegExp(`^END_${section[1]!.toUpperCase()}\\b`, 'i');
      warnings.push({
        line: i + 1,
        col: 1,
        code: 'SCL_SECTION_MOVED',
        params: { section: section[1]!.toUpperCase() },
      });
      let j = i;
      // Fino a END_CONST/END_LABEL; senza, ci si ferma prima della fine del blocco.
      for (; j < lines.length; j++) {
        const c = cleanLine(lines[j]!).code;
        if (j > i && (end.test(c) || ANY_START.test(c))) {
          j--;
          break;
        }
        moved.push(raw[j]!);
        masked[j] = '';
        if (close.test(c)) break;
      }
      i = j;
      continue;
    }
    if (/^BEGIN$/i.test(code)) {
      let j = i + 1;
      while (j < lines.length && !end.test(cleanLine(lines[j]!).code)) j++;
      const body = dedent(raw.slice(i + 1, j));
      const head = moved.map((l) => `// ${l.trim()}`).join('\n');
      bodies.push(head === '' ? body : body === '' ? head : `${head}\n${body}`);
      hadBody = true;
      for (let k = i + 1; k < j; k++) masked[k] = '';
      i = j - 1;
      continue;
    }
    if (end.test(code)) {
      // Blocco senza BEGIN: il corpo è vuoto (o le sole sezioni spostate).
      if (!hadBody) bodies.push(moved.map((l) => `// ${l.trim()}`).join('\n'));
      inCode = null;
      unit = null;
    }
  }
  const parsed = parseAwlSource(masked.join('\n'), device);
  if (!parsed.ok) return parsed;
  let n = 0;
  parsed.source.units.forEach((u, at) => {
    const header =
      u.kind === 'UDT'
        ? u.udt
        : u.kind === 'IDB'
          ? u.header
          : u.kind === 'DB'
            ? u.db.header
            : u.block.header;
    const before = leading[at] ?? [];
    if (before.length > 0) {
      header.comment = [...before, ...(header.comment === '' ? [] : [header.comment])].join('\n');
    }
    header.title = unquote(header.title);
    header.version = unquote(header.version);
    header.author = unquote(header.author);
    header.family = unquote(header.family);
    header.headerName = unquote(header.headerName);
    if (u.kind !== 'OB' && u.kind !== 'FB' && u.kind !== 'FC') return;
    u.block.language = 'SCL';
    u.block.networks = [{ id: '', title: '', comment: '', source: bodies[n++] ?? '' }];
  });
  return { ok: true, source: parsed.source, warnings };
}
