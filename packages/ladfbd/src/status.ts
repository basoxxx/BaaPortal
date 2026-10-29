// Osservazione di una rete KOP/FUP: dallo stato per riga dell'AWL generato (simulatore o CPU)
// allo stato di ogni elemento del grafico. La forma dell'AWL è quella di `networkToAwl`: i
// contatti si leggono dal loro STA (stato dell'operando), gli altri elementi dall'RLO dopo
// l'ultima loro riga eseguita, le uscite e i nodi ricevono il flusso della serie davanti.
import { BOX_CATALOG } from './catalog.js';
import { isNode } from './model.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from './model.js';
import type { LineOwner } from './toAwl.js';

/** Stato dopo un'istruzione della riga; `null` = chiesta ma non elaborata in questo ciclo. */
export type LineState = { rlo: boolean; sta: boolean; accu1: number } | null;

/**
 * Stato di un elemento (o di un nodo) elaborato. Un elemento senza voce non è stato elaborato
 * (o la sua riga non è stata chiesta). `in`/`out`: flusso in entrata e in uscita (ENO o Q di un
 * box; per le uscite e i nodi coincidono); `undefined` se non si può dire.
 */
export type ElemStatus = {
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

export function networkStatus(
  net: LadNetwork,
  lines: readonly LineOwner[],
  cells: ReadonlyMap<number, LineState>,
): Map<string, ElemStatus> {
  const owned = new Map<string, LineOwner[]>();
  for (const l of lines) {
    const list = owned.get(l.elemId);
    if (list) list.push(l);
    else owned.set(l.elemId, [l]);
  }
  const out = new Map<string, ElemStatus>();
  /** Stato dopo l'ultima riga eseguita dell'elemento. */
  const lastRun = (id: string) => {
    const own = owned.get(id) ?? [];
    for (let i = own.length - 1; i >= 0; i--) {
      const c = cells.get(own[i]!.line);
      if (c) return c;
    }
    return undefined;
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
      if (outs.every((o) => o === undefined)) return undefined;
      const res = outs.some((o) => o === true);
      out.set(e.id, { ...(flow !== undefined ? { in: flow } : {}), out: res });
      return res;
    }
    const run = lastRun(e.id);
    if (!run) return undefined;
    const st: ElemStatus = flow !== undefined ? { in: flow } : {};
    if (e.k === 'contact') {
      st.sta = run.sta;
      st.out = flow !== false && run.sta !== e.neg;
    } else if (e.k === 'box') {
      const def = BOX_CATALOG[e.box];
      const pins: Record<string, boolean> = {};
      const first = def.en ? 'EN' : def.firstPin;
      if (flow !== undefined && first) pins[first] = flow;
      for (const [name, list] of Object.entries(e.boolPins)) {
        if (list.length === 0) continue;
        const p = series(list, true, true, false);
        if (p !== undefined) pins[name] = p;
      }
      if (Object.keys(pins).length > 0) st.pins = pins;
      // ENO/Q non collegato: l'AWL non lo calcola (NOP 0)
      if (connected) st.out = and(ctx, run.rlo);
    } else {
      st.out = and(ctx, run.rlo);
    }
    const v = valuesOf(e.id);
    if (v) st.values = v;
    out.set(e.id, st);
    return st.out;
  }

  function output(o: LadOut, flow: Flow): void {
    const own = owned.get(o.id) ?? [];
    if (!own.some((l) => cells.get(l.line))) return;
    const st: ElemStatus = flow !== undefined ? { in: flow, out: flow } : {};
    const v = valuesOf(o.id);
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
    const seen = [...n.series, ...n.outs].some((x) => out.has(x.id));
    if (p !== undefined && seen) out.set(n.id, { in: p, out: p });
  }

  node(net.root, true);
  return out;
}
