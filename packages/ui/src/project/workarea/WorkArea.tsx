import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useAppStore, useServices } from '../../state/AppContext';
import { EditorFrame } from './EditorFrame';

/** Uno o due riquadri (affiancati o sovrapposti) con l'editor attivo di ciascuno. */
export function WorkArea() {
  const { t } = useTranslation();
  const { store } = useServices();
  const split = useAppStore((s) => s.workArea.split);
  const panes = useAppStore((s) => s.workArea.panes);
  const focused = useAppStore((s) => s.workArea.focusedPane);
  const editors = useAppStore((s) => s.workArea.editors);

  const count = split === 'none' ? 1 : 2;
  const pane = (i: 0 | 1) => {
    const editor = editors.find((e) => e.key === panes[i]);
    return (
      <div
        className={`baa-work-pane${split !== 'none' && focused === i ? ' baa-pane-focused' : ''}`}
        data-testid={`work-pane-${i}`}
        aria-label={t('editor.pane', { n: i + 1 })}
        role="region"
        // In cattura: il riquadro prende il focus anche se l'editor ferma l'evento.
        onMouseDownCapture={() => store.getState().focusPane(i)}
        onFocusCapture={() => store.getState().focusPane(i)}
      >
        {editor ? (
          <EditorFrame editor={editor} />
        ) : (
          <p className="baa-pane-empty">{t('editor.empty')}</p>
        )}
      </div>
    );
  };

  if (count === 1) return pane(0);
  return (
    <Group orientation={split === 'vertical' ? 'horizontal' : 'vertical'} id="baa-work">
      {([0, 1] as const).map((i) => (
        <Fragment key={i}>
          {i === 1 ? (
            <Separator
              data-testid="splitter-panes"
              className={`baa-splitter ${split === 'vertical' ? 'baa-splitter-h' : 'baa-splitter-v'}`}
            />
          ) : null}
          <Panel id={`pane-${i}`} minSize="15%">
            {pane(i)}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
