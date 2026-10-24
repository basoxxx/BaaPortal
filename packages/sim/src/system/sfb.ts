import { layoutInstance, type LayoutEntry } from '@baaportal/s7-types';
import type { SystemBlock } from '@baaportal/catalog';
import { SimError } from '../errors';
import { readBits, writeBits, type Location } from '../operands';
import type { SystemCall, SystemHandler } from './params';

/**
 * SFB 0–5 (manuale delle funzioni di sistema, temporizzatori e contatori IEC). I parametri stanno nel DB
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

/** Disposizione dei parametri nel DB di istanza: IN, OUT nell'ordine, come il compilatore (layoutInstance). */
function layoutOf(b: SystemBlock): Entries {
  let l = LAYOUTS.get(b);
  if (l) return l;
  const r = layoutInstance({ input: b.input, output: b.output, inOut: [], static: [] }, () => null);
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
  }

  private loc(name: string): Location {
    const e = this.entries.get(name)!;
    return {
      area: 'DI',
      db: this.call.ctx.regs.di || null,
      bit: (this.base + e.byte) * 8 + e.bit,
    };
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

export const SFB_TABLE: Record<number, SystemHandler> = {
  0: ctu,
  1: ctd,
  2: ctud,
  3: tp,
  4: ton,
  5: tof,
};
