// Traduzione di una rete KOP in AWL (mnemonici internazionali), con le forme di
// docs/linguaggi/kop-awl.md §2–§4 e le regole adottate per le ipotesi (piano 4A, Global
// Constraints). Il traduttore non interpreta gli operandi: li scrive come sono e lascia il
// controllo al pacchetto awl; la mappa delle righe riporta gli errori sugli elementi.
import { formatNetwork } from '@baaportal/awl';
import { BOX_CATALOG } from './catalog.js';
import type { BoxDef } from './catalog.js';
import { isNode } from './model.js';
import type { LadBox, LadElem, LadNetwork, LadNode, LadOut } from './model.js';
import { validateNetwork } from './validate.js';
import type { LadDiag } from './validate.js';

/** Riga 0-based della sorgente generata e id dell'elemento che l'ha prodotta. */
export type LineOwner = { line: number; elemId: string };
export type NetworkAwl = {
  source: string;
  lines: LineOwner[];
  diagnostics: LadDiag[];
  nextLabel: number;
};

/** Opzioni della traduzione di una rete. */
export type NetworkAwlOpts = {
  /** Primo byte L libero dopo i TEMP dichiarati. */
  tempEnd: number;
  /** Numero della prossima etichetta automatica del blocco (`_001` = 1). */
  firstLabel: number;
  /**
   * Ordine dei parametri del blocco chiamato da un box CALL (istanza come scritta nel box, ad
   * esempio "FC 1"); senza risposta i parametri seguono l'ordine delle chiavi del box.
   */
  callParams?: (instance: string) => string[] | undefined;
};

/** Ultima etichetta automatica possibile: il formato è `_` + 3 cifre. */
const MAX_LABEL = 999;

type Parallel = Extract<LadElem, { k: 'parallel' }>;
type Contact = Extract<LadElem, { k: 'contact' }>;

/** Uscite dopo le quali l'RLO del nodo non si può più usare (SAVE è seguito da CLR). */
const DESTROYS_RLO = new Set<LadOut['k']>(['jmp', 'jmpn', 'ret', 'callCoil', 'mcrOpen', 'save']);
/** Uscite che possono saltare il resto del segmento o del blocco. */
const TRANSFERS = new Set<LadOut['k']>(['jmp', 'jmpn', 'ret']);
/** Uscite che sulla barra non hanno bisogno di un RLO (salto, chiamata; OPN e MCR solo da sole). */
const RAIL_UNCONDITIONAL = new Set<LadOut['k']>([
  'jmp',
  'callCoil',
  'opn',
  'mcrClose',
  'mcra',
  'mcrd',
]);

const isContact = (e: LadElem): e is Contact => e.k === 'contact';

function hasTransfer(o: LadOut | LadNode): boolean {
  return isNode(o) ? o.outs.some(hasTransfer) : TRANSFERS.has(o.k);
}

function hasMcrOpen(o: LadOut | LadNode): boolean {
  return isNode(o) ? o.outs.some(hasMcrOpen) : o.k === 'mcrOpen';
}

/**
 * Ordine di emissione delle uscite di un nodo (ordine stabile): prima quelle che lasciano l'RLO
 * com'è, poi i rami a T e le uscite che lo distruggono (CALL, SAVE), poi MCR( e i rami a T che lo
 * contengono (così le uscite degli altri rami non finiscono nella zona MCR che il segmento apre),
 * per ultimi i salti, RET e i rami a T che li contengono, così un salto preso non salta altre
 * uscite del nodo.
 */
function emitOrder(outs: (LadOut | LadNode)[]): (LadOut | LadNode)[] {
  const rank = (o: LadOut | LadNode) =>
    hasTransfer(o) ? 3 : hasMcrOpen(o) ? 2 : isNode(o) || DESTROYS_RLO.has(o.k) ? 1 : 0;
  return outs
    .map((o, i) => ({ o, i, r: rank(o) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);
}
const contactText = (e: Contact, or: boolean) =>
  `${or ? 'O' : 'A'}${e.neg ? 'N' : ''} ${e.op.trim()}`;

/** Nodi che proseguono la serie di `node` (un solo ramo a T, poi un solo ramo a T…), compreso lui. */
function inlineChain(node: LadNode): LadNode[] {
  const chain = [node];
  for (let n = node; n.outs.length === 1 && isNode(n.outs[0]!);) {
    n = n.outs[0] as LadNode;
    chain.push(n);
  }
  return chain;
}

/** Pin di un box CALL nell'ordine dell'interfaccia (se nota), poi gli altri nell'ordine del box. */
function callPinOrder(b: LadBox, iface: string[] | undefined): string[] {
  const own = [...new Set([...Object.keys(b.pins), ...Object.keys(b.boolPins)])];
  if (!iface) return own;
  return [...iface.filter((n) => own.includes(n)), ...own.filter((n) => !iface.includes(n))];
}

class Emitter {
  readonly out: { text: string; elemId: string }[] = [];
  readonly diagnostics: LadDiag[] = [];
  private nextBit: number;
  /** Numero della prossima etichetta automatica. */
  labelNo: number;
  /** Bit L dei pin BOOL con logica dei box CALL: id del box → pin → bit. */
  private readonly pinBits = new Map<string, Map<string, string>>();

  constructor(private readonly opts: NetworkAwlOpts) {
    this.nextBit = opts.tempEnd * 8;
    this.labelNo = opts.firstLabel;
  }

  private push(elemId: string, ...texts: string[]): void {
    for (const text of texts) this.out.push({ text, elemId });
  }

  /** Prossimo bit L libero dopo i TEMP dichiarati (ipotesi H4: riparte in ogni segmento). */
  private allocBit(): string {
    const b = this.nextBit++;
    return `L ${Math.floor(b / 8)}.${b % 8}`;
  }

  /** Etichetta automatica del blocco (ipotesi H11): `_001`…`_999`, oltre diagnostica sul box. */
  private label(boxId: string): string {
    const n = this.labelNo++;
    if (n > MAX_LABEL) this.diagnostics.push({ elemId: boxId, code: 'TOO_MANY_LABELS' });
    return `_${String(n).padStart(3, '0')}`;
  }

  // ---- serie e paralleli ----

  /**
   * `fresh`: non c'è RLO davanti (barra o inizio di una parentesi); `continues`: la serie
   * prosegue con altra logica (nodo con un solo ramo a T), quindi l'ultimo elemento non è l'ultimo;
   * `outsAfter`: dopo la serie ci sono uscite (l'ENO o il Q di un box finale è collegato).
   */
  private series(items: LadElem[], fresh: boolean, continues = false, outsAfter = false): void {
    items.forEach((e, i) => {
      const last = i === items.length - 1;
      this.item(e, fresh && i === 0, !continues && last, !last || continues || outsAfter);
    });
  }

  /** `connected`: dopo l'elemento c'è altro (serve ai box per ENO e Q). */
  private item(e: LadElem, fresh: boolean, last: boolean, connected: boolean): void {
    switch (e.k) {
      case 'contact':
        return this.push(e.id, contactText(e, false));
      case 'not':
        return this.push(e.id, 'NOT');
      case 'cmp': {
        // §3.5: il confronto scrive l'RLO, quindi con logica davanti va in A( … )
        const body = [`L ${e.in1.trim()}`, `L ${e.in2.trim()}`, e.fn];
        return this.push(e.id, ...(fresh ? body : ['A(', ...body, ')']));
      }
      case 'edge':
        return this.push(e.id, `F${e.dir} ${e.mem.trim()}`);
      case 'posneg': {
        // §2.13, ipotesi H8: il fronte si calcola sul bit, non sull'RLO della rete
        const body = [`A ${e.bit.trim()}`, `F${e.dir} ${e.mem.trim()}`];
        return this.push(e.id, ...(fresh ? body : ['A(', ...body, ')']));
      }
      case 'midline':
        // §2.9, ipotesi H3
        return this.push(e.id, `= ${e.op.trim()}`, `A ${e.op.trim()}`);
      case 'parallel':
        return this.parallel(e, fresh, last);
      case 'box':
        return this.box(e, fresh, connected);
    }
  }

  // ---- box ----

  private box(b: LadBox, fresh: boolean, connected: boolean): void {
    const def = BOX_CATALOG[b.box];
    if (def.en) this.enBox(b, def, fresh, connected);
    else this.flowBox(b, def, fresh, connected);
  }

  /**
   * Box con EN/ENO, §4.1 (quattro casi), §4.3 (ipotesi H12 per i box che non sbagliano), §4.9
   * (cascata: l'ENO del primo è l'RLO davanti al secondo), §4.11 (CALL, ipotesi H17).
   */
  private enBox(b: LadBox, def: BoxDef, fresh: boolean, connected: boolean): void {
    const isCall = def.kind === 'CALL';
    if (fresh) {
      // EN sulla barra: il corpo si esegue sempre, niente salto
      this.boxBody(b, def);
      if (!connected) this.push(b.id, 'NOP 0');
      else if (isCall) this.push(b.id, 'A BR');
      else this.push(b.id, def.canFail ? 'AN OV' : 'SET', 'SAVE', 'CLR', 'A BR');
      return;
    }
    const label = this.label(b.id);
    this.push(b.id, `JNB ${label}`);
    this.boxBody(b, def);
    if (connected && def.canFail && !isCall) this.push(b.id, 'AN OV', 'SAVE', 'CLR');
    this.push(b.id, `${label}: ${connected ? 'A BR' : 'NOP 0'}`);
  }

  /** Corpo di un box con EN/ENO: caricamenti, istruzione, trasferimenti (§4.4–§4.8, §4.11). */
  private boxBody(b: LadBox, def: BoxDef): void {
    const pin = (name: string) => (b.pins[name] ?? '').trim();
    if (def.kind === 'CALL') return this.callBody(b);
    // §4.8, ipotesi H14: N va in ACCU2, quindi si carica per primo
    const loads = def.group === 'shift' ? ['N', 'IN'] : def.dataInputs.map((p) => p.name);
    this.push(b.id, ...loads.map((n) => `L ${pin(n)}`));
    if (def.awl) this.push(b.id, def.awl);
    this.push(b.id, ...def.outputs.map((p) => `T ${pin(p.name)}`));
  }

  /** §4.11: CALL con i parametri `nome := operando`, uno per riga; i pin vuoti si omettono. */
  private callBody(b: LadBox): void {
    const instance = b.instance.trim();
    const bits = this.pinBits.get(b.id);
    const params: string[] = [];
    for (const name of callPinOrder(b, this.opts.callParams?.(instance))) {
      const value = bits?.get(name) ?? (b.pins[name] ?? '').trim();
      if (value) params.push(`${name} := ${value}`);
    }
    this.push(b.id, `CALL ${instance}`);
    if (params.length === 0) return;
    this.push(b.id, '(', ...params.map((p, i) => (i < params.length - 1 ? `${p},` : p)), ');');
  }

  /**
   * Pin BOOL con logica dei box CALL della serie di `node` e dei nodi che la proseguono: ognuno si
   * calcola prima della logica di EN in un bit L (ipotesi H18, senza BLD 103).
   */
  private callPrelude(node: LadNode): void {
    for (const n of inlineChain(node)) {
      for (const e of n.series) {
        if (e.k !== 'box' || e.box !== 'CALL') continue;
        const bits = new Map<string, string>();
        for (const [name, list] of Object.entries(e.boolPins)) {
          if (list.length === 0) continue;
          this.series(list, true);
          const bit = this.allocBit();
          this.push(e.id, `= ${bit}`);
          bits.set(name, bit);
        }
        this.pinBits.set(e.id, bits);
      }
    }
  }

  /**
   * Flip-flop (§2.12), temporizzatori (§3.2) e contatori (§3.4) a box: il primo pin prende il
   * flusso entrante, ogni altro pin BOOL ha la sua logica che parte da capo (le operazioni prima
   * azzerano /FC); poi le uscite di dati e, se collegato, Q come `A istanza`. I pin non
   * collegati tolgono la loro parte.
   */
  private flowBox(b: LadBox, def: BoxDef, fresh: boolean, connected: boolean): void {
    const inst = b.instance.trim();
    const pin = (name: string) => (b.pins[name] ?? '').trim();
    const action = (name: string): string[] => {
      if (def.group === 'timer' && name === 'S') return [`L ${pin('TV')}`, `${def.awl} ${inst}`];
      if (def.group === 'counter' && name === 'S') return [`L ${pin('PV')}`, `S ${inst}`];
      return [`${name} ${inst}`]; // S, R del flip-flop; R; CU, CD
    };
    // primo pin direttamente sulla barra: serve un RLO = 1 (come le bobine, ipotesi H7)
    if (fresh) this.push(b.id, 'SET');
    this.push(b.id, ...action(def.firstPin));
    for (const name of def.boolInputs) {
      const list = b.boolPins[name] ?? [];
      if (list.length === 0) continue;
      this.series(list, true);
      this.push(b.id, ...action(name));
    }
    for (const o of def.outputs) {
      if (o.type === 'BOOL' || !pin(o.name)) continue;
      // §3.2/§3.4: valore binario con L, valore BCD con LC
      this.push(b.id, `${o.name.includes('BCD') ? 'LC' : 'L'} ${inst}`, `T ${pin(o.name)}`);
    }
    if (connected) this.push(b.id, `A ${inst}`);
  }

  /** Regola 4: il parallelo va in A( … ) se ha logica davanti o dopo nella serie. */
  private parallel(p: Parallel, fresh: boolean, last: boolean): void {
    const wrap = !(fresh && last);
    if (wrap) this.push(p.id, 'A(');
    this.branches(p);
    if (wrap) this.push(p.id, ')');
  }

  private branches(p: Parallel): void {
    const single = (b: LadElem[]) => b.length === 1 && isContact(b[0]!);
    const simple = (b: LadElem[]) => b.every(isContact);
    if (p.branches.every(single)) {
      // regola 1: O x per ramo
      for (const b of p.branches) this.push(b[0]!.id, contactText(b[0] as Contact, true));
    } else if (p.branches.every(simple)) {
      // regola 2: A… / O / A…
      p.branches.forEach((b, i) => {
        if (i > 0) this.push(p.id, 'O');
        for (const e of b as Contact[]) this.push(e.id, contactText(e, false));
      });
    } else {
      // regola 3: i rami che non sono un contatto solo vanno in O( … )
      for (const b of p.branches) {
        if (single(b)) {
          this.push(b[0]!.id, contactText(b[0] as Contact, true));
        } else {
          this.push(p.id, 'O(');
          this.series(b, true);
          this.push(p.id, ')');
        }
      }
    }
  }

  // ---- nodi e uscite ----

  /**
   * `fresh`: il nodo riceve il flusso dalla barra, senza logica davanti; `prelude`: la logica dei
   * pin BOOL dei box CALL di questa serie non è ancora stata scritta.
   */
  node(node: LadNode, fresh: boolean, prelude = true): void {
    const only = node.outs.length === 1 ? node.outs[0] : undefined;
    const inline = only && isNode(only) ? only : undefined;
    const railOnly = fresh && node.series.length === 0;
    // dalla barra senza serie, ogni ramo riparte da capo e scrive da sé la sua logica dei pin
    if (prelude && !railOnly) this.callPrelude(node);
    this.series(node.series, fresh, inline !== undefined, node.outs.length > 0);
    if (railOnly) return this.railOuts(node.outs);
    if (inline) return this.node(inline, false, false);
    const outs = emitOrder(node.outs);
    const shared =
      outs.some(isNode) || outs.filter((o) => !isNode(o) && DESTROYS_RLO.has(o.k)).length > 1;
    if (!shared) {
      // §2.8: le uscite che non cambiano l'RLO si scrivono una dopo l'altra
      for (const o of outs) this.output(o as LadOut, true);
      return;
    }
    // §2.10 senza BLD (ipotesi H4/H5): il nodo si salva in un bit L e ogni uscita lo rilegge
    const bit = this.allocBit();
    this.push(node.id, `= ${bit}`);
    for (const o of outs) {
      if (isNode(o)) this.callPrelude(o);
      this.push(o.id, `A ${bit}`);
      if (isNode(o)) this.node(o, false, false);
      else this.output(o, true);
    }
  }

  /** Uscite collegate alla barra: ognuna riparte da capo; quelle che usano l'RLO hanno SET (H7). */
  private railOuts(outs: (LadOut | LadNode)[]): void {
    let rloSet = false;
    for (const o of emitOrder(outs)) {
      if (isNode(o)) {
        this.node(o, true);
        rloSet = false;
        continue;
      }
      if (!RAIL_UNCONDITIONAL.has(o.k) && !rloSet) {
        this.push(o.id, 'SET');
        rloSet = true;
      }
      this.output(o, false);
      if (DESTROYS_RLO.has(o.k)) rloSet = false;
    }
  }

  /** `cond`: l'uscita ha logica davanti (salto e chiamata condizionati). */
  private output(o: LadOut, cond: boolean): void {
    switch (o.k) {
      case 'coil':
        return this.push(o.id, `= ${o.op.trim()}`);
      case 'set':
        return this.push(o.id, `S ${o.op.trim()}`);
      case 'reset':
        return this.push(o.id, `R ${o.op.trim()}`);
      case 'tcoil': // §3.1
        return this.push(o.id, `L ${o.value.trim()}`, `${o.fn} ${o.timer.trim()}`);
      case 'ccoil': // §3.3
        return o.fn === 'SC'
          ? this.push(o.id, `L ${o.value.trim()}`, `S ${o.counter.trim()}`)
          : this.push(o.id, `${o.fn} ${o.counter.trim()}`);
      case 'jmp': // §4.12
        return this.push(o.id, `${cond ? 'JC' : 'JU'} ${o.label.trim()}`);
      case 'jmpn':
        return this.push(o.id, `JCN ${o.label.trim()}`);
      case 'ret': // §4.13
        if (!cond) throw new Error('invariante violata: RET senza logica davanti');
        return this.push(o.id, 'SAVE', 'BEC');
      case 'save':
        // §2.14 dà SAVE da solo; CLR in più (scostamento voluto) rimette /FC = 0, così la logica
        // che segue, nel nodo o nel segmento dopo, non si combina con l'RLO del SAVE
        return this.push(o.id, 'SAVE', 'CLR');
      case 'mcrOpen': // §4.14
        return this.push(o.id, 'MCR(');
      case 'mcrClose':
        return this.push(o.id, ')MCR');
      case 'mcra':
        return this.push(o.id, 'MCRA');
      case 'mcrd':
        return this.push(o.id, 'MCRD');
      case 'callCoil': // §4.11, ipotesi H16
        return this.push(o.id, `${cond ? 'CC' : 'UC'} ${o.block.trim()}`);
      case 'opn':
        return this.push(o.id, `OPN ${o.db.trim()}`);
    }
  }
}

/**
 * Traduce una rete KOP (vedi `NetworkAwlOpts`). Con diagnostiche `source` è vuota e nessuna
 * etichetta automatica è consumata; altrimenti `nextLabel` è il numero della prossima.
 */
export function networkToAwl(net: LadNetwork, opts: NetworkAwlOpts): NetworkAwl {
  const failed = (diagnostics: LadDiag[]): NetworkAwl => ({
    source: '',
    lines: [],
    diagnostics,
    nextLabel: opts.firstLabel,
  });
  const diagnostics = validateNetwork(net);
  if (diagnostics.length > 0) return failed(diagnostics);

  const em = new Emitter(opts);
  em.node(net.root, true);
  if (em.diagnostics.length > 0) return failed(em.diagnostics);
  const raw = em.out.map((l) => l.text);
  const label = net.label?.trim();
  if (label && raw.length > 0) raw[0] = `${label}: ${raw[0]}`;
  const plain = raw.join('\n');
  // forma canonica di formatNetwork; se un operando sbagliato cambia il numero di righe resta
  // il testo grezzo, così la mappa delle righe vale comunque
  const formatted = formatNetwork(plain, 'international');
  const source = formatted.split('\n').length === raw.length ? formatted : plain;
  return {
    source,
    lines: em.out.map((l, line) => ({ line, elemId: l.elemId })),
    diagnostics: [],
    nextLabel: em.labelNo,
  };
}
