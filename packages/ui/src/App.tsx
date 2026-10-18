// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- le dichiarazioni *.css devono seguire il file anche nei programmi TS che lo importano (desktop)
/// <reference path="./css.d.ts" />
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { BaaBridge } from './bridge';
import { useShortcuts } from './commands/useShortcuts';
import { i18next, initI18n, t } from './i18n';
import { createProjectService } from './services/projectService';
import { PortalView } from './portal/PortalView';
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

function Shell() {
  useShortcuts();
  const view = useAppStore((s) => s.view);
  return (
    <div data-testid="app-root" className="baa-app">
      {/* La vista progetto arriva nel Task 5. */}
      {view === 'portal' ? <PortalView /> : null}
    </div>
  );
}

export function App({ bridge, onReady }: AppProps) {
  const [services, setServices] = useState<AppServices | null>(null);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const [appVersion] = await Promise.all([bridge.appVersion(), initI18n()]);
      if (cancelled) return;
      const store = createAppStore();
      const service = createProjectService({ store, bridge, t, appVersion });
      const detachPortal = attachPortalReaction(store);
      dispose = () => {
        detachPortal();
        service.dispose();
      };
      const services = { store, service, bridge };
      setServices(services);
      onReady?.(services);
    })();
    return () => {
      cancelled = true;
      dispose?.();
      setServices(null);
    };
  }, [bridge]);

  if (!services) return null;
  return (
    <I18nextProvider i18n={i18next}>
      <AppProvider value={services}>
        <Shell />
      </AppProvider>
    </I18nextProvider>
  );
}
