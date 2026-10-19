import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView } from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import { convertMnemonics, lex, type AwlDiagnostic, type Mnemonic } from '@baaportal/awl';

export type AwlKind =
  'instruction' | 'address' | 'symbol' | 'local' | 'constant' | 'label' | 'comment';

export interface AwlSpan {
  from: number;
  to: number;
  kind: AwlKind;
}

/** Gli intervalli da colorare, ricavati dai token del lexer (indipendenti dalla mnemonica). */
export function awlSpans(text: string): AwlSpan[] {
  const out: AwlSpan[] = [];
  // Il primo termine di una riga è l'istruzione; il numero subito dopo è una costante ("L 5").
  type Prev = 'start' | 'instruction' | 'other' | 'assign';
  let prev = 'start' as Prev;
  for (const t of lex(text)) {
    const from = t.range.from.offset;
    const to = t.range.to.offset;
    let kind: AwlKind | null = null;
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
      prev = kind === 'instruction' ? 'instruction' : t.text === ':=' ? 'assign' : 'other';
    }
    if (kind) out.push({ from, to, kind });
  }
  return out;
}

function decorate(text: string): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const s of awlSpans(text)) {
    if (s.to > s.from) b.add(s.from, s.to, Decoration.mark({ class: `baa-awl-${s.kind}` }));
  }
  return b.finish();
}

/** Evidenziazione dalla grammatica del lexer: classi `baa-awl-<tipo>`, colori in awl.css. */
export function awlHighlight(): Extension {
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
