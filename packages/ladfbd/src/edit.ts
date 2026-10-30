// Modifiche pure alle reti KOP: ogni funzione lavora su una copia e non tocca l'argomento.
import { isNode } from './model.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from './model.js';

/** Posizione d'inserimento: serie di un nodo, ramo di un parallelo o lista di un pin BOOL di un box. */
export type InsertPoint =
  | { node: string; index: number }
  | { branchOf: string; branch: number; index: number }
  | { box: string; pin: string; index: number };

export type LadItem = LadElem | LadOut | LadNode;

type Owner =
  | { t: 'series'; node: LadNode }
  | { t: 'branch'; par: Extract<LadElem, { k: 'parallel' }>; branch: number }
  | { t: 'pin'; box: Extract<LadElem, { k: 'box' }>; pin: string };

type ElemLoc = { list: LadElem[]; index: number; owner: Owner };
type OutLoc = { parent: LadNode; index: number };

const clone = (net: LadNetwork): LadNetwork => structuredClone(net);

/** Rete vuota: nessun elemento e una bobina senza operando. */
export function emptyNetwork(newId: () => string): LadNetwork {
  return {
    root: { id: newId(), series: [], outs: [{ id: newId(), k: 'coil', op: '' }] },
  };
}

// ---- visita ----

function* walkList(list: LadElem[]): Generator<LadItem> {
  for (const e of list) {
    yield e;
    if (e.k === 'parallel') for (const b of e.branches) yield* walkList(b);
    else if (e.k === 'box') for (const l of Object.values(e.boolPins)) yield* walkList(l);
  }
}

function* walkNode(n: LadNode): Generator<LadItem> {
  yield n;
  yield* walkList(n.series);
  for (const o of n.outs) {
    if (isNode(o)) yield* walkNode(o);
    else yield o;
  }
}

/** Tutti i nodi, elementi e uscite della rete, in ordine di documento. */
export function walk(net: LadNetwork): Generator<LadItem> {
  return walkNode(net.root);
}

export function findElem(net: LadNetwork, id: string): LadItem | undefined {
  for (const it of walk(net)) if (it.id === id) return it;
  return undefined;
}

// ---- ricerca di posizioni (su una rete già clonata) ----

function locateInList(list: LadElem[], owner: Owner, id: string): ElemLoc | undefined {
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (e.id === id) return { list, index: i, owner };
    if (e.k === 'parallel') {
      for (let b = 0; b < e.branches.length; b++) {
        const r = locateInList(e.branches[b]!, { t: 'branch', par: e, branch: b }, id);
        if (r) return r;
      }
    } else if (e.k === 'box') {
      for (const [pin, l] of Object.entries(e.boolPins)) {
        const r = locateInList(l, { t: 'pin', box: e, pin }, id);
        if (r) return r;
      }
    }
  }
  return undefined;
}

function locateElem(node: LadNode, id: string): ElemLoc | undefined {
  const r = locateInList(node.series, { t: 'series', node }, id);
  if (r) return r;
  for (const o of node.outs)
    if (isNode(o)) {
      const x = locateElem(o, id);
      if (x) return x;
    }
  return undefined;
}

function locateOut(node: LadNode, id: string): OutLoc | undefined {
  for (let i = 0; i < node.outs.length; i++) {
    const o = node.outs[i]!;
    if (o.id === id) return { parent: node, index: i };
    if (isNode(o)) {
      const r = locateOut(o, id);
      if (r) return r;
    }
  }
  return undefined;
}

function findNode(node: LadNode, id: string): LadNode | undefined {
  if (node.id === id) return node;
  for (const o of node.outs)
    if (isNode(o)) {
      const r = findNode(o, id);
      if (r) return r;
    }
  return undefined;
}

function findParallel(node: LadNode, id: string): Extract<LadElem, { k: 'parallel' }> | undefined {
  const it = findElem({ root: node }, id);
  return it && 'k' in it && it.k === 'parallel' ? it : undefined;
}

function findBox(node: LadNode, id: string): Extract<LadElem, { k: 'box' }> | undefined {
  const it = findElem({ root: node }, id);
  return it && 'k' in it && it.k === 'box' ? it : undefined;
}

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`Rete KOP: ${what} non trovato`);
  return v;
}

function emptyContact(newId: () => string): LadElem {
  return { id: newId(), k: 'contact', neg: false, op: '' };
}

// ---- operazioni ----

const ELEM_KINDS = new Set([
  'contact',
  'not',
  'cmp',
  'edge',
  'posneg',
  'midline',
  'parallel',
  'box',
]);

export function insertElem(net: LadNetwork, at: InsertPoint, elem: LadElem): LadNetwork {
  // un'uscita o un nodo copiati per errore farebbero una serie non valida
  if (!ELEM_KINDS.has((elem as { k?: string }).k ?? ''))
    throw new Error(`Rete KOP: ${elem.id} non è un elemento di serie`);
  const n = clone(net);
  let list: LadElem[];
  if ('node' in at) list = must(findNode(n.root, at.node), `nodo ${at.node}`).series;
  else if ('box' in at) {
    const box = must(findBox(n.root, at.box), `box ${at.box}`);
    list = box.boolPins[at.pin] ??= [];
  } else {
    const par = must(findParallel(n.root, at.branchOf), `parallelo ${at.branchOf}`);
    list = must(par.branches[at.branch], `ramo ${at.branch} di ${at.branchOf}`);
  }
  if (!Number.isInteger(at.index) || at.index < 0 || at.index > list.length) {
    throw new Error(`Rete KOP: indice ${at.index} fuori intervallo (0..${list.length})`);
  }
  list.splice(at.index, 0, structuredClone(elem));
  return n;
}

/**
 * Apre un ramo parallelo sull'elemento. Se l'elemento è già un parallelo o sta dentro un ramo
 * di un parallelo, il nuovo ramo si aggiunge a quel parallelo; altrimenti l'elemento viene
 * avvolto in un nuovo parallelo.
 */
export function openBranch(net: LadNetwork, elemId: string, newId: () => string): LadNetwork {
  const n = clone(net);
  const loc = must(locateElem(n.root, elemId), `elemento ${elemId}`);
  const target = loc.list[loc.index]!;
  if (target.k === 'parallel') target.branches.push([emptyContact(newId)]);
  else if (loc.owner.t === 'branch') loc.owner.par.branches.push([emptyContact(newId)]);
  else {
    const id = newId();
    loc.list[loc.index] = { id, k: 'parallel', branches: [[target], [emptyContact(newId)]] };
  }
  return n;
}

/**
 * Chiude il ramo (F9) più avanti: gli elementi della serie che seguono il parallelo, fino a
 * `targetElemId` compreso, passano nel percorso principale, cioè nei rami diversi da quello che
 * contiene `branchElemId`, che li scavalca. Con più di due rami gli altri rami si raggruppano
 * prima in un parallelo annidato (serve `newId`, usato solo in quel caso). Esempio:
 * `P([c1],[nuovo]) c2 c3` chiuso su `c3` diventa `P([c1,c2,c3],[nuovo])`. Il parallelo può stare
 * in una serie, in un ramo o in un pin di un box; il bersaglio dev'essere nella stessa lista.
 */
export function closeBranchAfter(
  net: LadNetwork,
  branchElemId: string,
  targetElemId: string,
  newId: () => string,
): LadNetwork {
  const n = clone(net);
  const loc = must(locateElem(n.root, branchElemId), `elemento ${branchElemId}`);
  if (loc.owner.t !== 'branch') throw new Error(`Rete KOP: ${branchElemId} non è in un ramo`);
  const { par, branch } = loc.owner;
  const outer = must(locateElem(n.root, par.id), `parallelo ${par.id}`);
  const to = outer.list.findIndex((e) => e.id === targetElemId);
  if (to <= outer.index) {
    throw new Error(`Rete KOP: ${targetElemId} non segue il parallelo nella stessa serie`);
  }
  const moved = outer.list.splice(outer.index + 1, to - outer.index);
  const others = par.branches.filter((_, i) => i !== branch);
  const mine = par.branches[branch]!;
  if (others.length === 1) others[0]!.push(...moved);
  else {
    const inner: LadElem = { id: newId(), k: 'parallel', branches: others };
    par.branches = [[inner, ...moved], mine];
  }
  return n;
}

export function addOutput(net: LadNetwork, nodeId: string, out: LadOut | LadNode): LadNetwork {
  const n = clone(net);
  must(findNode(n.root, nodeId), `nodo ${nodeId}`).outs.push(structuredClone(out));
  return n;
}

/** Toglie un nodo a T rimasto senza uscite, risalendo finché serve; la radice resta. */
function pruneEmpty(root: LadNode, node: LadNode, newId: () => string): void {
  if (node.outs.length > 0) return;
  if (node === root) {
    node.outs.push({ id: newId(), k: 'coil', op: '' });
    return;
  }
  const loc = must(locateOut(root, node.id), `nodo ${node.id}`);
  loc.parent.outs.splice(loc.index, 1);
  pruneEmpty(root, loc.parent, newId);
}

export function removeElem(net: LadNetwork, id: string, newId: () => string): LadNetwork {
  const n = clone(net);
  if (n.root.id === id) throw new Error('Rete KOP: il nodo radice non si elimina');
  const loc = locateElem(n.root, id);
  if (loc) {
    loc.list.splice(loc.index, 1);
    if (loc.owner.t === 'branch') {
      const { par, branch } = loc.owner;
      const emptied = loc.list.length === 0;
      if (emptied) par.branches.splice(branch, 1);
      // Un parallelo con un solo ramo si scioglie nella serie che lo contiene; un gruppo
      // (un ramo solo, dopo `negateElem`) anche quando gli resta un elemento solo. Un gruppo
      // rimasto con soli NOT sparisce: sciolto, il NOT negherebbe la logica che lo precede.
      const rest = par.branches[0] ?? [];
      if (
        par.branches.length <= 1 &&
        (emptied || rest.length <= 1 || rest.every((e) => e.k === 'not'))
      ) {
        const outer = must(locateElem(n.root, par.id), `parallelo ${par.id}`);
        outer.list.splice(outer.index, 1, ...rest.filter((e) => e.k !== 'not'));
      }
    }
    return n;
  }
  const out = locateOut(n.root, id);
  if (out) {
    out.parent.outs.splice(out.index, 1);
    pruneEmpty(n.root, out.parent, newId);
    return n;
  }
  throw new Error(`Rete KOP: elemento ${id} non trovato`);
}

/**
 * Nega un'entrata che apre una logica propria (confronto, box POS/NEG, parallelo) mettendola in
 * un gruppo `[elemento, NOT]` (parallelo di un solo ramo, AWL `A(` … `NOT` `)`): il `NOT` nega
 * solo lei, non la logica che la precede. Se l'elemento è già l'unico di un gruppo con `NOT`
 * il gruppo si scioglie.
 */
export function negateElem(net: LadNetwork, id: string, newId: () => string): LadNetwork {
  const n = clone(net);
  const loc = must(locateElem(n.root, id), `elemento ${id}`);
  const e = loc.list[loc.index]!;
  if (!(e.k === 'cmp' || e.k === 'posneg' || e.k === 'parallel'))
    throw new Error(`Rete KOP: ${id} non si nega da solo`);
  loc.list[loc.index] = { id: newId(), k: 'parallel', branches: [[e, { id: newId(), k: 'not' }]] };
  return n;
}

/**
 * Patch superficiale dei campi di un elemento o di un'uscita: operandi, `pins`, `boolPins`,
 * `neg` (NA ↔ NC)… Non cambia `id` e non serve a ristrutturare la rete (rami, serie, uscite):
 * per quello ci sono le altre operazioni.
 */
export function updateElem(
  net: LadNetwork,
  id: string,
  patch: Record<string, unknown>,
): LadNetwork {
  const n = clone(net);
  const it = must(findElem(n, id), `elemento ${id}`);
  const rest = structuredClone(patch);
  delete rest.id;
  Object.assign(it, rest);
  return n;
}
