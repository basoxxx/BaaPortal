import { describe, expect, it } from 'vitest';
import { toIpcResult, fromIpcResult } from '../src/shared/ipcResult';

describe('ipcResult', () => {
  it('un errore EACCES codificato e decodificato mantiene code e message', async () => {
    const original = Object.assign(new Error("EACCES: permission denied, open '/x'"), {
      code: 'EACCES',
    });
    const encoded = await toIpcResult(() => Promise.reject(original));
    const wire = structuredClone(encoded);
    expect(wire.ok).toBe(false);
    let caught: unknown;
    try {
      fromIpcResult(wire);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
    expect((caught as Error).message).toBe(original.message);
  });
  it('un errore senza code resta un Error senza code', async () => {
    const wire = structuredClone(await toIpcResult(() => Promise.reject(new Error('boom'))));
    expect(() => fromIpcResult(wire)).toThrow('boom');
    try {
      fromIpcResult(wire);
    } catch (e) {
      expect((e as { code?: string }).code).toBeUndefined();
    }
  });
  it('il successo passa il valore invariato, anche Uint8Array', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const wire = structuredClone(await toIpcResult(() => Promise.resolve(data)));
    const out = fromIpcResult(wire);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
  it('void passa come undefined', async () => {
    expect(
      fromIpcResult(structuredClone(await toIpcResult(async () => undefined))),
    ).toBeUndefined();
  });
});
