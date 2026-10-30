import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, createGlobalDb, findDevice } from '@baaportal/project';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp } from './renderApp';

const PLC = 'id1';
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent?.trim());

describe('vista dettagli del PLC', () => {
  it('cartella dei blocchi: Nome, Numero, Tipo, Linguaggio', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    act(() => {
      store.getState().edit('history.addBlock', (p) => {
        const dev = findDevice(p, PLC)!;
        dev.blocks.push(
          createCodeBlock({ kind: 'FC', number: 4, name: 'Calcolo', language: 'AWL' }),
        );
        dev.blocks.push(createGlobalDb({ number: 7, name: 'Dati' }));
      });
      store.getState().select(ids.folder(PLC, 'blocks'));
    });
    expect(headers()).toEqual(['Nome', 'Numero', 'Tipo', 'Linguaggio']);
    const rows = screen.getAllByTestId('details-row');
    expect(rows.map(cells)).toEqual([
      ['Aggiungi nuovo blocco', '', '', ''],
      ['Calcolo', '4', 'FC', 'AWL'],
      ['Dati', '7', 'DB', ''],
      ['Main', '1', 'OB', 'AWL'],
      ['Blocchi di sistema', '', '', ''],
    ]);
    // Solo le righe che rappresentano un oggetto sono trascinabili.
    expect(rows.map((r) => r.getAttribute('draggable'))).toEqual([
      null,
      'true',
      'true',
      'true',
      null,
    ]);
  });

  it('Variabili PLC: Nome e Variabili; Tipi di dati PLC: Nome e Numero', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    act(() => {
      store.getState().edit('history.addUdt', (p) => {
        findDevice(p, PLC)!.udts.push({
          id: 'u1',
          name: 'Motore',
          number: 3,
          group: '',
          comment: '',
          author: '',
          family: '',
          version: '0.1',
          members: [],
        });
      });
      store.getState().select(ids.folder(PLC, 'tags'));
    });
    expect(headers()).toEqual(['Nome', 'Variabili']);
    expect(screen.getAllByTestId('details-row').map(cells)).toContainEqual([
      'Tabella delle variabili standard',
      '0',
    ]);
    act(() => store.getState().select(ids.folder(PLC, 'types')));
    expect(headers()).toEqual(['Nome', 'Numero']);
    expect(screen.getAllByTestId('details-row').map(cells)).toContainEqual(['Motore', '3']);
  });

  it('una tabella delle variabili mostra i tag con tipo, indirizzo e commento', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const tableId = findDevice(store.getState().doc!.project, PLC)!.tagTables[0]!.id;
    act(() => {
      store.getState().edit('history.addTagTable', (p) => {
        findDevice(p, PLC)!.tagTables[0]!.tags.push(
          {
            id: 't1',
            name: 'Start',
            type: 'Bool',
            address: 'I0.0',
            hmi: false,
            comment: 'Pulsante',
          },
          { id: 't2', name: 'Conteggio', type: 'Int', address: 'MW10', hmi: false, comment: '' },
        );
      });
      store.getState().select(ids.tagTable(PLC, tableId));
    });
    expect(headers()).toEqual(['Nome', 'Tipo di dati', 'Indirizzo', 'Commento dei tag']);
    const rows = screen.getAllByTestId('details-row');
    expect(rows.map(cells)).toEqual([
      ['Start', 'Bool', 'I0.0', 'Pulsante'],
      ['Conteggio', 'Int', 'MW10', ''],
    ]);
    expect(rows.every((r) => r.getAttribute('draggable') === 'true')).toBe(true);
  });

  it('un gruppo dei blocchi usa le stesse colonne; gli altri nodi restano a una colonna', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    act(() => {
      store.getState().edit('history.addBlock', (p) => {
        const dev = findDevice(p, PLC)!;
        dev.groups.blocks.push('Linea');
        const b = createCodeBlock({ kind: 'FB', number: 2, name: 'Motore', language: 'AWL' });
        b.group = 'Linea';
        dev.blocks.push(b);
      });
      store.getState().select(ids.group(PLC, 'blocks', 'Linea'));
    });
    expect(headers()).toEqual(['Nome', 'Numero', 'Tipo', 'Linguaggio']);
    expect(screen.getAllByTestId('details-row').map(cells)).toEqual([['Motore', '2', 'FB', 'AWL']]);
    act(() => store.getState().select(`plc:${PLC}`));
    expect(headers()).toEqual(['Nome']);
    expect(screen.getAllByTestId('details-row')).toHaveLength(10);
  });
});
