import { readU16, writeU16 } from '../bytes';
import { S7Error } from '../errors';

/**
 * Lista SZL (proto §7). `records` sono i record grezzi, ciascuno di `recordLength` byte.
 * `declaredCount` c'è solo se il conteggio N_DR sul filo era diverso dal numero di record
 * (alcune CPU mandano 0xFFFF; le liste "solo intestazione" 0x0Fxx non hanno record): serve a
 * ricodificare gli stessi byte.
 */
export interface SzlList {
  id: number;
  index: number;
  recordLength: number;
  records: Uint8Array[];
  declaredCount?: number;
}

const HEADER = 8;
const COUNT_UNKNOWN = 0xffff;

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `SZL: ${msg}`);
}

/** Payload di una richiesta Read SZL: id + index (proto §7.1). */
export function encodeSzlRequest(id: number, index: number): Uint8Array {
  const out = new Uint8Array(4);
  writeU16(out, 0, id);
  writeU16(out, 2, index);
  return out;
}

export function decodeSzlRequest(payload: Uint8Array): { id: number; index: number } {
  if (payload.length !== 4) throw bad(`richiesta di ${payload.length} byte invece di 4`);
  return { id: readU16(payload, 0), index: readU16(payload, 2) };
}

/**
 * Ricompone i pezzi di una risposta (proto §6.7, §7.2): il primo porta l'intestazione di lista
 * di 8 byte, gli altri solo byte di record. Se N_DR è 0xFFFF il conteggio si ricalcola dai byte.
 */
export function parseSzl(fragments: Uint8Array[]): SzlList {
  const first = fragments[0];
  if (!first) throw bad('nessun pezzo');
  if (first.length < HEADER) throw bad('intestazione di lista troncata');
  const id = readU16(first, 0);
  const index = readU16(first, 2);
  const recordLength = readU16(first, 4);
  const nDr = readU16(first, 6);
  let total = first.length - HEADER;
  for (let i = 1; i < fragments.length; i++) total += fragments[i]!.length;
  const bytes = new Uint8Array(total);
  let o = 0;
  bytes.set(first.subarray(HEADER), o);
  o += first.length - HEADER;
  for (let i = 1; i < fragments.length; i++) {
    bytes.set(fragments[i]!, o);
    o += fragments[i]!.length;
  }
  let count: number;
  if (total === 0 && (id & 0x0f00) === 0x0f00) {
    // Estratto 0x0F: "solo intestazione" (proto §7.3), N_DR descrive la lista ma i record mancano.
    count = 0;
  } else if (nDr === COUNT_UNKNOWN) {
    if (recordLength === 0) {
      if (total !== 0) throw bad('record di lunghezza 0 con dati');
      count = 0;
    } else {
      if (total % recordLength !== 0) throw bad('record finale incompleto');
      count = total / recordLength;
    }
  } else {
    count = nDr;
    if (total < count * recordLength)
      throw bad(`attesi ${count * recordLength} byte, ricevuti ${total}`);
    if (total > count * recordLength) throw bad("byte oltre l'ultimo record");
  }
  const records: Uint8Array[] = [];
  for (let i = 0; i < count; i++)
    records.push(bytes.slice(i * recordLength, (i + 1) * recordLength));
  const list: SzlList = { id, index, recordLength, records };
  if (nDr !== count) list.declaredCount = nDr;
  return list;
}

/**
 * Pezzi come li manda una CPU: i byte (intestazione + record) tagliati ogni `maxPayload`,
 * anche in mezzo a un record. Il primo pezzo porta l'intestazione.
 */
export function encodeSzl(list: SzlList, maxPayload: number): Uint8Array[] {
  if (!Number.isInteger(maxPayload) || maxPayload <= HEADER) {
    throw new RangeError(`maxPayload ${maxPayload} deve superare ${HEADER}`);
  }
  const all = new Uint8Array(HEADER + list.recordLength * list.records.length);
  writeU16(all, 0, list.id);
  writeU16(all, 2, list.index);
  writeU16(all, 4, list.recordLength);
  writeU16(all, 6, list.declaredCount ?? list.records.length);
  list.records.forEach((r, i) => {
    if (r.length !== list.recordLength) throw new RangeError(`record ${i} di ${r.length} byte`);
    all.set(r, HEADER + i * list.recordLength);
  });
  const out: Uint8Array[] = [];
  for (let o = 0; o < all.length; o += maxPayload) out.push(all.slice(o, o + maxPayload));
  return out;
}
