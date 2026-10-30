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

export type CallParam = { name: string; dir: 'in' | 'out' | 'inout'; type: string };
/** Parametri del blocco chiamato da un box CALL (dall'interfaccia del blocco), se l'istanza è nota. */
export type CallParams = (instance: string) => CallParam[] | undefined;
/** Gli ingressi BOOL prendono la logica del pin (slot), non un operando. */
const isBoolInput = (p: CallParam) => p.dir === 'in' && p.type.toUpperCase() === 'BOOL';

/** Campo modificabile di un elemento: chiave nel modello e chiave i18n dell'etichetta. */
export type LadField = { key: string; label: string; pin?: boolean };

const f = (key: string): LadField => ({ key, label: `lad.field.${key}` });

/** Campi (operandi) di un elemento, nell'ordine in cui si scorrono con Tab. */
export function fieldsOf(e: LadElem | LadOut, callParams?: CallParams): LadField[] {
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
      return boxFields(e, callParams);
    default:
      return [];
  }
}

/** Nome del pin di flusso (ENO o Q): non ha operando. */
export function flowPin(kind: BoxKind): string {
  const def = BOX_CATALOG[kind];
  return def.en ? 'ENO' : (def.outputs.find((o) => o.name === 'Q')?.name ?? '');
}

function boxFields(b: LadBox, callParams?: CallParams): LadField[] {
  const def = BOX_CATALOG[b.box];
  const out: LadField[] = [];
  if (['bistable', 'timer', 'counter', 'call'].includes(def.group) || b.instance !== '')
    out.push(f('instance'));
  const params = def.dynamicPins ? callParams?.(b.instance) : undefined;
  const names = def.dynamicPins
    ? params
      ? params.filter((p) => !isBoolInput(p)).map((p) => p.name)
      : Object.keys(b.pins)
    : [...def.dataInputs, ...def.outputs.filter((o) => o.name !== flowPin(b.box))].map(
        (p) => p.name,
      );
  for (const n of names) out.push({ key: n, label: n, pin: true });
  return out;
}

/**
 * Pin di dati vuoto di un box CALL: per un FB (`"FB", "DB"`, `FB 1, DB 1`, multi-istanza `#x`) è
 * facoltativo, perché resta il valore nell'istanza; per una FC o SFC è obbligatorio (il controllo
 * AWL dà CALL_PARAM_MISSING). `undefined` se il pin ha un operando o il box non è una CALL.
 */
export function callPinHint(b: LadBox, pin: string): 'optional' | 'required' | undefined {
  if (b.box !== 'CALL' || !(pin in b.pins) || b.pins[pin]!.trim() !== '') return undefined;
  const inst = b.instance.trim();
  return inst.includes(',') || inst.startsWith('#') ? 'optional' : 'required';
}

export function fieldValue(e: LadElem | LadOut, fld: LadField): string {
  if (e.k === 'box') return fld.pin ? (e.pins[fld.key] ?? '') : e.instance;
  const v = (e as Record<string, unknown>)[fld.key];
  return typeof v === 'string' ? v : '';
}

/**
 * Patch per `updateElem` che cambia un campo. Cambiando l'istanza di un CALL con `callParams`,
 * i pin del blocco chiamato che mancano si aggiungono vuoti (gli ingressi BOOL come logica di pin).
 */
export function fieldPatch(
  e: LadElem | LadOut,
  fld: LadField,
  value: string,
  callParams?: CallParams,
): Record<string, unknown> {
  if (e.k !== 'box') return { [fld.key]: value };
  if (fld.pin) return { pins: { ...e.pins, [fld.key]: value } };
  const patch: Record<string, unknown> = { instance: value };
  const params = e.box === 'CALL' ? callParams?.(value) : undefined;
  if (params) {
    const pins = { ...e.pins };
    const boolPins = { ...e.boolPins };
    for (const p of params) {
      if (isBoolInput(p)) boolPins[p.name] ??= [];
      else pins[p.name] ??= '';
    }
    patch.pins = pins;
    patch.boolPins = boolPins;
  }
  return patch;
}

/** Lista di elementi (serie, ramo o pin) che contiene l'elemento `id`. */
export function listOf(net: LadNetwork, id: string): LadElem[] | undefined {
  const inList = (list: LadElem[]): LadElem[] | undefined => {
    for (const e of list) {
      if (e.id === id) return list;
      if (e.k === 'parallel') {
        for (const b of e.branches) {
          const r = inList(b);
          if (r) return r;
        }
      } else if (e.k === 'box') {
        for (const l of Object.values(e.boolPins)) {
          const r = inList(l);
          if (r) return r;
        }
      }
    }
    return undefined;
  };
  const inNode = (n: LadNode): LadElem[] | undefined => {
    const r = inList(n.series);
    if (r) return r;
    for (const o of n.outs) {
      if (isNode(o)) {
        const x = inNode(o);
        if (x) return x;
      }
    }
    return undefined;
  };
  return inNode(net.root);
}

/**
 * Per chiudere un ramo dopo l'elemento `id` (F9): primo elemento dell'ultimo ramo del parallelo
 * più vicino che lo precede nella stessa serie, cioè l'argomento `branchElemId` di
 * `closeBranchAfter`. `undefined` se prima di `id` non c'è nessun parallelo.
 */
export function branchToClose(net: LadNetwork, id: string): string | undefined {
  const list = listOf(net, id);
  if (!list) return undefined;
  for (let i = list.findIndex((e) => e.id === id) - 1; i >= 0; i--) {
    const e = list[i]!;
    if (e.k === 'parallel') return e.branches[e.branches.length - 1]?.[0]?.id;
  }
  return undefined;
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

/** Elementi contigui della stessa serie fra `a` e `b` inclusi (ordine del modello); `undefined` se stanno in liste diverse. */
export function rangeBetween(net: LadNetwork, a: string, b: string): string[] | undefined {
  const list = listOf(net, a);
  if (!list || list !== listOf(net, b)) return undefined;
  const i = list.findIndex((e) => e.id === a);
  const j = list.findIndex((e) => e.id === b);
  return list.slice(Math.min(i, j), Math.max(i, j) + 1).map((e) => e.id);
}

/** Copia profonda di un elemento con id nuovi (anche negli elementi che contiene). */
export function cloneFresh(e: LadElem, newId: () => string): LadElem {
  const c = structuredClone(e);
  const renew = (x: LadElem): void => {
    x.id = newId();
    if (x.k === 'parallel') x.branches.forEach((b) => b.forEach(renew));
    else if (x.k === 'box') Object.values(x.boolPins).forEach((l) => l.forEach(renew));
  };
  renew(c);
  return c;
}
