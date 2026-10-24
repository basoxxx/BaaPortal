import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createPlcDevice,
  createProject,
  findDevice,
  type CodeBlock,
  type PlcDevice,
} from '@baaportal/project';
import { commands, type CommandContext } from '../../src/commands/commands';
import { simControllerFor } from '../../src/sim/simController';
import { SimSession } from '../../src/sim/session';
import { createAppStore } from '../../src/state/store';
import { monitorLinesByNetwork } from '../../src/editors/awl/monitorExtension';
import { initI18n } from '../../src/i18n';
import { FakeBridge } from '../fakeBridge';
import { fakeWorker } from './simFixtures';
import { vi } from 'vitest';

const DEV = 'dev1';

function setup() {
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
  // il dispositivo nuovo ha già l'OB1 «Main»
  const ob = dev.blocks.find((b) => b.kind === 'OB' && b.number === 1) as CodeBlock;
  // riga 0: commento, 1: L, 2: T; la rete 2 resta vuota
  ob.networks[0]!.source = '// avvio\nL 42\nT MW 10\nBE';
  const fc = createCodeBlock({ kind: 'FC', number: 5, name: 'FC5', language: 'AWL' });
  fc.networks[0]!.source = 'L 7\nT MW 20';
  dev.blocks.push(fc);
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
  const ctx: CommandContext = { store, bridge: new FakeBridge(), service: {} as never };
  const ops = () => workers.flatMap((w) => w.sent.map((m) => m.req));
  const monitorReqs = () => ops().filter((r) => r.op === 'monitor');
  return { store, ctx, ops, monitorReqs, ob, fc };
}

const open = (s: ReturnType<typeof setup>, blockId: string) =>
  s.store.getState().openEditor({ kind: 'block', deviceId: DEV, objectId: blockId });
const st = (s: ReturnType<typeof setup>) => s.store.getState();

describe('osservazione del programma', () => {
  it('il comando è disabilitato senza simulazione o senza un blocco di codice aperto', async () => {
    await initI18n('it');
    const s = setup();
    open(s, s.ob.id);
    expect(commands['online.monitor'].isEnabled(st(s))).toBe(false); // simulazione spenta
    await commands['online.simulation'].run(s.ctx);
    expect(commands['online.monitor'].isEnabled(st(s))).toBe(true);
    st(s).closeAllEditors();
    expect(commands['online.monitor'].isEnabled(st(s))).toBe(false);
  });

  it('non caricato: motivo notLoaded e nessuna richiesta al worker', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.monitor'].run(s.ctx);
    expect(st(s).sim.monitor).toMatchObject({ blockId: s.ob.id, reason: 'notLoaded' });
    expect(s.monitorReqs()).toEqual([]);
    expect(commands['online.monitor'].isChecked?.(st(s))).toBe(true);
  });

  it('dopo il caricamento arrivano i passi; le righe si mappano sul testo', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.monitor'].run(s.ctx);
    await commands['online.download'].run(s.ctx); // chiede di avviare la CPU: sì
    await vi.waitFor(() => expect(st(s).sim.mode).toBe('RUN'));
    await vi.waitFor(() => expect(st(s).sim.monitor?.reason).toBe('ok'));
    expect(s.monitorReqs().at(-1)).toEqual({ op: 'monitor', block: { kind: 'OB', number: 1 } });
    await vi.waitFor(() => expect(st(s).sim.monitorSteps?.length).toBeGreaterThan(0));
    const lines = monitorLinesByNetwork(
      st(s).compile.lines[s.ob.id]!,
      st(s).sim.monitorSteps!,
      true,
    );
    const cells = lines.get(0)!.cells;
    expect(cells.has(0)).toBe(false); // il commento non ha istruzioni
    expect(cells.get(1)!.accu1).toBe(42);
    expect(cells.get(3)).not.toBeNull(); // BE
  });

  it('una modifica al testo sospende (stale) e il nuovo caricamento riprende', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.download'].run(s.ctx);
    await commands['online.monitor'].run(s.ctx);
    await vi.waitFor(() => expect(st(s).sim.monitor?.reason).toBe('ok'));
    await vi.waitFor(() => expect(st(s).sim.monitorSteps).not.toBeNull());
    st(s).edit('history.editNetworkCode', (p) => {
      findDevice(p, DEV)!.blocks.find((b) => b.id === s.ob.id)!.networks[0]!.source =
        '// avvio\nL 43\nT MW 10\nBE';
    });
    expect(st(s).sim.monitor?.reason).toBe('stale');
    expect(st(s).sim.monitorSteps).toBeNull();
    await vi.waitFor(() => expect(s.monitorReqs().at(-1)).toEqual({ op: 'monitor' }));
    await commands['online.download'].run(s.ctx);
    await vi.waitFor(() => expect(st(s).sim.monitor?.reason).toBe('ok'));
    await vi.waitFor(() => expect(s.monitorReqs().at(-1)).toMatchObject({ block: { number: 1 } }));
    await vi.waitFor(() => {
      const steps = st(s).sim.monitorSteps;
      expect(steps?.some((x) => x.accu1 === 43)).toBe(true);
    });
  });

  it("cambiare blocco o chiudere l'editor ferma l'osservazione", async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.download'].run(s.ctx);
    await commands['online.monitor'].run(s.ctx);
    await vi.waitFor(() => expect(st(s).sim.monitor?.reason).toBe('ok'));
    open(s, s.fc.id);
    expect(st(s).sim.monitor).toBeNull();
    await vi.waitFor(() => expect(s.monitorReqs().at(-1)).toEqual({ op: 'monitor' }));
    // di nuovo, poi si chiude l'editor
    open(s, s.ob.id);
    await commands['online.monitor'].run(s.ctx);
    expect(st(s).sim.monitor).not.toBeNull();
    st(s).closeAllEditors();
    expect(st(s).sim.monitor).toBeNull();
  });

  it('blocco importato senza righe: noLines', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.download'].run(s.ctx);
    // come per un blocco importato non modificato: file senza mappa
    s.store.setState((x) => {
      const lines = { ...x.compile.lines };
      delete lines[s.ob.id];
      return { compile: { ...x.compile, lines } };
    });
    await commands['online.monitor'].run(s.ctx);
    expect(st(s).sim.monitor?.reason).toBe('noLines');
    expect(s.monitorReqs().filter((r) => r.block)).toEqual([]);
  });

  it("spegnere la simulazione azzera l'osservazione", async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.monitor'].run(s.ctx);
    await commands['online.simulation'].run(s.ctx);
    expect(st(s).sim.monitor).toBeNull();
    expect(st(s).sim.loaded).toEqual({});
  });
});
