import { layoutInstance, type LayoutEntry } from '@baaportal/s7-types';
import type { SystemBlock } from '@baaportal/catalog';
import { SimError } from '../errors';
import { readBits, writeBits, type Location } from '../operands';
import type { SystemCall, SystemHandler } from './params';

/**
 * SFB 0–5 e 32 (manuale delle funzioni di sistema, temporizzatori e contatori IEC; DRUM sotto). I parametri stanno nel DB
 * di istanza aperto in DI, all'offset AR2 (multi-istanza); lo stato interno (memorie dei fronti, istanti
 * di avvio) sta nella CPU, indicizzato da (DI, offset AR2), perché il manuale non documenta statici di
 * questi SFB (R4 del piano).
 */

/** Stato interno di un'istanza: memorie dei fronti e fase del temporizzatore. */
export interface SfbState {
  prevIn: boolean;
  prevCu: boolean;
  prevCd: boolean;
  /** Impulso (TP) o ritardo di spegnimento (TOF) in corso. */
  active: boolean;
  /** TON in conteggio. */
  running: boolean;
  /** TP/TOF concluso: ET resta a PT finché l'ingresso lo consente. */
  done: boolean;
  /** Istante di avvio, in ms dell'orologio di CPU (`tickMs`). */
  start: number;
}

const MS_WRAP = 2 ** 31;
const INT_MIN = -32768;
const INT_MAX = 32767;

type Entries = Map<string, LayoutEntry>;
const LAYOUTS = new WeakMap<SystemBlock, Entries>();

/** Disposizione dei parametri nel DB di istanza: IN, OUT e statici documentati, come il compilatore (layoutInstance). */
function layoutOf(b: SystemBlock): Entries {
  let l = LAYOUTS.get(b);
  if (l) return l;
  const r = layoutInstance(
    { input: b.input, output: b.output, inOut: [], static: b.static ?? [] },
    () => null,
  );
  if (!r.ok) throw new SimError('MC7_NON_ESEGUIBILE', `${b.name}: disposizione non calcolabile`);
  LAYOUTS.set(b, (l = new Map(r.entries.map((e) => [e.path, e]))));
  return l;
}

/** Accesso ai parametri di un'istanza. */
class Instance {
  readonly key: string;
  private readonly entries: Entries;
  private readonly base: number;

  constructor(private readonly call: SystemCall) {
    const regs = call.ctx.regs;
    this.entries = layoutOf(call.block);
    // AR2: byte nei bit 3–18 (le altre parti sono l'area del puntatore).
    this.base = (regs.ar2 & 0x7ffff) >>> 3;
    this.key = `${regs.di}:${this.base}`;
    // Ogni parametro dell'istanza deve stare nel DB: un'istanza corta è un errore di programmazione
    // prima di toccare stato e uscite (nessuna scrittura parziale, nessun fronte perso).
    const mem = call.ctx.ctx.mem;
    for (const e of this.entries.values())
      mem.bytes('DI', regs.di || null, this.base + e.byte, Math.ceil((e.bit + e.sizeBits) / 8));
  }

  /** `index`: elemento di un array (contato da 0 sugli indici, l'ultimo più rapido). */
  private loc(name: string, index = 0): Location {
    const e = this.entries.get(name)!;
    return {
      area: 'DI',
      db: this.call.ctx.regs.di || null,
      bit: (this.base + e.byte) * 8 + e.bit + index * (e.strideBits ?? 0),
    };
  }

  /** Valore senza segno (BYTE, WORD, DWORD o BOOL), anche di un elemento di array. */
  get(name: string, size: 'X' | 'B' | 'W' | 'D', index = 0): number {
    return readBits(this.call.ctx.ctx.mem, this.loc(name, index), size) >>> 0;
  }
  set(name: string, size: 'X' | 'B' | 'W' | 'D', v: number): void {
    writeBits(this.call.ctx.ctx.mem, this.loc(name), size, v >>> 0);
  }

  bool(name: string): boolean {
    return readBits(this.call.ctx.ctx.mem, this.loc(name), 'X') !== 0;
  }
  int(name: string): number {
    return (readBits(this.call.ctx.ctx.mem, this.loc(name), 'W') << 16) >> 16;
  }
  time(name: string): number {
    return readBits(this.call.ctx.ctx.mem, this.loc(name), 'D') | 0;
  }
  setBool(name: string, v: boolean): void {
    writeBits(this.call.ctx.ctx.mem, this.loc(name), 'X', v ? 1 : 0);
  }
  setInt(name: string, v: number): void {
    writeBits(this.call.ctx.ctx.mem, this.loc(name), 'W', v & 0xffff);
  }
  setTime(name: string, v: number): void {
    writeBits(this.call.ctx.ctx.mem, this.loc(name), 'D', v >>> 0);
  }
}

function stateOf(call: SystemCall, key: string): SfbState {
  const map = call.services.sfbState;
  let s = map.get(key);
  if (!s) {
    s = {
      prevIn: false,
      prevCu: false,
      prevCd: false,
      active: false,
      running: false,
      done: false,
      start: 0,
    };
    map.set(key, s);
  }
  return s;
}

/** PT negativo: ⚠️ il manuale non lo descrive, si tratta come 0. */
const ptOf = (i: Instance): number => Math.max(0, i.time('PT'));
const elapsed = (call: SystemCall, s: SfbState): number =>
  (((call.services.tickMs() - s.start) % MS_WRAP) + MS_WRAP) % MS_WRAP;

/** Prologo comune: istanza, stato e ingresso IN. */
function timer(
  call: SystemCall,
  body: (s: SfbState, inp: boolean, pt: number) => { q: boolean; et: number },
): void {
  const i = new Instance(call);
  const s = stateOf(call, i.key);
  const inp = i.bool('IN');
  const pt = ptOf(i);
  const r = body(s, inp, pt);
  s.prevIn = inp;
  i.setBool('Q', r.q);
  i.setTime('ET', r.et);
}

/** SFB 3 TP: impulso di durata PT sul fronte di salita, non riavviabile. */
const tp: SystemHandler = (call) =>
  timer(call, (s, inp, pt) => {
    if (!s.active && !s.done && inp && !s.prevIn) {
      s.active = true;
      s.start = call.services.tickMs();
    }
    if (s.active) {
      const el = elapsed(call, s);
      if (el < pt) return { q: true, et: el };
      s.active = false;
      s.done = true;
    }
    if (s.done) {
      if (inp) return { q: false, et: pt };
      s.done = false;
    }
    return { q: false, et: 0 };
  });

/** SFB 4 TON: Q = 1 dopo PT con IN = 1. */
const ton: SystemHandler = (call) =>
  timer(call, (s, inp, pt) => {
    if (!inp) {
      s.running = false;
      s.done = false;
      return { q: false, et: 0 };
    }
    // Concluso: Q e ET restano fissi finché IN = 1, senza rileggere l'orologio (che può girare oltre 2^31 ms).
    if (s.done) return { q: true, et: pt };
    if (!s.running) {
      s.running = true;
      s.start = call.services.tickMs();
    }
    const el = elapsed(call, s);
    if (el < pt) return { q: false, et: el };
    s.done = true;
    return { q: true, et: pt };
  });

/** SFB 5 TOF: Q = 1 con IN = 1; Q = 0 dopo PT dal fronte di discesa. */
const tof: SystemHandler = (call) =>
  timer(call, (s, inp, pt) => {
    if (inp) {
      s.active = false;
      s.done = false;
      return { q: true, et: 0 };
    }
    if (s.prevIn && !s.active) {
      s.active = true;
      s.done = false;
      s.start = call.services.tickMs();
    }
    if (s.active) {
      const el = elapsed(call, s);
      if (el < pt) return { q: true, et: el };
      s.active = false;
      s.done = true;
    }
    return { q: false, et: s.done ? pt : 0 };
  });

const sat = (v: number): number => Math.min(INT_MAX, Math.max(INT_MIN, v));

/** SFB 0 CTU. */
const ctu: SystemHandler = (call) => {
  const i = new Instance(call);
  const s = stateOf(call, i.key);
  const cu = i.bool('CU');
  let cv = i.int('CV');
  if (i.bool('R')) cv = 0;
  else if (cu && !s.prevCu) cv = sat(cv + 1);
  s.prevCu = cu;
  i.setInt('CV', cv);
  i.setBool('Q', cv >= i.int('PV'));
};

/** SFB 1 CTD. */
const ctd: SystemHandler = (call) => {
  const i = new Instance(call);
  const s = stateOf(call, i.key);
  const cd = i.bool('CD');
  let cv = i.int('CV');
  if (i.bool('LOAD')) cv = i.int('PV');
  else if (cd && !s.prevCd) cv = sat(cv - 1);
  s.prevCd = cd;
  i.setInt('CV', cv);
  i.setBool('Q', cv <= 0);
};

/** SFB 2 CTUD: R prevale su LOAD; due fronti insieme si annullano. */
const ctud: SystemHandler = (call) => {
  const i = new Instance(call);
  const s = stateOf(call, i.key);
  const cu = i.bool('CU');
  const cd = i.bool('CD');
  const up = cu && !s.prevCu;
  const down = cd && !s.prevCd;
  let cv = i.int('CV');
  if (i.bool('R')) cv = 0;
  else if (i.bool('LOAD')) cv = i.int('PV');
  else if (up && !down) cv = sat(cv + 1);
  else if (down && !up) cv = sat(cv - 1);
  s.prevCu = cu;
  s.prevCd = cd;
  i.setInt('CV', cv);
  i.setBool('QU', cv >= i.int('PV'));
  i.setBool('QD', cv <= 0);
};

/**
 * SFB 32 DRUM: sequenziatore fino a 16 passi (manuale «System Software for S7-300/400 System and
 * Standard Functions», 05/2010, 14.7). Tutto lo stato è nei dati statici documentati dell'istanza
 * (JOG_HIS, EOD, DSP, DSC, DCC, DTBP, PREV_TIME, S_PRESET, OUT_VAL, S_MASK). Si passa al passo
 * seguente con un fronte di JOG o, con DRUM_EN = 1, quando EVENTi del passo è a 1 e il tempo
 * DTBP × S_PRESET[i] è scaduto; DCC cala solo con EVENTi a 1. Nell'ultimo passo il fronte di JOG
 * (o il tempo scaduto) porta Q = EOD = 1 e DCC = 0 fino a RESET. Uscita j: OUT_VAL[i, j] se
 * S_MASK[i, j] = 1, altrimenti il valore del passo precedente.
 * ⚠️ da verificare su CPU reale: le uscite si ricalcolano a ogni richiamo (non solo al cambio di
 * passo); EVENTi letto al richiamo vale per tutto il tempo trascorso dal richiamo precedente; il
 * tempo avanzato oltre lo scadere non passa al passo seguente; con un errore nulla cambia (anche
 * JOG_HIS e PREV_TIME); DSP oltre LST_STEP è 16#8083; DSC fuori da DSP..LST_STEP è 16#8082.
 * 16#8084 non può capitare: DTBP e S_PRESET sono WORD, il prodotto sta sempre in 32 bit.
 */
const drum: SystemHandler = (call) => {
  const i = new Instance(call);
  const now = call.services.tickMs();
  const reset = i.bool('RESET');
  const last = i.get('LST_STEP', 'B');
  const dsp = i.get('DSP', 'B');
  let dsc = reset ? dsp : i.get('DSC', 'B');
  const err =
    last < 1 || last > 16
      ? 0x8081
      : dsp < 1 || dsp > last
        ? 0x8083
        : dsc < dsp || dsc > last
          ? 0x8082
          : 0;
  i.set('ERR_CODE', 'W', err);
  if (err) return;
  const jog = i.bool('JOG');
  const edge = jog && !i.bool('JOG_HIS');
  const presetOf = (step: number) => i.get('DTBP', 'W') * i.get('S_PRESET', 'W', step - 1);
  let eod = !reset && i.bool('EOD');
  let dcc = reset ? presetOf(dsc) : i.get('DCC', 'D');
  const next = () => {
    if (dsc < last) dcc = presetOf(++dsc);
    else [eod, dcc] = [true, 0];
  };
  if (!reset && !eod) {
    if (edge) next();
    else if (i.bool('DRUM_EN') && i.bool(`EVENT${dsc}`)) {
      const dt = (((now - i.get('PREV_TIME', 'D')) % MS_WRAP) + MS_WRAP) % MS_WRAP;
      dcc = Math.max(0, dcc - dt);
      if (dcc === 0) next();
    }
  }
  let word = 0;
  for (let j = 0; j < 16; j++) {
    const k = (dsc - 1) * 16 + j;
    const v = i.get('S_MASK', 'X', k) ? i.get('OUT_VAL', 'X', k) : i.get(`OUT${j}`, 'X');
    i.setBool(`OUT${j}`, v === 1);
    word |= v << j;
  }
  i.set('OUT_WORD', 'W', word);
  i.setBool('Q', eod);
  i.setBool('EOD', eod);
  i.set('DSC', 'B', dsc);
  i.set('DCC', 'D', dcc);
  i.setBool('JOG_HIS', jog);
  i.set('PREV_TIME', 'D', now);
};

export const SFB_TABLE: Record<number, SystemHandler> = {
  0: ctu,
  1: ctd,
  2: ctud,
  3: tp,
  4: ton,
  5: tof,
  32: drum,
};
