import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView } from '@codemirror/view';
import { awlSpans, type AwlSpan } from '../awl/awlExtensions';
import type { EditorCodec } from '../awl/CommittedEditor';

export type SourceSpanKind = AwlSpan['kind'] | 'keyword';
export interface SourceSpan {
  from: number;
  to: number;
  kind: SourceSpanKind;
}

// Parole che aprono o chiudono una riga della sorgente, in ordine libero di maiuscole.
const LINE_KEYWORDS = new Set([
  'FUNCTION_BLOCK',
  'FUNCTION',
  'ORGANIZATION_BLOCK',
  'DATA_BLOCK',
  'TYPE',
  'END_TYPE',
  'END_FUNCTION_BLOCK',
  'END_FUNCTION',
  'END_ORGANIZATION_BLOCK',
  'END_DATA_BLOCK',
  'VAR_INPUT',
  'VAR_OUTPUT',
  'VAR_IN_OUT',
  'VAR_TEMP',
  'VAR',
  'END_VAR',
  'BEGIN',
  'NETWORK',
  'TITLE',
  'AUTHOR',
  'FAMILY',
  'NAME',
  'VERSION',
  'KNOW_HOW_PROTECT',
  'UNLINKED',
  'READ_ONLY',
  'NON_RETAIN',
  'STRUCT',
  'END_STRUCT',
]);
// Parole che stanno anche in mezzo alla riga (`Pos : Struct`).
const INLINE_KEYWORDS = new Set(['STRUCT', 'END_STRUCT']);
const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Gli intervalli da colorare in una sorgente: parole chiave della sorgente più il codice AWL
 * (istruzioni, indirizzi, simboli, commenti). Le parole chiave dentro commenti e nomi tra virgolette no.
 */
export function sourceSpans(text: string): SourceSpan[] {
  const awl = awlSpans(text);
  const opaque = awl.filter(
    (s) => s.kind === 'comment' || s.kind === 'symbol' || s.kind === 'constant',
  );
  const keywords: SourceSpan[] = [];
  for (const m of text.matchAll(WORD)) {
    const from = m.index!;
    const to = from + m[0].length;
    const upper = m[0].toUpperCase();
    if (!LINE_KEYWORDS.has(upper)) continue;
    if (opaque.some((s) => s.from <= from && from < s.to)) continue;
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const first = text.slice(lineStart, from).trim() === '';
    if (!first && !INLINE_KEYWORDS.has(upper)) continue;
    keywords.push({ from, to, kind: 'keyword' });
  }
  const rest = awl.filter((s) => !keywords.some((k) => s.from < k.to && k.from < s.to));
  return [...rest, ...keywords].sort((a, b) => a.from - b.from || a.to - b.to);
}

function decorate(text: string): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  // Gli intervalli arrivano già in ordine di inizio.
  for (const s of sourceSpans(text)) {
    if (s.to > s.from) b.add(s.from, s.to, Decoration.mark({ class: `baa-awl-${s.kind}` }));
  }
  return b.finish();
}

/** Evidenziazione di una sorgente: classi `baa-awl-<tipo>`, colori in awl.css. */
export function sourceHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view.state.doc.toString());
      }
      update(u: { docChanged: boolean; state: EditorView['state'] }) {
        if (u.docChanged) this.decorations = decorate(u.state.doc.toString());
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Una sorgente è un file: il testo si mostra com'è (nessuna conversione di mnemonica), con a capo LF. */
export const sourceCodec: EditorCodec = {
  key: 'source',
  toShown: (stored) => stored.replace(/\r\n?/g, '\n'),
  toStored: (shown, eol) => (eol === '\n' ? shown : shown.replace(/\n/g, eol)),
};
