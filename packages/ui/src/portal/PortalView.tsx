import { useTranslation } from 'react-i18next';
import type { IconName } from '../icons';
import { useAppStore, useServices } from '../state/AppContext';
import type { PortalId, StartAction } from '../state/store';
import { targetPlcId } from '../project/navigation/treeIds';
import { ActionList, type ActionItem } from './ActionList';
import { PortalList } from './PortalList';
import { FirstStepsPane } from './selection/FirstStepsPane';
import { InstalledSoftwarePane } from './selection/InstalledSoftwarePane';
import { LanguagePane } from './selection/LanguagePane';
import { NewProjectPane } from './selection/NewProjectPane';
import { OpenProjectPane } from './selection/OpenProjectPane';
import './portal.css';

const START_ACTIONS: { id: StartAction; icon: IconName }[] = [
  { id: 'open', icon: 'actionOpen' },
  { id: 'new', icon: 'actionNew' },
  { id: 'migrate', icon: 'actionMigrate' },
  { id: 'close', icon: 'actionClose' },
  { id: 'firstSteps', icon: 'actionFirstSteps' },
  { id: 'installed', icon: 'actionInstalled' },
  { id: 'help', icon: 'actionHelp' },
  { id: 'language', icon: 'actionLanguage' },
];

/** Operazione propria di ciascun portale diverso da Avvio. */
const OTHER_PORTAL_ACTION: Record<Exclude<PortalId, 'start'>, string> = {
  devices: 'addDevice',
  plc: 'addBlock',
  online: 'accessibleDevices',
};

function SelectionPane({ action }: { action: StartAction }) {
  switch (action) {
    case 'open':
      return <OpenProjectPane />;
    case 'new':
      return <NewProjectPane />;
    case 'firstSteps':
      return <FirstStepsPane />;
    case 'installed':
      return <InstalledSoftwarePane />;
    case 'language':
      return <LanguagePane />;
    default:
      return null;
  }
}

export function PortalView() {
  const { t } = useTranslation();
  const { store, service } = useServices();
  const doc = useAppStore((s) => s.doc);
  const storedPortal = useAppStore((s) => s.portal);
  const startAction = useAppStore((s) => s.startAction);
  const hasPlc = (doc?.project.devices.length ?? 0) > 0;
  const portal: PortalId = doc ? storedPortal : 'start';

  const startItems: ActionItem[] = START_ACTIONS.map(({ id, icon }) => ({
    id,
    icon,
    label: t(`portal.action.${id}`),
    disabled:
      id === 'migrate' || id === 'help' || ((id === 'close' || id === 'firstSteps') && !doc),
  }));
  // Il portale non ha la barra dei menu: la raccolta dati CPU si apre anche da qui.
  startItems.push({ id: 'collectCpu', icon: 'portalOnline', label: t('portal.action.collectCpu') });
  const otherItems: ActionItem[] =
    portal === 'start'
      ? []
      : [
          { id: 'openView', label: t('portal.action.openView') },
          {
            id: OTHER_PORTAL_ACTION[portal],
            label: t(`portal.action.${OTHER_PORTAL_ACTION[portal]}`),
            // I dispositivi accessibili restano per un'altra tappa; un blocco serve un PLC a cui aggiungerlo.
            disabled: portal === 'online' || (portal === 'plc' && !hasPlc),
          },
        ];

  return (
    <div className="baa-portal" data-testid="portal-view">
      <div className="baa-portal-columns">
        <PortalList current={portal} onSelect={(p) => store.getState().setPortal(p)} />
        <ActionList
          items={portal === 'start' ? startItems : otherItems}
          current={portal === 'start' ? startAction : null}
          onSelect={(id) => {
            if (id === 'close') void service.close();
            else if (id === 'collectCpu') store.getState().openDialog({ kind: 'collectKit' });
            else if (portal === 'start') store.getState().setStartAction(id as StartAction);
            else if (id === 'openView') store.getState().setView('project');
            else if (id === 'addDevice') store.getState().openDialog({ kind: 'addDevice' });
            else if (id === 'addBlock') {
              const deviceId = targetPlcId(store.getState());
              if (deviceId) store.getState().openDialog({ kind: 'addBlock', deviceId });
            }
          }}
        />
        <section className="baa-selection-pane" data-testid="selection-pane">
          {portal === 'start' ? <SelectionPane action={startAction} /> : null}
        </section>
      </div>
      <footer className="baa-portal-footer">
        <button
          type="button"
          className="baa-link"
          data-testid="link-project-view"
          onClick={() => store.getState().setView('project')}
        >
          {t('portal.projectView')}
        </button>
        <span className="baa-portal-info" data-testid="open-project-info">
          {doc ? t('portal.openProjectInfo', { path: doc.filePath }) : ''}
        </span>
      </footer>
    </div>
  );
}
