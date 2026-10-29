// Riferimenti incrociati: dopo la modifica di un blocco si ricalcola solo quel blocco.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeBlock, PlcDevice } from '../src/index';

const calls = vi.hoisted(() => [] as string[]);
vi.mock('../src/kopSources', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/kopSources')>();
  return {
    ...orig,
    kopSources: (block: CodeBlock, dev: PlcDevice) => {
      calls.push(block.name);
      return orig.kopSources(block, dev);
    },
  };
});

const { createCodeBlock, crossReferences } = await import('../src/index');
const { makeDevice } = await import('./fixtures');

const setSource = (dev: PlcDevice, name: string, source: string): PlcDevice => ({
  ...dev,
  blocks: dev.blocks.map((b) =>
    b.name === name && b.kind !== 'DB' && b.kind !== 'IDB'
      ? { ...b, networks: [{ ...b.networks[0]!, source }] }
      : b,
  ),
});

describe('crossReferences: cache per blocco', () => {
  let dev: PlcDevice;
  beforeEach(() => {
    dev = makeDevice();
    const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'Uno', language: 'AWL' });
    fc.networks = [{ id: 'n1', title: '', comment: '', source: 'A "Start"\n= M 0.0' }];
    const fc2 = createCodeBlock({ kind: 'FC', number: 2, name: 'Due', language: 'AWL' });
    fc2.networks = [{ id: 'n2', title: '', comment: '', source: 'A "Stop"\n= M 0.1' }];
    dev.blocks.push(fc, fc2);
    crossReferences(dev);
    calls.length = 0;
  });

  it('modificare un blocco ricalcola solo quel blocco, con lo stesso risultato di un calcolo nuovo', () => {
    const next = setSource(dev, 'Uno', 'A "Stop"\n= M 0.2');
    const got = crossReferences(next);
    expect(calls).toEqual(['Uno']);
    expect(got.find((o) => o.address === '%M0.2')?.uses.map((u) => u.block)).toEqual(['FC1']);
    expect(got.find((o) => o.address === '%M0.0')).toBeUndefined();
    expect(crossReferences(next)).toEqual(got);
    expect(calls).toEqual(['Uno']);
  });

  it('cambiare i tag o un interfaccia ricalcola tutti i blocchi', () => {
    crossReferences({ ...dev, tagTables: [...dev.tagTables] });
    const all = calls.length;
    expect(all).toBeGreaterThanOrEqual(2);
    calls.length = 0;
    crossReferences({
      ...dev,
      blocks: dev.blocks.map((b) =>
        b.name === 'Due' && b.kind === 'FC' ? { ...b, interface: { ...b.interface } } : b,
      ),
    });
    expect(calls.length).toBe(all);
  });
});
