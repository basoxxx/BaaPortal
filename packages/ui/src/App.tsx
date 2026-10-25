// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- le dichiarazioni *.css devono seguire il file anche nei programmi TS che lo importano (desktop)
/// <reference path="./css.d.ts" />
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { BaaBridge } from './bridge';
import { ErrorBoundary, FatalError } from './ErrorBoundary';
import { useShortcuts } from './commands/useShortcuts';
import { i18next, initI18n, t } from './i18n';
import { flushPendingEdits } from './flushPendingEdits';
import { createProjectService } from './services/projectService';
import { createRecoveryService, type RecoveryService } from './services/recoveryService';
import { AccessibleDevicesDialog } from './dialogs/AccessibleDevicesDialog';
import { RestoreDialog } from './dialogs/RestoreDialog';
import { DownloadPreviewDialog } from './dialogs/DownloadPreviewDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { applyDisplaySettings, useSettings } from './settings/settings';
import { AddBlockDialog } from './project/dialogs/AddBlockDialog';
import { AddDeviceDialog } from './project/dialogs/AddDeviceDialog';
import { ImportTagsReport } from './project/dialogs/ImportTagsReport';
import { KitDialog } from './project/dialogs/KitDialog';
import { DetachedWindows } from './project/workarea/DetachedWindow';
import { UpdateNotice } from './update/UpdateNotice';
import { PortalView } from './portal/PortalView';
import { ProjectView } from './project/ProjectView';
import { loadLayout, saveLayout } from './project/layoutStorage';
import { AppProvider, useAppStore, useServices, type AppServices } from './state/AppContext';
import { attachEditorReconciler } from './state/editorReconciler';
import { attachPortalReaction } from './state/portalReaction';
import { createAppStore } from './state/store';
import './theme/tokens.css';
import './theme/global.css';

export interface AppProps {
  bridge: BaaBridge;
  /** Chiamata quando store e servizio sono pronti (usata dai test). */
  onReady?: (services: AppServices) => void;
}

/** localStorage può lanciare (dati del sito bloccati): in tal caso il layout non viene ricordato. */
function layoutStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function Shell() {
  useShortcuts();
  const { store } = useServices();
  const view = useAppStore((s) => s.view);
  const online = useAppStore((s) => s.online.status === 'on');
  const dialog = useAppStore((s) => s.dialog);
  const close = () => store.getState().closeDialog();
  const [settings] = useSettings();
  // Scala e carattere degli editor: variabili CSS su :root, senza riavvio.
  useEffect(() => applyDisplaySettings(document, settings), [settings]);
  return (
    <div data-testid="app-root" className={online ? 'baa-app online' : 'baa-app'}>
      {view === 'portal' ? <PortalView /> : <ProjectView />}
      {dialog?.kind === 'addDevice' ? <AddDeviceDialog onClose={close} /> : null}
      {dialog?.kind === 'settings' ? <SettingsDialog onClose={close} /> : null}
      {dialog?.kind === 'accessibleDevices' ? <AccessibleDevicesDialog onClose={close} /> : null}
      {dialog?.kind === 'download' ? (
        <DownloadPreviewDialog plan={dialog.plan} onClose={close} />
      ) : null}
      {dialog?.kind === 'restore' ? <RestoreDialog onClose={close} /> : null}
      {dialog?.kind === 'collectKit' ? <KitDialog onClose={close} /> : null}
      {dialog?.kind === 'addBlock' ? (
        <AddBlockDialog
          deviceId={dialog.deviceId}
          onClose={close}
          onAdded={(ref, open) => {
            if (open && ref.kind === 'block') {
              store
                .getState()
                .openEditor({ kind: 'block', deviceId: ref.deviceId, objectId: ref.id });
            }
          }}
        />
      ) : null}
      {dialog?.kind === 'importTagsReport' ? (
        <ImportTagsReport
          fileName={dialog.fileName}
          tableName={dialog.tableName}
          summary={dialog.summary}
          onClose={close}
        />
      ) : null}
      <DetachedWindows />
      <UpdateNotice />
    </div>
  );
}

export function App({ bridge, onReady }: AppProps) {
  const [services, setServices] = useState<AppServices | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        await start();
      } catch (e) {
        console.error(e);
        if (!cancelled) setFailed(true);
      }
    })();
    async function start() {
      const [appVersion] = await Promise.all([bridge.appVersion(), initI18n()]);
      if (cancelled) return;
      const store = createAppStore();
      const storage = layoutStorage();
      store.setState({ panels: loadLayout(storage) });
      const detachLayout = store.subscribe((s, prev) => {
        if (s.panels !== prev.panels) saveLayout(storage, s.panels);
      });
      const ref: { recovery?: RecoveryService } = {};
      const service = createProjectService({
        store,
        bridge,
        t,
        appVersion,
        flushPendingEdits,
        // "Non salvare" all'uscita non deve lasciare una copia di recupero.
        beforeWindowClose: async () => {
          const doc = store.getState().doc;
          if (doc) await ref.recovery?.clear(doc.filePath);
        },
      });
      const recovery = createRecoveryService({ store, bridge, t, appVersion, service });
      ref.recovery = recovery;
      const detachPortal = attachPortalReaction(store);
      const detachEditors = attachEditorReconciler(store);
      dispose = () => {
        detachPortal();
        detachEditors();
        detachLayout();
        recovery.dispose();
        service.dispose();
      };
      const services = { store, service, bridge };
      setServices(services);
      onReady?.(services);
      void recovery.offerRecovery();
    }
    return () => {
      cancelled = true;
      dispose?.();
      setServices(null);
    };
  }, [bridge]);

  if (failed) return <FatalError />;
  if (!services) return null;
  return (
    <ErrorBoundary>
      <I18nextProvider i18n={i18next}>
        <AppProvider value={services}>
          <Shell />
        </AppProvider>
      </I18nextProvider>
    </ErrorBoundary>
  );
}
