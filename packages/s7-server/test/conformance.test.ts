import { describe, expect, it } from 'vitest';
import {
  parseBlockFile,
  type BlockType,
  type CpuMode,
  type DiagEntry,
  type S7DateTime,
} from '@baaportal/s7comm';
import { FakeCpu } from '../src';
import { blockFile, seq } from './helpers';
import { rig, type Via } from './rig';

const NOW: S7DateTime = {
  year: 2026,
  month: 10,
  day: 20,
  hour: 9,
  minute: 8,
  second: 7,
  ms: 654,
  weekday: 3,
};

const DIAG: DiagEntry[] = [
  {
    eventId: 0x4302,
    info: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    time: { year: 2025, month: 1, day: 2, hour: 3, minute: 4, second: 5, ms: 678, weekday: 5 },
  },
  {
    eventId: 0x5144,
    info: new Uint8Array(10).fill(0xaa),
    time: { year: 2025, month: 6, day: 30, hour: 23, minute: 59, second: 58, ms: 12, weekday: 2 },
  },
  {
    eventId: 0x4570,
    info: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]),
    time: { year: 2026, month: 2, day: 28, hour: 0, minute: 0, second: 1, ms: 999, weekday: 7 },
  },
];

const DB1 = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
const DB20 = seq(10, 100);
const OB1 = seq(60, 9);
const FC3 = seq(33, 200);
const FB4 = seq(120, 77);
const SFC6 = seq(8, 1);

/** Il blocco, e i byte esatti con cui è stato messo nel finto PLC. */
function populate(cpu: FakeCpu): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const add = (type: BlockType, n: number, mc7: Uint8Array, lang: number, flags: number) => {
    const f = blockFile(type, n, mc7, lang, flags);
    cpu.addBlock(f);
    files.set(`${type}${n}`, f);
  };
  cpu.addDb(1, DB1);
  cpu.addDb(20, DB20);
  add('OB', 1, OB1, 1, 0x01);
  add('FC', 3, FC3, 3, 0x01);
  add('FB', 4, FB4, 2, 0x01);
  add('SFC', 6, SFC6, 1, 0x09);
  for (const k of ['DB1', 'DB20']) files.set(k, cpu.block('DB', Number(k.slice(2)))!.file);
  cpu.setMemory('I', 0, seq(64, 1));
  cpu.setMemory('Q', 4, seq(100, 50));
  cpu.setMemory('M', 100, seq(300, 3));
  for (const d of DIAG) cpu.addDiagnostic(d);
  return files;
}

const COMBOS: { via: Via; fake: number; client: number; expected: number }[] = [];
for (const via of ['memory', 'tcp'] as const) {
  for (const [fake, client] of [
    [240, 240],
    [480, 480],
    [960, 960],
    [240, 960],
  ] as const) {
    COMBOS.push({ via, fake, client, expected: Math.min(fake, client) });
  }
}

describe('conformità: ogni metodo di S7Client contro il finto PLC', () => {
  for (const c of COMBOS) {
    it(
      `${c.via}, finto PDU ${c.fake}, client ${c.client} (negoziata ${c.expected})`,
      { timeout: 30_000 },
      async () => {
        const cpu = new FakeCpu({
          pduLength: c.fake,
          clock: () => NOW,
          orderNumber: '6ES7 315-2EH14-0AB0',
          firmware: 'V3.2.7',
          asName: 'Impianto 7',
          moduleName: 'CPU 315-2 PN/DP',
          serialNumber: 'S C-ABC123456789',
          maxConnections: 12,
        });
        const files = populate(cpu);
        const r = await rig(cpu, c.via);
        try {
          const cl = await r.connect({ proposedPdu: c.client });
          expect(cl.pduLength).toBe(c.expected);

          // identità
          expect(await cl.identity()).toEqual({
            orderNumber: '6ES7 315-2EH14-0AB0',
            version: 'V3.2.7',
            asName: 'Impianto 7',
            moduleName: 'CPU 315-2 PN/DP',
            serialNumber: 'S C-ABC123456789',
            copyright: 'Original Siemens Equipment',
            plantId: '',
            mmcSerial: '',
          });
          expect(await cl.communication()).toEqual({ maxPdu: c.fake, maxConnections: 12 });
          expect(await cl.protection()).toMatchObject({ validLevel: 1 });

          // memoria
          expect(await cl.readArea('I', 0, 0, 64)).toEqual(seq(64, 1));
          expect(await cl.readArea('Q', 0, 4, 100)).toEqual(seq(100, 50));
          expect(await cl.readArea('M', 0, 100, 300)).toEqual(seq(300, 3));
          expect(await cl.readArea('DB', 20, 0, 10)).toEqual(DB20);
          expect(await cl.readArea('DB', 1, 0, 5000)).toEqual(DB1);
          expect(await cl.readArea('DB', 1, 4321, 100)).toEqual(DB1.slice(4321, 4421));
          const items = await cl.readItems([
            { area: 'M', db: 0, start: 100, size: 'BYTE', count: 3 },
            { area: 'DB', db: 20, start: 2, size: 'WORD', count: 2 },
            { area: 'M', db: 0, start: 101, bit: 2, size: 'BIT', count: 1 },
            { area: 'DB', db: 99, start: 0, size: 'BYTE', count: 1 },
          ]);
          expect(items.map((x) => x.ok)).toEqual([true, true, true, false]);
          expect(items[0]).toMatchObject({ ok: true, data: seq(3, 3) });
          expect(items[1]).toMatchObject({ ok: true, data: DB20.slice(2, 6) });
          expect(items[3]).toMatchObject({ ok: false, returnCode: 0x0a });
          await expect(cl.readArea('DB', 99, 0, 4)).rejects.toMatchObject({
            code: 'CPU_ERROR',
            detail: { returnCode: 0x0a },
          });

          // blocchi
          expect(await cl.blockCounts()).toEqual({
            OB: 1,
            DB: 2,
            SDB: 0,
            FC: 1,
            SFC: 1,
            FB: 1,
            SFB: 0,
          });
          expect((await cl.listBlocks('DB')).map((e) => e.number)).toEqual([1, 20]);
          expect((await cl.listBlocks('OB')).map((e) => e.number)).toEqual([1]);
          expect(await cl.listBlocks('SDB')).toEqual([]);
          expect(await cl.listBlocks('SFB')).toEqual([]);
          for (const [name, file] of files) {
            const type = name.replace(/\d+$/, '') as BlockType;
            const number = Number(name.slice(type.length));
            const bytes = await cl.upload(type, number);
            expect(bytes).toEqual(file);
            const parsed = parseBlockFile(bytes);
            const info = await cl.blockInfo(type, number);
            expect(info).toMatchObject({
              type,
              number,
              language: parsed.header.language,
              flags: parsed.header.flags,
              loadLength: parsed.header.loadLength,
              security: parsed.header.security,
              ssbLength: parsed.header.ssbLength,
              addLength: parsed.header.addLength,
              localDataLength: parsed.header.localDataLength,
              mc7Length: parsed.header.mc7Length,
              author: parsed.footer?.author,
              family: parsed.footer?.family,
              name: parsed.footer?.name,
              checksum: parsed.footer?.checksum,
            });
            expect(info.codeTime).toEqual(parsed.header.codeTime);
            expect(info.interfaceTime).toEqual(parsed.header.interfaceTime);
          }
          const withInfo = await cl.uploadWithInfo('DB', 1);
          expect(withInfo.bytes).toEqual(files.get('DB1'));
          expect(withInfo.declaredLength).toBe(files.get('DB1')!.length);
          await expect(cl.upload('DB', 77)).rejects.toMatchObject({ code: 'CPU_ERROR' });
          await expect(cl.blockInfo('FC', 77)).rejects.toMatchObject({ code: 'CPU_ERROR' });

          // modo
          for (const m of ['RUN', 'STOP', 'STARTUP', 'HOLD', 'DEFECT'] as CpuMode[]) {
            cpu.setMode(m);
            expect(await cl.mode()).toBe(m);
          }

          // ora e buffer diagnostico (il più recente per primo)
          expect(await cl.readClock()).toEqual(NOW);
          const diag = await cl.diagnosticBuffer();
          expect(diag).toEqual([...DIAG].reverse());
          expect(cpu.connections).toBe(1);
        } finally {
          await r.close();
        }
        expect(cpu.connections).toBe(0);
      },
    );
  }

  for (const via of ['memory', 'tcp'] as const) {
    for (const level of [1, 2, 3] as const) {
      it(`${via}: livello di protezione ${level}`, { timeout: 30_000 }, async () => {
        const cpu = new FakeCpu({ protectionLevel: level, clock: () => NOW });
        populate(cpu);
        const r = await rig(cpu, via);
        try {
          const cl = await r.connect();
          const p = await cl.protection();
          expect(p.validLevel).toBe(level);
          expect(p.switchLevel).toBe(level);
          // identità, liste e info blocchi funzionano a ogni livello
          expect((await cl.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
          expect((await cl.blockCounts()).DB).toBe(2);
          expect((await cl.listBlocks('DB')).length).toBe(2);
          expect((await cl.blockInfo('DB', 1)).number).toBe(1);
          expect(await cl.readClock()).toEqual(NOW);
          if (level === 3) {
            // ASSUNZIONE: il rifiuto 0xD241 della lettura variabili a livello 3 è una scelta del
            // finto PLC, non visto su una CPU vera (la sola cattura protetta è di snap7: item 0x0A)
            await expect(cl.readArea('M', 0, 100, 4)).rejects.toMatchObject({
              code: 'CPU_ERROR',
              detail: { errorClass: 0xd2, errorCode: 0x41 },
            });
            await expect(cl.upload('DB', 1)).rejects.toMatchObject({
              code: 'CPU_ERROR',
              detail: { errorClass: 0xd2, errorCode: 0x41 },
            });
            // la connessione resta usabile dopo l'errore
            expect((await cl.identity()).version).toBe('V3.2.0');
          } else {
            expect(await cl.readArea('M', 0, 100, 4)).toEqual(seq(4, 3));
            expect((await cl.upload('DB', 20)).length).toBeGreaterThan(10);
          }
        } finally {
          await r.close();
        }
      });
    }
  }

  it('un tipo di blocco senza blocchi dà [] e un finto PLC vuoto risponde a tutto', async () => {
    const cpu = new FakeCpu();
    const r = await rig(cpu, 'memory');
    try {
      const cl = await r.connect();
      expect(await cl.blockCounts()).toEqual({
        OB: 0,
        DB: 0,
        SDB: 0,
        FC: 0,
        SFC: 0,
        FB: 0,
        SFB: 0,
      });
      for (const t of ['OB', 'DB', 'SDB', 'FC', 'SFC', 'FB', 'SFB'] as BlockType[]) {
        expect(await cl.listBlocks(t)).toEqual([]);
      }
      expect(await cl.diagnosticBuffer()).toEqual([]);
    } finally {
      await r.close();
    }
  });
});
