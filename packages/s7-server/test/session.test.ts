import { describe, expect, it } from 'vitest';
import {
  S7Client,
  S7Connection,
  decodeEndUploadResponse,
  decodeReadResponse,
  decodeSetup,
  decodeStartUploadResponse,
  decodeUploadResponse,
  decodeUserdata,
  decodeWriteResponse,
  encodeEndUpload,
  encodeInsertBlock,
  encodeRequestDownload,
  memoryTransportPair,
  sliceBlockForDownload,
  type TransportFactory,
  encodePlcStop,
  encodeWarmRestart,
  encodeWriteRequest,
  decodeControlResponse,
  encodeReadRequest,
  encodeS7,
  encodeSetup,
  encodeStartUpload,
  encodeTpkt,
  encodeUpload,
  hex,
  parseBlockFile,
  reqBlockCounts,
  reqContinue,
  reqReadSzl,
  type ReadItem,
} from '@baaportal/s7comm';
import { FakeCpu, serve, userdataFunction } from '../src';
import { NOTHING, TestPeer, blockFile, seq, sleep } from './helpers';

const read = (count: number, area: ReadItem['area'] = 'M'): Uint8Array =>
  encodeReadRequest([{ area, db: 0, start: 0, size: 'BYTE', count }]);

describe('setup', () => {
  it('PDU = minimo tra richiesta e configurata; AmQ 1/1 come la 315 vera', async () => {
    for (const [asked, configured, want] of [
      [480, 240, 240],
      [960, 240, 240],
      [120, 240, 120],
      [240, 480, 240],
      [480, 480, 480],
    ] as const) {
      const p = new TestPeer(new FakeCpu({ pduLength: configured }));
      await p.connect();
      const r = await p.setup(asked, 3);
      expect(r).toMatchObject({ rosctr: 3, errorClass: 0, errorCode: 0 });
      expect(decodeSetup(r!.param)).toEqual({ amqCalling: 1, amqCalled: 1, pduLength: want });
      expect(r!.data).toHaveLength(0);
    }
  });

  it('identica nei byte alla risposta reale di proto §17.2', async () => {
    const p = new TestPeer(new FakeCpu());
    await p.connect();
    await p.setup(480);
    // 0300 001b 02f080 | 32 03 0000 <ref> 0008 0000 0000 | f0 00 0001 0001 00f0
    expect(hex(p.chunks.at(-1)!)).toBe(
      '0300001b02f08032030000' + '0001' + '0008000000' + '00' + 'f0000001000100f0',
    );
  });

  it('senza setup le richieste di lettura funzionano con la PDU configurata', async () => {
    const cpu = new FakeCpu();
    cpu.setMemory('M', 0, Uint8Array.of(7));
    const p = new TestPeer(cpu);
    await p.connect();
    const r = await p.job(read(1));
    expect(decodeReadResponse(r!.param, r!.data)[0]).toMatchObject({ ok: true });
  });
});

describe('connessione: DT prima del CC, spazzatura, chiusure', () => {
  it('un DT prima del CC chiude, senza risposta', async () => {
    const cpu = new FakeCpu();
    const p = new TestPeer(cpu);
    const r = await p.job(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }));
    expect(r).toBeUndefined();
    expect(p.closed).toBe(true);
    expect(p.cotp).toHaveLength(0);
    expect(cpu.connections).toBe(0);
  });

  it('spazzatura, TPKT sbagliato, COTP sconosciuto, S7 troncato: la sessione si chiude', async () => {
    const cases: Uint8Array[] = [
      Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      Uint8Array.of(3, 0, 0, 3), // TPKT troppo corto
      encodeTpkt(Uint8Array.of(2, 0x42, 0x00, 0x00)), // tipo COTP sconosciuto
    ];
    for (const bytes of cases) {
      const cpu = new FakeCpu();
      const p = new TestPeer(cpu);
      await p.connect();
      p.sendRaw(bytes);
      await new Promise((r) => setImmediate(r));
      expect(p.closed, hex(bytes)).toBe(true);
      expect(cpu.connections).toBe(0);
    }
    const cpu = new FakeCpu();
    const p = new TestPeer(cpu);
    await p.open();
    p.sendCotp({ type: 'DT', eot: true, data: Uint8Array.of(0x32, 0x01, 0x00) });
    await new Promise((r) => setImmediate(r));
    expect(p.closed).toBe(true);
  });

  it('un secondo CR, un DR o un ER del cliente chiudono e liberano il posto', async () => {
    for (const make of [
      (p: TestPeer) => p.connect(),
      async (p: TestPeer) => p.sendCotp({ type: 'DR', dstRef: 1, srcRef: 0x100, reason: 0x80 }),
      async (p: TestPeer) => p.sendCotp({ type: 'ER', dstRef: 1, cause: 1 }),
    ]) {
      const cpu = new FakeCpu();
      const p = await new TestPeer(cpu).open();
      expect(cpu.connections).toBe(1);
      await make(p);
      await new Promise((r) => setImmediate(r));
      expect(p.closed).toBe(true);
      expect(cpu.connections).toBe(0);
    }
  });

  it('close() della sessione chiude il trasporto e libera la connessione', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    p.server.close();
    await new Promise((r) => setImmediate(r));
    expect(p.closed).toBe(true);
    expect(cpu.connections).toBe(0);
    p.server.close(); // idempotente
  });

  it('una PDU S7 spezzata in più DT si ricompone', async () => {
    const cpu = new FakeCpu();
    cpu.setMemory('M', 0, Uint8Array.of(0x11, 0x22));
    const p = new TestPeer(cpu);
    await p.connect();
    const whole = encodeS7({
      rosctr: 1,
      pduRef: 9,
      errorClass: 0,
      errorCode: 0,
      param: read(2),
      data: NOTHING,
    });
    p.sendCotp({ type: 'DT', eot: false, data: whole.slice(0, 10) });
    await new Promise((r) => setImmediate(r));
    expect(p.pdus).toHaveLength(0);
    p.sendCotp({ type: 'DT', eot: true, data: whole.slice(10) });
    await new Promise((r) => setImmediate(r));
    expect(p.pdus).toHaveLength(1);
    expect(hex(p.pdus[0]!.data)).toBe('ff0400101122');
  });

  it('con TPDU-size piccola la risposta si spezza in DT che stanno nella TPDU', async () => {
    const cpu = new FakeCpu();
    const p = new TestPeer(cpu);
    await p.connect({ tpduSize: 0x07 }); // 128 byte: 125 di dati per DT
    await p.setup(240);
    const { list, pieces } = await p.readSzl(0x001c, 0);
    expect(list!.records).toHaveLength(10);
    expect(pieces).toHaveLength(2);
    const dts = p.cotp.filter((c) => c.type === 'DT');
    expect(dts.some((c) => c.type === 'DT' && !c.eot)).toBe(true);
    for (const c of dts) if (c.type === 'DT') expect(c.data.length).toBeLessThanOrEqual(125);
  });

  it('non manda mai job (ROSCTR 1): solo risposte', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(30));
    const p = await new TestPeer(cpu).open();
    await p.job(read(4));
    await p.job(encodeStartUpload('_0A00001A'));
    await p.job(Uint8Array.of(0x05, 0x00));
    await p.userdata(reqBlockCounts());
    expect(p.pdus.length).toBeGreaterThan(3);
    expect(p.pdus.every((x) => x.rosctr !== 1)).toBe(true);
  });
});

describe('upload', () => {
  async function chunks(p: TestPeer, id: number): Promise<number[]> {
    const sizes: number[] = [];
    for (;;) {
      const r = await p.job(encodeUpload(id));
      const u = decodeUploadResponse(r!.param, r!.data);
      sizes.push(u.chunk.length);
      if (!u.more) return sizes;
    }
  }

  it('sequenza start, upload a pezzi, end: stessi byte del blocco, pezzi da PDU - 18', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(300));
    const file = blockFile('FC', 5, seq(500));
    cpu.addBlock(file);
    const p = await new TestPeer(cpu).open();
    const st = await p.job(encodeStartUpload('_0A00001A'));
    expect(st!.rosctr).toBe(3);
    const started = decodeStartUploadResponse(st!.param);
    expect(started).toMatchObject({
      totalLength: 36 + 300 + 36,
      lengthString: '0000372',
      status: 0,
    });
    expect(hex(started.unknown)).toBe('0100');
    expect(await chunks(p, started.uploadId)).toEqual([222, 150]);
    const end = await p.job(encodeEndUpload(started.uploadId));
    expect(end!.rosctr).toBe(3);
    expect(() => decodeEndUploadResponse(end!.param)).not.toThrow();

    // contenuto: ricompongo i pezzi di FC5
    const st2 = decodeStartUploadResponse((await p.job(encodeStartUpload('_0C00005A')))!.param);
    const got: Uint8Array[] = [];
    for (;;) {
      const r = await p.job(encodeUpload(st2.uploadId));
      const u = decodeUploadResponse(r!.param, r!.data);
      got.push(u.chunk);
      expect(hex(u.dataHeader)).toBe('00fb');
      if (!u.more) break;
    }
    expect(hex(Uint8Array.from(got.flatMap((c) => [...c])))).toBe(hex(file));
    await p.job(encodeEndUpload(st2.uploadId));
    expect(parseBlockFile(file).header).toMatchObject({ type: 'FC', number: 5 });
  });

  it('i pezzi seguono la PDU negoziata (480 → 462)', async () => {
    const cpu = new FakeCpu({ pduLength: 480 });
    cpu.addDb(1, seq(900));
    const p = await new TestPeer(cpu).open(480);
    const st = decodeStartUploadResponse((await p.job(encodeStartUpload('_0A00001A')))!.param);
    expect(await chunks(p, st.uploadId)).toEqual([462, 462, 972 - 924]);
  });

  it('un blocco che sta in un pezzo ha EoU 0 (come _0B00000A reale)', async () => {
    const cpu = new FakeCpu();
    cpu.addBlock(blockFile('SDB', 0, seq(144), 7, 0));
    const p = await new TestPeer(cpu).open();
    const st = decodeStartUploadResponse((await p.job(encodeStartUpload('_0B00000A')))!.param);
    expect(st.totalLength).toBe(216);
    const r = await p.job(encodeUpload(st.uploadId));
    expect(hex(r!.param)).toBe('1e00');
    expect(r!.data).toHaveLength(220);
  });

  it("un secondo start in parallelo → 0x8304; l'end libera la sessione", async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(10));
    cpu.addDb(2, seq(10));
    const p = await new TestPeer(cpu).open();
    const a = decodeStartUploadResponse((await p.job(encodeStartUpload('_0A00001A')))!.param);
    const second = await p.job(encodeStartUpload('_0A00002A'));
    expect(second).toMatchObject({ rosctr: 2, errorClass: 0x83, errorCode: 0x04 });
    // l'altra connessione è indipendente
    const q = await new TestPeer(cpu).open();
    expect((await q.job(encodeStartUpload('_0A00002A')))!.rosctr).toBe(3);
    await p.job(encodeEndUpload(a.uploadId));
    const again = await p.job(encodeStartUpload('_0A00002A'));
    expect(again!.rosctr).toBe(3);
  });

  it('id sconosciuto in upload o end → 0x8401; end due volte → 0x8401', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(10));
    const p = await new TestPeer(cpu).open();
    expect(await p.job(encodeUpload(7))).toMatchObject({
      rosctr: 2,
      errorClass: 0x84,
      errorCode: 0x01,
    });
    expect(await p.job(encodeEndUpload(7))).toMatchObject({
      rosctr: 2,
      errorClass: 0x84,
      errorCode: 0x01,
    });
    const st = decodeStartUploadResponse((await p.job(encodeStartUpload('_0A00001A')))!.param);
    expect(await p.job(encodeUpload(st.uploadId + 1))).toMatchObject({
      errorClass: 0x84,
      errorCode: 0x01,
    });
    expect(await p.job(encodeEndUpload(st.uploadId + 1))).toMatchObject({
      errorClass: 0x84,
      errorCode: 0x01,
    });
    expect((await p.job(encodeEndUpload(st.uploadId)))!.rosctr).toBe(3);
    expect(await p.job(encodeEndUpload(st.uploadId))).toMatchObject({
      errorClass: 0x84,
      errorCode: 0x01,
    });
  });

  it('una connessione caduta libera la sessione (la CPU non resta bloccata)', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(10));
    const a = await new TestPeer(cpu).open();
    await a.job(encodeStartUpload('_0A00001A'));
    a.close();
    await new Promise((r) => setImmediate(r));
    const b = await new TestPeer(cpu).open();
    expect((await b.job(encodeStartUpload('_0A00001A')))!.rosctr).toBe(3);
  });

  it('blocco mancante → 0xD20C come la CPU vera (snap7.pcap); nome o filesystem non validi → 0xD201', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(10));
    const p = await new TestPeer(cpu).open();
    const miss = await p.job(encodeStartUpload('_0800000A'));
    expect(hex(miss!.param)).toBe('');
    expect(miss).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x0c });
    const badFs = await p.job(encodeStartUpload('_0A00001Z'));
    expect(badFs).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x01 });
    const raw = encodeStartUpload('_0A00001A');
    raw.set(new TextEncoder().encode('_XX'), 9);
    expect(await p.job(raw)).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x01 });
    for (const fs of ['P', 'B']) {
      const ok = await p.job(encodeStartUpload(`_0A00001${fs}`));
      expect(ok!.rosctr, fs).toBe(3);
      await p.job(encodeEndUpload(decodeStartUploadResponse(ok!.param).uploadId));
    }
  });
});

describe('userdata: continuazione', () => {
  it('continuazione senza frammentazione aperta o con sequence sbagliato → 0x8401', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const none = await p.userdata(reqContinue(4, 1, 3));
    expect(decodeUserdata(none!.param, none!.data).param.errorCode).toBe(0x8401);
    const first = await p.userdata(reqReadSzl(0x001c, 0));
    const u = decodeUserdata(first!.param, first!.data);
    expect(u.param.lastDataUnit).toBe(true);
    const wrong = await p.userdata(reqContinue(4, 1, u.param.sequence + 1));
    expect(decodeUserdata(wrong!.param, wrong!.data).param.errorCode).toBe(0x8401);
    // la frammentazione resta aperta: la continuazione giusta funziona
    const ok = await p.userdata(reqContinue(4, 1, u.param.sequence));
    const o = decodeUserdata(ok!.param, ok!.data);
    expect(o.param.errorCode).toBe(0);
    expect(o.param.lastDataUnit).toBe(false);
    // dopo l'ultimo pezzo non c'è più nulla da continuare
    const after = await p.userdata(reqContinue(4, 1, u.param.sequence));
    expect(decodeUserdata(after!.param, after!.data).param.errorCode).toBe(0x8401);
  });

  it('una risposta non frammentata ripete il sequence della richiesta, data unit reference 0', async () => {
    const p = await new TestPeer(new FakeCpu()).open();
    const r = await p.userdata(reqReadSzl(0x0011, 1, 5));
    const u = decodeUserdata(r!.param, r!.data);
    expect(u.param).toMatchObject({
      sequence: 5,
      dataUnitRef: 0,
      lastDataUnit: false,
      errorCode: 0,
    });
    expect(hex(r!.param)).toBe('000112081284010500000000');
  });
});

describe('guasti (FaultPlan)', () => {
  it('chunkSize: ogni TPKT in uscita arriva in pezzi di al più N byte', async () => {
    const p = new TestPeer(new FakeCpu({ faults: { chunkSize: 5 } }));
    await p.connect();
    await p.setup(480);
    await p.userdata(reqBlockCounts());
    expect(p.chunks.length).toBeGreaterThan(8);
    expect(p.chunks.every((c) => c.length <= 5)).toBe(true);
    expect(p.pdus).toHaveLength(2);
    expect(p.chunks.map((c) => c.length).filter((n) => n < 5).length).toBeLessThanOrEqual(3);
  });

  it('ignoreFunction: silenzio su quella funzione, le altre rispondono', async () => {
    const p = new TestPeer(new FakeCpu({ faults: { ignoreFunction: 0x04 } }));
    await p.connect();
    expect(await p.setup(480)).toBeDefined();
    expect(await p.job(read(1))).toBeUndefined();
    expect(await p.userdata(reqBlockCounts())).toBeDefined();
    const q = new TestPeer(new FakeCpu({ faults: { ignoreFunction: userdataFunction(4, 1) } }));
    await q.open();
    expect(await q.userdata(reqReadSzl(0x0011, 0))).toBeUndefined();
    expect(await q.job(read(1))).toBeDefined();
    expect(userdataFunction(4, 1)).toBe(0x1401);
  });

  it('errorFor: errore forzato per la funzione, anche nei userdata', async () => {
    const cpu = new FakeCpu({
      faults: { errorFor: { function: 0x04, errorClass: 0x85, errorCode: 0x01 } },
    });
    const p = await new TestPeer(cpu).open();
    expect(await p.job(read(1))).toMatchObject({ rosctr: 2, errorClass: 0x85, errorCode: 0x01 });
    const q = await new TestPeer(
      new FakeCpu({
        faults: {
          errorFor: { function: userdataFunction(3, 1), errorClass: 0xd2, errorCode: 0x09 },
        },
      }),
    ).open();
    const r = await q.userdata(reqBlockCounts());
    const u = decodeUserdata(r!.param, r!.data);
    expect(u.param.errorCode).toBe(0xd209);
    expect(u.returnCode).toBe(0x0a);
    expect((await q.job(read(1)))!.rosctr).toBe(3);
  });

  it('dropAfterResponses: dopo N risposte la connessione si chiude', async () => {
    const cpu = new FakeCpu({ faults: { dropAfterResponses: 2 } });
    const p = await new TestPeer(cpu).open(); // risposta 1: setup
    const second = await p.job(read(1)); // risposta 2, poi chiude
    expect(second!.rosctr).toBe(3);
    await new Promise((r) => setImmediate(r));
    expect(p.closed).toBe(true);
    expect(cpu.connections).toBe(0);
    const zero = new TestPeer(new FakeCpu({ faults: { dropAfterResponses: 0 } }));
    await zero.connect();
    expect(await zero.setup()).toBeUndefined();
    expect(zero.closed).toBe(true);
  });

  it('delayMs: nessuna risposta prima del ritardo, poi in ordine', async () => {
    const p = new TestPeer(new FakeCpu({ faults: { delayMs: 60 } }));
    await p.connect();
    await sleep(120);
    expect(p.cotp[0]?.type).toBe('CC');
    await p.setup(480);
    await p.job(read(1), NOTHING, 11);
    await p.job(read(2), NOTHING, 12);
    expect(p.pdus).toHaveLength(0);
    await sleep(160);
    expect(p.pdus.map((x) => x.pduRef)).toEqual([1, 11, 12]);
  });

  it('i guasti sono deterministici: stesse richieste, stessi byte', async () => {
    const run = async (): Promise<string> => {
      const cpu = new FakeCpu({ faults: { chunkSize: 7 } });
      cpu.addDb(1, seq(50));
      const p = await new TestPeer(cpu).open();
      await p.readSzl(0x001c, 0);
      await p.job(read(3));
      return p.chunks.map(hex).join('|');
    };
    expect(await run()).toBe(await run());
  });
});

describe('opzioni', () => {
  it('valori predefiniti di proto §7.4 e del brief', async () => {
    const cpu = new FakeCpu();
    expect(cpu.mode).toBe('RUN');
    const p = await new TestPeer(cpu).open();
    expect(p.pdu).toBe(240);
    const comm = (await p.readSzl(0x0131, 1)).list!;
    expect(comm.records[0]!.slice(2, 6)).toEqual(Uint8Array.of(0x00, 0xf0, 0x00, 0x10));
  });

  it('opzioni non valide → RangeError', () => {
    expect(() => new FakeCpu({ pduLength: 10 })).toThrow(RangeError);
    expect(() => new FakeCpu({ maxConnections: 0 })).toThrow(RangeError);
    expect(() => new FakeCpu({ rack: 9 })).toThrow(RangeError);
    expect(() => new FakeCpu({ protectionLevel: 4 as 3 })).toThrow(RangeError);
    expect(() => new FakeCpu({ faults: { chunkSize: 0 } })).toThrow(RangeError);
    expect(() => new FakeCpu({ faults: { delayMs: -1 } })).toThrow(RangeError);
    const cpu = new FakeCpu();
    expect(() => cpu.setMemory('M', 2047, Uint8Array.of(1, 2))).toThrow(RangeError);
    expect(() => cpu.addBlock(Uint8Array.of(1, 2, 3))).toThrow();
    expect(() => cpu.addDb(70000, seq(1))).toThrow(RangeError);
    expect(() => cpu.addDb(1, new Uint8Array(70000))).toThrow(RangeError);
  });
});

describe('write var e stop/avvio (allowlist)', () => {
  const wr = (
    area: ReadItem['area'],
    start: number,
    data: Uint8Array,
    db = 0,
  ): ReturnType<typeof encodeWriteRequest> =>
    encodeWriteRequest([{ area, db, start, size: 'BYTE', count: data.length, data }]);

  it('write var su MW10 poi read var rilegge il valore scritto', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const { param, data } = wr('M', 10, Uint8Array.of(0x12, 0x34));
    const r = await p.job(param, data);
    expect(r).toMatchObject({ rosctr: 3, errorClass: 0, errorCode: 0 });
    expect(decodeWriteResponse(r!.param, r!.data)[0]!.returnCode).toBe(0xff);
    const back = await p.job(
      encodeReadRequest([{ area: 'M', db: 0, start: 10, size: 'BYTE', count: 2 }]),
    );
    const item = decodeReadResponse(back!.param, back!.data)[0]!;
    expect(item).toMatchObject({ ok: true, data: Uint8Array.of(0x12, 0x34) });
  });

  it('write var su DB inesistente → 0x0A; oltre la dimensione di M → 0x05; stato invariato per quegli item', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const before = cpu.snapshot();
    const a = wr('DB', 0, Uint8Array.of(1), 99);
    const ra = await p.job(a.param, a.data);
    expect(decodeWriteResponse(ra!.param, ra!.data)[0]!.returnCode).toBe(0x0a);
    const b = wr('M', 2047, Uint8Array.of(1, 2));
    const rb = await p.job(b.param, b.data);
    expect(decodeWriteResponse(rb!.param, rb!.data)[0]!.returnCode).toBe(0x05);
    expect(cpu.snapshot()).toBe(before);
  });

  it('PLC stop porta mode a STOP; secondo stop → para 0x07; SZL 0x0424 ora dice STOP', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const r1 = await p.job(encodePlcStop());
    expect(r1).toMatchObject({ rosctr: 3, errorClass: 0, errorCode: 0 });
    expect(decodeControlResponse(r1!.param).code).toBe(0);
    expect(cpu.mode).toBe('STOP');
    const r2 = await p.job(encodePlcStop());
    expect(decodeControlResponse(r2!.param).code).toBe(0x07);
    const szl = (await p.readSzl(0x0424, 0)).list!;
    expect(szl.records[0]![3]! & 0x0f).toBe(0x4);
  });

  it('warm restart porta mode a RUN; secondo → para 0x03', async () => {
    const cpu = new FakeCpu({ mode: 'STOP' });
    const p = await new TestPeer(cpu).open();
    const r1 = await p.job(encodeWarmRestart());
    expect(decodeControlResponse(r1!.param).code).toBe(0);
    expect(cpu.mode).toBe('RUN');
    const r2 = await p.job(encodeWarmRestart());
    expect(decodeControlResponse(r2!.param).code).toBe(0x03);
    const szl = (await p.readSzl(0x0424, 0)).list!;
    expect(szl.records[0]![3]! & 0x0f).toBe(0x8);
  });

  it('con protezione 2 la write var risponde 0xD241 e non cambia la memoria', async () => {
    const cpu = new FakeCpu({ protectionLevel: 2 });
    const p = await new TestPeer(cpu).open();
    const before = cpu.snapshot();
    const { param, data } = wr('M', 10, Uint8Array.of(0x55));
    const r = await p.job(param, data);
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    const s = await p.job(encodePlcStop());
    expect(s).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    const w = await p.job(encodeWarmRestart());
    expect(w).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    expect(cpu.snapshot()).toBe(before);
    const back = await p.job(read(1));
    expect(decodeReadResponse(back!.param, back!.data)[0]).toMatchObject({ ok: true });
  });

  it('0x28 con servizio _MODU resta ERR.PROTECTED (fuori allowlist)', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const before = cpu.snapshot();
    const modu = Uint8Array.from([
      ...[0x28, 0, 0, 0, 0, 0, 0, 0xfd, 0, 0, 5],
      ...[...'_MODU'].map((c) => c.charCodeAt(0)),
    ]);
    const r = await p.job(modu);
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    expect(cpu.snapshot()).toBe(before);
  });
});

describe('download di un blocco (ruoli invertiti: il finto PLC manda i job 0x1B/0x1C)', () => {
  const transportFor =
    (cpu: FakeCpu): TransportFactory =>
    async () => {
      const [a, b] = memoryTransportPair();
      serve(cpu, b);
      return a;
    };

  const openWrite = (cpu: FakeCpu): Promise<S7Connection> =>
    S7Connection.open({
      host: 'finto',
      transport: transportFor(cpu),
      timeoutMs: 2000,
      mode: 'online-write',
    });

  /** Il lato PG del download: 0x1A, fette su richiesta, 0x1C. Non manda l'_INSE. */
  async function download(
    conn: S7Connection,
    file: Uint8Array,
    declared: { load?: number; mc7?: number } = {},
  ): Promise<void> {
    const parsed = parseBlockFile(file);
    const slices = sliceBlockForDownload(file, 240);
    let i = 0;
    await conn.runDownload(
      encodeRequestDownload(
        parsed.header.type!,
        parsed.header.number,
        'P',
        declared.load ?? file.length,
        declared.mc7 ?? parsed.header.mc7Length,
      ),
      () => {
        const chunk = slices[i]!;
        i++;
        return { eos: i < slices.length, chunk };
      },
      () => undefined,
    );
  }

  it('download di un blocco costruito con buildBlockFile: dopo _INSE compare in list-blocks e si rilegge in upload identico', async () => {
    const cpu = new FakeCpu();
    const file = blockFile('DB', 5, seq(700, 9), 5);
    const conn = await openWrite(cpu);
    await download(conn, file);
    // fino all'_INSE il blocco non esiste
    expect(cpu.blockList('DB')).toEqual([]);
    const r = await conn.request(encodeInsertBlock('DB', 5, 'P'), NOTHING, 1);
    expect(r).toMatchObject({ rosctr: 3, errorClass: 0, errorCode: 0 });
    expect(r.param[0]).toBe(0x28);
    expect(cpu.blockList('DB').map((b) => b.number)).toEqual([5]);
    expect(cpu.block('DB', 5)!.file).toEqual(file);
    await conn.close();

    const c = await S7Client.connect({
      host: 'finto',
      transport: transportFor(cpu),
      timeoutMs: 2000,
    });
    try {
      expect((await c.listBlocks('DB')).map((e) => e.number)).toEqual([5]);
      expect(await c.upload('DB', 5)).toEqual(file);
    } finally {
      await c.close();
    }
  });

  it('download senza _INSE finale → il blocco NON compare (stato invariato)', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(20));
    const before = cpu.snapshot();
    const conn = await openWrite(cpu);
    await download(conn, blockFile('DB', 5, seq(700, 9), 5));
    await conn.close();
    await sleep(10);
    expect(cpu.blockList('DB').map((b) => b.number)).toEqual([1]);
    expect(cpu.block('DB', 5)).toBeUndefined();
    expect(cpu.snapshot()).toBe(before);
    expect(cpu.connections).toBe(0);
  });

  it('lunghezza dichiarata ≠ byte ricomposti → errore, blocco non inserito', async () => {
    for (const declared of [{ load: 999 }, { mc7: 5 }]) {
      const cpu = new FakeCpu();
      const before = cpu.snapshot();
      const conn = await openWrite(cpu);
      await download(conn, blockFile('DB', 5, seq(700, 9), 5), declared);
      const r = await conn.request(encodeInsertBlock('DB', 5, 'P'), NOTHING, 1);
      expect(r.rosctr).toBe(2);
      expect(r.errorClass).not.toBe(0);
      expect(cpu.block('DB', 5)).toBeUndefined();
      expect(cpu.snapshot()).toBe(before);
      await conn.close();
    }
  });

  it('secondo download in parallelo → errore "nessun download possibile"', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const req = encodeRequestDownload('DB', 5, 'P', 100, 10);
    await p.job(req);
    // l'ack 0x1A è seguito dal primo job 0x1B del finto PLC
    expect(p.pdus.at(-2)).toMatchObject({ rosctr: 3 });
    expect(p.pdus.at(-1)).toMatchObject({ rosctr: 1 });
    expect(p.pdus.at(-1)!.param[0]).toBe(0x1b);
    const r = await p.job(req);
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0x83, errorCode: 0x04 });
    expect(cpu.block('DB', 5)).toBeUndefined();
  });

  it('con protezione 2 il request download risponde 0xD241 e non parte nessun job', async () => {
    const cpu = new FakeCpu({ protectionLevel: 2 });
    const p = await new TestPeer(cpu).open();
    const r = await p.job(encodeRequestDownload('DB', 5, 'P', 100, 10));
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    expect(p.pdus.some((x) => x.rosctr === 1)).toBe(false);
  });

  it('_INSE senza download in corso resta un servizio non ammesso; un ack-data spurio è ignorato', async () => {
    const cpu = new FakeCpu();
    const p = await new TestPeer(cpu).open();
    const before = cpu.snapshot();
    const r = await p.job(encodeInsertBlock('DB', 5, 'P'));
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    const n = p.pdus.length;
    await p.send({ rosctr: 3, param: Uint8Array.of(0x1b, 0), data: new Uint8Array(4), pduRef: 9 });
    expect(p.pdus.length).toBe(n);
    expect(cpu.snapshot()).toBe(before);
  });

  it('connessione caduta a metà download → nessun blocco e la CPU si libera', async () => {
    const cpu = new FakeCpu();
    const before = cpu.snapshot();
    const p = await new TestPeer(cpu).open();
    await p.job(encodeRequestDownload('DB', 5, 'P', 100, 10));
    p.close();
    await sleep(10);
    expect(cpu.connections).toBe(0);
    expect(cpu.snapshot()).toBe(before);
  });
});
