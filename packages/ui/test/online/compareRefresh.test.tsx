import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { COMPARE_DEBOUNCE_MS } from '../../src/online/plcController';
import type { PlcBlocksResult } from '../../src/online/plcTypes';
import { renderApp, type RenderedApp } from '../renderApp';

// Cancello sulla compilazione: il test ferma il riallineamento a metà.
const hook = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  entered: false,
  done: undefined as Promise<void> | undefined,
}));
vi.mock('../../src/project/compile/compileActions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/project/compile/compileActions')>();
  return {
    ...real,
    compileProgram: (...a: Parameters<typeof real.compileProgram>) => {
      const gate = hook.gate;
      if (!gate) return real.compileProgram(...a);
      hook.gate = undefined;
      hook.entered = true;
      hook.done = gate.then(() => real.compileProgram(...a));
      return hook.done;
    },
  };
});

const PLC = 'id1';
const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };
const OK = {
  ok: true as const,
  mode: 'RUN' as const,
  identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
};

function fc(n: number): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: n, name: `FC${n}`, language: 'AWL' });
  b.networks[0]!.source = 'A %I0.0\n= %Q0.0';
  return b;
}

async function setup() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await act(async () => {
    await app.service.open('/doc/BaaPortal/Linea 3.baap');
  });
  findDevice(app.store.getState().doc!.project, PLC)!.properties.access = ACCESS;
  const a = fc(1);
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(a);
    });
  });
  const ctx = { store: app.store, service: app.service, bridge: app.bridge };
  const run = (id: 'online.goOnline' | 'online.compare') =>
    act(async () => {
      await commands[id].run(ctx);
    });
  app.bridge.plcResults.push(OK);
  await run('online.goOnline');
  await waitFor(() => expect(st(app).online.compare).toBeDefined());
  await waitFor(() => expect(st(app).online.comparing).toBe(false));
  return { app, a, run, ctx };
}

const st = (app: RenderedApp) => app.store.getState();
const stateOf = (app: RenderedApp, id: string) =>
  st(app).online.compare?.rows.find((r) => r.blockId === id)?.state;
const editA = (app: RenderedApp, a: CodeBlock, src: string) =>
  act(() => {
    st(app).edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.find((b) => b.id === a.id)!.networks[0]!.source = src;
    });
  });
const UNREADABLE: PlcBlocksResult = {
  ok: true,
  blocks: [{ type: 'FC', number: 1, loadLength: 0, mc7Length: 0, checksum: 0, unreadable: true }],
};

describe('riallineamento del confronto dopo una modifica', () => {
  it('un Confronta durante la compilazione vince: non si riapplica l elenco vecchio', async () => {
    const { app, a, run } = await setup();
    expect(stateOf(app, a.id)).toBe('offlineOnly');
    let release!: () => void;
    hook.gate = new Promise<void>((r) => (release = r));
    hook.entered = false;
    editA(app, a, 'A %I0.1\n= %Q0.0');
    await waitFor(() => expect(hook.entered).toBe(true), { timeout: COMPARE_DEBOUNCE_MS * 4 });
    app.bridge.plcBlocksResults = [UNREADABLE];
    await run('online.compare');
    expect(stateOf(app, a.id)).toBe('unreadable');
    await act(async () => {
      release();
      await hook.done;
    });
    expect(stateOf(app, a.id)).toBe('unreadable');
  }, 30_000);

  it('una modifica durante il confronto si riallinea alla sua fine', async () => {
    const { app, a, ctx } = await setup();
    let answer!: (r: PlcBlocksResult) => void;
    app.bridge.plcBlocks = () => new Promise((r) => (answer = r));
    const comparing = commands['online.compare'].run(ctx);
    await waitFor(() => expect(answer).toBeDefined());
    editA(app, a, 'A %I0.2\n= %Q0.0');
    // Il riallineamento scade mentre il confronto è ancora in corso.
    await act(() => new Promise((r) => setTimeout(r, COMPARE_DEBOUNCE_MS + 200)));
    await act(async () => answer({ ok: true, blocks: [] }));
    await comparing;
    expect(stateOf(app, a.id)).toBe('notCompiled');
    await waitFor(() => expect(stateOf(app, a.id)).toBe('offlineOnly'), {
      timeout: COMPARE_DEBOUNCE_MS * 4,
    });
  }, 30_000);
});
