import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeCotp,
  decodeDownloadBlockAck,
  decodeS7,
  encodeInsertBlock,
  encodePlcStop,
  encodeRequestDownload,
  parseBlockFile,
  readPcap,
  type S7Pdu,
} from '@baaportal/s7comm';
import { FakeCpu, compareShape } from '../src';
import { TestPeer } from './helpers';
// aiuti di test già usati da s7comm per trovare le catture
import { CACHE_DIR, CISAGOV_DIR } from '../../s7comm/test/captures';

/** PDU S7 complete (anche su più DT) di tutte le connessioni di una cattura, nell'ordine. */
function pdusOf(path: string): { dir: 'tx' | 'rx'; pdu: S7Pdu }[] {
  const out: { dir: 'tx' | 'rx'; pdu: S7Pdu }[] = [];
  for (const st of readPcap(readFileSync(path))) {
    const parts = { tx: [] as Uint8Array[], rx: [] as Uint8Array[] };
    for (const f of st.frames) {
      let c;
      try {
        c = decodeCotp(f.bytes);
      } catch {
        continue;
      }
      if (c.type !== 'DT') continue;
      parts[f.dir].push(c.data);
      if (!c.eot) continue;
      const chunks = parts[f.dir].splice(0);
      const whole = new Uint8Array(chunks.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of chunks) {
        whole.set(p, at);
        at += p.length;
      }
      try {
        out.push({ dir: f.dir, pdu: decodeS7(whole) });
      } catch {
        /* S7comm-plus o coda: non interessa */
      }
    }
  }
  return out;
}

const DOWNLOAD = 's7comm_downloading_block_db1.pcap';
const LIBNODAVE = 's7comm_varservice_libnodavedemo.pcap';
const has = (f: string): boolean => existsSync(join(CACHE_DIR, f));
const code = (p: S7Pdu): number => (p.errorClass << 8) | p.errorCode;

describe('forma delle risposte del finto PLC contro il filo vero (scrittura e controllo)', () => {
  it('stop, e write var di cisagov/snap7.pcap: stessa struttura della CPU 315 vera', async () => {
    const all = pdusOf(join(CISAGOV_DIR, 'snap7.pcap'));
    let stops = 0;
    let writes = 0;
    for (const [i, x] of all.entries()) {
      const next = all[i + 1];
      if (x.dir !== 'tx' || x.pdu.rosctr !== 1 || next?.dir !== 'rx') continue;
      const fn = x.pdu.param[0];
      if (fn !== 0x29 && !(fn === 0x05 && x.pdu.param[1] === 1)) continue;
      const cpu = new FakeCpu({ mode: 'RUN' });
      const peer = await new TestPeer(cpu).open();
      const got = await peer.job(x.pdu.param, x.pdu.data);
      expect(got, `risposta a fn ${fn!.toString(16)}`).toBeDefined();
      expect(compareShape(next.pdu, got!), `fn ${fn!.toString(16)}`).toEqual([]);
      expect(code(got!)).toBe(0);
      if (fn === 0x05) {
        // un esito per item, come la vera: stessi byte di dati di return code
        expect(got!.data.length).toBe(next.pdu.data.length);
        writes++;
      } else stops++;
      peer.close();
    }
    expect(stops).toBeGreaterThanOrEqual(1);
    expect(writes).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!has(LIBNODAVE))(
    `write var di ${LIBNODAVE}: stessa struttura della CPU vera (cattura scaricata)`,
    async () => {
      const all = pdusOf(join(CACHE_DIR, LIBNODAVE));
      let n = 0;
      for (const [i, x] of all.entries()) {
        const next = all[i + 1];
        if (x.dir !== 'tx' || x.pdu.rosctr !== 1 || x.pdu.param[0] !== 0x05) continue;
        if (next?.dir !== 'rx' || x.pdu.param[1] !== 1) continue;
        const cpu = new FakeCpu();
        const peer = await new TestPeer(cpu).open();
        const got = await peer.job(x.pdu.param, x.pdu.data);
        expect(compareShape(next.pdu, got!)).toEqual([]);
        expect(got!.data.length).toBe(next.pdu.data.length);
        n++;
        peer.close();
      }
      expect(n).toBeGreaterThan(0);
    },
  );

  it.skipIf(!has(DOWNLOAD))(
    `sequenza di download di ${DOWNLOAD}: il finto PLC risponde con la stessa struttura e inserisce il blocco`,
    async () => {
      const all = pdusOf(join(CACHE_DIR, DOWNLOAD));
      // PDU di S7 dopo il setup, nell'ordine in cui compaiono
      const seq = all.filter(
        (x) => x.pdu.param[0] !== 0xf0 && [0x1a, 0x1b, 0x1c, 0x28].includes(x.pdu.param[0]!),
      );
      const reqDl = seq[0]!;
      expect(reqDl.dir).toBe('tx');
      expect(reqDl.pdu.param[0]).toBe(0x1a);

      const cpu = new FakeCpu();
      const peer = await new TestPeer(cpu).open();
      await peer.job(reqDl.pdu.param);
      // dopo l'ack il finto PLC manda subito il primo job 0x1B
      const mine = peer.pdus.at(-2)!;
      expect(mine.rosctr).toBe(3);
      expect(compareShape(seq[1]!.pdu, mine), 'ack 0x1A').toEqual([]);

      // La CPU vera chiede 3 fette; qui il finto PLC chiede le stesse (la prima è già partita)
      const chunks: Uint8Array[] = [];
      let realJobs = 0;
      let k = 2;
      while (seq[k]?.pdu.param[0] === 0x1b) {
        const realJob = seq[k]!.pdu; // CPU->PG job 0x1B
        const realAck = seq[k + 1]!.pdu; // PG->CPU ack-data con la fetta
        expect(realJob.rosctr).toBe(1);
        expect(realAck.rosctr).toBe(3);
        const myJob = peer.pdus.at(-1)!;
        expect(myJob.rosctr, 'job 0x1B del finto PLC').toBe(1);
        expect(compareShape(realJob, myJob), `job 0x1B n.${realJobs}`).toEqual([]);
        chunks.push(decodeDownloadBlockAck(realAck.param, realAck.data).chunk);
        // il PG risponde con i byte VERI (stesso pduRef del job del finto PLC)
        await peer.send({
          rosctr: 3,
          param: realAck.param,
          data: realAck.data,
          pduRef: myJob.pduRef,
        });
        realJobs++;
        k += 2;
      }
      expect(realJobs).toBe(3);
      // dopo l'ultima fetta il finto PLC manda il 0x1C, come la vera
      const myEnd = peer.pdus.at(-1)!;
      expect(seq[k]!.pdu.param[0]).toBe(0x1c);
      expect(compareShape(seq[k]!.pdu, myEnd), 'job 0x1C').toEqual([]);
      await peer.send({
        rosctr: 3,
        param: seq[k + 1]!.pdu.param,
        data: seq[k + 1]!.pdu.data,
        pduRef: myEnd.pduRef,
      });

      // _INSE vero
      const inse = seq[k + 2]!;
      expect(inse.pdu.param[0]).toBe(0x28);
      const done = await peer.job(inse.pdu.param);
      expect(compareShape(seq[k + 3]!.pdu, done!), 'ack _INSE').toEqual([]);
      expect(code(done!)).toBe(0);
      peer.close();

      // il blocco è ora nel finto PLC, uguale a quello della cattura
      const file = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        file.set(c, at);
        at += c.length;
      }
      expect(parseBlockFile(file).header).toMatchObject({ type: 'DB', number: 1 });
      expect(cpu.block('DB', 1)?.file).toEqual(file);
    },
  );
});

describe('i codec di download e controllo ricostruiscono i byte della richiesta vera', () => {
  it.skipIf(!has(DOWNLOAD))(`numeri veri di ${DOWNLOAD}`, () => {
    const all = pdusOf(join(CACHE_DIR, DOWNLOAD));
    const req = all.find((x) => x.pdu.param[0] === 0x1a && x.dir === 'tx')!;
    // i valori veri: load memory 500, MC7 400 (non quelli del §17.9)
    expect(req.pdu.param).toEqual(encodeRequestDownload('DB', 1, 'P', 500, 400));
    const inse = all.find((x) => x.pdu.param[0] === 0x28 && x.dir === 'tx')!;
    expect(inse.pdu.param).toEqual(encodeInsertBlock('DB', 1, 'P'));
  });

  it('lo stop vero di snap7.pcap coincide con encodePlcStop', () => {
    const stop = pdusOf(join(CISAGOV_DIR, 'snap7.pcap')).find(
      (x) => x.dir === 'tx' && x.pdu.param[0] === 0x29,
    )!;
    expect(stop.pdu.param).toEqual(encodePlcStop());
  });
});
