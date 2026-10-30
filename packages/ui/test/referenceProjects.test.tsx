import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createPlcDevice,
  createProject,
  findDevice,
  writeBaap,
} from '@baaportal/project';
import { commands } from '../src/commands/commands';
import { ids } from '../src/project/navigation/treeIds';
import {
  closeReference,
  resetReferences,
  useReferencesSnapshot,
} from '../src/project/reference/referenceStore';
import { forgetClipboard } from '../src/services/clipboard';
import { PROJECT_PATH, renderApp, type RenderedApp } from './renderApp';

const REF = '/ref/Macchina.baap';
const PLC = 'id1';
let n = 0;
const newId = () => `r${++n}`;

function referenceBytes(withFc1 = true) {
  const project = createProject(
    { name: 'Macchina', author: 'X', comment: '' },
    new Date('2026-01-01T00:00:00Z'),
  );
  const dev = createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.3',
    name: 'PLC_R',
    texts: { defaultTagTable: 'Standard' },
    newId,
  });
  if (withFc1) {
    dev.blocks.push(
      createCodeBlock({ kind: 'FC', number: 1, name: 'Calcolo', language: 'AWL', newId }),
    );
  }
  project.devices.push(dev);
  return writeBaap(project, { appVersion: '0.1.0' });
}

beforeEach(() => {
  n = 100;
  forgetClipboard();
  resetReferences();
});

async function setup() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  app.bridge.files.set(REF, referenceBytes());
  act(() => app.store.getState().setReferenceProjectsOpen(true));
  await openRef(app);
  return app;
}
async function openRef(app: RenderedApp, path = REF) {
  app.bridge.openDialogResults.push(path);
  await act(async () => {
    await commands['project.openReference'].run({
      store: app.store,
      service: app.service,
      bridge: app.bridge,
    });
  });
}
const refNodes = () => screen.queryAllByTestId(/^reference-node-/);
const calcoloNode = () =>
  refNodes().find((e) => e.textContent?.includes('Calcolo'))! as HTMLElement;
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;

describe('progetti di riferimento', () => {
  it('apri riferimento → albero nel pannello con nome e percorso; chiudi → sparisce', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    app.bridge.files.set(REF, referenceBytes());
    act(() => app.store.getState().setReferenceProjectsOpen(true));
    await openRef(app);
    const panel = screen.getByTestId('panel-reference-projects');
    expect(within(panel).getAllByText('Macchina')[0]).toBeInTheDocument();
    expect(within(panel).getByText(REF)).toBeInTheDocument();
    expect(calcoloNode()).toBeTruthy();
    await app.user.click(within(panel).getByRole('button', { name: /Chiudi/ }));
    expect(refNodes()).toHaveLength(0);
    expect(within(panel).queryByText(REF)).toBeNull();
  });

  it('rinomina/elimina/incolla disattivati sui nodi del riferimento', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    app.bridge.files.set(REF, referenceBytes());
    act(() => app.store.getState().setReferenceProjectsOpen(true));
    await openRef(app);
    await app.user.click(calcoloNode());
    await app.user.pointer({ keys: '[MouseRight]', target: calcoloNode() });
    const item = (name: RegExp) => screen.getByRole('menuitem', { name });
    expect(item(/^Rinomina/)).toHaveAttribute('aria-disabled', 'true');
    expect(item(/^Elimina/)).toHaveAttribute('aria-disabled', 'true');
    expect(item(/^Incolla/)).toHaveAttribute('aria-disabled', 'true');
    expect(item(/^Taglia/)).toHaveAttribute('aria-disabled', 'true');
    expect(item(/^Copia$/)).not.toHaveAttribute('aria-disabled', 'true');
    expect(item(/Copia nel progetto/)).not.toHaveAttribute('aria-disabled', 'true');
    await app.user.keyboard('{Escape}');
    // Dai comandi di Modifica (barra e tastiera) con il focus nell'albero di riferimento.
    calcoloNode().focus();
    await waitFor(() => expect(app.store.getState().editTarget?.id).toBe('reference-tree'));
    const s = app.store.getState();
    expect(commands['edit.copy'].isEnabled(s)).toBe(true);
    for (const id of ['edit.cut', 'edit.paste', 'edit.delete', 'edit.rename'] as const) {
      expect(commands[id].isEnabled(s)).toBe(false);
    }
  });

  it('copia FC1 dal riferimento e incolla nel progetto → FC compare; un Ctrl+Z lo toglie; riferimento invariato', async () => {
    const app = await setup();
    const before = JSON.stringify(useReferencesSnapshot()[0]!.doc);
    expect(Object.isFrozen(useReferencesSnapshot()[0]!.doc)).toBe(true);
    await app.user.click(calcoloNode());
    await app.user.keyboard('{Control>}c{/Control}');
    expect(app.bridge.clipboard).toBe('Calcolo');
    await app.user.click(screen.getByTestId(`tree-node-${ids.folder(PLC, 'blocks')}`));
    const past = app.store.getState().history.past.length;
    await app.user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(dev(app).blocks.some((b) => b.name === 'Calcolo')).toBe(true));
    expect(app.store.getState().history.past.length).toBe(past + 1);
    act(() => app.store.getState().undo());
    expect(dev(app).blocks.some((b) => b.name === 'Calcolo')).toBe(false);
    expect(JSON.stringify(useReferencesSnapshot()[0]!.doc)).toBe(before);
  });

  it('incolla FC1 in un progetto che ha già FC1 → stesso esito di pasteObjects (rinumera/rinomina)', async () => {
    const app = await setup();
    act(() =>
      app.store.getState().edit('history.addBlock', (p) => {
        findDevice(p, PLC)!.blocks.push(
          createCodeBlock({ kind: 'FC', number: 1, name: 'Calcolo', language: 'AWL', newId }),
        );
      }),
    );
    await app.user.click(calcoloNode());
    await app.user.keyboard('{Control>}c{/Control}');
    await app.user.click(screen.getByTestId(`tree-node-${ids.folder(PLC, 'blocks')}`));
    await app.user.keyboard('{Control>}v{/Control}');
    await waitFor(() => expect(dev(app).blocks.some((b) => b.name === 'Calcolo_1')).toBe(true));
    const copy = dev(app).blocks.find((b) => b.name === 'Calcolo_1')!;
    expect(copy.number).not.toBe(1);
  });

  it('Copia nel progetto: copia e incolla in un solo passo di cronologia', async () => {
    const app = await setup();
    const past = app.store.getState().history.past.length;
    await app.user.pointer({ keys: '[MouseRight]', target: calcoloNode() });
    await app.user.click(screen.getByRole('menuitem', { name: /Copia nel progetto/ }));
    await waitFor(() => expect(dev(app).blocks.some((b) => b.name === 'Calcolo')).toBe(true));
    expect(app.store.getState().history.past.length).toBe(past + 1);
  });

  it('doppio clic apre l\u2019oggetto in sola lettura; il trascinamento inserisce nel PLC con un passo di cronologia', async () => {
    const app = await setup();
    await app.user.dblClick(calcoloNode());
    expect(screen.getByTestId('reference-view').textContent).toContain('Calcolo');
    await app.user.click(within(screen.getByTestId('reference-view')).getByTestId('dialog-ok'));
    const past = app.store.getState().history.past.length;
    const dt = { setData: () => {}, effectAllowed: '' };
    fireEvent.dragStart(calcoloNode(), { dataTransfer: dt });
    const plcNode = screen.getByTestId(`tree-node-${ids.plc(PLC)}`);
    fireEvent.drop(plcNode, { dataTransfer: dt });
    await waitFor(() => expect(dev(app).blocks.some((b) => b.name === 'Calcolo')).toBe(true));
    expect(app.store.getState().history.past.length).toBe(past + 1);
  });

  it('riferimento = stesso file del progetto aperto → si apre, modifiche al progetto non toccano il riferimento', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    act(() => app.store.getState().setReferenceProjectsOpen(true));
    await openRef(app, PROJECT_PATH);
    const ref = useReferencesSnapshot()[0]!;
    const before = JSON.stringify(ref.doc);
    act(() =>
      app.store.getState().edit('history.addBlock', (p) => {
        findDevice(p, PLC)!.blocks.push(
          createCodeBlock({ kind: 'FC', number: 5, name: 'Nuovo', language: 'AWL', newId }),
        );
      }),
    );
    expect(JSON.stringify(useReferencesSnapshot()[0]!.doc)).toBe(before);
    // Lo stesso percorso riaperto non duplica il riferimento.
    await openRef(app, PROJECT_PATH);
    expect(useReferencesSnapshot()).toHaveLength(1);
    // Due riferimenti diversi hanno chiavi diverse; chiudere il progetto li lascia aperti.
    app.bridge.files.set(REF, referenceBytes());
    await openRef(app);
    const keys = useReferencesSnapshot().map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
    await act(async () => void (await app.service.close()));
    expect(useReferencesSnapshot()).toHaveLength(2);
    act(() => closeReference(keys[0]!));
    expect(useReferencesSnapshot()).toHaveLength(1);
  });

  it('file non .baap valido → messaggio con codice BaapFormatError, nessun riferimento aggiunto', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    app.bridge.files.set('/ref/rotto.baap', new Uint8Array([1, 2, 3]));
    await openRef(app, '/ref/rotto.baap');
    expect(useReferencesSnapshot()).toHaveLength(0);
    expect(app.bridge.errors).toHaveLength(1);
    expect(app.bridge.errors[0]!.message).toMatch(/non è un progetto BaaPortal valido/);
  });
});
