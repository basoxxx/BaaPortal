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
import { applyImport, blockToMc7File, planImport } from '@baaportal/project';
import { commands, type CommandContext } from '../../src/commands/commands';
import { simControllerFor } from '../../src/sim/simController';
import { SimSession } from '../../src/sim/session';
import type { SimWireRequest } from '../../src/sim/protocol';
import { createAppStore } from '../../src/state/store';
import { initI18n } from '../../src/i18n';
import { FakeBridge } from '../fakeBridge';
import { fakeWorker } from './simFixtures';

// Gancio sul compilatore di ogni blocco: i test vi inseriscono eccezioni o eventi a metà compilazione.
const hook = vi.hoisted(() => ({ onBlock: (n: number): void => void n, n: 0 }));
vi.mock('@baaportal/project', async (importOriginal) => {
  const real = await importOriginal<typeof import('@baaportal/project')>();
  return {
    ...real,
    blockToMc7File: (...a: Parameters<typeof real.blockToMc7File>) => {
      hook.onBlock(++hook.n);
      return real.blockToMc7File(...a);
    },
  };
});

const DEV = 'dev1';

function setup(opts: { badFc?: boolean; gate?: Promise<void> } = {}) {
  hook.n = 0;
  hook.onBlock = () => undefined;
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
  const controller = simControllerFor(store, {
    start: async (o) => {
      await opts.gate;
      return SimSession.start({
        ...o,
        createWorker: () => {
          const w = fakeWorker();
          workers.push(w);
          return w;
        },
      });
    },
  });
  const bridge = new FakeBridge();
  const ctx: CommandContext = { store, bridge, service: {} as never };
  const ops = (): SimWireRequest['req']['op'][] =>
    workers.flatMap((w) => w.sent.map((m) => m.req.op));
  return { store, bridge, ctx, workers, ops, controller };
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

  it('MRES chiede conferma e va al worker solo in STOP', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    s.bridge.questionAnswers.push(false);
    await s.controller.memoryReset(s.ctx);
    expect(s.bridge.questions).toHaveLength(1);
    expect(s.ops()).not.toContain('mres');
    await s.controller.memoryReset(s.ctx); // risposta predefinita: sì
    expect(s.ops()).toContain('mres');
    s.store.getState().setSim({ mode: 'RUN' });
    await s.controller.memoryReset(s.ctx);
    expect(s.bridge.questions).toHaveLength(2); // in RUN non chiede nemmeno
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

  it('compilatore che lancia a metà: non si carica nulla e si dice perché', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    hook.onBlock = (n) => {
      if (n === 2) throw new Error('compilatore guasto');
    };
    await commands['online.download'].run(s.ctx);
    expect(s.ops()).toEqual(['start']);
    expect(s.bridge.questions).toHaveLength(0);
    expect(s.store.getState().messages.at(-1)!.textKey).toBe('messages.simDownloadStale');
    expect(s.store.getState().sim.downloading).toBe(false);
  });

  it('un blocco compilato prima e poi modificato non si carica con il file vecchio', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    await commands['online.download'].run(s.ctx);
    const ob = findDevice(s.store.getState().doc!.project, DEV)!.blocks.find(
      (b) => b.kind === 'FC',
    )!;
    s.store.getState().edit('history.test', (p) => {
      const b = findDevice(p, DEV)!.blocks.find((x) => x.id === ob.id);
      if (b && b.kind === 'FC') b.networks[0]!.source = 'A %I0.1\n= %Q0.1';
    });
    hook.n = 0;
    hook.onBlock = (n) => {
      if (n === 1) throw new Error('compilatore guasto');
    };
    const before = s.ops().filter((o) => o === 'download').length;
    await commands['online.download'].run(s.ctx);
    expect(s.ops().filter((o) => o === 'download')).toHaveLength(before);
    expect(s.store.getState().messages.at(-1)!.textKey).toBe('messages.compileFailed');
  });

  it('Simulazione spenta mentre sta partendo: il worker nato dopo è terminato', async () => {
    await initI18n('it');
    let open!: () => void;
    const s = setup({ gate: new Promise<void>((r) => (open = r)) });
    const starting = commands['online.simulation'].run(s.ctx);
    expect(s.store.getState().sim.phase).toBe('starting');
    await commands['online.simulation'].run(s.ctx); // spegne
    expect(s.store.getState().sim.phase).toBe('off');
    open();
    await starting;
    expect(s.store.getState().sim.phase).toBe('off');
    expect(s.workers.every((w) => w.terminated)).toBe(true);
  });

  it('spenta durante la compilazione: nessun caricamento, nessun messaggio', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    const n0 = s.store.getState().messages.length;
    hook.onBlock = (n) => {
      if (n === 1) s.controller.shutdown();
    };
    await commands['online.download'].run(s.ctx);
    expect(s.ops()).toEqual(['start']);
    expect(s.bridge.questions).toHaveLength(0);
    expect(s.store.getState().sim.phase).toBe('off');
    expect(
      s.store
        .getState()
        .messages.slice(n0)
        .map((m) => m.textKey),
    ).not.toContain('messages.simDownloaded');
  });

  it('spenta durante la richiesta di download: niente messaggio, niente domanda', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    const w = s.workers[0]!;
    const post = w.postMessage.bind(w);
    w.postMessage = (m) => {
      if (m.req.op === 'download') s.controller.shutdown();
      post(m);
    };
    const n0 = s.store.getState().messages.length;
    await commands['online.download'].run(s.ctx);
    expect(s.bridge.questions).toHaveLength(0);
    expect(
      s.store
        .getState()
        .messages.slice(n0)
        .map((m) => m.textKey),
    ).toEqual([]);
  });

  it('spenta durante la domanda «Avviare la CPU?»: la CPU non viene avviata', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    s.bridge.askQuestion = async (q) => {
      s.bridge.questions.push(q);
      s.controller.shutdown();
      return true;
    };
    const n0 = s.store.getState().messages.length;
    await commands['online.download'].run(s.ctx);
    expect(s.ops()).not.toContain('mode');
    expect(
      s.store
        .getState()
        .messages.slice(n0)
        .map((m) => m.textKey),
    ).toEqual(['messages.simDownloaded']);
    expect(s.store.getState().sim.phase).toBe('off');
  });

  it('doppio clic su Carica: un solo caricamento, il comando è disabilitato mentre dura', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    let during: boolean | undefined;
    hook.onBlock = (n) => {
      if (n === 1) during = commands['online.download'].isEnabled(s.store.getState());
    };
    const a = commands['online.download'].run(s.ctx);
    const b = commands['online.download'].run(s.ctx);
    await Promise.all([a, b]);
    expect(s.ops().filter((o) => o === 'download')).toHaveLength(1);
    expect(during).toBe(false);
    expect(commands['online.download'].isEnabled(s.store.getState())).toBe(true);
  });

  it('cambio di progetto a metà caricamento: nessuna scrittura nello stato del nuovo progetto', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    hook.onBlock = (n) => {
      if (n === 1)
        s.store.getState().setDoc({
          project: createProject({ name: 'Altro', author: '', comment: '' }, new Date()),
          filePath: '/a.baap',
          dirty: false,
          revision: 0,
          savedRevision: 0,
        });
    };
    const n0 = s.store.getState().messages.length;
    await commands['online.download'].run(s.ctx);
    const st = s.store.getState();
    expect(s.ops()).toEqual(['start']);
    expect(st.sim.phase).toBe('off');
    expect(st.compile.hashes).toEqual({});
    expect(st.compile.files).toEqual({});
    expect(st.messages.slice(n0).map((m) => m.textKey)).toEqual([]);
  });

  it('un blocco importato e non modificato si carica con i suoi byte originali', async () => {
    await initI18n('it');
    const s = setup();
    const cpu = findCpu('cpu-315-2-pn-dp')!;
    const other = createPlcDevice({
      cpu,
      orderNumber: '6ES7 315-2EH14-0AB0',
      firmware: 'V3.3',
      name: 'PLC_X',
      texts: { defaultTagTable: 'Tabella' },
    });
    const src = createCodeBlock({ kind: 'FC', number: 9, name: 'Importato', language: 'AWL' });
    src.networks[0]!.source = 'A %I0.3\n= %Q0.3';
    other.blocks.push(src);
    const blk = blockToMc7File(src, other, cpu, new Date('2026-10-20T10:00:00Z')).file!;
    s.store.getState().edit('history.importBlocks', (p) => {
      const d = findDevice(p, DEV)!;
      applyImport(d, planImport(d, [blk]));
    });
    await on(s);
    await commands['online.download'].run(s.ctx);
    const dl = s.workers[0]!.sent.find((m) => m.req.op === 'download')!.req;
    if (dl.op !== 'download') throw new Error('atteso download');
    expect(dl.files.some((f) => f.length === blk.length && f.every((v, i) => v === blk[i]))).toBe(
      true,
    );
  });

  it('setInputs e interrupt vanno al worker; gli ingressi locali si aggiornano subito', async () => {
    await initI18n('it');
    const s = setup();
    await on(s);
    s.store.getState().setSim({ inputs: new Uint8Array(4) });
    await s.controller.setInputs(1, Uint8Array.of(5));
    await s.controller.interrupt(82, 256);
    expect(s.ops()).toEqual(expect.arrayContaining(['setInputs', 'interrupt']));
    expect(s.store.getState().sim.inputs[1]).toBe(5);
    const sent = s.workers.flatMap((w) => w.sent.map((m) => m.req));
    expect(sent).toContainEqual({ op: 'interrupt', ob: 82, address: 256 });
  });
});
