import { itemResponseBytes, type Area, type ReadItem } from './readVar';

/** Massimo item per richiesta (proto §5.11, come snap7). */
export const MAX_ITEMS_PER_REQUEST = 20;

const REQ_HEADER = 10;
const RES_HEADER = 12;

function fits(group: ReadItem[], pdu: number): boolean {
  if (group.length > MAX_ITEMS_PER_REQUEST) return false;
  if (REQ_HEADER + 2 + 12 * group.length > pdu) return false;
  let res = RES_HEADER + 2;
  group.forEach((it, i) => {
    const n = itemResponseBytes(it);
    res += 4 + n + (n % 2 === 1 && i < group.length - 1 ? 1 : 0);
  });
  return res <= pdu;
}

/**
 * Raggruppa gli item (in ordine) in richieste che stanno nella PDU sia come richiesta
 * (10 + 2 + 12n) sia come risposta (12 + 2 + Σ(4 + dati + pad)), al massimo 20 item.
 * Un item che da solo non entra non è ammesso: RangeError, il chiamante usa splitArea.
 */
export function planReads(items: ReadItem[], pduLength: number): ReadItem[][] {
  const groups: ReadItem[][] = [];
  let cur: ReadItem[] = [];
  for (const it of items) {
    if (!fits([it], pduLength)) {
      throw new RangeError('item più grande della PDU negoziata: va diviso con splitArea');
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
 * Divide una lettura di `length` byte in item BYTE che entrano da soli nella PDU.
 * Massimo byte dati per item = pdu − 18, dove 18 = header risposta 12 + parametro 2 +
 * header item dati 4 (proto §5.11: PDU 240 → 222; verificato, 218 byte → risposta da 222).
 */
export function splitArea(
  area: Area,
  db: number,
  start: number,
  length: number,
  pduLength: number,
): ReadItem[] {
  if (area === 'C' || area === 'T')
    throw new RangeError('splitArea non vale per timer e contatori');
  if (!Number.isInteger(length) || length < 1)
    throw new RangeError(`lunghezza ${length} non valida`);
  const chunk = pduLength - (RES_HEADER + 2 + 4);
  if (chunk < 1) throw new RangeError(`PDU ${pduLength} troppo piccola`);
  const out: ReadItem[] = [];
  for (let done = 0; done < length; done += chunk) {
    out.push({
      area,
      db,
      start: start + done,
      size: 'BYTE',
      count: Math.min(chunk, length - done),
    });
  }
  return out;
}
