import { useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { Icon } from '../icons';
import '../icons/toolbar';
import { useAppStore, useServices } from '../state/AppContext';
import type { PanelName } from '../state/store';

export interface PanelLayoutProps {
  navigation: ReactNode;
  referenceProjects: ReactNode;
  details: ReactNode;
  workArea: ReactNode;
  inspector: ReactNode;
  taskCards: ReactNode;
}

const TESTID: Record<PanelName, string> = {
  navigation: 'panel-navigation',
  details: 'panel-details',
  inspector: 'panel-inspector',
  taskCards: 'panel-task-cards',
};
/** Dove si trova ciascun pannello: determina freccia, barretta e posizione del pannello a comparsa. */
const EDGE: Record<PanelName, 'left' | 'bottom' | 'right'> = {
  navigation: 'left',
  details: 'left',
  inspector: 'bottom',
  taskCards: 'right',
};
const ARROW = { left: '‹', bottom: '⌄', right: '›' } as const;
const MIN_SIZE = 5;
const MAX_SIZE = 80;

function PanelFrame({ name, children }: { name: PanelName; children: ReactNode }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const pinned = useAppStore((s) => s.panels[name].pinned);
  return (
    <section className="baa-panel" data-testid={TESTID[name]}>
      <header className="baa-panel-header">
        <h2>{t(`panel.${name}`)}</h2>
        <button
          type="button"
          data-testid={`pin-${name}`}
          className="baa-panel-btn"
          aria-pressed={pinned}
          aria-label={pinned ? t('panel.autoHide') : t('panel.pin')}
          title={pinned ? t('panel.autoHide') : t('panel.pin')}
          onClick={() => store.getState().setPanel(name, { pinned: !pinned })}
        >
          <Icon name="pin" size={16} />
        </button>
        <button
          type="button"
          data-testid={`collapse-${name}`}
          className="baa-panel-btn"
          aria-label={t('panel.collapse')}
          title={t('panel.collapse')}
          onClick={() => store.getState().setPanel(name, { open: false })}
        >
          <span aria-hidden="true">{ARROW[EDGE[name]]}</span>
        </button>
      </header>
      <div className="baa-panel-body">{children}</div>
    </section>
  );
}

function Strip({
  name,
  onHover,
  onLeave,
}: {
  name: PanelName;
  onHover(): void;
  onLeave(e: MouseEvent): void;
}) {
  const { t } = useTranslation();
  const { store } = useServices();
  const open = useAppStore((s) => s.panels[name].open);
  return (
    <button
      type="button"
      data-testid={`strip-${name}`}
      className={`baa-strip baa-strip-${EDGE[name]}`}
      title={t('panel.expand')}
      onClick={() => (open ? onHover() : store.getState().setPanel(name, { open: true }))}
      onMouseEnter={() => open && onHover()}
      onMouseLeave={onLeave}
    >
      {t(`panel.${name}`)}
    </button>
  );
}

function ResizeHandle({ id, vertical }: { id: string; vertical?: boolean }) {
  return <Separator data-testid={`splitter-${id}`} className={`baa-splitter ${vertical ? 'baa-splitter-v' : 'baa-splitter-h'}`} />;
}

export function PanelLayout(props: PanelLayoutProps) {
  const { t } = useTranslation();
  const { store } = useServices();
  const panels = useAppStore((s) => s.panels);
  const refOpen = useAppStore((s) => s.referenceProjectsOpen);
  const [flyout, setFlyout] = useState<PanelName | null>(null);

  const docked = (n: PanelName) => panels[n].open && panels[n].pinned;
  const stripped = (n: PanelName) => !docked(n);

  const persist = (names: PanelName[]) => (layout: Layout, meta: { isUserInteraction: boolean }) => {
    if (!meta.isUserInteraction) return;
    for (const n of names) {
      const v = layout[n];
      if (v === undefined) continue;
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(v)));
      if (size !== store.getState().panels[n].size) store.getState().setPanel(n, { size });
    }
  };
  const leaveStrip = (e: MouseEvent) => {
    const to = e.relatedTarget;
    if (!(to instanceof Element && to.closest('[data-flyout]'))) setFlyout(null);
  };
  const strip = (n: PanelName) => (
    <Strip key={n} name={n} onHover={() => setFlyout(n)} onLeave={leaveStrip} />
  );
  const flyoutOf = (n: PanelName, content: ReactNode) =>
    flyout === n && panels[n].open && !panels[n].pinned ? (
      <div data-flyout data-testid={`flyout-${n}`} className={`baa-flyout baa-flyout-${EDGE[n]}`} onMouseLeave={() => setFlyout(null)}>
        <PanelFrame name={n}>{content}</PanelFrame>
      </div>
    ) : null;

  // Se nella colonna sinistra non c'è nulla da mostrare (niente pannelli agganciati e progetti di
  // riferimento chiusi) la colonna non esiste: restano solo le barrette.
  const leftVisible = docked('navigation') || docked('details') || refOpen;
  const leftRail = (['navigation', 'details'] as const).filter(stripped);
  const rightRail = stripped('taskCards');

  return (
    <div className="baa-layout">
      {leftRail.length > 0 || !leftVisible ? (
        <div className="baa-rail baa-rail-left">
          {leftRail.map(strip)}
          {!leftVisible ? (
            <button
              type="button"
              data-testid="strip-reference"
              className="baa-strip baa-strip-left"
              title={t('panel.toggleReference')}
              onClick={() => store.getState().setReferenceProjectsOpen(true)}
            >
              {t('panel.referenceProjects')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="baa-layout-main">
        <Group orientation="horizontal" id="baa-h" onLayoutChanged={persist(['taskCards'])}>
          {leftVisible ? (
            <>
          <Panel id="left" defaultSize="18%" minSize="10%">
            <Group orientation="vertical" id="baa-left" onLayoutChanged={persist(['navigation', 'details'])}>
              {docked('navigation') ? (
                <>
                  <Panel id="navigation" defaultSize={`${panels.navigation.size}%`} minSize="8%">
                    <PanelFrame name="navigation">{props.navigation}</PanelFrame>
                  </Panel>
                  <ResizeHandle id="navigation" vertical />
                </>
              ) : null}
              <Panel id="reference" minSize={refOpen ? '8%' : '26px'} maxSize={refOpen ? '100%' : '26px'}>
                <section className="baa-panel" data-testid="panel-reference-projects">
                  <header className="baa-panel-header">
                    <h2>{t('panel.referenceProjects')}</h2>
                    <button
                      type="button"
                      data-testid="toggle-reference-projects"
                      className="baa-panel-btn"
                      aria-expanded={refOpen}
                      aria-label={t('panel.toggleReference')}
                      title={t('panel.toggleReference')}
                      onClick={() => store.getState().setReferenceProjectsOpen(!refOpen)}
                    >
                      <span aria-hidden="true">{refOpen ? '⌃' : '⌄'}</span>
                    </button>
                  </header>
                  {refOpen ? <div className="baa-panel-body">{props.referenceProjects}</div> : null}
                </section>
              </Panel>
              {docked('details') ? (
                <>
                  <ResizeHandle id="details" vertical />
                  <Panel id="details" defaultSize={`${panels.details.size}%`} minSize="8%">
                    <PanelFrame name="details">{props.details}</PanelFrame>
                  </Panel>
                </>
              ) : null}
            </Group>
          </Panel>
          <ResizeHandle id="left" />
            </>
          ) : null}
          <Panel id="center" minSize="30%">
            <div className="baa-center">
              <Group orientation="vertical" id="baa-center" onLayoutChanged={persist(['inspector'])}>
                <Panel id="work" minSize="20%">
                  <div data-testid="work-area" className="baa-work-area">{props.workArea}</div>
                </Panel>
                {docked('inspector') ? (
                  <>
                    <ResizeHandle id="work" vertical />
                    <Panel id="inspector" defaultSize={`${panels.inspector.size}%`} minSize="8%">
                      <PanelFrame name="inspector">{props.inspector}</PanelFrame>
                    </Panel>
                  </>
                ) : null}
              </Group>
              {stripped('inspector') ? strip('inspector') : null}
            </div>
          </Panel>
          {docked('taskCards') ? (
            <>
              <ResizeHandle id="right" />
              <Panel id="taskCards" defaultSize={`${panels.taskCards.size}%`} minSize="10%">
                <PanelFrame name="taskCards">{props.taskCards}</PanelFrame>
              </Panel>
            </>
          ) : null}
        </Group>
        {flyoutOf('navigation', props.navigation)}
        {flyoutOf('details', props.details)}
        {flyoutOf('inspector', props.inspector)}
        {flyoutOf('taskCards', props.taskCards)}
      </div>
      {rightRail ? <div className="baa-rail baa-rail-right">{strip('taskCards')}</div> : null}
    </div>
  );
}
