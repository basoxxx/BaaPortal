import { describe, expect, it } from 'vitest';
import {
  MpiFrameDecoder,
  encodeMpiFrame,
  fromHex,
  hex,
  listMpiNodes,
  memoryTransportPair,
  mpiAdapterLink,
  type MpiOptions,
  type PduLink,
  type Transport,
} from '../src';

const BASE: MpiOptions = {
  localAddress: 0,
  cpuAddress: 2,
  highestAddress: 31,
  busSpeed: '187.5k',
  variant: 'v1',
};

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

type Reply = (p: Uint8Array) => (Uint8Array | string)[] | undefined;

/**
 * Lato adattatore minimo: risponde DLE a STX e ai frame, manda le risposte di `reply` con
 * STX → DLE → frame → DLE. `rx` sono i payload arrivati dal PC, nell'ordine.
 */
function scripted(end: Transport, reply: Reply) {
  const rx: Uint8Array[] = [];
  const dec = new MpiFrameDecoder();
  const out: Uint8Array[] = [];
  let state: 'idle' | 'rx' | 'tx1' | 'tx2' = 'idle';
  let closed = false;
  const put = (b: number[] | Uint8Array): void => end.send(Uint8Array.from(b));
  const kick = (): void => {
    if (state !== 'idle' || out.length === 0) return;
    state = 'tx1';
    put([0x02]);
  };
  end.onClose(() => (closed = true));
  end.onData((chunk) => {
    for (const it of dec.push(chunk)) {
      if (it === 'STX') {
        // collisione: vince l'adattatore, lo STX del PC si ignora
        if (state === 'idle') {
          state = 'rx';
          put([0x10]);
        }
      } else if (it === 'DLE') {
        if (state === 'tx1') {
          state = 'tx2';
          put(encodeMpiFrame(out[0]!));
        } else if (state === 'tx2') {
          out.shift();
          state = 'idle';
          kick();
        }
      } else if (state === 'rx') {
        rx.push(it);
        put([0x10]);
        state = 'idle';
        for (const r of reply(it) ?? []) out.push(typeof r === 'string' ? fromHex(r) : r);
        kick();
      }
    }
  });
  return {
    rx,
    get closed() {
      return closed;
    },
    push(p: Uint8Array) {
      out.push(p);
      kick();
    },
  };
}

const VERSION = '01 0D 20 56 30 30 2E 38 33'; // 01 xx 20 "V00.83"
const CONFIG_OK = '01 03 20 56 30 30 2E 38 33';

function partners(active: number[]): Uint8Array {
  const p = new Uint8Array(133).fill(0x10);
  p.set([0x01, 0x07, 0x20, 0, 0, 0]);
  for (const a of active) p[6 + a] = 0x30;
  return p;
}

const hdrV1 = (cn2: number) => [0x04, 0x82, 0x80, 0x0c, 0x14, cn2];

/** Un adattatore v1 con una CPU all'indirizzo 2 che rimanda ogni PDU con il byte 1 = 3. */
function v1Adapter(o: { cn2?: number; cpu?: boolean; active?: number[] } = {}): Reply {
  const cn2 = o.cn2 ?? 0x10;
  let rnr = 0;
  return (p) => {
    const k = hex(p);
    if (k === '010d02') return [VERSION];
    if (k.startsWith('010302')) return [CONFIG_OK];
    if (k === '010702') return [partners(o.active ?? [0, 2])];
    if (k === '010402') return ['01 04 20'];
    if (p[0] === 0x04 && p[3] === 0x0d) {
      if (o.cpu === false) return undefined;
      return [Uint8Array.of(...hdrV1(cn2), ...fromHex('D0 04 00 80 00 02 00 02 01 00 01 00'))];
    }
    if (p[0] === 0x04 && p[6] === 0x05) return [Uint8Array.of(...hdrV1(cn2), 0x05, 0x01)];
    if (p[0] === 0x04 && p[6] === 0x80) return [Uint8Array.of(...hdrV1(cn2), 0xc0)];
    if (p[0] === 0x04 && p[6] === 0xf1) {
      const pdu = p.slice(8);
      pdu[1] = 3;
      rnr = rnr === 0xff ? 1 : rnr + 1;
      return [
        Uint8Array.of(...hdrV1(cn2), 0xb0, 0x01, p[7]!),
        Uint8Array.of(...hdrV1(cn2), 0xf1, rnr, ...pdu),
      ];
    }
    return undefined; // B0 del PC e il resto: niente
  };
}

async function open(reply: Reply, o: Partial<MpiOptions> = {}, timeoutMs = 300) {
  const [a, b] = memoryTransportPair();
  const ad = scripted(b, reply);
  const link = await mpiAdapterLink(async () => a, { ...BASE, ...o })({ timeoutMs });
  return { ad, link };
}

function nextPdu(link: PduLink): { got: Uint8Array[]; one(): Promise<Uint8Array> } {
  const got: Uint8Array[] = [];
  let waiter: ((p: Uint8Array) => void) | undefined;
  link.onPdu((p) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(p);
    } else got.push(p);
  });
  return {
    got,
    one: () =>
      got.length ? Promise.resolve(got.shift()!) : new Promise<Uint8Array>((r) => (waiter = r)),
  };
}

describe('PC Adapter MPI: inizializzazione e connessione', () => {
  it('v1: versione, configurazione, connessione alla CPU 2 con i byte degli esempi', async () => {
    const { ad, link } = await open(v1Adapter());
    expect(ad.rx.map(hex)).toEqual([
      '010d02',
      '01030227009f013c009001140000050200' + '1f0201010380',
      '0482800d0014e00400800002000201000100',
      '0482800c101405' + '01',
    ]);
    await link.close();
  });

  it('auto: v1 senza risposta, poi v2 riuscito; le PDU hanno l’intestazione v2', async () => {
    const hdr = [0x00, 0x0c, 0x03, 0x07];
    const reply: Reply = (p) => {
      const k = hex(p);
      if (k.startsWith('01030217')) return [CONFIG_OK];
      if (p[0] === 0x00 && p[1] === 0x0d && p[17] === 2) {
        return [
          Uint8Array.of(...hdr, ...fromHex('D0 04 00 80 01 06 00 02 00 01 02 02 01 00 01 00')),
        ];
      }
      if (p[0] === 0x00 && p[4] === 0x05) return [Uint8Array.of(...hdr, 0x05, 0x01)];
      if (p[0] === 0x00 && p[4] === 0xf1) {
        return [
          Uint8Array.of(...hdr, 0xb0, 0x01, p[5]!),
          Uint8Array.of(...hdr, 0xf1, 0, ...p.slice(6)),
        ];
      }
      return undefined; // un adattatore v2 tace alla richiesta di versione v1
    };
    const { ad, link } = await open(reply, { variant: 'auto', highestAddress: 15 }, 40);
    expect((link as { variant?: string }).variant).toBe('v2');
    const v2 = ad.rx.findIndex((p) => hex(p).startsWith('01030217'));
    expect(hex(ad.rx[v2]!)).toBe('01030217009f013c009001140000050200' + '0f0501010380');
    expect(hex(ad.rx[v2 + 1]!)).toBe('000d0003e00400800002010601000001020201' + '00');
    expect(hex(ad.rx[v2 + 2]!)).toBe('000c0703' + '0501');
    const q = nextPdu(link);
    link.sendPdu(fromHex('32 01 00 00 00 01 00 00 00 00'));
    expect(hex(await q.one())).toBe('32010000000100000000');
    await settle();
    expect(hex(ad.rx.at(-2)!)).toBe('000c0703f100' + '32010000000100000000');
    expect(hex(ad.rx.at(-1)!)).toBe('000c0703b00100');
    await link.close();
  });

  it('nessuna risposta: MPI_NO_ADAPTER dopo il timeout, porta chiusa', async () => {
    const [a, b] = memoryTransportPair();
    let closed = false;
    b.onData(() => undefined);
    b.onClose(() => (closed = true));
    const t0 = Date.now();
    await expect(
      mpiAdapterLink(async () => a, { ...BASE, variant: 'auto' })({ timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: 'MPI_NO_ADAPTER',
      message: expect.stringContaining(
        'Adattatore MPI non risponde: controllare porta, velocità e cavo',
      ),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    await settle();
    expect(closed).toBe(true);
  });

  it('CPU assente all’indirizzo: MPI_NO_CPU con i nodi visti', async () => {
    const [a, b] = memoryTransportPair();
    scripted(b, v1Adapter({ cpu: false, active: [0, 3] }));
    await expect(mpiAdapterLink(async () => a, BASE)({ timeoutMs: 40 })).rejects.toMatchObject({
      code: 'MPI_NO_CPU',
      message: expect.stringContaining('nodi sul bus: 0, 3'),
    });
  });

  it('adattatore E=03xx: passo in più 01 0C 02 dopo la configurazione', async () => {
    const base = v1Adapter();
    const { ad, link } = await open((p) => {
      const k = hex(p);
      if (k.startsWith('010302')) return ['01 03 20 45 3D 30 33 33 30']; // "E=0330"
      if (k === '010c02') return ['01 0C 20'];
      return base(p);
    });
    expect(hex(ad.rx[2]!)).toBe('010c02');
    await link.close();
  });

  it('listMpiNodes: nodi attivi, poi chiusura dell’adattatore', async () => {
    const [a, b] = memoryTransportPair();
    const ad = scripted(b, v1Adapter({ active: [0, 2, 16] }));
    const o = { localAddress: 0, highestAddress: 31, busSpeed: '187.5k', variant: 'v1' } as const;
    expect(await listMpiNodes(async () => a, { ...o, timeoutMs: 300 })).toEqual([0, 2, 16]);
    expect(ad.rx.map(hex).slice(-2)).toEqual(['010702', '010402']);
    await settle();
    expect(ad.closed).toBe(true);
  });

  it('opzioni fuori campo: RangeError prima di aprire la porta', () => {
    let opened = false;
    const t = async (): Promise<Transport> => {
      opened = true;
      return memoryTransportPair()[0];
    };
    expect(() => mpiAdapterLink(t, { ...BASE, cpuAddress: 127 })).toThrow(RangeError);
    expect(() => mpiAdapterLink(t, { ...BASE, busSpeed: '9.6k' as never })).toThrow(RangeError);
    expect(opened).toBe(false);
  });
});

describe('PC Adapter MPI: PDU, ack e chiusura', () => {
  it('una PDU inviata e una ricevuta, con l’ack giusto (cn2 = 0x10 raddoppiato sul filo)', async () => {
    const { ad, link } = await open(v1Adapter());
    const q = nextPdu(link);
    link.sendPdu(fromHex('32 01 00 00 00 05 00 00 00 00'));
    expect(hex(await q.one())).toBe('32030000000500000000');
    await settle();
    expect(ad.rx.map(hex).slice(-2)).toEqual([
      '0482800c1014f100' + '32010000000500000000',
      '0482800c1014b00101',
    ]);
    await link.close();
  });

  it('i numeri di messaggio vanno 00..FF e poi ricominciano da 01, senza lo 0', async () => {
    const { ad, link } = await open(v1Adapter());
    const q = nextPdu(link);
    for (let i = 0; i < 258; i++) {
      link.sendPdu(Uint8Array.of(0x32, 1, 0, 0, i >> 8, i & 0xff, 0, 0, 0, 0));
      await q.one();
    }
    await settle();
    const ours = ad.rx.filter((p) => p[6] === 0xf1).map((p) => p[7]);
    expect(ours.slice(0, 2)).toEqual([0, 1]);
    expect(ours.slice(254, 258)).toEqual([0xfe, 0xff, 1, 2]);
    const acks = ad.rx.filter((p) => p[6] === 0xb0).map((p) => p[8]);
    expect(acks.slice(253, 258)).toEqual([0xfe, 0xff, 1, 2, 3]);
    await link.close();
  });

  it('PDU arrivate prima di onPdu si consegnano alla registrazione', async () => {
    const { ad, link } = await open(v1Adapter());
    ad.push(Uint8Array.of(...hdrV1(0x10), 0xf1, 0x01, ...fromHex('32 07 00 00 00 09 00 00 00 00')));
    await settle();
    await settle();
    const got: string[] = [];
    link.onPdu((p) => got.push(hex(p)));
    expect(got).toEqual(['32070000000900000000']);
    await link.close();
  });

  it('chiusura: disconnessione dalla CPU, poi 01 04 02, poi la porta', async () => {
    const { ad, link } = await open(v1Adapter());
    await link.close();
    expect(ad.rx.map(hex).slice(-2)).toEqual(['0482800c101480', '010402']);
    await settle();
    expect(ad.closed).toBe(true);
  });

  it('porta che si chiude: onClose con errore, sendPdu rifiutato', async () => {
    const [a, b] = memoryTransportPair();
    scripted(b, v1Adapter());
    const link = await mpiAdapterLink(async () => a, BASE)({ timeoutMs: 300 });
    const errs: (Error | undefined)[] = [];
    link.onClose((e) => errs.push(e));
    b.close();
    await settle();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ name: 'S7Error' });
    expect(() => link.sendPdu(Uint8Array.of(0x32))).toThrow();
    await expect(link.close()).resolves.toBeUndefined();
  });

  it('adattatore che tace dopo la connessione: MPI_NO_ADAPTER, niente attese appese', async () => {
    let mute = false;
    const base = v1Adapter();
    const [a, b] = memoryTransportPair();
    // come `scripted`, ma da `mute` in poi l'adattatore non risponde più a nulla
    const inner = scripted(
      {
        send: (x) => {
          if (!mute) b.send(x);
        },
        onData: (cb) => b.onData(cb),
        onClose: (cb) => b.onClose(cb),
        close: () => b.close(),
      },
      base,
    );
    const link = await mpiAdapterLink(async () => a, BASE)({ timeoutMs: 20 });
    expect(inner.rx.length).toBeGreaterThan(0);
    const errs: (Error | undefined)[] = [];
    link.onClose((e) => errs.push(e));
    mute = true;
    link.sendPdu(fromHex('32 01 00 00 00 05 00 00 00 00'));
    await new Promise((r) => setTimeout(r, 200));
    expect(errs).toEqual([expect.objectContaining({ code: 'MPI_NO_ADAPTER' })]);
    await expect(link.close()).resolves.toBeUndefined();
  });
});
