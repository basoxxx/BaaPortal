import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createProject, validateProjectName, writeBaap } from '@baaportal/project';
import { commands } from '../src/commands/commands';
import enTexts from '../src/i18n/en.json';
import itTexts from '../src/i18n/it.json';
import { t } from '../src/i18n';
import { PROJECT_PATH, renderApp } from './renderApp';

const names = (el: HTMLElement) =>
  within(el)
    .getAllByRole('button')
    .map((b) => b.textContent);

describe('vista portale: struttura', () => {
  it('senza progetto solo Avvio è attivo', async () => {
    await renderApp();
    expect(screen.getByTestId('portal-start')).toBeEnabled();
    for (const p of ['devices', 'plc', 'online'])
      expect(screen.getByTestId(`portal-${p}`)).toBeDisabled();
  });

  it("Avvio elenca le operazioni nell'ordine della spec", async () => {
    await renderApp();
    expect(names(screen.getByTestId('action-list'))).toEqual([
      'Apri progetto esistente',
      'Crea nuovo progetto',
      'Migra progetto',
      'Chiudi progetto',
      'Primi passi',
      'Software installato',
      'Guida',
      "Lingua dell'interfaccia utente",
      'Raccolta dati CPU (sola lettura)',
    ]);
    expect(screen.getByTestId('action-migrate')).toBeDisabled();
    expect(screen.getByTestId('action-help')).toBeDisabled();
  });

  it('con progetto aperto gli altri portali sono attivi: Aggiungi nuovo dispositivo è attivo, Aggiungi nuovo blocco solo con un PLC', async () => {
    const { user, store } = await renderApp({ withProject: true });
    expect(screen.getByTestId('portal-devices')).toBeEnabled();
    await user.click(screen.getByTestId('portal-devices'));
    expect(names(screen.getByTestId('action-list'))).toEqual([
      'Apri la vista progetto',
      'Aggiungi nuovo dispositivo',
    ]);
    expect(screen.getByRole('button', { name: 'Aggiungi nuovo dispositivo' })).toBeEnabled();
    await user.click(screen.getByTestId('portal-plc'));
    expect(screen.getByRole('button', { name: 'Aggiungi nuovo blocco' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Apri la vista progetto' }));
    expect(store.getState().view).toBe('project');
  });

  it('il link Vista progetto passa alla vista progetto anche senza progetto', async () => {
    const { user, store } = await renderApp();
    await user.click(screen.getByTestId('link-project-view'));
    expect(store.getState().view).toBe('project');
  });

  it('open-project-info mostra il percorso del progetto aperto', async () => {
    await renderApp({ withProject: true });
    expect(screen.getByTestId('open-project-info')).toHaveTextContent(
      `Progetto aperto: ${PROJECT_PATH}`,
    );
  });
});

describe('Crea nuovo progetto', () => {
  it("nome non valido mostra l'errore e disattiva Crea", async () => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    await user.clear(screen.getByLabelText('Nome progetto'));
    await user.type(screen.getByLabelText('Nome progetto'), 'CON');
    expect(screen.getByText(t('errors.name.RESERVED'))).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crea' })).toBeDisabled();
  });

  it.each([
    ['a/b', 'INVALID_CHARS'],
    ['Linea 3.', 'TRAILING_DOT_OR_SPACE'],
  ])('nome %j mostra errors.name.%s e disattiva Crea', async (value, reason) => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    await user.clear(screen.getByLabelText('Nome progetto'));
    await user.type(screen.getByLabelText('Nome progetto'), value);
    expect(screen.getByText(t(`errors.name.${reason}`))).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crea' })).toBeDisabled();
  });

  it('nome vuoto mostra errors.name.EMPTY e disattiva Crea', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    await screen.findByDisplayValue('Progetto1');
    await user.clear(screen.getByLabelText('Nome progetto'));
    expect(screen.getByText(t('errors.name.EMPTY'))).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crea' })).toBeDisabled();
  });

  it('ogni motivo di validateProjectName ha un testo in it e en', () => {
    const samples = ['', 'x'.repeat(500), 'a/b', 'CON', 'a.'];
    const reasons = samples.map((n) => {
      const r = validateProjectName(n);
      return r.ok ? null : r.reason;
    });
    expect([...reasons].sort()).toEqual([
      'EMPTY',
      'INVALID_CHARS',
      'RESERVED',
      'TOO_LONG',
      'TRAILING_DOT_OR_SPACE',
    ]);
    for (const r of reasons) {
      expect((itTexts.errors.name as Record<string, string>)[r!]).toBeTruthy();
      expect((enTexts.errors.name as Record<string, string>)[r!]).toBeTruthy();
    }
  });

  it('propone Progetto1 e percorso predefinito', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    expect(await screen.findByDisplayValue('Progetto1')).toBeVisible();
    expect(screen.getByLabelText('Percorso')).toHaveValue('/doc/BaaPortal');
  });

  it('propone Progetto2 se Progetto1 esiste', async () => {
    const { user, bridge } = await renderApp();
    bridge.files.set('/doc/BaaPortal/Progetto1.baap', new Uint8Array());
    await user.click(screen.getByTestId('action-new'));
    expect(await screen.findByDisplayValue('Progetto2')).toBeVisible();
  });

  it("l'autore predefinito è l'ultimo usato", async () => {
    const { user } = await renderApp();
    localStorage.setItem('baa.lastAuthor', 'Anna');
    await user.click(screen.getByTestId('action-new'));
    await waitFor(() => expect(screen.getByLabelText('Autore')).toHaveValue('Anna'));
  });

  it('Sfoglia… riempie il percorso con la cartella scelta', async () => {
    const { user, bridge } = await renderApp();
    bridge.showSelectFolderDialog = async () => '/altra/cartella';
    await user.click(screen.getByTestId('action-new'));
    await user.click(screen.getByRole('button', { name: 'Sfoglia…' }));
    await waitFor(() => expect(screen.getByLabelText('Percorso')).toHaveValue('/altra/cartella'));
  });

  it('un percorso relativo disabilita Crea e mostra il motivo', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    await screen.findByDisplayValue('Progetto1');
    const dir = screen.getByLabelText('Percorso');
    await user.clear(dir);
    await user.type(dir, 'relativo/cartella');
    expect(screen.getByRole('button', { name: 'Crea' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('deve essere assoluto');
    await user.clear(dir);
    await user.type(dir, '/assoluto');
    expect(screen.getByRole('button', { name: 'Crea' })).toBeEnabled();
  });

  it('Crea → Primi passi → Apri la vista progetto', async () => {
    const { user, store, bridge } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    await screen.findByDisplayValue('Progetto1');
    await user.type(screen.getByLabelText('Autore'), 'Mario');
    await user.click(screen.getByRole('button', { name: 'Crea' }));
    await waitFor(() => expect(store.getState().startAction).toBe('firstSteps'));
    expect(store.getState().view).toBe('portal');
    expect(bridge.files.has('/doc/BaaPortal/Progetto1.baap')).toBe(true);
    expect(localStorage.getItem('baa.lastAuthor')).toBe('Mario');
    await user.click(screen.getByRole('button', { name: /Apri la vista progetto/ }));
    expect(store.getState().view).toBe('project');
  });

  it('Primi passi porta ai portali Dispositivi e PLC', async () => {
    const { user, store } = await renderApp({ withProject: true });
    await user.click(screen.getByTestId('action-firstSteps'));
    await user.click(screen.getByRole('button', { name: /Configura un dispositivo/ }));
    expect(store.getState().portal).toBe('devices');
    await user.click(screen.getByTestId('portal-start'));
    await user.click(screen.getByTestId('action-firstSteps'));
    await user.click(screen.getByRole('button', { name: /Scrivi programma PLC/ }));
    expect(store.getState().portal).toBe('plc');
  });

  it("con EXISTS compare l'errore sotto il campo Nome", async () => {
    const { user, bridge } = await renderApp();
    await user.click(screen.getByTestId('action-new'));
    await screen.findByDisplayValue('Progetto1');
    bridge.files.set('/doc/BaaPortal/Progetto1.baap', new Uint8Array());
    await user.click(screen.getByRole('button', { name: 'Crea' }));
    expect(await screen.findByText(t('errors.name.EXISTS'))).toBeVisible();
  });
});

describe('Apri progetto esistente', () => {
  it('elenca i recenti e il doppio clic apre il progetto', async () => {
    const { user, bridge, store } = await renderApp();
    const project = createProject({ name: 'Linea 3', author: '', comment: '' }, new Date());
    bridge.files.set(PROJECT_PATH, writeBaap(project, { appVersion: '0.1.0' }));
    bridge.recent = [
      { path: PROJECT_PATH, name: 'Linea 3', lastOpened: '2026-01-01T10:00:00Z', exists: true },
    ];
    await user.click(screen.getByTestId('action-new'));
    await user.click(screen.getByTestId('action-open'));
    const row = await screen.findByText('Linea 3');
    await user.dblClick(row);
    await waitFor(() => expect(store.getState().doc?.filePath).toBe(PROJECT_PATH));
    expect(store.getState()).toMatchObject({ view: 'portal', startAction: 'firstSteps' });
  });

  it('recente non trovato: messaggio e rimozione dalla lista', async () => {
    const { user, bridge, store } = await renderApp();
    bridge.recent = [{ path: '/x/Perso.baap', name: 'Perso', lastOpened: '', exists: false }];
    const remove = vi.spyOn(bridge, 'recentRemove');
    await user.click(screen.getByTestId('action-new'));
    await user.click(screen.getByTestId('action-open'));
    expect(await screen.findByText(/\(non trovato\)/)).toBeVisible();
    await user.dblClick(screen.getByText('Perso'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/x/Perso.baap'));
    await waitFor(() => expect(screen.queryByText('Perso')).toBeNull());
    expect(store.getState().messages.at(-1)?.textKey).toBe('messages.recentMissing');
  });

  it('Sfoglia… usa la finestra di apertura e passa a Primi passi', async () => {
    const { user, bridge, store } = await renderApp();
    const project = createProject({ name: 'Linea 3', author: '', comment: '' }, new Date());
    bridge.files.set(PROJECT_PATH, writeBaap(project, { appVersion: '0.1.0' }));
    bridge.openDialogResults.push(PROJECT_PATH);
    await user.click(screen.getByRole('button', { name: 'Sfoglia…' }));
    await waitFor(() => expect(store.getState().startAction).toBe('firstSteps'));
  });

  it('OS open-file request in vista portale porta a Primi passi', async () => {
    const { bridge, store } = await renderApp({ withProject: false });
    const project = createProject({ name: 'Linea 3', author: '', comment: '' }, new Date());
    bridge.files.set(PROJECT_PATH, writeBaap(project, { appVersion: '0.1.0' }));
    await act(async () => {
      await bridge.emitOpenFile(PROJECT_PATH);
    });
    expect(store.getState()).toMatchObject({
      view: 'portal',
      portal: 'start',
      startAction: 'firstSteps',
    });
  });

  it("in vista progetto un'apertura resta nella vista progetto", async () => {
    const { bridge, store } = await renderApp({ view: 'project' });
    const project = createProject({ name: 'Linea 3', author: '', comment: '' }, new Date());
    bridge.files.set(PROJECT_PATH, writeBaap(project, { appVersion: '0.1.0' }));
    await act(async () => {
      await bridge.emitOpenFile(PROJECT_PATH);
    });
    expect(store.getState()).toMatchObject({ view: 'project', startAction: 'open' });
  });
});

describe('altre operazioni', () => {
  it('Chiudi progetto chiama subito service.close() e torna ad Avvio > Apri', async () => {
    const { user, store } = await renderApp({ withProject: true });
    expect(store.getState().startAction).toBe('firstSteps');
    await user.click(screen.getByTestId('action-close'));
    await waitFor(() => expect(store.getState().doc).toBeNull());
    expect(store.getState()).toMatchObject({
      view: 'portal',
      portal: 'start',
      startAction: 'open',
    });
  });

  it('Chiudi progetto con modifiche non salvate passa dalla conferma di service.close()', async () => {
    const { user, store, bridge } = await renderApp({ withProject: true });
    store.getState().edit('history.author', (p) => {
      p.meta.author = 'X';
    });
    await user.click(screen.getByTestId('action-close'));
    await waitFor(() => expect(bridge.confirmTexts).toHaveLength(1));
    expect(store.getState().doc).not.toBeNull();
  });

  it('project.close dalla vista progetto porta al portale su Avvio > Apri', async () => {
    const { store, service, bridge } = await renderApp({ withProject: true, view: 'project' });
    await act(async () => {
      await commands['project.close'].run({ store, service, bridge });
    });
    expect(store.getState()).toMatchObject({
      view: 'portal',
      portal: 'start',
      startAction: 'open',
      doc: null,
    });
  });

  it('Salva con nome nel portale non salta a Primi passi', async () => {
    const { store, service, bridge } = await renderApp({ withProject: true });
    act(() => store.getState().setStartAction('installed'));
    bridge.saveDialogResults.push('/doc/BaaPortal/Altro.baap');
    await act(async () => {
      await service.saveAs();
    });
    expect(store.getState().doc?.filePath).toBe('/doc/BaaPortal/Altro.baap');
    expect(store.getState().startAction).toBe('installed');
  });

  it('cambio lingua in English traduce i portali', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-language'));
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByTestId('portal-start')).toHaveTextContent('Start');
    expect(screen.getByTestId('portal-devices')).toHaveTextContent('Devices & networks');
    expect(screen.getByTestId('link-project-view')).toHaveTextContent('Project view');
  });

  it('Software installato mostra la versione', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByTestId('action-installed'));
    const pane = screen.getByTestId('selection-pane');
    expect(await within(pane).findByText('BaaPortal 0.1.0')).toBeVisible();
    expect(within(pane).getByText(/@baaportal\/ui 0\.1\.0/)).toBeVisible();
    expect(within(pane).getByText(/@baaportal\/project 0\.1\.0/)).toBeVisible();
  });
});
