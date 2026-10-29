// Editor SCL: evidenziazione dai token del lexer SCL, completamento con i nomi del contesto AWL
// (stesse liste del completamento AWL) e diagnostiche del traduttore e del controllo AWL.
import type { Extension, Text } from '@codemirror/state';
import type { Diagnostic } from '@codemirror/lint';
import {
  checkBlockCode,
  completeOperand,
  type AwlBlockInfo,
  type AwlContext,
  type Completion,
} from '@baaportal/awl';
import { KEYWORDS, lex, sclToAwl, type Tok } from '@baaportal/scl';
import type { TypedMember } from '@baaportal/s7-types';
import { decorateRanges, visibleHighlight } from '../awl/awlExtensions';

export type SclKind =
  | 'keyword'
  | 'type'
  | 'operator'
  | 'constant'
  | 'comment'
  | 'local'
  | 'symbol'
  | 'address'
  | 'param';
export interface SclSpan {
  from: number;
  to: number;
  kind: SclKind;
}

/** Tipi e funzioni di conversione: `INT`, `INT_TO_DINT`, `ROUND`… */
const TYPE_WORD =
  /^(?:BOOL|BYTE|WORD|DWORD|INT|DINT|REAL|TIME|S5TIME|DATE|CHAR|STRING|ROUND|TRUNC|[A-Z]+_TO_[A-Z]+)$/i;
const KIND: Partial<Record<Tok['kind'], SclKind>> = {
  comment: 'comment',
  local: 'local',
  symbol: 'symbol',
  addr: 'address',
  int: 'constant',
  real: 'constant',
  string: 'constant',
  op: 'operator',
};

/** Gli intervalli da colorare: tutto il testo, perché un commento `(* *)` può andare a capo. */
export function sclSpans(text: string): SclSpan[] {
  const toks = lex(text, { errors: [], comments: true });
  const out: SclSpan[] = [];
  let depth = 0;
  toks.forEach((t, n) => {
    if (t.kind === 'eof') return;
    if (t.text === '(') depth++;
    if (t.text === ')') depth = Math.max(0, depth - 1);
    const up = t.text.toUpperCase();
    const next = toks[n + 1]?.text;
    let kind = KIND[t.kind];
    if (t.kind === 'kw') kind = up === 'TRUE' || up === 'FALSE' ? 'constant' : 'keyword';
    // un parametro per nome dentro una chiamata: `(in := …`
    else if (t.kind === 'id' && depth > 0 && (next === ':=' || next === '=>')) kind = 'param';
    else if (t.kind === 'id' && TYPE_WORD.test(t.text)) kind = 'type';
    if (kind) out.push({ from: t.from, to: t.from + t.text.length, kind });
  });
  return out;
}

/** Evidenziazione SCL: classi `baa-awl-<tipo>` (colori dai token di awl.css). */
export function sclHighlight(): Extension {
  return visibleHighlight((doc: Text) =>
    decorateRanges(doc, [{ from: 0, to: doc.length }], sclSpans),
  );
}

export interface SclProblem {
  /** Da 1. */
  line: number;
  /** Da 1. */
  col: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/**
 * Gli errori del testo SCL (anche non confermato): quelli del traduttore; se non ce ne sono,
 * quelli del controllo AWL sull'AWL generato, alla riga SCL che ha prodotto la riga AWL.
 */
export function sclProblems(
  text: string,
  ctx: AwlContext,
  tempEnd: number,
  awlMessage: (d: ReturnType<typeof checkBlockCode>[number]) => string,
): SclProblem[] {
  const r = sclToAwl(text, ctx, tempEnd);
  if (r.diagnostics.length) return r.diagnostics.map((d) => ({ ...d, severity: 'error' }));
  return checkBlockCode([r.source], ctx, 'international').map((d) => ({
    line: r.lines.filter((l) => l.line <= d.range.from.line).at(-1)?.sclLine ?? 1,
    col: 1,
    severity: d.severity,
    message: awlMessage(d),
  }));
}

/** Le diagnostiche sul documento: dalla colonna alla fine della parola (almeno un carattere). */
export function sclLintDiagnostics(doc: Text, problems: readonly SclProblem[]): Diagnostic[] {
  return problems.map((p) => {
    const line = doc.line(Math.min(Math.max(p.line, 1), doc.lines));
    const from = Math.min(line.from + Math.max(p.col - 1, 0), line.to);
    const word = /^(?:"[^"\n]*"?|#?[A-Za-z0-9_]+)/.exec(doc.sliceString(from, line.to))?.[0];
    const to = Math.min(from + Math.max(word?.length ?? 1, 1), doc.length);
    return { from, to: Math.max(to, from), severity: p.severity, message: p.message };
  });
}

/** Inizio dell'operando che si sta scrivendo nella riga `s` (nomi tra virgolette compresi). */
function operandStart(s: string): number {
  let i = s.length;
  // virgolette dispari: il cursore è dentro un nome che si sta scrivendo
  if ((s.match(/"/g)?.length ?? 0) % 2 === 1) i = s.lastIndexOf('"');
  while (i > 0) {
    const c = s[i - 1]!;
    if (c === '"') i = s.lastIndexOf('"', i - 2);
    else if (/[A-Za-z0-9_#.[\]]/.test(c)) i--;
    else break;
    if (i < 0) return 0;
  }
  return i;
}

/** I parametri di una chiamata: `"Fc"(in := , out => )`. */
function callSnippet(name: string, b: AwlBlockInfo): string {
  const i = b.iface;
  const of = (ms: readonly TypedMember[], arrow: string) => ms.map((m) => `${m.name} ${arrow} `);
  const params = i ? [...of(i.input, ':='), ...of(i.inOut, ':='), ...of(i.output, '=>')] : [];
  return `"${name}"(${params.join(', ')})`;
}

/** Chiamate possibili: le FC e SFC, e le FB tramite i loro DB di istanza. */
function callOptions(ctx: AwlContext): Completion[] {
  return ctx.allBlocks().flatMap((b): Completion[] => {
    if (b.kind === 'FC' || b.kind === 'SFC')
      return [
        {
          label: `${b.name}(…)`,
          kind: 'block',
          detail: `${b.kind} ${b.number}`,
          apply: callSnippet(b.name, b),
        },
      ];
    if (b.kind !== 'IDB' || !b.instanceOf) return [];
    const fb = ctx.block({ name: b.instanceOf });
    return fb
      ? [
          {
            label: `${b.name}(…)`,
            kind: 'block',
            detail: `${fb.kind} ${fb.number}`,
            apply: callSnippet(b.name, fb),
          },
        ]
      : [];
  });
}

const norm = (s: string) => s.toLowerCase();

/**
 * Completamento SCL in `offset`: variabili dell'interfaccia (con o senza `#`), tag e DB (`"…"`),
 * membri dopo `"DB".` e `#s.`, chiamate di blocchi con i loro parametri, parole chiave.
 */
export function sclComplete(
  text: string,
  offset: number,
  ctx: AwlContext,
): { from: number; options: Completion[] } {
  const none = { from: offset, options: [] };
  // Dentro un commento o una stringa non si propone niente.
  const last = lex(text.slice(0, offset), { errors: [], comments: true }).at(-2);
  if (last && last.from + last.text.length >= offset) {
    if (last.kind === 'comment' && !last.text.endsWith('*)')) return none;
    if (last.kind === 'string' && !(last.text.length > 1 && last.text.endsWith("'"))) return none;
  }
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const s = text.slice(lineStart, offset);
  const start = operandStart(s);
  const op = s.slice(start);
  const base = lineStart + start;
  if (/^\d/.test(op)) return none;
  const r = completeOperand(ctx, op, base);
  // Un nome scritto senza `#` o virgolette: anche variabili locali, chiamate e parole chiave.
  if (/^[A-Za-z_]?[A-Za-z0-9_]*$/.test(op)) {
    const locals = completeOperand(ctx, `#${op}`, base - 1).options;
    const words = [...KEYWORDS]
      .filter((k) => op !== '' && norm(k).startsWith(norm(op)))
      .map((k): Completion => ({ label: k, kind: 'instruction', apply: k }));
    const calls = callOptions(ctx).filter((o) => norm(o.label).startsWith(norm(op)));
    return { from: base, options: [...locals, ...r.options, ...calls, ...words] };
  }
  if (/^"[^"]*$/.test(op)) {
    const calls = callOptions(ctx).filter((o) => norm(o.label).startsWith(norm(op.slice(1))));
    return { from: r.from, options: [...r.options, ...calls] };
  }
  return r;
}
