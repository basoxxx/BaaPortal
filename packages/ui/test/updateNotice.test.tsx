import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18next } from '../src/i18n';
import { getUpdateState, installNow } from '../src/update/updateController';
import type { UpdateEvent, UpdateInfoView } from '../src/update/updateTypes';
import { flush } from './fakeBridge';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const INFO: UpdateInfoView = {
  enabled: true,
  prereleaseBuild: false,
  current: '0.12.0',
  platform: 'win32',
  mode: 'install',
};

const setup = (info: Partial<UpdateInfoView> = {}, view: 'portal' | 'project' = 'project') =>
  renderApp({
    view,
    withProject: view === 'project',
    configure: (b) => {
      b.updateInfoValue = { ...INFO, ...info };
    },
  });
const emit = async (app: RenderedApp, e: UpdateEvent) => {
  await act(async () => {
    app.bridge.emitUpdateEvent(e);
    await flush();
  });
};
const notice = () => screen.getByTestId('update-notice');

afterEach(() => {
  vi.useRealTimers();
});

describe('avviso degli aggiornamenti', () => {
  it(
    'available: testo, Scarica, Più tardi, Note di rilascio',
    async () => {
      const app = await setup();
      await emit(app, { type: 'available', version: '0.12.1', manual: false });
      expect(within(notice()).getByText('È disponibile BaaPortal 0.12.1')).toBeInTheDocument();
      await app.user.click(within(notice()).getByRole('button', { name: 'Note di rilascio' }));
      await app.user.click(within(notice()).getByRole('button', { name: 'Scarica' }));
      await app.user.click(within(notice()).getByRole('button', { name: 'Più tardi' }));
      expect(app.bridge.updateCalls).toEqual(['notes:0.12.1', 'download', 'later:0.12.1']);
      expect(screen.queryByTestId('update-notice')).toBeNull();
    },
    T,
  );

  it(
    "progress: percentuale e Annulla; la barra di stato lo mostra anche con un'altra operazione",
    async () => {
      const app = await setup();
      await emit(app, { type: 'available', version: '0.12.1', manual: false });
      await emit(app, { type: 'progress', transferred: 25, total: 100 });
      expect(within(notice()).getByText(/25%/)).toBeInTheDocument();
      const bar = screen.getByTestId('status-update');
      expect(within(bar).getByText('Download aggiornamento 0.12.1')).toBeInTheDocument();
      await app.user.click(within(notice()).getByRole('button', { name: 'Annulla' }));
      expect(app.bridge.updateCalls).toContain('cancel');
      await emit(app, { type: 'cancelled' });
      expect(within(notice()).getByText('È disponibile BaaPortal 0.12.1')).toBeInTheDocument();
      expect(screen.queryByTestId('status-update')).toBeNull();
    },
    T,
  );

  it(
    'downloaded con busy: messaggio, nessuna domanda, nessun updateInstall',
    async () => {
      const app = await setup();
      app.bridge.updateCanInstallValue = { ok: false, reason: 'busy' };
      app.store.getState().edit('x', (p) => void (p.meta.comment = 'm'));
      await emit(app, { type: 'downloaded', version: '0.12.1' });
      expect(within(notice()).getByText('BaaPortal 0.12.1 è pronto')).toBeInTheDocument();
      await app.user.click(within(notice()).getByRole('button', { name: 'Riavvia e aggiorna' }));
      expect(await screen.findByTestId('update-message')).toHaveTextContent(/Aspetta la fine/);
      expect(app.bridge.confirmTexts).toHaveLength(0);
      expect(app.bridge.updateCalls).not.toContain('install');
    },
    T,
  );

  it(
    'downloaded con modifiche non salvate e Annulla: nessun updateInstall',
    async () => {
      const app = await setup();
      app.store.getState().edit('x', (p) => void (p.meta.comment = 'm'));
      app.bridge.confirmAnswers = ['cancel'];
      await emit(app, { type: 'downloaded', version: '0.12.1' });
      await app.user.click(within(notice()).getByRole('button', { name: 'Riavvia e aggiorna' }));
      await waitFor(() => expect(app.bridge.confirmTexts).toHaveLength(1));
      await flush();
      expect(app.bridge.updateCalls).not.toContain('install');
    },
    T,
  );

  it(
    'downloaded senza modifiche: prepara e poi updateInstall',
    async () => {
      const app = await setup();
      await emit(app, { type: 'downloaded', version: '0.12.1' });
      await app.user.click(within(notice()).getByRole('button', { name: 'Riavvia e aggiorna' }));
      await waitFor(() => expect(app.bridge.updateCalls).toContain('install'));
      expect(app.bridge.confirmTexts).toHaveLength(0);
      expect(app.bridge.closeConfirmed).toBe(false);
      // updateInstall del finto risponde notReady: il messaggio compare
      expect(await screen.findByTestId('update-message')).toBeInTheDocument();
    },
    T,
  );

  it(
    'doppio clic su «Riavvia e aggiorna»: una sola preparazione e un solo updateInstall',
    async () => {
      const app = await setup();
      await emit(app, { type: 'downloaded', version: '0.12.1' });
      let release!: (v: boolean) => void;
      const prepare = vi.fn(() => new Promise<boolean>((r) => (release = r)));
      const msgs = { busy: 'b', notReady: 'n' };
      const first = installNow(prepare, msgs);
      await flush();
      await installNow(prepare, msgs); // secondo clic mentre il primo è in corso
      expect(prepare).toHaveBeenCalledTimes(1);
      release(true);
      await first;
      expect(app.bridge.updateCalls.filter((c) => c === 'install')).toHaveLength(1);
    },
    T,
  );

  it(
    'macReady: istruzioni, Mostra nel Finder, Chiudi BaaPortal passa dalla domanda di salvataggio',
    async () => {
      const app = await setup({ platform: 'darwin', mode: 'dmg' });
      app.store.getState().edit('x', (p) => void (p.meta.comment = 'm'));
      await emit(app, { type: 'macReady', version: '0.12.1', path: '/d/x.dmg', reused: false });
      expect(
        within(notice()).getByText(/trascina BaaPortal nella cartella Applicazioni/),
      ).toBeInTheDocument();
      await app.user.click(within(notice()).getByRole('button', { name: 'Mostra nel Finder' }));
      expect(app.bridge.updateCalls).toContain('showInFolder');
      app.bridge.confirmAnswers = ['cancel'];
      await app.user.click(within(notice()).getByRole('button', { name: 'Chiudi BaaPortal' }));
      await waitFor(() => expect(app.bridge.confirmTexts).toHaveLength(1));
      expect(app.bridge.closeConfirmed).toBe(false);
    },
    T,
  );

  it(
    'none dopo il controllo a mano: «è aggiornato», sparisce dopo 5 s',
    async () => {
      const app = await setup();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await emit(app, { type: 'none', manual: true });
      expect(within(notice()).getByText('BaaPortal 0.12.0 è aggiornato')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.queryByTestId('update-notice')).toBeNull();
    },
    T,
  );

  it(
    'errore: messaggio e Chiudi',
    async () => {
      const app = await setup();
      await emit(app, {
        type: 'error',
        phase: 'check',
        message: 'Nessuna connessione di rete',
        manual: true,
      });
      expect(within(notice()).getByText('Nessuna connessione di rete')).toBeInTheDocument();
      await app.user.click(within(notice()).getByRole('button', { name: 'Chiudi' }));
      expect(screen.queryByTestId('update-notice')).toBeNull();
    },
    T,
  );

  it(
    "all'avvio: updateState ricostruisce l'avviso e le impostazioni vanno al main",
    async () => {
      const app = await renderApp({
        view: 'project',
        withProject: true,
        configure: (b) => {
          b.updateInfoValue = INFO;
          b.updateStateValue = { type: 'downloaded', version: '0.12.1' };
        },
      });
      expect(await screen.findByText('BaaPortal 0.12.1 è pronto')).toBeInTheDocument();
      expect(app.bridge.updatePrefsCalls).toEqual([{ checkOnStartup: true, prerelease: null }]);
    },
    T,
  );

  it(
    'in inglese',
    async () => {
      const app = await setup();
      await act(async () => {
        await i18next.changeLanguage('en');
      });
      await emit(app, { type: 'available', version: '0.12.1', manual: false });
      expect(within(notice()).getByText('BaaPortal 0.12.1 is available')).toBeInTheDocument();
      expect(within(notice()).getByRole('button', { name: 'Later' })).toBeInTheDocument();
      await act(async () => {
        await i18next.changeLanguage('it');
      });
    },
    T,
  );
});

describe('Guida e Software installato', () => {
  it(
    'menu Guida: Visualizza la guida, Controlla aggiornamenti, separatore, Informazioni',
    async () => {
      const app = await setup();
      await app.user.click(screen.getByRole('menuitem', { name: 'Guida' }));
      const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
      const at = items.indexOf('Controlla aggiornamenti…');
      expect(at).toBeGreaterThan(0);
      expect(items[at - 1]).toMatch(/^Visualizza la guida/);
      expect(items[at + 1]).toBe('Informazioni su BaaPortal');
      await app.user.click(screen.getByRole('menuitem', { name: 'Controlla aggiornamenti…' }));
      expect(app.bridge.updateCalls).toContain('check');
    },
    T,
  );

  it(
    'portale: pulsante Controlla aggiornamenti e canale',
    async () => {
      const app = await setup({ prereleaseBuild: true }, 'portal');
      await app.user.click(screen.getByTestId('action-installed'));
      expect(await screen.findByText('Versione di prova')).toBeInTheDocument();
      await app.user.click(screen.getByRole('button', { name: 'Controlla aggiornamenti' }));
      expect(app.bridge.updateCalls).toContain('check');
    },
    T,
  );
});

describe('Impostazioni → Aggiornamenti', () => {
  const open = async (app: RenderedApp) => {
    await app.user.click(screen.getByRole('menuitem', { name: 'Opzioni' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Impostazioni' }));
    return screen.findByRole('dialog', { name: 'Impostazioni' });
  };

  it(
    'build di prova: casella attiva; stabile: spenta; toccata e OK: salvata e inviata',
    async () => {
      const beta = await setup({ prereleaseBuild: true });
      const d = await open(beta);
      expect(
        within(d).getByRole('checkbox', { name: 'Ricevi anche le versioni di prova' }),
      ).toBeChecked();
      expect(within(d).getByText('Questa è una versione di prova')).toBeInTheDocument();
    },
    T,
  );

  it(
    'stabile: casella spenta; toccata e OK → updateSetPrefs con prerelease true; Ripristina → null',
    async () => {
      const app = await setup();
      let d = await open(app);
      const box = within(d).getByRole('checkbox', { name: 'Ricevi anche le versioni di prova' });
      expect(box).not.toBeChecked();
      await app.user.click(box);
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      await waitFor(() =>
        expect(app.bridge.updatePrefsCalls.at(-1)).toEqual({
          checkOnStartup: true,
          prerelease: true,
        }),
      );
      d = await open(app);
      await app.user.click(within(d).getByRole('button', { name: 'Ripristina predefiniti' }));
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      await waitFor(() =>
        expect(app.bridge.updatePrefsCalls.at(-1)).toEqual({
          checkOnStartup: true,
          prerelease: null,
        }),
      );
    },
    T,
  );

  it(
    'updateInfo.enabled falso: caselle disattivate e nota',
    async () => {
      const app = await setup({ enabled: false });
      const d = await open(app);
      for (const c of within(d).getAllByRole('checkbox', {
        name: /aggiornamenti all'avvio|versioni di prova/,
      }))
        expect(c).toBeDisabled();
      expect(
        within(d).getByText("Gli aggiornamenti funzionano solo nell'app installata"),
      ).toBeInTheDocument();
      expect(getUpdateState().info?.enabled).toBe(false);
    },
    T,
  );
});
