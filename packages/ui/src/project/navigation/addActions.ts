import type { StoreApi } from 'zustand/vanilla';
import {
  createTagTable,
  createUdt,
  findDevice,
  nextFreeNumber,
  symbolNames,
  uniqueName,
} from '@baaportal/project';
import { t } from '../../i18n';
import type { AppState } from '../../state/store';
import { ids, parseNodeId } from './treeIds';

/** Numero massimo degli UDT in S7-300. */
export const MAX_UDT = 65535;

/** Aggiunge una tabella delle variabili (un solo passo di annulla) e la seleziona. */
export function addTagTable(store: StoreApi<AppState>, deviceId: string): void {
  let newId: string | null = null;
  store.getState().edit('history.addTagTable', (p) => {
    const dev = findDevice(p, deviceId);
    if (!dev) return;
    const name = uniqueName(
      t('defaults.tagTable'),
      dev.tagTables.map((x) => x.name),
    );
    const table = createTagTable(name);
    dev.tagTables.push(table);
    newId = table.id;
  });
  if (newId) store.getState().select(ids.tagTable(deviceId, newId));
}

/** Aggiunge un tipo di dati utente (un solo passo di annulla) e lo seleziona. */
export function addUdt(store: StoreApi<AppState>, deviceId: string): void {
  let newId: string | null = null;
  store.getState().edit('history.addUdt', (p) => {
    const dev = findDevice(p, deviceId);
    if (!dev) return;
    const number = nextFreeNumber(dev, 'UDT', MAX_UDT);
    if (number === null) return;
    const udt = createUdt({ name: uniqueName(t('defaults.udt'), symbolNames(dev)), number });
    dev.udts.push(udt);
    newId = udt.id;
  });
  if (newId) store.getState().select(ids.udt(deviceId, newId));
}

/**
 * Doppio clic o Invio su un nodo "Aggiungi…". Restituisce true se il nodo lo era.
 * I blocchi hanno un dialogo, il dispositivo pure; tabella e UDT si aggiungono subito.
 */
export function runAddNode(store: StoreApi<AppState>, nodeId: string): boolean {
  if (nodeId === 'add-device') {
    store.getState().openDialog({ kind: 'addDevice' });
    return true;
  }
  const p = parseNodeId(nodeId);
  if (p.kind !== 'folder') return false;
  switch (p.folder) {
    case 'blocks-add':
      store.getState().openDialog({ kind: 'addBlock', deviceId: p.dev });
      return true;
    case 'tags-add':
      addTagTable(store, p.dev);
      return true;
    case 'types-add':
      addUdt(store, p.dev);
      return true;
    default:
      return false;
  }
}
