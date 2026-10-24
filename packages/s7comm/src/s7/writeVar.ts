import { writeU16, readU16 } from '../bytes';
import { S7Error } from '../errors';
import { itemReturnName } from './errorCodes';
import {
  dataBytes,
  decodeReadRequest,
  encodeReadRequest,
  itemByteLength,
  responseTransportFor,
  type Area,
  type ReadItem,
  type TransportSize,
} from './readVar';
import { MAX_ITEMS_PER_REQUEST } from './plan';

const FN_WRITE = 0x05;
const RC_RESERVED = 0x00;

const REQ_HEADER = 10;
const RES_HEADER = 12;
/** Ultimo byte indirizzabile (indirizzo in bit su 3 byte), come in plan.ts. */
const MAX_ADDR_BYTES = 0x1fffff;

export interface WriteItem {
  area: Area;
  db: number;
  start: number;
  bit?: number;
  size: TransportSize;
  count: number;
  data: Uint8Array;
}

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `write var: ${msg}`);
}

const specOf = (it: WriteItem): ReadItem => {
  const spec: ReadItem = {
    area: it.area,
    db: it.db,
    start: it.start,
    size: it.size,
    count: it.count,
  };
  if (it.bit !== undefined) spec.bit = it.bit;
  return spec;
};

/** Lunghezza dell'item dati sul filo: bit per TS 0x04/0x05, un bit per 0x03 (count), byte per il resto. */
function wireLength(ts: number, spec: ReadItem): number {
  if (ts === 0x04 || ts === 0x05) return itemByteLength(spec) * 8;
  if (ts === 0x03) return spec.count;
  return itemByteLength(spec);
}

/**
 * Write request (proto §5.1, §5.5). La parte parametro è quella della read con function 0x05;
 * ogni item dati è `00 TS len(2) dati`, con 1 byte di riempimento dopo i dati dispari
 * tranne che nell'ultimo item (§5.10).
 */
export function encodeWriteRequest(items: WriteItem[]): { param: Uint8Array; data: Uint8Array } {
  const specs = items.map(specOf);
  const param = encodeReadRequest(specs); // valida anche item e conteggio
  param[0] = FN_WRITE;
  let total = 0;
  items.forEach((it, i) => {
    const want = itemByteLength(specs[i]!);
    if (it.data.length !== want) {
      throw new RangeError(`item ${i}: ${it.data.length} byte di dati, attesi ${want}`);
    }
    total += 4 + want + (want % 2 === 1 && i < items.length - 1 ? 1 : 0);
  });
  const data = new Uint8Array(total);
  let o = 0;
  items.forEach((it, i) => {
    const spec = specs[i]!;
    const ts = responseTransportFor(spec);
    const len = wireLength(ts, spec);
    if (len > 0xffff) throw new RangeError(`item ${i}: lunghezza non codificabile`);
    data[o] = RC_RESERVED;
    data[o + 1] = ts;
    writeU16(data, o + 2, len);
    data.set(it.data, o + 4);
    o += 4 + it.data.length;
    if (it.data.length % 2 === 1 && i < items.length - 1) o += 1;
  });
  return { param, data };
}

/** Lato server (finto PLC). */
export function decodeWriteRequest(param: Uint8Array, data: Uint8Array): WriteItem[] {
  if (param.length < 2 || param[0] !== FN_WRITE) throw bad('parametro di richiesta non valido');
  const specs = decodeReadRequest(Uint8Array.from(param, (b, i) => (i === 0 ? 0x04 : b)));
  const out: WriteItem[] = [];
  let o = 0;
  specs.forEach((spec, i) => {
    if (o + 4 > data.length) throw bad('item dati troncato');
    const nb = dataBytes(data[o + 1]!, readU16(data, o + 2));
    if (nb !== itemByteLength(spec)) {
      throw bad(`item ${i}: ${nb} byte di dati, attesi ${itemByteLength(spec)} dalla specifica`);
    }
    if (o + 4 + nb > data.length) throw bad('dati item oltre la parte dati');
    out.push({ ...spec, data: data.slice(o + 4, o + 4 + nb) });
    o += 4 + nb;
    if (nb % 2 === 1 && i < specs.length - 1) o += 1;
  });
  return out;
}

/** Write response (proto §5.9): un return code per item, nessun padding. Lato server. */
export function encodeWriteResponse(returnCodes: number[]): {
  param: Uint8Array;
  data: Uint8Array;
} {
  if (returnCodes.length < 1 || returnCodes.length > 255)
    throw new RangeError(`${returnCodes.length} item: fuori 1-255`);
  return {
    param: Uint8Array.of(FN_WRITE, returnCodes.length),
    data: Uint8Array.from(returnCodes, (c) => c & 0xff),
  };
}

export function decodeWriteResponse(
  param: Uint8Array,
  data: Uint8Array,
): { returnCode: number; name: string }[] {
  if (param.length < 2 || param[0] !== FN_WRITE) throw bad('parametro di risposta non valido');
  const n = param[1]!;
  if (data.length < n) throw bad('return code troncati');
  return Array.from(data.subarray(0, n), (rc) => ({ returnCode: rc, name: itemReturnName(rc) }));
}

/** Quanto occupa il gruppo come richiesta (10 + 2 + 12n + dati) e come risposta (12 + 2 + n). */
function fits(group: WriteItem[], pdu: number): boolean {
  if (group.length > MAX_ITEMS_PER_REQUEST) return false;
  let req = REQ_HEADER + 2 + 12 * group.length;
  group.forEach((it, i) => {
    const n = it.data.length;
    req += 4 + n + (n % 2 === 1 && i < group.length - 1 ? 1 : 0);
  });
  return req <= pdu && RES_HEADER + 2 + group.length <= pdu;
}

/**
 * Raggruppa gli item (in ordine) in richieste che stanno nella PDU come richiesta e come
 * risposta, al massimo 20 item (proto §5.11). Un item che da solo non entra: RangeError,
 * il chiamante usa splitWrite.
 */
export function planWrites(items: WriteItem[], pduLength: number): WriteItem[][] {
  const groups: WriteItem[][] = [];
  let cur: WriteItem[] = [];
  for (const it of items) {
    if (!fits([it], pduLength)) {
      throw new RangeError('item più grande della PDU negoziata: va diviso con splitWrite');
    }
    if (!fits([...cur, it], pduLength)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Divide una scrittura in item BYTE che entrano da soli nella PDU. Massimo byte dati per
 * item = pdu − 28, con 28 = header 10 + parametro 2 + item 12 + header dato 4
 * (proto §5.11: PDU 240 → 212).
 */
export function splitWrite(
  area: Area,
  db: number,
  start: number,
  data: Uint8Array,
  pduLength: number,
): WriteItem[] {
  if (area === 'C' || area === 'T')
    throw new RangeError('splitWrite non vale per timer e contatori');
  if (data.length < 1 || data.length > MAX_ADDR_BYTES) {
    throw new RangeError(`lunghezza ${data.length} fuori 1-${MAX_ADDR_BYTES}`);
  }
  if (!Number.isInteger(start) || start < 0 || start + data.length - 1 > MAX_ADDR_BYTES) {
    throw new RangeError(`start ${start} fuori dallo spazio di indirizzi a 3 byte`);
  }
  const chunk = pduLength - (REQ_HEADER + 2 + 12 + 4);
  if (chunk < 1) throw new RangeError(`PDU ${pduLength} troppo piccola`);
  const out: WriteItem[] = [];
  for (let done = 0; done < data.length; done += chunk) {
    const part = data.slice(done, done + chunk);
    out.push({ area, db, start: start + done, size: 'BYTE', count: part.length, data: part });
  }
  return out;
}
