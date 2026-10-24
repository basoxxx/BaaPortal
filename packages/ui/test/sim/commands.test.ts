import { describe, expect, it, vi } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createPlcDevice,
  createProject,
  findDevice,
  type PlcDevice,
} from '@baaportal/project';
import { commands, type CommandContext } from '../../src/commands/commands';
import { simControllerFor } from '../../src/sim/simController';
import { SimSession } from '../../src/sim/session';
import type { SimWireRequest } from '../../src/sim/protocol';
import { createAppStore } from '../../src/state/store';
import { initI18n } from '../../src/i18n';
import { FakeBridge } from '../fakeBridge';
import { fakeWorker } from './simFixtures';

const DEV = 'dev1';

function setup(opts: { badFc?: boolean } = {}) {
  const store = createAppStore();
  const project = createProject({ name: 'P', author: '', comment: '' }, new Date());
  let n = 0;
  const dev: PlcDevice = createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.3',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Tabella' },
    newId: () => (n++ === 0 ? DEV : `id${n}`),
  });
  const fc = createCodeBlock({ kind: 'FC', number: 5, name: 'FC5', language: 'AWL' });
  fc.networks[0]!.source = opts.badFc ? 'QUESTA NON E UN ISTRUZIONE' : 'A %I0.0\n= %Q0.0';
  const db = createGlobalDb({ number: 3, name: 'DB3' });
  dev.blocks.push(fc, db);
  project.devices.push(dev);
  store.getState().setDoc({
    project,
    filePath: '/p.baap',
    dirty: false,
    revision: 0,
    savedRevision: 0,
  });
  const workers: ReturnType<typeof fakeWorker>[] = [];
  simControllerFor(store, {
    start: (o) =>
      SimSession.start({
        ...o,
        createWorker: () => {
          const w = fakeWorker();
          workers.push(w);
          return w;
        },
      }),
  });
  const bridge = new FakeBridge();
  const ctx: CommandContext = { store, bridge, service: {} as never };
  const ops = (): SimWireRequest['req']['op'][] =>
    workers.flatMap((w) => w.sent.map((m) => m.req.op));
  return { store, bridge, ctx, workers, ops };
}

const on = async (s: ReturnType<typeof setup>) => {
  await commands['online.simulation'].run(s.ctx);
  expect(s.store.getState().sim.phase).toBe('on');
};

describe('comandi online sul simulatore', () => {
  it('comandi disabilitati senza simulazione; il worker non esiste finché non serve', async () => {
    await initI18n('it');
    const s = setup();
    const st = s.store.getState();
    expect(commands['online.simulation'].isEnabled(st)).toBe(true);
    expect(commands['online.simulation'].isChecked?.(st)).toBe(false);
    for (const id of ['online.download', 'online.startCpu', 'online.stopCpu'] as const)
      expect(commands[id].isEnabled(st)).toBe(false);
    expect(s.workers).toHaveLength(0);
  });

  it('senza PLC la simulazione non si può accendere', () => {
    const store = createAppStore();
    expect(commands['online.simulation'].isEnabled(store.getState())).toBe(false);
  });

  it('Simulazione accende e spegne; spenta, il worker è terminato', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    const st = s.store.getState();
    expect(st.sim.deviceId).toBe(DEV);
    expect(st.sim.mode).toBe('STOP');
    expect(commands['online.simulation'].isChecked?.(st)).toBe(true);
    expect(commands['online.download'].isEnabled(st)).toBe(true);
    expect(s.ops()).toEqual(['start']);
    await commands['online.simulation'].run(s.ctx);
    expect(s.store.getState().sim.phase).toBe('off');
    expect(s.workers[0]!.terminated).toBe(true);
  });

  it('ordine di caricamento: DB, FC, FB, OB; poi chiede di avviare la CPU e va in RUN', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    await commands['online.download'].run(s.ctx);
    const dl = s.workers[0]!.sent.find((m) => m.req.op === 'download')!.req;
    if (dl.op !== 'download') throw new Error('atteso download');
    const files = s.store.getState().compile.files;
    const blocks = findDevice(s.store.getState().doc!.project, DEV)!.blocks;
    const order = ['DB', 'FC', 'OB'].flatMap((k) => blocks.filter((b) => b.kind === k));
    expect(dl.files).toEqual(order.map((b) => files[b.id]));
    expect(dl.files).toHaveLength(3);
    expect(s.bridge.questions).toHaveLength(1);
    expect(s.bridge.questions[0]!.message).toBe('Avviare la CPU?');
    await vi.waitFor(() => expect(s.store.getState().sim.mode).toBe('RUN'));
  });

  it('risposta No: i blocchi sono caricati, la CPU resta in STOP', async () => {
    await initI18n('it');
    const s = setup();
    s.bridge.questionAnswers.push(false);
    await on(s);
    await commands['online.download'].run(s.ctx);
    expect(s.ops()).toContain('download');
    expect(s.ops()).not.toContain('mode');
    expect(s.store.getState().sim.mode).toBe('STOP');
  });

  it('CPU già in RUN: si ricarica senza domande e resta in RUN', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    await commands['online.download'].run(s.ctx);
    await vi.waitFor(() => expect(s.store.getState().sim.mode).toBe('RUN'));
    s.bridge.questions.length = 0;
    await commands['online.download'].run(s.ctx);
    expect(s.bridge.questions).toHaveLength(0);
    expect(s.store.getState().sim.mode).toBe('RUN');
  });

  it('download bloccato da errori di compilazione', async () => {
    await initI18n('it');
    const s = setup({ badFc: true });
    await on(s);
    await commands['online.download'].run(s.ctx);
    expect(s.ops()).toEqual(['start']);
    expect(s.bridge.questions).toHaveLength(0);
    expect(s.store.getState().compile.summary!.errors).toBeGreaterThan(0);
    expect(s.store.getState().messages.at(-1)!.textKey).toBe('messages.simDownloadBlocked');
  });

  it('startCpu/stopCpu cambiano il modo', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    const st = () => s.store.getState();
    expect(commands['online.startCpu'].isEnabled(st())).toBe(true);
    expect(commands['online.stopCpu'].isEnabled(st())).toBe(false);
    await commands['online.startCpu'].run(s.ctx);
    await vi.waitFor(() => expect(st().sim.mode).toBe('RUN'));
    expect(commands['online.startCpu'].isEnabled(st())).toBe(false);
    expect(commands['online.stopCpu'].isEnabled(st())).toBe(true);
    await commands['online.stopCpu'].run(s.ctx);
    await vi.waitFor(() => expect(st().sim.mode).toBe('STOP'));
  });

  it('chiusura del progetto → dispose', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    s.store.getState().setDoc(null);
    expect(s.workers[0]!.terminated).toBe(true);
    expect(s.store.getState().sim.phase).toBe('off');
  });

  it('cambio di progetto → dispose', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    s.store.getState().setDoc({
      project: createProject({ name: 'Altro', author: '', comment: '' }, new Date()),
      filePath: '/a.baap',
      dirty: false,
      revision: 0,
      savedRevision: 0,
    });
    expect(s.workers[0]!.terminated).toBe(true);
    expect(s.store.getState().sim.phase).toBe('off');
  });

  it('guasto del worker: la simulazione si spegne con un messaggio', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    s.workers[0]!.onerror?.({ message: 'boom' });
    expect(s.store.getState().sim.phase).toBe('off');
    expect(s.store.getState().messages.at(-1)!.textKey).toBe('messages.simFailed');
  });
});
