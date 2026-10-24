import { szlIdList } from '@baaportal/s7-server';
import { dateTimeBcd } from '../obStartInfo';
import { type AnyRef, type SystemCall, type SystemHandler } from './params';

/**
 * SFC simulate. Fonte della semantica: manuale «System Software for S7-300/400 System and Standard
 * Functions» (SFC 0, 1, 20–24, 46, 47, 51, 64). I codici di RET_VAL sono quelli del manuale dove lo
 * documenta; gli altri sono marcati ⚠️ e vanno verificati su una CPU vera.
 */

// ---- Orologio (SFC 0 e 1) --------------------------------------------------------------------------

const nib = (b: number): number | undefined =>
  b >> 4 <= 9 && (b & 15) <= 9 ? (b >> 4) * 10 + (b & 15) : undefined;

/** DATE_AND_TIME in BCD → istante in ms (ora locale, come `dateTimeBcd`); `undefined` se non valido. */
function dateTimeMs(b: Uint8Array): number | undefined {
  const [yy, mo, d, h, mi, s, ms2] = [0, 1, 2, 3, 4, 5, 6].map((i) => nib(b[i]!));
  const ms1 = b[7]! >> 4;
  if ([yy, mo, d, h, mi, s, ms2].includes(undefined) || ms1 > 9) return undefined;
  // Manuale, tipo DATE_AND_TIME: anni 1990–2089 (90–99 = 19xx, 00–89 = 20xx).
  const year = yy! >= 90 ? 1900 + yy! : 2000 + yy!;
  const t = new Date(year, mo! - 1, d, h, mi, s, ms2! * 10 + ms1);
  const same =
    t.getFullYear() === year && t.getMonth() === mo! - 1 && t.getDate() === d && t.getHours() === h;
  return same && mi! < 60 && s! < 60 ? t.getTime() : undefined;
}

/** ⚠️ 16#8080: data o ora non valida (il manuale non è esplicito sul codice per SFC 0). */
const BAD_DATE = 0x8080;

const setClk: SystemHandler = (call) => {
  const ms = dateTimeMs(call.param('PDT').bytes(8));
  if (ms === undefined) return call.ret(BAD_DATE);
  call.services.setClockMs(ms);
  call.ret(0);
};

const readClk: SystemHandler = (call) => {
  call.param('CDT').bytes(8, 'write').set(dateTimeBcd(call.services.clockMs()));
  call.ret(0);
};

// ---- Copia (SFC 20 e 21) ---------------------------------------------------------------------------

/** ⚠️ 16#8091: aree sovrapposte (il manuale vieta la sovrapposizione; il codice non è verificato). */
const OVERLAP = 0x8091;

function overlaps(a: AnyRef, b: AnyRef): boolean {
  if (a.area === 'P' || b.area === 'P') return false;
  const area = (x: AnyRef): string => (x.area === 'V' ? 'L' : x.area);
  if (area(a) !== area(b)) return false;
  if ((a.area === 'DB' || a.area === 'DI') && (a.area !== b.area || a.db !== b.db)) return false;
  const [a0, b0] = [a.bit >> 3, b.bit >> 3];
  return a0 < b0 + b.length && b0 < a0 + a.length;
}

/**
 * BLKMOV: copia SRCBLK in DSTBLK. Se le lunghezze differiscono si copia la minore (⚠️ dal manuale).
 * Convalida entrambe le aree prima di scrivere: un errore non lascia scritture parziali.
 */
const blkmov: SystemHandler = (call) => {
  const [src, dst] = [call.param('SRCBLK'), call.param('DSTBLK')];
  const [a, b] = [src.any(), dst.any()];
  const from = src.anyBytes(a, 'read');
  const to = dst.anyBytes(b, 'write');
  if (overlaps(a, b)) return call.ret(OVERLAP);
  to.set(from.subarray(0, Math.min(from.length, to.length)));
  call.ret(0);
};

/** FILL: ripete BVAL in BLK; l'ultima copia è troncata se la lunghezza non è un multiplo (⚠️). */
const fill: SystemHandler = (call) => {
  const [src, dst] = [call.param('BVAL'), call.param('BLK')];
  const [a, b] = [src.any(), dst.any()];
  const from = src.anyBytes(a, 'read');
  const to = dst.anyBytes(b, 'write');
  if (overlaps(a, b)) return call.ret(OVERLAP);
  if (from.length > 0) for (let i = 0; i < to.length; i++) to[i] = from[i % from.length]!;
  call.ret(0);
};

// ---- DB (SFC 22–24) --------------------------------------------------------------------------------

/** ⚠️ Codici di SFC 22–24: numero o limiti di DB errati 16#80A1, lunghezza errata 16#80B1, DB assente / nessun numero libero 16#80B1 / 16#80B2. */
const BAD_DB_NUMBER = 0x80a1;
const BAD_LENGTH_OR_MISSING = 0x80b1;
const NO_FREE_DB = 0x80b2;

/** Lunghezza massima di un DB: parola, pari. */
const MAX_DB_BYTES = 0xfffe;

const creatDb: SystemHandler = (call) => {
  const lo = call.param('LOW_LIMIT').read('W');
  const up = call.param('UP_LIMIT').read('W');
  const count = call.param('COUNT').read('W');
  const max = call.services.maxDb;
  if (lo < 1 || lo > max || up < lo || up > max) return call.ret(BAD_DB_NUMBER);
  if (count === 0 || count % 2 !== 0 || count > MAX_DB_BYTES)
    return call.ret(BAD_LENGTH_OR_MISSING);
  const dbs = call.ctx.mem.dbs;
  let n = lo;
  while (n <= up && dbs.has(n)) n++;
  if (n > up) return call.ret(NO_FREE_DB);
  // Prima l'uscita (può fallire se il puntatore è fuori area), poi il DB: nessun DB orfano.
  call.param('DB_NUMBER').write('W', n);
  dbs.set(n, { data: new Uint8Array(count), initial: new Uint8Array(count), retentive: false });
  call.ret(0);
};

const delDb: SystemHandler = (call) => {
  const n = call.param('DB_NUMBER').read('W');
  if (n < 1 || n > call.services.maxDb) return call.ret(BAD_DB_NUMBER);
  if (!call.ctx.mem.dbs.delete(n)) return call.ret(BAD_LENGTH_OR_MISSING);
  call.ret(0);
};

const testDb: SystemHandler = (call) => {
  const n = call.param('DB_NUMBER').read('W');
  if (n < 1 || n > call.services.maxDb) return call.ret(BAD_DB_NUMBER);
  const db = call.ctx.mem.dbs.get(n);
  if (!db) return call.ret(BAD_LENGTH_OR_MISSING);
  // Prima si convalidano le due uscite, poi si scrive: nessuna scrittura parziale.
  const [length, prot] = [call.param('DB_LENGTH'), call.param('WRITE_PROT')];
  length.bytes(2, 'write');
  prot.bytes(1, 'write');
  length.write('W', db.data.length);
  // ⚠️ La CPU simulata non ha DB protetti da scrittura.
  prot.write('X', 0);
  call.ret(0);
};

// ---- STP, WAIT, TIME_TCK ---------------------------------------------------------------------------

const stp: SystemHandler = (call) => call.services.stop('SFC 46 STP');

const wait: SystemHandler = (call) => {
  const wt = call.param('WT').read('W');
  // ⚠️ Un'attesa negativa conta 0.
  call.services.wait(wt >= 0x8000 ? 0 : wt);
};

const timeTck: SystemHandler = (call) => call.ret(call.services.tickMs());

// ---- RDSYSST (SFC 51) ------------------------------------------------------------------------------

/** ⚠️ RDSYSST: 16#0081 campo di destinazione troppo corto (dati troncati), 16#8082 SZL-ID sconosciuto, 16#8083 indice sbagliato. */
const SSL_TRUNCATED = 0x0081;
const SSL_UNKNOWN_ID = 0x8082;
const SSL_BAD_INDEX = 0x8083;

/**
 * RDSYSST in modo sincrono (BUSY sempre 0). Le liste SZL vengono dal server S7 della stessa CPU
 * (`buildSzl`), quindi i byte sono quelli che un PG leggerebbe.
 */
const rdsysst: SystemHandler = (call: SystemCall) => {
  const busy = call.param('BUSY');
  // ⚠️ Con REQ = 0 non si fa niente, tranne BUSY = 0.
  if (!call.param('REQ').read('X')) {
    busy.write('X', 0);
    return call.ret(0);
  }
  const id = call.param('SSL_ID').read('W');
  const index = call.param('INDEX').read('W');
  const list = call.services.szl(id, index);
  if (!list) {
    busy.write('X', 0);
    return call.ret(szlIdList().includes(id) ? SSL_BAD_INDEX : SSL_UNKNOWN_ID);
  }
  // Tutte le uscite si risolvono prima di scrivere (BUSY compreso): un errore non lascia scritture parziali.
  busy.bytes(1, 'write');
  const header = call.param('SSL_HEADER').bytes(4, 'write');
  const dr = call.param('DR');
  const out = dr.anyBytes(dr.any(), 'write');
  // Sincrona: BUSY = 0 subito, qualunque sia l'esito.
  busy.write('X', 0);
  // Si copiano solo record interi: N_DR = quelli che stanno in DR.
  const len = list.recordLength;
  const fit = len > 0 ? Math.min(list.records.length, Math.floor(out.length / len)) : 0;
  const truncated = fit < list.records.length;
  const count = truncated ? fit : (list.declaredCount ?? list.records.length);
  header.set([len >> 8, len & 255, count >> 8, count & 255]);
  out.set(Uint8Array.from(list.records.slice(0, fit).flatMap((r) => [...r])));
  call.ret(truncated ? SSL_TRUNCATED : 0);
};

export const SFC_TABLE: Record<number, SystemHandler> = {
  0: setClk,
  1: readClk,
  20: blkmov,
  21: fill,
  22: creatDb,
  23: delDb,
  24: testDb,
  46: stp,
  47: wait,
  51: rdsysst,
  64: timeTck,
};
