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

  it('kit:save da un altro mittente dà ok:false e non scrive', async () => {
    const a = sender();
    const b = sender();
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/x.zip' });
    const run = call('kit:start', a, opts) as Promise<{ ok: boolean; savedTo: string }>;
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    expect((await run).savedTo).toBe('/tmp/x.zip');
    writeFileAtomic.mockClear();
    const other = (await call('kit:save', b)) as { ok: boolean; error?: string };
    expect(other.ok).toBe(false);
    expect(other.error).toBeTruthy();
    expect(writeFileAtomic).not.toHaveBeenCalled();
    expect(await call('kit:save', a)).toEqual({ ok: true, path: '/tmp/x.zip' });
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
