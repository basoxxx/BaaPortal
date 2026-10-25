import { describe, expect, it, vi } from 'vitest';
import {
  createInterruptAsk,
  INTERRUPT_MESSAGE,
  WriteCloseGuard,
} from '../../src/main/plc/closeGuard';

describe('WriteCloseGuard', () => {
  it('senza scrittura in corso non chiede nulla', () => {
    const ask = vi.fn(async () => true);
    const g = new WriteCloseGuard(() => false, ask);
    expect(g.needsConfirm()).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('con una scrittura chiede; «Annulla» tiene aperto e richiede la volta dopo', async () => {
    const ask = vi.fn(async () => false);
    const g = new WriteCloseGuard(() => true, ask);
    expect(g.needsConfirm()).toBe(true);
    expect(await g.confirm()).toBe(false);
    expect(g.needsConfirm()).toBe(true);
  });

  it('«Interrompi» vale finché la scrittura dura: finestra e uscita non chiedono due volte', async () => {
    let writing = true;
    const ask = vi.fn(async () => true);
    const g = new WriteCloseGuard(() => writing, ask);
    expect(await g.confirm()).toBe(true);
    expect(g.needsConfirm()).toBe(false);
    writing = false;
    expect(g.needsConfirm()).toBe(false);
    // Una nuova scrittura chiede di nuovo.
    writing = true;
    expect(g.needsConfirm()).toBe(true);
  });

  it('una sola domanda alla volta; una domanda che lancia vale «Annulla»', async () => {
    let release!: (v: boolean) => void;
    const ask = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const g = new WriteCloseGuard(() => true, ask);
    const p1 = g.confirm();
    const p2 = g.confirm();
    release(true);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    const bad = new WriteCloseGuard(
      () => true,
      async () => {
        throw new Error('x');
      },
    );
    expect(await bad.confirm()).toBe(false);
  });
});

describe('createInterruptAsk', () => {
  const WIN = { isDestroyed: () => false } as never;

  it('«Annulla» è predefinito e di fuga; solo «Interrompi» conferma', async () => {
    const show = vi.fn<(w: unknown, o: unknown) => Promise<{ response: number }>>(async () => ({
      response: 1,
    }));
    const ask = createInterruptAsk({ showMessageBox: show } as never, () => WIN);
    expect(await ask()).toBe(true);
    expect(show.mock.calls[0]![1]).toMatchObject({
      buttons: ['Annulla', 'Interrompi'],
      defaultId: 0,
      cancelId: 0,
      message: INTERRUPT_MESSAGE,
    });
    show.mockResolvedValueOnce({ response: 0 });
    expect(await ask()).toBe(false);
  });

  it('senza finestra non mostra nulla e non interrompe', async () => {
    const show = vi.fn();
    const ask = createInterruptAsk({ showMessageBox: show } as never, () => null);
    expect(await ask()).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });
});
