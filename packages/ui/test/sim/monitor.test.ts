import { describe, expect, it, vi } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import { networkStatus } from '@baaportal/ladfbd';
import { SimCpu } from '@baaportal/sim';
import {
  blockToMc7File,
  createCodeBlock,
  createPlcDevice,
  kopSources,
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
import { PROPS, fakeWorker } from './simFixtures';

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
  ob.networks[0]!.source = '// avvio\nL 42\nL 17\nBE';
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
  return { store, ctx, ops, monitorReqs, ob, fc, workers };
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
    expect(cells.get(2)!.accu1).toBe(17); // una riga sfasata di una non passerebbe
    expect(cells.get(2)!.accu2).toBe(42);
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

  it("blocco SCL: si chiede l'ultima esecuzione nel ciclo (i cicli mostrano l'ultimo giro)", async () => {
    await initI18n('it');
    const s = setup();
    const scl = createCodeBlock({ kind: 'FC', number: 6, name: 'S', language: 'SCL' });
    scl.networks[0]!.source = 'MW20 := 1;';
    st(s).edit('history.addBlock', (p) => void findDevice(p, DEV)!.blocks.push(scl));
    await commands['online.simulation'].run(s.ctx);
    open(s, scl.id);
    await commands['online.download'].run(s.ctx);
    await commands['online.monitor'].run(s.ctx);
    await vi.waitFor(() =>
      expect(s.monitorReqs().at(-1)).toEqual({
        op: 'monitor',
        block: { kind: 'FC', number: 6, last: true },
      }),
    );
    // la notifica del blocco osservato passa (stessa chiave della richiesta)
    st(s).setSim({ monitorSteps: null });
    await vi.waitFor(() => expect(st(s).sim.monitorSteps).not.toBeNull());
  });

  it("riquadri divisi: «Osserva» prende il blocco del riquadro con il fuoco; l'altro riquadro non lo ferma", async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    st(s).setSplit('vertical');
    st(s).focusPane(1);
    open(s, s.fc.id);
    expect(st(s).workArea.panes).toEqual([`block:${DEV}:${s.ob.id}`, `block:${DEV}:${s.fc.id}`]);
    await commands['online.download'].run(s.ctx);
    await commands['online.monitor'].run(s.ctx);
    expect(st(s).sim.monitor?.blockId).toBe(s.fc.id);
    await vi.waitFor(() => expect(st(s).sim.monitor?.reason).toBe('ok'));
    await vi.waitFor(() =>
      expect(s.monitorReqs().at(-1)).toEqual({ op: 'monitor', block: { kind: 'FC', number: 5 } }),
    );
    // un altro blocco nell'altro riquadro: l'osservazione continua
    st(s).focusPane(0);
    open(s, s.ob.id);
    expect(st(s).sim.monitor?.blockId).toBe(s.fc.id);
    // non più visibile in nessun riquadro: si ferma
    st(s).closeAllEditors();
    expect(st(s).sim.monitor).toBeNull();
  });

  it('una richiesta rifiutata si ripete e la sua notifica non passa', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.download'].run(s.ctx);
    const real = SimSession.prototype.request;
    let rejected = 0;
    const spy = vi.spyOn(SimSession.prototype, 'request').mockImplementation(function (
      this: SimSession,
      req,
    ) {
      if (req.op === 'monitor' && req.block && rejected++ === 0)
        return Promise.reject(new Error('no'));
      return real.call(this, req);
    });
    try {
      await commands['online.monitor'].run(s.ctx);
      await vi.waitFor(() => expect(rejected).toBeGreaterThanOrEqual(2)); // ritentata
      await vi.waitFor(() => expect(st(s).sim.monitorSteps).not.toBeNull());
      expect(st(s).messages.filter((m) => m.textKey === 'messages.simMonitorFailed')).toHaveLength(
        1,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('una notifica di un blocco non più osservato si scarta', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s, s.ob.id);
    await commands['online.download'].run(s.ctx);
    await commands['online.monitor'].run(s.ctx);
    await vi.waitFor(() => expect(st(s).sim.monitorSteps).not.toBeNull());
    const late = (kind: 'OB' | 'FC', number: number) =>
      s.workers[0]!.onmessage!({
        data: {
          type: 'notice',
          notice: {
            kind: 'monitor',
            block: { kind, number },
            steps: [
              {
                offset: 0,
                rlo: true,
                sta: true,
                stw: 0,
                accu1: 99,
                accu2: 0,
                ar1: 0,
                db: 0,
                di: 0,
              },
            ],
          },
        },
      });
    // spento: arriva una notifica in ritardo
    await commands['online.monitor'].run(s.ctx);
    expect(st(s).sim.monitorSteps).toBeNull();
    late('OB', 1);
    expect(st(s).sim.monitorSteps).toBeNull();
    // acceso su OB1, ma la notifica è di un altro blocco
    await commands['online.monitor'].run(s.ctx);
    await vi.waitFor(() => expect(st(s).sim.monitorSteps).not.toBeNull());
    st(s).setSim({ monitorSteps: null });
    late('FC', 5);
    expect(st(s).sim.monitorSteps).toBeNull();
  });
});

describe('osservazione di un blocco KOP', () => {
  it('compilato, eseguito da OB1 nel simulatore: gli elementi hanno lo stato del ciclo', () => {
    const dev = findDevice(setup().store.getState().doc!.project, DEV)!;
    const ob = dev.blocks.find((b) => b.kind === 'OB' && b.number === 1) as CodeBlock;
    ob.networks[0]!.source = 'SET\n= I 0.0\n= I 0.1\nCALL FC 1';
    const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'Logica', language: 'KOP' });
    const lad = {
      root: {
        id: 'n0',
        series: [
          { id: 'a', k: 'contact' as const, neg: false, op: 'I 0.0' },
          { id: 'b', k: 'contact' as const, neg: false, op: 'I 0.1' },
        ],
        outs: [{ id: 'q', k: 'coil' as const, op: 'Q 4.0' }],
      },
    };
    fc.networks[0]!.lad = lad;
    dev.blocks = dev.blocks.filter((b) => b.kind !== 'FC');
    dev.blocks.push(fc);
    const cpuType = findCpu(dev.cpu.typeId)!;
    const cpu = new SimCpu({ cpuTypeId: cpuType.id, props: PROPS });
    let lines;
    for (const b of dev.blocks) {
      const r = blockToMc7File(b, dev, cpuType);
      cpu.loadBlock(r.file!);
      if (b === fc) lines = r.lines;
    }
    cpu.setMonitor({ kind: 'FC', number: 1 });
    cpu.run();
    cpu.cycle();
    expect(cpu.memory.Q[4]).toBe(1);
    const cells = monitorLinesByNetwork(lines!, cpu.monitorSnapshot()!, false).get(0)!.cells;
    const status = networkStatus(lad, kopSources(fc, dev)[0]!.lines, cells);
    expect(status.get('a')).toEqual({ in: true, sta: true, out: true });
    expect(status.get('b')).toEqual({ in: true, sta: true, out: true });
    expect(status.get('q')).toEqual({ in: true, out: true });
  });
});
