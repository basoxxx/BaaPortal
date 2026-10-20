import { describe, expect, it } from 'vitest';
import {
  S7Client,
  memoryTransportPair,
  parseBlockFile,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve } from '../src';
import { blockFile, seq } from './helpers';

function connect(cpu: FakeCpu, proposedPdu?: number): Promise<S7Client> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return S7Client.connect({ host: 'finto', transport, timeoutMs: 2000, proposedPdu });
}

describe('S7Client reale contro il finto PLC', () => {
  it('identity, mode, readArea, blockCounts, listBlocks, blockInfo, upload, readClock', async () => {
    const t = {
      year: 2026,
      month: 10,
      day: 20,
      hour: 9,
      minute: 8,
      second: 7,
      ms: 654,
      weekday: 3,
    };
    const cpu = new FakeCpu({ firmware: 'V3.2.7', clock: () => t });
    const db = seq(500, 3);
    cpu.addDb(1, db);
    cpu.addDb(20, seq(10));
    cpu.addBlock(blockFile('OB', 1, seq(40), 1));
    cpu.setMemory('M', 100, seq(300, 1));
    const c = await connect(cpu);
    try {
      expect(c.pduLength).toBe(240);
      expect(await c.identity()).toMatchObject({
        orderNumber: '6ES7 315-2EH14-0AB0',
        version: 'V3.2.7',
        asName: 'BaaPortal finto PLC',
        moduleName: 'CPU 315-2 PN/DP',
        serialNumber: 'S C-BAA000000001',
        copyright: 'Original Siemens Equipment',
      });
      expect(await c.mode()).toBe('RUN');
      expect(await c.communication()).toEqual({ maxPdu: 240, maxConnections: 16 });
      expect(await c.protection()).toMatchObject({ validLevel: 1 });
      // 300 byte: più richieste per la PDU da 240
      expect(await c.readArea('M', 0, 100, 300)).toEqual(seq(300, 1));
      expect(await c.readArea('DB', 1, 10, 400)).toEqual(db.slice(10, 410));
      expect(await c.blockCounts()).toMatchObject({ OB: 1, DB: 2, FC: 0, SDB: 0 });
      expect((await c.listBlocks('DB')).map((e) => e.number)).toEqual([1, 20]);
      const info = await c.blockInfo('DB', 1);
      expect(info).toMatchObject({ type: 'DB', number: 1, mc7Length: 500, language: 5 });
      const bytes = await c.upload('DB', 1);
      const parsed = parseBlockFile(bytes);
      expect(parsed.header).toMatchObject({ type: 'DB', number: 1, mc7Length: 500 });
      expect(parsed.mc7).toEqual(db);
      expect(parsed.warnings).toEqual([]);
      expect(info.loadLength).toBe(bytes.length);
      expect(await c.readClock()).toEqual(t);
      // lettura di un DB che manca: errore di item con codice 0x0A
      await expect(c.readArea('DB', 9, 0, 4)).rejects.toMatchObject({
        code: 'CPU_ERROR',
        detail: { returnCode: 0x0a },
      });
      // upload di un blocco che manca: errore della CPU
      await expect(c.upload('FC', 3)).rejects.toMatchObject({ code: 'CPU_ERROR' });
      // dopo gli errori la sessione funziona ancora e la sessione di upload è libera
      expect((await c.upload('OB', 1)).length).toBe(36 + 40 + 36);
    } finally {
      await c.close();
    }
  });

  it('diagnostica e lettura multipla; PDU negoziata più piccola', async () => {
    const cpu = new FakeCpu({ pduLength: 120 });
    cpu.setMemory('I', 0, Uint8Array.of(1, 2, 3, 4));
    cpu.addDiagnostic({
      eventId: 0x4302,
      info: new Uint8Array(10),
      time: { year: 2025, month: 1, day: 2, hour: 3, minute: 4, second: 5, ms: 6 },
    });
    const c = await connect(cpu);
    try {
      expect(c.pduLength).toBe(120);
      expect((await c.diagnosticBuffer())[0]).toMatchObject({ eventId: 0x4302 });
      const r = await c.readItems([
        { area: 'I', db: 0, start: 0, size: 'BYTE', count: 4 },
        { area: 'T', db: 0, start: 0, size: 'TIMER', count: 2 },
      ]);
      expect(r.map((x) => x.ok)).toEqual([true, true]);
      expect(await c.readArea('I', 0, 0, 4)).toEqual(Uint8Array.of(1, 2, 3, 4));
    } finally {
      await c.close();
    }
  });

  it('protezione 3: il client riceve CPU_ERROR 0xD241 su lettura e upload, ma legge identità e blocchi', async () => {
    const cpu = new FakeCpu({ protectionLevel: 3 });
    cpu.addDb(1, seq(8));
    const c = await connect(cpu);
    try {
      await expect(c.readArea('M', 0, 0, 4)).rejects.toMatchObject({
        code: 'CPU_ERROR',
        detail: { errorClass: 0xd2, errorCode: 0x41 },
      });
      await expect(c.upload('DB', 1)).rejects.toMatchObject({ code: 'CPU_ERROR' });
      expect((await c.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
      expect((await c.blockCounts()).DB).toBe(1);
      expect((await c.protection()).validLevel).toBe(3);
    } finally {
      await c.close();
    }
  });
});
