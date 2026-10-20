import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSaveDialog = vi.fn();
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: (...a: unknown[]) => showSaveDialog(...a) },
}));

let release: (() => void) | null = null;
vi.mock('@baaportal/s7comm', () => ({ kitZip: () => new Uint8Array([1, 2, 3]) }));
vi.mock('@baaportal/s7comm/node', () => ({
  collectTcp: (_o: unknown, _p: unknown, signal: AbortSignal) =>
    new Promise((resolve) => {
      const done = () => resolve({ summary: { identity: { orderNumber: 'X' } } });
      release = done;
      signal.addEventListener('abort', done);
    }),
}));
const writeFileAtomic = vi.fn();
vi.mock('../src/main/fsAtomic', () => ({
  writeFileAtomic: (...a: unknown[]) => writeFileAtomic(...a),
}));

import { registerKit } from '../src/main/kit';

type Listener = (e: { sender: unknown }, ...a: unknown[]) => unknown;
const sender = () => ({
  once: vi.fn(),
  removeListener: vi.fn(),
  isDestroyed: () => false,
  send: vi.fn(),
});

const opts = {
  host: '10.0.0.5',
  port: 102,
  rack: 0,
  slot: 2,
  connectionType: 'pg',
  includeBlocks: false,
};

describe('kit: legato alla finestra che lo avvia', () => {
  let ch: Map<string, Listener>;
  beforeEach(() => {
    ch = new Map();
    release = null;
    showSaveDialog.mockReset();
    writeFileAtomic.mockReset();
    registerKit(((c: string, l: Listener) => ch.set(c, l)) as never);
  });
  const call = (c: string, s: unknown, ...a: unknown[]) => ch.get(c)!({ sender: s }, ...a);

  it('kit:cancel da un altro mittente è ignorato; dal proprietario interrompe', async () => {
    const a = sender();
    const b = sender();
    const run = call('kit:start', a, opts) as Promise<{ ok: boolean }>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(call('kit:cancel', b)).toBe(false);
    expect(call('kit:cancel', a)).toBe(true);
    expect((await run).ok).toBe(true);
  });

  it('una raccolta finita si salva da qualunque finestra fidata (la proprietaria potrebbe non esserci più)', async () => {
    const a = sender();
    const b = sender();
    showSaveDialog.mockResolvedValue({ canceled: true });
    const run = call('kit:start', a, opts) as Promise<{ ok: boolean; savedTo: string | null }>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    expect((await run).savedTo).toBeNull();
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/x.zip' });
    expect(await call('kit:save', b)).toEqual({ ok: true, path: '/tmp/x.zip' });
    expect(writeFileAtomic).toHaveBeenCalledTimes(1);
  });

  it('kit:save senza nessuna raccolta dà ok:false e non scrive', async () => {
    const r = (await call('kit:save', sender())) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(writeFileAtomic).not.toHaveBeenCalled();
  });

  it('kit:hasUnsaved: dopo una raccolta non salvata dà il riepilogo; dopo un salvataggio riuscito o una nuova raccolta è null', async () => {
    const a = sender();
    expect(await call('kit:hasUnsaved', a)).toBeNull();
    showSaveDialog.mockResolvedValue({ canceled: true });
    let run = call('kit:start', a, opts) as Promise<unknown>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await run;
    expect(await call('kit:hasUnsaved', sender())).toEqual({ identity: { orderNumber: 'X' } });
    // un salvataggio annullato non lo cancella
    expect(await call('kit:save', a)).toEqual({ ok: true, path: null });
    expect(await call('kit:hasUnsaved', a)).not.toBeNull();
    // un salvataggio riuscito sì
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/x.zip' });
    expect(await call('kit:save', a)).toEqual({ ok: true, path: '/tmp/x.zip' });
    expect(await call('kit:hasUnsaved', a)).toBeNull();
    // ...e una nuova raccolta lo azzera mentre è in corso
    release = null;
    showSaveDialog.mockResolvedValue({ canceled: true });
    run = call('kit:start', a, opts) as Promise<unknown>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(await call('kit:hasUnsaved', a)).toBeNull();
    release!();
    await run;
    expect(await call('kit:hasUnsaved', a)).not.toBeNull();
    release = null;
    run = call('kit:start', a, opts) as Promise<unknown>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(await call('kit:hasUnsaved', a)).toBeNull();
    release!();
    await run;
  });

  it('se il salvataggio automatico fallisce, startKit riporta saveError', async () => {
    const a = sender();
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/x.zip' });
    writeFileAtomic.mockRejectedValue(new Error('disco pieno'));
    const run = call('kit:start', a, opts) as Promise<Record<string, unknown>>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    expect(await run).toMatchObject({ ok: true, savedTo: null, saveError: 'disco pieno' });
  });
});
