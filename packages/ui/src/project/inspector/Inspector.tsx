import { useTranslation } from 'react-i18next';
import { useAppStore, useServices } from '../../state/AppContext';
import type { InfoSubTab, InspectorTab } from '../../state/store';
import { CompileMessages } from '../compile/CompileMessages';
import { InfoMessages } from './InfoMessages';
import { parseNodeId } from '../navigation/treeIds';
import { ProjectProperties } from './ProjectProperties';
import { BlockProperties } from './properties/BlockProperties';
import { PlcProperties } from './properties/PlcProperties';
import { TagTableProperties } from './properties/TagTableProperties';
import { UdtProperties } from './properties/UdtProperties';

const TABS: InspectorTab[] = ['properties', 'info', 'diagnostics'];
const SUBTABS: InfoSubTab[] = ['general', 'crossRefs', 'compile'];

/** Il pannello delle proprietà dipende dal nodo selezionato. */
function Properties() {
  const { t } = useTranslation();
  const selection = useAppStore((s) => s.selection);
  if (selection === 'project') return <ProjectProperties />;
  const node = selection ? parseNodeId(selection) : null;
  switch (node?.kind) {
    case 'plc':
      return <PlcProperties deviceId={node.dev} />;
    case 'block':
      return <BlockProperties deviceId={node.dev} blockId={node.id} />;
    case 'udt':
      return <UdtProperties deviceId={node.dev} udtId={node.id} />;
    case 'tagTable':
      return <TagTableProperties deviceId={node.dev} tableId={node.id} />;
    default:
      return <p className="baa-placeholder">{t('inspector.noProperties')}</p>;
  }
}

export function Inspector() {
  const { t } = useTranslation();
  const { store } = useServices();
  const tab = useAppStore((s) => s.inspectorTab);
  const setTab = (id: InspectorTab) => store.getState().setInspectorTab(id);
  const sub = useAppStore((s) => s.infoSubTab);
  const setSub = (id: InfoSubTab) => store.getState().setInfoSubTab(id);
  return (
    <div className="baa-inspector">
      <div role="tablist" className="baa-tabs" aria-label={t('panel.inspector')}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`inspector-tab-${id}`}
            data-testid={`inspector-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="inspector-panel"
            className="baa-tab"
            onClick={() => setTab(id)}
          >
            {t(`inspector.tab.${id}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="inspector-panel"
        aria-labelledby={`inspector-tab-${tab}`}
        className="baa-tabpanel"
      >
        {tab === 'properties' ? <Properties /> : null}
        {tab === 'diagnostics' ? (
          <p className="baa-placeholder">{t('inspector.diagnosticsEmpty')}</p>
        ) : null}
        {tab === 'info' ? (
          <div className="baa-inspector">
            <div
              role="tablist"
              className="baa-tabs baa-subtabs"
              aria-label={t('inspector.tab.info')}
            >
              {SUBTABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`info-subtab-${id}`}
                  data-testid={`info-subtab-${id}`}
                  aria-selected={sub === id}
                  aria-controls="info-subpanel"
                  className="baa-tab"
                  onClick={() => setSub(id)}
                >
                  {t(`inspector.sub.${id}`)}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id="info-subpanel"
              aria-labelledby={`info-subtab-${sub}`}
              className="baa-tabpanel"
            >
              {sub === 'general' ? <InfoMessages /> : null}
              {sub === 'crossRefs' ? (
                <p className="baa-placeholder">{t('inspector.crossRefsEmpty')}</p>
              ) : null}
              {sub === 'compile' ? <CompileMessages /> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
