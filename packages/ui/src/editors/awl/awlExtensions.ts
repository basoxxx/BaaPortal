import { RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import {
  convertMnemonics,
  findInstruction,
  lex,
  type AwlDiagnostic,
  type Mnemonic,
} from '@baaportal/awl';

export type AwlKind =
  'instruction' | 'address' | 'symbol' | 'local' | 'constant' | 'label' | 'comment' | 'param';

export interface AwlSpan {
  from: number;
  to: number;
  kind: AwlKind;
}

const MAX_MNEMONIC = 6;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

/**
 * Fine dell'istruzione che comincia in `i` (anche scritta con simboli: `=`, `==I`, `+I`, `)`, `A(`),
 * nell'uno o nell'altro mnemonico; -1 se non ce n'è una. Come nel parser: la più lunga, con confine
 * di parola.
 */
function instructionEnd(text: string, i: number): number {
  let t = i;
  while (t < text.length && !/[\s;]/.test(text[t]!) && !text.startsWith('//', t)) t++;
  for (let e = Math.min(t, i + MAX_MNEMONIC); e > i; e--) {
    if (isWordChar(text[e - 1]) && isWordChar(text[e])) continue;
    const word = text.slice(i, e);
    if (findInstruction(word, 'international') || findInstruction(word, 'german')) return e;
  }
  return -1;
}

/**
 * Gli intervalli da colorare, ricavati dai token del lexer (indipendenti dalla mnemonica). Ogni riga
 * si colora da sola: il risultato di un pezzo di righe intere è quello del testo intero.
 */
export function awlSpans(text: string): AwlSpan[] {
  const out: AwlSpan[] = [];
  // Il primo termine di una riga è l'istruzione; il numero subito dopo è una costante ("L 5").
  type Prev = 'start' | 'instruction' | 'other' | 'assign' | 'list';
  let prev = 'start' as Prev;
  // Parentesi aperte dell'elenco dei parametri di un CALL: la ')' che lo chiude non è un'istruzione.
  let depth = 0;
  const tokens = lex(text);
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n]!;
    const from = t.range.from.offset;
    const to = t.range.to.offset;
    let kind: AwlKind | null = null;
    const next = tokens[n + 1];
    if (t.kind === 'punct' && t.text === '(') depth++;
    else if (t.kind === 'punct' && t.text === ')' && depth > 0) {
      depth--;
      prev = 'other';
      continue;
    }
    // Nome di un parametro di CALL: a inizio riga o dopo '(' / ',', seguito da := o =>.
    const isParam =
      (t.kind === 'word' || t.kind === 'symbol') &&
      (prev === 'start' || prev === 'list') &&
      next?.kind === 'punct' &&
      (next.text === ':=' || next.text === '=>');
    if (isParam) {
      out.push({ from, to, kind: 'param' });
      prev = 'other';
      continue;
    }
    if (prev === 'start' && (t.kind === 'word' || t.kind === 'punct')) {
      const end = instructionEnd(text, from);
      if (end > from) {
        out.push({ from, to: end, kind: 'instruction' });
        // I token dentro l'istruzione (`==` e `I`) ne fanno parte.
        while (tokens[n + 1] && tokens[n + 1]!.range.from.offset < end) n++;
        prev = 'instruction';
        continue;
      }
    }
    switch (t.kind) {
      case 'newline':
        prev = 'start';
        continue;
      case 'comment':
        kind = 'comment';
        break;
      case 'label':
        kind = 'label';
        break;
      case 'word':
        kind = prev === 'start' ? 'instruction' : 'address';
        break;
      case 'number':
        kind = prev === 'instruction' || prev === 'assign' ? 'constant' : 'address';
        break;
      case 'literal':
      case 'string':
        kind = 'constant';
        break;
      case 'symbol':
        kind = 'symbol';
        break;
      case 'local':
        kind = 'local';
        break;
      default:
        break;
    }
    if (t.kind !== 'comment' && t.kind !== 'label') {
      prev =
        kind === 'instruction'
          ? 'instruction'
          : t.text === ':=' || t.text === '=>'
            ? 'assign'
            : t.text === '(' || t.text === ','
              ? 'list'
              : 'other';
    }
    if (kind) out.push({ from, to, kind });
  }
  return out;
}

/** Le righe intere che coprono gli intervalli (in ordine), unite quando si toccano. */
export function lineBlocks(
  doc: Text,
  ranges: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const from = doc.lineAt(Math.min(r.from, doc.length)).from;
    const to = doc.lineAt(Math.min(r.to, doc.length)).to;
    const last = out[out.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}

const MARKS = new Map<string, Decoration>();
const mark = (kind: string): Decoration => {
  let d = MARKS.get(kind);
  if (!d) MARKS.set(kind, (d = Decoration.mark({ class: `baa-awl-${kind}` })));
  return d;
};

/** Decorazioni delle sole righe degli intervalli dati (le righe visibili), con `spans` per pezzo. */
export function decorateRanges(
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  spans: (text: string) => readonly { from: number; to: number; kind: string }[],
): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const block of lineBlocks(doc, ranges)) {
    for (const s of spans(doc.sliceString(block.from, block.to))) {
      if (s.to > s.from) b.add(block.from + s.from, block.from + s.to, mark(s.kind));
    }
  }
  return b.finish();
}

/** Le decorazioni AWL delle righe degli intervalli dati. */
export const awlDecorations = (
  doc: Text,
  ranges: readonly { from: number; to: number }[],
): DecorationSet => decorateRanges(doc, ranges, awlSpans);

/**
 * Evidenziazione con `build` sulle sole righe visibili: si rifà quando cambiano il testo o la parte
 * visibile. Classi `baa-awl-<tipo>`, colori in awl.css.
 */
export function visibleHighlight(
  build: (doc: Text, ranges: readonly { from: number; to: number }[]) => DecorationSet,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view.state.doc, view.visibleRanges);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = build(u.state.doc, u.view.visibleRanges);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Evidenziazione dalla grammatica del lexer, sulle righe visibili. */
export function awlHighlight(): Extension {
  return visibleHighlight(awlDecorations);
}

/** Le diagnostiche del segmento come intervalli di CodeMirror, sul testo mostrato. */
export function toLintDiagnostics(
  diagnostics: readonly AwlDiagnostic[],
  docLength: number,
  message: (d: AwlDiagnostic) => string,
): Diagnostic[] {
  return diagnostics.map((d) => {
    const from = Math.min(Math.max(d.range.from.offset, 0), docLength);
    let to = Math.min(Math.max(d.range.to.offset, from), docLength);
    // Un intervallo vuoto non si vedrebbe: si sottolinea almeno un carattere.
    if (to === from) to = Math.min(from + 1, docLength);
    return {
      from: Math.min(from, to),
      to,
      severity: d.severity,
      message: message(d),
      source: d.code,
    };
  });
}

/** Il testo salvato (internazionale) come lo mostra l'editor: mnemonica scelta, a capo sempre `\n`. */
export function displayText(stored: string, m: Mnemonic): string {
  return convertMnemonics(stored, 'international', m).replace(/\r\n?/g, '\n');
}

/** I segmenti salvati con CRLF lo conservano; gli altri restano con LF. */
export function lineEndingOf(stored: string): '\n' | '\r\n' {
  return stored.includes('\r\n') ? '\r\n' : '\n';
}

/** Dal testo dell'editor (LF) al testo salvato: mnemonica internazionale e a capo originale. */
export function storedText(shownText: string, m: Mnemonic, eol: '\n' | '\r\n'): string {
  const stored = convertMnemonics(shownText, m, 'international');
  return eol === '\n' ? stored : stored.replace(/\n/g, eol);
}
