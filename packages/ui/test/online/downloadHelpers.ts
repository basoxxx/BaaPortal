import { expect } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { parseBlockFile } from '@baaportal/s7comm';
import { createCodeBlock, createGlobalDb, findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import type { OnlineBlock } from '../../src/online/plcTypes';
import { renderApp, type RenderedApp } from '../renderApp';

export const PLC = 'id1';
export const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };
const OK = {
  ok: true as const,
  mode: 'RUN' as const,
  identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
};

export type Kind = 'OB' | 'FB' | 'FC' | 'DB';

export function block(kind: Kind, n: number): CodeBlock {
  if (kind === 'DB') return createGlobalDb({ number: n, name: `DB${n}` }) as unknown as CodeBlock;
  const b = createCodeBlock({ kind, number: n, name: `${kind}${n}`, language: 'AWL' });
  b.networks[0]!.source = 'A %I0.0\n= %Q0.0';
  return b;
}

/** Online con i blocchi dati nel progetto (e la CPU in `mode`); il confronto automatico è già finito. */
export async function setupOnline(kinds: [Kind, number][], mode: 'RUN' | 'STOP' = 'RUN') {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await act(async () => {
    await app.service.open('/doc/BaaPortal/Linea 3.baap');
  });
  findDevice(app.store.getState().doc!.project, PLC)!.properties.access = ACCESS;
  const blocks = kinds.map(([k, n]) => block(k, n));
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(...blocks);
    });
  });
  app.bridge.plcResults.push({ ...OK, mode });
  await act(async () => {
    await commands['online.goOnline'].run(ctx(app));
  });
  await waitFor(() => expect(app.store.getState().online.compare).toBeDefined());
  return { app, blocks };
}

export const ctx = (app: RenderedApp) => ({
  store: app.store,
  service: app.service,
  bridge: app.bridge,
});

/** Blocco della CPU uguale (o con `delta` ≠ 0 diverso) al compilato del progetto. */
export function cpuBlock(
  app: RenderedApp,
  b: CodeBlock,
  type: 'OB' | 'FB' | 'FC' | 'DB',
  delta = 0,
): OnlineBlock {
  const p = parseBlockFile(app.store.getState().compile.files[b.id]!);
  return {
    type,
    number: b.number,
    loadLength: p.header.mc7Length + 72,
    mc7Length: p.header.mc7Length,
    checksum: p.footer!.checksum + delta,
  };
}

export const runDownload = (app: RenderedApp) =>
  act(async () => {
    await commands['online.download'].run(ctx(app));
  });
