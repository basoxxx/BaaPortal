import { blockTypeCode } from '@baaportal/s7comm';
import { describe, expect, it } from 'vitest';
import { MAX_WATCH_ITEMS, SimHost } from '../../src/sim/host';
import type { SimNotice } from '../../src/sim/protocol';
import { PROPS, ob1 } from './simFixtures';

/**
 * Orologio e pianificatore finti: `advance` esegue i lavori scaduti in ordine. Ogni lettura
 * dell'orologio costa 0,25 ms, così le fette di esecuzione terminano.
 */
function fake() {
  let t = 1000;
  let seq = 0;
  const jobs: { at: number; seq: number; fn: () => void }[] = [];
  const notices: SimNotice[] = [];
  const host = new SimHost({
    post: (n) => notices.push(n),
    now: () => (t += 0.25),
    schedule: (fn, ms) => {
      const job = { at: t + ms, seq: seq++, fn };
      jobs.push(job);
      return () => {
        const i = jobs.indexOf(job);
        if (i >= 0) jobs.splice(i, 1);
      };
    },
  });
  /** Avanza di `ms` in passi da 1 ms, eseguendo i lavori scaduti. */
  async function advance(ms: number): Promise<void> {
    const end = t + ms;
    for (;;) {
      jobs.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = jobs[0];
      if (!next || next.at > end) break;
      jobs.shift();
      t = Math.max(t, next.at);
      next.fn();
      await Promise.resolve();
    }
    t = Math.max(t, end);
  }
  const of = <K extends SimNotice['kind']>(k: K) =>
    notices.filter((n): n is Extract<SimNotice, { kind: K }> => n.kind === k);
  return {
    host,
    advance,
    notices,
    of,
    pending: () => jobs.length,
    now: () => t,
    pending: () => jobs.length,
  };
}

const start = (h: SimHost) => h.handle({ op: 'start', cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });

describe('SimHost', () => {
  it('start, download di OB1, RUN, cicli, status con modo RUN', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['\tA I 0.0;\n\t= Q 4.0;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(500);
    const st = f.of('status');
    expect(st.length).toBeGreaterThan(0);
    const last = st[st.length - 1]!;
    expect(last.mode).toBe('RUN');
    expect(last.stats.cycles).toBeGreaterThan(0);
    await f.host.handle({ op: 'stop' });
  });

  it('setInputs → uscite al ciclo dopo', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['\tA I 0.0;\n\t= Q 4.0;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(300);
    expect(f.of('status').at(-1)!.outputs[4]).toBe(0);
    await f.host.handle({ op: 'setInputs', byte: 0, bytes: Uint8Array.of(1) });
    await f.advance(300);
    const last = f.of('status').at(-1)!;
    expect(last.inputs[0]).toBe(1);
    expect(last.outputs[4]).toBe(1);
    await f.host.handle({ op: 'stop' });
  });

  it("ciclo infinito → STOP con TEMPO_CICLO_SUPERATO, l'ospite resta reattivo", async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['M1:\tNOP 0;\n\tJU M1;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(400);
    const last = f.of('status').at(-1)!;
    expect(last.mode).toBe('STOP');
    expect(last.diagnostics.some((d) => d.code === 'TEMPO_CICLO_SUPERATO')).toBe(true);
    // reattivo: risponde ancora
    await expect(f.host.handle({ op: 'mres' })).resolves.toBeUndefined();
    await f.host.handle({ op: 'stop' });
  });

  it('monitor e watch limitati a una notifica ogni 200 ms', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['\tL 7;\n\tT MB 0;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.host.handle({ op: 'monitor', block: { kind: 'OB', number: 1 } });
    await f.host.handle({ op: 'watch', items: [{ area: 'M', byte: 0, size: 'B' }] });
    await f.advance(1000);
    const w = f.of('watch');
    const mo = f.of('monitor');
    expect(w.length).toBeGreaterThanOrEqual(4);
    expect(w.length).toBeLessThanOrEqual(6);
    expect(mo.length).toBeGreaterThanOrEqual(4);
    expect(mo.length).toBeLessThanOrEqual(6);
    expect(mo.at(-1)!.steps.length).toBeGreaterThan(0);
    const v = w.at(-1)!.values[0]!;
    expect('bytes' in v && v.bytes[0]).toBe(7);
    // senza richieste, niente notifiche
    await f.host.handle({ op: 'watch', items: [] });
    await f.host.handle({ op: 'monitor' });
    const n = f.notices.filter((x) => x.kind !== 'status').length;
    await f.advance(1000);
    expect(f.notices.filter((x) => x.kind !== 'status').length).toBe(n);
    await f.host.handle({ op: 'stop' });
  });

  it('watch: operandi fuori area danno un errore per elemento, gli altri valgono', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({
      op: 'watch',
      items: [
        { area: 'M', byte: 99999, size: 'W' },
        { area: 'DB', db: 5, byte: 0, size: 'B' },
        { area: 'M', byte: 0, bit: 0, size: 'X' },
      ],
    });
    await f.advance(250);
    const v = f.of('watch').at(-1)!.values;
    expect('error' in v[0]!).toBe(true);
    expect('error' in v[1]!).toBe(true);
    expect('bytes' in v[2]!).toBe(true);
    await f.host.handle({ op: 'stop' });
  });

  it('watch e write: troppe voci sono rifiutate; la notifica porta solo le voci richieste', async () => {
    const f = fake();
    await start(f.host);
    const item = { area: 'M' as const, byte: 0, size: 'D' as const };
    const many = Array.from({ length: MAX_WATCH_ITEMS + 1 }, () => item);
    await expect(f.host.handle({ op: 'watch', items: many })).rejects.toThrow(/troppe voci/);
    await expect(
      f.host.handle({
        op: 'write',
        items: many.map((x) => ({ ...x, data: Uint8Array.of(0, 0, 0, 0) })),
      }),
    ).rejects.toThrow(/troppe voci/);
    await f.host.handle({ op: 'watch', items: [item, item] });
    await f.advance(250);
    const v = f.of('watch').at(-1)!.values;
    expect(v).toHaveLength(2);
    expect(v.every((x) => 'bytes' in x && x.bytes.length === 4)).toBe(true);
    await f.host.handle({ op: 'stop' });
  });

  it('write su PQ in RUN: dura oltre il ciclo (aggiorna anche Q); PI resta; fuori da Q basta physOut', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['\tNOP 0;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(100);
    const r = await f.host.handle({
      op: 'write',
      items: [
        { area: 'PQ', byte: 4, size: 'W', data: Uint8Array.of(0xff, 0xff) },
        { area: 'PQ', byte: 6, bit: 3, size: 'X', data: Uint8Array.of(1) },
        { area: 'PI', byte: 2, size: 'B', data: Uint8Array.of(0x5a) },
      ],
    });
    expect(r).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    await f.advance(500); // diversi cicli
    const read = async (item: object) => {
      await f.host.handle({ op: 'watch', items: [item as never] });
      await f.advance(250);
      return f.of('watch').at(-1)!.values[0]!;
    };
    expect(await read({ area: 'PQ', byte: 4, size: 'W' })).toEqual({
      bytes: Uint8Array.of(255, 255),
    });
    expect(await read({ area: 'Q', byte: 4, size: 'W' })).toEqual({
      bytes: Uint8Array.of(255, 255),
    });
    expect(await read({ area: 'PQ', byte: 6, bit: 3, size: 'X' })).toEqual({
      bytes: Uint8Array.of(1),
    });
    expect(await read({ area: 'PI', byte: 2, size: 'B' })).toEqual({ bytes: Uint8Array.of(0x5a) });
    await f.host.handle({ op: 'stop' });
  });

  it('write: scrive M e PQ, segnala per elemento gli errori', async () => {
    const f = fake();
    await start(f.host);
    const r = await f.host.handle({
      op: 'write',
      items: [
        { area: 'M', byte: 2, size: 'W', data: Uint8Array.of(0x12, 0x34) },
        { area: 'M', byte: 99999, size: 'B', data: Uint8Array.of(1) },
        { area: 'T', byte: 0, size: 'W', data: Uint8Array.of(0, 0) },
      ],
    });
    expect(r).toEqual([{ ok: true }, { error: expect.any(String) }, { error: expect.any(String) }]);
    await f.host.handle({ op: 'watch', items: [{ area: 'M', byte: 2, size: 'W' }] });
    await f.advance(250);
    const v = f.of('watch').at(-1)!.values[0]!;
    expect('bytes' in v && [...v.bytes]).toEqual([0x12, 0x34]);
    await f.host.handle({ op: 'stop' });
  });

  it('download di un file corrotto → errore con il blocco', async () => {
    const f = fake();
    await start(f.host);
    const good = ob1(['\tNOP 0;']);
    const bad = good.slice();
    bad[5] = blockTypeCode('SFC'); // ben formato per il protocollo, ma la CPU non lo carica
    await expect(f.host.handle({ op: 'download', files: [good, bad] })).rejects.toThrow(/SFC1/);
    await expect(
      f.host.handle({ op: 'download', files: [Uint8Array.of(1, 2, 3)] }),
    ).rejects.toThrow(/file 1/);
    await f.host.handle({ op: 'stop' });
  });

  it('richieste prima di start: errore; dopo stop: errore', async () => {
    const f = fake();
    await expect(f.host.handle({ op: 'mres' })).rejects.toThrow();
    await start(f.host);
    await f.host.handle({ op: 'stop' });
    await expect(f.host.handle({ op: 'mres' })).rejects.toThrow();
  });

  it('RUN ripetuti non raddoppiano la pianificazione', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['\tNOP 0;'])] });
    for (let i = 0; i < 3; i++) {
      await f.host.handle({ op: 'mode', to: 'RUN' });
      await f.host.handle({ op: 'mode', to: 'STOP' });
    }
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    expect(f.pending()).toBeLessThanOrEqual(2); // un timer di notifica e una fetta
    await f.host.handle({ op: 'stop' });
  });

  it('minCycleMs > 0 scandisce i cicli', async () => {
    const f = fake();
    await f.host.handle({
      op: 'start',
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: { ...PROPS, minCycleMs: 50 },
    });
    await f.host.handle({ op: 'download', files: [ob1(['\tNOP 0;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(1000);
    const cycles = f.of('status').at(-1)!.stats.cycles;
    expect(cycles).toBeGreaterThanOrEqual(15);
    expect(cycles).toBeLessThanOrEqual(21);
    await f.host.handle({ op: 'stop' });
  });

  it("con l'orologio fermo una fetta è limitata e cede", async () => {
    const jobs: { fn: () => void; ms: number }[] = [];
    let tickJob: (() => void) | undefined;
    const notices: SimNotice[] = [];
    const host = new SimHost({
      post: (n) => notices.push(n),
      now: () => 5000,
      schedule: (fn, ms) => {
        jobs.push({ fn, ms });
        if (ms === 200) tickJob = fn;
        return () => undefined;
      },
    });
    await start(host);
    await host.handle({ op: 'download', files: [ob1(['\tNOP 0;'])] });
    await host.handle({ op: 'mode', to: 'RUN' });
    jobs.length = 0;
    // la fetta già pianificata al RUN è stata annullata dal test: se ne pianifica una nuova
    await host.handle({ op: 'mode', to: 'STOP' });
    await host.handle({ op: 'mode', to: 'RUN' });
    const pump = jobs.filter((j) => j.ms === 0).at(-1)!;
    jobs.length = 0;
    pump.fn(); // deve tornare
    expect(jobs.map((j) => j.ms)).toEqual([0]); // ha ceduto, non gira all'infinito
    const st = (): SimNotice | undefined => notices.filter((n) => n.kind === 'status').at(-1);
    tickJob!(); // notifica di stato
    const s = st();
    expect(s && s.kind === 'status' && s.stats.cycles).toBe(5000);
    await host.handle({ op: 'stop' });
  });

  it('download in RUN: il blocco nuovo vale dai cicli successivi', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'download', files: [ob1(['\tL 1;\n\tT MB 0;'])] });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(300);
    await f.host.handle({ op: 'download', files: [ob1(['\tL 2;\n\tT MB 0;'])] });
    await f.host.handle({ op: 'watch', items: [{ area: 'M', byte: 0, size: 'B' }] });
    await f.advance(300);
    const v = f.of('watch').at(-1)!.values[0]!;
    expect('bytes' in v && v.bytes[0]).toBe(2);
    expect(f.of('status').at(-1)!.mode).toBe('RUN');
    await f.host.handle({ op: 'stop' });
  });

  it('setInputs con byte non intero o fuori area è rifiutato', async () => {
    const f = fake();
    await start(f.host);
    await expect(
      f.host.handle({ op: 'setInputs', byte: 0.5, bytes: Uint8Array.of(1) }),
    ).rejects.toThrow();
    await expect(
      f.host.handle({ op: 'setInputs', byte: -1, bytes: Uint8Array.of(1) }),
    ).rejects.toThrow();
    await f.host.handle({ op: 'stop' });
  });

  it('interrupt con indirizzo del modulo: OB82 lo riceve nei dati di avvio; indirizzo non valido rifiutato', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({
      op: 'download',
      files: [ob1(['\tNOP 0;']), ob1(['\tL LW 6;\n\tT QW 0;'], 82)],
    });
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.advance(300);
    await f.host.handle({ op: 'interrupt', ob: 82, address: 0x0104 });
    await f.advance(300);
    const out = f.of('status').at(-1)!.outputs;
    expect([out[0], out[1]]).toEqual([0x01, 0x04]);
    for (const address of [-1, 1.5, 0x10000])
      await expect(f.host.handle({ op: 'interrupt', ob: 86, address })).rejects.toThrow();
    await f.host.handle({ op: 'stop' });
  });

  it('stop: ultimo status in STOP prima di spegnersi', async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'mode', to: 'RUN' });
    await f.host.handle({ op: 'stop' });
    expect(f.of('status').at(-1)!.mode).toBe('STOP');
  });

  it("un'eccezione in un timer è segnalata come errore fatale", async () => {
    const f = fake();
    await start(f.host);
    await f.host.handle({ op: 'watch', items: [{ area: 'M', byte: 0, size: 'B' }] });
    await f.host.handle({ op: 'monitor', block: { kind: 'OB', number: 1 } });
    // rompe il lettore dei valori
    Object.defineProperty(f.host, 'readOne', {
      value: () => {
        throw new Error('guasto');
      },
    });
    await f.advance(250);
    expect(f.of('error')[0]?.message).toBe('guasto');
    await expect(f.host.handle({ op: 'mres' })).rejects.toThrow();
  });
});
