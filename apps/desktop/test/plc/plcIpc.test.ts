import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerPlc } from '../../src/main/plc/plcIpc';
import type { PlcOwner } from '../../src/main/plc/plcService';

type Listener = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

class Sender implements PlcOwner {
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
  once(): void {}
  removeListener(): void {}
}

describe("registerPlc: canali dell'osservazione", () => {
  const channels = new Map<string, Listener>();
  const reg = registerPlc((c, l) => void channels.set(c, l), vi.fn());
  const e = { sender: new Sender() } as unknown as IpcMainInvokeEvent;

  it('registra i canali plc:status*', () => {
    for (const c of ['plc:statusStart', 'plc:statusWindow', 'plc:statusRead', 'plc:statusStop']) {
      expect(channels.has(c), c).toBe(true);
    }
    expect(reg.writing()).toBe(false);
  });

  it('senza osservazione: read → ended, window → errore, stop ok; start non valida → errore', async () => {
    expect(await channels.get('plc:statusRead')!(e)).toMatchObject({ ok: false, ended: true });
    expect(channels.get('plc:statusWindow')!(e, {})).toMatchObject({ ok: false });
    await expect(channels.get('plc:statusStop')!(e)).resolves.toBeUndefined();
    expect(await channels.get('plc:statusStart')!(e, 42)).toMatchObject({
      ok: false,
      reason: 'error',
    });
  });

  it('closeAll senza collegamenti non fallisce', async () => {
    await expect(reg.closeAll()).resolves.toBeUndefined();
  });
});
