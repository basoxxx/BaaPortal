import { useEffect, useImperativeHandle, useRef } from 'react';
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { lineEndingOf } from './awlExtensions';
import './awl.css';

/** Come il testo salvato diventa il testo mostrato e viceversa (mnemonica, a capo). */
export interface EditorCodec {
  /** Cambia quando cambia la conversione (es. la mnemonica): la bozza si conferma prima di passare alla nuova. */
  key: string;
  toShown(stored: string): string;
  toStored(shown: string, eol: '\n' | '\r\n'): string;
}

export interface CommittedEditorHandle {
  /** Porta il cursore (spostamento nel testo mostrato) e il focus, e lo rende visibile. */
  focusAt(offset: number): void;
  /** Seleziona un intervallo del testo mostrato, con il focus, e lo rende visibile. */
  selectRange(from: number, to: number): void;
  /** Il testo mostrato adesso (anche non confermato). */
  getText(): string;
  getView(): EditorView | null;
}

export interface CommittedEditorProps {
  /** Il testo salvato. */
  value: string;
  codec: EditorCodec;
  /** Estensioni aggiuntive; lette una volta sola, alla creazione dell'editor. */
  extensions?: Extension[];
  /** Una sola volta all'uscita dal focus (o alla chiusura), con il testo salvato, solo se è cambiato. */
  onCommit(text: string): void;
  /** Ad ogni modifica del testo mostrato (anche quelle esterne). */
  onChange?(textShown: string): void;
  'aria-label': string;
  /** Sola lettura: il testo si vede e si seleziona ma non si scrive. */
  readOnly?: boolean;
  className?: string;
  ref?: React.Ref<CommittedEditorHandle>;
}

const external = Annotation.define<boolean>();

const lockExtension = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
];

interface Session {
  /** Il testo salvato a cui l'editor si riferisce. */
  baseline: string;
  /** Gli a capo del testo salvato, che la conferma ripristina. */
  eol: '\n' | '\r\n';
  /** La conversione del testo oggi nel documento. */
  codec: EditorCodec;
  /** Modifiche dell'utente non ancora confermate. */
  dirty: boolean;
  focused: boolean;
  /** Valore arrivato da fuori mentre si scriveva. */
  pending: string | null;
}

/**
 * Editor CodeMirror a conferma: una bozza si scrive nel documento e diventa una sola modifica
 * all'uscita dal focus o alla chiusura. Conserva gli a capo del testo salvato e applica subito i
 * valori esterni quando non c'è una bozza.
 */
export function CommittedEditor(p: CommittedEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(p);
  const label = useRef(new Compartment());
  const lock = useRef(new Compartment());
  const s = useRef<Session>({
    baseline: p.value,
    eol: lineEndingOf(p.value),
    codec: p.codec,
    dirty: false,
    focused: false,
    pending: null,
  });
  useEffect(() => {
    latest.current = p;
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
    const shown = v.state.doc.toString();
    // Scritto e poi riportato com'era: nessuna modifica (anche con a capo misti o `\r` isolati).
    if (shown === st.codec.toShown(st.baseline)) return;
    const stored = st.codec.toStored(shown, st.eol);
    if (stored === st.baseline) return;
    st.baseline = stored;
    st.pending = null;
    latest.current.onCommit(stored);
  };

  // L'editor vive quanto il componente; il documento è quello del contenitore (anche una finestra separata).
  useEffect(() => {
    const el = host.current!;
    const st = s.current;
    const view = new EditorView({
      parent: el,
      root: el.ownerDocument,
      state: EditorState.create({
        doc: st.codec.toShown(st.baseline),
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...(latest.current.extensions ?? []),
          lock.current.of(lockExtension(!!latest.current.readOnly)),
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
                replaceDoc(st.codec.toShown(pending));
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
    viewRef.current?.dispatch({ effects: lock.current.reconfigure(lockExtension(!!p.readOnly)) });
  }, [p.readOnly]);

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
    replaceDoc(st.codec.toShown(p.value));
  }, [p.value]);

  // Cambio di conversione: prima si conferma la bozza (con quella di allora), poi si converte la vista.
  useEffect(() => {
    const st = s.current;
    if (p.codec.key === st.codec.key) return;
    commitDraft();
    st.codec = p.codec;
    replaceDoc(p.codec.toShown(st.baseline));
    st.dirty = false;
  }, [p.codec.key]);

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
      selectRange(from: number, to: number) {
        const v = viewRef.current;
        if (!v) return;
        const max = v.state.doc.length;
        const a = Math.min(Math.max(from, 0), max);
        const b = Math.min(Math.max(to, a), max);
        v.focus();
        v.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
        v.dom.scrollIntoView?.({ block: 'nearest' });
      },
      getText: () => viewRef.current?.state.doc.toString() ?? '',
      getView: () => viewRef.current,
    }),
    [],
  );

  return <div ref={host} className={p.className ?? 'baa-awl-editor'} />;
}
