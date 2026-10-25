// Equivalenza di comportamento fra la rete KOP e l'AWL generato: un valutatore del flusso di
// corrente KOP e un piccolo interprete AWL (parola di stato come packages/sim/src/ops/bitLogic.ts,
// jump.ts e control.ts) devono dare gli stessi effetti per ogni combinazione degli ingressi.
import { describe, expect, it } from 'vitest';
import { networkToAwl } from '../src/index.js';
import type { CmpFn, LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';

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
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: nid(),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNetwork => ({
  root: node(series, outs),
});

/** Interi fissi per i confronti. */
const INTS: Record<string, number> = { MW10: 3, MW12: 5, MW14: 5 };
const key = (op: string) => op.replace(/[\s%]/g, '');
const intValue = (op: string) => {
  const k = key(op);
  return k in INTS ? INTS[k]! : Number(k);
};
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

type Effects = { mem: Map<string, boolean>; calls: string[]; transfer: string; br: boolean };

// ---- valutatore KOP (flusso di corrente) ----

const isNode = (o: LadOut | LadNode): o is LadNode => 'series' in o;
const TRANSFER = new Set(['jmp', 'jmpn', 'ret']);
const DESTROY = new Set(['callCoil', 'mcrOpen', 'save']);
const hasTransfer = (o: LadOut | LadNode): boolean =>
  isNode(o) ? o.outs.some(hasTransfer) : TRANSFER.has(o.k);
/** Ordine di esecuzione atteso: uscite semplici, poi rami e CALL/SAVE, poi salti e RET. */
const order = (outs: (LadOut | LadNode)[]) =>
  outs
    .map((o, i) => ({ o, i, r: hasTransfer(o) ? 2 : isNode(o) || DESTROY.has(o.k) ? 1 : 0 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);

class Stop extends Error {}

function ladSeries(items: LadElem[], pin: boolean, fx: Effects): boolean {
  let p = pin;
  for (const e of items) {
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
        p = p && cmpTest(e.fn, intValue(e.in1), intValue(e.in2));
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
      case 'box':
        throw new Error('box non previsti');
    }
  }
  return p;
}

function ladNode(n: LadNode, pin: boolean, fx: Effects): void {
  const p = ladSeries(n.series, pin, fx);
  for (const o of order(n.outs)) {
    if (isNode(o)) {
      ladNode(o, p, fx);
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
    ladNode(n.root, true, fx);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
}

// ---- interprete AWL (sottoinsieme generato) ----

type Stw = { rlo: boolean; fc: boolean; or: boolean };
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
  for (const raw of source.split('\n')) {
    const text = raw
      .replace(/^[A-Za-z_]\w*:/, '')
      .trim()
      .replace(/;$/, '');
    const sp = text.indexOf(' ');
    const ins = sp < 0 ? text : text.slice(0, sp);
    const op = sp < 0 ? '' : text.slice(sp + 1).trim();
    const bit = () => fx.mem.get(key(op)) ?? false;
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
        accu1 = intValue(op);
        break;
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
  calls: [],
  transfer: '',
  br: false,
});
/** Effetti visibili: i bit L automatici restano fuori. */
const visible = (fx: Effects) => ({
  ...fx,
  mem: [...fx.mem].filter(([k]) => !k.startsWith('L')).sort(),
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
      const s: Stw = { rlo: rlo0, fc: false, or: false };
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
