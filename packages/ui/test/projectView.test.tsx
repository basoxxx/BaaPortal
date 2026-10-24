import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_PATH, renderApp } from './renderApp';
import { flush } from './fakeBridge';

const menuTitles = () => within(screen.getByTestId('menu-bar')).getAllByRole('menuitem');

describe('vista progetto: struttura', () => {
  it('ci sono tutti gli elementi della vista progetto', async () => {
    await renderApp({ view: 'project', withProject: true });
    for (const id of [
      'menu-bar',
      'toolbar',
      'panel-navigation',
      'panel-reference-projects',
      'panel-details',
      'work-area',
      'panel-inspector',
      'link-portal-view',
      'editor-bar',
      'status-bar',
      'panel-task-cards',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId(/^splitter-/).length).toBeGreaterThanOrEqual(4);
  });

  it("i menu sono nell'ordine di TIA Portal", async () => {
    await renderApp({ view: 'project', withProject: true });
    expect(menuTitles().map((m) => m.textContent)).toEqual([
      'Progetto',
      'Modifica',
      'Visualizza',
      'Inserisci',
      'Online',
      'Opzioni',
      'Strumenti',
      'Finestra',
      'Guida',
    ]);
  });

  it("la barra degli strumenti ha i comandi nell'ordine della spec e il campo Ricerca disattivato", async () => {
    await renderApp({ view: 'project', withProject: true });
    const tb = within(screen.getByTestId('toolbar'));
    expect(tb.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Nuovo…',
      'Apri…',
      'Salva',
      'Stampa…',
      'Taglia',
      'Copia',
      'Incolla',
      'Elimina',
      'Annulla',
      'Ripeti',
      'Compila → Software (solo modifiche)',
      'Carica nel dispositivo',
      'Carica dal dispositivo…',
      'Simulazione',
      'Collegamento online',
      'Interrompi collegamento online',
      'Dispositivi accessibili…',
      'Avvia CPU',
      'Arresta CPU',
      'Dividi area di lavoro in verticale',
    ]);
    expect(tb.getByRole('button', { name: 'Salva' })).toBeEnabled();
    expect(tb.getByRole('button', { name: 'Taglia' })).toBeDisabled();
    expect(tb.getByRole('searchbox')).toBeDisabled();
  });
});

describe('vista progetto: menu', () => {
  it('menu Progetto: Salva e Archivia attivi con progetto, Stampa disattivato', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByRole('menuitem', { name: 'Progetto' }));
    expect(screen.getByRole('menuitem', { name: 'Salva' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Archivia…' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Stampa…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('senza progetto Salva è disattivato', async () => {
    const { user } = await renderApp({ view: 'project' });
    await user.click(screen.getByRole('menuitem', { name: 'Progetto' }));
    expect(screen.getByRole('menuitem', { name: 'Salva' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Progetti recenti elenca i recenti e apre quello cliccato', async () => {
    const { user, bridge, store } = await renderApp({ view: 'project', withProject: true });
    await bridge.recentAdd('/doc/BaaPortal/Altro.baap', 'Altro');
    await bridge.recentAdd(PROJECT_PATH, 'Linea 3');
    bridge.files.set('/doc/BaaPortal/Altro.baap', bridge.files.get(PROJECT_PATH)!);
    await user.click(screen.getByRole('menuitem', { name: 'Progetto' }));
    await user.click(screen.getByRole('menuitem', { name: 'Progetti recenti' }));
    const sub = await screen.findByRole('menuitem', { name: 'Altro' });
    expect(screen.getAllByRole('menuitem', { name: 'Linea 3' }).length).toBeGreaterThan(0);
    await user.click(sub);
    await waitFor(() => expect(store.getState().doc?.filePath).toBe('/doc/BaaPortal/Altro.baap'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('i menu si usano da tastiera: F10, frecce, Invio, Esc', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.keyboard('{F10}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menuitem', { name: 'Modifica' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('menuitem', { name: 'Inserisci' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.keyboard('{F10}{ArrowRight}{ArrowRight}{ArrowDown}{Enter}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(store.getState().view).toBe('project');
  });

  it('Visualizza: Vista portale e voci con spunta', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByRole('menuitem', { name: 'Visualizza' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Finestra di ispezione' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('menuitem', { name: 'Vista portale' }));
    expect(store.getState().view).toBe('portal');
  });

  it('Visualizza -> Finestra di ispezione nasconde e rimostra il pannello', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByRole('menuitem', { name: 'Visualizza' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Finestra di ispezione' }));
    expect(screen.queryByTestId('panel-inspector')).not.toBeInTheDocument();
    expect(screen.getByTestId('strip-inspector')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Visualizza' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Finestra di ispezione' }));
    expect(screen.getByTestId('panel-inspector')).toBeInTheDocument();
  });
});

describe('vista progetto: scorciatoie', () => {
  it.each([
    ['win32', '{Control>}s{/Control}'],
    ['darwin', '{Meta>}s{/Meta}'],
  ] as const)('Mod+S salva su %s', async (platform, keys) => {
    const { user, store, bridge } = await renderApp({
      view: 'project',
      withProject: true,
      platform,
    });
    act(() => store.getState().setDoc({ ...store.getState().doc!, dirty: true }));
    const before = bridge.files.get(PROJECT_PATH);
    await user.keyboard(keys);
    await waitFor(() => expect(bridge.files.get(PROJECT_PATH)).not.toBe(before));
    await waitFor(() => expect(screen.getByTestId('status-bar')).toHaveTextContent('salvato'));
  });

  it('la ripetizione automatica del tasto (e.repeat) non rilancia il comando', async () => {
    const { store, bridge } = await renderApp({ view: 'project', withProject: true });
    act(() => store.getState().setDoc({ ...store.getState().doc!, dirty: true }));
    let writes = 0;
    const orig = bridge.writeFileAtomic.bind(bridge);
    bridge.writeFileAtomic = async (p, d) => {
      writes++;
      return orig(p, d);
    };
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, repeat: true });
    await flush();
    expect(writes).toBe(0);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(writes).toBe(1));
  });

  it('Ctrl+O funziona anche dalla vista portale', async () => {
    const { user, bridge } = await renderApp();
    bridge.openDialogResults.push(PROJECT_PATH);
    bridge.files.set(PROJECT_PATH, new Uint8Array());
    let called = 0;
    const orig = bridge.showOpenProjectDialog.bind(bridge);
    bridge.showOpenProjectDialog = async () => {
      called++;
      return orig();
    };
    await user.keyboard('{Control>}o{/Control}');
    expect(called).toBe(1);
  });
});

describe('vista progetto: pannelli', () => {
  it('la freccia chiude il pannello e un clic sulla barretta lo riapre', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('collapse-taskCards'));
    expect(store.getState().panels.taskCards.open).toBe(false);
    expect(screen.queryByTestId('panel-task-cards')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('strip-taskCards'));
    expect(store.getState().panels.taskCards.open).toBe(true);
    expect(screen.getByTestId('panel-task-cards')).toBeInTheDocument();
  });

  it("nascondi automaticamente: il pannello si apre al passaggio e si richiude all'uscita", async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('pin-navigation'));
    expect(store.getState().panels.navigation.pinned).toBe(false);
    expect(screen.queryByTestId('panel-navigation')).not.toBeInTheDocument();
    await user.hover(screen.getByTestId('strip-navigation'));
    expect(screen.getByTestId('panel-navigation')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId('flyout-navigation'));
    expect(screen.queryByTestId('panel-navigation')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('strip-navigation'));
    expect(screen.getByTestId('panel-navigation')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId('flyout-navigation'));
    expect(screen.queryByTestId('panel-navigation')).not.toBeInTheDocument();
  });

  it("Progetti di riferimento si apre e si chiude dall'intestazione", async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    expect(store.getState().referenceProjectsOpen).toBe(false);
    await user.click(screen.getByTestId('toggle-reference-projects'));
    expect(store.getState().referenceProjectsOpen).toBe(true);
  });

  it('il layout si salva a ogni modifica', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('collapse-inspector'));
    expect(JSON.parse(localStorage.getItem('baa.layout.v1')!).inspector.open).toBe(false);
  });
});

describe('vista progetto: collegamenti', () => {
  it('il link Vista portale torna alla vista portale', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('link-portal-view'));
    expect(store.getState().view).toBe('portal');
    expect(screen.getByTestId('portal-start')).toBeInTheDocument();
  });

  it("la barra di stato mostra l'ultimo messaggio", async () => {
    const { store } = await renderApp({ view: 'project', withProject: true });
    act(() =>
      store
        .getState()
        .pushMessage({ severity: 'info', textKey: 'messages.saved', params: { name: 'Prova' } }),
    );
    expect(screen.getByTestId('status-bar')).toHaveTextContent('Progetto "Prova" salvato.');
  });
});

describe('vista progetto: colonna sinistra vuota', () => {
  it('senza pannelli a sinistra la colonna sparisce, restano le barrette, nessun errore', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('collapse-navigation'));
    await user.click(screen.getByTestId('collapse-details'));
    expect(store.getState().referenceProjectsOpen).toBe(false);
    expect(screen.getByTestId('work-area')).toBeInTheDocument();
    expect(screen.getByTestId('strip-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('strip-details')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-reference-projects')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('strip-reference'));
    expect(screen.getByTestId('panel-reference-projects')).toBeInTheDocument();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    err.mockRestore();
    warn.mockRestore();
  });
});

describe('vista progetto: sottomenu recenti da tastiera', () => {
  it('Progetti recenti: frecce ed Invio aprono il secondo recente', async () => {
    const { user, bridge, service } = await renderApp({ view: 'project', withProject: true });
    await bridge.recentAdd('/doc/BaaPortal/Altro.baap', 'Altro');
    await bridge.recentAdd('/doc/BaaPortal/Terzo.baap', 'Terzo');
    const opened: string[] = [];
    service.open = async (p: string) => {
      opened.push(p);
      return true;
    };
    await user.keyboard('{F10}');
    await screen.findByRole('menuitem', { name: 'Progetti recenti' });
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}'); // Nuovo, Apri, Progetti recenti
    expect(screen.getByRole('menuitem', { name: 'Progetti recenti' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const items = await within(screen.getByTestId('menu-recent')).findAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(screen.queryByTestId('menu-recent')).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Progetti recenti' })).toHaveFocus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(opened).toEqual([items[1]!.title]);
  });
});
