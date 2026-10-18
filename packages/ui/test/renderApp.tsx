import { act, render, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { StoreApi } from 'zustand/vanilla';
import { createProject, writeBaap } from '@baaportal/project';
import { App } from '../src/App';
import { initI18n } from '../src/i18n';
import type { ProjectService } from '../src/services/projectService';
import type { AppState, View } from '../src/state/store';
import { FakeBridge } from './fakeBridge';

export const PROJECT_PATH = '/doc/BaaPortal/Linea 3.baap';

export interface RenderAppOptions {
  view?: View;
  withProject?: boolean;
  platform?: 'win32' | 'darwin' | 'linux';
}

export interface RenderedApp {
  store: StoreApi<AppState>;
  bridge: FakeBridge;
  service: ProjectService;
  user: ReturnType<typeof userEvent.setup>;
}

/** Monta la vera <App> su un FakeBridge e attende che sia pronta. */
export async function renderApp(opts: RenderAppOptions = {}): Promise<RenderedApp> {
  try {
    localStorage.clear();
  } catch {
    /* storage non disponibile */
  }
  await initI18n('it');

  const bridge = new FakeBridge();
  if (opts.platform) bridge.platform = opts.platform;
  if (opts.withProject) {
    const project = createProject({ name: 'Linea 3', author: 'Mario', comment: '' }, new Date('2026-01-01T00:00:00Z'));
    bridge.files.set(PROJECT_PATH, writeBaap(project, { appVersion: '0.1.0' }));
  }

  let services: { store: StoreApi<AppState>; service: ProjectService } | null = null;
  const user = userEvent.setup();
  render(<App bridge={bridge} onReady={(s) => { services = s; }} />);
  await waitFor(() => expect(services).not.toBeNull());
  const { store, service } = services!;
  if (opts.withProject) await act(async () => { await service.open(PROJECT_PATH); });
  if (opts.view) act(() => store.getState().setView(opts.view!));
  return { store, bridge, service, user };
}
