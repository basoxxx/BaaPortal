import { describe, expect, it, vi } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  addWatchTable,
  createPlcDevice,
  createProject,
  createWatchRow,
  findDevice,
  type PlcDevice,
  type WatchRow,
} from '@baaportal/project';
import { commands, type CommandContext } from '../../src/commands/commands';
import { simControllerFor } from '../../src/sim/simController';
import { SimSession } from '../../src/sim/session';
import { createAppStore } from '../../src/state/store';
import { initI18n } from '../../src/i18n';
import { FakeBridge } from '../fakeBridge';
import { fakeWorker } from './simFixtures';

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
  const table = addWatchTable(dev, 'Prova', () => 'wt1');
  const row = (id: string, operand: string, format: WatchRow['format'], modify?: string) => {
    const r = createWatchRow(operand, format, () => id);
    if (modify !== undefined) r.modify = modify;
    table.rows.push(r);
  };
  row('r-mw', 'MW10', 'DEC', '-5');
  row('r-bit', 'M 0.1', 'BOOL', 'TRUE');
  row('r-bad', '"Inesistente"', 'DEC', '1');
  row('r-range', 'MB20', 'DEC', '300');
  row('r-timer', 'T 1', 'S5TIME');
  row('r-tw', 'T 2', 'S5TIME', 'S5T#1S');
  const t2 = addWatchTable(dev, 'Seconda', () => 'wt2');
  t2.rows.push(createWatchRow('MB5', 'HEX', () => 'q1'));
  project.devices.push(dev);
  store
    .getState()
    .setDoc({ project, filePath: '/p.baap', dirty: false, revision: 0, savedRevision: 0 });
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const failures = { watch: 0 };
  simControllerFor(store, {
    start: async (o) => {
      const s = await SimSession.start({
        ...o,
        createWorker: () => {
          const w = fakeWorker();
          workers.push(w);
          return w;
        },
      });
      const orig = s.request.bind(s);
      s.request = ((req: Parameters<typeof orig>[0]) =>
        req.op === 'watch' && failures.watch > 0
          ? (failures.watch--, Promise.reject(new Error('rifiutata')))
          : orig(req)) as typeof s.request;
      return s;
    },
  });
  const ctx: CommandContext = { store, bridge: new FakeBridge(), service: {} as never };
  const ops = () => workers.flatMap((w) => w.sent.map((m) => m.req));
  const watchReqs = () => ops().filter((r) => r.op === 'watch');
  return { store, ctx, ops, watchReqs, failures };
}

const st = (s: ReturnType<typeof setup>) => s.store.getState();
const ctl = (s: ReturnType<typeof setup>) => simControllerFor(s.store);
const open = (s: ReturnType<typeof setup>) =>
  st(s).openEditor({ kind: 'watchTable', deviceId: DEV, objectId: 'wt1' });
const table = (s: ReturnType<typeof setup>) => findDevice(st(s).doc!.project, DEV)!.watchTables[0]!;

describe('tabelle di controllo sul simulatore', () => {
  it('osserva: solo le righe valide, valori grezzi per riga; si ferma chiudendo la tabella', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    expect(st(s).sim.watch).toEqual([{ deviceId: DEV, tableId: 'wt1' }]);
    await vi.waitFor(() => expect(st(s).sim.watchValues).not.toBeNull());
    // il simbolo sconosciuto non si osserva; T e C sì (anche quello che non si può scrivere)
    expect(Object.keys(st(s).sim.watchValues!).sort()).toEqual([
      'r-bit',
      'r-mw',
      'r-range',
      'r-timer',
      'r-tw',
    ]);
    expect(st(s).sim.watchValues!['r-mw']).toEqual({ bytes: Uint8Array.of(0, 0) });
    expect(st(s).sim.watchValues!['r-bit']).toEqual({ bytes: Uint8Array.of(0) });
    expect(st(s).sim.watchValues!['r-timer']).toEqual({ bytes: Uint8Array.of(0, 0) });
    expect(s.watchReqs()).toHaveLength(1);
    expect((s.watchReqs()[0] as { items: unknown[] }).items).toHaveLength(5);
    // chiudere l'editor ferma l'osservazione
    st(s).closeAllEditors();
    expect(st(s).sim.watch).toEqual([]);
    expect(st(s).sim.watchValues).toBeNull();
    await vi.waitFor(() => expect(s.watchReqs().at(-1)).toEqual({ op: 'watch', items: [] }));
  });

  it('comanda: scrive le righe valide e riporta gli errori per riga senza bloccare le altre', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    const res = await ctl(s).commandWatch(DEV, 'wt1');
    expect(res!.written).toBe(2);
    expect(Object.keys(res!.errors).sort()).toEqual(['r-bad', 'r-range', 'r-tw']);
    expect(res!.errors['r-bad']!.key).toBe('row.UNKNOWN');
    expect(res!.errors['r-range']).toMatchObject({ key: 'RANGE' });
    expect(res!.errors['r-tw']).toEqual({ key: 'TC_WRITE' });
    await vi.waitFor(() => {
      const v = st(s).sim.watchValues;
      expect(v?.['r-mw']).toEqual({ bytes: Uint8Array.of(0xff, 0xfb) });
      expect(v?.['r-bit']).toEqual({ bytes: Uint8Array.of(1) });
    });
  });

  it('una modifica alle righe manda le voci nuove; le notifiche vecchie non si applicano', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    await vi.waitFor(() => expect(st(s).sim.watchValues).not.toBeNull());
    st(s).edit('history.editCell', (p) => {
      findDevice(p, DEV)!.watchTables[0]!.rows = [createWatchRow('MB5', 'HEX', () => 'r-new')];
    });
    await vi.waitFor(() => expect(s.watchReqs()).toHaveLength(2));
    expect((s.watchReqs()[1] as { items: unknown[] }).items).toEqual([
      { area: 'M', byte: 5, size: 'B' },
    ]);
    await vi.waitFor(() => expect(Object.keys(st(s).sim.watchValues ?? {})).toEqual(['r-new']));
  });

  it('una richiesta rifiutata si ripete alla prossima occasione, con un solo messaggio', async () => {
    await initI18n('it');
    const s = setup();
    s.failures.watch = 1;
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    await vi.waitFor(() =>
      expect(st(s).messages.some((m) => m.textKey === 'messages.simWatchFailed')).toBe(true),
    );
    // la notifica di stato (ogni 200 ms) fa ripartire l'allineamento
    await vi.waitFor(() => expect(st(s).sim.watchValues).not.toBeNull());
    expect(st(s).messages.filter((m) => m.textKey === 'messages.simWatchFailed')).toHaveLength(1);
  });

  it('spegnere la simulazione azzera osservazione e valori; «Osserva tutto» due volte spegne', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    ctl(s).toggleWatch(DEV, 'wt1');
    expect(st(s).sim.watch).toEqual([]);
    ctl(s).toggleWatch(DEV, 'wt1');
    await commands['online.simulation'].run(s.ctx);
    expect(st(s).sim.watch).toEqual([]);
    expect(st(s).sim.watchValues).toBeNull();
    expect(await ctl(s).commandWatch(DEV, 'wt1')).toBeNull();
    // senza simulazione non si osserva
    ctl(s).toggleWatch(DEV, 'wt1');
    expect(st(s).sim.watch).toEqual([]);
    expect(table(s).rows).toHaveLength(6);
  });

  it('due tabelle visibili (riquadri divisi) si osservano insieme in una sola richiesta', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    st(s).setSplit('vertical');
    st(s).focusPane(1);
    st(s).openEditor({ kind: 'watchTable', deviceId: DEV, objectId: 'wt2' });
    ctl(s).toggleWatch(DEV, 'wt1');
    ctl(s).toggleWatch(DEV, 'wt2');
    expect(st(s).sim.watch).toHaveLength(2);
    await vi.waitFor(() =>
      expect(Object.keys(st(s).sim.watchValues ?? {})).toEqual(
        expect.arrayContaining(['r-mw', 'q1']),
      ),
    );
    expect((s.watchReqs().at(-1) as { items: unknown[] }).items).toHaveLength(6);
    // spegnerne una lascia l'altra
    ctl(s).toggleWatch(DEV, 'wt1');
    expect(st(s).sim.watch).toEqual([{ deviceId: DEV, tableId: 'wt2' }]);
    await vi.waitFor(() => expect(Object.keys(st(s).sim.watchValues ?? {})).toEqual(['q1']));
  });

  it('passando da una tabella all altra le notifiche della vecchia non si applicano', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    await vi.waitFor(() => expect(st(s).sim.watchValues).not.toBeNull());
    st(s).openEditor({ kind: 'watchTable', deviceId: DEV, objectId: 'wt2' });
    expect(st(s).sim.watch).toEqual([]); // la prima non è più visibile
    expect(st(s).sim.watchValues).toBeNull();
    ctl(s).toggleWatch(DEV, 'wt2');
    await vi.waitFor(() => expect(Object.keys(st(s).sim.watchValues ?? {})).toEqual(['q1']));
    await new Promise((r) => setTimeout(r, 450)); // altre notifiche: mai righe della prima
    expect(Object.keys(st(s).sim.watchValues!)).toEqual(['q1']);
  });

  it('cambiata la voce di una riga (MW10 → MD10) il vecchio valore sparisce subito', async () => {
    await initI18n('it');
    const s = setup();
    await commands['online.simulation'].run(s.ctx);
    open(s);
    ctl(s).toggleWatch(DEV, 'wt1');
    await vi.waitFor(() => expect(st(s).sim.watchValues?.['r-mw']).toBeDefined());
    expect(st(s).sim.watchValues!['r-mw']).toEqual({ bytes: Uint8Array.of(0, 0) });
    st(s).edit('history.editCell', (p) => {
      findDevice(p, DEV)!.watchTables[0]!.rows[0]!.operand = 'MD10';
    });
    // sincrono: nessun valore a 2 byte per una voce a 4
    expect(st(s).sim.watchValues?.['r-mw']).toBeUndefined();
    expect(st(s).sim.watchValues?.['r-bit']).toBeDefined(); // le altre righe restano
    await vi.waitFor(() =>
      expect(st(s).sim.watchValues?.['r-mw']).toEqual({ bytes: Uint8Array.of(0, 0, 0, 0) }),
    );
  });
});
