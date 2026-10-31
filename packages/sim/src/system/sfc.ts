import { szlIdList } from '@baaportal/s7-server';
import { dateTimeBcd } from '../obStartInfo';
import { type AnyRef, type SystemCall, type SystemHandler } from './params';

/**
 * SFC simulate. Fonte della semantica: manuale «System Software for S7-300/400 System and Standard
 * Functions» (SFC 0–6, 13–15, 20–24, 28–34, 36–43, 46, 47, 49, 51, 52, 58, 59, 64). Tutte da verificare su una CPU reale. I codici di RET_VAL sono quelli del manuale dove lo
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

/** ⚠️ DEL_DB: 16#80C1 il DB è in uso (aperto nel registro DB o DI del blocco chiamante). */
const DB_IN_USE = 0x80c1;

const delDb: SystemHandler = (call) => {
  const n = call.param('DB_NUMBER').read('W');
  if (n < 1 || n > call.services.maxDb) return call.ret(BAD_DB_NUMBER);
  const { db, di } = call.ctx.regs;
  if (call.ctx.mem.dbs.has(n) && (db === n || di === n)) return call.ret(DB_IN_USE);
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

// ---- RD_SINFO (SFC 6) ------------------------------------------------------------------------------

/**
 * Manuale, 13.2 «SFC 6 RD_SINFO»: TOP_SI = primi 12 byte dei dati di avvio dell'OB in corso,
 * START_UP_SI = quelli dell'ultimo OB di avvio. Entrambe le uscite si convalidano prima di scrivere.
 */
const rdSinfo: SystemHandler = (call) => {
  const top = call.param('TOP_SI').bytes(12, 'write');
  const startUp = call.param('START_UP_SI').bytes(12, 'write');
  const info = call.services.startInfo();
  top.set(info.top);
  startUp.set(info.startUp);
  call.ret(0);
};

// ---- DP (SFC 13, 14, 15) ---------------------------------------------------------------------------

/**
 * La CPU simulata non ha slave DP: nessun modulo all'indirizzo LADDR. Manuale, 16.4 «SFC 13
 * DPNRM_DG», 16.5 «SFC 14 DPRD_DAT», 16.6 «SFC 15 DPWR_DAT»: 16#8090 = indirizzo logico non
 * configurato. Uscite (RECORD) intatte.
 */
const NO_DP_MODULE = 0x8090;
/** Manuale, SFC 13: 16#7000 = prima chiamata con REQ = 0, nessun trasferimento, BUSY = 0 (⚠️). */
const FIRST_CALL_NO_REQ = 0x7000;

const dpnrmDg: SystemHandler = (call) => {
  const req = call.param('REQ').read('X');
  call.param('BUSY').write('X', 0);
  call.ret(req ? NO_DP_MODULE : FIRST_CALL_NO_REQ);
};

const noDp: SystemHandler = (call) => call.ret(NO_DP_MODULE);

// ---- Allarmi e controllo del ciclo (SFC 41, 42, 43) ------------------------------------------------

/**
 * Manuale, 12.4 «SFC 41 DIS_AIRT»: ritarda gli allarmi di priorità più alta e gli errori asincroni
 * fino a SFC 42 o alla fine dell'OB; RET_VAL = ritardi attivi dopo la chiamata.
 */
const disAirt: SystemHandler = (call) => call.ret(call.services.delayInterrupts(1) ?? 0);

/** Manuale, 12.5 «SFC 42 EN_AIRT»: toglie un ritardo; 16#8080 se non ce n'era nessuno attivo. */
const AIRT_ALREADY_ENABLED = 0x8080;
const enAirt: SystemHandler = (call) =>
  call.ret(call.services.delayInterrupts(-1) ?? AIRT_ALREADY_ENABLED);

/** Manuale, 4.1 «SFC 43 RE_TRIGR»: riavvia il controllo del tempo di ciclo. */
const reTrigr: SystemHandler = (call) => call.services.retrigger();

// ---- Contatore di ore (SFC 2, 3, 4) ----------------------------------------------------------------

/**
 * Manuale, 6.1–6.5 «SET_RTM», «CTRL_RTM», «READ_RTM»: le CPU 31x hanno un contatore (numero 0), da 0 a
 * 32767 ore. 16#8080 numero sbagliato, 16#8081 valore negativo (SET_RTM) o superamento (READ_RTM).
 * ⚠️ Da verificare su CPU reale: il contatore si ferma in STOP e va riavviato con SFC 3 dopo l'avvio.
 */
const BAD_RTM = 0x8080;
const RTM_VALUE = 0x8081;
const HOUR_MS = 3_600_000;
const MAX_HOURS = 0x7fff;

const rtmHours = (call: SystemCall): number => {
  const r = call.services.state.rtm;
  return Math.floor((r.ms + (r.since !== undefined ? call.ctx.ctx.now() - r.since : 0)) / HOUR_MS);
};

const setRtm: SystemHandler = (call) => {
  if (call.param('NR').read('B') !== 0) return call.ret(BAD_RTM);
  const pv = call.param('PV').read('W');
  if (pv & 0x8000) return call.ret(RTM_VALUE);
  const running = call.services.state.rtm.since !== undefined;
  call.services.state.rtm = {
    ms: pv * HOUR_MS,
    ...(running ? { since: call.ctx.ctx.now() } : {}),
  };
  call.ret(0);
};

const ctrlRtm: SystemHandler = (call) => {
  if (call.param('NR').read('B') !== 0) return call.ret(BAD_RTM);
  const run = call.param('S').read('X') !== 0;
  const state = call.services.state;
  const now = call.ctx.ctx.now();
  if (!run) state.stopRtm(now);
  else if (state.rtm.since === undefined) state.rtm = { ms: state.rtm.ms, since: now };
  call.ret(0);
};

const readRtm: SystemHandler = (call) => {
  if (call.param('NR').read('B') !== 0) return call.ret(BAD_RTM);
  const [cq, cv] = [call.param('CQ'), call.param('CV')];
  cq.bytes(1, 'write');
  cv.bytes(2, 'write');
  const h = rtmHours(call);
  cq.write('X', call.services.state.rtm.since !== undefined ? 1 : 0);
  cv.write('W', Math.min(h, MAX_HOURS));
  call.ret(h > MAX_HOURS ? RTM_VALUE : 0);
};

// ---- Allarmi dall'orologio (SFC 28–31, OB10) e di ritardo (SFC 32–34, OB20) ------------------------

/** 16#8090: OB_NR non valido (la S7-300 ha solo OB10 e OB20). */
const BAD_OB = 0x8090;
/** SRT_DINT: 16#8091 DTIME fuori da 1..60000 ms; SET_TINT: 16#8091 data di partenza non valida. */
const BAD_TIME = 0x8091;
/** SET_TINT: 16#8092 PERIOD non valido. */
const BAD_PERIOD = 0x8092;
/** CAN_DINT: allarme non avviato; ACT_TINT/CAN_TINT: data di partenza non impostata. */
const NOT_SET = 0x80a0;
/** ACT_TINT: allarme «una volta» con la data già passata. */
const IN_THE_PAST = 0x80a1;

/** Manuale, 9.1: periodi di SFC 28. ⚠️ 16#2001 = alla fine del mese. */
const PERIODS = new Set([0x0000, 0x0201, 0x0401, 0x1001, 0x1201, 0x1401, 0x1801, 0x2001]);

/**
 * Prossima scadenza dopo `t` di un allarme dall'orologio, in ora locale. `undefined` se «una volta» ed
 * è già passato. ⚠️ Un giorno del mese che non esiste (31 in un mese da 30) salta quel mese.
 */
export function nextTod(start: number, period: number, t: number): number | undefined {
  if (start > t) return start;
  if (period === 0x0000) return undefined;
  if (period === 0x0201 || period === 0x0401) {
    const p = period === 0x0201 ? 60_000 : HOUR_MS;
    return start + p * (Math.floor((t - start) / p) + 1);
  }
  const s = new Date(start);
  for (let k = 1; ; k++) {
    const d = new Date(s);
    if (period === 0x1001) d.setDate(s.getDate() + k);
    else if (period === 0x1201) d.setDate(s.getDate() + 7 * k);
    else if (period === 0x2001) d.setMonth(s.getMonth() + k + 1, 0);
    else {
      // Mensile e annuale: i mesi (o gli anni) senza quel giorno si saltano.
      if (period === 0x1801) d.setFullYear(s.getFullYear() + k);
      else d.setMonth(s.getMonth() + k);
      if (d.getDate() !== s.getDate()) continue;
    }
    if (d.getTime() > t) return d.getTime();
  }
}

const obNr = (call: SystemCall, ob: number): boolean => call.param('OB_NR').read('W') === ob;

const setTint: SystemHandler = (call) => {
  if (!obNr(call, 10)) return call.ret(BAD_OB);
  const ms = dateTimeMs(call.param('SDT').bytes(8));
  const period = call.param('PERIOD').read('W');
  if (ms === undefined) return call.ret(BAD_TIME);
  if (!PERIODS.has(period)) return call.ret(BAD_PERIOD);
  // Manuale, 9.3: secondi e millisecondi della data di partenza si ignorano (valgono 0).
  const start = Math.floor(ms / 60_000) * 60_000;
  // Una nuova data disattiva l'allarme: si riattiva con SFC 30.
  call.services.state.tod.set(10, { start, period, active: false });
  call.ret(0);
};

const actTint: SystemHandler = (call) => {
  if (!obNr(call, 10)) return call.ret(BAD_OB);
  const tod = call.services.state.tod.get(10);
  if (!tod) return call.ret(NOT_SET);
  const next = nextTod(tod.start, tod.period, call.services.clockMs());
  if (next === undefined) return call.ret(IN_THE_PAST);
  tod.active = true;
  tod.next = next;
  call.ret(0);
};

const canTint: SystemHandler = (call) => {
  if (!obNr(call, 10)) return call.ret(BAD_OB);
  // Manuale, 9.4: si cancella la data di partenza; l'allarme non è più attivo.
  call.ret(call.services.state.tod.delete(10) ? 0 : NOT_SET);
};

/**
 * STATUS di SFC 31 e SFC 34 (manuale, 9.6 e 10.3, ⚠️ bit da verificare su CPU reale): bit 1 = allarme
 * bloccato da SFC 39, bit 2 = attivo, bit 4 = OB caricato; bit 0 (CPU in avvio) è sempre 0.
 */
function irqStatus(call: SystemCall, ob: number, active: boolean): number {
  const loaded = call.ctx.ctx.program.get('OB', ob) !== undefined;
  const disabled = call.services.state.disabled.has(ob);
  return (disabled ? 2 : 0) | (active ? 4 : 0) | (loaded ? 0x10 : 0);
}

const qryTint: SystemHandler = (call) => {
  if (!obNr(call, 10)) return call.ret(BAD_OB);
  const active = call.services.state.tod.get(10)?.active ?? false;
  call.param('STATUS').write('W', irqStatus(call, 10, active));
  call.ret(0);
};

/** Manuale, 10.2 «SRT_DINT»: DTIME da 1 a 60000 ms; un nuovo avvio sostituisce quello in corso. */
const srtDint: SystemHandler = (call) => {
  if (!obNr(call, 20)) return call.ret(BAD_OB);
  const dtime = call.param('DTIME').read('D') | 0;
  const sign = call.param('SIGN').read('W');
  if (dtime < 1 || dtime > 60_000) return call.ret(BAD_TIME);
  call.services.state.delay.set(20, { due: call.ctx.ctx.now() + dtime, sign, dtimeMs: dtime });
  call.ret(0);
};

const canDint: SystemHandler = (call) => {
  if (!obNr(call, 20)) return call.ret(BAD_OB);
  call.ret(call.services.state.delay.delete(20) ? 0 : NOT_SET);
};

const qryDint: SystemHandler = (call) => {
  if (!obNr(call, 20)) return call.ret(BAD_OB);
  call.param('STATUS').write('W', irqStatus(call, 20, call.services.state.delay.has(20)));
  call.ret(0);
};

// ---- Errori sincroni (SFC 36, 37, 38) --------------------------------------------------------------

/**
 * Manuale, 11.1–11.4: maschere degli errori di programmazione (PRGFLT, bit n = SW_FLT 16#20+n) e di
 * accesso (ACCFLT, bit n = 16#40+n) della classe di priorità in corso. Un errore mascherato non
 * richiama OB121/OB122: lo si annota nel registro degli errori (READ_ERR) e il programma prosegue.
 * RET_VAL 16#0001: almeno un bit era già mascherato (MSK_FLT), non mascherato (DMSK_FLT, READ_ERR).
 * ⚠️ Da verificare su CPU reale: le maschere valgono per l'esecuzione dell'OB in corso e finiscono con
 * esso; l'istruzione mascherata non scrive niente e lascia i registri com'erano.
 */
const SOME_BIT = 0x0001;

function maskOutputs(call: SystemCall, a: string, b: string): (prg: number, acc: number) => void {
  const [pa, pb] = [call.param(a), call.param(b)];
  pa.bytes(4, 'write');
  pb.bytes(4, 'write');
  return (prg, acc) => {
    pa.write('D', prg >>> 0);
    pb.write('D', acc >>> 0);
  };
}

const masksIn = (call: SystemCall, a: string, b: string): [number, number] => [
  call.param(a).read('D') >>> 0,
  call.param(b).read('D') >>> 0,
];

const mskFlt: SystemHandler = (call) => {
  const [prg, acc] = masksIn(call, 'PRGFLT_SET_MASK', 'ACCFLT_SET_MASK');
  const out = maskOutputs(call, 'PRGFLT_MASKED', 'ACCFLT_MASKED');
  const m = call.services.faults();
  const again = (m.prg & prg) !== 0 || (m.acc & acc) !== 0;
  m.prg = (m.prg | prg) >>> 0;
  m.acc = (m.acc | acc) >>> 0;
  // L'errore mascherato si gestisce al posto dell'istruzione anche senza OB121/OB122.
  call.ctx.ctx.onError ??= call.services.onFault;
  out(m.prg, m.acc);
  call.ret(again ? SOME_BIT : 0);
};

const dmskFlt: SystemHandler = (call) => {
  const [prg, acc] = masksIn(call, 'PRGFLT_RESET_MASK', 'ACCFLT_RESET_MASK');
  const out = maskOutputs(call, 'PRGFLT_MASKED', 'ACCFLT_MASKED');
  const m = call.services.faults();
  const missing = (prg & ~m.prg) !== 0 || (acc & ~m.acc) !== 0;
  m.prg = (m.prg & ~prg) >>> 0;
  m.acc = (m.acc & ~acc) >>> 0;
  out(m.prg, m.acc);
  call.ret(missing ? SOME_BIT : 0);
};

const readErr: SystemHandler = (call) => {
  const [prg, acc] = masksIn(call, 'PRGFLT_QUERY', 'ACCFLT_QUERY');
  const out = maskOutputs(call, 'PRGFLT_CLR', 'ACCFLT_CLR');
  const m = call.services.faults();
  const unmasked = (prg & ~m.prg) !== 0 || (acc & ~m.acc) !== 0;
  out(m.prgErr & prg, m.accErr & acc);
  m.prgErr = (m.prgErr & ~prg) >>> 0;
  m.accErr = (m.accErr & ~acc) >>> 0;
  call.ret(unmasked ? SOME_BIT : 0);
};

// ---- DIS_IRT, EN_IRT (SFC 39, 40) ------------------------------------------------------------------

/**
 * Manuale, 12.1–12.3: MODE 0 = tutti gli allarmi e gli errori asincroni, 1 = una classe (OB_NR 10,
 * 20, 30, 80 per OB10, OB20, OB35, OB80–86), 2 = un OB. Gli eventi bloccati **si scartano** (a
 * differenza di SFC 41). 16#8090 OB_NR non valido, 16#8091 MODE non valido. ⚠️ Da verificare su CPU
 * reale: un errore di tempo bloccato non richiama OB80, ma il secondo superamento nel ciclo dà STOP.
 */
const IRQ_OBS = [10, 20, 35, 80, 82, 85, 86];
const IRQ_CLASSES: Record<number, number[]> = {
  10: [10],
  20: [20],
  30: [35],
  80: [80, 82, 85, 86],
};
const BAD_MODE = 0x8091;

function irtObs(call: SystemCall): number[] | number {
  const mode = call.param('MODE').read('B');
  const nr = call.param('OB_NR').read('W');
  if (mode === 0) return IRQ_OBS;
  if (mode === 1) return IRQ_CLASSES[nr] ?? BAD_OB;
  if (mode === 2) return IRQ_OBS.includes(nr) ? [nr] : BAD_OB;
  return BAD_MODE;
}

const irt =
  (disable: boolean): SystemHandler =>
  (call) => {
    const obs = irtObs(call);
    if (typeof obs === 'number') return call.ret(obs);
    const set = call.services.state.disabled;
    for (const ob of obs) {
      if (disable) set.add(ob);
      else set.delete(ob);
    }
    call.ret(0);
  };

// ---- WR_USMSG (SFC 52) -----------------------------------------------------------------------------

/**
 * Manuale, 13.4 «WR_USMSG»: voce utente nel buffer di diagnostica con EVENTN (16#8xyy, 16#9xyy,
 * 16#Axyy, 16#Bxyy) e le informazioni INFO1 e INFO2. 16#8083 EVENTN non valido. ⚠️ Nessun PG è
 * iscritto ai messaggi: con SEND = 1 RET_VAL 16#0001 (voce scritta, invio non possibile); da
 * verificare su CPU reale.
 */
const BAD_EVENT = 0x8083;
const NOT_SENT = 0x0001;
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const wrUsmsg: SystemHandler = (call) => {
  const send = call.param('SEND').read('X');
  const ev = call.param('EVENTN').read('W');
  const [i1, i2] = [call.param('INFO1'), call.param('INFO2')];
  const info1 = i1.anyBytes(i1.any(), 'read');
  const info2 = i2.anyBytes(i2.any(), 'read');
  if (ev < 0x8000 || ev > 0xbfff) return call.ret(BAD_EVENT);
  const id = ev.toString(16).toUpperCase();
  call.services.userMessage(ev, `16#${id} INFO1 16#${hex(info1)} INFO2 16#${hex(info2)}`);
  call.ret(send ? NOT_SENT : 0);
};

// ---- Indirizzi e set di dati (SFC 5, 49, 58, 59) ---------------------------------------------------

/**
 * Manuale, 15.1 «GADR_LGC» e 15.2 «LGC_GADR»; 7.7 «WR_REC» e 7.8 «RD_REC». I moduli sono quelli
 * presenti della configurazione hardware. 16#8099 posto non configurato, 16#809A SUBADDR fuori dal
 * modulo (SFC 5); 16#8090 indirizzo logico non valido (SFC 49, 58, 59); 16#80B0 il modulo non
 * conosce il set di dati (SFC 58, 59: la CPU simulata non ha set di dati, ⚠️). AREA di SFC 49: 1 =
 * rack S7-300, 2 = periferia decentrata (⚠️ per una stazione RACK è il numero della stazione). Da
 * verificare su CPU reale.
 */
const SLOT_NOT_CONFIGURED = 0x8099;
const BAD_SUBADDR = 0x809a;
const BAD_LADDR = 0x8090;
const NO_RECORD = 0x80b0;
const IOID_IN = 0x54;
const IOID_OUT = 0x55;

/** Modulo e area (ingressi o uscite) che contengono l'indirizzo logico. */
function moduleAt(call: SystemCall, ioid: number, laddr: number) {
  for (const m of call.services.modules()) {
    const r = ioid === IOID_IN ? m.inputs : ioid === IOID_OUT ? m.outputs : undefined;
    if (r && laddr >= r.start && laddr < r.start + r.bytes) return { m, r };
  }
  return undefined;
}

const gadrLgc: SystemHandler = (call) => {
  const subnet = call.param('SUBNETID').read('B');
  const rack = call.param('RACK').read('W');
  const slot = call.param('SLOT').read('W');
  const sub = call.param('SUBADDR').read('W');
  const [ioid, laddr] = [call.param('IOID'), call.param('LADDR')];
  ioid.bytes(1, 'write');
  laddr.bytes(2, 'write');
  // SUBNETID 0 = rack centrale; altrimenti RACK è il numero della stazione (⚠️).
  const m = call.services
    .modules()
    .find((x) =>
      subnet === 0
        ? x.station === undefined && x.rack === rack && x.slot === slot
        : x.station === rack && x.slot === slot,
    );
  if (!m) return call.ret(SLOT_NOT_CONFIGURED);
  const r = m.inputs ?? m.outputs!;
  if (sub >= r.bytes) return call.ret(BAD_SUBADDR);
  ioid.write('B', m.inputs ? IOID_IN : IOID_OUT);
  laddr.write('W', r.start + sub);
  call.ret(0);
};

const lgcGadr: SystemHandler = (call) => {
  const hit = moduleAt(call, call.param('IOID').read('B'), call.param('LADDR').read('W'));
  const out = ['AREA', 'RACK', 'SLOT', 'SUBADDR'].map((n) => call.param(n));
  out[0]!.bytes(1, 'write');
  for (const p of out.slice(1)) p.bytes(2, 'write');
  if (!hit) return call.ret(BAD_LADDR);
  const { m, r } = hit;
  const laddr = call.param('LADDR').read('W');
  out[0]!.write('B', m.station === undefined ? 1 : 2);
  out[1]!.write('W', m.station ?? m.rack);
  out[2]!.write('W', m.slot);
  out[3]!.write('W', laddr - r.start);
  call.ret(0);
};

/** ⚠️ REQ = 0: nessun trasferimento, BUSY = 0 e RET_VAL 0. */
const dataRecord: SystemHandler = (call) => {
  const req = call.param('REQ').read('X');
  const ioid = call.param('IOID').read('B');
  const laddr = call.param('LADDR').read('W');
  call.param('BUSY').write('X', 0);
  if (!req) return call.ret(0);
  call.ret(moduleAt(call, ioid, laddr) ? NO_RECORD : BAD_LADDR);
};

export const SFC_TABLE: Record<number, SystemHandler> = {
  0: setClk,
  1: readClk,
  2: setRtm,
  3: ctrlRtm,
  4: readRtm,
  5: gadrLgc,
  6: rdSinfo,
  13: dpnrmDg,
  14: noDp,
  15: noDp,
  20: blkmov,
  21: fill,
  22: creatDb,
  23: delDb,
  24: testDb,
  28: setTint,
  29: canTint,
  30: actTint,
  31: qryTint,
  32: srtDint,
  33: canDint,
  34: qryDint,
  36: mskFlt,
  37: dmskFlt,
  38: readErr,
  39: irt(true),
  40: irt(false),
  41: disAirt,
  42: enAirt,
  43: reTrigr,
  46: stp,
  47: wait,
  49: lgcGadr,
  51: rdsysst,
  52: wrUsmsg,
  58: dataRecord,
  59: dataRecord,
  64: timeTck,
};
