import { describe, expect, it } from 'vitest';
import {
  RESTORE_SDB,
  assertOnlineRestore,
  assertOnlineWrite,
  assertOutgoingFrame,
  encodeCompressMemory,
  encodeCopyRamToRom,
  encodeCotp,
  encodeDeleteBlock,
  encodeDownloadBlockAck,
  encodeDownloadEnded,
  encodeInsertBlock,
  encodePlcStop,
  encodeRequestDownload,
  encodeS7,
  encodeTpkt,
  encodeUserdata,
  encodeWarmRestart,
  encodeWriteRequest,
  isRestorableSdb,
  reqBlockCounts,
  reqBlockInfo,
  reqBlockListOfType,
  reqBlockStatus,
  reqDeleteJob,
  reqEnableJob,
  reqReadClock,
  reqReadJobList,
  reqReadSzl,
  reqSetClock,
  reqStack,
  type BlockType,
  type S7Pdu,
  type UserdataFrame,
} from '../src';

const none = new Uint8Array(0);
const job = (param: Uint8Array, data: Uint8Array = none, rosctr: 1 | 3 | 7 = 1): S7Pdu => ({
  rosctr,
  pduRef: 7,
  errorClass: 0,
  errorCode: 0,
  param,
  data,
});
const ud = (f: UserdataFrame): S7Pdu => job(f.param, f.data, 7);
const dt = (p: S7Pdu): Uint8Array =>
  encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: encodeS7(p) }));
const forbidden = expect.objectContaining({ code: 'FORBIDDEN' });
const passes = (p: S7Pdu): boolean => {
  try {
    assertOnlineRestore(p);
    return true;
  } catch (e) {
    expect((e as { code: string }).code).toBe('FORBIDDEN');
    return false;
  }
};
const ascii = (b: Uint8Array): string => String.fromCharCode(...b);

describe('assertOnlineRestore: forme canoniche di §19.3.1', () => {
  it('i nomi sono quelli della cattura TIA', () => {
    expect(ascii(encodeDeleteBlock('SDB', 1000, 'A'))).toContain('0B01000A');
    expect(ascii(encodeRequestDownload('SDB', 7, 'P', 100, 2))).toContain('_0B00007P');
    expect(ascii(encodeInsertBlock('SDB', 0, 'P'))).toContain('0B00000P');
  });

  it('ammette _DELE "A" di SDB, download e _INSE "P" dei blocchi e degli SDB, STOP e riavvio a caldo', () => {
    const ok: S7Pdu[] = [
      job(encodeDeleteBlock('SDB', 1000, 'A')),
      job(encodeDeleteBlock('SDB', 2000, 'A')),
      job(encodeDeleteBlock('SDB', 4, 'A')),
      job(encodeRequestDownload('SDB', 7, 'P', 100, 2)),
      job(encodeRequestDownload('OB', 1, 'P', 100, 2)),
      job(encodeRequestDownload('DB', 5, 'P', 100, 2)),
      job(encodeDownloadEnded('SDB', 7, 'P')),
      job(encodeDownloadEnded('FC', 2, 'P')),
      job(encodeInsertBlock('SDB', 0, 'P')),
      job(encodeInsertBlock('FB', 3, 'P')),
      job(encodePlcStop()),
      job(encodeWarmRestart()),
      ud(reqReadJobList()),
      ud(reqReadSzl(0x0131, 2)),
      ud(reqBlockInfo('SDB', 1000)),
    ];
    for (const p of ok) expect(() => assertOnlineRestore(p)).not.toThrow();
    const ack = encodeDownloadBlockAck(false, Uint8Array.of(1, 2, 3));
    expect(() => assertOnlineRestore(job(ack.param, ack.data, 3))).not.toThrow();
    expect(() => assertOnlineRestore(job(Uint8Array.of(0x1c), none, 3))).not.toThrow();
  });

  it('rifiuta: SDB 2, 999, 3000; _DELE SDB con P; download SDB con A; _DELE di blocchi utente', () => {
    const bad: S7Pdu[] = [
      job(encodeDeleteBlock('SDB', 2, 'A')),
      job(encodeDeleteBlock('SDB', 999, 'A')),
      job(encodeDeleteBlock('SDB', 3000, 'A')),
      job(encodeDeleteBlock('SDB', 1000, 'P')),
      job(encodeDeleteBlock('SDB', 1000, 'B')),
      job(encodeRequestDownload('SDB', 7, 'A', 100, 2)),
      job(encodeRequestDownload('SDB', 2, 'P', 100, 2)),
      job(encodeRequestDownload('SDB', 3000, 'P', 100, 2)),
      job(encodeRequestDownload('SFC', 1, 'P', 100, 2)),
      job(encodeInsertBlock('SDB', 2, 'P')),
      job(encodeInsertBlock('SDB', 7, 'A')),
      job(encodeInsertBlock('SFB', 1, 'P')),
      job(encodeDownloadEnded('SDB', 999, 'P')),
      job(encodeDeleteBlock('DB', 1, 'A')),
      job(encodeDeleteBlock('OB', 1, 'A')),
    ];
    for (const p of bad) expect(() => assertOnlineRestore(p)).toThrowError(forbidden);
  });

  it('rifiuta block status, write var, orologio, _MODU, _GARB, enable/delete e stack', () => {
    const w = encodeWriteRequest([
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 1, data: Uint8Array.of(1) },
    ]);
    const lines = { type: 'OB' as const, number: 1, initMask: 3, lines: [{ offset: 0, mask: 3 }] };
    const bad: S7Pdu[] = [
      ud(reqBlockStatus(lines, 4)),
      job(w.param, w.data),
      ud(reqSetClock({ year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 })),
      job(encodeCopyRamToRom()),
      job(encodeCompressMemory()),
      ud(reqEnableJob(0x13, 3)),
      ud(reqDeleteJob(0x13, 3)),
      ud(reqStack('ISTACK')),
    ];
    for (const p of bad) expect(() => assertOnlineRestore(p)).toThrowError(forbidden);
  });

  it('online-write rifiuta download, _INSE e _DELE di SDB', () => {
    expect(() => assertOnlineWrite(job(encodeDeleteBlock('SDB', 1000, 'A')))).toThrowError(
      forbidden,
    );
    for (const f of [
      encodeRequestDownload('SDB', 7, 'P', 100, 2),
      encodeDownloadEnded('SDB', 7, 'P'),
      encodeInsertBlock('SDB', 7, 'P'),
    ]) {
      expect(() => assertOnlineWrite(job(f))).toThrowError(forbidden);
    }
    expect(() => assertOnlineWrite(job(encodeRequestDownload('DB', 7, 'P', 100, 2)))).not.toThrow();
  });

  it('assertOutgoingFrame usa il filtro del ripristino solo in modo online-restore', () => {
    const f = dt(job(encodeDeleteBlock('SDB', 1000, 'A')));
    expect(() => assertOutgoingFrame(f, 'online-restore', 240)).not.toThrow();
    expect(() => assertOutgoingFrame(f, 'online-write', 240)).toThrowError(forbidden);
    expect(() => assertOutgoingFrame(f, 'read-only', 240)).toThrowError(forbidden);
    expect(() => assertOutgoingFrame(f, 'online-test', 240)).toThrowError(forbidden);
    const w = dt(ud(reqReadClock()));
    expect(() => assertOutgoingFrame(w, 'online-restore', 240)).not.toThrow();
  });
});

describe('assertOnlineRestore: scansioni esaustive', () => {
  it('isRestorableSdb segue RESTORE_SDB; SDB 2 mai', () => {
    expect(RESTORE_SDB.single).toEqual([0, 1, 3, 4, 5, 6, 7]);
    expect(isRestorableSdb(2)).toBe(false);
    expect(isRestorableSdb(999)).toBe(false);
    expect(isRestorableSdb(1000)).toBe(true);
    expect(isRestorableSdb(2999)).toBe(true);
    expect(isRestorableSdb(3000)).toBe(false);
    expect(isRestorableSdb(-1)).toBe(false);
  });

  it('SDB 0-65535: _DELE "A", request download, download ended e _INSE "P" passano solo se ripristinabili', () => {
    const expected = [
      ...RESTORE_SDB.single,
      ...Array.from({ length: 1000 }, (_, i) => 1000 + i),
      ...Array.from({ length: 1000 }, (_, i) => 2000 + i),
    ];
    const kinds: Record<string, (n: number) => S7Pdu> = {
      dele: (n) => job(encodeDeleteBlock('SDB', n, 'A')),
      req: (n) => job(encodeRequestDownload('SDB', n, 'P', 100, 2)),
      ended: (n) => job(encodeDownloadEnded('SDB', n, 'P')),
      inse: (n) => job(encodeInsertBlock('SDB', n, 'P')),
    };
    for (const [name, make] of Object.entries(kinds)) {
      const got: number[] = [];
      for (let n = 0; n <= 65535; n++) if (passes(make(n))) got.push(n);
      expect(got, name).toEqual(expected);
    }
  }, 30_000);

  it('tipo x filesystem x numero: passano solo le combinazioni del ripristino', () => {
    const types: BlockType[] = ['OB', 'DB', 'SDB', 'FC', 'SFC', 'FB', 'SFB'];
    const fss = ['A', 'P', 'B'] as const;
    const numbers = [0, 1, 2, 7, 999, 1000, 1999, 2000, 2999, 3000, 65535];
    const got: string[] = [];
    const want: string[] = [];
    for (const t of types)
      for (const fs of fss)
        for (const n of numbers) {
          const user = ['OB', 'FB', 'FC', 'DB'].includes(t);
          const sdbOk = t === 'SDB' && isRestorableSdb(n);
          const key = (k: string): string => `${k}:${t}${n}${fs}`;
          if (passes(job(encodeDeleteBlock(t, n, fs)))) got.push(key('dele'));
          if (t === 'SDB' && sdbOk && fs === 'A') want.push(key('dele'));
          for (const [k, make] of [
            ['req', () => encodeRequestDownload(t, n, fs, 100, 2)],
            ['ended', () => encodeDownloadEnded(t, n, fs)],
            ['inse', () => encodeInsertBlock(t, n, fs)],
          ] as const) {
            if (passes(job(make()))) got.push(key(k));
            if ((user || sdbOk) && fs === 'P') want.push(key(k));
          }
        }
    expect(got.sort()).toEqual(want.sort());
  }, 30_000);

  it('tutti i 256 byte di funzione ROSCTR 1: passano solo 0x1E e 0x1F con parametro minimo', () => {
    const passed: number[] = [];
    for (let fn = 0; fn < 256; fn++) {
      for (const param of [Uint8Array.of(fn), Uint8Array.of(fn, 0, 0, 0, 0, 0, 0, 0)]) {
        if (passes(job(param))) passed.push(fn);
      }
    }
    expect(passed).toEqual([0x1e, 0x1f]);
  });

  it('userdata: tipo x gruppo x sottofunzione (65536): passano le 6 forme di lettura e la lista dei job', () => {
    const canon: Record<string, UserdataFrame> = {
      '4/1': reqReadSzl(0x11, 0),
      '3/1': reqBlockCounts(),
      '3/2': reqBlockListOfType('DB'),
      '3/3': reqBlockInfo('DB', 1),
      '7/1': reqReadClock(),
      '7/3': encodeUserdata(
        { method: 'request', group: 7, subfunction: 3, sequence: 0 },
        none,
        0x0a,
      ),
    };
    const passed: string[] = [];
    for (let type = 0; type < 16; type++) {
      for (let group = 0; group < 16; group++) {
        for (let sub = 0; sub < 256; sub++) {
          const key = `${group}/${sub}`;
          const c = canon[key];
          const param = Uint8Array.of(0, 1, 0x12, 4, 0x11, (type << 4) | group, sub, 0);
          if (passes(job(param, c?.data ?? none, 7))) passed.push(`${type}:${key}`);
        }
      }
    }
    expect(passed.sort()).toEqual(
      Object.keys(canon)
        .map((k) => `4:${k}`)
        .sort(),
    );
  }, 30_000);

  it('TIS: ogni sottofunzione 0-255 con la testa delle richieste: passa solo la lista dei job', () => {
    const base = reqReadJobList();
    const passed: number[] = [];
    for (let sub = 0; sub < 256; sub++) {
      const param = base.param.slice();
      param[6] = sub;
      if (passes(job(param, base.data, 7))) passed.push(sub);
    }
    expect(passed).toEqual([base.param[6]]);
  });

  it('dati presenti in una richiesta del ripristino → rifiutati', () => {
    for (const f of [
      encodeDeleteBlock('SDB', 1000, 'A'),
      encodeInsertBlock('SDB', 0, 'P'),
      encodePlcStop(),
      encodeWarmRestart(),
    ]) {
      expect(() => assertOnlineRestore(job(f, Uint8Array.of(0)))).toThrowError(forbidden);
    }
  });
});
