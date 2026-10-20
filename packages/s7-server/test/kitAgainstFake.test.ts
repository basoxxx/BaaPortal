import { describe, expect, it } from 'vitest';
import {
  collect,
  kitZip,
  parseBlockFile,
  readKitZip,
  type KitOptions,
  type KitProgress,
} from '@baaportal/s7comm';
import { collectTcp } from '@baaportal/s7comm/node';
import { FakeCpu } from '../src';
import { listen } from '../src/node';
import { ALLOWED, cpuWithBlocks, memoryFactory, txKinds, uploadIds } from './kitRig';

/** La finta, come le CPU vere, rifiuta alcune SZL elencate (0xD402): sono errori attesi, per passo. */
const nonSzl = (errors: { step: string; code: string }[]) =>
  errors.filter((e) => !(e.step.startsWith('szl ') && e.code === 'CPU_ERROR'));

const FAST = { host: 'fake', minIntervalMs: 0, reconnectDelayMs: 0, timeoutMs: 2000 };
const run = (
  cpuFor: (n: number) => FakeCpu,
  o: Partial<KitOptions> = {},
  signal?: AbortSignal,
  onProgress: (p: KitProgress) => void = () => undefined,
) =>
  collect(
    { ...FAST, includeBlocks: true, transport: memoryFactory(cpuFor), ...o },
    onProgress,
    signal,
  );

describe('kit contro il finto PLC', () => {
  it('5 blocchi: zip completo, blocchi identici a quelli messi', async () => {
    const cpu = cpuWithBlocks();
    const r = await run(() => cpu);
    const s = r.summary;
    expect(nonSzl(s.errors)).toEqual([]);
    expect(s.refusedCount).toBe(0);
    expect(s.identity?.orderNumber).toBe('6ES7 315-2EH14-0AB0');
    expect(s.mode).toBe('RUN');
    expect(s.blocksListed).toBe(5);
    expect(s.blocksUploaded).toBe(5);
    expect(s.szlRead).toBeGreaterThan(8);
    expect(s.pduLength).toBeGreaterThan(0);
    expect(s.clock).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/);

    const z = readKitZip(kitZip(r));
    expect(Object.keys(z.blocks).sort()).toEqual(['DB1', 'DB2', 'FB1', 'FC1', 'OB1']);
    for (const [name, type, n] of [
      ['OB1', 'OB', 1],
      ['FC1', 'FC', 1],
      ['FB1', 'FB', 1],
      ['DB1', 'DB', 1],
      ['DB2', 'DB', 2],
    ] as const) {
      expect(z.blocks[name]).toEqual(cpu.block(type, n)!.file);
      expect(parseBlockFile(z.blocks[name]!).header.number).toBe(n);
      expect(z.blockInfo[name]).toBeDefined();
    }
    expect(Object.keys(z.szl)).toContain('0011-0000');
    expect(Object.keys(z.szl)).toContain('0000-0000');
    expect(z.szl['0011-0000']!.records.length).toBeGreaterThan(0);
    expect(z.szl['0011-0000']!.records[0]).toMatch(/^[0-9A-F]+$/);
    expect(z.frames.length).toBeGreaterThan(30);
    expect(z.summary.kitFormat).toBe(1);
  });

  it('senza includeBlocks nessun blocco e nessun upload', async () => {
    const r = await run(() => cpuWithBlocks(), { includeBlocks: false });
    expect(r.summary.blocksListed).toBe(5);
    expect(r.summary.blocksUploaded).toBe(0);
    expect(Object.keys(r.files).some((f) => f.startsWith('blocchi/'))).toBe(false);
    const z = readKitZip(kitZip(r));
    expect(txKinds(z.frames)).not.toContain('upload');
  });

  it("nel log della raccolta ci sono solo PDU dell'allowlist; ogni upload iniziato ha la sua fine", async () => {
    const r = await run(() => cpuWithBlocks());
    const z = readKitZip(kitZip(r));
    const kinds = txKinds(z.frames);
    for (const k of kinds) expect(ALLOWED.has(k)).toBe(true);
    for (const k of ['connect', 'setup', 'szl', 'blockList', 'blockInfo', 'upload', 'clock']) {
      expect(kinds).toContain(k);
    }
    expect(z.summary.refusedCount).toBe(0);
    const { started, ended } = uploadIds(z.frames);
    expect(started).toHaveLength(5);
    expect(ended.sort()).toEqual(started.sort());
  });

  it('SZL: 0x0000 e ogni id elencato con indice 0, più le esplicite; nessuna lista solo intestazione', async () => {
    const r = await run(() => cpuWithBlocks());
    const keys = Object.keys(readKitZip(kitZip(r)).szl);
    for (const k of [
      '0000-0000',
      '0011-0000',
      '001C-0000',
      '0131-0001',
      '0424-0000',
      '00A0-0000',
    ]) {
      expect(keys).toContain(k);
    }
    expect(keys.some((k) => k.startsWith('0F'))).toBe(false);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('protezione 3: identità e SZL raccolte, letture e blocchi come errori nel riepilogo', async () => {
    const r = await run(() => cpuWithBlocks({ protectionLevel: 3 }));
    const s = r.summary;
    expect(s.identity?.orderNumber).toBe('6ES7 315-2EH14-0AB0');
    expect(s.szlRead).toBeGreaterThan(5);
    expect(s.errors.length).toBeGreaterThan(0);
    for (const e of s.errors) {
      expect(['CPU_ERROR', 'PROTOCOL']).toContain(e.code);
      expect(e.step).toBeTruthy();
    }
    expect(s.errors.some((e) => e.step.startsWith('upload'))).toBe(true);
    expect(s.blocksUploaded).toBe(0);
    expect(s.refusedCount).toBe(0);
    const z = readKitZip(kitZip(r));
    expect(z.frames.length).toBeGreaterThan(10);
    for (const k of txKinds(z.frames)) expect(ALLOWED.has(k)).toBe(true);
    const { started, ended } = uploadIds(z.frames);
    expect(ended.sort()).toEqual(started.sort());
  });

  it('connessione che cade verso la fine: riapre una volta, riprende dal passo fallito e completa', async () => {
    const clean = await run(() => cpuWithBlocks());
    const rx = readKitZip(kitZip(clean)).frames.filter((f) => f.dir === 'rx').length;
    const r = await run((n) =>
      cpuWithBlocks(n === 0 ? { faults: { dropAfterResponses: Math.floor(rx * 0.7) } } : {}),
    );
    expect(r.summary.errors.some((e) => e.code === 'CLOSED')).toBe(true);
    expect(r.summary.blocksUploaded).toBe(5);
    expect(r.summary.clock).toBeDefined();
    const z = readKitZip(kitZip(r));
    expect(z.frames.filter((f) => dissectConnect(f.bytes)).length).toBeGreaterThanOrEqual(2);
  });

  it('seconda caduta: la raccolta finisce con quello che ha, zip completo e leggibile', async () => {
    const clean = await run(() => cpuWithBlocks());
    const rx = readKitZip(kitZip(clean)).frames.filter((f) => f.dir === 'rx').length;
    const r = await run((n) =>
      cpuWithBlocks({ faults: { dropAfterResponses: n === 0 ? Math.floor(rx * 0.7) : 2 } }),
    );
    const closed = r.summary.errors.filter((e) => e.code === 'CLOSED');
    expect(closed).toHaveLength(2);
    expect(r.summary.clock).toBeUndefined();
    expect(r.summary.blocksUploaded).toBeLessThan(5);
    const z = readKitZip(kitZip(r));
    expect(z.summary.errors.filter((e) => e.code === 'CLOSED')).toHaveLength(2);
    expect(z.summary.identity?.orderNumber).toBe('6ES7 315-2EH14-0AB0');
  });

  it('annullamento con AbortSignal: zip parziale con errore ABORTED', async () => {
    const ac = new AbortController();
    const r = await run(
      () => cpuWithBlocks(),
      {},
      ac.signal,
      (p) => {
        if (p.phase === 'upload') ac.abort();
      },
    );
    expect(r.summary.errors.at(-1)!.code).toBe('ABORTED');
    expect(r.summary.blocksUploaded).toBeLessThan(5);
    const z = readKitZip(kitZip(r));
    expect(z.summary.identity).toBeDefined();
    const { started, ended } = uploadIds(z.frames);
    expect(ended.sort()).toEqual(started.sort());
  });

  it('un tipo con conteggio 0 non viene elencato', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, new Uint8Array(8));
    const r = await run(() => cpu);
    expect(nonSzl(r.summary.errors)).toEqual([]);
    expect(r.summary.blocksListed).toBe(1);
    const z = readKitZip(kitZip(r));
    // una sola richiesta di lista blocchi di tipo (oltre al conteggio)
    expect(txKinds(z.frames).filter((k) => k === 'blockList')).toHaveLength(2);
  });

  it('avanzamento: fasi in ordine, ultima "done"', async () => {
    const phases: string[] = [];
    await run(
      () => cpuWithBlocks(),
      {},
      undefined,
      (p) => {
        if (phases.at(-1) !== p.phase) phases.push(p.phase);
      },
    );
    expect(phases).toEqual(['connect', 'szl', 'identity', 'blocks', 'upload', 'done']);
  });

  it('pausa minima tra le richieste: con minIntervalMs 20 passa il tempo previsto', async () => {
    const cpu = new FakeCpu();
    const t0 = Date.now();
    const r = await run(() => cpu, { minIntervalMs: 20, includeBlocks: false });
    const n = readKitZip(kitZip(r)).frames.filter((f) => f.dir === 'tx').length;
    expect(Date.now() - t0).toBeGreaterThanOrEqual((n - 3) * 20);
  });

  it('collectTcp su TCP vero: stesso risultato, porta effimera', async () => {
    const cpu = cpuWithBlocks();
    const srv = await listen(cpu);
    try {
      const r = await collectTcp(
        {
          host: '127.0.0.1',
          port: srv.port,
          includeBlocks: true,
          minIntervalMs: 0,
          timeoutMs: 2000,
        },
        () => undefined,
        undefined,
        '9.9.9',
      );
      expect(nonSzl(r.summary.errors)).toEqual([]);
      expect(r.summary.blocksUploaded).toBe(5);
      expect(r.summary.baaportalVersion).toBe('9.9.9');
      expect(readKitZip(kitZip(r)).blocks['DB2']).toEqual(cpu.block('DB', 2)!.file);
    } finally {
      await srv.close();
    }
  });

  it('collectTcp: porta chiusa, zip con CONNECT_REFUSED (una riapertura)', async () => {
    const srv = await listen(new FakeCpu());
    const port = srv.port;
    await srv.close();
    const r = await collectTcp(
      { host: '127.0.0.1', port, includeBlocks: false, reconnectDelayMs: 0, timeoutMs: 1000 },
      () => undefined,
    );
    expect(r.summary.errors.map((e) => e.code)).toEqual(['CONNECT_REFUSED', 'CONNECT_REFUSED']);
    expect(readKitZip(kitZip(r)).frames).toEqual([]);
  });
});

import { decodeCotp } from '@baaportal/s7comm';
function dissectConnect(b: Uint8Array): boolean {
  return decodeCotp(b).type === 'CR';
}
