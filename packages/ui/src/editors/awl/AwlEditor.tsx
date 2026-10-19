import { useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  autocompletion,
  startCompletion,
  type Completion as CmCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { setDiagnostics } from '@codemirror/lint';
import { type AwlDiagnostic, type Completion, type Mnemonic } from '@baaportal/awl';
import {
  awlHighlight,
  displayText,
  lineEndingOf,
  storedText,
  toLintDiagnostics,
} from './awlExtensions';
import './awl.css';

export { useMnemonic } from './mnemonicPreference';
export { awlHighlight } from './awlExtensions';

export interface AwlEditorHandle {
  /** Porta il cursore (spostamento nel testo mostrato) e il focus, e lo rende visibile. */
  focusAt(offset: number): void;
}

export interface AwlEditorProps {
  /** Il testo salvato, in mnemonica internazionale. */
  value: string;
  /** La mnemonica con cui il testo viene mostrato e scritto. */
  mnemonic: Mnemonic;
  /** Diagnostiche del segmento, con intervalli sul testo mostrato. */
  diagnostics: readonly AwlDiagnostic[];
  /** Completamento sul testo mostrato; `text` è il testo attuale dell'editor (anche non confermato). */
  complete: (offset: number, text: string) => { from: number; options: Completion[] };
  /** Una sola volta all'uscita dal focus (o alla chiusura), con il testo in internazionale, solo se è cambiato. */
  onCommit(text: string): void;
  /** Ad ogni modifica del testo mostrato (anche quelle esterne). */
  onChange?(textShown: string): void;
  'aria-label': string;
  ref?: React.Ref<AwlEditorHandle>;
}

const external = Annotation.define<boolean>();
const TRIGGERS = new Set(['"', '#', '.']);

const CM_TYPE: Record<Completion['kind'], string> = {
  instruction: 'keyword',
  tag: 'variable',
  constant: 'constant',
  local: 'variable',
  member: 'property',
  block: 'function',
  label: 'label',
  param: 'property',
};

interface Session {
  /** Il testo salvato (internazionale) a cui l'editor si riferisce. */
  baseline: string;
  /** Gli a capo del testo salvato, che la conferma ripristina. */
  eol: '\n' | '\r\n';
  /** La mnemonica del testo oggi nel documento. */
  shown: Mnemonic;
  /** Modifiche dell'utente non ancora confermate. */
  dirty: boolean;
  focused: boolean;
  /** Valore arrivato da fuori mentre si scriveva. */
  pending: string | null;
}

export function AwlEditor(p: AwlEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(p);
  const tRef = useRef(t);
  const label = useRef(new Compartment());
  const s = useRef<Session>({
    baseline: p.value,
    eol: lineEndingOf(p.value),
    shown: p.mnemonic,
    dirty: false,
    focused: false,
    pending: null,
  });
  useEffect(() => {
    latest.current = p;
    tRef.current = t;
  });

  const replaceDoc = (text: string) => {
    const v = viewRef.current;
    if (!v || v.state.doc.toString() === text) return;
    const head = Math.min(v.state.selection.main.head, text.length);
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: { anchor: head },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  };

  const commitDraft = () => {
    const v = viewRef.current;
    const st = s.current;
    if (!v || !st.dirty) return;
    st.dirty = false;
    const stored = storedText(v.state.doc.toString(), st.shown, st.eol);
    if (stored === st.baseline) return;
    st.baseline = stored;
    st.pending = null;
    latest.current.onCommit(stored);
  };

  // L'editor vive quanto il componente; il documento è quello del contenitore (anche una finestra separata).
  useEffect(() => {
    const el = host.current!;
    const st = s.current;
    const source = (c: CompletionContext): CompletionResult | null => {
      const r = latest.current.complete(c.pos, c.state.doc.toString());
      if (r.options.length === 0) return null;
      return {
        from: r.from,
        filter: false,
        options: r.options.map((o): CmCompletion => ({
          label: o.label,
          ...(o.detail ? { detail: o.detail } : {}),
          type: CM_TYPE[o.kind],
          apply: (view, _c, _from, to) =>
            view.dispatch({
              changes: { from: r.from, to, insert: o.apply },
              selection: { anchor: r.from + o.apply.length },
              userEvent: 'input.complete',
            }),
        })),
      };
    };
    const view = new EditorView({
      parent: el,
      root: el.ownerDocument,
      state: EditorState.create({
        doc: displayText(st.baseline, st.shown),
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          awlHighlight(),
          autocompletion({ override: [source], activateOnTyping: false }),
          label.current.of(
            EditorView.contentAttributes.of({
              role: 'textbox',
              'aria-multiline': 'true',
              'aria-label': latest.current['aria-label'],
            }),
          ),
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (!u.docChanged) return;
            const isExternal = u.transactions.some((tr) => tr.annotation(external));
            if (!isExternal) st.dirty = true;
            latest.current.onChange?.(u.state.doc.toString());
            // Dopo `"`, `#` e `.` si propone il completamento.
            const typed = u.transactions.some((tr) => tr.isUserEvent('input.type'));
            if (typed) {
              let last = '';
              u.changes.iterChanges((_a, _b, _c, _d, ins) => {
                last = ins.toString().slice(-1);
              });
              if (TRIGGERS.has(last))
                queueMicrotask(() => {
                  if (viewRef.current === view) startCompletion(view);
                });
            }
          }),
          EditorView.domEventHandlers({
            focus: () => {
              st.focused = true;
            },
            blur: () => {
              st.focused = false;
              commitDraft();
              const pending = st.pending;
              st.pending = null;
              if (pending !== null && pending !== st.baseline) {
                st.baseline = pending;
                st.eol = lineEndingOf(pending);
                replaceDoc(displayText(pending, st.shown));
                st.dirty = false;
              }
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      // Una bozza ancora nell'editor (scheda chiusa, blocco tolto, linguaggio cambiato) non si perde.
      commitDraft();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: label.current.reconfigure(
        EditorView.contentAttributes.of({
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': p['aria-label'],
        }),
      ),
    });
  }, [p['aria-label']]);

  // Valore dal progetto (annulla, ripeti, rinomina nel codice, incolla): sul testo che si sta scrivendo non si scrive.
  useEffect(() => {
    const st = s.current;
    if (p.value === st.baseline) {
      st.pending = null;
      return;
    }
    // Chi sta scrivendo non perde il testo; se non ha scritto nulla il valore nuovo si vede subito.
    if (st.focused && st.dirty) {
      st.pending = p.value;
      return;
    }
    st.pending = null;
    st.baseline = p.value;
    st.eol = lineEndingOf(p.value);
    st.dirty = false;
    replaceDoc(displayText(p.value, st.shown));
  }, [p.value]);

  // Cambio di mnemonica: prima si conferma la bozza (con la mnemonica di allora), poi si converte la vista.
  useEffect(() => {
    const st = s.current;
    if (p.mnemonic === st.shown) return;
    commitDraft();
    st.shown = p.mnemonic;
    replaceDoc(displayText(st.baseline, p.mnemonic));
    st.dirty = false;
  }, [p.mnemonic]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const msg = (d: AwlDiagnostic) => tRef.current(`awl.diag.${d.code}`, d.params ?? {});
    v.dispatch(setDiagnostics(v.state, toLintDiagnostics(p.diagnostics, v.state.doc.length, msg)));
  }, [p.diagnostics, t]);

  useImperativeHandle(
    p.ref,
    () => ({
      focusAt(offset: number) {
        const v = viewRef.current;
        if (!v) return;
        const at = Math.min(Math.max(offset, 0), v.state.doc.length);
        v.focus();
        v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
        v.dom.scrollIntoView?.({ block: 'nearest' });
      },
    }),
    [],
  );

  return <div ref={host} className="baa-awl-editor" />;
}
