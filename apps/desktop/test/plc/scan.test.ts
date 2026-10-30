import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S7Error } from '@baaportal/s7comm';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { FoundDevice, PlcScanEvent } from '@baaportal/ui';
import { hostsToScan, listInterfaces } from '../../src/main/plc/interfaces';
import {
  createIdentify,
  createProbe,
  scanSubnet,
  type IdentifyFn,
  type ProbeFn,
} from '../../src/main/plc/scan';
import { ScanService, type ScanOwner } from '../../src/main/plc/scanService';

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condizione non raggiunta');
    await sleep(5);
  }
};

class FakeOwner implements ScanOwner {
  events: PlcScanEvent[] = [];
  sentAfterDestroy = 0;
  private destroyed = false;
  private listeners = new Map<string, Set<() => void>>();
  isDestroyed() {
    return this.destroyed;
  }
  send(_c: string, e: PlcScanEvent) {
    if (this.destroyed) this.sentAfterDestroy++;
    this.events.push(e);
  }
  once(e: string, cb: () => void) {
    if (!this.listeners.has(e)) this.listeners.set(e, new Set());
    this.listeners.get(e)!.add(cb);
  }
  removeListener(e: string, cb: () => void) {
    this.listeners.get(e)?.delete(cb);
  }
  fire(e: string) {
    for (const cb of [...(this.listeners.get(e) ?? [])]) cb();
  }
  destroy() {
    this.destroyed = true;
    this.fire('destroyed');
  }
}

describe('hostsToScan', () => {
  it('/24 → 253 host senza il proprio', () => {
    const h = hostsToScan('192.0.2.10', '255.255.255.0');
    expect(h).toHaveLength(253);
    expect(h).not.toContain('192.0.2.10');
    expect(h).not.toContain('192.0.2.0');
    expect(h).not.toContain('192.0.2.255');
    expect(h[0]).toBe('192.0.2.1');
    expect(h[252]).toBe('192.0.2.254');
  });
  it('/16 → 1024 host attorno al proprio', () => {
    const h = hostsToScan('198.51.100.10', '255.255.0.0');
    expect(h).toHaveLength(1024);
    expect(h).not.toContain('198.51.100.10');
    const nums = h.map((x) => x.split('.').slice(2).map(Number)).map(([a, b]) => a! * 256 + b!);
    const mid = 100 * 256 + 10;
    expect(Math.max(...nums.map((n) => Math.abs(n - mid)))).toBeLessThanOrEqual(512);
    expect(new Set(h).size).toBe(1024);
  });
  it('/16 con indirizzo vicino al bordo: resta dentro la sottorete', () => {
    const h = hostsToScan('198.51.100.1', '255.255.0.0');
    expect(h).toHaveLength(1024);
    expect(h.every((x) => x.startsWith('198.51.'))).toBe(true);
    expect(h).not.toContain('198.51.0.0');
  });
  it('/31 e /32 → vuoto; dati non validi → vuoto', () => {
    expect(hostsToScan('192.0.2.10', '255.255.255.254')).toEqual([]);
    expect(hostsToScan('192.0.2.10', '255.255.255.255')).toEqual([]);
    expect(hostsToScan('192.0.2.300', '255.255.255.0')).toEqual([]);
    expect(hostsToScan('192.0.2.10', '255.0.255.0')).toEqual([]);
  });
  it('rispetta max', () => {
    expect(hostsToScan('192.0.2.10', '255.255.255.0', 10)).toHaveLength(10);
  });
});

describe('listInterfaces', () => {
  it('scarta IPv6 e interne', () => {
    const base = { mac: '', cidr: null };
    const r = listInterfaces(() => ({
      lo0: [
        { ...base, address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true },
      ],
      en0: [
        {
          ...base,
          address: 'fe80::1',
          netmask: 'ffff::',
          family: 'IPv6',
          internal: false,
          scopeid: 0,
        },
        {
          ...base,
          address: '192.0.2.10',
          netmask: '255.255.255.0',
          family: 'IPv4',
          internal: false,
        },
      ],
      v6only: [
        {
          ...base,
          address: '2001:db8::1',
          netmask: 'ffff::',
          family: 'IPv6',
          internal: false,
          scopeid: 0,
        },
      ],
    }));
    expect(r).toEqual([{ name: 'en0', address: '192.0.2.10', netmask: '255.255.255.0' }]);
  });
});

const ident: IdentifyFn = async () => ({ orderNumber: '6ES7 315-2EH14-0AB0', mode: 'RUN' });

describe('scanSubnet', () => {
  const hosts = (n: number) => Array.from({ length: n }, (_, i) => `192.0.2.${i + 1}`);

  it('al più 32 probe insieme', async () => {
    let live = 0;
    let max = 0;
    const probe: ProbeFn = async () => {
      live++;
      max = Math.max(max, live);
      await sleep(5);
      live--;
      return false;
    };
    const progress: number[] = [];
    await scanSubnet(hosts(100), {
      probe,
      identify: ident,
      concurrency: 500, // anche se chiesto di più, il tetto è 32
      signal: new AbortController().signal,
      onFound: () => undefined,
      onProgress: (d) => progress.push(d),
    });
    expect(max).toBe(32);
    expect(progress).toHaveLength(100);
    expect(progress[99]).toBe(100);
  });

  it('cancel ferma la ricerca: niente più onFound né onProgress, probe notificate', async () => {
    const ctl = new AbortController();
    const signals: AbortSignal[] = [];
    const probe: ProbeFn = (_h, s) =>
      new Promise((resolve) => {
        signals.push(s);
        s.addEventListener('abort', () => resolve(true)); // anche se «apre», dopo cancel non conta
      });
    const found: FoundDevice[] = [];
    let calls = 0;
    const run = scanSubnet(hosts(50), {
      probe,
      identify: ident,
      signal: ctl.signal,
      onFound: (d) => found.push(d),
      onProgress: () => calls++,
    });
    await waitFor(() => signals.length === 32);
    ctl.abort();
    await run; // ritorna con le probe ancora pendenti
    await sleep(30);
    expect(found).toEqual([]);
    expect(calls).toBe(0);
    expect(signals.length).toBe(32); // nessun nuovo host dopo cancel
  });

  it('cancel durante identify: nessun onFound', async () => {
    const ctl = new AbortController();
    let started = false;
    const identify: IdentifyFn = () =>
      new Promise((_, reject) => {
        started = true;
        setTimeout(() => reject(new Error('tardi')), 20);
      });
    const found: FoundDevice[] = [];
    const run = scanSubnet(['192.0.2.1'], {
      probe: async () => true,
      identify,
      signal: ctl.signal,
      onFound: (d) => found.push(d),
      onProgress: () => undefined,
    });
    await waitFor(() => started);
    ctl.abort();
    await run;
    await sleep(40);
    expect(found).toEqual([]);
  });

  it('host non S7 → unknown con motivo, la ricerca prosegue', async () => {
    const identify: IdentifyFn = async (h) => {
      if (h === '192.0.2.2') throw new S7Error('COTP_REJECTED', 'rifiutato');
      if (h === '192.0.2.3') throw new S7Error('TIMEOUT', 'nessuna risposta');
      return { orderNumber: 'X', mode: 'STOP' };
    };
    const found: FoundDevice[] = [];
    await scanSubnet(hosts(4), {
      probe: async (h) => h !== '192.0.2.4',
      identify,
      signal: new AbortController().signal,
      onFound: (d) => found.push(d),
      onProgress: () => undefined,
    });
    found.sort((a, b) => a.host.localeCompare(b.host));
    expect(found.map((d) => [d.host, d.status])).toEqual([
      ['192.0.2.1', 'cpu'],
      ['192.0.2.2', 'unknown'],
      ['192.0.2.3', 'unknown'],
    ]);
    const u = found[1]!;
    expect(u.status === 'unknown' && u.reason).toMatch(/102/);
    expect(found[0]).toEqual({
      host: '192.0.2.1',
      status: 'cpu',
      identity: { orderNumber: 'X' },
      mode: 'STOP',
    });
  });

  it('una probe che lancia vale come porta chiusa', async () => {
    const found: FoundDevice[] = [];
    await scanSubnet(hosts(2), {
      probe: async () => {
        throw new Error('boom');
      },
      identify: ident,
      signal: new AbortController().signal,
      onFound: (d) => found.push(d),
      onProgress: () => undefined,
    });
    expect(found).toEqual([]);
  });
});

describe('probe e identify veri contro il PLC di prova (127.0.0.1)', () => {
  let plc: ListeningCpu;
  beforeEach(async () => {
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    plc = await listen(simBackend(cpu), { port: 0 });
  });
  afterEach(async () => {
    await plc.close();
  });

  it('identify reale: identità e modo della CPU simulata', async () => {
    const r = await createIdentify(plc.port)('127.0.0.1', new AbortController().signal);
    expect(r.orderNumber).not.toBe('');
    expect(r.mode).toBe('RUN');
  });

  it('probe reale: porta aperta vero, porta chiusa falso', async () => {
    const sig = new AbortController().signal;
    expect(await createProbe(plc.port, 400)('127.0.0.1', sig)).toBe(true);
    const port = plc.port;
    await plc.close();
    expect(await createProbe(port, 400)('127.0.0.1', sig)).toBe(false);
    plc = await listen(simBackend(new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS })), {
      port: 0,
    });
  });

  it('scansione intera sul loopback: trova la CPU di prova', async () => {
    const found: FoundDevice[] = [];
    await scanSubnet(['127.0.0.1'], {
      probe: createProbe(plc.port),
      identify: createIdentify(plc.port),
      signal: new AbortController().signal,
      onFound: (d) => found.push(d),
      onProgress: () => undefined,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe('cpu');
  });
});

describe('ScanService', () => {
  const iface = { name: 'en0', address: '192.0.2.10', netmask: '255.255.255.0' };
  const make = (probe: ProbeFn, extra = {}) =>
    new ScanService({
      probe,
      identify: ident,
      interfaces: () => [iface],
      progressIntervalMs: 0,
      ...extra,
    });

  it('ricerca completa: found, progress e done', async () => {
    const owner = new FakeOwner();
    const svc = make(async (h) => h === '192.0.2.1');
    const r = svc.start(owner, iface.address);
    expect(r).toMatchObject({ ok: true, total: 253 });
    await waitFor(() => owner.events.some((e) => e.kind === 'done'));
    const kinds = new Set(owner.events.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['done', 'found', 'progress']);
    const done = owner.events.at(-1);
    expect(done).toMatchObject({ kind: 'done', found: 1, cancelled: false });
    expect(owner.events.every((e) => e.scanId === (r.ok ? r.scanId : -1))).toBe(true);
  });

  it('interfaccia sconosciuta → errore, nessuna ricerca', () => {
    const svc = make(async () => false);
    expect(svc.start(new FakeOwner(), '203.0.113.9')).toEqual({
      ok: false,
      error: 'Interfaccia di rete non disponibile',
    });
  });

  it('una nuova ricerca interrompe la precedente della stessa finestra', async () => {
    const owner = new FakeOwner();
    const signals: AbortSignal[] = [];
    const svc = make((_h, s) => {
      signals.push(s);
      return new Promise(() => undefined);
    });
    svc.start(owner, iface.address);
    await waitFor(() => signals.length > 0);
    const first = signals[0]!;
    const second = svc.start(owner, iface.address);
    expect(first.aborted).toBe(true);
    expect(second.ok && second.scanId).toBe(2);
    await waitFor(() => owner.events.some((e) => e.kind === 'done' && e.scanId === 1));
    svc.cancel(owner);
  });

  it('finestre diverse hanno ricerche indipendenti', async () => {
    const a = new FakeOwner();
    const b = new FakeOwner();
    const signals: AbortSignal[] = [];
    const svc = make((_h, s) => {
      signals.push(s);
      return new Promise(() => undefined);
    });
    svc.start(a, iface.address);
    svc.start(b, iface.address);
    await waitFor(() => signals.length >= 64);
    svc.cancel(a);
    expect(signals.filter((s) => s.aborted)).toHaveLength(32);
    await svc.cancelAll();
  });

  it('cancel: arriva done con cancelled e poi nessun altro evento', async () => {
    const owner = new FakeOwner();
    const signals: AbortSignal[] = [];
    const svc = make((_h, s) => {
      signals.push(s);
      return new Promise(() => undefined);
    });
    svc.start(owner, iface.address);
    await waitFor(() => signals.length > 0);
    svc.cancel(owner);
    await waitFor(() => owner.events.length > 0);
    await sleep(30);
    expect(owner.events).toEqual([{ scanId: 1, kind: 'done', found: 0, cancelled: true }]);
  });

  it('finestra distrutta → ricerca interrotta, nessun evento verso la finestra', async () => {
    const owner = new FakeOwner();
    const signals: AbortSignal[] = [];
    const svc = make((_h, s) => {
      signals.push(s);
      return new Promise((res) => setTimeout(() => res(true), 20));
    });
    svc.start(owner, iface.address);
    await waitFor(() => signals.length > 0);
    owner.destroy();
    expect(signals.every((s) => s.aborted)).toBe(true);
    await sleep(80);
    expect(owner.events).toEqual([]);
    expect(owner.sentAfterDestroy).toBe(0);
  });

  it('pagina ricaricata o renderer caduto → ricerca interrotta, nessun evento alla pagina nuova', async () => {
    for (const e of ['did-navigate', 'render-process-gone']) {
      const owner = new FakeOwner();
      const signals: AbortSignal[] = [];
      const svc = make((_h, s) => {
        signals.push(s);
        return new Promise((res) => setTimeout(() => res(true), 20));
      });
      svc.start(owner, iface.address);
      await waitFor(() => signals.length > 0);
      const before = owner.events.length;
      owner.fire(e);
      expect(signals.every((s) => s.aborted)).toBe(true);
      await sleep(80);
      expect(owner.events).toHaveLength(before);
    }
  });

  it('cancelAll (uscita dall’app) interrompe tutto e aspetta', async () => {
    const owner = new FakeOwner();
    const signals: AbortSignal[] = [];
    const svc = make((_h, s) => {
      signals.push(s);
      return new Promise(() => undefined);
    });
    svc.start(owner, iface.address);
    await waitFor(() => signals.length > 0);
    await svc.cancelAll();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('avanzamento limitato a 10 eventi al secondo, ma l’ultimo non si perde', async () => {
    const owner = new FakeOwner();
    const svc = make(async () => false, { progressIntervalMs: 100 });
    svc.start(owner, iface.address);
    await waitFor(() => owner.events.some((e) => e.kind === 'done'));
    const progress = owner.events.filter((e) => e.kind === 'progress');
    expect(progress.length).toBeLessThan(10);
    expect(progress.at(-1)).toMatchObject({ done: 253, total: 253 });
  });
});
