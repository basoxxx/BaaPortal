import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { findDevice, findSource } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { CommittedEditor, type CommittedEditorHandle } from '../awl/CommittedEditor';
import { offsetOfLineCol } from '../../project/navigation/sourceActions';
import { sourceCodec, sourceHighlight } from './sourceExtensions';

const EXTENSIONS = [sourceHighlight()];

/** Editor di una sorgente esterna: il testo del file com'è, confermato all'uscita dal focus (un solo `edit`). */
export function SourceEditor({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const source = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined;
    return dev && findSource(dev, editor.objectId);
  });
  const reveal = useAppStore((s) =>
    s.reveal && s.reveal.deviceId === editor.deviceId && s.reveal.sourceId === editor.objectId
      ? s.reveal
      : null,
  );
  const handle = useRef<CommittedEditorHandle>(null);

  // Un clic su un errore apre la sorgente nel punto: la richiesta si esegue una volta sola.
  useEffect(() => {
    if (!reveal || !handle.current) return;
    if (reveal.range) handle.current.selectRange(reveal.range.from, reveal.range.to);
    else handle.current.focusAt(offsetOfLineCol(handle.current.getText(), reveal.line, reveal.col));
    store.getState().clearReveal(reveal.n);
  }, [reveal, store]);

  if (!source) return null;
  const commit = (text: string) =>
    store.getState().edit('history.editSource', (p) => {
      const x = findSource(findDevice(p, editor.deviceId)!, editor.objectId);
      if (x) x.text = text;
    });
  return (
    <div className="baa-source-editor">
      <CommittedEditor
        ref={handle}
        value={source.text}
        codec={sourceCodec}
        extensions={EXTENSIONS}
        onCommit={commit}
        aria-label={t('source.editor', { name: source.name })}
      />
    </div>
  );
}
