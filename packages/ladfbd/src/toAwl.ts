// Traduzione di una rete KOP in AWL (mnemonici internazionali), con le forme di
// docs/linguaggi/kop-awl.md §2–§4 e le regole adottate per le ipotesi (piano 4A, Global
// Constraints). Il traduttore non interpreta gli operandi: li scrive come sono e lascia il
// controllo al pacchetto awl; la mappa delle righe riporta gli errori sugli elementi.
import { formatNetwork } from '@baaportal/awl';
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

type Parallel = Extract<LadElem, { k: 'parallel' }>;
type Contact = Extract<LadElem, { k: 'contact' }>;

/** Uscite dopo le quali l'RLO del nodo non si può più usare: devono essere le ultime del nodo. */
const DESTROYS_RLO = new Set<LadOut['k']>(['jmp', 'jmpn', 'ret', 'callCoil', 'mcrOpen']);
/** Uscite che sulla barra non hanno bisogno di un RLO (salto, chiamata, OPN, MCR). */
const RAIL_UNCONDITIONAL = new Set<LadOut['k']>([
  'jmp',
  'callCoil',
  'opn',
  'mcrClose',
  'mcra',
  'mcrd',
]);

const isContact = (e: LadElem): e is Contact => e.k === 'contact';
const contactText = (e: Contact, or: boolean) =>
  `${or ? 'O' : 'A'}${e.neg ? 'N' : ''} ${e.op.trim()}`;

class Emitter {
  readonly out: { text: string; elemId: string }[] = [];
  private nextBit: number;

  constructor(tempEnd: number) {
    this.nextBit = tempEnd * 8;
  }

  private push(elemId: string, ...texts: string[]): void {
    for (const text of texts) this.out.push({ text, elemId });
  }

  /** Prossimo bit L libero dopo i TEMP dichiarati (ipotesi H4: riparte in ogni segmento). */
  private allocBit(): string {
    const b = this.nextBit++;
    return `L ${Math.floor(b / 8)}.${b % 8}`;
  }

  // ---- serie e paralleli ----

  /** `fresh`: non c'è RLO davanti (barra o inizio di una parentesi). */
  private series(items: LadElem[], fresh: boolean): void {
    items.forEach((e, i) => this.item(e, fresh && i === 0, i === items.length - 1));
  }

  private item(e: LadElem, fresh: boolean, last: boolean): void {
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
        return this.box(e);
    }
  }

  /** Box in serie: Task 4 (riceverà anche fresh e last, come il parallelo). */
  private box(e: LadBox): void {
    throw new Error(`Box KOP ${e.box}: traduzione non ancora disponibile`);
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

  /** `fresh`: il nodo riceve il flusso dalla barra, senza logica davanti. */
  node(node: LadNode, fresh: boolean): void {
    this.series(node.series, fresh);
    if (fresh && node.series.length === 0) return this.railOuts(node.outs);
    const outs = node.outs;
    const only = outs[0];
    if (outs.length === 1 && only && isNode(only)) return this.node(only, false);
    const shared =
      outs.some(isNode) ||
      outs.some((o, i) => !isNode(o) && DESTROYS_RLO.has(o.k) && i < outs.length - 1);
    if (!shared) {
      // §2.8: le uscite che non cambiano l'RLO si scrivono una dopo l'altra
      for (const o of outs) this.output(o as LadOut, true);
      return;
    }
    // §2.10 senza BLD (ipotesi H4/H5): il nodo si salva in un bit L e ogni uscita lo rilegge
    const bit = this.allocBit();
    this.push(node.id, `= ${bit}`);
    for (const o of outs) {
      this.push(o.id, `A ${bit}`);
      if (isNode(o)) this.node(o, false);
      else this.output(o, true);
    }
  }

  /** Uscite collegate alla barra: ognuna riparte da capo; quelle che usano l'RLO hanno SET (H7). */
  private railOuts(outs: (LadOut | LadNode)[]): void {
    let rloSet = false;
    for (const o of outs) {
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
        if (!cond) throw new Error('RET senza logica davanti');
        return this.push(o.id, 'SAVE', 'BEC');
      case 'save': // §2.14
        return this.push(o.id, 'SAVE');
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
 * Traduce una rete KOP. `tempEnd`: primo byte L libero dopo i TEMP dichiarati; `firstLabel`:
 * numero della prossima etichetta automatica del blocco. Con diagnostiche `source` è vuota.
 */
export function networkToAwl(
  net: LadNetwork,
  opts: { tempEnd: number; firstLabel: number },
): NetworkAwl {
  const diagnostics = validateNetwork(net);
  if (diagnostics.length > 0)
    return { source: '', lines: [], diagnostics, nextLabel: opts.firstLabel };

  const em = new Emitter(opts.tempEnd);
  em.node(net.root, true);
  const raw = em.out.map((l) => l.text);
  if (net.label && raw.length > 0) raw[0] = `${net.label}: ${raw[0]}`;
  const plain = raw.join('\n');
  // forma canonica di formatNetwork; se un operando sbagliato cambia il numero di righe resta
  // il testo grezzo, così la mappa delle righe vale comunque
  const formatted = formatNetwork(plain, 'international');
  const source = formatted.split('\n').length === raw.length ? formatted : plain;
  return {
    source,
    lines: em.out.map((l, line) => ({ line, elemId: l.elemId })),
    diagnostics: [],
    nextLabel: opts.firstLabel,
  };
}
