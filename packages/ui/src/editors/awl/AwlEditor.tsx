import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  autocompletion,
  startCompletion,
  type Completion as CmCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { setDiagnostics } from '@codemirror/lint';
import { type AwlDiagnostic, type Completion, type Mnemonic } from '@baaportal/awl';
import { awlHighlight, displayText, storedText, toLintDiagnostics } from './awlExtensions';
import { CommittedEditor, type CommittedEditorHandle, type EditorCodec } from './CommittedEditor';

export { useMnemonic } from './mnemonicPreference';
export { awlHighlight } from './awlExtensions';

export type AwlEditorHandle = CommittedEditorHandle;

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

const codecOf = (m: Mnemonic): EditorCodec => ({
  key: m,
  toShown: (stored) => displayText(stored, m),
  toStored: (shown, eol) => storedText(shown, m, eol),
});

/** Segmento AWL: l'editor a conferma con evidenziazione, completamento e diagnostiche. */
export function AwlEditor(p: AwlEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const core = useRef<CommittedEditorHandle>(null);
  const latest = useRef(p);
  const tRef = useRef(t);
  useEffect(() => {
    latest.current = p;
    tRef.current = t;
  });
  const codec = useMemo(() => codecOf(p.mnemonic), [p.mnemonic]);

  // Le estensioni si leggono una volta sola; leggono le proprietà attuali da `latest`.
  const extensions = useMemo<Extension[]>(() => {
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
    return [
      awlHighlight(),
      autocompletion({ override: [source], activateOnTyping: false }),
      // Dopo `"`, `#` e `.` si propone il completamento.
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (!u.docChanged) return;
        const typed = u.transactions.some((tr) => tr.isUserEvent('input.type'));
        if (!typed) return;
        let last = '';
        u.changes.iterChanges((_a, _b, _c, _d, ins) => {
          last = ins.toString().slice(-1);
        });
        if (TRIGGERS.has(last))
          queueMicrotask(() => {
            if (core.current?.getView() === u.view) startCompletion(u.view);
          });
      }),
    ];
  }, []);

  useEffect(() => {
    const v = core.current?.getView();
    if (!v) return;
    const msg = (d: AwlDiagnostic) => tRef.current(`awl.diag.${d.code}`, d.params ?? {});
    v.dispatch(setDiagnostics(v.state, toLintDiagnostics(p.diagnostics, v.state.doc.length, msg)));
  }, [p.diagnostics, t]);

  useImperativeHandle(
    p.ref,
    () => ({
      focusAt: (o) => core.current?.focusAt(o),
      getText: () => core.current?.getText() ?? '',
      getView: () => core.current?.getView() ?? null,
    }),
    [],
  );

  return (
    <CommittedEditor
      ref={core}
      value={p.value}
      codec={codec}
      extensions={extensions}
      onCommit={p.onCommit}
      {...(p.onChange ? { onChange: p.onChange } : {})}
      aria-label={p['aria-label']}
    />
  );
}
