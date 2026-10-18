import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeBlock, findDevice } from '@baaportal/project';
import { commands } from '../src/commands/commands';
import { editorKey } from '../src/state/workArea';
import { renderApp, type RenderedApp } from './renderApp';

const PLC = 'id1';
const mainBlock = (app: RenderedApp) =>
  findDevice(app.store.getState().doc!.project, PLC)!.blocks.find((b) => b.kind === 'OB')!;
const blockKey = (id: string) => editorKey('block', PLC, id);

const setup = () => renderApp({ view: 'project', withProject: true, withPlc: true });

/** Aggiunge un FB e lo apre. */
function addAndOpenFb(app: RenderedApp, number: number) {
  const b = createCodeBlock({ kind: 'FB', number, name: `Blocco_${number}`, language: 'AWL' });
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(b);
    });
    app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: b.id });
  });
  return b;
}

interface FakeWin extends EventTarget {
  document: Document;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closed: boolean;
}
function fakeWindow(): FakeWin {
  return Object.assign(new EventTarget(), {
    document: document.implementation.createHTMLDocument(''),
    focus: vi.fn(),
    close: vi.fn(),
    closed: false,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('area di lavoro: apertura e coerenza', () => {
  it("doppio clic su Main [OB1] apre l'editor e mostra il pulsante nella barra", async () => {
    const app = await setup();
    expect(screen.queryByTestId('work-pane-0-editor')).not.toBeInTheDocument();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    const bar = screen.getByTestId('editor-bar');
    expect(within(bar).getByRole('button', { name: 'Main [OB1]' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const pane = screen.getByTestId('work-pane-0');
    expect(within(pane).getByRole('heading', { name: 'Main [OB1]' })).toBeInTheDocument();
    expect(within(pane).getByText('PLC_1 › Main [OB1]')).toBeInTheDocument();
    // Un secondo doppio clic non duplica.
    await app.user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:block:${mainBlock(app).id}`));
    expect(app.store.getState().workArea.editors).toHaveLength(1);
  });

  it('Invio su un blocco apre; un solo clic seleziona e basta', async () => {
    const app = await setup();
    const node = screen.getByTestId(`tree-node-plc:${PLC}:block:${mainBlock(app).id}`);
    await app.user.click(node);
    expect(app.store.getState().workArea.editors).toHaveLength(0);
    await app.user.keyboard('{Enter}');
    expect(app.store.getState().workArea.editors.map((e) => e.key)).toEqual([
      blockKey(mainBlock(app).id),
    ]);
  });

  it('Apri del menu contestuale apre l’editor', async () => {
    const app = await setup();
    await app.user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Main [OB1]'),
    });
    await app.user.click(screen.getByTestId('context-open'));
    expect(app.store.getState().workArea.editors).toHaveLength(1);
  });

  it('"Mostra tutte le variabili" si apre con il titolo del tipo', async () => {
    const app = await setup();
    await app.user.dblClick(screen.getByText('Mostra tutte le variabili'));
    expect(
      within(screen.getByTestId('work-pane-0')).getByRole('grid', { name: 'Variabili PLC' }),
    ).toBeInTheDocument();
  });

  it('attivare un editor seleziona il suo nodo nell’albero', async () => {
    const app = await setup();
    const b = addAndOpenFb(app, 1);
    act(() => app.store.getState().select(null));
    act(() => app.store.getState().activateEditor(blockKey(b.id)));
    expect(app.store.getState().selection).toBe(`plc:${PLC}:block:${b.id}`);
  });

  it("annullare la creazione di un blocco aperto chiude l'editor", async () => {
    const app = await setup();
    const b = addAndOpenFb(app, 1);
    expect(screen.getByRole('button', { name: 'Blocco_1 [FB1]' })).toBeInTheDocument();
    act(() => app.store.getState().undo());
    expect(app.store.getState().workArea.editors).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Blocco_1 [FB1]' })).not.toBeInTheDocument();
    expect(app.store.getState().workArea.panes[0]).toBeNull();
    expect(b.id).toBeTruthy();
  });

  it("chiudere l'editor attivo mostra l'ultimo usato rimasto", async () => {
    const app = await setup();
    const main = mainBlock(app);
    act(() => app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: main.id }));
    const fb = addAndOpenFb(app, 1);
    addAndOpenFb(app, 2);
    act(() => app.store.getState().activateEditor(blockKey(fb.id)));
    act(() => app.store.getState().closeEditor(blockKey(fb.id)));
    // Ordine d'uso: FB2 è stato usato dopo Main.
    expect(app.store.getState().workArea.panes[0]).toBe(
      app.store.getState().workArea.editors.find((e) => e.objectId !== main.id)!.key,
    );
  });

  it('cambiare documento chiude tutti gli editor', async () => {
    const app = await setup();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    await act(async () => {
      await app.service.close();
    });
    expect(app.store.getState().workArea.editors).toHaveLength(0);
  });

  it('Aggiungi e apri apre il nuovo blocco; Aggiungi tabella e UDT aprono l’oggetto', async () => {
    const app = await setup();
    await app.user.click(screen.getByRole('menuitem', { name: 'Inserisci' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Nuovo blocco…' }));
    await app.user.click(screen.getByTestId('dialog-ok'));
    expect(app.store.getState().workArea.editors.map((e) => e.kind)).toEqual(['block']);
    await app.user.dblClick(screen.getByText('Aggiungi nuova tabella delle variabili'));
    await app.user.dblClick(screen.getByText('Aggiungi nuovo tipo di dati'));
    expect(app.store.getState().workArea.editors.map((e) => e.kind)).toEqual([
      'block',
      'tagTable',
      'udt',
    ]);
  });

  it('Chiudi tutti gli editor: abilitato solo con editor aperti', async () => {
    const app = await setup();
    expect(commands['window.closeAllEditors'].isEnabled(app.store.getState())).toBe(false);
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    expect(commands['window.closeAllEditors'].isEnabled(app.store.getState())).toBe(true);
    await app.user.click(screen.getByRole('menuitem', { name: 'Finestra' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Chiudi tutti gli editor' }));
    expect(app.store.getState().workArea.editors).toHaveLength(0);
  });
});

describe('area di lavoro: riquadri', () => {
  it('divisione verticale: due riquadri, il secondo con l’editor precedente', async () => {
    const app = await setup();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    addAndOpenFb(app, 1);
    expect(screen.queryByTestId('work-pane-1')).not.toBeInTheDocument();
    await app.user.click(screen.getByRole('menuitem', { name: 'Finestra' }));
    const item = screen.getByRole('menuitemcheckbox', {
      name: /Dividi area di lavoro in verticale/,
    });
    expect(item).toHaveAttribute('aria-checked', 'false');
    await app.user.click(item);
    expect(app.store.getState().workArea.split).toBe('vertical');
    expect(
      within(screen.getByTestId('work-pane-0')).getByRole('heading', {
        name: 'Blocco_1 [FB1]',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('work-pane-1')).getByRole('heading', { name: 'Main [OB1]' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('splitter-panes')).toBeInTheDocument();
    // Si spegne con lo stesso comando.
    await app.user.click(screen.getByRole('menuitem', { name: 'Finestra' }));
    await app.user.click(
      screen.getByRole('menuitemcheckbox', { name: /Dividi area di lavoro in verticale/ }),
    );
    expect(screen.queryByTestId('work-pane-1')).not.toBeInTheDocument();
    expect(app.store.getState().workArea.focusedPane).toBe(0);
  });

  it('con la divisione, l’editor si apre nel riquadro con il focus', async () => {
    const app = await setup();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    act(() => app.store.getState().setSplit('horizontal'));
    await app.user.click(screen.getByTestId('work-pane-1'));
    expect(app.store.getState().workArea.focusedPane).toBe(1);
    const fb = addAndOpenFb(app, 1);
    expect(app.store.getState().workArea.panes).toEqual([
      blockKey(mainBlock(app).id),
      blockKey(fb.id),
    ]);
  });
});

describe('barra degli editor: gruppi', () => {
  it('con poco spazio raggruppa; il clic sul gruppo apre un menu', async () => {
    const RealRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        if (el.getAttribute('data-testid') === 'editor-bar-items') {
          this.cb([{ contentRect: { width: 320 } } as ResizeObserverEntry], this);
        }
      }
      unobserve() {}
      disconnect() {}
    };
    try {
      const app = await setup();
      const fbs = [addAndOpenFb(app, 1), addAndOpenFb(app, 2), addAndOpenFb(app, 3)];
      const group = await screen.findByRole('button', { name: /Blocchi \(3\)/ });
      expect(screen.queryByRole('button', { name: 'Blocco_1 [FB1]' })).not.toBeInTheDocument();
      await app.user.click(group);
      const menu = screen.getByRole('menu');
      await app.user.click(within(menu).getByRole('menuitem', { name: 'Blocco_2 [FB2]' }));
      expect(app.store.getState().workArea.panes[0]).toBe(blockKey(fbs[1]!.id));
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });
});

describe('finestra separata', () => {
  it("portale nella figlia; chiusura della figlia → torna nell'area di lavoro", async () => {
    const win = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    document.head.appendChild(
      Object.assign(document.createElement('style'), { textContent: 'a{}' }),
    );
    document.documentElement.setAttribute('data-theme', 'dark');
    const app = await setup();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    await app.user.click(screen.getByRole('button', { name: 'Apri in una finestra separata' }));

    const key = blockKey(mainBlock(app).id);
    expect(open).toHaveBeenCalledWith(
      '',
      expect.stringMatching(/^baa-editor-[0-9a-f]+$/),
      'width=1000,height=700',
    );
    expect(app.store.getState().workArea.detached).toEqual([key]);
    await waitFor(() => expect(win.document.querySelector('h3')?.textContent).toBe('Main [OB1]'));
    expect(win.document.title).toBe('Main [OB1]');
    expect(win.document.head.querySelector('style')).not.toBeNull();
    expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
    // Fuori dal riquadro, ma resta nella barra con l'icona finestra.
    expect(
      within(screen.getByTestId('work-pane-0')).queryByRole('heading', { name: 'Main [OB1]' }),
    ).not.toBeInTheDocument();
    const barBtn = within(screen.getByTestId('editor-bar')).getByRole('button', {
      name: /Main \[OB1\]/,
    });
    await app.user.click(barBtn);
    expect(win.focus).toHaveBeenCalled();

    act(() => {
      win.dispatchEvent(new Event('pagehide'));
    });
    expect(app.store.getState().workArea.detached).toEqual([]);
    expect(app.store.getState().workArea.panes[0]).toBe(key);
    expect(
      within(screen.getByTestId('work-pane-0')).getByRole('heading', { name: 'Main [OB1]' }),
    ).toBeInTheDocument();
    expect(win.close).toHaveBeenCalled();
    document.documentElement.removeAttribute('data-theme');
  });

  it("chiudere l'editor staccato chiude la finestra", async () => {
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    const app = await setup();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    await app.user.click(screen.getByRole('button', { name: 'Apri in una finestra separata' }));
    await waitFor(() => expect(win.document.body.textContent).toContain('Main [OB1]'));
    act(() => app.store.getState().closeAllEditors());
    expect(win.close).toHaveBeenCalled();
    expect(app.store.getState().workArea.detached).toEqual([]);
  });

  it("window.open null: l'editor resta e compare un messaggio", async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const app = await setup();
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    await app.user.click(screen.getByRole('button', { name: 'Apri in una finestra separata' }));
    await waitFor(() => expect(app.store.getState().workArea.detached).toEqual([]));
    expect(
      within(screen.getByTestId('work-pane-0')).getByRole('heading', { name: 'Main [OB1]' }),
    ).toBeInTheDocument();
    expect(app.store.getState().messages.at(-1)?.textKey).toBe('messages.detachBlocked');
  });

  it('Mod+S nella finestra separata salva', async () => {
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    const app = await setup();
    const save = vi.spyOn(app.service, 'save');
    await app.user.dblClick(screen.getByText('Main [OB1]'));
    await app.user.click(screen.getByRole('button', { name: 'Apri in una finestra separata' }));
    await waitFor(() => expect(win.document.body.textContent).toContain('Main [OB1]'));
    fireEvent(
      win.document,
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
    );
    await waitFor(() => expect(save).toHaveBeenCalled());
  });
});
