// Visita di tutti gli operandi scritti di una rete KOP/FUP (per rinominare simboli senza toccare
// la struttura). Le etichette dei salti non sono operandi e restano come sono.
import type { LadBox, LadElem, LadNetwork, LadNode, LadOut } from './model.js';
import { isNode } from './model.js';

/** `op`: operando (anche timer, contatore, istanza SR/RS); `call`: blocco chiamato; `db`: DB di `opn`. */
export type OperandRole = 'op' | 'call' | 'db';
/** Dove sta l'operando: l'id dell'elemento e il campo (`op`, `in1`, `pin:NOME`, `instance`...). */
export type OperandAt = { id: string; field: string };
export type OperandMapper = (value: string, role: OperandRole, at: OperandAt) => string;

/**
 * Nuova rete con ogni operando passato per `fn`; gli id non cambiano e la rete di ingresso non si
 * tocca. `pinName` (facoltativo) rinomina le chiavi dei pin di un box (i parametri di una CALL).
 */
export function mapOperands(
  net: LadNetwork,
  fn: OperandMapper,
  pinName?: (box: LadBox, name: string) => string,
): LadNetwork {
  const at = (x: { id: string }, field: string): OperandAt => ({ id: x.id, field });
  const box = (b: LadBox): LadBox => {
    const pins: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.pins))
      pins[pinName ? pinName(b, k) : k] = fn(v, 'op', { id: b.id, field: `pin:${k}` });
    const boolPins: Record<string, LadElem[]> = {};
    for (const [k, v] of Object.entries(b.boolPins)) boolPins[k] = v.map(elem);
    return {
      ...b,
      instance:
        b.instance === ''
          ? b.instance
          : fn(b.instance, b.box === 'CALL' ? 'call' : 'op', { id: b.id, field: 'instance' }),
      pins,
      boolPins,
    };
  };
  const elem = (e: LadElem): LadElem => {
    switch (e.k) {
      case 'contact':
      case 'midline':
        return { ...e, op: fn(e.op, 'op', at(e, 'op')) };
      case 'cmp':
        return { ...e, in1: fn(e.in1, 'op', at(e, 'in1')), in2: fn(e.in2, 'op', at(e, 'in2')) };
      case 'edge':
        return { ...e, mem: fn(e.mem, 'op', at(e, 'mem')) };
      case 'posneg':
        return { ...e, bit: fn(e.bit, 'op', at(e, 'bit')), mem: fn(e.mem, 'op', at(e, 'mem')) };
      case 'parallel':
        return { ...e, branches: e.branches.map((r) => r.map(elem)) };
      case 'box':
        return box(e);
      case 'not':
        return e;
    }
  };
  const out = (o: LadOut): LadOut => {
    switch (o.k) {
      case 'coil':
      case 'set':
      case 'reset':
        return { ...o, op: fn(o.op, 'op', at(o, 'op')) };
      case 'tcoil':
        return {
          ...o,
          timer: fn(o.timer, 'op', at(o, 'timer')),
          value: fn(o.value, 'op', at(o, 'value')),
        };
      case 'ccoil':
        return {
          ...o,
          counter: fn(o.counter, 'op', at(o, 'counter')),
          value: fn(o.value, 'op', at(o, 'value')),
        };
      case 'callCoil':
        return { ...o, block: fn(o.block, 'call', at(o, 'block')) };
      case 'opn':
        return { ...o, db: fn(o.db, 'db', at(o, 'db')) };
      default:
        return o; // jmp, jmpn (etichetta), ret, save, mcr*
    }
  };
  const node = (n: LadNode): LadNode => ({
    ...n,
    series: n.series.map(elem),
    outs: n.outs.map((x) => (isNode(x) ? node(x) : out(x))),
  });
  return { ...net, root: node(net.root) };
}
