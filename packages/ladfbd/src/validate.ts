// Controllo di una rete KOP prima della traduzione: con anche una sola diagnostica la rete non
// genera AWL. Le regole di posizione vengono da docs/linguaggi/kop-awl.md §1.3.
import { isNode } from './model.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from './model.js';

export type LadDiagCode =
  | 'NO_OUTPUT'
  | 'EMPTY_OPERAND'
  | 'EMPTY_BRANCH'
  | 'MIDLINE_ON_RAIL'
  | 'RET_ON_RAIL'
  | 'EDGE_ON_RAIL'
  | 'NOT_ON_RAIL'
  | 'FLOW_IN_BRANCH'
  | 'BOX_IN_PARALLEL'
  | 'BOX_IN_TBRANCH'
  | 'BAD_LABEL'
  | 'BAD_INSTANCE';

export type LadDiag = { elemId: string; code: LadDiagCode; params?: Record<string, string> };

/** Etichetta di salto scritta dall'utente: 1–4 caratteri, il primo è una lettera (§1.3). */
export const LABEL_RE = /^[A-Za-z][A-Za-z0-9]{0,3}$/;

type Add = (elemId: string, code: LadDiagCode, params?: Record<string, string>) => void;

const blank = (s: string) => s.trim() === '';

/**
 * Elementi che trasformano il flusso che ricevono (NOT, (#), fronti): in un ramo parallelo
 * si traducono bene solo se il ramo parte dalla barra, perché il parallelo con logica davanti
 * diventa A( … ) e dentro la parentesi il flusso in ingresso non c'è.
 */
const FLOW_CODE = { not: 'NOT_ON_RAIL', midline: 'MIDLINE_ON_RAIL', edge: 'EDGE_ON_RAIL' } as const;

/**
 * Controlla una serie. `railInput`: la serie riceve il flusso direttamente dalla barra (niente
 * logica davanti); `inBranch`: la serie è un ramo di un parallelo.
 */
function checkSeries(list: LadElem[], inBranch: boolean, railInput: boolean, add: Add): void {
  let logic = !railInput;
  for (const e of list) {
    switch (e.k) {
      case 'contact':
        if (blank(e.op)) add(e.id, 'EMPTY_OPERAND');
        break;
      case 'cmp':
        if (blank(e.in1) || blank(e.in2)) add(e.id, 'EMPTY_OPERAND');
        break;
      case 'posneg':
        if (blank(e.bit) || blank(e.mem)) add(e.id, 'EMPTY_OPERAND');
        break;
      case 'not':
      case 'midline':
      case 'edge':
        if ((e.k === 'midline' && blank(e.op)) || (e.k === 'edge' && blank(e.mem)))
          add(e.id, 'EMPTY_OPERAND');
        if (inBranch && !railInput) add(e.id, 'FLOW_IN_BRANCH');
        else if (!logic) add(e.id, FLOW_CODE[e.k]);
        break;
      case 'parallel':
        e.branches.forEach((b, i) => {
          if (b.length === 0) add(e.id, 'EMPTY_BRANCH', { branch: String(i) });
          else checkSeries(b, true, !logic, add);
        });
        break;
      case 'box':
        // controlli dei box: Task 4 (pin, istanza, posizione)
        break;
    }
    logic = true;
  }
}

function checkOut(o: LadOut, hasLogic: boolean, add: Add): void {
  const need = (...ops: string[]) => {
    if (ops.some(blank)) add(o.id, 'EMPTY_OPERAND');
  };
  switch (o.k) {
    case 'coil':
    case 'set':
    case 'reset':
      return need(o.op);
    case 'tcoil':
      return need(o.timer, o.value);
    case 'ccoil':
      return o.fn === 'SC' ? need(o.counter, o.value) : need(o.counter);
    case 'jmp':
    case 'jmpn':
      if (blank(o.label)) add(o.id, 'EMPTY_OPERAND');
      else if (!LABEL_RE.test(o.label.trim())) add(o.id, 'BAD_LABEL', { label: o.label });
      return;
    case 'ret':
      if (!hasLogic) add(o.id, 'RET_ON_RAIL');
      return;
    case 'callCoil':
      return need(o.block);
    case 'opn':
      return need(o.db);
    case 'save':
    case 'mcrOpen':
    case 'mcrClose':
    case 'mcra':
    case 'mcrd':
      return;
  }
}

function checkNode(node: LadNode, logicBefore: boolean, add: Add): void {
  if (node.outs.length === 0) add(node.id, 'NO_OUTPUT');
  checkSeries(node.series, false, !logicBefore, add);
  const hasLogic = logicBefore || node.series.length > 0;
  for (const o of node.outs) {
    if (isNode(o)) checkNode(o, hasLogic, add);
    else checkOut(o, hasLogic, add);
  }
}

/** Diagnostiche della rete, in ordine di documento; vuoto se la rete si può tradurre. */
export function validateNetwork(net: LadNetwork): LadDiag[] {
  const diags: LadDiag[] = [];
  const add: Add = (elemId, code, params) =>
    diags.push(params ? { elemId, code, params } : { elemId, code });
  if (net.label && !LABEL_RE.test(net.label)) add(net.root.id, 'BAD_LABEL', { label: net.label });
  checkNode(net.root, false, add);
  return diags;
}
