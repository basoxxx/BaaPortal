import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  S7Connection,
  S7Error,
  createRecorder,
  decodeSetup,
  encodeReadRequest,
  hex,
  memoryTransportPair,
  nextPduRef,
  remoteTsap,
  type Transport,
} from '../src';
import { FakeCpu, type FakeCpuOptions } from './fakeCpu';

afterEach(() => {
  vi.useRealTimers();
});

const readParam = encodeReadRequest([{ area: 'M', db: 0, start: 0, size: 'BYTE', count: 1 }]);
const none = new Uint8Array(0);

function rig(opts: FakeCpuOptions = {}): { client: Transport; cpu: FakeCpu } {
  const [client, server] = memoryTransportPair();
  return { client, cpu: new FakeCpu(server, opts) };
}

async function openOn(
  client: Transport,
  extra: Partial<Parameters<typeof S7Connection.open>[0]> = {},
): Promise<S7Connection> {
  return S7Connection.open({ host: 'h', transport: async () => client, ...extra });
}

describe('apertura', () => {
  it('invia CR con TSAP e TPDU size, poi setup 1/1 con 480, e adotta la PDU 240 della CPU', async () => {
    const { client, cpu } = rig({ pdu: 240, amq: 3 });
    const conn = await openOn(client, { rack: 0, slot: 2 });
    const cr = cpu.cotp[0]!;
    expect(cr).toMatchObject({
      type: 'CR',
      dstRef: 0,
      srcRef: 0x0100,
      tpduSize: 0x0a,
      srcTsap: 0x0100,
      dstTsap: remoteTsap('pg', 0, 2),
    });
    const setup = decodeSetup(cpu.pdus[0]!.param);
    expect(setup).toEqual({ amqCalling: 1, amqCalled: 1, pduLength: 480 });
    expect(conn.pduLength).toBe(240);
    expect(conn.amq).toBe(3);
    expect(conn.closed).toBe(false);
  });

  it('usa il TSAP remoto esplicito, il tipo e la PDU proposta', async () => {
    const { client, cpu } = rig();
    await openOn(client, { remoteTsap: 0x0203, localTsap: 0x4d57, proposedPdu: 960 });
    expect(cpu.cotp[0]).toMatchObject({ srcTsap: 0x4d57, dstTsap: 0x0203 });
    expect(decodeSetup(cpu.pdus[0]!.param).pduLength).toBe(960);
    const r2 = rig();
    await openOn(r2.client, { connectionType: 'op', rack: 0, slot: 3 });
    expect(r2.cpu.cotp[0]).toMatchObject({ dstTsap: 0x0203 });
  });

  it('DR al posto del CC -> COTP_REJECTED con il motivo; ER con la causa', async () => {
    const a = rig({ connect: 'dr' });
    await expect(openOn(a.client)).rejects.toMatchObject({
      code: 'COTP_REJECTED',
      message: expect.stringContaining('0x03'),
    });
    const b = rig({ connect: 'er' });
    await expect(openOn(b.client)).rejects.toMatchObject({
      code: 'COTP_REJECTED',
      message: expect.stringContaining('0x01'),
    });
  });

  it('nessun CC -> CONNECT_TIMEOUT entro 1,5x il timeout', async () => {
    vi.useFakeTimers();
    const { client } = rig({ connect: 'silent' });
    const p = openOn(client, { timeoutMs: 1000 });
    const seen = p.then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await seen).toBe('CONNECT_TIMEOUT');
    expect(client).toBeDefined();
  });

  it('setup senza risposta -> TIMEOUT e connessione chiusa', async () => {
    vi.useFakeTimers();
    const { client } = rig({ setup: 'silent' });
    const seen = openOn(client, { timeoutMs: 500 }).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(await seen).toBe('TIMEOUT');
  });

  it('il segnale già annullato dà ABORTED senza aprire nulla', async () => {
    const { client, cpu } = rig();
    const ac = new AbortController();
    ac.abort();
    await expect(openOn(client, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cpu.cotp.length).toBe(0);
  });
});

describe('riferimento PDU', () => {
  it('cresce di uno, salta lo 0 e si riavvolge a 16 bit', () => {
    expect(nextPduRef(0)).toBe(1);
    expect(nextPduRef(1)).toBe(2);
    expect(nextPduRef(0xfffe)).toBe(0xffff);
    expect(nextPduRef(0xffff)).toBe(1);
  });

  it('i riferimenti sul filo sono consecutivi, a partire dal setup', async () => {
    const { client, cpu } = rig({ onPdu: (p, c) => c.ack(p.pduRef, new Uint8Array([4, 0])) });
    const conn = await openOn(client);
    await conn.request(readParam, none, 1);
    await conn.request(readParam, none, 1);
    expect(cpu.pdus.map((p) => p.pduRef)).toEqual([1, 2, 3]);
  });
});

describe('richiesta e risposta', () => {
  it('abbina per riferimento; una risposta sconosciuta si ignora e si registra', async () => {
    const rec = createRecorder();
    const { client } = rig({
      onPdu: (p, c) => {
        c.ack(p.pduRef + 100, new Uint8Array([9]));
        c.ack(p.pduRef, new Uint8Array([4, 0]));
      },
    });
    const conn = await openOn(client, { recorder: rec });
    const res = await conn.request(readParam, none, 1);
    expect(res.rosctr).toBe(3);
    expect([...res.param]).toEqual([4, 0]);
    expect(conn.ignoredCount).toBe(1);
    expect(conn.closed).toBe(false);
  });

  it('una risposta con lo stesso riferimento ma ROSCTR incoerente si ignora', async () => {
    const { client } = rig({
      onPdu: (p, c) => {
        // userdata in risposta a un job: incoerente
        c.sendPdu({
          rosctr: 7,
          pduRef: p.pduRef,
          errorClass: 0,
          errorCode: 0,
          param: none,
          data: none,
        });
        c.ack(p.pduRef, new Uint8Array([4, 0]));
      },
    });
    const conn = await openOn(client);
    await expect(conn.request(readParam, none, 1)).resolves.toMatchObject({ rosctr: 3 });
    expect(conn.ignoredCount).toBe(1);
  });

  it("un errore della CPU nell'header non è sollevato: request() restituisce la PDU", async () => {
    const { client } = rig({
      onPdu: (p, c) =>
        c.sendPdu({
          rosctr: 2,
          pduRef: p.pduRef,
          errorClass: 0x81,
          errorCode: 0x04,
          param: none,
          data: none,
        }),
    });
    const conn = await openOn(client);
    const res = await conn.request(readParam, none, 1);
    expect(res).toMatchObject({ rosctr: 2, errorClass: 0x81, errorCode: 0x04 });
  });

  it("riassembla i DT senza EOT fino all'EOT", async () => {
    const { client } = rig({
      onPdu: (p, c) => {
        const bytes = encodeAck(p.pduRef);
        const mid = Math.floor(bytes.length / 2);
        c.sendCotp({ type: 'DT', eot: false, data: bytes.slice(0, mid) });
        c.sendCotp({ type: 'DT', eot: true, data: bytes.slice(mid) });
      },
    });
    const conn = await openOn(client);
    await expect(conn.request(readParam, none, 1)).resolves.toMatchObject({ rosctr: 3 });
  });

  it('una sola richiesta in volo anche con AmQ 3: le altre aspettano', async () => {
    const seen: number[] = [];
    let release: (() => void) | undefined;
    const { client, cpu } = rig({
      amq: 3,
      onPdu: (p, c) => {
        seen.push(p.pduRef);
        release = () => c.ack(p.pduRef, new Uint8Array([4, 0]));
      },
    });
    const conn = await openOn(client);
    const done: number[] = [];
    const ps = [1, 2, 3].map((i) => conn.request(readParam, none, 1).then(() => done.push(i)));
    await new Promise((r) => setTimeout(r, 30));
    expect(cpu.pdus.length - 1).toBe(1);
    release!();
    await new Promise((r) => setTimeout(r, 30));
    expect(cpu.pdus.length - 1).toBe(2);
    release!();
    await new Promise((r) => setTimeout(r, 30));
    release!();
    await Promise.all(ps);
    expect(done).toEqual([1, 2, 3]);
    expect(seen).toEqual([2, 3, 4]);
  });

  it('un job ROSCTR 1 dalla CPU chiude con PROTOCOL e non riceve risposta', async () => {
    let cpuRef: FakeCpu | undefined;
    const { client, cpu } = rig({
      onPdu: (_p, c) => {
        cpuRef = c;
        c.sendPdu({
          rosctr: 1,
          pduRef: 77,
          errorClass: 0,
          errorCode: 0,
          param: readParam,
          data: none,
        });
      },
    });
    const conn = await openOn(client);
    const sentBefore = cpu.pdus.length;
    await expect(conn.request(readParam, none, 1)).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(conn.closed).toBe(true);
    expect(cpuRef).toBeDefined();
    // nessun frame S7 inviato in risposta: solo la richiesta stessa
    expect(cpu.pdus.length).toBe(sentBefore + 1);
    await expect(conn.request(readParam, none, 1)).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('request con PDU più grande di quella negoziata è rifiutata', async () => {
    const { client } = rig({ pdu: 240 });
    const conn = await openOn(client);
    await expect(conn.request(readParam, new Uint8Array(300), 1)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

function encodeAck(ref: number): Uint8Array {
  const param = new Uint8Array([4, 0]);
  const out = new Uint8Array(12 + 2);
  out.set([0x32, 3, 0, 0, ref >> 8, ref & 0xff, 0, 2, 0, 0, 0, 0], 0);
  out.set(param, 12);
  return out;
}

describe('timeout, chiusura e annullamento', () => {
  it('timeout di risposta: TIMEOUT, connessione chiusa, richiesta in coda rifiutata con CLOSED', async () => {
    vi.useFakeTimers();
    const { client } = rig({ onPdu: () => undefined });
    const conn = await openOn(client);
    const first = conn.request(readParam, none, 1, 200).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    const queued = conn.request(readParam, none, 1).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toBe('TIMEOUT');
    expect(await queued).toBe('CLOSED');
    expect(conn.closed).toBe(true);
  });

  it('il timeout predefinito è 5000 ms', async () => {
    vi.useFakeTimers();
    const { client } = rig({ onPdu: () => undefined });
    const conn = await openOn(client);
    let code = '';
    void conn.request(readParam, none, 1).catch((e: { code: string }) => (code = e.code));
    await vi.advanceTimersByTimeAsync(4900);
    expect(code).toBe('');
    await vi.advanceTimersByTimeAsync(200);
    expect(code).toBe('TIMEOUT');
  });

  it('chiusura del trasporto: tutto in sospeso è rifiutato con CLOSED', async () => {
    const { client, cpu } = rig({ onPdu: () => undefined });
    const conn = await openOn(client);
    const rs = [
      conn.request(readParam, none, 1).catch((e: { code: string }) => e.code),
      conn.request(readParam, none, 1).catch((e: { code: string }) => e.code),
    ];
    await new Promise((r) => setTimeout(r, 10));
    cpu.end.close();
    expect(await Promise.all(rs)).toEqual(['CLOSED', 'CLOSED']);
    expect(conn.closed).toBe(true);
  });

  it('signal annullato: ABORTED e connessione chiusa', async () => {
    const ac = new AbortController();
    const { client } = rig({ onPdu: () => undefined });
    const conn = await openOn(client, { signal: ac.signal });
    const p = conn.request(readParam, none, 1).catch((e: { code: string }) => e.code);
    const q = conn.request(readParam, none, 1).catch((e: { code: string }) => e.code);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await p).toBe('ABORTED');
    expect(await q).toBe('ABORTED');
    expect(conn.closed).toBe(true);
  });

  it('dopo close() nessuna promessa resta in sospeso (contatore)', async () => {
    const { client, cpu } = rig({ onPdu: () => undefined });
    const conn = await openOn(client);
    let settled = 0;
    const N = 6;
    for (let i = 0; i < N; i++) {
      conn.request(readParam, none, 1).then(
        () => settled++,
        () => settled++,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
    await conn.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(N);
    expect(conn.closed).toBe(true);
    // DR di cortesia inviato come ultimo frame COTP
    expect(cpu.cotp.at(-1)?.type).toBe('DR');
    await conn.close(); // idempotente
    await expect(conn.request(readParam, none, 1)).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

describe('registratore', () => {
  it('registra CR/CC e ogni frame come sul filo; un frame rifiutato non è tx', async () => {
    const rec = createRecorder();
    const { client } = rig({ onPdu: (p, c) => c.ack(p.pduRef, new Uint8Array([4, 0])) });
    const conn = await openOn(client, { recorder: rec });
    await conn.request(readParam, none, 1);
    await expect(conn.request(new Uint8Array([0x05, 0x01]), none, 1)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const frames = rec.frames();
    // CR, CC, setup, setup-ack, read, read-ack
    expect(frames.map((f) => f.dir)).toEqual(['tx', 'rx', 'tx', 'rx', 'tx', 'rx']);
    expect(hex(frames[0]!.bytes).startsWith('11e000000100')).toBe(true);
    expect(hex(frames[1]!.bytes).startsWith('11d0')).toBe(true);
    expect(frames.some((f) => hex(f.bytes).includes('0501'))).toBe(false);
    expect(conn.refusedCount).toBe(1);
  });
});

describe('sorgente: punto di invio e confini della piattaforma', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  const src = join(__dirname, '..', 'src');
  const rel = (f: string): string => f.slice(src.length + 1);
  const stripComments = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const files = walk(src);

  it('il parola "send" (ogni forma di accesso) compare solo nel punto di invio e nei trasporti', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const r = rel(f);
      const text = stripComments(readFileSync(f, 'utf8'));
      if (r === 'transport.ts' || r.startsWith('node/')) continue;
      if (r === 'connection.ts') {
        // i marcatori sono commenti: cercarli nel testo originale
        const raw = readFileSync(f, 'utf8');
        const s0 = raw.indexOf('// BEGIN CHOKE POINT');
        const e0 = raw.indexOf('// END CHOKE POINT');
        expect(s0).toBeGreaterThan(-1);
        expect(e0).toBeGreaterThan(s0);
        const outside = stripComments(raw.slice(0, s0) + raw.slice(e0));
        expect(outside, r).not.toMatch(/\bsend\b/);
        const inside = stripComments(raw.slice(s0, e0));
        expect((inside.match(/\bsend\b/g) ?? []).length).toBeLessThanOrEqual(3);
        expect(inside.match(/\.send\(/g)?.length).toBe(1);
        continue;
      }
      expect(text, r).not.toMatch(/\bsend\b/);
    }
    for (const f of files) {
      expect(stripComments(readFileSync(f, 'utf8')), rel(f)).not.toMatch(/\bReflect\b|\.bind\(/);
    }
  });

  it('net, node:*, require( e import( solo in src/node/ (tutte le estensioni)', () => {
    for (const f of files) {
      if (rel(f).startsWith('node/')) continue;
      const text = stripComments(readFileSync(f, 'utf8'));
      expect(text, rel(f)).not.toMatch(
        /['"`](node:[a-z_/]+|net|tls|dgram|http2?|https|fs|child_process|worker_threads)['"`]/,
      );
      expect(text, rel(f)).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    }
  });
});

describe("struttura: nessun Transport sull'istanza", () => {
  it('né proprietà proprie né sul prototipo contengono un oggetto con send()', async () => {
    const { client } = rig();
    const conn = await openOn(client);
    const holders: string[] = [];
    let o: object | null = conn;
    while (o && o !== Object.prototype) {
      for (const k of [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o)]) {
        const d = Object.getOwnPropertyDescriptor(o, k)!;
        const v: unknown = 'value' in d ? d.value : undefined;
        if (v && typeof v === 'object' && typeof (v as { send?: unknown }).send === 'function') {
          holders.push(String(k));
        }
      }
      o = Object.getPrototypeOf(o);
    }
    expect(holders).toEqual([]);
    expect((conn as unknown as Record<string, unknown>)['transport']).toBeUndefined();
  });

  it('pduLength e amq sono di sola lettura', async () => {
    const { client } = rig();
    const conn = await openOn(client);
    for (const k of ['pduLength', 'amq'] as const) {
      const d = Object.getOwnPropertyDescriptor(S7Connection.prototype, k)!;
      expect(d.get).toBeTypeOf('function');
      expect(d.set).toBeUndefined();
    }
    expect(() => {
      (conn as unknown as { pduLength: number }).pduLength = 1;
    }).toThrow();
  });
});

describe('ogni promessa si risolve, nessun timer resta', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown): void => void unhandled.push(r);
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };

  /** Trasporto che chiude sincronamente da dentro send(). */
  function closingTransport(end: Transport): { t: Transport; arm: () => void } {
    let closeCb: ((e?: Error) => void) | undefined;
    let armed = false;
    return {
      arm: () => (armed = true),
      t: {
        send: (b) => {
          if (armed) closeCb?.();
          end.send(b);
        },
        onData: (cb) => end.onData(cb),
        onClose: (cb) => {
          closeCb = cb;
          end.onClose(cb);
        },
        close: () => end.close(),
      },
    };
  }

  it("onClose sincrono dentro send() durante l'apertura: open rifiuta con CLOSED", async () => {
    vi.useFakeTimers();
    const [a, b] = memoryTransportPair();
    new FakeCpu(b);
    const { t, arm } = closingTransport(a);
    arm();
    await expect(openOn(t)).rejects.toMatchObject({ code: 'CLOSED' });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('onClose sincrono dentro send() di una richiesta: CLOSED per tutte', async () => {
    vi.useFakeTimers();
    const [a, b] = memoryTransportPair();
    new FakeCpu(b);
    const { t, arm } = closingTransport(a);
    const conn = await openOn(t);
    arm();
    const r1 = conn.request(readParam, none, 1).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    const r2 = conn.request(readParam, none, 1).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    expect(await r1).toBe('CLOSED');
    expect(await r2).toBe('CLOSED');
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('un registratore che annulla (abort) durante il tx della CR: open rifiuta, nessun timer', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const { client } = rig();
    const rec = {
      record: (d: 'tx' | 'rx') => {
        if (d === 'tx') ac.abort();
      },
      frames: () => [],
    };
    await expect(openOn(client, { recorder: rec, signal: ac.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('un registratore che chiama close() durante il tx di una richiesta: CLOSED, nessun timer', async () => {
    vi.useFakeTimers();
    const { client } = rig({ onPdu: () => undefined });
    const holder: { conn?: S7Connection } = {};
    let armed = false;
    const rec = {
      record: (d: 'tx' | 'rx') => {
        if (armed && d === 'tx') void holder.conn!.close();
      },
      frames: () => [],
    };
    const conn = await openOn(client, { recorder: rec });
    holder.conn = conn;
    armed = true;
    const r1 = conn.request(readParam, none, 1).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    const r2 = conn.request(readParam, none, 1).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    expect(await r1).toBe('CLOSED');
    expect(await r2).toBe('CLOSED');
    await flush();
    expect(conn.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('un registratore che abort() durante il tx di una richiesta: ABORTED, nessun timer', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const { client } = rig({ onPdu: () => undefined });
    let armed = false;
    const rec = {
      record: (d: 'tx' | 'rx') => {
        if (armed && d === 'tx') ac.abort();
      },
      frames: () => [],
    };
    const conn = await openOn(client, { recorder: rec, signal: ac.signal });
    armed = true;
    const r1 = conn.request(readParam, none, 1).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    expect(await r1).toBe('ABORTED');
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('un registratore che lancia non disturba la connessione', async () => {
    vi.useFakeTimers();
    const { client } = rig({ onPdu: (p, c) => c.ack(p.pduRef, new Uint8Array([4, 0])) });
    const rec = {
      record: () => {
        throw new Error('rotto');
      },
      frames: () => [],
    };
    const conn = await openOn(client, { recorder: rec });
    await expect(conn.request(readParam, none, 1)).resolves.toMatchObject({ rosctr: 3 });
    await conn.close();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('un invio che lancia nella CR: open rifiuta, nessun timer, nessun rifiuto non gestito', async () => {
    vi.useFakeTimers();
    const [a] = memoryTransportPair();
    const t: Transport = {
      send: () => {
        throw new Error('socket rotto');
      },
      onData: (cb) => a.onData(cb),
      onClose: (cb) => a.onClose(cb),
      close: () => a.close(),
    };
    await expect(openOn(t)).rejects.toThrow('socket rotto');
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe('opzioni, annullamento e TPDU', () => {
  it('valida TSAP, PDU proposta e timeout con RangeError', async () => {
    const mk = (): Transport => rig().client;
    const bad: Partial<Parameters<typeof S7Connection.open>[0]>[] = [
      { localTsap: -1 },
      { localTsap: 0x10000 },
      { remoteTsap: 1.5 },
      { proposedPdu: 100 },
      { proposedPdu: 2000 },
      { timeoutMs: 0 },
      { timeoutMs: -5 },
      { timeoutMs: Number.NaN },
    ];
    for (const b of bad) {
      await expect(openOn(mk(), b), JSON.stringify(b)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('request con timeout non positivo: RangeError', async () => {
    const { client } = rig();
    const conn = await openOn(client);
    await expect(conn.request(readParam, none, 1, 0)).rejects.toBeInstanceOf(RangeError);
  });

  it('il segnale è passato alla fabbrica di trasporti: abort durante la connessione è immediato', async () => {
    const ac = new AbortController();
    let got: AbortSignal | undefined;
    const factory = (
      _h: string,
      _p: number,
      _t: number,
      signal?: AbortSignal,
    ): Promise<Transport> => {
      got = signal;
      return new Promise((_res, rej) => {
        signal?.addEventListener('abort', () => rej(new S7Error('ABORTED', 'annullato')));
      });
    };
    const p = S7Connection.open({ host: 'h', transport: factory, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    expect(got).toBe(ac.signal);
  });

  it('il TPDU-size del CC più piccolo limita la PDU (e la proposta del setup)', async () => {
    const { client, cpu } = rig({ pdu: 480, ccTpduSize: 0x08 });
    const conn = await openOn(client);
    expect(decodeSetup(cpu.pdus[0]!.param).pduLength).toBe(253);
    expect(conn.pduLength).toBe(253);
  });

  it('un TPDU-size del CC troppo piccolo dà COTP_REJECTED', async () => {
    const { client } = rig({ ccTpduSize: 0x04 });
    await expect(openOn(client)).rejects.toMatchObject({ code: 'COTP_REJECTED' });
  });
});

describe('memoryTransportPair', () => {
  it("consegna in modo asincrono (microtask) e chiude l'altra estremità", async () => {
    const [a, b] = memoryTransportPair();
    const got: number[] = [];
    b.onData((c) => got.push(c[0]!));
    let closed = false;
    b.onClose(() => (closed = true));
    a.onData(() => undefined);
    a.send(Uint8Array.of(7));
    expect(got).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([7]);
    a.close();
    expect(closed).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(true);
  });
});
