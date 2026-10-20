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
