import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, useServices } from '../../state/AppContext';
import type { TaskCardId } from '../../state/store';
import { CallStack } from './CallStack';
import { CpuPanel } from './CpuPanel';
import { FindReplace } from './FindReplace';

const SECTIONS: Record<TaskCardId, string[]> = {
  instructions: ['favorites', 'basic', 'advanced', 'communication', 'optional'],
  test: ['cpuPanel', 'callStack'],
  tasks: ['findReplace'],
  libraries: ['projectLibrary', 'globalLibraries'],
};
const IDS: TaskCardId[] = ['instructions', 'test', 'tasks', 'libraries'];

function Section({ card, id }: { card: TaskCardId; id: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
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
      {open && id === 'findReplace' ? (
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
