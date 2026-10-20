import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  S7Client,
  S7Error,
  commFrom,
  createRecorder,
  decodeBcdDateTime,
  decodeBlockCounts,
  decodeCotp,
  decodeReadRequest,
  decodeS7,
  decodeStartUpload,
  decodeSzlRequest,
  decodeUserdata,
  diagFrom,
  dissect,
  encodeBlockInfo,
  encodeBlockListOfType,
  encodeReadResponse,
  encodeSzl,
  encodeUserdata,
  identityFrom,
  itemByteLength,
  memoryTransportPair,
  modeFrom,
  parseSzl,
  readPcap,
  responseTransportFor,
  encodeStartUploadResponse,
  encodeUploadResponse,
  type BlockType,
  type ItemResult,
  type S7Pdu,
} from '../src';
import { FakeCpu } from './fakeCpu';
import { CISAGOV_DIR } from './captures';

// ---- vettori reali: cisagov/snap7.pcap (stream 0), indice del frame nel flusso ---------------

const frames = readPcap(readFileSync(`${CISAGOV_DIR}/snap7.pcap`))[0]!.frames;
function cap(i: number): S7Pdu {
  const c = decodeCotp(frames[i]!.bytes);
  if (c.type !== 'DT') throw new Error(`frame ${i} non è un DT`);
  return decodeS7(c.data);
}
const R = {
  szl0011: cap(3),
  szl001cFirst: cap(5),
  szl001cNext: cap(7),
  szl0131: cap(9),
  szl0424: cap(11),
  counts: cap(15),
  startOk: cap(17),
  upload: cap(19),
  endOk: cap(21),
  info0Missing: cap(23),
  startRejected: cap(43), // ROSCTR 2 con errore nell'header (start upload di un OB)
  clock: cap(45),
};
/** I 216 byte del SDB 0 del vettore reale. */
const SDB0 = R.upload.data.slice(4);

const none = new Uint8Array(0);

// ---- finto server su memoryTransportPair ------------------------------------------------------

type Reply =
  | {
      rosctr: 2 | 3 | 7;
      param: Uint8Array;
      data: Uint8Array;
      errorClass?: number;
      errorCode?: number;
    }
  | 'silent'
  | 'close';

interface Rig {
  client: S7Client;
  cpu: FakeCpu;
  /** Funzione e (per i userdata) group/sub di ogni richiesta, in ordine di arrivo. */
  log: string[];
  /** Richieste userdata con il loro payload. */
  ud: { pdu: S7Pdu; u: ReturnType<typeof decodeUserdata> }[];
  recorder: ReturnType<typeof createRecorder>;
}

interface RigOptions {
  pdu?: number;
  /** Prima del comportamento di default; `undefined` lascia il default. */
  override?: (pdu: S7Pdu, ud?: ReturnType<typeof decodeUserdata>) => Reply | undefined;
}

const fromCapture = (p: S7Pdu): Reply => ({
  rosctr: p.rosctr as 2 | 3 | 7,
  param: p.param,
  data: p.data,
  errorClass: p.errorClass,
  errorCode: p.errorCode,
});

function szlReply(fragment: Uint8Array, more: boolean, sequence: number): Reply {
  const { param, data } = encodeUserdata(
    {
      method: 'response',
      group: 4,
      subfunction: 1,
      sequence,
      dataUnitRef: 0,
      lastDataUnit: more,
      errorCode: 0,
    },
    fragment,
  );
  return { rosctr: 7, param, data };
}

function errorReply(group: number, sub: number, code: number): Reply {
  const { param, data } = encodeUserdata(
    {
      method: 'response',
      group,
      subfunction: sub,
      sequence: 0,
      dataUnitRef: 0,
      lastDataUnit: false,
      errorCode: code,
    },
    none,
    0x0a,
  );
  return { rosctr: 7, param, data };
}

/** Liste che il vettore reale non contiene: costruite con i codificatori lato CPU. */
function builtSzl(id: number, index: number): Reply | undefined {
  if ((id === 0x0232 || id === 0x0132) && index === 4) {
    const rec = Uint8Array.of(0, 4, 0, 1, 0, 2, 0, 3, 0, 2, 0, 0, 0, 0);
    return szlReply(encodeSzl({ id, index, recordLength: 14, records: [rec] }, 200)[0]!, false, 1);
  }
  if (id === 0x00a0) {
    const mk = (event: number) => {
      const r = new Uint8Array(20);
      r[0] = event >> 8;
      r[1] = event & 0xff;
      r.set([0x26, 0x10, 0x20, 0x12, 0x34, 0x56, 0x00, 0x03], 12); // 2026-10-20 12:34:56.000
      return r;
    };
    const records = [mk(0x4302), mk(0x4303)];
    return szlReply(encodeSzl({ id, index, recordLength: 20, records }, 200)[0]!, false, 1);
  }
  return undefined;
}

/** Lista di blocchi grande: 100 DB, a pezzi da 100 byte (25 record). */
const BIG_LIST = Array.from({ length: 100 }, (_, i) => ({
  number: i + 1,
  flags: 0x01,
  language: 0x05,
}));

function defaultReply(
  pdu: S7Pdu,
  state: { pending: Reply[] },
  ud?: ReturnType<typeof decodeUserdata>,
): Reply | undefined {
  if (pdu.rosctr === 7 && ud) {
    const g = ud.param.group;
    const s = ud.param.subfunction;
    if (g === 4 && s === 1) {
      if (ud.param.methodByte === 0x12) return state.pending.shift();
      const { id, index } = decodeSzlRequest(ud.payload);
      if (id === 0x0011) return fromCapture(R.szl0011);
      if (id === 0x001c) {
        state.pending = [fromCapture(R.szl001cNext)];
        return fromCapture(R.szl001cFirst);
      }
      if (id === 0x0131) return fromCapture(R.szl0131);
      if (id === 0x0424) return fromCapture(R.szl0424);
      return builtSzl(id, index) ?? errorReply(4, 1, 0xd401);
    }
    if (g === 3 && s === 1) return fromCapture(R.counts);
    if (g === 3 && s === 2) {
      if (ud.param.methodByte === 0x12) return state.pending.shift();
      const pieces = encodeBlockListOfType(BIG_LIST, 100);
      state.pending = pieces.slice(1).map((p, i) => {
        const e = encodeUserdata(
          {
            method: 'response',
            group: 3,
            subfunction: 2,
            sequence: 1,
            dataUnitRef: 0,
            lastDataUnit: i < pieces.length - 2,
            errorCode: 0,
          },
          p,
        );
        return { rosctr: 7 as const, param: e.param, data: e.data };
      });
      const e = encodeUserdata(
        {
          method: 'response',
          group: 3,
          subfunction: 2,
          sequence: 1,
          dataUnitRef: 0,
          lastDataUnit: true,
          errorCode: 0,
        },
        pieces[0]!,
      );
      return { rosctr: 7, param: e.param, data: e.data };
    }
    if (g === 3 && s === 3) {
      const p = ud.payload;
      const type = ((): BlockType => {
        const t = String.fromCharCode(p[0]!, p[1]!);
        return (
          {
            '08': 'OB',
            '0A': 'DB',
            '0B': 'SDB',
            '0C': 'FC',
            '0D': 'SFC',
            '0E': 'FB',
            '0F': 'SFB',
          } as Record<string, BlockType>
        )[t]!;
      })();
      const number = Number(String.fromCharCode(...p.subarray(2, 7)));
      if (type === 'DB' && number === 0) return fromCapture(R.info0Missing);
      const info = encodeBlockInfo({
        type,
        number,
        language: 5,
        name: 'TESTBLK',
        author: 'BAA',
        version: '1.0',
        loadLength: 216,
      });
      const e = encodeUserdata(
        {
          method: 'response',
          group: 3,
          subfunction: 3,
          sequence: 0,
          dataUnitRef: 0,
          lastDataUnit: false,
          errorCode: 0,
        },
        info,
      );
      return { rosctr: 7, param: e.param, data: e.data };
    }
    if (g === 7 && s === 1) return fromCapture(R.clock);
    return undefined;
  }
  const fn = pdu.param[0];
  if (fn === 0x04) {
    const items = decodeReadRequest(pdu.param);
    const results: ItemResult[] = items.map((it) => {
      if (it.area === 'DB' && it.db === 99)
        return { ok: false, returnCode: 0x0a, name: 'x', transportSize: 0, rawLength: 4 };
      const n = itemByteLength(it);
      const data = Uint8Array.from({ length: n }, (_, i) => (it.start + i) & 0xff);
      return { ok: true, data, transportSize: responseTransportFor(it) };
    });
    const e = encodeReadResponse(results);
    return { rosctr: 3, param: e.param, data: e.data };
  }
  if (fn === 0x1d) {
    const { fileName } = decodeStartUpload(pdu.param);
    if (!fileName.startsWith('_0B')) return fromCapture(R.startRejected);
    return fromCapture(R.startOk);
  }
  if (fn === 0x1e) return fromCapture(R.upload);
  if (fn === 0x1f) return fromCapture(R.endOk);
  return undefined;
}

async function rig(o: RigOptions = {}): Promise<Rig> {
  const [a, b] = memoryTransportPair();
  const log: string[] = [];
  const ud: Rig['ud'] = [];
  const state = { pending: [] as Reply[] };
  const cpu: FakeCpu = new FakeCpu(b, {
    pdu: o.pdu ?? 240,
    onPdu: (pdu) => {
      const u = pdu.rosctr === 7 ? decodeUserdata(pdu.param, pdu.data) : undefined;
      log.push(
        u
          ? `ud${u.param.group}/${u.param.subfunction}${u.param.methodByte === 0x12 ? 'c' : ''}`
          : `fn${pdu.param[0]!.toString(16)}`,
      );
      if (u) ud.push({ pdu, u });
      const reply = o.override?.(pdu, u) ?? defaultReply(pdu, state, u);
      if (!reply || reply === 'silent') return;
      if (reply === 'close') {
        cpu.end.close();
        return;
      }
      cpu.sendPdu({
        rosctr: reply.rosctr,
        pduRef: pdu.pduRef,
        errorClass: reply.errorClass ?? 0,
        errorCode: reply.errorCode ?? 0,
        param: reply.param,
        data: reply.data,
      });
    },
  });
  const recorder = createRecorder();
  const client = await S7Client.connect({ host: 'h', transport: async () => a, recorder });
  return { client, cpu, log, ud, recorder };
}

const sdbStart = (len: number) => ({
  rosctr: 3 as const,
  param: encodeStartUploadResponse(7, len),
  data: none,
});

// ---- test ------------------------------------------------------------------------------------

describe('SZL, identità, modo, protezione, comunicazione', () => {
  it('identity, mode, protection e communication dai vettori reali', async () => {
    const { client } = await rig();
    expect(client.pduLength).toBe(240);
    const s11 = parseSzl([R.szl0011.data.slice(4)]);
    const s1c = parseSzl([R.szl001cFirst.data.slice(4), R.szl001cNext.data.slice(4)]);
    const id = await client.identity();
    expect(id).toEqual(identityFrom(s11, s1c));
    expect(id.orderNumber).toMatch(/^6ES7|MMC|CPU|\d/);
    expect(id.asName).toBeDefined();
    expect(await client.mode()).toBe(modeFrom(parseSzl([R.szl0424.data.slice(4)])));
    expect(await client.communication()).toEqual(commFrom(parseSzl([R.szl0131.data.slice(4)])));
    expect((await client.communication()).maxPdu).toBeGreaterThan(0);
    const prot = await client.protection();
    expect(prot).toEqual({ switchLevel: 1, paramLevel: 2, validLevel: 3, modeSwitch: 'RUN-P' });
  });

  it('readSzl segue i pezzi con il sequence della CPU (una 0x001C reale in due pezzi)', async () => {
    const { client, ud } = await rig();
    const list = await client.readSzl(0x001c, 0);
    expect(list).toEqual(parseSzl([R.szl001cFirst.data.slice(4), R.szl001cNext.data.slice(4)]));
    expect(ud.map((x) => [x.u.param.methodByte, x.u.param.sequence, x.u.payload.length])).toEqual([
      [0x11, 0, 4],
      [0x12, 2, 0], // continuazione col sequence della CPU
    ]);
  });

  it('una SZL che non finisce mai: PROTOCOL dopo 64 pezzi', async () => {
    const { client, ud } = await rig({
      override: (_p, u) => {
        if (u?.param.group !== 4) return undefined;
        const first = u.param.methodByte === 0x11;
        return szlReply(
          first ? R.szl001cFirst.data.slice(4, 12) : Uint8Array.of(1, 2, 3, 4),
          true,
          3,
        );
      },
    });
    await expect(client.readSzl(0x001c, 0)).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(ud.length).toBe(64);
  });

  it('manca la 0x001C (rifiutata): identity ha solo i campi della 0x0011', async () => {
    const { client } = await rig({
      override: (_p, u) => {
        if (u && u.param.group === 4 && u.param.methodByte === 0x11) {
          const { id } = decodeSzlRequest(u.payload);
          if (id === 0x001c) return errorReply(4, 1, 0xd401);
        }
        return undefined;
      },
    });
    const id = await client.identity();
    expect(id).toEqual(identityFrom(parseSzl([R.szl0011.data.slice(4)])));
    expect(id.asName).toBeUndefined();
    expect(id.orderNumber.length).toBeGreaterThan(0);
  });

  it('se la 0x0011 è rifiutata identity lancia CPU_ERROR; altri errori della 0x001C non si nascondono', async () => {
    const a = await rig({
      override: (_p, u) => (u?.param.group === 4 ? errorReply(4, 1, 0xd401) : undefined),
    });
    await expect(a.client.identity()).rejects.toMatchObject({ code: 'CPU_ERROR' });
    const b = await rig({
      override: (_p, u) => {
        if (
          u &&
          u.param.group === 4 &&
          u.param.methodByte === 0x11 &&
          decodeSzlRequest(u.payload).id === 0x001c
        ) {
          return szlReply(Uint8Array.of(1, 2, 3), false, 1); // troncata: PROTOCOL
        }
        return undefined;
      },
    });
    await expect(b.client.identity()).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('una lista con id diverso dal richiesto è PROTOCOL; una lista corta non fa lanciare i tipizzati', async () => {
    const a = await rig({
      override: (_p, u) =>
        u?.param.group === 4 ? szlReply(R.szl0131.data.slice(4), false, 1) : undefined,
    });
    await expect(a.client.mode()).rejects.toMatchObject({ code: 'PROTOCOL' });
    // 0x0424 vuota (nessun record): UNKNOWN, senza lanciare
    const b = await rig({
      override: (_p, u) =>
        u?.param.group === 4
          ? szlReply(
              encodeSzl({ id: 0x0424, index: 0, recordLength: 0, records: [] }, 200)[0]!,
              false,
              1,
            )
          : undefined,
    });
    expect(await b.client.mode()).toBe('UNKNOWN');
    expect(await b.client.protection().catch((e) => e)).toBeInstanceOf(S7Error);
  });

  it('diagnosticBuffer', async () => {
    const { client } = await rig();
    const d = await client.diagnosticBuffer();
    expect(d.map((e) => e.eventId)).toEqual([0x4302, 0x4303]);
    expect(d[0]!.time).toMatchObject({
      year: 2026,
      month: 10,
      day: 20,
      hour: 12,
      minute: 34,
      second: 56,
    });
    expect(d).toEqual(diagFrom(await client.readSzl(0x00a0, 0)));
  });
});

describe('protezione', () => {
  it('prima 0x0132 indice 4 (STEP 7/TIA)', async () => {
    const { client, ud } = await rig();
    expect(await client.protection()).toMatchObject({ switchLevel: 1, modeSwitch: 'RUN-P' });
    expect(ud.map((x) => decodeSzlRequest(x.u.payload).id)).toEqual([0x0132]);
  });

  it('se la CPU rifiuta la 0x0132 ripiega sulla 0x0232', async () => {
    const { client, ud } = await rig({
      override: (_p, u) =>
        u?.param.methodByte === 0x11 &&
        u.param.group === 4 &&
        decodeSzlRequest(u.payload).id === 0x0132
          ? errorReply(4, 1, 0xd401)
          : undefined,
    });
    expect(await client.protection()).toMatchObject({ switchLevel: 1, modeSwitch: 'RUN-P' });
    expect(ud.map((x) => decodeSzlRequest(x.u.payload).id)).toEqual([0x0132, 0x0232]);
  });
});

describe('variabili', () => {
  it('readArea di 1000 byte con PDU 240: 5 richieste, dati ricomposti in ordine', async () => {
    const { client, log, cpu } = await rig({ pdu: 240 });
    const data = await client.readArea('DB', 1, 10, 1000);
    expect(data.length).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(data[i]).toBe((10 + i) & 0xff);
    expect(log).toEqual(['fn4', 'fn4', 'fn4', 'fn4', 'fn4']);
    const counts = cpu.pdus
      .filter((p) => p.param[0] === 0x04)
      .map((p) => decodeReadRequest(p.param)[0]!.count);
    expect(counts).toEqual([222, 222, 222, 222, 112]);
  });

  it('readItems con un DB mancante: risultato per item, gli altri letti', async () => {
    const { client } = await rig();
    const r = await client.readItems([
      { area: 'DB', db: 99, start: 0, size: 'BYTE', count: 4 },
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 2 },
      { area: 'M', db: 0, start: 8, size: 'WORD', count: 1 },
    ]);
    expect(r[0]).toMatchObject({ ok: false, returnCode: 0x0a });
    expect(r[1]).toMatchObject({ ok: true });
    expect([...(r[1] as { data: Uint8Array }).data]).toEqual([0, 1]);
    expect([...(r[2] as { data: Uint8Array }).data]).toEqual([8, 9]);
  });

  it('readArea: un item fallito è CPU_ERROR con returnCode e nome', async () => {
    const { client } = await rig();
    const e = await client.readArea('DB', 99, 0, 10).catch((x) => x);
    expect(e).toBeInstanceOf(S7Error);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { returnCode: 0x0a } });
    expect(e.message).toContain('oggetto non disponibile');
  });

  it("errore nell'header della risposta: CPU_ERROR con classe, codice e testo", async () => {
    const { client } = await rig({
      override: (p) =>
        p.param[0] === 0x04
          ? { rosctr: 2, param: none, data: none, errorClass: 0x85, errorCode: 0x00 }
          : undefined,
    });
    const e = await client
      .readItems([{ area: 'M', db: 0, start: 0, size: 'BYTE', count: 1 }])
      .catch((x) => x);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0x85, errorCode: 0 } });
    expect(e.message).toMatch(/0x85/);
  });

  it('una risposta con meno item o byte di quelli chiesti è PROTOCOL', async () => {
    const { client } = await rig({
      override: (p) => {
        if (p.param[0] !== 0x04) return undefined;
        const e = encodeReadResponse([{ ok: true, data: Uint8Array.of(1), transportSize: 4 }]);
        return { rosctr: 3, param: e.param, data: e.data };
      },
    });
    await expect(
      client.readItems([{ area: 'M', db: 0, start: 0, size: 'BYTE', count: 2 }]),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});

describe('blocchi e orologio', () => {
  it('blockCounts dal vettore reale', async () => {
    const { client } = await rig();
    expect(await client.blockCounts()).toEqual(decodeBlockCounts(R.counts.data.slice(4)));
  });

  it('listBlocks segue i pezzi (continuazione 3/2 col sequence della CPU)', async () => {
    const { client, log } = await rig();
    const list = await client.listBlocks('DB');
    expect(list).toEqual(BIG_LIST);
    expect(log).toEqual(['ud3/2', 'ud3/2c', 'ud3/2c', 'ud3/2c']);
  });

  it('listBlocks: oltre 256 pezzi è PROTOCOL', async () => {
    const { client, ud } = await rig({
      override: (_p, u) => {
        if (u?.param.group !== 3) return undefined;
        const e = encodeUserdata(
          {
            method: 'response',
            group: 3,
            subfunction: 2,
            sequence: 1,
            dataUnitRef: 0,
            lastDataUnit: true,
            errorCode: 0,
          },
          Uint8Array.of(0, 1, 1, 5),
        );
        return { rosctr: 7, param: e.param, data: e.data };
      },
    });
    await expect(client.listBlocks('DB')).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(ud.length).toBe(256);
  });

  it('blockInfo usa il filesystem A e restituisce i campi', async () => {
    const { client, ud } = await rig();
    const info = await client.blockInfo('DB', 1);
    expect(info).toMatchObject({
      type: 'DB',
      number: 1,
      name: 'TESTBLK',
      author: 'BAA',
      version: '1.0',
    });
    expect(String.fromCharCode(...ud[0]!.u.payload)).toBe('0A00001A');
  });

  it('blocco mancante (errore reale 0xD209 dal vettore): CPU_ERROR con classe e codice', async () => {
    const { client } = await rig();
    const e = await client.blockInfo('DB', 0).catch((x) => x);
    expect(e).toBeInstanceOf(S7Error);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd2, errorCode: 0x09 } });
    expect(e.message).toContain('0xd2');
  });

  it('readClock', async () => {
    const { client } = await rig();
    expect(await client.readClock()).toEqual(decodeBcdDateTime(R.clock.data.slice(4)));
  });
});

describe('upload', () => {
  it('start, upload fino a EoU 0, end: byte grezzi del blocco reale', async () => {
    const { client, log } = await rig();
    const bytes = await client.upload('SDB', 0);
    expect([...bytes]).toEqual([...SDB0]);
    expect(bytes.length).toBe(216);
    expect(log).toEqual(['fn1d', 'fn1e', 'fn1f']);
  });

  it('più pezzi: si ricompongono in ordine', async () => {
    let n = 0;
    const { client, log } = await rig({
      override: (p) => {
        if (p.param[0] === 0x1d) return sdbStart(300);
        if (p.param[0] !== 0x1e) return undefined;
        n++;
        const chunk = Uint8Array.from({ length: 100 }, (_, i) => (n * 100 + i) & 0xff);
        const e = encodeUploadResponse(n < 3, chunk);
        return { rosctr: 3, param: e.param, data: e.data };
      },
    });
    const bytes = await client.upload('SDB', 0);
    expect(bytes.length).toBe(300);
    expect(bytes[0]).toBe(100);
    expect(bytes[299]).toBe((300 + 99) & 0xff);
    expect(log).toEqual(['fn1d', 'fn1e', 'fn1e', 'fn1e', 'fn1f']);
  });

  it('errore a metà: EndUpload inviato comunque e S7Error rilanciato', async () => {
    let n = 0;
    const { client, log } = await rig({
      override: (p) => {
        if (p.param[0] !== 0x1e) return undefined;
        n++;
        if (n === 1) {
          const e = encodeUploadResponse(true, SDB0.slice(0, 100));
          return { rosctr: 3, param: e.param, data: e.data };
        }
        return { rosctr: 2, param: none, data: none, errorClass: 0xd2, errorCode: 0x09 };
      },
    });
    const e = await client.upload('SDB', 0).catch((x) => x);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd2, errorCode: 0x09 } });
    expect(log).toEqual(['fn1d', 'fn1e', 'fn1e', 'fn1f']);
    // la connessione resta usabile
    expect(await client.mode()).toBeDefined();
  });

  it("un EndUpload che fallisce non nasconde l'errore originale", async () => {
    const { client, log } = await rig({
      override: (p) => {
        if (p.param[0] === 0x1e)
          return { rosctr: 2, param: none, data: none, errorClass: 0x81, errorCode: 0x04 };
        if (p.param[0] === 0x1f)
          return { rosctr: 2, param: none, data: none, errorClass: 0xd2, errorCode: 0x09 };
        return undefined;
      },
    });
    const e = await client.upload('SDB', 0).catch((x) => x);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0x81, errorCode: 0x04 } });
    expect(log).toEqual(['fn1d', 'fn1e', 'fn1f']);
  });

  it('lunghezza dichiarata diversa dai byte ricevuti: avviso, non errore (più grande e più piccola)', async () => {
    for (const declared of [217, 100]) {
      const { client, log } = await rig({
        override: (p) => (p.param[0] === 0x1d ? sdbStart(declared) : undefined),
      });
      const r = await client.uploadWithInfo('SDB', 0);
      expect(r.bytes.length).toBe(216);
      expect(r.declaredLength).toBe(declared);
      expect(r.warnings).toEqual([`lunghezza dichiarata ${declared}, ricevuti 216`]);
      expect((await client.upload('SDB', 0)).length).toBe(216);
      expect(log.slice(0, 3)).toEqual(['fn1d', 'fn1e', 'fn1f']);
    }
    const ok = await rig();
    expect(await ok.client.uploadWithInfo('SDB', 0)).toMatchObject({
      declaredLength: 216,
      warnings: [],
    });
  });

  it('start malformato: PROTOCOL, connessione chiusa, poi CLOSED', async () => {
    const { client, log } = await rig({
      override: (p) =>
        p.param[0] === 0x1d
          ? { rosctr: 3, param: Uint8Array.of(0x1d, 0, 1), data: none }
          : undefined,
    });
    await expect(client.upload('SDB', 0)).rejects.toMatchObject({ code: 'PROTOCOL' });
    await expect(client.mode()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(log).toEqual(['fn1d']);
  });

  it('oltre 16 MiB: PROTOCOL, EndUpload inviato', async () => {
    const big = new Uint8Array(60000);
    const { client, log } = await rig({
      override: (p) => {
        if (p.param[0] === 0x1d) {
          return {
            rosctr: 3,
            param: encodeStartUploadResponse(7, 0, { lengthString: null }),
            data: none,
          };
        }
        if (p.param[0] !== 0x1e) return undefined;
        const e = encodeUploadResponse(true, big);
        return { rosctr: 3, param: e.param, data: e.data };
      },
    });
    const e = await client.upload('SDB', 0).catch((x) => x);
    expect(e).toMatchObject({ code: 'PROTOCOL' });
    expect(log.at(-1)).toBe('fn1f');
    expect(log.filter((l) => l === 'fn1e').length).toBe(Math.floor((16 * 1024 * 1024) / 60000) + 1);
  });

  it("start rifiutato (errore reale nell'header): CPU_ERROR, niente EndUpload", async () => {
    const { client, log } = await rig();
    const e = await client.upload('OB', 1).catch((x) => x);
    expect(e).toMatchObject({
      code: 'CPU_ERROR',
      detail: { errorClass: R.startRejected.errorClass, errorCode: R.startRejected.errorCode },
    });
    expect(R.startRejected.errorClass).not.toBe(0);
    expect(log).toEqual(['fn1d']);
  });

  it('connessione chiusa a metà: CLOSED e nessun EndUpload', async () => {
    const { client, log } = await rig({
      override: (p) => (p.param[0] === 0x1e ? 'close' : undefined),
    });
    await expect(client.upload('SDB', 0)).rejects.toMatchObject({ code: 'CLOSED' });
    expect(log).toEqual(['fn1d', 'fn1e']);
  });
});

describe('sola lettura', () => {
  it('S7Client non ha metodi di scrittura (controllo sulle chiavi del prototipo)', () => {
    expect(Object.getOwnPropertyNames(S7Client.prototype).sort()).toEqual(
      [
        'constructor',
        'blockCounts',
        'blockInfo',
        'close',
        'communication',
        'diagnosticBuffer',
        'identity',
        'listBlocks',
        'mode',
        'pduLength',
        'protection',
        'readArea',
        'readClock',
        'readItems',
        'readSzl',
        'upload',
        'uploadWithInfo',
      ].sort(),
    );
    expect(Object.getOwnPropertyNames(S7Client).sort()).toEqual(
      ['connect', 'length', 'name', 'prototype'].sort(),
    );
  });

  it('ogni frame inviato in un esercizio completo ha un tipo in allowlist', async () => {
    const { client, recorder } = await rig();
    await client.readItems([{ area: 'M', db: 0, start: 0, size: 'BYTE', count: 1 }]);
    await client.readArea('DB', 1, 0, 500);
    await client.readSzl(0x001c, 0);
    await client.identity();
    await client.mode();
    await client.protection();
    await client.communication();
    await client.diagnosticBuffer();
    await client.blockCounts();
    await client.listBlocks('DB');
    await client.blockInfo('DB', 1);
    await client.blockInfo('DB', 0).catch(() => undefined);
    await client.readClock();
    await client.upload('SDB', 0);
    await client.upload('OB', 1).catch(() => undefined);
    await client.close();
    const tx = recorder.frames().filter((f) => f.dir === 'tx');
    const kinds = new Set<string>();
    for (const f of tx) {
      const d = dissect(f.bytes);
      kinds.add(d.kind);
      expect([
        'connect',
        'setup',
        'readVar',
        'szl',
        'blockList',
        'blockInfo',
        'clock',
        'upload',
      ]).toContain(d.kind);
      if (d.s7) expect([1, 7]).toContain(d.s7.rosctr);
    }
    expect([...kinds].sort()).toEqual(
      ['blockInfo', 'blockList', 'clock', 'connect', 'readVar', 'setup', 'szl', 'upload'].sort(),
    );
  });
});
