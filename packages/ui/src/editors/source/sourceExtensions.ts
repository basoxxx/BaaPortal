import type { Extension, Text } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { awlSpans, decorateRanges, visibleHighlight, type AwlSpan } from '../awl/awlExtensions';
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
 * Lineare: le due liste sono in ordine e si scorrono una volta; ogni riga si colora da sola.
 */
export function sourceSpans(text: string): SourceSpan[] {
  const awl = awlSpans(text);
  const opaque = awl.filter(
    (s) => s.kind === 'comment' || s.kind === 'symbol' || s.kind === 'constant',
  );
  const keywords: SourceSpan[] = [];
  let o = 0;
  for (const m of text.matchAll(WORD)) {
    const from = m.index;
    const to = from + m[0].length;
    const upper = m[0].toUpperCase();
    if (!LINE_KEYWORDS.has(upper)) continue;
    while (o < opaque.length && opaque[o]!.to <= from) o++;
    if (o < opaque.length && opaque[o]!.from <= from) continue;
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const first = text.slice(lineStart, from).trim() === '';
    if (!first && !INLINE_KEYWORDS.has(upper)) continue;
    keywords.push({ from, to, kind: 'keyword' });
  }
  // Unione delle due liste ordinate; gli intervalli AWL coperti da una parola chiave cedono.
  const out: SourceSpan[] = [];
  let k = 0;
  for (const s of awl) {
    while (k < keywords.length && keywords[k]!.from < s.from) out.push(keywords[k++]!);
    let j = k;
    while (j < keywords.length && keywords[j]!.to <= s.from) j++;
    if (j < keywords.length && keywords[j]!.from < s.to) continue;
    out.push(s);
  }
  while (k < keywords.length) out.push(keywords[k++]!);
  return out;
}

/** Le decorazioni della sorgente nelle righe degli intervalli dati (le righe visibili). */
export const sourceDecorations = (
  doc: Text,
  ranges: readonly { from: number; to: number }[],
): DecorationSet => decorateRanges(doc, ranges, sourceSpans);

/** Evidenziazione di una sorgente, sulle righe visibili: classi `baa-awl-<tipo>`, colori in awl.css. */
export function sourceHighlight(): Extension {
  return visibleHighlight(sourceDecorations);
}

/** Una sorgente è un file: il testo si mostra com'è (nessuna conversione di mnemonica), con a capo LF. */
export const sourceCodec: EditorCodec = {
  key: 'source',
  toShown: (stored) => stored.replace(/\r\n?/g, '\n'),
  toStored: (shown, eol) => (eol === '\n' ? shown : shown.replace(/\n/g, eol)),
};
