import {
  dissect,
  decodeS7,
  decodeCotp,
  decodeEndUpload,
  decodeStartUploadResponse,
  memoryTransportPair,
  type CapturedFrame,
  type DissectKind,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, type FakeCpuOptions } from '../src';
import { blockFile, seq } from './helpers';

/** Un finto PLC con 5 blocchi: OB1, FC1, FB1, DB1, DB2. */
export function cpuWithBlocks(o: FakeCpuOptions = {}): FakeCpu {
  const cpu = new FakeCpu(o);
  cpu.addBlock(blockFile('OB', 1, seq(24)));
  cpu.addBlock(blockFile('FC', 1, seq(16, 3)));
  cpu.addBlock(blockFile('FB', 1, seq(40, 7)));
  cpu.addDb(1, seq(40));
  cpu.addDb(2, seq(100, 9));
  return cpu;
}

/** Trasporto in memoria verso il finto PLC; `cpuFor(n)` sceglie quale CPU risponde alla n-esima connessione (da 0). */
export function memoryFactory(cpuFor: (n: number) => FakeCpu): TransportFactory {
  let n = 0;
  return async () => {
    const cpu = cpuFor(n++);
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
}

export const ALLOWED = new Set<DissectKind>([
  'setup',
  'readVar',
  'szl',
  'blockList',
  'blockInfo',
  'clock',
  'upload',
  'connect',
]);

/** Classe di ogni frame tx del registro. */
export function txKinds(frames: CapturedFrame[]): DissectKind[] {
  return frames.filter((f) => f.dir === 'tx').map((f) => dissect(f.bytes).kind);
}

/** Id degli upload iniziati (dalle risposte allo start) e degli id su cui è partito l'EndUpload. */
export function uploadIds(frames: CapturedFrame[]): { started: number[]; ended: number[] } {
  const startRefs = new Set<number>();
  const started: number[] = [];
  const ended: number[] = [];
  for (const f of frames) {
    const c = decodeCotp(f.bytes);
    if (c.type !== 'DT' || !c.eot) continue;
    const pdu = decodeS7(c.data);
    if (f.dir === 'tx' && pdu.rosctr === 1 && pdu.param[0] === 0x1d) startRefs.add(pdu.pduRef);
    else if (f.dir === 'tx' && pdu.rosctr === 1 && pdu.param[0] === 0x1f) {
      ended.push(decodeEndUpload(pdu.param).uploadId);
    } else if (f.dir === 'rx' && pdu.rosctr === 3 && startRefs.has(pdu.pduRef)) {
      startRefs.delete(pdu.pduRef);
      started.push(decodeStartUploadResponse(pdu.param).uploadId);
    }
  }
  return { started, ended };
}

/**
 * Controlla la chiusura degli upload nel registro: dopo ogni start (0x1D) non può partire altra
 * richiesta se non un upload (0x1E) dello stesso id, finché non arriva l'end (0x1F) con lo stesso
 * id o la connessione si chiude (DR inviato, nuova CR, o fine del registro).
 */
export function uploadViolations(frames: CapturedFrame[]): string[] {
  const out: string[] = [];
  let open: { ref: number; id?: number } | undefined;
  frames.forEach((f, i) => {
    const c = decodeCotp(f.bytes);
    if (c.type === 'CR' || c.type === 'DR') {
      open = undefined;
      return;
    }
    if (c.type !== 'DT' || !c.eot) return;
    const pdu = decodeS7(c.data);
    if (f.dir === 'rx') {
      if (open && open.id === undefined && pdu.pduRef === open.ref && pdu.rosctr === 3) {
        try {
          open.id = decodeStartUploadResponse(pdu.param).uploadId;
        } catch {
          open = undefined; // start rifiutato: nessun upload aperto
        }
      }
      return;
    }
    if (pdu.rosctr !== 1 && pdu.rosctr !== 7) return;
    const fn = pdu.rosctr === 1 ? pdu.param[0] : undefined;
    if (fn === 0x1d) {
      if (open) out.push(`frame ${i}: nuovo start con un upload ancora aperto`);
      open = { ref: pdu.pduRef };
    } else if (open && fn === 0x1e) {
      // altro pezzo dello stesso upload
    } else if (open && fn === 0x1f) {
      const id = decodeEndUpload(pdu.param).uploadId;
      if (open.id !== undefined && id !== open.id) out.push(`frame ${i}: end con id ${id}`);
      open = undefined;
    } else if (open) {
      out.push(`frame ${i}: richiesta 0x${(fn ?? 0).toString(16)} con un upload aperto`);
    }
  });
  return out;
}

/** Come `memoryFactory`, ma registra i byte davvero inviati al finto PLC e può spiare i dati in arrivo. */
export function spyFactory(
  cpuFor: (n: number) => FakeCpu,
  spy: { wire: Uint8Array[]; onRx?: (count: number) => void },
): TransportFactory {
  const inner = memoryFactory(cpuFor);
  let rx = 0;
  return async (...a) => {
    const t = await inner(...a);
    return {
      send(b) {
        spy.wire.push(b.slice());
        t.send(b);
      },
      onData(cb) {
        t.onData((c) => {
          rx++;
          cb(c);
          spy.onRx?.(rx);
        });
      },
      onClose: (cb) => t.onClose(cb),
      close: () => t.close(),
    };
  };
}
