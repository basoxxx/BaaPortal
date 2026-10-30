import { describe, expect, it, vi } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import { createPlcDevice, createProject, type WatchTarget } from '@baaportal/project';
import { commands, type CommandContext } from '../../src/commands/commands';
import { simHmiLink } from '../../src/editors/hmi/hmiLinks';
import { SimSession } from '../../src/sim/session';
import { simControllerFor } from '../../src/sim/simController';
import { createAppStore } from '../../src/state/store';
import { initI18n } from '../../src/i18n';
import { FakeBridge } from '../fakeBridge';
import { fakeWorker, ob1 } from './simFixtures';

const DEV = 'dev1';

async function setup() {
  await initI18n('it');
  const store = createAppStore();
  const project = createProject({ name: 'P', author: '', comment: '' }, new Date());
  let n = 0;
  project.devices.push(
    createPlcDevice({
      cpu: findCpu('cpu-315-2-pn-dp')!,
      orderNumber: '6ES7 315-2EH14-0AB0',
      firmware: 'V3.3',
      name: 'PLC_1',
      texts: { defaultTagTable: 'Tabella' },
      newId: () => (n++ === 0 ? DEV : `id${n}`),
    }),
  );
  store
    .getState()
    .setDoc({ project, filePath: '/p.baap', dirty: false, revision: 0, savedRevision: 0 });
  let session: SimSession | undefined;
  simControllerFor(store, {
    start: async (o) => (session = await SimSession.start({ ...o, createWorker: fakeWorker })),
  });
  const ctx: CommandContext = { store, bridge: new FakeBridge(), service: {} as never };
  await commands['online.simulation'].run(ctx);
  return { store, session: session! };
}

const JOG: WatchTarget = { area: 'M', byte: 0, bit: 2, size: 'X' };
const OUT: WatchTarget = { area: 'Q', byte: 4, bit: 0, size: 'X' };

describe('runtime HMI sul simulatore', () => {
  it('pulsante a impulsi su M 0.2 con «A M 0.2 / = Q 4.0»: premuto → uscita accesa, rilasciato → spenta', async () => {
    const { store, session } = await setup();
    await session.request({ op: 'download', files: [ob1(['A M 0.2\n= Q 4.0'])] });
    await session.request({ op: 'mode', to: 'RUN' });
    const link = simHmiLink(store, DEV);
    link.setPlan(['out'], [OUT]);
    link.start();
    await vi.waitFor(() =>
      expect(link.getState().values?.['out']).toEqual({ bytes: Uint8Array.of(0) }),
    );
    expect(await link.write(JOG, Uint8Array.of(1))).toBe(null);
    await vi.waitFor(() =>
      expect(link.getState().values?.['out']).toEqual({ bytes: Uint8Array.of(1) }),
    );
    expect(await link.write(JOG, Uint8Array.of(0))).toBe(null);
    await vi.waitFor(() =>
      expect(link.getState().values?.['out']).toEqual({ bytes: Uint8Array.of(0) }),
    );
    link.stop();
  });

  it('una voce non leggibile dà il suo errore; spenta la simulazione la lettura si ferma', async () => {
    const { store } = await setup();
    const link = simHmiLink(store, DEV);
    link.setPlan(['db'], [{ area: 'DB', db: 9, byte: 0, size: 'W' }]);
    link.start();
    await vi.waitFor(() =>
      expect(link.getState().values?.['db']).toEqual({ error: 'DB9 non caricato' }),
    );
    expect(await link.write({ area: 'DB', db: 9, byte: 0, size: 'W' }, Uint8Array.of(0, 1))).toBe(
      'DB9 non caricato',
    );
    simControllerFor(store).shutdown();
    await vi.waitFor(() => expect(link.getState().running).toBe(false));
    expect(await link.write(JOG, Uint8Array.of(1))).toBe('Simulazione non attiva');
  });
});
