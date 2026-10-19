import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createUdt,
  type CodeBlock,
  type Member,
  type PlcDevice,
} from '@baaportal/project';

let n = 0;
export const newId = () => `x${++n}`;

export const mem = (name: string, type: string, extra: Partial<Member> = {}): Member => ({
  id: `m-${name}`,
  name,
  type,
  comment: '',
  ...extra,
});

export function plc(): PlcDevice {
  return createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.3',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Standard' },
    newId,
  });
}

export const fb = (name: string, i: Partial<CodeBlock['interface']> = {}): CodeBlock => {
  const b = createCodeBlock({ kind: 'FB', number: 10, name, language: 'AWL', newId });
  b.id = `fb-${name}`;
  Object.assign(b.interface, i);
  return b;
};
export const fc = (name: string, i: Partial<CodeBlock['interface']> = {}): CodeBlock => {
  const b = createCodeBlock({ kind: 'FC', number: 20, name, language: 'AWL', newId });
  b.id = `fc-${name}`;
  Object.assign(b.interface, i);
  return b;
};
export const udt = (name: string, members: Member[]) => {
  const u = createUdt({ name, number: 1, newId });
  u.id = `udt-${name}`;
  u.members = members;
  return u;
};
export const globalDb = (name: string, members: Member[]) => {
  const d = createGlobalDb({ number: 5, name, newId });
  d.id = `db-${name}`;
  d.members = members;
  return d;
};
export const instanceDb = (name: string, instanceOf: string) => {
  const d = createInstanceDb({ number: 6, name, instanceOf, newId });
  d.id = `idb-${name}`;
  return d;
};

// ---- Montaggio dell'editor nell'app (solo per i test dei componenti) ----
import { act, fireEvent } from '@testing-library/react';
import { findDevice } from '@baaportal/project';
import { renderApp, type RenderedApp } from './renderApp';

export const PLC = 'id1';
export const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
export const past = (app: RenderedApp) => app.store.getState().history.past.length;

/** Apre l'editor di un oggetto dopo aver preparato il PLC con `setup`. */
export async function openEditor(
  kind: 'block' | 'udt',
  objectId: string | ((d: PlcDevice) => string),
  setup: (d: PlcDevice) => void,
): Promise<RenderedApp> {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addRow', (p) => setup(findDevice(p, PLC)!));
    const id = typeof objectId === 'string' ? objectId : objectId(dev(app));
    app.store.getState().openEditor({ kind, deviceId: PLC, objectId: id });
  });
  return app;
}

export const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-col-id="${col}"]`)!;
export const addCells = (col: string) => [
  ...document.querySelectorAll<HTMLElement>(`.is-add [data-col-id="${col}"]`),
];
export const rowNum = (row: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-rownum]`)!;
export const rowEl = (row: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"]`)!;
export const expander = (row: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-expander]`)!;
export const rowKeys = () =>
  [...document.querySelectorAll<HTMLElement>('[data-row-key]:not(.is-add)')].map(
    (r) => r.dataset.rowKey!,
  );

export function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none' as string,
    effectAllowed: 'all',
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    get types() {
      return [...data.keys()];
    },
  };
}
export { fireEvent };
