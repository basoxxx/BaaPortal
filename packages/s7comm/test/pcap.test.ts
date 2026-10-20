import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S7Error,
  createRecorder,
  decodeCotp,
  dissect,
  encodeCotp,
  encodeS7,
  encodeSetup,
  encodeTpkt,
  fromHex,
  framesToJsonl,
  hex,
  jsonlToFrames,
  readPcap,
  type CapturedFrame,
} from '../src';
import { CISAGOV_DIR } from './captures';

// ---- costruttori di catture sintetiche -------------------------------------------------------

interface Seg {
  from: 'c' | 's';
  seq: number;
  payload?: Uint8Array;
  flags?: number; // 0x02 SYN, 0x10 ACK, ...
  ms?: number;
  sport?: number; // sovrascrive la porta (per le prove "non 102")
}

const CIP = [10, 0, 0, 1];
const SIP = [10, 0, 0, 2];

function ipTcp(s: Seg): Uint8Array {
  const payload = s.payload ?? new Uint8Array(0);
  const toServer = s.from === 'c';
  const src = toServer ? CIP : SIP;
  const dst = toServer ? SIP : CIP;
  const sport = s.sport ?? (toServer ? 40000 : 102);
  const dport = toServer ? 102 : 40000;
  const total = 20 + 20 + payload.length;
  const b = new Uint8Array(total);
  b[0] = 0x45;
  b[2] = total >> 8;
  b[3] = total & 0xff;
  b[8] = 64;
  b[9] = 6;
  b.set(src, 12);
  b.set(dst, 16);
  b[20] = sport >> 8;
  b[21] = sport & 0xff;
  b[22] = dport >> 8;
  b[23] = dport & 0xff;
  new DataView(b.buffer).setUint32(24, s.seq >>> 0);
  b[32] = 0x50;
  b[33] = s.flags ?? 0x18;
  b.set(payload, 40);
  return b;
}

function ether(ip: Uint8Array, opts: { vlan?: boolean } = {}): Uint8Array {
  const head = opts.vlan
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0x81, 0x00, 0x00, 0x64, 0x08, 0x00]
    : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0x08, 0x00];
  const out = new Uint8Array(head.length + ip.length + 6); // 6 byte di riempimento Ethernet
  out.set(head, 0);
  out.set(ip, head.length);
  return out;
}

function sll(ip: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + ip.length);
  out[15] = 0; // protocollo in 14-15 (non usato)
  out[14] = 0x08;
  out.set(ip, 16);
  return out;
}

interface RawPacket {
  ms: number;
  data: Uint8Array;
  link?: number;
}

function pcapFile(
  packets: RawPacket[],
  o: { be?: boolean; nano?: boolean; link?: number } = {},
): Uint8Array {
  const parts: number[] = [];
  const dv = new DataView(new ArrayBuffer(24));
  const le = !o.be;
  dv.setUint32(0, o.nano ? 0xa1b23c4d : 0xa1b2c3d4, le);
  dv.setUint16(4, 2, le);
  dv.setUint16(6, 4, le);
  dv.setUint32(16, 65535, le);
  dv.setUint32(20, o.link ?? 1, le);
  parts.push(...new Uint8Array(dv.buffer));
  for (const p of packets) {
    const h = new DataView(new ArrayBuffer(16));
    const sec = Math.floor(p.ms / 1000);
    const frac = Math.round((p.ms - sec * 1000) * (o.nano ? 1e6 : 1e3));
    h.setUint32(0, sec, le);
    h.setUint32(4, frac, le);
    h.setUint32(8, p.data.length, le);
    h.setUint32(12, p.data.length, le);
    parts.push(...new Uint8Array(h.buffer), ...p.data);
  }
  return Uint8Array.from(parts);
}

function pcapngFile(
  packets: (RawPacket & { iface?: number; simple?: boolean })[],
  o: { be?: boolean; links?: number[]; tsresol?: number } = {},
): Uint8Array {
  const le = !o.be;
  const out: number[] = [];
  const block = (type: number, body: number[]): void => {
    const pad = (4 - (body.length % 4)) % 4;
    const total = 12 + body.length + pad;
    const h = new DataView(new ArrayBuffer(8));
    h.setUint32(0, type, le);
    h.setUint32(4, total, le);
    const t = new DataView(new ArrayBuffer(4));
    t.setUint32(0, total, le);
    out.push(
      ...new Uint8Array(h.buffer),
      ...body,
      ...new Array<number>(pad).fill(0),
      ...new Uint8Array(t.buffer),
    );
  };
  const u32 = (v: number): number[] => {
    const d = new DataView(new ArrayBuffer(4));
    d.setUint32(0, v >>> 0, le);
    return [...new Uint8Array(d.buffer)];
  };
  const u16 = (v: number): number[] => {
    const d = new DataView(new ArrayBuffer(2));
    d.setUint16(0, v, le);
    return [...new Uint8Array(d.buffer)];
  };
  // SHB
  block(0x0a0d0d0a, [
    ...u32(0x1a2b3c4d),
    ...u16(1),
    ...u16(0),
    ...u32(0xffffffff),
    ...u32(0xffffffff),
  ]);
  const resol = o.tsresol ?? 6;
  for (const link of o.links ?? [1]) {
    // IDB con opzione if_tsresol
    block(1, [
      ...u16(link),
      ...u16(0),
      ...u32(65535),
      ...u16(9),
      ...u16(1),
      resol,
      0,
      0,
      0,
      ...u16(0),
      ...u16(0),
    ]);
  }
  for (const p of packets) {
    if (p.simple) {
      block(3, [...u32(p.data.length), ...p.data]);
      continue;
    }
    const ticks = BigInt(Math.round(p.ms * 1000)) * 10n ** BigInt(resol - 6);
    const hi = Number(ticks >> 32n);
    const lo = Number(ticks & 0xffffffffn);
    block(6, [
      ...u32(p.iface ?? 0),
      ...u32(hi),
      ...u32(lo),
      ...u32(p.data.length),
      ...u32(p.data.length),
      ...p.data,
    ]);
  }
  return Uint8Array.from(out);
}

const tpktOf = (payload: Uint8Array): Uint8Array => encodeTpkt(payload);
const CR = fromHex('11e00000000f00c1020100c2020102c0010a');
const CC = fromHex('11d0000f000300c0010ac1020100c2020102');
const dt = (body: string): Uint8Array => encodeCotp({ type: 'DT', eot: true, data: fromHex(body) });

const crTpkt = tpktOf(CR);
const ccTpkt = tpktOf(CC);
const dtA = tpktOf(dt('32010000000100080000f0000001000103c0'));
const dtB = tpktOf(dt('320300000001000200080000000000f0000001000100f0'));

/** Conversazione base: SYN, SYN-ACK, CR in due pezzi, CC, DT A, DT B. */
function conversation(): RawPacket[] {
  const segs: Seg[] = [
    { from: 'c', seq: 1000, flags: 0x02, ms: 0 },
    { from: 's', seq: 5000, flags: 0x12, ms: 1 },
    { from: 'c', seq: 1001, flags: 0x10, ms: 2 },
    { from: 'c', seq: 1001, payload: crTpkt.subarray(0, 10), ms: 10 },
    { from: 'c', seq: 1001 + 10, payload: crTpkt.subarray(10), ms: 11 },
    { from: 's', seq: 5001, payload: ccTpkt, ms: 20 },
    { from: 'c', seq: 1001 + crTpkt.length, payload: dtA, ms: 30 },
    { from: 's', seq: 5001 + ccTpkt.length, payload: dtB, ms: 40 },
  ];
  return segs.map((s) => ({ ms: 1_700_000_000_000 + (s.ms ?? 0), data: ether(ipTcp(s)) }));
}

const expectedFrames = (): CapturedFrame[] => [
  { t: 0, dir: 'tx', bytes: CR },
  { t: 9, dir: 'rx', bytes: CC },
  { t: 19, dir: 'tx', bytes: dtA.subarray(4) },
  { t: 29, dir: 'rx', bytes: dtB.subarray(4) },
];

const summary = (fr: CapturedFrame[]): string[] => fr.map((f) => `${f.dir}:${hex(f.bytes)}`);

describe('readPcap: file sintetici', () => {
  it('ricompone i TPKT spezzati su più segmenti e assegna direzione e tempo', () => {
    const streams = readPcap(pcapFile(conversation()));
    expect(streams).toHaveLength(1);
    expect(streams[0]!.client).toBe('10.0.0.1:40000');
    expect(streams[0]!.server).toBe('10.0.0.2:102');
    expect(summary(streams[0]!.frames)).toEqual(summary(expectedFrames()));
    // t = ms dal primo frame del flusso (un frame vale quando arriva il suo ultimo segmento)
    expect(streams[0]!.frames.map((f) => f.t)).toEqual([0, 9, 19, 29]);
  });

  it.each([
    ['pcap LE µs', () => pcapFile(conversation())],
    ['pcap BE µs', () => pcapFile(conversation(), { be: true })],
    ['pcap LE ns', () => pcapFile(conversation(), { nano: true })],
    ['pcap BE ns', () => pcapFile(conversation(), { be: true, nano: true })],
    ['pcapng LE', () => pcapngFile(conversation())],
    ['pcapng BE', () => pcapngFile(conversation(), { be: true })],
    ['pcapng ns', () => pcapngFile(conversation(), { tsresol: 9 })],
  ])('%s dà gli stessi frame', (_n, make) => {
    const s = readPcap(make());
    expect(s).toHaveLength(1);
    expect(summary(s[0]!.frames)).toEqual(summary(expectedFrames()));
    expect(s[0]!.frames.map((f) => f.t)).toEqual([0, 9, 19, 29]);
  });

  it('pcapng con più interfacce (Ethernet e IP grezzo) e Simple Packet Block', () => {
    const pk = conversation();
    const raw = (p: RawPacket): Uint8Array => p.data.subarray(14, p.data.length - 6);
    const mixed = pk.map((p, i) =>
      i % 2 === 0 ? { ...p, iface: 0 } : { ms: p.ms, data: raw(p), iface: 1 },
    );
    const s = readPcap(pcapngFile(mixed, { links: [1, 101] }));
    expect(summary(s[0]!.frames)).toEqual(summary(expectedFrames()));
    // SPB: nessun orario, il flusso resta ricomponibile
    const spb = pk.map((p) => ({ ms: 0, data: p.data, simple: true }));
    const s2 = readPcap(pcapngFile(spb));
    expect(summary(s2[0]!.frames)).toEqual(summary(expectedFrames()));
  });

  it('802.1Q VLAN e Linux cooked SLL', () => {
    const pk = conversation();
    const vlan = pk.map((p) => {
      const ip = p.data.subarray(14, p.data.length - 6);
      return { ms: p.ms, data: ether(ip, { vlan: true }) };
    });
    expect(summary(readPcap(pcapFile(vlan))[0]!.frames)).toEqual(summary(expectedFrames()));
    const cooked = pk.map((p) => ({ ms: p.ms, data: sll(p.data.subarray(14, p.data.length - 6)) }));
    expect(summary(readPcap(pcapFile(cooked, { link: 113 }))[0]!.frames)).toEqual(
      summary(expectedFrames()),
    );
  });

  it('ritrasmissioni, duplicati e segmenti fuori ordine non cambiano i frame', () => {
    const segs: Seg[] = [
      { from: 'c', seq: 1000, flags: 0x02, ms: 0 },
      { from: 's', seq: 5000, flags: 0x12, ms: 1 },
      { from: 'c', seq: 1001, payload: crTpkt, ms: 10 },
      { from: 'c', seq: 1001, payload: crTpkt, ms: 11 }, // ritrasmissione
      { from: 's', seq: 5001, payload: ccTpkt, ms: 20 },
      { from: 's', seq: 5001, payload: ccTpkt, ms: 21 }, // duplicato
      // dtA (seq 1001+len) arriva dopo dtA2 (fuori ordine)
      { from: 'c', seq: 1001 + crTpkt.length + dtA.length, payload: dtB, ms: 31 },
      { from: 'c', seq: 1001 + crTpkt.length, payload: dtA, ms: 32 },
      // ritrasmissione parziale: ripete la coda di dtB più un pezzo nuovo non esiste: solo la coda
      { from: 'c', seq: 1001 + crTpkt.length + dtA.length + 5, payload: dtB.subarray(5), ms: 33 },
    ];
    const s = readPcap(
      pcapFile(segs.map((x) => ({ ms: 1000 + (x.ms ?? 0), data: ether(ipTcp(x)) }))),
    );
    expect(s).toHaveLength(1);
    expect(summary(s[0]!.frames)).toEqual([
      `tx:${hex(CR)}`,
      `rx:${hex(CC)}`,
      `tx:${hex(dtA.subarray(4))}`,
      `tx:${hex(dtB.subarray(4))}`,
    ]);
  });

  it('ignora le porte diverse da 102 e separa i flussi; la direzione è verso la porta 102', () => {
    const other: Seg = { from: 'c', seq: 1, payload: crTpkt, ms: 0 };
    const pk = conversation();
    const wrongPort = ipTcp(other);
    wrongPort[22] = 0x03; // porta di destinazione 0x0366
    wrongPort[23] = 0x66;
    const second = conversation().map((p) => {
      const ip = p.data.slice(14, p.data.length - 6);
      if (ip[20] === 0x9c && ip[21] === 0x40) ip[21] = 0x41; // porta client 40000 -> 40001
      if (ip[22] === 0x9c && ip[23] === 0x40) ip[23] = 0x41;
      return { ms: p.ms + 5000, data: ether(ip) };
    });
    const s = readPcap(pcapFile([{ ms: 0, data: ether(wrongPort) }, ...pk, ...second]));
    expect(s).toHaveLength(2);
    expect(s[0]!.client).toBe('10.0.0.1:40000');
    expect(s[1]!.client).toBe('10.0.0.1:40001');
    for (const x of s) expect(x.frames.map((f) => f.dir)).toEqual(['tx', 'rx', 'tx', 'rx']);
  });

  it('un nuovo SYN sulla stessa quadrupla apre un altro flusso', () => {
    const a = conversation();
    const b = conversation().map((p) => ({ ...p, ms: p.ms + 100_000 }));
    const s = readPcap(pcapFile([...a, ...b]));
    expect(s).toHaveLength(2);
    expect(summary(s[1]!.frames)).toEqual(summary(expectedFrames()));
  });

  it('ultimo pacchetto troncato: tiene i frame precedenti', () => {
    const full = pcapFile(conversation());
    const cut = full.subarray(0, full.length - 7);
    const s = readPcap(cut);
    expect(summary(s[0]!.frames)).toEqual(summary(expectedFrames()).slice(0, 3));
    // anche pcapng
    const ng = pcapngFile(conversation());
    const s2 = readPcap(ng.subarray(0, ng.length - 9));
    expect(summary(s2[0]!.frames)).toEqual(summary(expectedFrames()).slice(0, 3));
  });

  it('input vuoto, corto o spazzatura: S7Error PROTOCOL', () => {
    for (const bad of [
      new Uint8Array(0),
      Uint8Array.from([1, 2, 3]),
      new Uint8Array(100),
      new TextEncoder().encode('questo non e una cattura di rete, nemmeno per scherzo'),
    ]) {
      expect(() => readPcap(bad)).toThrow(S7Error);
      try {
        readPcap(bad);
      } catch (e) {
        expect((e as S7Error).code).toBe('PROTOCOL');
      }
    }
  });

  it('byte casuali o pcap troncati dappertutto: S7Error PROTOCOL oppure un risultato, mai altro', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 8;
    };
    const inputs: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) {
      const n = rnd() % 200;
      const b = new Uint8Array(Math.max(n, 12));
      for (let j = 0; j < n; j++) b[j] = rnd() & 0xff;
      // metà con una testa pcap/pcapng valida, il resto casuale
      if (i % 3 === 1) b.set([0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0], 0);
      if (i % 3 === 2) b.set([0x0a, 0x0d, 0x0d, 0x0a, 0x1c, 0, 0, 0, 0x4d, 0x3c, 0x2b, 0x1a], 0);
      inputs.push(b);
    }
    for (const full of [pcapFile(conversation()), pcapngFile(conversation())]) {
      for (let n = 0; n < full.length; n += 3) inputs.push(full.subarray(0, n));
      for (let i = 0; i < 200; i++) {
        const c = full.slice();
        c[rnd() % c.length] = rnd() & 0xff;
        c[rnd() % c.length] = rnd() & 0xff;
        inputs.push(c);
      }
    }
    for (const input of inputs) {
      try {
        readPcap(input);
      } catch (e) {
        expect(e).toBeInstanceOf(S7Error);
        expect((e as S7Error).code).toBe('PROTOCOL');
      }
    }
  });
});

describe('readPcap: snap7.pcap (cisagov)', () => {
  it('un flusso sulla porta 102, frame ricomposti, dal setup (la cattura inizia a connessione aperta)', () => {
    const streams = readPcap(readFileSync(join(CISAGOV_DIR, 'snap7.pcap')));
    expect(streams).toHaveLength(1);
    const f = streams[0]!.frames;
    expect(streams[0]!.server.endsWith(':102')).toBe(true);
    expect(f).toHaveLength(64);
    // snap7.pcap non ha l'handshake TCP né il CR/CC: il primo frame è il setup communication
    expect(f[0]!.dir).toBe('tx');
    expect(f[0]!.t).toBe(0);
    expect(dissect(f[0]!.bytes).kind).toBe('setup');
    expect(f[1]!.dir).toBe('rx');
    expect(dissect(f[1]!.bytes).kind).toBe('setup');
    for (const x of f) expect(decodeCotp(x.bytes).type).toBe('DT');
    for (let i = 1; i < f.length; i++) expect(f[i]!.t).toBeGreaterThanOrEqual(f[i - 1]!.t);
  });

  it('s7ident.pcap si legge senza errori', () => {
    const streams = readPcap(readFileSync(join(CISAGOV_DIR, 's7ident.pcap')));
    expect(streams.length).toBeGreaterThan(0);
    expect(streams[0]!.frames.length).toBeGreaterThan(2);
  });
});

describe('registro delle catture (JSONL)', () => {
  const frames: CapturedFrame[] = [
    { t: 0, dir: 'tx', bytes: fromHex('11e0000000010000') },
    { t: 12.5, dir: 'rx', bytes: fromHex('02f080') },
    { t: 40, dir: 'tx', bytes: new Uint8Array(0) },
  ];

  it('una riga per frame, LF, formato { t, dir, hex }', () => {
    const text = framesToJsonl(frames);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ t: 0, dir: 'tx', hex: '11e0000000010000' });
    expect(Object.keys(JSON.parse(lines[1]!))).toEqual(['t', 'dir', 'hex']);
    expect(framesToJsonl([])).toBe('');
  });

  it('andata e ritorno identici; righe vuote ignorate; CRLF tollerato', () => {
    const text = framesToJsonl(frames);
    const back = jsonlToFrames(text);
    expect(back).toEqual(frames);
    expect(jsonlToFrames('\n\n' + text.replace(/\n/g, '\n\n') + '  \n')).toEqual(frames);
    expect(jsonlToFrames(text.replace(/\n/g, '\r\n'))).toEqual(frames);
    expect(jsonlToFrames('')).toEqual([]);
  });

  it('riga errata: PROTOCOL con il numero di riga', () => {
    const good = '{"t":0,"dir":"tx","hex":"00"}';
    const cases = [
      'non json',
      '{"t":0,"dir":"su","hex":"00"}',
      '{"t":-1,"dir":"tx","hex":"00"}',
      '{"t":"0","dir":"tx","hex":"00"}',
      '{"t":0,"dir":"tx","hex":"0"}',
      '{"t":0,"dir":"tx","hex":"zz"}',
      '{"t":0,"dir":"tx"}',
      '[1,2]',
      'null',
    ];
    for (const c of cases) {
      const text = `${good}\n\n${c}\n`;
      let err: unknown;
      try {
        jsonlToFrames(text);
      } catch (e) {
        err = e;
      }
      expect(err, c).toBeInstanceOf(S7Error);
      expect((err as S7Error).code).toBe('PROTOCOL');
      expect((err as S7Error).message).toContain('riga 3');
    }
  });

  it('il registratore tiene i frame in memoria e li restituisce come copie', () => {
    let clock = 1000;
    const rec = createRecorder(() => clock);
    const a = fromHex('aabb');
    rec.record('tx', a);
    clock = 1250;
    rec.record('rx', fromHex('cc'));
    a[0] = 0; // il registratore ha copiato i byte
    const got = rec.frames();
    expect(got.map((f) => [f.t, f.dir, hex(f.bytes)])).toEqual([
      [0, 'tx', 'aabb'],
      [250, 'rx', 'cc'],
    ]);
    got[0]!.bytes[0] = 0x11; // modificare la copia non tocca il registro
    got.pop();
    expect(rec.frames()).toHaveLength(2);
    expect(hex(rec.frames()[0]!.bytes)).toBe('aabb');
    expect(createRecorder().frames()).toEqual([]);
  });
});

describe('dissect', () => {
  const s7 = (rosctr: 1 | 3, param: string, data = '', ec = 0): Uint8Array =>
    encodeCotp({
      type: 'DT',
      eot: true,
      data: encodeS7({
        rosctr,
        pduRef: 1,
        errorClass: ec,
        errorCode: 0,
        param: fromHex(param),
        data: fromHex(data),
      }),
    });

  it('classifica COTP e S7', () => {
    expect(dissect(CR).kind).toBe('connect');
    expect(dissect(CC).kind).toBe('connect');
    expect(dissect(encodeCotp({ type: 'DR', dstRef: 1, srcRef: 2, reason: 0 })).kind).toBe(
      'connect',
    );
    const setup = dissect(s7(1, hex(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }))));
    expect(setup.kind).toBe('setup');
    expect(setup.s7?.rosctr).toBe(1);
    expect(dissect(s7(1, '0401120a10020001000081000000' + '00', '')).kind).toBe('readVar');
    expect(dissect(s7(1, '1d0000000000' + '00' + '09' + '5f30423030303031' + '41')).kind).toBe(
      'upload',
    );
    expect(dissect(s7(1, '05010000')).kind).toBe('other'); // write var: mai 'readVar'
    expect(dissect(s7(1, '29000000000009505f50524f4752414d')).kind).toBe('other'); // PLC stop
  });

  it('userdata: szl, blockList, blockInfo, clock; set clock resta other', () => {
    const ud = (group: number, sub: number, type = 4): Uint8Array => s7Userdata(group, sub, type);
    expect(dissect(ud(4, 1)).kind).toBe('szl');
    expect(dissect(ud(3, 1)).kind).toBe('blockList');
    expect(dissect(ud(3, 2)).kind).toBe('blockList');
    expect(dissect(ud(3, 3)).kind).toBe('blockInfo');
    expect(dissect(ud(7, 1)).kind).toBe('clock');
    expect(dissect(ud(7, 3)).kind).toBe('clock');
    expect(dissect(ud(7, 2)).kind).toBe('other');
    expect(dissect(ud(1, 1)).kind).toBe('other');
  });

  it('malformato: kind malformed con il messaggio, senza lanciare', () => {
    const cases = [
      new Uint8Array(0),
      Uint8Array.from([0x02]),
      Uint8Array.from([0x02, 0xf0, 0x80, 0x99, 0x00]), // DT con S7 non valido
      Uint8Array.from([0x02, 0xf0, 0x80, 0x32, 0x01]), // S7 troncato
      Uint8Array.from([0xff, 0xff, 0xff]),
    ];
    for (const c of cases) {
      const d = dissect(c);
      expect(d.kind).toBe('malformed');
      expect(typeof d.error).toBe('string');
      expect(d.error!.length).toBeGreaterThan(0);
    }
  });

  it('DT non finale e ER sono other, mai un errore', () => {
    expect(dissect(encodeCotp({ type: 'DT', eot: false, data: fromHex('3201') })).kind).toBe(
      'other',
    );
    expect(dissect(encodeCotp({ type: 'ER', dstRef: 1, cause: 1 })).kind).toBe('other');
  });
});

function s7Userdata(group: number, sub: number, type: number): Uint8Array {
  const param = Uint8Array.from([0, 1, 0x12, 4, 0x11, (type << 4) | group, sub, 0]);
  const data = fromHex('0a000000');
  return encodeCotp({
    type: 'DT',
    eot: true,
    data: encodeS7({ rosctr: 7, pduRef: 1, errorClass: 0, errorCode: 0, param, data }),
  });
}

// ---- buchi nella cattura: nessun falso frame --------------------------------------------------

/** Una connessione (con SYN) fatta di segmenti dati; `drop` dice quali segmenti mancano. */
function gappy(segments: Uint8Array[], drop: Set<number>): Uint8Array {
  const segs: Seg[] = [
    { from: 'c', seq: 1000, flags: 0x02, ms: 0 },
    { from: 's', seq: 5000, flags: 0x12, ms: 1 },
  ];
  let seq = 1001;
  segments.forEach((payload, i) => {
    if (!drop.has(i)) segs.push({ from: 'c', seq, payload, ms: 10 + i });
    seq += payload.length;
  });
  return pcapFile(segs.map((x) => ({ ms: 1000 + (x.ms ?? 0), data: ether(ipTcp(x)) })));
}

const tpktDt = (n: number, fill: number): Uint8Array =>
  tpktOf(dt('32010000000100080000f0' + fill.toString(16).padStart(2, '0').repeat(n)));

describe('readPcap: buchi nella cattura', () => {
  it('dopo un buco, un segmento che inizia con 03 xx ma non è un TPKT non dà frame falsi', () => {
    const A = tpktDt(20, 0xa1);
    const B = tpktDt(30, 0xb2);
    // 03 00 00 20 05 ...: versione e lunghezza plausibili, ma LI 5 non lo è
    const junk = Uint8Array.from([3, 0, 0, 0x20, 5, 0xf0, 0x80, ...new Array<number>(40).fill(7)]);
    const junk2 = Uint8Array.from([3, 0x11, 0x22, 0x33, ...new Array<number>(40).fill(9)]);
    const hole = new Uint8Array(10);
    const s = readPcap(gappy([A, hole, junk, junk2, B], new Set([1])));
    expect(s).toHaveLength(1);
    expect(summary(s[0]!.frames)).toEqual([`tx:${hex(A.subarray(4))}`, `tx:${hex(B.subarray(4))}`]);
    expect(s[0]!.droppedBytes).toBeGreaterThanOrEqual(junk.length + junk2.length);
  });

  it('buco a metà segmento: il TPKT che segue dentro lo stesso segmento è recuperato', () => {
    const A = tpktDt(20, 0xa1);
    const B = tpktDt(30, 0xb2);
    const C = tpktDt(5, 0xc3);
    const tail = new Uint8Array(12).fill(0x55); // coda di un frame di cui manca l'inizio
    const joined = Uint8Array.from([...tail, ...B, ...C]);
    const s = readPcap(gappy([A, new Uint8Array(8), joined], new Set([1])));
    expect(summary(s[0]!.frames)).toEqual([
      `tx:${hex(A.subarray(4))}`,
      `tx:${hex(B.subarray(4))}`,
      `tx:${hex(C.subarray(4))}`,
    ]);
    expect(s[0]!.droppedBytes).toBe(tail.length);
  });

  it('senza buchi droppedBytes vale 0', () => {
    const s = readPcap(pcapFile(conversation()));
    expect(s[0]!.droppedBytes).toBe(0);
  });

  it('buchi in posizioni casuali tra 200 frame noti: ogni frame restituito è uno dei noti', () => {
    for (let seed = 1; seed <= 25; seed++) {
      let x = seed * 7919;
      const rnd = (n: number): number => {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        return (x >>> 8) % n;
      };
      const known: Uint8Array[] = [];
      for (let i = 0; i < 200; i++) {
        const body = new Uint8Array(3 + rnd(300));
        for (let j = 0; j < body.length; j++) body[j] = rnd(256);
        known.push(tpktOf(encodeCotp({ type: 'DT', eot: true, data: body })));
      }
      const all = Uint8Array.from(known.flatMap((f) => [...f]));
      const segments: Uint8Array[] = [];
      for (let o = 0; o < all.length;) {
        const n = Math.min(1 + rnd(400), all.length - o);
        segments.push(all.subarray(o, o + n));
        o += n;
      }
      const drop = new Set<number>();
      segments.forEach((_s, i) => {
        if (rnd(100) < 5) drop.add(i);
      });
      const set = new Set(known.map((f) => hex(f.subarray(4))));
      const s = readPcap(gappy(segments, drop));
      const got = s.flatMap((c) => c.frames);
      for (const f of got) expect(set.has(hex(f.bytes)), `seed ${seed}`).toBe(true);
      expect(got.length, `seed ${seed}`).toBeGreaterThan(50);
    }
  });

  it('Simple Packet pcapng troppo corto: PROTOCOL, mai una lunghezza negativa', () => {
    const ok = pcapngFile([{ ms: 0, data: new Uint8Array(4), simple: true }]);
    // sostituisce l'ultimo blocco con uno SPB lungo 12 byte (senza dati né lunghezza originale)
    const le = new DataView(new ArrayBuffer(12));
    le.setUint32(0, 3, true);
    le.setUint32(4, 12, true);
    le.setUint32(8, 12, true);
    const head = ok.subarray(0, ok.length - 20);
    const bad = Uint8Array.from([...head, ...new Uint8Array(le.buffer)]);
    expect(() => readPcap(bad)).toThrow(S7Error);
  });
});
