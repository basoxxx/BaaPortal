import { fromHex, hex } from '../bytes';
import { S7Error } from '../errors';

/** Un frame TPKT (senza l'header di 4 byte) con il suo istante, in ms dal primo frame. */
export interface CapturedFrame {
  t: number;
  /** tx = verso la CPU (porta 102), rx = dalla CPU. */
  dir: 'tx' | 'rx';
  bytes: Uint8Array;
}

/** Una connessione TCP sulla porta 102: i payload TPKT interi, nell'ordine di arrivo. */
export interface CaptureStream {
  client: string;
  server: string;
  frames: CapturedFrame[];
  /** Byte TCP scartati perché dopo un buco della cattura non c'era un inizio di TPKT sicuro. */
  droppedBytes: number;
}

/**
 * Registro di cattura: una riga JSON per frame, `{ "t": ms, "dir": "tx"|"rx", "hex": "..." }`,
 * con a-capo LF (anche su Windows) e un a-capo dopo l'ultima riga.
 */
export function framesToJsonl(frames: CapturedFrame[]): string {
  let out = '';
  for (const f of frames) out += `${JSON.stringify({ t: f.t, dir: f.dir, hex: hex(f.bytes) })}\n`;
  return out;
}

/** Legge un registro. Righe vuote ignorate; una riga errata dà PROTOCOL con il suo numero (da 1). */
export function jsonlToFrames(text: string): CapturedFrame[] {
  const out: CapturedFrame[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim(); // toglie anche l'eventuale CR
    if (line === '') continue;
    const bad = (why: string): S7Error =>
      new S7Error('PROTOCOL', `registro di cattura: riga ${i + 1}: ${why}`);
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw bad('JSON non valido');
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad('non è un oggetto');
    const o = v as Record<string, unknown>;
    if (typeof o['t'] !== 'number' || !Number.isFinite(o['t']) || o['t'] < 0) {
      throw bad('"t" deve essere un numero >= 0');
    }
    if (o['dir'] !== 'tx' && o['dir'] !== 'rx') throw bad('"dir" deve essere "tx" o "rx"');
    const h = o['hex'];
    if (typeof h !== 'string' || h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) {
      throw bad('"hex" non è una stringa esadecimale di lunghezza pari');
    }
    out.push({ t: o['t'], dir: o['dir'], bytes: fromHex(h) });
  }
  return out;
}

export interface CaptureRecorder {
  record(dir: 'tx' | 'rx', bytes: Uint8Array): void;
  /** Copie: modificarle non tocca il registro. */
  frames(): CapturedFrame[];
}

/** Registra in memoria; `t` è in ms dal primo frame registrato. */
export function createRecorder(now: () => number = Date.now): CaptureRecorder {
  const items: CapturedFrame[] = [];
  let first: number | undefined;
  return {
    record(dir, bytes) {
      const at = now();
      first ??= at;
      items.push({ t: at - first, dir, bytes: bytes.slice() });
    },
    frames() {
      return items.map((f) => ({ t: f.t, dir: f.dir, bytes: f.bytes.slice() }));
    },
  };
}
