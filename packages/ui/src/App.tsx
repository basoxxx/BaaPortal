// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- le dichiarazioni *.css devono seguire il file anche nei programmi TS che lo importano (desktop)
/// <reference path="./css.d.ts" />
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { BaaBridge } from './bridge';
import { ErrorBoundary, FatalError } from './ErrorBoundary';
import { useShortcuts } from './commands/useShortcuts';
import { i18next, initI18n, t } from './i18n';
import { createProjectService } from './services/projectService';
import { PortalView } from './portal/PortalView';
import { ProjectView } from './project/ProjectView';
import { loadLayout, saveLayout } from './project/layoutStorage';
import { AppProvider, useAppStore, type AppServices } from './state/AppContext';
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
  const view = useAppStore((s) => s.view);
  return (
    <div data-testid="app-root" className="baa-app">
      {view === 'portal' ? <PortalView /> : <ProjectView />}
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
      const service = createProjectService({ store, bridge, t, appVersion });
      const detachPortal = attachPortalReaction(store);
      dispose = () => {
        detachPortal();
        detachLayout();
        service.dispose();
      };
      const services = { store, service, bridge };
      setServices(services);
      onReady?.(services);
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
