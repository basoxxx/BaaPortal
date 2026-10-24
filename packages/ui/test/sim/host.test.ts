import { blockTypeCode } from '@baaportal/s7comm';
import { describe, expect, it } from 'vitest';
import { SimHost } from '../../src/sim/host';
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
  return { host, advance, notices, of, now: () => t };
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
});
