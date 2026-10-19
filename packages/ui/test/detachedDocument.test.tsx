import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findDevice, readBaap } from '@baaportal/project';
import { flushPendingEdits, registerEditDocument } from '../src/flushPendingEdits';
import { editorKey, type EditorKind } from '../src/state/workArea';
import { PROJECT_PATH, renderApp, type RenderedApp } from './renderApp';

// Gli id dei progetti di renderApp sono prevedibili: PLC 'id1', tabella standard 'id2'.
const PLC = 'id1';
const TABLE = 'id2';

const frames: HTMLIFrameElement[] = [];
/** Finestra figlia simulata: un iframe ha un proprio documento in cui il focus funziona. */
function childWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const win = frame.contentWindow!;
  vi.spyOn(win, 'close').mockImplementation(() => undefined);
  vi.spyOn(win, 'focus').mockImplementation(() => undefined);
  return win;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of frames.splice(0)) f.remove();
});

function addTag(app: RenderedApp, name: string) {
  const id = `tag-${name}`;
  act(() => {
    app.store.getState().edit('history.addRow', (p) => {
      findDevice(p, PLC)!.tagTables[0]!.tags.push({
        id,
        name,
        type: 'Bool',
        address: '%M0.0',
        hmi: true,
        comment: '',
      });
    });
  });
  return id;
}

/** Apre l'editor indicato direttamente in una finestra separata; restituisce il documento figlio. */
async function openDetached(app: RenderedApp, kind: EditorKind, objectId: string) {
  const win = childWindow();
  vi.spyOn(window, 'open').mockReturnValue(win);
  act(() => {
    app.store.getState().openEditor({ kind, deviceId: PLC, objectId });
    app.store.getState().detachEditor(editorKey(kind, PLC, objectId));
  });
  await waitFor(() =>
    expect(win.document.querySelector('[data-testid^="editor-body-"]')).not.toBeNull(),
  );
  return { win, doc: win.document };
}

const setup = () => renderApp({ view: 'project', withProject: true, withPlc: true });
const tagNames = (app: RenderedApp) =>
  findDevice(app.store.getState().doc!.project, PLC)!.tagTables[0]!.tags.map((t) => t.name);

/** Avvia la modifica del nome del tag nella finestra figlia e scrive `text` senza confermare. */
function typeInNameCell(doc: Document, tagId: string, text: string): HTMLInputElement {
  const cell = doc.querySelector<HTMLElement>(`[data-row-key="${tagId}"] [data-col-id="name"]`)!;
  act(() => cell.focus());
  fireEvent.keyDown(cell, { key: 'Enter' });
  const input = doc.querySelector<HTMLInputElement>('input.baa-grid-input')!;
  expect(doc.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe('finestra separata: documento proprio', () => {
  it('Mod+S in un campo della finestra separata salva anche il testo appena scritto', async () => {
    const app = await setup();
    const tagId = addTag(app, 'Motore');
    const { doc } = await openDetached(app, 'tagTable', TABLE);
    const input = typeInNameCell(doc, tagId, 'Pompa');
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(
        readBaap(app.bridge.files.get(PROJECT_PATH)!).devices[0]!.tagTables[0]!.tags[0]!.name,
      ).toBe('Pompa'),
    );
    await waitFor(() => expect(app.store.getState().doc!.dirty).toBe(false));
  });

  it('il salvataggio del servizio conferma anche la bozza della finestra separata', async () => {
    const app = await setup();
    const tagId = addTag(app, 'Motore');
    const { doc } = await openDetached(app, 'tagTable', TABLE);
    typeInNameCell(doc, tagId, 'Pompa');
    await act(async () => {
      await app.service.save();
    });
    expect(
      readBaap(app.bridge.files.get(PROJECT_PATH)!).devices[0]!.tagTables[0]!.tags[0]!.name,
    ).toBe('Pompa');
  });

  it('chiudere la finestra separata con una cella in modifica conserva la bozza', async () => {
    const app = await setup();
    const tagId = addTag(app, 'Motore');
    const { win, doc } = await openDetached(app, 'tagTable', TABLE);
    typeInNameCell(doc, tagId, 'Pompa');
    act(() => {
      win.dispatchEvent(new Event('beforeunload'));
    });
    expect(app.store.getState().workArea.detached).toEqual([]);
    expect(tagNames(app)).toEqual(['Pompa']);
  });

  it('il riempimento automatico termina anche nella finestra separata', async () => {
    const app = await setup();
    const tagId = addTag(app, 'Motore');
    const { doc } = await openDetached(app, 'tagTable', TABLE);
    const cell = doc.querySelector<HTMLElement>(`[data-row-key="${tagId}"] [data-col-id="name"]`)!;
    fireEvent.click(cell);
    act(() => cell.focus());
    const handle = doc.querySelector<HTMLElement>('[data-fill-handle]')!;
    fireEvent.pointerDown(handle);
    // La riga "<Aggiungi>" conta come una riga in più.
    fireEvent.pointerEnter(doc.querySelector('[data-row-key$="add:0"]')!);
    fireEvent.pointerUp(doc.body);
    expect(tagNames(app)).toEqual(['Motore', 'Motore_1']);
  });

  it('il menu "⋯" di un segmento si apre nella finestra separata', async () => {
    const app = await setup();
    const ob1 = findDevice(app.store.getState().doc!.project, PLC)!.blocks[0]!;
    const { doc } = await openDetached(app, 'block', ob1.id);
    fireEvent.click(doc.querySelector('[aria-label="Menu del segmento 1"]')!);
    const menu = doc.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Un clic fuori dal menu, nella finestra separata, lo chiude.
    fireEvent.mouseDown(doc.body);
    expect(doc.querySelector('[role="menu"]')).toBeNull();
  });

  it('le frecce spostano il focus fra le schede della tabella nella finestra separata', async () => {
    const app = await setup();
    const { doc } = await openDetached(app, 'tagTable', TABLE);
    const tabs = doc.querySelectorAll<HTMLElement>('[role="tab"]');
    act(() => tabs[0]!.focus());
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(doc.activeElement).toBe(doc.querySelectorAll('[role="tab"]')[1]);
  });

  it('il focus che lascia la griglia nella finestra separata toglie la destinazione di Modifica', async () => {
    const app = await setup();
    const tagId = addTag(app, 'Motore');
    const { doc } = await openDetached(app, 'tagTable', TABLE);
    const cell = doc.querySelector<HTMLElement>(`[data-row-key="${tagId}"] [data-col-id="name"]`)!;
    act(() => cell.focus());
    expect(app.store.getState().editTarget).not.toBeNull();
    // Un menu tiene la destinazione; il focus che poi va altrove la toglie.
    const menu = Object.assign(doc.createElement('div'), { tabIndex: -1 });
    menu.setAttribute('role', 'menu');
    doc.body.appendChild(menu);
    act(() => menu.focus());
    expect(app.store.getState().editTarget).not.toBeNull();
    act(() => doc.querySelector<HTMLElement>('[role="tab"]')!.focus());
    expect(app.store.getState().editTarget).toBeNull();
  });
});

describe('flushPendingEdits', () => {
  it('conferma i campi della finestra principale e di quelle separate registrate', () => {
    const child = childWindow().document;
    const input = child.createElement('input');
    child.body.appendChild(input);
    const blurred = vi.fn();
    input.addEventListener('blur', blurred);
    const unregister = registerEditDocument(child);
    input.focus();
    flushPendingEdits();
    expect(blurred).toHaveBeenCalledTimes(1);
    unregister();
    input.focus();
    flushPendingEdits();
    expect(blurred).toHaveBeenCalledTimes(1);
  });
});
