import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  autocompletion,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import type { Completion } from '@baaportal/awl';
import { getSettings } from '../../settings/settings';
import { CommittedEditor, type CommittedEditorHandle } from '../awl/CommittedEditor';
import { sourceCodec } from '../source/sourceExtensions';
import { offsetOfLineCol } from '../../project/navigation/sourceActions';
import { sclHighlight, sclLintDiagnostics, type SclProblem } from './sclExtensions';
import { sclMonitorExtension, setSclMonitor, type SclMonitor } from './sclMonitor';

const CHECK_DELAY_MS = 250;
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

export interface SclEditorProps {
  value: string;
  /** Errori del testo mostrato (anche non confermato); si rifà 250 ms dopo l'ultima modifica. */
  check?: (text: string) => SclProblem[];
  complete?: (offset: number, text: string) => { from: number; options: Completion[] };
  onCommit(text: string): void;
  /** Testo mostrato a ogni modifica (anche non confermato). */
  onChange?(text: string): void;
  /** Osservazione del programma: valori a fine riga (`null` o assente: nessuno). */
  monitor?: SclMonitor | null;
  /** Righe visibili (da 1; `0, 0` se nessuna), per la finestra dell'osservazione sulla CPU. */
  onVisibleLines?(first: number, last: number): void;
  'aria-label': string;
  readOnly?: boolean;
  ref?: React.Ref<CommittedEditorHandle>;
}

/** Testo SCL: editor a conferma con evidenziazione, completamento, errori sottolineati ed elenco. */
export function SclEditor(p: SclEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const core = useRef<CommittedEditorHandle>(null);
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });
  const [problems, setProblems] = useState<SclProblem[]>([]);
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? p.value;
  const visible = useRef<[number, number] | null>(null);

  // Il controllo gira 250 ms dopo l'ultima modifica, sul testo mostrato.
  useEffect(() => {
    if (!p.check) return;
    const check = p.check;
    const timer = setTimeout(() => setProblems(check(shown)), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [p.check, shown]);

  useEffect(() => {
    const v = core.current?.getView();
    if (v) v.dispatch(setDiagnostics(v.state, sclLintDiagnostics(v.state.doc, problems)));
  }, [problems]);

  const extensions = useMemo<Extension[]>(() => {
    const source = (c: CompletionContext): CompletionResult | null => {
      const complete = latest.current.complete;
      if (!complete || !getSettings().editor.autocomplete) return null;
      const r = complete(c.pos, c.state.doc.toString());
      if (r.options.length === 0) return null;
      return {
        from: r.from,
        filter: false,
        options: r.options.map((o) => ({
          label: o.label,
          ...(o.detail ? { detail: o.detail } : {}),
          type: CM_TYPE[o.kind],
          apply: o.apply,
        })),
      };
    };
    return [
      sclHighlight(),
      sclMonitorExtension((first, last) => {
        visible.current = [first, last];
        latest.current.onVisibleLines?.(first, last);
      }),
      lintGutter(),
      autocompletion({ override: [source], activateOnTyping: false }),
      // Dopo `"`, `#` e `.` si propone il completamento, come in AWL.
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (!u.docChanged) return;
        if (!u.transactions.some((tr) => tr.isUserEvent('input.type'))) return;
        let last = '';
        u.changes.iterChanges((_a, _b, _c, _d, ins) => {
          last = ins.toString().slice(-1);
        });
        if (TRIGGERS.has(last) && getSettings().editor.autocomplete)
          queueMicrotask(() => {
            if (core.current?.getView() === u.view) startCompletion(u.view);
          });
      }),
    ];
  }, []);

  useEffect(() => {
    core.current?.getView()?.dispatch({ effects: setSclMonitor.of(p.monitor ?? null) });
  }, [p.monitor]);
  // chi arriva dopo (osservazione accesa più tardi) riceve subito le righe visibili
  const onVisible = p.onVisibleLines;
  useEffect(() => {
    if (visible.current) onVisible?.(...visible.current);
  }, [onVisible]);

  useImperativeHandle(
    p.ref,
    () => ({
      focusAt: (o) => core.current?.focusAt(o),
      selectRange: (a, b) => core.current?.selectRange(a, b),
      getText: () => core.current?.getText() ?? '',
      getView: () => core.current?.getView() ?? null,
    }),
    [],
  );

  const goTo = (q: SclProblem) => {
    const h = core.current;
    if (h) h.focusAt(offsetOfLineCol(h.getText(), q.line, q.col));
  };

  return (
    <>
      <CommittedEditor
        ref={core}
        value={p.value}
        codec={sourceCodec}
        extensions={extensions}
        onCommit={p.onCommit}
        onChange={(v) => {
          setText(v);
          p.onChange?.(v);
        }}
        aria-label={p['aria-label']}
        {...(p.readOnly ? { readOnly: true } : {})}
      />
      <ul className="baa-awl-problems" aria-label={t('block.sclProblems')}>
        {problems.map((q, k) => (
          <li key={k}>
            <button type="button" className={`is-${q.severity}`} onClick={() => goTo(q)}>
              {t('block.sclProblemRow', { line: q.line, message: q.message })}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
