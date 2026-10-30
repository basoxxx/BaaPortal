import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import {
  createCodeBlock,
  emptyLibrary,
  findDevice,
  readBaaplib,
  writeBaaplib,
} from '@baaportal/project';
import { ids } from '../src/project/navigation/treeIds';
import { resetLibraries } from '../src/project/library/libraryStore';
import { fakeDataTransfer } from './blockFixtures';
import { renderApp, type RenderedApp } from './renderApp';

const PLC = 'id1';
const LIB = '/lib/Motori.baaplib';

beforeEach(() => resetLibraries());

async function openLibraries(opts: Parameters<typeof renderApp>[0] = {}): Promise<RenderedApp> {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true, ...opts });
  await app.user.click(screen.getByTestId('taskcard-tab-libraries'));
  return app;
}
const plcBlocks = (app: RenderedApp) =>
  findDevice(app.store.getState().doc!.project, PLC)!
    .blocks.map((b) => `${b.kind}${b.number} ${b.name}`)
    .sort();
const menuItem = (name: string) => screen.getByRole('menuitem', { name });

/** Aggiunge al PLC un FC e lo seleziona nell'albero del progetto. */
function selectNewFc(app: RenderedApp, name = 'Calcolo') {
  const fc = createCodeBlock({ kind: 'FC', number: 7, name, language: 'AWL' });
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(fc);
    });
    app.store.getState().select(ids.block(PLC, fc.id));
  });
  return fc;
}

describe('task card Librerie', () => {
  it('la libreria standard IEC: cartelle, ricerca e sola lettura', async () => {
    const app = await openLibraries();
    const iec = screen.getByTestId('library-iec');
    const tree = within(iec).getByRole('tree');
    expect(tree).toHaveAttribute('aria-readonly', 'true');
    expect(within(iec).getByTestId('library-row-iec-Selezione')).toBeInTheDocument();
    expect(within(iec).getByTestId('library-row-iec-Fronti e bistabili')).toBeInTheDocument();
    expect(within(iec).queryByRole('button', { name: 'Aggiungi la selezione' })).toBeNull();
    await app.user.type(within(iec).getByRole('searchbox'), 'trig');
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((r) => r.textContent),
    ).toEqual(['▾Fronti e bistabili', 'F_TRIG', 'R_TRIG']);
    fireEvent.contextMenu(within(iec).getByTestId('library-row-iec-R_TRIG'));
    expect(menuItem('Elimina')).toHaveAttribute('aria-disabled', 'true');
  });

  it('inserisce un blocco IEC nel PLC; la seconda volta chiede cosa fare dello scontro', async () => {
    const app = await openLibraries();
    const iec = screen.getByTestId('library-iec');
    fireEvent.contextMenu(within(iec).getByTestId('library-row-iec-LIMIT_INT'));
    await app.user.click(menuItem('Inserisci nel PLC'));
    expect(plcBlocks(app)).toEqual(['FC500 LIMIT_INT', 'OB1 Main']);
    expect(app.store.getState().messages.at(-1)?.textKey).toBe('messages.libraryInserted');

    fireEvent.contextMenu(within(iec).getByTestId('library-row-iec-LIMIT_INT'));
    await app.user.click(menuItem('Inserisci nel PLC'));
    const dialog = screen.getByTestId('library-conflicts');
    const select = within(dialog).getByRole('combobox', { name: 'Cosa fare di LIMIT_INT' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Rinomina', 'Sostituisci', 'Salta']);
    await app.user.click(within(dialog).getByTestId('dialog-ok'));
    expect(plcBlocks(app)).toEqual(['FC1 LIMIT_INT_1', 'FC500 LIMIT_INT', 'OB1 Main']);
    // Un solo passo da annullare.
    act(() => app.store.getState().undo());
    expect(plcBlocks(app)).toEqual(['FC500 LIMIT_INT', 'OB1 Main']);
  });

  it('trascinamento: dalla libreria IEC su un nodo del PLC, e dall albero alla libreria di progetto', async () => {
    const app = await openLibraries();
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('library-row-iec-RS'), { dataTransfer: dt });
    const target = screen.getByTestId(`tree-node-${ids.folder(PLC, 'blocks')}`);
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe('copy');
    fireEvent.drop(target, { dataTransfer: dt });
    expect(plcBlocks(app)).toEqual(['FB503 RS', 'OB1 Main']);

    const fc = selectNewFc(app);
    const dt2 = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId(`tree-node-${ids.block(PLC, fc.id)}`), {
      dataTransfer: dt2,
    });
    const tree = within(screen.getByTestId('library-project')).getByRole('tree');
    expect(fireEvent.dragOver(tree, { dataTransfer: dt2 })).toBe(false);
    fireEvent.drop(tree, { dataTransfer: dt2 });
    expect(app.store.getState().doc!.project.library!.items.map((i) => i.name)).toEqual([
      'Calcolo',
    ]);
    // Nella libreria IEC (sola lettura) il rilascio è vietato.
    fireEvent.dragStart(screen.getByTestId(`tree-node-${ids.block(PLC, fc.id)}`), {
      dataTransfer: dt2,
    });
    const iecTree = within(screen.getByTestId('library-iec')).getByRole('tree');
    expect(fireEvent.dragOver(iecTree, { dataTransfer: dt2 })).toBe(true);
  });

  it('apre un modello in sola lettura con la sua sorgente AWL', async () => {
    const app = await openLibraries();
    fireEvent.contextMenu(screen.getByTestId('library-row-iec-SR'));
    await app.user.click(menuItem('Apri in sola lettura'));
    const dialog = screen.getByTestId('library-view');
    expect(dialog.textContent).toContain('FUNCTION_BLOCK');
    expect(dialog.textContent).toContain('S1');
  });

  it('libreria di progetto: aggiunge la selezione, rinomina, inserisce e si annulla', async () => {
    const app = await openLibraries();
    selectNewFc(app);
    const proj = screen.getByTestId('library-project');
    await app.user.click(within(proj).getByRole('button', { name: 'Aggiungi la selezione' }));
    const lib = () => app.store.getState().doc!.project.library!;
    expect(lib().items.map((i) => i.name)).toEqual(['Calcolo']);
    expect(app.store.getState().doc!.dirty).toBe(true);

    fireEvent.contextMenu(within(proj).getByTestId('library-row-project-Calcolo'));
    await app.user.click(menuItem('Rinomina'));
    const input = within(proj).getByRole('textbox');
    await app.user.clear(input);
    await app.user.type(input, 'Calcolo base{Enter}');
    expect(lib().items.map((i) => i.name)).toEqual(['Calcolo base']);

    fireEvent.contextMenu(within(proj).getByTestId('library-row-project-Calcolo base'));
    await app.user.click(menuItem('Elimina'));
    await waitFor(() => expect(lib().items).toEqual([]));
    act(() => app.store.getState().undo());
    expect(lib().items.map((i) => i.name)).toEqual(['Calcolo base']);
  });

  it('libreria globale: si apre in sola lettura, si modifica e si salva nel file', async () => {
    const app = await openLibraries({
      configure: (b) => {
        b.files.set(LIB, writeBaaplib(emptyLibrary(), { appVersion: '1' }));
        b.openFileResults.push([LIB]);
      },
    });
    await app.user.click(screen.getByRole('button', { name: 'Apri libreria globale…' }));
    const section = await screen.findByTestId('global-Motori');
    expect(within(section).queryByRole('button', { name: 'Aggiungi la selezione' })).toBeNull();
    await app.user.click(within(section).getByRole('button', { name: 'Modifica' }));
    selectNewFc(app, 'Pompa');
    await app.user.click(within(section).getByRole('button', { name: 'Aggiungi la selezione' }));
    expect(within(section).getByText('Motori *')).toBeInTheDocument();
    await app.user.click(within(section).getByRole('button', { name: 'Salva' }));
    await waitFor(() =>
      expect(readBaaplib(app.bridge.files.get(LIB)!).items.map((i) => i.name)).toEqual(['Pompa']),
    );
    expect(within(section).getByText('Motori')).toBeInTheDocument();
    // La libreria del progetto non cambia.
    expect(app.store.getState().doc!.project.library).toBeUndefined();
  });

  it('un file di libreria rovinato non si apre: messaggio d errore', async () => {
    const app = await openLibraries({
      configure: (b) => {
        b.files.set(LIB, strToU8('non è uno zip'));
        b.openFileResults.push([LIB]);
      },
    });
    await app.user.click(screen.getByRole('button', { name: 'Apri libreria globale…' }));
    await waitFor(() => expect(app.bridge.errors).toHaveLength(1));
    expect(app.bridge.errors[0]!.message).toBe(
      'La libreria non si può aprire: non è un file di libreria.',
    );
    expect(screen.queryByTestId('global-Motori')).toBeNull();
  });
});
