import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  S7Connection,
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

describe('sorgente: transport.send solo nel punto di controllo', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  const src = join(__dirname, '..', 'src');

  it('".send(" compare solo in sendFrame e nelle implementazioni del trasporto', () => {
    const allowedFiles = new Set(['transport.ts', join('node', 'tcpTransport.ts')]);
    for (const f of walk(src)) {
      const rel = f.slice(src.length + 1);
      const text = readFileSync(f, 'utf8');
      const count = (text.match(/\.send\(/g) ?? []).length;
      if (allowedFiles.has(rel)) continue;
      if (rel === 'connection.ts') {
        expect(count, rel).toBe(1);
        const start = text.indexOf('private sendFrame(');
        const end = text.indexOf('\n  }\n', start);
        const at = text.indexOf('.send(');
        expect(start).toBeGreaterThan(-1);
        expect(at).toBeGreaterThan(start);
        expect(at).toBeLessThan(end);
        expect(text).toMatch(/this\.transport\.send\(/);
      } else {
        expect(count, rel).toBe(0);
      }
    }
  });

  it('node:net è importato solo da node/tcpTransport.ts', () => {
    for (const f of walk(src)) {
      const rel = f.slice(src.length + 1);
      const text = readFileSync(f, 'utf8');
      if (rel === join('node', 'tcpTransport.ts')) continue;
      expect(text, rel).not.toMatch(/from ['"]node:/);
    }
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
