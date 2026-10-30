import { act, screen, within } from '@testing-library/react';
import { findDevice } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { renderApp } from './renderApp';

describe('albero del progetto', () => {
  it('è un tree con nodi, etichette italiane e sezione Progetti di riferimento vuota', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    const tree = screen.getByRole('tree');
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(7);
    expect(screen.getByTestId('tree-node-project')).toHaveTextContent('Linea 3');
    expect(screen.getByTestId('tree-node-add-device')).toHaveTextContent(
      'Aggiungi nuovo dispositivo',
    );
    expect(screen.getByTestId('tree-node-online-access')).toHaveTextContent('Accessi online');
    expect(screen.getByTestId('tree-node-add-device')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('tree-node-project')).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByTestId('toggle-reference-projects'));
    expect(store.getState().referenceProjectsOpen).toBe(true);
    expect(screen.getByText('Nessun progetto di riferimento.')).toBeInTheDocument();
  });

  it('senza progetto mostra solo Accessi online', async () => {
    await renderApp({ view: 'project' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
    expect(screen.getByTestId('tree-node-online-access')).toBeInTheDocument();
  });

  it('il clic seleziona (aria-selected) e il doppio clic chiude e riapre', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-common-data'));
    expect(store.getState().selection).toBe('common-data');
    expect(screen.getByTestId('tree-node-common-data')).toHaveAttribute('aria-selected', 'true');
    await user.dblClick(screen.getByTestId('tree-node-project'));
    expect(screen.getByTestId('tree-node-project')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('tree-node-common-data')).not.toBeInTheDocument();
    await user.dblClick(screen.getByTestId('tree-node-project'));
    expect(screen.getByTestId('tree-node-common-data')).toBeInTheDocument();
  });

  it('tastiera: giù seleziona il successivo, sinistra chiude, destra riapre e scende al figlio', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    await user.keyboard('{ArrowDown}');
    expect(store.getState().selection).toBe('add-device');
    await user.keyboard('{ArrowDown}');
    expect(store.getState().selection).toBe('devices-networks');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(store.getState().selection).toBe('project');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('tree-node-project')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('tree-node-add-device')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('tree-node-project')).toHaveAttribute('aria-expanded', 'true');
    expect(store.getState().selection).toBe('project');
    await user.keyboard('{ArrowRight}');
    expect(store.getState().selection).toBe('add-device');
    await user.keyboard('{ArrowLeft}');
    expect(store.getState().selection).toBe('project');
  });

  it('roving tabindex: solo il nodo selezionato è nella sequenza di tabulazione', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-languages'));
    const tabbable = screen
      .getAllByRole('treeitem')
      .filter((n) => n.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(screen.getByTestId('tree-node-languages'));
    expect(screen.getByTestId('tree-node-languages')).toHaveFocus();
  });
});

describe('vista dettagli', () => {
  it('mostra i figli del nodo selezionato', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true });
    expect(screen.queryAllByTestId('details-row')).toHaveLength(0);
    act(() => store.getState().select('project'));
    const rows = screen.getAllByTestId('details-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Aggiungi nuovo dispositivo');
    expect(rows[4]).toHaveTextContent('Lingue e risorse');
    act(() => store.getState().select('languages'));
    expect(screen.queryAllByTestId('details-row')).toHaveLength(0);
  });
});

describe('albero del PLC', () => {
  const PLC = 'id1';

  it('mostra le cartelle del PLC con ruoli e stato corretti', async () => {
    await renderApp({ view: 'project', withProject: true, withPlc: true });
    const plc = screen.getByTestId(`tree-node-plc:${PLC}`);
    expect(plc).toHaveTextContent('PLC_1 [CPU 315-2 PN/DP]');
    expect(plc).toHaveAttribute('aria-level', '2');
    expect(screen.getByTestId(`tree-node-plc:${PLC}:device-config`)).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByTestId(`tree-node-plc:${PLC}:blocks`)).toHaveTextContent(
      'Blocchi di programma',
    );
    expect(screen.getByText('Main [OB1]')).toBeInTheDocument();
    expect(screen.getByText('Tabella delle variabili standard [0]')).toBeInTheDocument();
  });

  it('Aggiungi nuova tabella delle variabili due volte → _1 e _2, un passo di annulla ciascuna', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:tags-add`));
    await user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:tags-add`));
    const tables = findDevice(store.getState().doc!.project, PLC)!.tagTables;
    expect(tables.map((t) => t.name)).toEqual([
      'Tabella delle variabili standard',
      'Tabella delle variabili_1',
      'Tabella delle variabili_2',
    ]);
    expect(store.getState().history.past).toHaveLength(2);
    expect(store.getState().selection).toBe(`plc:${PLC}:tagTable:${tables[2]!.id}`);
    expect(screen.getByText('Tabella delle variabili_2 [0]')).toBeInTheDocument();
    act(() => store.getState().undo());
    expect(findDevice(store.getState().doc!.project, PLC)!.tagTables).toHaveLength(2);
  });

  it('Invio su Aggiungi nuovo tipo di dati aggiunge un UDT col primo numero libero', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await user.click(screen.getByTestId(`tree-node-plc:${PLC}:types-add`));
    await user.keyboard('{Enter}{Enter}');
    const udts = findDevice(store.getState().doc!.project, PLC)!.udts;
    expect(udts.map((u) => [u.name, u.number])).toEqual([
      ['Tipo di dati utente_1', 1],
      ['Tipo di dati utente_2', 2],
    ]);
    expect(screen.getByTestId(`tree-node-plc:${PLC}:udt:${udts[1]!.id}`)).toHaveTextContent(
      'Tipo di dati utente_2',
    );
  });

  it('Invio su un nodo disattivato o su una cartella non fa nulla', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await user.click(screen.getByTestId(`tree-node-plc:${PLC}:sources`));
    await user.keyboard('{Enter}');
    await user.click(screen.getByTestId(`tree-node-plc:${PLC}:blocks`));
    await user.keyboard('{Enter}');
    expect(store.getState().dialog).toBeNull();
    expect(store.getState().history.past).toHaveLength(0);
  });

  it('un nodo selezionato da fuori riapre i rami chiusi che lo contengono', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await user.dblClick(screen.getByTestId('tree-node-project'));
    expect(screen.queryByTestId(`tree-node-plc:${PLC}`)).not.toBeInTheDocument();
    act(() => store.getState().select(`plc:${PLC}`));
    expect(screen.getByTestId(`tree-node-plc:${PLC}`)).toBeVisible();
    expect(screen.getByTestId('tree-node-project')).toHaveAttribute('aria-expanded', 'true');
  });
});
