import { parseBlockFile } from '@baaportal/s7comm';
import type { OnlineBlock } from './plcTypes';

/** Stato di un blocco nel confronto con la CPU. */
export type CompareState =
  'same' | 'different' | 'offlineOnly' | 'onlineOnly' | 'notCompiled' | 'unreadable';

/** Blocco del progetto: `file` è il compilato aggiornato (assente: da compilare o con errori). */
export interface CompareProjectBlock {
  id: string;
  type: 'OB' | 'FB' | 'FC' | 'DB';
  number: number;
  file?: Uint8Array;
}

export interface CompareRow {
  type: OnlineBlock['type'];
  number: number;
  /** Id del blocco nel progetto; assente per i blocchi presenti solo nella CPU. */
  blockId?: string;
  state: CompareState;
}

/** Il confronto tenuto nello stato online. `hashes`: impronta di ogni blocco al momento del confronto. */
export interface OnlineCompare {
  deviceId: string;
  rows: CompareRow[];
  hashes: Record<string, string>;
}

/** Tipi di sistema: non fanno parte del progetto, quindi non si confrontano. */
const SYSTEM: ReadonlySet<string> = new Set(['SFC', 'SFB', 'SDB']);

const key = (type: string, number: number) => `${type}${number}`;

/** Checksum e lunghezza MC7 dall'intestazione del compilato; `undefined` se il file non si legge. */
export function signatureOf(file: Uint8Array): { checksum: number; mc7Length: number } | undefined {
  try {
    const p = parseBlockFile(file);
    return p.footer ? { checksum: p.footer.checksum, mc7Length: p.header.mc7Length } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Byte del codice MC7 diversi fra due compilati (i byte in più del più lungo contano come diversi);
 * `undefined` se uno dei due non si legge.
 */
export function mc7ByteDiff(a: Uint8Array, b: Uint8Array): number | undefined {
  try {
    const [x, y] = [parseBlockFile(a).mc7, parseBlockFile(b).mc7];
    let n = Math.abs(x.length - y.length);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
    return n;
  } catch {
    return undefined;
  }
}

/**
 * Confronta i blocchi compilati del progetto con quelli della CPU. «Uguale» vuol dire stesso
 * checksum e stessa lunghezza MC7; ogni altra differenza è «diverso». Un blocco senza compilato
 * aggiornato è «da compilare» qualunque cosa abbia la CPU. Un blocco della CPU le cui informazioni
 * non si sono lette è «illeggibile». SFC, SFB e SDB sono esclusi.
 *
 * Il numero è quello dichiarato dal progetto: il numero 0 dell'SSB dei blocchi protetti (know-how)
 * e degli OB riguarda solo la sezione SSB, non l'intestazione, che porta il numero vero.
 */
export function compareBlocks(project: CompareProjectBlock[], online: OnlineBlock[]): CompareRow[] {
  const cpu = new Map<string, OnlineBlock>();
  for (const o of online) if (!SYSTEM.has(o.type)) cpu.set(key(o.type, o.number), o);
  const rows: CompareRow[] = [];
  const seen = new Set<string>();
  for (const b of project) {
    const k = key(b.type, b.number);
    seen.add(k);
    const base = { type: b.type, number: b.number, blockId: b.id };
    const o = cpu.get(k);
    const sig = b.file ? signatureOf(b.file) : undefined;
    if (!sig) rows.push({ ...base, state: 'notCompiled' });
    else if (!o) rows.push({ ...base, state: 'offlineOnly' });
    else if (o.unreadable) rows.push({ ...base, state: 'unreadable' });
    else {
      const same = sig.checksum === o.checksum && sig.mc7Length === o.mc7Length;
      rows.push({ ...base, state: same ? 'same' : 'different' });
    }
  }
  for (const [k, o] of cpu) {
    if (!seen.has(k))
      rows.push({
        type: o.type,
        number: o.number,
        state: o.unreadable ? 'unreadable' : 'onlineOnly',
      });
  }
  return rows;
}
