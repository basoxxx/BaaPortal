// Osservazione di una rete KOP/FUP: dallo stato per riga dell'AWL generato (simulatore o CPU)
// allo stato di ogni elemento del grafico. La forma dell'AWL è quella di `networkToAwl`: i
// contatti si leggono dal loro STA (stato dell'operando), gli altri elementi dall'RLO dopo
// la loro ultima riga (quella che dà l'uscita), le uscite e i nodi ricevono il flusso della serie
// davanti. Una riga senza cella (non chiesta, fuori finestra, in attesa) lascia lo stato sconosciuto.
import { BOX_CATALOG } from './catalog.js';
import { isNode } from './model.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from './model.js';
import type { LineOwner } from './toAwl.js';

/** Stato dopo un'istruzione della riga; `null` = chiesta ma non elaborata in questo ciclo. */
export type LineState = { rlo: boolean; sta: boolean; accu1: number } | null;

/**
 * Stato di un elemento (o di un nodo). Un elemento senza voce, o con `unknown`, ha stato
 * sconosciuto; `notRun`: la sua ultima riga è stata chiesta ma non elaborata. `in`/`out`: flusso in
 * entrata e in uscita (ENO o Q di un box; per le uscite e i nodi coincidono); `undefined` se non si
 * può dire.
 */
export type ElemStatus = {
  /** L'ultima riga dell'elemento non ha cella: si sa al più il flusso davanti e qualche valore. */
  unknown?: true;
  /** L'ultima riga dell'elemento è chiesta e non elaborata nel ciclo. */
  notRun?: true;
  in?: boolean;
  out?: boolean;
  /** Stato dell'operando di un contatto. */
  sta?: boolean;
  /** Flusso dei pin BOOL d'ingresso di un box (EN o primo pin, pin con logica). */
  pins?: Record<string, boolean>;
  /** ACCU1 sulla riga che carica o trasferisce il pin (o il campo `in1`, `in2`, `value`). */
  values?: Record<string, number>;
};

type Flow = boolean | undefined;

/**
 * `nullUnknown`: una cella `null` non dice «non elaborata» (risposta parziale della CPU, segnaposto
 * della finestra in attesa di risposta) e vale come assente.
 */
export function networkStatus(
  net: LadNetwork,
  lines: readonly LineOwner[],
  cells: ReadonlyMap<number, LineState>,
  opts: { nullUnknown?: boolean } = {},
): Map<string, ElemStatus> {
  const owned = new Map<string, LineOwner[]>();
  for (const l of lines) {
    const list = owned.get(l.elemId);
    if (list) list.push(l);
    else owned.set(l.elemId, [l]);
  }
  const out = new Map<string, ElemStatus>();
  /**
   * Stato dopo l'ultima riga dell'elemento, la sola che ne dà l'uscita (una riga prima ha un RLO
   * intermedio): `undefined` sconosciuto, `null` non elaborata.
   */
  const outLine = (id: string): LineState | undefined => {
    const own = owned.get(id);
    const c = own && cells.get(own[own.length - 1]!.line);
    return c === null && opts.nullUnknown ? undefined : c;
  };
  const known = (id: string) => {
    const s = out.get(id);
    return s !== undefined && !s.unknown && !s.notRun;
  };
  const valuesOf = (id: string): Record<string, number> | undefined => {
    let v: Record<string, number> | undefined;
    for (const l of owned.get(id) ?? []) {
      const c = l.pin === undefined ? undefined : cells.get(l.line);
      if (c) (v ??= {})[l.pin!] = c.accu1;
    }
    return v;
  };
  const and = (ctx: Flow, v: boolean) => ctx !== false && v;

  /**
   * `ctx`: flusso davanti al contesto AWL della serie che l'RLO non contiene (il flusso di
   * ingresso del parallelo per un suo ramo, `true` altrove); `connected`: dopo la serie c'è altro.
   */
  function series(list: LadElem[], flow: Flow, ctx: Flow, connected: boolean): Flow {
    list.forEach((e, i) => (flow = elem(e, flow, ctx, i < list.length - 1 || connected)));
    return flow;
  }

  function elem(e: LadElem, flow: Flow, ctx: Flow, connected: boolean): Flow {
    if (e.k === 'parallel') {
      // ogni ramo riparte dal flusso davanti al parallelo; l'uscita è l'OR dei rami
      const outs = e.branches.map((b) => series(b, flow, flow, false));
      // un ramo sconosciuto lascia sconosciuto l'OR, se nessun altro ramo dà 1
      const res = outs.includes(true) ? true : outs.includes(undefined) ? undefined : false;
      if (res !== undefined)
        out.set(e.id, { ...(flow !== undefined ? { in: flow } : {}), out: res });
      else if (e.branches.flat().some((x) => out.get(x.id)?.notRun))
        out.set(e.id, { notRun: true });
      return res;
    }
    const run = outLine(e.id);
    const st: ElemStatus = run === null ? { notRun: true } : flow !== undefined ? { in: flow } : {};
    if (run === undefined) st.unknown = true;
    if (e.k === 'contact') {
      if (run) {
        st.sta = run.sta;
        st.out = flow !== false && run.sta !== e.neg;
      }
    } else if (e.k === 'box') {
      const def = BOX_CATALOG[e.box];
      const pins: Record<string, boolean> = {};
      const first = def.en ? 'EN' : def.firstPin;
      if (flow !== undefined && first) pins[first] = flow;
      // la logica dei pin si visita sempre, così i suoi elementi hanno il loro stato
      for (const [name, list] of Object.entries(e.boolPins)) {
        if (list.length === 0) continue;
        const p = series(list, true, true, false);
        if (p !== undefined) pins[name] = p;
      }
      if (run !== null && Object.keys(pins).length > 0) st.pins = pins;
      // ENO/Q non collegato: l'AWL non lo calcola (NOP 0)
      if (run && connected) st.out = and(ctx, run.rlo);
    } else if (run) {
      st.out = and(ctx, run.rlo);
    }
    const v = run === null ? undefined : valuesOf(e.id);
    if (v) st.values = v;
    out.set(e.id, st);
    return st.out;
  }

  function output(o: LadOut, flow: Flow): void {
    const run = outLine(o.id);
    const st: ElemStatus =
      run === null
        ? { notRun: true }
        : run === undefined
          ? { unknown: true }
          : flow !== undefined
            ? { in: flow, out: flow }
            : {};
    const v = run === null ? undefined : valuesOf(o.id);
    if (v) st.values = v;
    out.set(o.id, st);
  }

  function node(n: LadNode, flow: Flow): void {
    const p = series(n.series, flow, true, n.outs.length > 0);
    for (const o of n.outs) {
      if (isNode(o)) node(o, p);
      else output(o, p);
    }
    // il nodo è elaborato se lo è qualcosa di suo (una serie vuota sulla barra non dice nulla)
    const kids = [...n.series, ...n.outs];
    if (p !== undefined && kids.some((x) => known(x.id))) out.set(n.id, { in: p, out: p });
    else if (kids.some((x) => out.get(x.id)?.notRun)) out.set(n.id, { notRun: true });
  }

  node(net.root, true);
  return out;
}
