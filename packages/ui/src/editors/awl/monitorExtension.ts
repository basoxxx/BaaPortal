import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** Riga della mappa di compilazione: istruzione MC7 → riga del testo della rete (da 0). */
export interface LineMapRow {
  offset: number;
  length: number;
  network: number;
  line: number;
}

/** Stato dopo un'istruzione, come lo manda il simulatore (`MonitorStep`, senza AR e DB). */
export interface MonitorStepLike {
  offset: number;
  rlo: boolean;
  sta: boolean;
  stw: number;
  accu1: number;
  accu2: number;
}

export interface MonitorCell {
  rlo: boolean;
  sta: boolean;
  stw: number;
  accu1: number;
  accu2: number;
}

/**
 * Valori da mostrare nel testo di una rete, per riga (da 0): `null` = riga non eseguita in questo
 * ciclo (grigia, senza valori). Le righe senza istruzioni (commenti, righe vuote) non compaiono.
 */
export interface MonitorLines {
  hex: boolean;
  cells: ReadonlyMap<number, MonitorCell | null>;
}

/** ACCU come esadecimale a 8 cifre o come decimale con segno (DINT). */
export function formatAccu(v: number, hex: boolean): string {
  const u = v >>> 0;
  return hex ? u.toString(16).toUpperCase().padStart(8, '0') : String(u | 0);
}

/** Parola di stato in 9 bit (BR … /FC, da sinistra a destra). */
export const formatStw = (w: number): string => (w & 0x1ff).toString(2).padStart(9, '0');

/**
 * Dai passi del simulatore ai valori per riga di ogni rete. Una riga con più voci (una `CALL`
 * espansa) è eseguita se lo è una qualsiasi, e mostra lo stato dopo l'ultima istruzione eseguita.
 */
export function monitorLinesByNetwork(
  map: readonly LineMapRow[],
  steps: readonly MonitorStepLike[],
  hex: boolean,
): Map<number, MonitorLines> {
  const byOffset = new Map<number, MonitorStepLike>();
  for (const s of steps) byOffset.set(s.offset, s);
  const out = new Map<number, MonitorLines>();
  // Per ogni riga, l'ultima voce eseguita (le voci sono in ordine di offset, ma non lo si presume).
  const last = new Map<number, Map<number, { offset: number; step: MonitorStepLike } | null>>();
  for (const e of map) {
    let rows = last.get(e.network);
    if (!rows) {
      rows = new Map();
      last.set(e.network, rows);
    }
    const step = byOffset.get(e.offset);
    const prev = rows.get(e.line);
    if (step) {
      if (!prev || e.offset > prev.offset) rows.set(e.line, { offset: e.offset, step });
    } else if (prev === undefined) rows.set(e.line, null);
  }
  for (const [network, rows] of last) {
    const cells = new Map<number, MonitorCell | null>();
    for (const [line, hit] of rows) {
      const s = hit?.step;
      cells.set(
        line,
        s ? { rlo: s.rlo, sta: s.sta, stw: s.stw, accu1: s.accu1, accu2: s.accu2 } : null,
      );
    }
    out.set(network, { hex, cells });
  }
  return out;
}

/** Imposta (o toglie, con `null`) i valori mostrati. */
export const setMonitorLines = StateEffect.define<MonitorLines | null>();

class CellWidget extends WidgetType {
  constructor(
    private readonly c: MonitorCell,
    private readonly hex: boolean,
  ) {
    super();
  }
  override eq(o: CellWidget): boolean {
    return o.hex === this.hex && JSON.stringify(o.c) === JSON.stringify(this.c);
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'baa-mon-cell';
    el.setAttribute('aria-hidden', 'true');
    const part = (label: string, value: string) => {
      const s = document.createElement('span');
      s.className = 'baa-mon-part';
      s.textContent = `${label} ${value}`;
      el.append(s);
    };
    part('RLO', this.c.rlo ? '1' : '0');
    part('STA', this.c.sta ? '1' : '0');
    part('ACCU1', formatAccu(this.c.accu1, this.hex));
    part('ACCU2', formatAccu(this.c.accu2, this.hex));
    part('STW', formatStw(this.c.stw));
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const offLine = Decoration.line({ class: 'baa-mon-off' });
const onLine = Decoration.line({ class: 'baa-mon-on' });

function build(doc: EditorView['state']['doc'], m: MonitorLines): DecorationSet {
  const ranges = [];
  for (const [i, cell] of m.cells) {
    if (i < 0 || i >= doc.lines) continue;
    const line = doc.line(i + 1);
    if (!cell) {
      ranges.push(offLine.range(line.from));
      continue;
    }
    ranges.push(onLine.range(line.from));
    ranges.push(Decoration.widget({ widget: new CellWidget(cell, m.hex), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

/**
 * Valori di osservazione a fine riga. Le posizioni sono quelle del testo da cui sono stati
 * calcolati: una modifica del testo li toglie, finché non ne arrivano di nuovi.
 */
const monitorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setMonitorLines)) return e.value ? build(tr.state.doc, e.value) : Decoration.none;
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function monitorExtension(): Extension {
  return monitorField;
}
