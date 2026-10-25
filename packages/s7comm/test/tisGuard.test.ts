import { describe, expect, it } from 'vitest';
import {
  MGMT_PARAM,
  assertOnlineTest,
  assertOnlineWrite,
  assertReadOnly,
  encodeInsertBlock,
  encodePlcStop,
  encodeRequestDownload,
  encodeTisRequest,
  encodeWriteRequest,
  reqBlockStatus,
  reqDeleteJob,
  reqEnableJob,
  reqReadJobList,
  reqStack,
  type BlockStatusRequest,
  type S7Pdu,
  type UserdataFrame,
} from '../src';

const none = new Uint8Array(0);
const ud = (f: UserdataFrame): S7Pdu => ({
  rosctr: 7,
  pduRef: 7,
  errorClass: 0,
  errorCode: 0,
  param: f.param,
  data: f.data,
});
const job = (param: Uint8Array, data: Uint8Array = none): S7Pdu => ({
  rosctr: 1,
  pduRef: 7,
  errorClass: 0,
  errorCode: 0,
  param,
  data,
});
const forbidden = expect.objectContaining({ code: 'FORBIDDEN' });

const lines = (n: number, mask = 0x03, step = 2): BlockStatusRequest => ({
  type: 'OB',
  number: 1,
  initMask: mask,
  lines: Array.from({ length: n }, (_, i) => ({ offset: i * step, mask })),
});

/** Block status con un byte del parametro TIS (offset dopo il prefisso di 8 byte dei dati) cambiato. */
function tweakParam(r: BlockStatusRequest, saz: number, at: number, ...bytes: number[]): S7Pdu {
  const f = reqBlockStatus(r, saz);
  const data = f.data.slice();
  data.set(bytes, 8 + at);
  return ud({ param: f.param, data });
}
/** Come sopra ma su un byte dei dati TIS (dopo i 28 byte del parametro). */
function tweakData(r: BlockStatusRequest, saz: number, at: number, ...bytes: number[]): S7Pdu {
  const f = reqBlockStatus(r, saz);
  const data = f.data.slice();
  data.set(bytes, 8 + 28 + at);
  return ud({ param: f.param, data });
}

describe('assertOnlineTest', () => {
  it('ammette create, enable, delete, lista e stack canonici', () => {
    const ok = [
      ud(reqBlockStatus(lines(6), 0x20)),
      ud(reqBlockStatus({ ...lines(3), type: 'FC', number: 10 }, 0x20)),
      ud(reqBlockStatus({ ...lines(3), type: 'FB', number: 2 }, 0x20)),
      ud(reqEnableJob(0x13, 3)),
      ud(reqDeleteJob(0x13, 3)),
      ud(reqReadJobList()),
      ud(reqStack('ISTACK')),
      ud(reqStack('BSTACK')),
      ud(reqStack('LSTACK', { priority: 1, depth: 0 })),
      ud(reqBlockStatus(lines(24), 0x40)),
    ];
    for (const p of ok) expect(() => assertOnlineTest(p, 240)).not.toThrow();
  });

  it('continua ad ammettere ciò che ammette la sola lettura', () => {
    expect(() => assertOnlineTest(job(Uint8Array.of(0xf0)), 240)).toThrow(); // setup non canonico
  });

  it('rifiuta block status non canonici', () => {
    const bad: S7Pdu[] = [
      tweakParam(lines(3), 0x20, 2, 0, 2), // p2 = 2
      tweakParam(lines(3), 0x20, 4, 0, 1), // p3 = 1
      tweakParam(lines(3), 0x20, 18, 0x02, 0x00), // trigger inizio ciclo
      tweakParam(lines(3), 0x20, 6, 0, 0x2f), // p4 sbagliato
      tweakParam(lines(3), 0x20, 0, 0, 1), // p1
      tweakParam(lines(3), 0x20, 8, 0, 2), // p5
      tweakParam(lines(3), 0x20, 21, 0x0a), // tipo DB
      tweakData(lines(3), 0x20, 3, 0x10), // maschera iniziale 0x10
      tweakData(lines(3), 0x20, 7, 0x10), // maschera di riga 0x10
      tweakData(lines(3), 0x20, 7, 0x20), // maschera di riga 0x20
      tweakData(lines(3), 0x20, 7, 0x07), // maschere diverse
      tweakData(lines(3), 0x20, 4, 0, 3), // offset dispari
      ud(reqBlockStatus(lines(3, 0x03, 2), 0x04)), // ultima riga oltre la SAZ
      ud(
        reqBlockStatus(
          { ...lines(3), lines: [4, 2, 6].map((offset) => ({ offset, mask: 3 })) },
          0x20,
        ),
      ),
      ud(reqBlockStatus(lines(25), 0x80)), // 25 righe con PDU 240
    ];
    for (const p of bad) expect(() => assertOnlineTest(p, 240)).toThrowError(forbidden);
    // 25 righe vanno bene con PDU 480
    expect(() => assertOnlineTest(ud(reqBlockStatus(lines(25), 0x80)), 480)).not.toThrow();
  });

  it('rifiuta le altre sottofunzioni del gruppo 1', () => {
    for (const sub of [
      0x02, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x11, 0x12, 0x16, 0x01, 0x06,
    ]) {
      const p = ud(encodeTisRequest(sub, MGMT_PARAM, Uint8Array.of(2, 2)));
      expect(() => assertOnlineTest(p, 240), `sub ${sub}`).toThrowError(forbidden);
    }
  });

  it('rifiuta enable con funzione 0x02 e delete con 00 00', () => {
    expect(() => assertOnlineTest(ud(reqEnableJob(0x02, 2)), 240)).toThrowError(forbidden);
    expect(() =>
      assertOnlineTest(ud(encodeTisRequest(0x0f, MGMT_PARAM, Uint8Array.of(0, 0, 0x13, 3))), 240),
    ).toThrowError(forbidden);
    expect(() => assertOnlineTest(ud(reqDeleteJob(0x02, 2)), 240)).toThrowError(forbidden);
  });

  it('rifiuta forme non canoniche di lista e stack', () => {
    const l = reqReadJobList();
    expect(() =>
      assertOnlineTest(ud({ param: l.param, data: Uint8Array.from([...l.data, 0]) }), 240),
    ).toThrowError(forbidden);
    expect(() =>
      assertOnlineTest(ud(encodeTisRequest(0x04, MGMT_PARAM, Uint8Array.of(0, 0))), 240),
    ).toThrowError(forbidden);
    expect(() =>
      assertOnlineTest(ud(encodeTisRequest(0x03, MGMT_PARAM, Uint8Array.of(0, 1))), 240),
    ).toThrowError(forbidden);
    const bad = reqStack('ISTACK').param.slice();
    bad[11] = 1;
    expect(() =>
      assertOnlineTest(ud({ param: bad, data: reqStack('ISTACK').data }), 240),
    ).toThrowError(forbidden);
  });

  it('rifiuta write var, request download, PLC stop e install', () => {
    const w = encodeWriteRequest([
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 1, data: Uint8Array.of(1) },
    ]);
    const bad = [
      job(w.param, w.data),
      job(encodeRequestDownload('DB', 1, 'P', 100, 2)),
      job(encodePlcStop()),
      job(encodeInsertBlock('DB', 1, 'P')),
    ];
    for (const p of bad) expect(() => assertOnlineTest(p, 240)).toThrowError(forbidden);
  });

  it('read-only e online-write rifiutano lista dei job e block status', () => {
    for (const f of [reqReadJobList(), reqBlockStatus(lines(3), 0x20), reqEnableJob(0x13, 3)]) {
      expect(() => assertReadOnly(ud(f))).toThrowError(forbidden);
      expect(() => assertOnlineWrite(ud(f))).toThrowError(forbidden);
    }
  });
});
