import { describe, expect, it } from 'vitest';
import {
  commFrom,
  decodeBlockCounts,
  decodeBlockInfo,
  decodeBlockListOfType,
  decodeReadResponse,
  decodeUserdata,
  diagFrom,
  encodeReadRequest,
  encodeSzl,
  hex,
  identityFrom,
  modeFrom,
  parseSzl,
  protectionFrom,
  reqBlockCounts,
  reqBlockInfo,
  reqBlockListOfType,
  reqContinue,
  reqReadClock,
  decodeBcdDateTime,
  encodeStartUpload,
  type ReadItem,
} from '@baaportal/s7comm';
import { FakeCpu } from '../src';
import { NOTHING, TestPeer, blockFile, realSzl, seq, u16 } from './helpers';

const item = (o: Partial<ReadItem> & Pick<ReadItem, 'area'>): ReadItem => ({
  db: 0,
  start: 0,
  size: 'BYTE',
  count: 1,
  ...o,
});

async function readVar(p: TestPeer, items: ReadItem[]) {
  const r = await p.job(encodeReadRequest(items));
  if (!r) throw new Error('nessuna risposta');
  return r;
}

describe('COTP: CC e DR', () => {
  it('TSAP giusto → CC nel layout della CPU vera (proto §17.1); slot sbagliato → DR', async () => {
    const cpu = new FakeCpu();
    const ok = new TestPeer(cpu);
    const cc = await ok.connect();
    expect(cc).toMatchObject({
      type: 'CC',
      dstRef: 0x0100,
      tpduSize: 0x0a,
      srcTsap: 0x0100,
      dstTsap: 0x0102,
    });
    // TPKT 22 byte, LI 0x11, ordine dei parametri C0 C1 C2
    expect(hex(ok.chunks[0]!)).toMatch(/^0300001611d00100[0-9a-f]{4}00c0010ac1020100c2020102$/);
    expect(cpu.connections).toBe(1);

    const wrong = new TestPeer(cpu);
    const dr = await wrong.connect({ dstTsap: 0x0103 });
    expect(dr).toMatchObject({ type: 'DR', dstRef: 0x0100 });
    expect(wrong.closed).toBe(true);
    expect(cpu.connections).toBe(1);
  });

  it('accetta i tipi 1, 2 e 3 con rack e slot configurati; rifiuta gli altri', async () => {
    const cpu = new FakeCpu({ rack: 1, slot: 3 });
    for (const [tsap, want] of [
      [0x0123, 'CC'],
      [0x0223, 'CC'],
      [0x0323, 'CC'],
      [0x0423, 'DR'],
      [0x0023, 'DR'],
      [0x0102, 'DR'],
      [0x0124, 'DR'],
    ] as const) {
      const p = new TestPeer(cpu);
      expect((await p.connect({ dstTsap: tsap }))?.type, tsap.toString(16)).toBe(want);
    }
  });

  it('TPDU-size del CC = minimo tra richiesta e 0x0A', async () => {
    const small = new TestPeer(new FakeCpu());
    expect(await small.connect({ tpduSize: 0x08 })).toMatchObject({ type: 'CC', tpduSize: 0x08 });
    const big = new TestPeer(new FakeCpu());
    expect(await big.connect({ tpduSize: 0x0d })).toMatchObject({ type: 'CC', tpduSize: 0x0a });
  });
});

describe('SZL', () => {
  it('0x0011 del finto PLC = quella della CPU vera di proto §17.5 (stessi campi, stesso ordine)', async () => {
    const real = parseSzl(realSzl('snap7.pcap').get('11/0')!);
    const cpu = new FakeCpu({ firmware: 'V3.2.7' });
    const p = await new TestPeer(cpu).open();
    const { list } = await p.readSzl(0x0011, 0);
    expect(list!.recordLength).toBe(28);
    expect(list!.records).toHaveLength(4);
    expect(list!.records.map((r) => u16(r, 0))).toEqual([1, 6, 7, 0x81]);
    expect(hex(encodeSzl(list!, 214)[0]!)).toBe(hex(encodeSzl(real, 214)[0]!));
    const id = identityFrom(list!);
    expect(id.orderNumber).toBe('6ES7 315-2EH14-0AB0');
    expect(id.version).toBe('V3.2.7');
  });

  it('0x0011 e 0x0111 per indice: un solo record; indice ignoto → 0xD402', async () => {
    const p = await new TestPeer(new FakeCpu()).open();
    for (const [id, index] of [
      [0x0011, 1],
      [0x0011, 6],
      [0x0111, 7],
    ] as const) {
      const { list } = await p.readSzl(id, index);
      expect(list!.id).toBe(id);
      expect(list!.index).toBe(index);
      expect(list!.records).toHaveLength(1);
      expect(u16(list!.records[0]!, 0)).toBe(index);
    }
    for (const [id, index] of [
      [0x0011, 9],
      [0x0111, 0],
      [0x0999, 0],
    ] as const) {
      const { error } = await p.readSzl(id, index);
      // forma reale (cattura goOnline): errore nel parametro, return code 0x0A, dati 0a 00 00 00
      expect(error!.param.errorCode).toBe(0xd402);
      expect(error!.returnCode).toBe(0x0a);
      expect(error!.transportSize).toBe(0);
      expect(error!.payload).toHaveLength(0);
    }
  });

  it('0x001C: 10 record da 34 byte con le stringhe configurate, a pezzi 214 + 134 come la CPU vera', async () => {
    const p = await new TestPeer(new FakeCpu()).open();
    const { list, pieces } = await p.readSzl(0x001c, 0);
    expect(pieces.map((x) => x.payload.length)).toEqual([214, 134]);
    expect(pieces.map((x) => x.param.lastDataUnit)).toEqual([true, false]);
    expect(pieces[0]!.param.sequence).toBe(pieces[1]!.param.sequence);
    expect(pieces[0]!.param.sequence).not.toBe(0);
    expect(pieces[0]!.param.dataUnitRef).toBe(pieces[1]!.param.dataUnitRef);
    expect(list!.recordLength).toBe(34);
    expect(list!.records.map((r) => u16(r, 0))).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    const id = identityFrom((await p.readSzl(0x0011, 0)).list!, list!);
    expect(id).toMatchObject({
      asName: 'BaaPortal finto PLC',
      moduleName: 'CPU 315-2 PN/DP',
      serialNumber: 'S C-BAA000000001',
      copyright: 'Original Siemens Equipment',
    });
  });

  it('0x0000 elenca esattamente le liste implementate e, oltre la PDU, arriva a pezzi con last-data-unit giusto', async () => {
    // Con pochi id l'elenco sta in una PDU da 240 (a differenza delle 112 voci di una CPU vera):
    // con una PDU da 60 (pezzi da 34 byte) 8 + 2*18 byte si spezzano come farebbe la CPU.
    const p = await new TestPeer(new FakeCpu({ pduLength: 60 })).open();
    expect(p.pdu).toBe(60);
    const { list, pieces } = await p.readSzl(0x0000, 0);
    expect(pieces.map((x) => x.payload.length)).toEqual([34, 30]);
    expect(pieces.map((x) => x.param.lastDataUnit)).toEqual([true, false]);
    const ids = list!.records.map((r) => u16(r, 0));
    expect(ids).toEqual([
      0x0000, 0x0f00, 0x0011, 0x0111, 0x0f11, 0x0013, 0x0f13, 0x0019, 0x0f19, 0x001c, 0x011c,
      0x0f1c, 0x0222, 0x0f22, 0x0124, 0x0424, 0x0f24, 0x0131, 0x0f31, 0x0132, 0x0232, 0x0f32,
      0x0074, 0x0174, 0x0f74, 0x00a0, 0x01a0, 0x0fa0,
    ]);
    // ogni id elencato risponde; uno non elencato no
    const big = await new TestPeer(new FakeCpu()).open();
    const needsIndex: Record<number, number> = {
      0x0111: 1,
      0x011c: 1,
      0x0131: 1,
      0x0132: 4,
      0x0232: 4,
      0x01a0: 2,
      0x0174: 1,
      0x0222: 1,
    };
    for (const id of ids) {
      const r = await big.readSzl(id, needsIndex[id] ?? 0);
      expect(r.error, `0x${id.toString(16)}`).toBeUndefined();
    }
    expect((await big.readSzl(0x0f99, 0)).error!.param.errorCode).toBe(0xd402);
  });

  it('0x0F11, 0x0F1C...: solo intestazione, con record e conteggio della lista piena', async () => {
    const p = await new TestPeer(new FakeCpu()).open();
    const want: [number, number, number][] = [
      [0x0f11, 28, 4],
      [0x0f1c, 34, 10],
      [0x0f31, 40, 2],
      [0x0f32, 40, 1],
      [0x0f24, 20, 1],
      [0x0fa0, 20, 0],
      [0x0f00, 2, 28],
      [0x0f13, 36, 5],
      [0x0f19, 4, 7],
      [0x0f74, 4, 7],
      [0x0f22, 28, 2],
    ];
    for (const [id, len, n] of want) {
      const { list, pieces } = await p.readSzl(id, 0);
      expect(pieces, `0x${id.toString(16)}`).toHaveLength(1);
      expect(pieces[0]!.payload).toHaveLength(8);
      expect(list).toMatchObject({
        id,
        recordLength: len,
        records: [],
        ...(n ? { declaredCount: n } : {}),
      });
    }
  });

  it('0x0131 indice 1 è uguale byte per byte a quello della 315-2EH14 vera; indice 2 esiste', async () => {
    const real = realSzl('snap7.pcap').get('131/1')![0]!;
    const p = await new TestPeer(new FakeCpu()).open();
    const { list } = await p.readSzl(0x0131, 1);
    expect(hex(encodeSzl(list!, 214)[0]!)).toBe(hex(real));
    expect(commFrom(list!)).toEqual({ maxPdu: 240, maxConnections: 16 });
    const two = await p.readSzl(0x0131, 2);
    expect(two.list!.records).toHaveLength(1);
    expect(two.list!.recordLength).toBe(40);
    expect((await p.readSzl(0x0131, 3)).error!.param.errorCode).toBe(0xd402);
  });

  it("0x0424 modo (nibble di bzu-id all'offset 3) segue setMode", async () => {
    const cpu = new FakeCpu({
      clock: () => ({ year: 2024, month: 3, day: 9, hour: 8, minute: 7, second: 6, ms: 5 }),
    });
    const p = await new TestPeer(cpu).open();
    const real = realSzl('snap7.pcap').get('424/0')![0]!;
    const first = (await p.readSzl(0x0424, 0)).list!;
    expect(modeFrom(first)).toBe('RUN');
    expect(hex(encodeSzl(first, 214)[0]!).slice(0, 16 + 24)).toBe(hex(real).slice(0, 16 + 24));
    for (const m of ['STOP', 'STARTUP', 'HOLD', 'DEFECT'] as const) {
      cpu.setMode(m);
      expect(modeFrom((await p.readSzl(0x0424, 0)).list!)).toBe(m);
    }
  });

  it('0x0132/0x0232 indice 4 riportano il livello di protezione configurato', async () => {
    for (const level of [1, 2, 3] as const) {
      const p = await new TestPeer(new FakeCpu({ protectionLevel: level })).open();
      for (const id of [0x0132, 0x0232]) {
        const { list } = await p.readSzl(id, 4);
        expect(list!.recordLength).toBe(40);
        expect(protectionFrom(list!).validLevel).toBe(level);
      }
    }
  });

  it('0x00A0 e 0x01A0: buffer diagnostico, il più recente per primo; 0x01A0 indice N = N più recenti', async () => {
    const cpu = new FakeCpu();
    const time = { year: 2023, month: 12, day: 31, hour: 23, minute: 59, second: 58, ms: 120 };
    for (let i = 1; i <= 12; i++) {
      cpu.addDiagnostic({ eventId: 0x4300 + i, info: Uint8Array.of(i, i), time });
    }
    const p = await new TestPeer(cpu).open();
    const all = (await p.readSzl(0x00a0, 0)).list!;
    expect(all.records).toHaveLength(12);
    const diag = diagFrom(all);
    expect(diag[0]!.eventId).toBe(0x430c);
    expect(diag[11]!.eventId).toBe(0x4301);
    expect(diag[0]!.time).toMatchObject({ year: 2023, month: 12, day: 31, ms: 120 });
    expect(diag[0]!.info.slice(0, 2)).toEqual(Uint8Array.of(12, 12));
    const three = diagFrom((await p.readSzl(0x01a0, 3)).list!);
    expect(three.map((d) => d.eventId)).toEqual([0x430c, 0x430b, 0x430a]);
    // 8 + 12*20 = 248 byte: a pezzi 214 + 34
    expect((await p.readSzl(0x00a0, 0)).pieces.map((x) => x.payload.length)).toEqual([214, 34]);
  });
});

describe('read var', () => {
  it('DB inesistente → 0x0A; oltre la dimensione di M → 0x05; forma reale 0a 00 00 00', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(100));
    const p = await new TestPeer(cpu).open();
    const r = await readVar(p, [
      item({ area: 'DB', db: 7, count: 4 }),
      item({ area: 'M', start: 2048 }),
      item({ area: 'M', start: 2047, count: 2 }),
      item({ area: 'DB', db: 1, start: 99, count: 2 }),
      item({ area: 'DB', db: 1, start: 98, count: 2 }),
    ]);
    expect(r.rosctr).toBe(3);
    const res = decodeReadResponse(r.param, r.data);
    expect(res.map((x) => (x.ok ? 0xff : x.returnCode))).toEqual([0x0a, 0x05, 0x05, 0x05, 0xff]);
    expect(hex(r.data.slice(0, 4))).toBe('0a000000');
    expect(hex(r.data.slice(4, 8))).toBe('05000000');
  });

  it('dati e transport size secondo responseTransportFor, con il riempimento tra item', async () => {
    const cpu = new FakeCpu();
    cpu.setMemory('M', 0, Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05, 0x06));
    cpu.setMemory('I', 0, Uint8Array.of(0xaa, 0xbb));
    cpu.setMemory('Q', 4, Uint8Array.of(0x5a));
    cpu.addDb(2, seq(16, 0x10));
    const p = await new TestPeer(cpu).open();
    const r = await readVar(p, [
      item({ area: 'M', count: 3 }), // 3 byte (dispari → riempimento)
      item({ area: 'M', size: 'INT', count: 1 }),
      item({ area: 'M', size: 'REAL', count: 1 }),
      item({ area: 'M', start: 1, size: 'BIT', bit: 1, count: 1 }),
      item({ area: 'I', size: 'WORD', count: 1 }),
      item({ area: 'Q', start: 4 }),
      item({ area: 'DB', db: 2, start: 14, count: 2 }),
      item({ area: 'DI', db: 2, start: 0, count: 1 }),
      item({ area: 'T', size: 'TIMER', count: 8 }),
      item({ area: 'C', start: 255, size: 'COUNTER', count: 1 }),
    ]);
    const res = decodeReadResponse(r.param, r.data);
    const got = res.map((x) => (x.ok ? `${x.transportSize}:${hex(x.data)}` : `err${x.returnCode}`));
    expect(got).toEqual([
      '4:010203',
      '5:0102',
      '7:01020304',
      '3:01',
      '4:aabb',
      '4:5a',
      '4:1e1f',
      '4:10',
      `9:${'00'.repeat(16)}`,
      '9:0000',
    ]);
    // lunghezze grezze: bit per BYTE/WORD/INT, byte per REAL e timer, 1 per BIT
    const lens: number[] = [];
    for (let o = 0, i = 0; i < res.length; i++) {
      const x = res[i]!;
      if (!x.ok) throw new Error('item');
      lens.push(u16(r.data, o + 2));
      o += 4 + x.data.length + (x.data.length % 2 === 1 && i < res.length - 1 ? 1 : 0);
    }
    expect(lens).toEqual([24, 16, 4, 1, 16, 8, 16, 8, 16, 2]);
  });

  it('timer oltre i 256 configurati → 0x05; aree L e V non leggibili → 0x03', async () => {
    const sizes = { inputBytes: 8, outputBytes: 8, mBytes: 8, timers: 4, counters: 4 };
    const p = await new TestPeer(new FakeCpu({ sizes })).open();
    const r = await readVar(p, [
      item({ area: 'T', start: 3, size: 'TIMER', count: 1 }),
      item({ area: 'T', start: 4, size: 'TIMER', count: 1 }),
      item({ area: 'C', start: 2, size: 'COUNTER', count: 3 }),
      item({ area: 'I', start: 7 }),
      item({ area: 'I', start: 8 }),
      item({ area: 'Q', start: 6, count: 3 }),
      item({ area: 'M', start: 7, size: 'BIT', bit: 7 }),
      item({ area: 'M', start: 8, size: 'BIT', bit: 0 }),
      item({ area: 'L' }),
      item({ area: 'V' }),
      item({ area: 'P' }),
    ]);
    const res = decodeReadResponse(r.param, r.data);
    expect(res.map((x) => (x.ok ? 0xff : x.returnCode))).toEqual([
      0xff, 0x05, 0x05, 0xff, 0x05, 0x05, 0xff, 0x05, 0x03, 0x03, 0x05,
    ]);
  });

  it('una risposta che non entra nella PDU → errore di header 0x8500 (frame errati)', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(400));
    const p = await new TestPeer(cpu).open();
    const ok = await readVar(p, [item({ area: 'DB', db: 1, count: 222 })]);
    expect(ok.rosctr).toBe(3);
    expect(ok.data).toHaveLength(226);
    const big = await readVar(p, [item({ area: 'DB', db: 1, count: 223 })]);
    expect(big).toMatchObject({ rosctr: 2, errorClass: 0x85, errorCode: 0x00 });
    // anche la somma di più item conta
    const multi = await readVar(p, [
      item({ area: 'DB', db: 1, count: 120 }),
      item({ area: 'DB', db: 1, count: 120 }),
    ]);
    expect(multi).toMatchObject({ rosctr: 2, errorClass: 0x85, errorCode: 0x00 });
  });
});

describe('lo stato non cambia da rete per le funzioni non ammesse', () => {
  it('download, controllo fuori allowlist, set clock, sconosciute → errore e stato invariato', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(32));
    cpu.setMemory('M', 0, seq(8, 1));
    const before = cpu.snapshot();
    const p = await new TestPeer(cpu).open();
    // PDU costruite a mano; write var e stop sono funzioni ammesse (session.test.ts)
    const mres = Uint8Array.of(0x28, 0, 0, 0, 0, 0, 0, 0xfd, 0, 0, 5, 0x5f, 0x4d, 0x52, 0x45, 0x53);
    expect(await p.job(mres)).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    // 0x1A è ammesso (download, session.test.ts): troncato è una richiesta malformata
    expect(await p.job(Uint8Array.of(0x1a, 0, 1, 0, 0, 0, 0, 0))).toMatchObject({
      rosctr: 2,
      errorClass: 0x85,
      errorCode: 0x00,
    });
    for (const fn of [0x1b, 0x1c]) {
      expect(await p.job(Uint8Array.of(fn, 0, 1, 0, 0, 0, 0, 0))).toMatchObject({
        rosctr: 2,
        errorClass: 0xd2,
        errorCode: 0x41,
      });
    }
    // set clock (userdata gruppo 7 sottofunzione 2), costruito a mano
    const setClock = await p.send({
      rosctr: 7,
      param: Uint8Array.of(0x00, 0x01, 0x12, 0x04, 0x11, 0x47, 0x02, 0x00),
      data: Uint8Array.of(
        0xff,
        0x09,
        0x00,
        0x0a,
        0x00,
        0x19,
        0x14,
        0x08,
        0x20,
        0x11,
        0x59,
        0x33,
        0x04,
        0x00,
      ),
    });
    // la FakeCpu non ha setClock: userdata 7/2 con error code "non implementato" (0x8104)
    expect(decodeUserdata(setClock!.param, setClock!.data).param.errorCode).toBe(0x8104);
    // funzione del tutto sconosciuta: servizio non implementato
    expect(await p.job(Uint8Array.of(0x99, 0, 0, 0))).toMatchObject({
      rosctr: 2,
      errorClass: 0x81,
      errorCode: 0x04,
    });
    expect(cpu.snapshot()).toBe(before);
    // la lettura mostra ancora i dati originali
    const r = await readVar(p, [
      item({ area: 'M', count: 4 }),
      item({ area: 'DB', db: 1, count: 2 }),
    ]);
    expect(decodeReadResponse(r.param, r.data).map((x) => (x.ok ? hex(x.data) : 'err'))).toEqual([
      '01020304',
      '0001',
    ]);
    expect(cpu.mode).toBe('RUN');
  });
});

describe('protezione', () => {
  it('livello 3: read var e start upload rifiutati con 0xD241; SZL, blocchi e orologio leggibili', async () => {
    const cpu = new FakeCpu({ protectionLevel: 3 });
    cpu.addDb(1, seq(10));
    const p = await new TestPeer(cpu).open();
    expect(await readVar(p, [item({ area: 'M' })])).toMatchObject({
      rosctr: 2,
      errorClass: 0xd2,
      errorCode: 0x41,
      param: NOTHING,
    });
    // forma reale di s7ident.pcap: ack ROSCTR 2 senza parametro né dati
    const up = await p.job(encodeStartUpload('_0A00001A'));
    expect(up).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    expect(up!.param).toHaveLength(0);
    expect(up!.data).toHaveLength(0);
    expect(identityFrom((await p.readSzl(0x0011, 0)).list!).orderNumber).toBe(
      '6ES7 315-2EH14-0AB0',
    );
    expect(protectionFrom((await p.readSzl(0x0132, 4)).list!).validLevel).toBe(3);
    const counts = await p.userdata(reqBlockCounts());
    expect(decodeBlockCounts(decodeUserdata(counts!.param, counts!.data).payload).DB).toBe(1);
    const clk = await p.userdata(reqReadClock());
    expect(decodeBcdDateTime(decodeUserdata(clk!.param, clk!.data).payload).year).toBeGreaterThan(
      2000,
    );
  });

  it('livello 2: le letture funzionano', async () => {
    const cpu = new FakeCpu({ protectionLevel: 2 });
    cpu.setMemory('M', 0, Uint8Array.of(9));
    const p = await new TestPeer(cpu).open();
    const r = await readVar(p, [item({ area: 'M' })]);
    expect(decodeReadResponse(r.param, r.data)[0]).toMatchObject({ ok: true });
  });
});

describe('connessioni', () => {
  it('17ª connessione → DR; connections conta le sessioni aperte e torna a 0', async () => {
    const cpu = new FakeCpu();
    const peers: TestPeer[] = [];
    for (let i = 0; i < 16; i++) {
      const p = new TestPeer(cpu);
      expect((await p.connect())?.type).toBe('CC');
      peers.push(p);
    }
    expect(cpu.connections).toBe(16);
    const extra = new TestPeer(cpu);
    expect((await extra.connect())?.type).toBe('DR');
    expect(extra.closed).toBe(true);
    expect(cpu.connections).toBe(16);
    // una sessione che chiude libera il posto
    peers[0]!.close();
    await new Promise((r) => setImmediate(r));
    expect(cpu.connections).toBe(15);
    const again = new TestPeer(cpu);
    expect((await again.connect())?.type).toBe('CC');
    for (const p of [...peers, again]) p.close();
    await new Promise((r) => setImmediate(r));
    expect(cpu.connections).toBe(0);
  });

  it('maxConnections configurabile', async () => {
    const cpu = new FakeCpu({ maxConnections: 2 });
    const a = new TestPeer(cpu);
    const b = new TestPeer(cpu);
    const c = new TestPeer(cpu);
    expect((await a.connect())?.type).toBe('CC');
    expect((await b.connect())?.type).toBe('CC');
    expect((await c.connect())?.type).toBe('DR');
  });
});

describe('blocchi', () => {
  it('conteggi, elenco e info coerenti con i blocchi caricati (anche SFC e SFB)', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(40));
    cpu.addDb(7, seq(8));
    cpu.addBlock(blockFile('OB', 1, seq(30)));
    cpu.addBlock(blockFile('FC', 12, seq(10), 2, 0x42));
    cpu.addBlock(blockFile('SFC', 20, seq(4)));
    cpu.addBlock(blockFile('SFB', 3, seq(6)));
    cpu.addBlock(blockFile('SDB', 0, seq(6), 7, 0x00));
    const p = await new TestPeer(cpu).open();
    const c = await p.userdata(reqBlockCounts());
    const cu = decodeUserdata(c!.param, c!.data);
    expect(decodeBlockCounts(cu.payload)).toEqual({
      OB: 1,
      FB: 0,
      FC: 1,
      DB: 2,
      SDB: 1,
      SFC: 1,
      SFB: 1,
    });
    const l = await p.userdata(reqBlockListOfType('DB'));
    const lu = decodeUserdata(l!.param, l!.data);
    expect(decodeBlockListOfType([lu.payload])).toEqual([
      { number: 1, flags: 0x01, language: 5 },
      { number: 7, flags: 0x01, language: 5 },
    ]);
    const fcr = await p.userdata(reqBlockListOfType('FC'));
    const fc = decodeUserdata(fcr!.param, fcr!.data);
    expect(decodeBlockListOfType([fc.payload])).toEqual([{ number: 12, flags: 0x42, language: 2 }]);
    for (const fs of ['A', 'P', 'B']) {
      const r = await p.userdata(reqBlockInfo('FC', 12, fs));
      const info = decodeBlockInfo(decodeUserdata(r!.param, r!.data).payload);
      expect(info).toMatchObject({
        type: 'FC',
        number: 12,
        language: 2,
        flags: 0x42,
        mc7Length: 10,
        author: 'BAA',
        family: 'TEST',
        name: 'FC12',
        version: '1.1',
        checksum: 0x1234,
        loadLength: 36 + 10 + 36,
      });
      expect(info.codeTime).toMatchObject({ year: 2020, month: 5, day: 17, hour: 10 });
    }
  });

  it('blocco mancante → 0xD209 con return code 0x0A (forma reale); lista di un tipo vuoto → 0xD20E', async () => {
    const p = await new TestPeer(new FakeCpu()).open();
    const r = await p.userdata(reqBlockInfo('DB', 1));
    const u = decodeUserdata(r!.param, r!.data);
    expect(u.param.errorCode).toBe(0xd209);
    expect(u.returnCode).toBe(0x0a);
    expect(u.transportSize).toBe(0);
    expect(hex(r!.data)).toBe('0a000000');
    const e = await p.userdata(reqBlockListOfType('FB'));
    expect(decodeUserdata(e!.param, e!.data).param.errorCode).toBe(0xd20e);
  });

  it('lista lunga: pezzi da 208 byte (PDU 240) con continuazione', async () => {
    const cpu = new FakeCpu();
    for (let n = 1; n <= 80; n++) cpu.addDb(n, seq(2));
    const p = await new TestPeer(cpu).open();
    const fr = await p.userdata(reqBlockListOfType('DB'));
    const first = decodeUserdata(fr!.param, fr!.data);
    expect(first.payload).toHaveLength(208);
    expect(first.param.lastDataUnit).toBe(true);
    const next = await p.userdata(reqContinue(3, 2, first.param.sequence));
    const nu = decodeUserdata(next!.param, next!.data);
    expect(nu.payload).toHaveLength(80 * 4 - 208);
    expect(nu.param.lastDataUnit).toBe(false);
    expect(decodeBlockListOfType([first.payload, nu.payload]).map((e) => e.number)).toEqual(
      Array.from({ length: 80 }, (_, i) => i + 1),
    );
  });
});

describe('orologio', () => {
  it("legge l'ora dall'orologio configurato", async () => {
    const t = { year: 2031, month: 2, day: 3, hour: 4, minute: 5, second: 6, ms: 789, weekday: 2 };
    const p = await new TestPeer(new FakeCpu({ clock: () => t })).open();
    const r = await p.userdata(reqReadClock());
    const u = decodeUserdata(r!.param, r!.data);
    expect(decodeBcdDateTime(u.payload)).toEqual(t);
  });
});
