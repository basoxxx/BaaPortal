// Funzioni pure dell'editor KOP: dove sta un elemento, quali campi si modificano, elementi nuovi.
import { BOX_CATALOG, isNode } from '@baaportal/ladfbd';
import type {
  BoxKind,
  InsertPoint,
  LadBox,
  LadElem,
  LadNetwork,
  LadNode,
  LadOut,
} from '@baaportal/ladfbd';

export type Place =
  | { t: 'elem'; nodeId: string; index: number; at: (index: number) => InsertPoint }
  | { t: 'out'; nodeId: string };

function scan(
  list: LadElem[],
  at: (index: number) => InsertPoint,
  nodeId: string,
  id: string,
): Place | undefined {
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (e.id === id) return { t: 'elem', nodeId, index: i, at };
    if (e.k === 'parallel') {
      for (let b = 0; b < e.branches.length; b++) {
        const r = scan(
          e.branches[b]!,
          (index) => ({ branchOf: e.id, branch: b, index }),
          nodeId,
          id,
        );
        if (r) return r;
      }
    } else if (e.k === 'box') {
      for (const [pin, l] of Object.entries(e.boolPins)) {
        const r = scan(l, (index) => ({ box: e.id, pin, index }), nodeId, id);
        if (r) return r;
      }
    }
  }
  return undefined;
}

function scanNode(node: LadNode, id: string): Place | undefined {
  const r = scan(node.series, (index) => ({ node: node.id, index }), node.id, id);
  if (r) return r;
  for (const o of node.outs) {
    if (o.id === id) return { t: 'out', nodeId: node.id };
    if (isNode(o)) {
      const x = scanNode(o, id);
      if (x) return x;
    }
  }
  return undefined;
}

/** Dove sta l'elemento o l'uscita `id` (nodo che lo contiene e punto d'inserimento). */
export function placeOf(net: LadNetwork, id: string): Place | undefined {
  return scanNode(net.root, id);
}

export function findNodeById(node: LadNode, id: string): LadNode | undefined {
  if (node.id === id) return node;
  for (const o of node.outs)
    if (isNode(o)) {
      const r = findNodeById(o, id);
      if (r) return r;
    }
  return undefined;
}

/** Nodo a cui appartiene un punto d'inserimento. */
export function nodeOfPoint(net: LadNetwork, at: InsertPoint): string | undefined {
  if ('node' in at) return at.node;
  const p = placeOf(net, 'branchOf' in at ? at.branchOf : at.box);
  return p?.nodeId;
}

/** Campo modificabile di un elemento: chiave nel modello e chiave i18n dell'etichetta. */
export type LadField = { key: string; label: string; pin?: boolean };

const f = (key: string): LadField => ({ key, label: `lad.field.${key}` });

/** Campi (operandi) di un elemento, nell'ordine in cui si scorrono con Tab. */
export function fieldsOf(e: LadElem | LadOut): LadField[] {
  switch (e.k) {
    case 'contact':
    case 'midline':
    case 'coil':
    case 'set':
    case 'reset':
      return [f('op')];
    case 'cmp':
      return [f('in1'), f('in2')];
    case 'edge':
      return [f('mem')];
    case 'posneg':
      return [f('bit'), f('mem')];
    case 'tcoil':
      return [f('timer'), f('value')];
    case 'ccoil':
      return e.fn === 'SC' ? [f('counter'), f('value')] : [f('counter')];
    case 'jmp':
    case 'jmpn':
      return [f('label')];
    case 'callCoil':
      return [f('block')];
    case 'opn':
      return [f('db')];
    case 'box':
      return boxFields(e);
    default:
      return [];
  }
}

/** Nome del pin di flusso (ENO o Q): non ha operando. */
export function flowPin(kind: BoxKind): string {
  const def = BOX_CATALOG[kind];
  return def.en ? 'ENO' : (def.outputs.find((o) => o.name === 'Q')?.name ?? '');
}

function boxFields(b: LadBox): LadField[] {
  const def = BOX_CATALOG[b.box];
  const out: LadField[] = [];
  if (['bistable', 'timer', 'counter', 'call'].includes(def.group) || b.instance !== '')
    out.push(f('instance'));
  const names = def.dynamicPins
    ? Object.keys(b.pins)
    : [...def.dataInputs, ...def.outputs.filter((o) => o.name !== flowPin(b.box))].map(
        (p) => p.name,
      );
  for (const n of names) out.push({ key: n, label: n, pin: true });
  return out;
}

export function fieldValue(e: LadElem | LadOut, fld: LadField): string {
  if (e.k === 'box') return fld.pin ? (e.pins[fld.key] ?? '') : e.instance;
  const v = (e as Record<string, unknown>)[fld.key];
  return typeof v === 'string' ? v : '';
}

/** Patch per `updateElem` che cambia un campo. */
export function fieldPatch(
  e: LadElem | LadOut,
  fld: LadField,
  value: string,
): Record<string, unknown> {
  if (e.k === 'box')
    return fld.pin ? { pins: { ...e.pins, [fld.key]: value } } : { instance: value };
  return { [fld.key]: value };
}

/** Operando principale (il primo campo) o `undefined` se l'elemento non ne ha. */
export function primaryOperand(e: LadElem | LadOut): string | undefined {
  const [first] = fieldsOf(e);
  return first ? fieldValue(e, first) : undefined;
}

export function newBox(kind: BoxKind, id: string): LadBox {
  return { id, k: 'box', box: kind, instance: '', pins: {}, boolPins: {} };
}

/** Id della voce di palette (e quindi dell'etichetta `lad.palette.<id>`) di un elemento. */
export function paletteIdOf(e: LadElem | LadOut): string {
  switch (e.k) {
    case 'contact':
      return e.neg ? 'contactNc' : 'contactNo';
    case 'edge':
      return e.dir === 'P' ? 'edgeP' : 'edgeN';
    case 'posneg':
      return e.dir === 'P' ? 'pos' : 'neg';
    case 'tcoil':
      return `timer${e.fn}`;
    case 'ccoil':
      return `counter${e.fn}`;
    default:
      return e.k;
  }
}
