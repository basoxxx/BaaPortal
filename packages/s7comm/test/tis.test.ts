import { describe, expect, it } from 'vitest';
import {
  MGMT_PARAM,
  REG,
  decodeBlockStatusResult,
  decodeJobList,
  decodeTisReply,
  encodeTisRequest,
  fromHex,
  hex,
  maxBlockStatusLines,
  regBytes,
  reqBlockStatus,
  reqDeleteJob,
  reqEnableJob,
  reqReadJobList,
  stwBits,
  tisErrorText,
  tisFunctionsFrom,
  blockStatusResultSize,
  type BlockStatusRequest,
  type SzlList,
} from '../src';

/** Esempio di proto §18.4: OB1, iniziali STW+ACCU1, sei righe, SAZ 0x0010. */
const EXAMPLE: BlockStatusRequest = {
  type: 'OB',
  number: 1,
  initMask: 0x03,
  lines: [
    { offset: 0x0, mask: 0x01 },
    { offset: 0x2, mask: 0x01 },
    { offset: 0x6, mask: 0x03 },
    { offset: 0x8, mask: 0x02 },
    { offset: 0xa, mask: 0x03 },
    { offset: 0xe, mask: 0x03 },
  ],
};
const EXAMPLE_RESULT = fromHex(
  '0000 0007 00000000 0000 0007 0002 0106 0006 0106 00000002 0008 00001111 000a 0106 00004444 000e 0106 00004444',
);

describe('richieste TIS (proto §18)', () => {
  it("reqBlockStatus dell'esempio §18.4: parametro TIS di 28 byte e dati", () => {
    const f = reqBlockStatus(EXAMPLE, 0x0010);
    expect(hex(f.param)).toBe('000112081241130000000000');
    expect(hex(f.data.slice(8, 36))).toBe(
      '0000000100000' + '02e' + '00010001000100010001' + '0600' + '0008' + '0001' + '0000' + '0010',
    );
    expect(hex(f.data.slice(36))).toBe(
      '00060003' + '00000001' + '00020001' + '00060003' + '00080002' + '000a0003' + '000e0003',
    );
  });

  it('encodeTisRequest del block status: ff 09 003c 001c 001c + 56 byte', () => {
    const f = reqBlockStatus(EXAMPLE, 0x0010);
    expect(hex(f.data.slice(0, 8))).toBe('ff09003c001c001c');
    expect(f.data.length).toBe(8 + 56);
  });

  it("blockStatusResultSize dell'esempio = 46", () => {
    expect(blockStatusResultSize(EXAMPLE)).toBe(46);
  });

  it('reqEnableJob(0x02, 2) uguale a §18.3: ff 09 001a 0014 0002 + MGMT_PARAM + 02 02', () => {
    const f = reqEnableJob(0x02, 2);
    expect(hex(f.data)).toBe(
      'ff09001a00140002' + '00000000000100000000000100010001' + '00010000' + '0202',
    );
    expect(hex(f.data.slice(8, 28))).toBe(hex(MGMT_PARAM));
    expect(f.param[6]).toBe(0x0e);
  });

  it('reqDeleteJob(0x13, 3) → dati TIS 00 01 13 03', () => {
    const f = reqDeleteJob(0x13, 3);
    expect(hex(f.data.slice(-4))).toBe('00011303');
    expect(f.param[6]).toBe(0x0f);
  });

  it('reqReadJobList: parametro con p5 = 1', () => {
    const f = reqReadJobList();
    expect(hex(f.data.slice(8, 28))).toBe('0000000000010000000100010001000100010000');
    expect(f.param[6]).toBe(0x10);
  });

  it('encodeTisRequest: parametro userdata di 8 byte con la sottofunzione', () => {
    expect(hex(encodeTisRequest(0x13, new Uint8Array(0), new Uint8Array(0)).param)).toBe(
      '000112081241130000000000',
    );
  });

  it('regBytes: 2 per la STW, 4 per gli altri; bit fuori da 0x0F → RangeError', () => {
    expect(regBytes(REG.STW)).toBe(2);
    expect(regBytes(0x0f)).toBe(14);
    expect(() => regBytes(0x10)).toThrow(RangeError);
  });

  it('maxBlockStatusLines: PDU 240 → 24 (0x03), 16 (0x07), 11 (0x0F); PDU 480 → 54', () => {
    expect(maxBlockStatusLines(240, 0x03)).toBe(24);
    expect(maxBlockStatusLines(240, 0x07)).toBe(16);
    expect(maxBlockStatusLines(240, 0x0f)).toBe(11);
    expect(maxBlockStatusLines(480, 0x03)).toBe(54);
  });
});

describe('risultato del block status', () => {
  it('decodifica il risultato di §18.4', () => {
    const r = decodeBlockStatusResult(EXAMPLE_RESULT, EXAMPLE);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.initial).toEqual({ stw: 7, accu1: 0 });
    expect(r.lines[2]).toEqual({ stw: 0x0106, accu1: 2 });
    expect(r.lines[3]).toEqual({ accu1: 0x1111 });
    expect(r.lines[5]).toEqual({ stw: 0x0106, accu1: 0x4444 });
    expect(r.trailing).toBeUndefined();
  });

  it('stwBits(0x0106) → BR 1, STA 1, RLO 1, gli altri 0', () => {
    expect(stwBits(0x0106)).toEqual({
      er: 0,
      rlo: 1,
      sta: 1,
      or: 0,
      os: 0,
      ov: 0,
      cc0: 0,
      cc1: 0,
      br: 1,
    });
  });

  // sei righe con STW+ACCU1: offset 0, 2, 6, 8, 10, 14
  const six = (): BlockStatusRequest => ({
    type: 'OB',
    number: 1,
    initMask: 0x03,
    lines: [0, 2, 6, 8, 10, 14].map((offset) => ({ offset, mask: 0x03 })),
  });
  const row = (offset: number, stw: number, a1: number): string =>
    offset.toString(16).padStart(4, '0') +
    stw.toString(16).padStart(4, '0') +
    a1.toString(16).padStart(8, '0');

  it('troncato dopo 4 righe → le ultime 2 sono null', () => {
    const bytes = fromHex(
      '0000' + '0001' + '00000000' + row(0, 1, 1) + row(2, 1, 2) + row(6, 1, 3) + row(8, 1, 4),
    );
    const r = decodeBlockStatusResult(bytes, six());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => l === null)).toEqual([false, false, false, false, true, true]);
  });

  it('senza la riga 0x0002 → 0x0002 null, 0x0006 con i suoi valori', () => {
    const bytes = fromHex(
      '0000' +
        '000100000000' +
        row(0, 1, 1) +
        row(6, 1, 3) +
        row(8, 1, 4) +
        row(10, 1, 5) +
        row(14, 1, 6),
    );
    const r = decodeBlockStatusResult(bytes, six());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[1]).toBeNull();
    expect(r.lines[2]).toEqual({ stw: 1, accu1: 3 });
    expect(r.lines[5]).toEqual({ stw: 1, accu1: 6 });
  });

  it("offset 0x0004 non chiesto → ok:false con l'esadecimale", () => {
    const bytes = fromHex('0000' + '000100000000' + row(0, 1, 1) + row(4, 1, 2));
    const r = decodeBlockStatusResult(bytes, six());
    expect(r).toEqual({ ok: false, why: expect.stringContaining('0x0004'), hex: hex(bytes) });
  });

  it('primo offset diverso da quello chiesto → ok:false', () => {
    const bytes = fromHex('0002' + '000100000000');
    expect(decodeBlockStatusResult(bytes, six())).toMatchObject({ ok: false, hex: hex(bytes) });
  });

  it('2 byte in più in coda → valori tenuti, trailing "abcd"', () => {
    const r1: BlockStatusRequest = {
      type: 'OB',
      number: 1,
      initMask: 0x03,
      lines: [{ offset: 0, mask: 0x03 }],
    };
    const bytes = fromHex('0000' + '000100000000' + row(0, 1, 1) + 'abcd');
    const r = decodeBlockStatusResult(bytes, r1);
    expect(r).toMatchObject({ ok: true, trailing: 'abcd' });
    if (r.ok) expect(r.lines[0]).toEqual({ stw: 1, accu1: 1 });
  });

  it('con maschere diverse la risincronizzazione non vale: il primo offset diverso è ok:false', () => {
    const mixed: BlockStatusRequest = {
      type: 'OB',
      number: 1,
      initMask: 0x01,
      lines: [
        { offset: 0, mask: 0x01 },
        { offset: 2, mask: 0x01 },
        { offset: 6, mask: 0x03 },
      ],
    };
    const bytes = fromHex('0000' + '0001' + '0000' + '0001' + '0006' + '0001' + '00000000');
    expect(decodeBlockStatusResult(bytes, mixed)).toMatchObject({ ok: false });
  });
});

describe('risposte e liste', () => {
  const hdr = (tg: string, sub: string, seq: string, err = '0000'): Uint8Array =>
    fromHex(`000112 08 12 ${tg} ${sub} ${seq} 00 00 ${err}`);

  it('ack con seq 03 → job 3', () => {
    const r = decodeTisReply(hdr('81', '13', '03'), fromHex('0a000000'));
    expect(r).toEqual({ kind: 'ack', sub: 0x13, job: 3, errorCode: 0 });
  });

  it('indication tg 01 sub 13 seq 03 → indication con i dati TIS', () => {
    const data = fromHex('ff09 0008 0004 0004 01000001 aabbccdd'.replace(/ /g, ''));
    const r = decodeTisReply(hdr('01', '13', '03'), data);
    expect(r.kind).toBe('indication');
    expect(r.job).toBe(3);
    expect(hex(r.tisData!)).toBe('aabbccdd');
  });

  it("risposta con dati subito (job list) e codice d'errore", () => {
    const r = decodeTisReply(
      hdr('81', '10', '03'),
      fromHex('ff09 0008 0004 0004 01000001 10030000'.replace(/ /g, '')),
    );
    expect(r.kind).toBe('data');
    expect(decodeJobList(r.tisData!)).toEqual([{ fn: 0x10, job: 3 }]);
    expect(decodeTisReply(hdr('81', '0f', '04', 'd0a5'), fromHex('0a000000')).errorCode).toBe(
      0xd0a5,
    );
  });

  it('decodeJobList(10 03 00 00) → una voce; lunghezza non multipla di 4 → PROTOCOL', () => {
    expect(decodeJobList(fromHex('10030000'))).toEqual([{ fn: 0x10, job: 3 }]);
    expect(() => decodeJobList(fromHex('100300'))).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL' }),
    );
  });

  it('tisErrorText: 0xD0C8 e un codice sconosciuto', () => {
    expect(tisErrorText(0xd0c8)).toBe('block status interrotto per incoerenza fra job e programma');
    expect(tisErrorText(0xd0ff)).toBe('errore TIS 0xD0FF');
  });
});

describe('tisFunctionsFrom (§7.5.9)', () => {
  const list = (funkt: string, trg: string): SzlList => {
    const r = new Uint8Array(40);
    r[1] = 2;
    r.set(fromHex(funkt), 2);
    r.set(fromHex(trg), 20);
    r[33] = 10;
    return { id: 0x0131, index: 2, recordLength: 40, records: [r] };
  };

  it('be fd 4f, 7d → v2, ISTACK, BSTACK, LSTACK, lista, enable, delete, area di codice', () => {
    expect(tisFunctionsFrom(list('befd4f000000', '7d0000'))).toEqual({
      blockStatusV2: true,
      istack: true,
      bstack: true,
      lstack: true,
      jobList: true,
      enable: true,
      del: true,
      codeAreaTrigger: true,
      forceMax: 10,
    });
  });

  it('be fd 03 → niente v2', () => {
    expect(tisFunctionsFrom(list('befd03000000', '7d0000')).blockStatusV2).toBe(false);
  });
});
