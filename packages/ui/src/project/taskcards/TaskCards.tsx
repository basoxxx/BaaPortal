import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import { LadPalette } from '../../editors/lad/LadPalette';
import { useAppStore, useServices } from '../../state/AppContext';
import type { TaskCardId } from '../../state/store';
import { CallStack } from './CallStack';
import { CpuPanel } from './CpuPanel';
import { IoPanel } from './IoPanel';
import { FindReplace } from './FindReplace';

const SECTIONS: Record<TaskCardId, string[]> = {
  instructions: ['favorites', 'basic', 'advanced', 'communication', 'optional'],
  test: ['cpuPanel', 'callStack', 'ioPanel'],
  tasks: ['findReplace'],
  libraries: ['projectLibrary', 'globalLibraries'],
};
const IDS: TaskCardId[] = ['instructions', 'test', 'tasks', 'libraries'];

/** L'editor attivo nel riquadro con il focus è un blocco KOP. */
function useKopActive(): boolean {
  return useAppStore((s) => {
    const wa = s.workArea;
    const key = wa.panes[wa.focusedPane];
    const e = wa.editors.find((x) => x.key === key);
    if (!e || e.kind !== 'block' || !s.doc) return false;
    const b = findDevice(s.doc.project, e.deviceId)?.blocks.find((x) => x.id === e.objectId);
    return b !== undefined && b.kind !== 'DB' && b.kind !== 'IDB' && b.language === 'KOP';
  });
}

function Section({ card, id }: { card: TaskCardId; id: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const kop = useKopActive();
  return (
    <section className="baa-tc-section">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`tc-${card}-${id}`}
          onClick={() => setOpen(!open)}
        >
          {t(`taskcards.section.${card}.${id}`)}
        </button>
      </h3>
      {open && card === 'instructions' && id === 'basic' && kop ? (
        <div id={`tc-${card}-${id}`}>
          <LadPalette />
        </div>
      ) : open && id === 'findReplace' ? (
        <div id={`tc-${card}-${id}`}>
          <FindReplace />
        </div>
      ) : open && id === 'cpuPanel' ? (
        <div id={`tc-${card}-${id}`}>
          <CpuPanel />
        </div>
      ) : open && id === 'callStack' ? (
        <div id={`tc-${card}-${id}`}>
          <CallStack />
        </div>
      ) : open && id === 'ioPanel' ? (
        <div id={`tc-${card}-${id}`}>
          <IoPanel />
        </div>
      ) : open ? (
        <p id={`tc-${card}-${id}`} className="baa-placeholder">
          {t('taskcards.empty')}
        </p>
      ) : null}
    </section>
  );
}

export function TaskCards() {
  const { t } = useTranslation();
  const { store } = useServices();
  const current = useAppStore((s) => s.taskCard);
  return (
    <div className="baa-taskcards">
      <div
        className="baa-tc-body"
        role="tabpanel"
        id="taskcard-panel"
        aria-labelledby={`taskcard-tab-${current}`}
      >
        {SECTIONS[current].map((id) => (
          <Section key={`${current}-${id}`} card={current} id={id} />
        ))}
      </div>
      <div
        role="tablist"
        aria-orientation="vertical"
        className="baa-tc-tabs"
        aria-label={t('panel.taskCards')}
      >
        {IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`taskcard-tab-${id}`}
            data-testid={`taskcard-tab-${id}`}
            aria-selected={current === id}
            aria-controls="taskcard-panel"
            className="baa-tc-tab"
            onClick={() => store.getState().setTaskCard(id)}
          >
            {t(`taskcards.tab.${id}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
