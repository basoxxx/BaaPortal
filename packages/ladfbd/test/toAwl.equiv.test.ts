// Equivalenza di comportamento fra la rete KOP e l'AWL generato: un valutatore del flusso di
// corrente KOP e un piccolo interprete AWL (parola di stato come packages/sim/src/ops/bitLogic.ts,
// jump.ts, control.ts e integer.ts) devono dare gli stessi effetti per ogni combinazione degli
// ingressi. I box con EN/ENO seguono il manuale (app. C.1): il box lavora solo con EN = 1 e
// ENO = EN AND NOT errore.
import { describe, expect, it } from 'vitest';
import { networkToAwl } from '../src/index.js';
import type { BoxKind, CmpFn, LadBox, LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';

// ---- costruttori ----

let seq = 0;
const nid = () => `x${++seq}`;
const c = (op: string): LadElem => ({ id: nid(), k: 'contact', neg: false, op });
const nc = (op: string): LadElem => ({ id: nid(), k: 'contact', neg: true, op });
const par = (...branches: LadElem[][]): LadElem => ({ id: nid(), k: 'parallel', branches });
const not = (): LadElem => ({ id: nid(), k: 'not' });
const mid = (op: string): LadElem => ({ id: nid(), k: 'midline', op });
const edge = (dir: 'P' | 'N', mem: string): LadElem => ({ id: nid(), k: 'edge', dir, mem });
const posneg = (dir: 'P' | 'N', bit: string, mem: string): LadElem => ({
  id: nid(),
  k: 'posneg',
  dir,
  bit,
  mem,
});
const cmp = (fn: CmpFn, in1: string, in2: string): LadElem => ({
  id: nid(),
  k: 'cmp',
  fn,
  in1,
  in2,
});
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
const out = (o: NoId<LadOut>): LadOut => ({ id: nid(), ...o }) as LadOut;
const coil = (op: string) => out({ k: 'coil', op });
const set = (op: string) => out({ k: 'set', op });
const reset = (op: string) => out({ k: 'reset', op });
const jmp = (label: string) => out({ k: 'jmp', label });
const jmpn = (label: string) => out({ k: 'jmpn', label });
const call = (block: string) => out({ k: 'callCoil', block });
const save = () => out({ k: 'save' });
const ret = () => out({ k: 'ret' });
const box = (kind: BoxKind, pins: Record<string, string>): LadBox => ({
  id: nid(),
  k: 'box',
  box: kind,
  instance: '',
  pins,
  boolPins: {},
});
const add = (in1 = 'MW 10', in2 = 'MW 12', out = 'MW 14') =>
  box('ADD_I', { IN1: in1, IN2: in2, OUT: out });
const sub = (in1: string, in2: string, out: string) =>
  box('SUB_I', { IN1: in1, IN2: in2, OUT: out });
const move = (from = 'MW 10', to = 'MW 12') => box('MOVE', { IN: from, OUT: to });
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: nid(),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNetwork => ({
  root: node(series, outs),
});

/** Valori iniziali delle parole (confronti e box); MW20 + MW22 e MW26 - MW22 vanno in overflow. */
const INTS: Record<string, number> = {
  MW10: 3,
  MW12: 5,
  MW14: 5,
  MW20: 30000,
  MW22: 10000,
  MW26: -30000,
};
const key = (op: string) => op.replace(/[\s%]/g, '');
const intValue = (op: string, fx: Effects) => fx.words.get(key(op)) ?? Number(key(op));
/** Valore INT a 16 bit con segno. */
const int16 = (v: number) => ((v + 0x8000) & 0xffff) - 0x8000;
const cmpTest = (fn: string, a: number, b: number) => {
  const rel = fn.slice(0, -1);
  return rel === '=='
    ? a === b
    : rel === '<>'
      ? a !== b
      : rel === '>'
        ? a > b
        : rel === '<'
          ? a < b
          : rel === '>='
            ? a >= b
            : a <= b;
};

type Effects = {
  mem: Map<string, boolean>;
  words: Map<string, number>;
  calls: string[];
  transfer: string;
  br: boolean;
};

// ---- valutatore KOP (flusso di corrente) ----

const isNode = (o: LadOut | LadNode): o is LadNode => 'series' in o;
const TRANSFER = new Set(['jmp', 'jmpn', 'ret']);
const DESTROY = new Set(['callCoil', 'mcrOpen', 'save']);
const hasTransfer = (o: LadOut | LadNode): boolean =>
  isNode(o) ? o.outs.some(hasTransfer) : TRANSFER.has(o.k);
const hasMcrOpen = (o: LadOut | LadNode): boolean =>
  isNode(o) ? o.outs.some(hasMcrOpen) : o.k === 'mcrOpen';
/** Ordine di esecuzione atteso: uscite semplici, poi rami e CALL/SAVE, poi MCR(, poi salti e RET. */
const rank = (o: LadOut | LadNode) =>
  hasTransfer(o) ? 3 : hasMcrOpen(o) ? 2 : isNode(o) || DESTROY.has(o.k) ? 1 : 0;
const order = (outs: (LadOut | LadNode)[]) =>
  outs
    .map((o, i) => ({ o, i, r: rank(o) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);

class Stop extends Error {}

/** Corpo di un box (eseguito solo con EN = 1); true se il box dà errore (ENO = 0). */
function ladBox(b: LadBox, fx: Effects): boolean {
  const pin = (n: string) => intValue(b.pins[n]!, fx);
  const write = (v: number) => fx.words.set(key(b.pins.OUT!), int16(v));
  switch (b.box) {
    case 'MOVE':
      write(pin('IN'));
      return false;
    case 'ADD_I':
    case 'SUB_I': {
      const r = b.box === 'ADD_I' ? pin('IN1') + pin('IN2') : pin('IN1') - pin('IN2');
      write(r);
      return int16(r) !== r;
    }
    default:
      throw new Error(`box ${b.box} non previsto`);
  }
}

/**
 * `rail`: la serie riceve il flusso direttamente dalla barra; `outsAfter`: dopo la serie ci sono
 * uscite. Servono a sapere che cosa resta in BR dopo un box: ENO se è collegato, EN se non è
 * collegato ma ha logica davanti, niente se è sulla barra e libero (§4.1).
 */
function ladSeries(
  items: LadElem[],
  pin: boolean,
  fx: Effects,
  rail = false,
  outsAfter = false,
): boolean {
  let p = pin;
  for (const [i, e] of items.entries()) {
    switch (e.k) {
      case 'contact': {
        const v = fx.mem.get(key(e.op)) ?? false;
        p = p && (e.neg ? !v : v);
        break;
      }
      case 'not':
        p = !p;
        break;
      case 'cmp':
        p = p && cmpTest(e.fn, intValue(e.in1, fx), intValue(e.in2, fx));
        break;
      case 'parallel': {
        let any = false;
        for (const b of e.branches) any = ladSeries(b, p, fx) || any;
        p = any;
        break;
      }
      case 'midline':
        fx.mem.set(key(e.op), p);
        break;
      case 'edge': {
        const prev = fx.mem.get(key(e.mem)) ?? false;
        fx.mem.set(key(e.mem), p);
        p = e.dir === 'P' ? p && !prev : !p && prev;
        break;
      }
      case 'posneg': {
        const cur = fx.mem.get(key(e.bit)) ?? false;
        const prev = fx.mem.get(key(e.mem)) ?? false;
        fx.mem.set(key(e.mem), cur);
        p = p && (e.dir === 'P' ? cur && !prev : !cur && prev);
        break;
      }
      case 'box': {
        const eno = p && !ladBox(e, fx);
        if (i < items.length - 1 || outsAfter) fx.br = eno;
        else if (!(rail && i === 0)) fx.br = p;
        p = eno;
        break;
      }
    }
  }
  return p;
}

function ladNode(n: LadNode, pin: boolean, fx: Effects, rail: boolean): void {
  const p = ladSeries(n.series, pin, fx, rail, n.outs.length > 0);
  for (const o of order(n.outs)) {
    if (isNode(o)) {
      ladNode(o, p, fx, rail && n.series.length === 0);
      continue;
    }
    switch (o.k) {
      case 'coil':
        fx.mem.set(key(o.op), p);
        break;
      case 'set':
        if (p) fx.mem.set(key(o.op), true);
        break;
      case 'reset':
        if (p) fx.mem.set(key(o.op), false);
        break;
      case 'save':
        fx.br = p;
        break;
      case 'callCoil':
        if (p) fx.calls.push(key(o.block));
        break;
      case 'jmp':
        if (p) {
          fx.transfer = o.label;
          throw new Stop();
        }
        break;
      case 'jmpn':
        if (!p) {
          fx.transfer = o.label;
          throw new Stop();
        }
        break;
      case 'ret':
        fx.br = p;
        if (p) {
          fx.transfer = 'RET';
          throw new Stop();
        }
        break;
      default:
        throw new Error(`uscita ${o.k} non prevista`);
    }
  }
}

function runLad(n: LadNetwork, fx: Effects): void {
  if (fx.transfer) return;
  try {
    ladNode(n.root, true, fx, true);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
}

// ---- interprete AWL (sottoinsieme generato) ----

/** Parola di stato; BR è `Effects.br`, così SAVE e i box si confrontano col KOP. */
type Stw = { rlo: boolean; fc: boolean; or: boolean; ov: boolean };
type Nest = { rlo: boolean; or: boolean; fc: boolean; fn: 'A' | 'O' | 'X'; negate: boolean };

function checkBit(s: Stw, fn: 'A' | 'O' | 'X', v: boolean): void {
  if (fn === 'A') s.rlo = (s.fc ? s.rlo && v : v) || s.or;
  else {
    s.rlo = s.fc ? (fn === 'O' ? s.rlo || v : s.rlo !== v) : v;
    s.or = false;
  }
  s.fc = true;
}

function runAwl(source: string, s: Stw, fx: Effects): void {
  if (fx.transfer) return;
  const nest: Nest[] = [];
  let accu1 = 0;
  let accu2 = 0;
  const end = () => {
    s.fc = false;
    s.or = false;
  };
  const lines = source.split('\n');
  // etichette automatiche: JNB salta in avanti dentro il segmento
  const labels = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = /^([A-Za-z_]\w*):/.exec(l);
    if (m) labels.set(m[1]!, i);
  });
  for (let pc = 0; pc < lines.length; pc++) {
    const raw = lines[pc]!;
    const text = raw
      .replace(/^[A-Za-z_]\w*:/, '')
      .trim()
      .replace(/;$/, '');
    const sp = text.indexOf(' ');
    const ins = sp < 0 ? text : text.slice(0, sp);
    const op = sp < 0 ? '' : text.slice(sp + 1).trim();
    // contatti di stato (bitLogic.ts): BR e OV vengono dalla parola di stato
    const bit = () => (op === 'BR' ? fx.br : op === 'OV' ? s.ov : (fx.mem.get(key(op)) ?? false));
    switch (ins) {
      case 'A':
      case 'AN':
      case 'O':
      case 'ON':
      case 'X':
      case 'XN':
        if (ins === 'O' && !op) {
          s.or = s.rlo;
          s.fc = false;
        } else checkBit(s, ins[0] as 'A' | 'O' | 'X', ins.endsWith('N') ? !bit() : bit());
        break;
      case 'A(':
      case 'AN(':
      case 'O(':
      case 'ON(':
      case 'X(':
      case 'XN(':
        nest.push({ ...s, fn: ins[0] as 'A' | 'O' | 'X', negate: ins.length === 3 });
        s.or = false;
        s.fc = false;
        break;
      case ')': {
        const e = nest.pop()!;
        const inner = e.negate ? !s.rlo : s.rlo;
        if (e.fn === 'A') s.rlo = (e.fc ? e.rlo && inner : inner) || e.or;
        else if (e.fn === 'O') s.rlo = e.fc ? e.rlo || inner : inner;
        else s.rlo = e.fc ? e.rlo !== inner : inner;
        s.or = e.or;
        s.fc = true;
        break;
      }
      case '=':
        fx.mem.set(key(op), s.rlo);
        end();
        break;
      case 'S':
      case 'R':
        if (s.rlo) fx.mem.set(key(op), ins === 'S');
        end();
        break;
      case 'NOT':
        s.rlo = !s.rlo;
        break;
      case 'SET':
      case 'CLR':
        s.rlo = ins === 'SET';
        end();
        break;
      case 'SAVE':
        fx.br = s.rlo;
        break;
      case 'NOP':
        break;
      case 'FP':
      case 'FN': {
        const cur = s.rlo;
        const prev = bit();
        fx.mem.set(key(op), cur);
        s.rlo = ins === 'FP' ? cur && !prev : !cur && prev;
        s.fc = true;
        s.or = false;
        break;
      }
      case 'L':
        accu2 = accu1;
        accu1 = intValue(op, fx);
        break;
      case 'T':
        fx.words.set(key(op), int16(accu1));
        break;
      case '+I':
      case '-I': {
        // integer.ts: risultato a 16 bit, OV se il risultato vero non ci sta
        const r = ins === '+I' ? int16(accu2) + int16(accu1) : int16(accu2) - int16(accu1);
        accu1 = int16(r);
        s.ov = accu1 !== r;
        break;
      }
      case '==I':
      case '<>I':
      case '>I':
      case '<I':
      case '>=I':
      case '<=I':
        checkBit(s, 'A', cmpTest(ins, accu2, accu1));
        s.or = false;
        break;
      case 'JU':
        fx.transfer = op;
        return;
      case 'JNB': {
        // jump.ts: l'RLO passa in BR; dopo il salto (preso o no) OR = 0, RLO = 1, /FC = 0
        const take = !s.rlo;
        fx.br = s.rlo;
        s.or = false;
        s.rlo = true;
        s.fc = false;
        if (take) {
          const to = labels.get(op);
          if (to === undefined || to <= pc) throw new Error(`etichetta ${op} non trovata`);
          pc = to - 1;
        }
        break;
      }
      case 'JC':
      case 'JCN': {
        const take = s.rlo === (ins === 'JC');
        s.or = false;
        s.rlo = true;
        s.fc = false;
        if (take) {
          fx.transfer = op;
          return;
        }
        break;
      }
      case 'BEC':
        if (s.rlo) {
          fx.transfer = 'RET';
          return;
        }
        s.or = false;
        s.rlo = true;
        s.fc = false;
        break;
      case 'CC':
      case 'UC': {
        const go = ins === 'UC' || s.rlo;
        s.or = false;
        s.fc = false;
        if (ins === 'CC') s.rlo = true;
        if (go) fx.calls.push(key(op));
        break;
      }
      default:
        throw new Error(`istruzione non prevista: ${raw}`);
    }
  }
  expect(nest).toEqual([]);
}

// ---- confronto su tutte le combinazioni ----

/** Bit il cui valore iniziale conta: contatti, memorie dei fronti, bit di S/R (= e (#) li scrivono). */
function bitOperands(nets: LadNetwork[]): string[] {
  const keys = new Set<string>();
  const list = (items: LadElem[]) => {
    for (const e of items) {
      if (e.k === 'contact' && /^[IQM]/.test(key(e.op))) keys.add(key(e.op));
      else if (e.k === 'edge') keys.add(key(e.mem));
      else if (e.k === 'posneg') keys.add(key(e.bit)).add(key(e.mem));
      else if (e.k === 'parallel') e.branches.forEach(list);
    }
  };
  const visit = (n: LadNode) => {
    list(n.series);
    for (const o of n.outs) {
      if (isNode(o)) visit(o);
      else if (o.k === 'set' || o.k === 'reset') keys.add(key(o.op));
    }
  };
  nets.forEach((n) => visit(n.root));
  return [...keys].sort();
}

const fresh = (keys: string[], combo: number): Effects => ({
  mem: new Map(keys.map((k, i) => [k, ((combo >> i) & 1) === 1])),
  words: new Map(Object.entries(INTS)),
  calls: [],
  transfer: '',
  br: false,
});
/** Effetti visibili: i bit L automatici restano fuori. */
const visible = (fx: Effects) => ({
  ...fx,
  mem: [...fx.mem].filter(([k]) => !k.startsWith('L')).sort(),
  words: [...fx.words].sort(),
});

function expectEquivalent(...nets: LadNetwork[]): void {
  const sources = nets.map((n) => {
    const r = networkToAwl(n, { tempEnd: 20, firstLabel: 1 });
    expect(r.diagnostics).toEqual([]);
    return r.source;
  });
  const keys = bitOperands(nets);
  expect(keys.length).toBeLessThanOrEqual(14);
  for (let combo = 0; combo < 1 << keys.length; combo++) {
    // l'RLO lasciato dal segmento precedente non deve contare (/FC = 0 fra i segmenti)
    for (const rlo0 of [false, true]) {
      const lad = fresh(keys, combo);
      for (const n of nets) runLad(n, lad);
      const stl = fresh(keys, combo);
      const s: Stw = { rlo: rlo0, fc: false, or: false, ov: false };
      for (const src of sources) runAwl(src, s, stl);
      if (JSON.stringify(visible(stl)) !== JSON.stringify(visible(lad)))
        expect({ combo, rlo0, awl: visible(stl), src: sources }).toEqual({
          combo,
          rlo0,
          awl: visible(lad),
          src: sources,
        });
    }
  }
}

describe('equivalenza KOP ↔ AWL generato', () => {
  it('ramo a T unico dopo un parallelo con O senza operando', () => {
    expectEquivalent(
      net([par([c('I 0.0'), c('I 0.3')], [c('I 0.1')])], [node([c('I 0.2')], [coil('Q 4.0')])]),
    );
  });

  it('dalla barra, un ramo unico con parallelo e un ramo unico dopo', () => {
    expectEquivalent(
      net(
        [],
        [
          node(
            [par([c('I 0.0'), c('I 0.1')], [nc('I 0.2')])],
            [node([c('I 0.3')], [coil('Q 4.1')])],
          ),
        ],
      ),
    );
  });

  it('parallelo con O senza operando, poi bobina e ramo a T', () => {
    expectEquivalent(
      net(
        [par([c('I 0.0'), c('I 0.1')], [c('I 0.2'), nc('I 0.3')])],
        [coil('Q 4.0'), node([c('I 0.4')], [coil('Q 4.1')])],
      ),
    );
  });

  it('ramo a T che finisce con SAVE, seguito da una bobina', () => {
    expectEquivalent(
      net(
        [c('I 0.0')],
        [node([c('I 0.1')], [save()]), coil('Q 4.0'), node([c('I 0.2')], [coil('Q 4.1')])],
      ),
    );
  });

  it('rami a T annidati con paralleli', () => {
    expectEquivalent(
      net(
        [par([c('I 0.0')], [c('I 0.1')]), c('I 0.2')],
        [
          coil('Q 4.0'),
          node(
            [par([c('I 0.3'), c('I 0.4')], [nc('I 0.5')])],
            [
              coil('Q 4.1'),
              node([par([c('I 0.6')], [c('I 0.7')])], [set('M 1.0'), reset('M 1.1')]),
            ],
          ),
          coil('Q 4.2'),
        ],
      ),
    );
  });

  it('confronto in un ramo annidato', () => {
    expectEquivalent(
      net(
        [
          c('I 0.0'),
          par([c('I 0.1')], [c('I 0.2'), par([c('I 0.3')], [cmp('>I', 'MW 12', 'MW 10')])]),
        ],
        [coil('Q 4.0')],
      ),
      net(
        [cmp('<I', 'MW 12', 'MW 10'), par([c('I 0.4')], [cmp('==I', 'MW 12', 'MW 14')])],
        [coil('Q 4.1')],
      ),
    );
  });

  it('NOT in ogni posizione ammessa', () => {
    expectEquivalent(
      net([c('I 0.0'), not(), par([c('I 0.1')], [c('I 0.2')]), not()], [coil('Q 4.0')]),
      net(
        [par([c('I 0.0'), not()], [c('I 0.1'), par([c('I 0.2')], [c('I 0.3')]), not()])],
        [coil('Q 4.1'), node([not(), c('I 0.4')], [coil('Q 4.2')])],
      ),
    );
  });

  it('(#) in ogni posizione ammessa', () => {
    expectEquivalent(
      net(
        [c('I 0.0'), mid('M 0.0'), par([c('I 0.1')], [c('I 0.2')]), mid('M 0.1')],
        [coil('Q 4.0'), node([mid('M 0.2'), c('I 0.3')], [coil('Q 4.1')])],
      ),
      net(
        [par([c('I 0.4'), mid('M 0.3'), c('I 0.5')], [c('I 0.6')]), mid('M 0.4')],
        [coil('Q 4.2')],
      ),
    );
  });

  it('fronti in linea e box POS/NEG', () => {
    expectEquivalent(
      net(
        [c('I 0.0'), edge('P', 'M 0.0')],
        [coil('Q 4.0'), node([edge('N', 'M 0.1')], [coil('Q 4.1')])],
      ),
      net(
        [posneg('P', 'I 0.1', 'M 0.2'), c('I 0.2'), posneg('N', 'I 0.3', 'M 0.3')],
        [coil('Q 4.2')],
      ),
    );
  });

  it('più uscite che distruggono l’RLO sullo stesso nodo', () => {
    expectEquivalent(
      net(
        [c('I 0.0'), nc('I 0.1')],
        [jmp('A'), call('FC 1'), coil('Q 4.0'), save(), jmpn('B'), set('M 1.0')],
      ),
    );
  });

  it('RET davanti ad altre uscite e a un ramo a T', () => {
    expectEquivalent(
      net(
        [par([c('I 0.0')], [c('I 0.1')])],
        [ret(), coil('Q 4.0'), node([c('I 0.2')], [coil('Q 4.1')])],
      ),
    );
  });

  it('salto in un ramo a T e bobine sugli altri rami', () => {
    expectEquivalent(
      net(
        [c('I 0.0')],
        [node([c('I 0.1')], [jmp('A')]), coil('Q 4.0'), node([nc('I 0.2')], [coil('Q 4.1')])],
      ),
    );
  });

  it('uscite sulla barra: JMP prima di una bobina, CALL, rami da capo', () => {
    expectEquivalent(
      net(
        [],
        [jmp('A'), coil('Q 4.0'), call('FC 2'), node([c('I 0.0')], [coil('Q 4.1')]), set('M 1.0')],
      ),
    );
  });

  it('segmento con SAVE e poi un segmento A b; = Q: nessuna traccia di /FC', () => {
    expectEquivalent(net([c('I 0.0')], [save()]), net([c('I 0.1')], [coil('Q 4.0')]));
    expectEquivalent(
      net([c('I 0.0')], [coil('Q 4.1'), save()]),
      net([c('I 0.1')], [coil('Q 4.0')]),
    );
  });
});

describe('equivalenza KOP ↔ AWL generato: box con EN/ENO', () => {
  it('ADD_I con ENO collegato e libero', () => {
    expectEquivalent(net([c('I 0.0'), add()], [coil('Q 4.0')]));
    expectEquivalent(net([c('I 0.0'), add()], []));
  });

  it('EN sulla barra con ENO collegato e libero (ADD_I e MOVE)', () => {
    expectEquivalent(net([add()], [coil('Q 4.0')]), net([move()], [coil('Q 4.1')]));
    expectEquivalent(net([add()], []), net([move()], []));
    // da soli: l'RLO lasciato dal segmento precedente (0 o 1) non deve arrivare in BR
    expectEquivalent(net([move()], [coil('Q 4.1')]));
  });

  it('box libero alla fine del segmento: il segmento dopo parte da capo (/FC = 0)', () => {
    expectEquivalent(net([c('I 0.0'), add()], []), net([c('I 0.1')], [coil('Q 4.1')]));
    expectEquivalent(net([c('I 0.0'), move()], []), net([c('I 0.1')], [coil('Q 4.1')]));
  });

  it('MOVE con logica davanti ed ENO collegato (H12)', () => {
    expectEquivalent(net([par([c('I 0.0')], [nc('I 0.1')]), move()], [coil('Q 4.0')]));
  });

  it('cascata ADD_I → MOVE, con e senza bobina', () => {
    expectEquivalent(net([c('I 0.0'), add(), move('MW 14', 'MW 16')], [coil('Q 4.0')]));
    expectEquivalent(net([c('I 0.0'), add(), move('MW 14', 'MW 16')], []));
  });

  it('box seguito da un contatto e da bobine sull’ENO', () => {
    expectEquivalent(
      net([c('I 0.0'), move(), c('I 0.1')], [coil('Q 4.0'), set('M 1.0')]),
      net([nc('I 0.2'), add()], [coil('Q 4.1'), node([c('I 0.3')], [coil('Q 4.2')])]),
    );
  });

  it('overflow: ENO = 0, OUT scritto lo stesso', () => {
    const over = () => add('MW 20', 'MW 22', 'MW 24');
    expectEquivalent(
      net([c('I 0.0'), over()], [coil('Q 4.0')]),
      net([c('I 0.1'), sub('MW 26', 'MW 22', 'MW 28')], [coil('Q 4.1')]),
      net([over()], [coil('Q 4.2')]),
    );
    expectEquivalent(net([c('I 0.0'), over(), move('MW 24', 'MW 30')], [coil('Q 4.3')]));
  });

  it('BR dopo il box: SAVE dopo l’ENO, box libero alla fine del segmento', () => {
    expectEquivalent(net([c('I 0.0'), add('MW 20', 'MW 22', 'MW 24')], [save()]));
    expectEquivalent(net([c('I 0.0'), add('MW 20', 'MW 22', 'MW 24')], []));
    expectEquivalent(net([c('I 0.0')], [save()]), net([add('MW 20', 'MW 22', 'MW 24')], []));
  });

  it('box nei rami a T (§4.10) e dalla barra', () => {
    expectEquivalent(
      net([c('I 0.0')], [node([move()], []), coil('Q 4.0'), node([add()], [coil('Q 4.1')])]),
      net([], [node([add('MW 20', 'MW 22', 'MW 24')], [coil('Q 4.2')]), node([move()], [])]),
    );
  });
});
