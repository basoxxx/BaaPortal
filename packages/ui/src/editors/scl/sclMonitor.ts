// Osservazione di un blocco SCL: a fine riga i valori assegnati o controllati (`sclLineStatus`),
// righe non elaborate in grigio, righe senza dati («fuori dalla finestra o in attesa») con un «?».
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { SclLineStatus, SclValue } from '@baaportal/scl';
import { t } from '../../i18n';
import { formatAccu } from '../awl/monitorExtension';
import { formatPinValue } from '../lad/ladMonitor';

/** Stato osservato per riga SCL (da 1) e formato dei numeri. */
export type SclMonitor = { status: ReadonlyMap<number, SclLineStatus>; hex: boolean };

/** Un valore nel suo tipo; `?` sconosciuto, `–` non elaborato (altra istruzione della riga). */
export function sclValueText(v: SclValue, hex: boolean): string {
  const c = v.cell;
  if (c === undefined) return '?';
  if (c === null) return '–';
  if (v.ty === 'BOOL') return c.rlo ? 'TRUE' : 'FALSE';
  if (v.ty === 'DWORD') return `16#${formatAccu(c.accu1, true)}`;
  return formatPinValue(c.accu1, v.ty, hex);
}

/** Il testo a fine riga e quello per `title`/`aria-label`; `undefined` se non c'è niente da dire. */
export function sclLineText(
  st: SclLineStatus,
  hex: boolean,
): { shown: string; full: string } | undefined {
  if (st.state === 'notRun') return { shown: t('lad.mon.none'), full: t('lad.mon.none') };
  if (st.state === 'unknown') return { shown: '?', full: t('lad.mon.outside') };
  if (st.values.length === 0) return undefined;
  const shown = st.values.map((v) => sclValueText(v, hex)).join('   ');
  return { shown, full: shown };
}

/** Imposta (o toglie, con `null`) i valori mostrati. */
export const setSclMonitor = StateEffect.define<SclMonitor | null>();

class ValueWidget extends WidgetType {
  constructor(private readonly text: { shown: string; full: string }) {
    super();
  }
  override eq(o: ValueWidget): boolean {
    return o.text.shown === this.text.shown && o.text.full === this.text.full;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'baa-mon-cell baa-scl-mon';
    el.textContent = this.text.shown;
    el.title = this.text.full;
    el.setAttribute('aria-label', this.text.full);
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const offLine = Decoration.line({ class: 'baa-mon-off' });

function build(doc: EditorView['state']['doc'], m: SclMonitor): DecorationSet {
  const ranges = [];
  for (const [n, st] of m.status) {
    if (n < 1 || n > doc.lines) continue;
    const line = doc.line(n);
    if (st.state === 'notRun') ranges.push(offLine.range(line.from));
    const text = sclLineText(st, m.hex);
    if (text)
      ranges.push(Decoration.widget({ widget: new ValueWidget(text), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

/** Come in AWL: una modifica del testo toglie i valori finché non ne arrivano di nuovi. */
const sclMonitorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setSclMonitor)) return e.value ? build(tr.state.doc, e.value) : Decoration.none;
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Righe SCL visibili (da 1, prima e ultima) dopo ogni scorrimento, anche della pagina attorno:
 * servono alla finestra dell'osservazione sulla CPU. Un editor non disposto (altezza 0) le dà tutte.
 */
function visibleLines(report: (first: number, last: number) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      private frame = 0;
      private sent = '';
      constructor(private readonly view: EditorView) {
        window.addEventListener('scroll', this.schedule, true);
        window.addEventListener('resize', this.schedule);
        this.schedule();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule();
      }
      private readonly schedule = (): void => {
        if (!this.frame) this.frame = requestAnimationFrame(this.measure);
      };
      private readonly measure = (): void => {
        this.frame = 0;
        const v = this.view;
        const doc = v.state.doc;
        const r = v.scrollDOM.getBoundingClientRect();
        let range: [number, number] = [1, doc.lines];
        if (r.height > 0) {
          let top = Math.max(r.top, 0);
          let bottom = Math.min(r.bottom, window.innerHeight);
          for (let p = v.scrollDOM.parentElement; p; p = p.parentElement) {
            if (!/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) continue;
            const pr = p.getBoundingClientRect();
            top = Math.max(top, pr.top);
            bottom = Math.min(bottom, pr.bottom);
          }
          const at = (y: number) => doc.lineAt(v.lineBlockAtHeight(y - v.documentTop).from).number;
          range = bottom > top ? [at(top), at(bottom)] : [0, 0];
        }
        const key = range.join(',');
        if (key === this.sent) return;
        this.sent = key;
        report(range[0], range[1]);
      };
      destroy(): void {
        window.removeEventListener('scroll', this.schedule, true);
        window.removeEventListener('resize', this.schedule);
        if (this.frame) cancelAnimationFrame(this.frame);
      }
    },
  );
}

/** Valori a fine riga; `report` riceve le righe visibili (`0, 0` se nessuna). */
export function sclMonitorExtension(report: (first: number, last: number) => void): Extension {
  return [sclMonitorField, visibleLines(report)];
}
