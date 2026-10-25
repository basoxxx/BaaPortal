import { describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import type { ConfirmFn } from '../../src/main/plc/confirm';
import { registerPlc } from '../../src/main/plc/plcIpc';
import { PlcService } from '../../src/main/plc/plcService';
import { PlcWriteService, type PlcWriteOwner } from '../../src/main/plc/plcWrite';
import { UploadService } from '../../src/main/plc/uploadAll';

class Owner implements PlcWriteOwner {
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
  once(): void {}
  removeListener(): void {}
}

type H = (e: unknown, ...a: unknown[]) => Promise<unknown>;

const access = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };
const target = { access, identity: { orderNumber: '6ES7 315-2EH14-0AB0' }, linkId: 1 };

/** Collegamento che resta in attesa finché il test non lo rilascia. */
function gate() {
  let release!: () => void;
  const p = new Promise<never>((_, reject) => {
    release = () => reject(new Error('rilasciato'));
  });
  return { p, release };
}

function setup(opts: { pick?: () => Promise<string | null> } = {}) {
  const handlers = new Map<string, H>();
  const g = gate();
  const confirm = vi.fn<ConfirmFn>(async () => true);
  // Il backup chiede il bersaglio del collegamento online della finestra.
  const service = {
    target: () => target,
    closeAll: async () => undefined,
  } as unknown as PlcService;
  const writes = new PlcWriteService({
    service,
    confirm,
    connect: () => g.p,
  });
  const uploads = new UploadService({ connect: () => g.p, connectTimeoutMs: 50 });
  const plc = registerPlc(
    (ch, l) => handlers.set(ch, l as H),
    confirm,
    service,
    undefined,
    writes,
    uploads,
    opts.pick ?? (async () => null),
  );
  return { handlers, plc, g };
}

describe('busy di registerPlc', () => {
  it('è falso a riposo', () => {
    expect(setup().plc.busy()).toBe(false);
  });

  it('vero durante una scrittura nel dispositivo, falso dopo', async () => {
    const { handlers, plc, g } = setup();
    const e = { sender: new Owner() };
    const p = handlers.get('plc:control')!(e, 'STOP');
    await vi.waitFor(() => expect(plc.busy()).toBe(true));
    g.release();
    await p;
    expect(plc.busy()).toBe(false);
  });

  it('vero durante il caricamento dal dispositivo, falso dopo', async () => {
    const { handlers, plc, g } = setup();
    const e = { sender: new Owner() };
    const p = handlers.get('plc:uploadAll')!(e, access);
    await vi.waitFor(() => expect(plc.busy()).toBe(true));
    g.release();
    await p;
    expect(plc.busy()).toBe(false);
  });

  it('vero durante il backup (anche alla finestra di salvataggio), falso dopo', async () => {
    let finishPick!: (v: string | null) => void;
    const pick = () => new Promise<string | null>((r) => (finishPick = r));
    const { handlers, plc } = setup({ pick });
    const e = { sender: new Owner() };
    const p = handlers.get('plc:backup')!(e);
    await vi.waitFor(() => expect(plc.busy()).toBe(true));
    finishPick(null);
    await p;
    expect(plc.busy()).toBe(false);
  });

  it('dopo closeAll nessun caricamento né backup parte, finché non si chiama resume', async () => {
    const { handlers, plc } = setup();
    const e = { sender: new Owner() };
    await plc.closeAll();
    expect(await handlers.get('plc:uploadAll')!(e, access)).toMatchObject({
      ok: false,
      error: 'Chiusura in corso',
    });
    expect(await handlers.get('plc:backup')!(e)).toMatchObject({
      ok: false,
      error: 'Chiusura in corso',
    });
    expect(await handlers.get('plc:control')!(e, 'STOP')).toMatchObject({ ok: false });
    plc.resume();
    const p = handlers.get('plc:uploadAll')!(e, access);
    await vi.waitFor(() => expect(plc.busy()).toBe(true));
    await plc.closeAll();
    await p;
  });
});
