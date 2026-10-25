// Controllo di una rete KOP prima della traduzione: con anche una sola diagnostica la rete non
// genera AWL. Le regole di posizione vengono da docs/linguaggi/kop-awl.md §1.3.
import { BOX_CATALOG } from './catalog.js';
import type { BoxGroup } from './catalog.js';
import { isNode } from './model.js';
import type { LadBox, LadElem, LadNetwork, LadNode, LadOut } from './model.js';

export type LadDiagCode =
  | 'NO_OUTPUT'
  | 'EMPTY_OPERAND'
  | 'EMPTY_BRANCH'
  | 'MIDLINE_ON_RAIL'
  | 'RET_ON_RAIL'
  | 'EDGE_ON_RAIL'
  | 'NOT_ON_RAIL'
  | 'FLOW_IN_BRANCH'
  | 'MUST_BE_ALONE'
  | 'BOX_IN_PARALLEL'
  | 'BOX_IN_TBRANCH'
  | 'BOX_IN_PIN'
  | 'BAD_LABEL'
  | 'BAD_INSTANCE'
  | 'TOO_MANY_LABELS';

export type LadDiag = { elemId: string; code: LadDiagCode; params?: Record<string, string> };

/** Etichetta di salto scritta dall'utente: 1–4 caratteri, il primo è una lettera (§1.3). */
export const LABEL_RE = /^[A-Za-z][A-Za-z0-9]{0,3}$/;

type Add = (elemId: string, code: LadDiagCode, params?: Record<string, string>) => void;

const blank = (s: string) => s.trim() === '';

// Istanze dei box: forma assoluta (anche con `%` davanti, come la scrive formatNetwork), simbolo
// "…" o parametro/variabile locale #… (il resto del controllo dell'operando lo fa il pacchetto awl
// sul codice generato).
const SYM = '"[^"]+"(?:\\.[^\\s,]+)?';
const LOCAL = '#[^\\s,]+';
const anyOf = (...forms: string[]) => new RegExp(`^(?:${forms.join('|')})$`, 'i');
const INSTANCE_RE: Partial<Record<BoxGroup, RegExp>> = {
  timer: anyOf('%?T\\s*\\d+', SYM, LOCAL),
  counter: anyOf('%?C\\s*\\d+', SYM, LOCAL),
  bistable: anyOf(
    '%?[IQML]\\s*\\d+\\.[0-7]',
    '(?:%?DB\\s*\\d+\\s*\\.\\s*)?%?D[BI]X\\s*\\d+\\.[0-7]',
    SYM,
    LOCAL,
  ),
  call: anyOf(
    '(?:%?S?FC\\s*\\d+|"[^"]+")',
    '(?:%?S?FB\\s*\\d+|"[^"]+")\\s*,\\s*(?:%?DB\\s*\\d+|"[^"]+")',
    LOCAL,
  ),
};

/** Istanza, pin di dati obbligatori e logica dei pin BOOL di un box. */
function checkBox(b: LadBox, add: Add): void {
  const def = BOX_CATALOG[b.box];
  const form = INSTANCE_RE[def.group];
  if (form && !form.test(b.instance.trim())) add(b.id, 'BAD_INSTANCE');
  const need = (name: string) => {
    if (blank(b.pins[name] ?? '')) add(b.id, 'EMPTY_OPERAND', { pin: name });
  };
  const logic = (name: string) => (b.boolPins[name] ?? []).length > 0;
  if (def.group === 'timer') need('TV');
  else if (def.group === 'counter' && logic('S')) need('PV');
  else if (def.en && def.kind !== 'CALL')
    [...def.dataInputs, ...def.outputs].forEach((p) => need(p.name));
  // i pin BOOL hanno logica propria che parte dalla barra; un box lì dentro non è ammesso
  const pins = def.kind === 'CALL' ? Object.keys(b.boolPins) : def.boolInputs;
  for (const name of pins) checkSeries(b.boolPins[name] ?? [], true, true, add, true);
}

/**
 * Elementi che trasformano il flusso che ricevono (NOT, (#), fronti): in un ramo parallelo
 * si traducono bene solo se il ramo parte dalla barra, perché il parallelo con logica davanti
 * diventa A( … ) e dentro la parentesi il flusso in ingresso non c'è.
 */
const FLOW_CODE = { not: 'NOT_ON_RAIL', midline: 'MIDLINE_ON_RAIL', edge: 'EDGE_ON_RAIL' } as const;

/**
 * Controlla una serie. `railInput`: la serie riceve il flusso direttamente dalla barra (niente
 * logica davanti); `inBranch`: la serie è un ramo di un parallelo; `inPin`: la serie è (o sta
 * dentro) la logica di un pin BOOL di un box.
 */
function checkSeries(
  list: LadElem[],
  inBranch: boolean,
  railInput: boolean,
  add: Add,
  inPin = false,
): void {
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
          else checkSeries(b, true, !logic, add, inPin);
        });
        break;
      case 'box':
        if (inPin) add(e.id, 'BOX_IN_PIN');
        else if (inBranch) add(e.id, 'BOX_IN_PARALLEL');
        checkBox(e, add);
        break;
    }
    logic = true;
  }
}

/** OPN, )MCR, MCRA, MCRD sono incondizionati: stanno da soli sulla barra (unica uscita della rete). */
const ALONE = new Set<LadOut['k']>(['opn', 'mcrClose', 'mcra', 'mcrd']);

function checkOut(o: LadOut, hasLogic: boolean, alone: boolean, add: Add): void {
  if (ALONE.has(o.k) && !alone) add(o.id, 'MUST_BE_ALONE');
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

function checkNode(node: LadNode, isRoot: boolean, logicBefore: boolean, add: Add): void {
  // un box alla fine della serie è un'uscita: il segmento finisce con lui (ENO o Q liberi)
  if (node.outs.length === 0 && node.series.at(-1)?.k !== 'box') add(node.id, 'NO_OUTPUT');
  // in un ramo a T un box sta solo all'inizio della serie
  if (!isRoot)
    node.series.forEach((e, i) => {
      if (e.k === 'box' && i > 0) add(e.id, 'BOX_IN_TBRANCH');
    });
  checkSeries(node.series, false, !logicBefore, add);
  const hasLogic = logicBefore || node.series.length > 0;
  const alone = isRoot && !hasLogic && node.outs.length === 1;
  for (const o of node.outs) {
    if (isNode(o)) checkNode(o, false, hasLogic, add);
    else checkOut(o, hasLogic, alone, add);
  }
}

/** Diagnostiche della rete, in ordine di documento; vuoto se la rete si può tradurre. */
export function validateNetwork(net: LadNetwork): LadDiag[] {
  const diags: LadDiag[] = [];
  const add: Add = (elemId, code, params) =>
    diags.push(params ? { elemId, code, params } : { elemId, code });
  const label = net.label?.trim();
  if (label && !LABEL_RE.test(label)) add(net.root.id, 'BAD_LABEL', { label });
  checkNode(net.root, true, false, add);
  return diags;
}
