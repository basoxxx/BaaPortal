import { act, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '@baaportal/project';
import { t } from '../src/i18n';
import { createProjectService } from '../src/services/projectService';
import { createRecoveryService } from '../src/services/recoveryService';
import { loadSettings, updateSettings } from '../src/settings/settings';
import { editorKey } from '../src/state/workArea';
import { createAppStore } from '../src/state/store';
import { fb, openEditor } from './blockFixtures';
import { FakeBridge } from './fakeBridge';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;

async function openSettings(app: RenderedApp) {
  await app.user.click(screen.getByRole('menuitem', { name: 'Opzioni' }));
  await app.user.click(screen.getByRole('menuitem', { name: 'Impostazioni' }));
  return screen.findByRole('dialog', { name: 'Impostazioni' });
}
const viewOf = () =>
  EditorView.findFromDOM(
    screen
      .getByRole('textbox', { name: 'Codice del segmento 1' })
      .closest('.cm-editor') as HTMLElement,
  )!;

describe('Impostazioni', () => {
  it(
    'Opzioni → Impostazioni apre il dialogo con le tre sezioni',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true });
      const d = await openSettings(app);
      for (const name of ['Generale', 'Aspetto', 'Comportamento editor'])
        expect(within(d).getByRole('heading', { name })).toBeInTheDocument();
      for (const name of ['OK', 'Annulla', 'Ripristina predefiniti'])
        expect(within(d).getByRole('button', { name })).toBeInTheDocument();
    },
    T,
  );

  it(
    'lingua en + OK → menu in inglese subito',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true });
      const d = await openSettings(app);
      await app.user.selectOptions(within(d).getByLabelText("Lingua dell'interfaccia"), 'en');
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Options' })).toBeVisible());
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(loadSettings().general.language).toBe('en');
    },
    T,
  );

  it(
    'mnemonica int + OK → l\'editor AWL mostra "A" invece di "U"',
    async () => {
      const f = fb('Nastro');
      f.networks[0]!.source = 'A I 0.0';
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      act(() => updateSettings({ editor: { mnemonic: 'de' } }));
      await waitFor(() => expect(viewOf().state.doc.toString()).toBe('U E 0.0'));
      const d = await openSettings(app);
      await app.user.selectOptions(within(d).getByLabelText('Mnemonica SIMATIC'), 'int');
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      await waitFor(() => expect(viewOf().state.doc.toString()).toBe('A I 0.0'));
    },
    T,
  );

  it(
    'Annulla non cambia niente',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true });
      const d = await openSettings(app);
      await app.user.selectOptions(within(d).getByLabelText("Lingua dell'interfaccia"), 'en');
      await app.user.selectOptions(within(d).getByLabelText('Dimensione del carattere'), '16');
      await app.user.click(within(d).getByRole('button', { name: 'Annulla' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Opzioni' })).toBeVisible();
      expect(loadSettings().general.language).toBe('it');
      expect(loadSettings().editor.fontSize).toBe(13);
    },
    T,
  );

  it(
    'Ripristina predefiniti agisce sulla bozza, applicata solo con OK',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true });
      act(() => updateSettings({ editor: { fontSize: 16 } }));
      const d = await openSettings(app);
      expect(within(d).getByLabelText('Dimensione del carattere')).toHaveValue('16');
      await app.user.click(within(d).getByRole('button', { name: 'Ripristina predefiniti' }));
      expect(within(d).getByLabelText('Dimensione del carattere')).toHaveValue('13');
      expect(loadSettings().editor.fontSize).toBe(16);
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      expect(loadSettings().editor.fontSize).toBe(13);
    },
    T,
  );

  it(
    'scala interfaccia: imposta la variabile CSS su :root dopo OK',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true });
      const d = await openSettings(app);
      await app.user.selectOptions(within(d).getByLabelText("Scala dell'interfaccia"), '125');
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      await waitFor(() =>
        expect(document.documentElement.style.getPropertyValue('--baa-ui-scale')).toBe('1.25'),
      );
    },
    T,
  );

  it(
    'cambiare impostazioni non segna il progetto modificato',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true });
      const before = app.store.getState().history.past.length;
      const d = await openSettings(app);
      await app.user.selectOptions(within(d).getByLabelText('Larghezza tabulazione'), '8');
      await app.user.click(within(d).getByRole('button', { name: 'OK' }));
      expect(app.store.getState().doc!.dirty).toBe(false);
      expect(app.store.getState().history.past.length).toBe(before);
    },
    T,
  );

  it(
    "l'intestazione dell'editor di blocco non ha più il selettore di mnemonica",
    async () => {
      const f = fb('Nastro');
      await openEditor('block', f.id, (d) => void d.blocks.push(f));
      expect(screen.getByRole('textbox', { name: 'Codice del segmento 1' })).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Mnemonica' })).toBeNull();
    },
    T,
  );
});

describe('Impostazioni - recupero', () => {
  afterEach(() => vi.useRealTimers());

  it(
    'recupero 0 → nessun salvataggio di recupero dopo 2 intervalli',
    async () => {
      localStorage.clear();
      vi.useFakeTimers();
      const bridge = new FakeBridge();
      const store = createAppStore();
      const service = createProjectService({ store, bridge, t, appVersion: '0.1.0' });
      const rec = createRecoveryService({ store, bridge, t, appVersion: '0.1.0', service });
      store.getState().setDoc({
        project: createProject({ name: 'P', author: 'A', comment: '' }, new Date(0)),
        filePath: '/doc/P.baap',
        dirty: false,
        revision: 0,
        savedRevision: 0,
      });
      store.getState().edit('x', (p) => void (p.meta.comment = 'uno'));
      await vi.advanceTimersByTimeAsync(0);
      updateSettings({ general: { recoveryMinutes: 0 } });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(bridge.recovery.size).toBe(0);
      // Un valore diverso da 0 riavvia il timer.
      updateSettings({ general: { recoveryMinutes: 2 } });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(bridge.recovery.size).toBe(1);
      rec.dispose();
      service.dispose();
    },
    T,
  );
});

describe('Impostazioni - numeri di riga, finestre staccate, autore', () => {
  it(
    'numeri di riga: il margine compare e scompare con le impostazioni',
    async () => {
      const f = fb('Nastro');
      await openEditor('block', f.id, (d) => void d.blocks.push(f));
      await waitFor(() => expect(document.querySelector('.cm-lineNumbers')).not.toBeNull());
      act(() => updateSettings({ editor: { lineNumbers: false } }));
      await waitFor(() => expect(document.querySelector('.cm-lineNumbers')).toBeNull());
      act(() => updateSettings({ editor: { lineNumbers: true } }));
      await waitFor(() => expect(document.querySelector('.cm-lineNumbers')).not.toBeNull());
    },
    T,
  );

  it(
    'finestra staccata: scala e carattere seguono le impostazioni',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const win = frame.contentWindow!;
      vi.spyOn(win, 'close').mockImplementation(() => undefined);
      vi.spyOn(window, 'open').mockReturnValue(win);
      act(() => {
        app.store.getState().openEditor({ kind: 'tagTable', deviceId: 'id1', objectId: 'id2' });
        app.store.getState().detachEditor(editorKey('tagTable', 'id1', 'id2'));
      });
      await waitFor(() =>
        expect(win.document.querySelector('[data-testid^="editor-body-"]')).not.toBeNull(),
      );
      act(() => updateSettings({ appearance: { uiScale: 125 }, editor: { fontSize: 16 } }));
      const st = win.document.documentElement.style;
      await waitFor(() => expect(st.getPropertyValue('--baa-ui-scale')).toBe('1.25'));
      expect(st.getPropertyValue('--baa-editor-font-size')).toBe('16px');
      act(() => updateSettings({ appearance: { uiScale: 90 } }));
      await waitFor(() => expect(st.getPropertyValue('--baa-ui-scale')).toBe('0.9'));
      frame.remove();
    },
    T,
  );

  it(
    "nuovo progetto: l'autore predefinito resta quello delle impostazioni",
    async () => {
      const { user, store } = await renderApp();
      act(() => updateSettings({ general: { author: 'Anna' } }));
      await user.click(screen.getByTestId('action-new'));
      const author = await screen.findByLabelText('Autore');
      await waitFor(() => expect(author).toHaveValue('Anna'));
      await user.clear(author);
      await user.type(author, 'Bruno');
      await user.click(screen.getByRole('button', { name: 'Crea' }));
      await waitFor(() => expect(store.getState().startAction).toBe('firstSteps'));
      expect(localStorage.getItem('baa.lastAuthor')).toBe('Bruno');
      expect(loadSettings().general.author).toBe('Anna');
    },
    T,
  );
});
