import { describe, expect, it } from 'vitest';
import { S7Error, createRecorder, decodeCotp, decodeS7, type S7Client } from '@baaportal/s7comm';
import { FakeCpu, userdataFunction } from '../src';
import { sleep } from './helpers';
import { exerciseAll, rig, smallWorld, type Via } from './rig';

const VIAS: Via[] = ['memory', 'tcp'];

/** Aspetta che `cond` sia vera (le chiusure su TCP sono asincrone), fino a `ms`. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(2);
}

const errorOf = async (p: Promise<unknown>): Promise<S7Error> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof S7Error) return e;
    throw e;
  }
  throw new Error('attesa un S7Error, la promessa è riuscita');
};

describe('robustezza: risposte a pezzi', () => {
  for (const via of VIAS) {
    for (const chunkSize of [1, 7]) {
      it(
        `${via}: pezzi da ${chunkSize} byte, ogni metodo funziona`,
        { timeout: 30_000 },
        async () => {
          const cpu = new FakeCpu({ faults: { chunkSize } });
          smallWorld(cpu);
          const r = await rig(cpu, via);
          try {
            await exerciseAll(await r.connect({ proposedPdu: 480 }));
          } finally {
            await r.close();
          }
        },
      );
    }
  }
});

describe('robustezza: ritardo, silenzio e guasti', () => {
  for (const via of VIAS) {
    it(
      `${via}: ritardo oltre il timeout dà TIMEOUT entro 1,5 volte e chiude la connessione`,
      { timeout: 30_000 },
      async () => {
        const cpu = new FakeCpu();
        smallWorld(cpu);
        const r = await rig(cpu, via);
        try {
          const timeoutMs = 400;
          const cl = await r.connect({ timeoutMs });
          expect(await cl.readClock()).toBeDefined();
          cpu.config.faults.delayMs = 2500; // da qui ogni risposta arriva dopo il timeout
          const t0 = Date.now();
          const e = await errorOf(cl.readClock());
          const took = Date.now() - t0;
          expect(e.code).toBe('TIMEOUT');
          expect(took).toBeGreaterThanOrEqual(timeoutMs * 0.9);
          expect(took).toBeLessThan(timeoutMs * 1.5 + 250); // 250 ms di margine per i CI lenti
          // la connessione è chiusa: niente più richieste, e la CPU ha liberato la sessione
          expect((await errorOf(cl.readClock())).code).toBe('CLOSED');
          await until(() => cpu.connections === 0);
          expect(cpu.connections).toBe(0);
        } finally {
          await r.close();
        }
      },
    );

    it(
      `${via}: un CC ritardato oltre il timeout dà CONNECT_TIMEOUT`,
      { timeout: 30_000 },
      async () => {
        const cpu = new FakeCpu({ faults: { delayMs: 2500 } });
        const r = await rig(cpu, via);
        try {
          const t0 = Date.now();
          const e = await errorOf(r.connect({ timeoutMs: 300 }));
          expect(e.code).toBe('CONNECT_TIMEOUT');
          expect(Date.now() - t0).toBeLessThan(300 * 1.5 + 250);
        } finally {
          await r.close();
        }
        await until(() => cpu.connections === 0);
        expect(cpu.connections).toBe(0);
      },
    );

    it(
      `${via}: ignoreFunction sulla lettura variabili dà TIMEOUT, le altre funzioni no`,
      { timeout: 30_000 },
      async () => {
        const cpu = new FakeCpu({ faults: { ignoreFunction: 0x04 } });
        smallWorld(cpu);
        const r = await rig(cpu, via);
        try {
          const cl = await r.connect({ timeoutMs: 300 });
          expect((await cl.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
          const t0 = Date.now();
          const e = await errorOf(cl.readArea('M', 0, 10, 4));
          expect(e.code).toBe('TIMEOUT');
          expect(Date.now() - t0).toBeLessThan(300 * 1.5 + 250);
        } finally {
          await r.close();
        }
      },
    );

    it(
      `${via}: errorFor su una SZL dà CPU_ERROR con il codice giusto`,
      { timeout: 30_000 },
      async () => {
        for (const [errorClass, errorCode] of [
          [0xd4, 0x02],
          [0x81, 0x04],
          [0xd2, 0x41],
          [0x85, 0x00],
        ] as const) {
          const cpu = new FakeCpu({
            faults: { errorFor: { function: userdataFunction(4, 1), errorClass, errorCode } },
          });
          smallWorld(cpu);
          const r = await rig(cpu, via);
          try {
            const cl = await r.connect();
            for (const call of [
              () => cl.mode(),
              () => cl.identity(),
              () => cl.diagnosticBuffer(),
            ]) {
              const e = await errorOf(call());
              expect(e.code).toBe('CPU_ERROR');
              expect(e.detail).toMatchObject({ errorClass, errorCode });
            }
            // le altre funzioni non sono toccate
            expect(await cl.readArea('M', 0, 10, 2)).toHaveLength(2);
            expect((await cl.blockCounts()).DB).toBe(1);
          } finally {
            await r.close();
          }
        }
      },
    );

    it(
      `${via}: errorFor sulla lettura variabili dà CPU_ERROR nell'header`,
      { timeout: 30_000 },
      async () => {
        const cpu = new FakeCpu({
          faults: { errorFor: { function: 0x04, errorClass: 0x85, errorCode: 0x00 } },
        });
        smallWorld(cpu);
        const r = await rig(cpu, via);
        try {
          const cl = await r.connect();
          const e = await errorOf(cl.readArea('M', 0, 10, 2));
          expect(e.code).toBe('CPU_ERROR');
          expect(e.detail).toMatchObject({ errorClass: 0x85, errorCode: 0x00 });
          expect((await cl.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
        } finally {
          await r.close();
        }
      },
    );

    it(
      `${via}: chiusura a metà di un upload dà CLOSED, nessuna promessa resta in attesa`,
      { timeout: 30_000 },
      async () => {
        for (const drop of [3, 5, 9]) {
          const cpu = new FakeCpu({ faults: { dropAfterResponses: drop } });
          smallWorld(cpu);
          cpu.addDb(2, new Uint8Array(5000).fill(0x5a));
          const r = await rig(cpu, via);
          const recorder = createRecorder();
          try {
            const cl = await r.connect({ proposedPdu: 240, recorder });
            // l'upload di DB2 sono ~22 pezzi: la CPU chiude dopo `drop` risposte (setup compreso)
            const calls: Promise<unknown>[] = [
              cl.upload('DB', 2),
              cl.readClock(), // in coda dietro l'upload
              cl.identity(),
            ];
            const settled = Promise.allSettled(calls);
            const done = await Promise.race([settled, sleep(10_000).then(() => 'attesa' as const)]);
            expect(done).not.toBe('attesa');
            // l'upload deve fallire con CLOSED; le richieste in coda si servono tra i suoi passi
            // (una alla volta), quindi possono riuscire prima della chiusura ma mai restare appese
            const [up, ...queued] = done as PromiseSettledResult<unknown>[];
            expect(up!.status).toBe('rejected');
            expect(((up as PromiseRejectedResult).reason as S7Error).code).toBe('CLOSED');
            for (const s of queued) {
              if (s.status === 'rejected') {
                expect(s.reason).toBeInstanceOf(S7Error);
                expect((s.reason as S7Error).code).toBe('CLOSED');
              }
            }
            expect((await errorOf(cl.readClock())).code).toBe('CLOSED');
            // il registratore ha tutti i frame fino alla chiusura: il CC e `drop` risposte S7
            const frames = recorder.frames();
            const rx = frames.filter((f) => f.dir === 'rx').map((f) => decodeCotp(f.bytes));
            expect(rx[0]!.type).toBe('CC');
            const pdus = rx.slice(1).filter((c) => c.type === 'DT');
            expect(pdus).toHaveLength(drop);
            const refs = pdus.map((c) => (c.type === 'DT' ? decodeS7(c.data).pduRef : -1));
            // una risposta per ogni richiesta inviata, nello stesso ordine
            const txRefs = frames
              .filter((f) => f.dir === 'tx')
              .map((f) => decodeCotp(f.bytes))
              .filter((c) => c.type === 'DT')
              .map((c) => (c.type === 'DT' ? decodeS7(c.data).pduRef : -1));
            expect(txRefs.slice(0, drop)).toEqual(refs);
          } finally {
            await r.close();
          }
          await until(() => cpu.connections === 0);
          expect(cpu.connections).toBe(0);
        }
      },
    );
  }
});

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of process.getActiveResourcesInfo()) out[k] = (out[k] ?? 0) + 1;
  return out;
}

describe('robustezza: sessioni ripetute e connessioni simultanee', () => {
  for (const via of VIAS) {
    it(
      `${via}: 200 sessioni aperte e chiuse in fila, connessioni a 0 ogni volta, nessuna risorsa persa`,
      { timeout: 60_000 },
      async () => {
        const cpu = new FakeCpu();
        smallWorld(cpu);
        await sleep(20);
        const before = counts();
        const r = await rig(cpu, via);
        for (let i = 0; i < 200; i++) {
          const cl = await r.connect({ timeoutMs: 3000 });
          if (i % 20 === 0) expect(await cl.readArea('M', 0, 10, 4)).toHaveLength(4);
          expect(cpu.connections).toBe(1);
          await cl.close();
          await until(() => cpu.connections === 0);
          expect(cpu.connections).toBe(0);
        }
        await r.close();
        await sleep(100);
        await new Promise((res) => setImmediate(res)); // un macrotask: i callback di chiusura sono passati
        const after = counts();
        for (const k of ['TCPSocketWrap', 'TCPServerWrap', 'Timeout', 'Immediate']) {
          expect(
            after[k] ?? 0,
            `${k} prima ${JSON.stringify(before)} dopo ${JSON.stringify(after)}`,
          ).toBeLessThanOrEqual(before[k] ?? 0);
        }
      },
    );

    it(
      `${via}: 17 connessioni simultanee con maxConnections 16: la 17ª dà COTP_REJECTED, le altre 16 funzionano`,
      { timeout: 30_000 },
      async () => {
        const cpu = new FakeCpu({ maxConnections: 16 });
        smallWorld(cpu);
        const r = await rig(cpu, via);
        try {
          const results = await Promise.allSettled(Array.from({ length: 17 }, () => r.connect()));
          const ok = results.filter(
            (x): x is PromiseFulfilledResult<S7Client> => x.status === 'fulfilled',
          );
          const bad = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
          expect(ok).toHaveLength(16);
          expect(bad).toHaveLength(1);
          expect((bad[0]!.reason as S7Error).code).toBe('COTP_REJECTED');
          expect(cpu.connections).toBe(16);
          await Promise.all(
            ok.map(async (x) => expect(await x.value.readArea('M', 0, 10, 2)).toHaveLength(2)),
          );
          await Promise.all(ok.map((x) => x.value.close()));
          await until(() => cpu.connections === 0);
          expect(cpu.connections).toBe(0);
          // liberato il posto, una nuova connessione entra
          expect((await (await r.connect()).identity()).orderNumber).toBeTruthy();
        } finally {
          await r.close();
        }
      },
    );
  }
});
