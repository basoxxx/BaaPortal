// Vista FUP di un segmento: lo stesso modello del KOP (docs/linguaggi/kop-awl.md §1), disegnato
// come riquadri logici. Albero ricorsivo in flex, nessuna griglia. Gli inserimenti sono quelli
// dell'editor KOP (`useLadEdit`): una serie è un riquadro `&`, un parallelo un `>=1`.
import { createContext, useContext, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BOX_CATALOG, findElem, insertElem, isNode, updateElem } from '@baaportal/ladfbd';
import type { LadBox, LadElem, LadNetwork, LadNode, LadOut } from '@baaportal/ladfbd';
import { LadToolbar } from '../lad/LadToolbar';
import { LAD_TOOL_KEYS, ladAction } from '../lad/ladKeys';
import { fieldPatch, fieldValue, fieldsOf, flowPin, paletteIdOf, placeOf } from '../lad/ladOps';
import type { CallParams, LadField } from '../lad/ladOps';
import { monAttr, monText, pinValues, type LadMonitor } from '../lad/ladMonitor';
import { useLadEdit } from '../lad/useLadEdit';
import type { LadInsertApi } from '../lad/useLadEdit';
import './fbd.css';

type Props = {
  net: LadNetwork;
  diagnostics: Map<string, string[]>;
  readOnly: boolean;
  onChange: (net: LadNetwork, labelKey: string) => void;
  callParams?: CallParams;
  newId?: () => string;
  /** Come in `LadNetworkEditor`: la tavolozza inserisce nell'ultima vista attiva. */
  onActive?: (api: LadInsertApi, active: boolean) => void;
  callOfDrop?: (raw: string) => string | undefined;
  /** Osservazione del programma: stato degli elementi, solo da mostrare. */
  monitor?: LadMonitor;
};

type Item = LadElem | LadOut;
type Editing = { id: string; key: string };
interface Ctx {
  sel: string | null;
  select: (id: string) => void;
  editing: Editing | null;
  edit: (id: string, key: string) => void;
  commit: (id: string, fld: LadField, value: string) => void;
  stop: () => void;
  diagnostics: Map<string, string[]>;
  monitor?: LadMonitor;
}
const FupCtx = createContext<Ctx | null>(null);
const EMPTY = '??.?';
const OUT_TITLE: Record<string, string> = { coil: '=', set: 'S', reset: 'R' };

function nameOf(e: Item, t: (k: string, o?: Record<string, string>) => string): string {
  if (e.k === 'box') return `${t('lad.boxEl', { kind: e.box })} ${e.instance}`.trim();
  const vals = fieldsOf(e).map((f) => fieldValue(e, f));
  const base = `${t(`lad.palette.${paletteIdOf(e)}`)}${e.k === 'cmp' ? ` ${e.fn}` : ''}`;
  return [base, ...vals.map((v, i) => v || (i === 0 ? EMPTY : ''))].filter(Boolean).join(' ');
}

/** In FUP un'entrata mostra il segnale del suo operando; gli altri elementi la loro uscita. */
function fupMon(mon: LadMonitor | undefined, item: Item) {
  const sta = mon?.status.get(item.id)?.sta;
  if (item.k === 'contact' && sta !== undefined) return sta ? '1' : '0';
  return monAttr(mon, item.id, 'out');
}

/** Elemento selezionabile (clic, tastiera) con le sue diagnostiche. */
function Sel({
  item,
  className,
  children,
}: {
  item: Item;
  className: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const c = useContext(FupCtx)!;
  const msgs = c.diagnostics.get(item.id) ?? [];
  const mon = monText(c.monitor, item, t);
  const tip = [...msgs, ...(mon ? [mon] : [])].join('\n');
  const cls = [className, 'baa-fup-el'];
  if (c.sel === item.id) cls.push('baa-fup-el--selected');
  if (msgs.length > 0) cls.push('baa-fup-el--error');
  return (
    <div
      role="button"
      tabIndex={0}
      className={cls.join(' ')}
      aria-label={mon ? `${nameOf(item, t)} (${mon})` : nameOf(item, t)}
      aria-pressed={c.sel === item.id}
      title={tip || undefined}
      data-fup-id={item.id}
      data-mon={fupMon(c.monitor, item)}
      onClick={(ev) => {
        ev.stopPropagation();
        c.select(item.id);
      }}
      onFocus={(ev) => {
        // Solo il proprio fuoco: l'evento deve risalire fino alla vista (tavolozza attiva).
        if (ev.target === ev.currentTarget) c.select(item.id);
      }}
    >
      {children}
    </div>
  );
}

/** Operando di un campo: doppio clic (o Invio sull'elemento) per modificarlo. */
function Operand({ item, fld }: { item: Item; fld: LadField }) {
  const { t } = useTranslation();
  const c = useContext(FupCtx)!;
  const value = fieldValue(item, fld);
  if (c.editing?.id === item.id && c.editing.key === fld.key) {
    const done = (v: string) => c.commit(item.id, fld, v.replace(/[\r\n]+/g, ' '));
    return (
      <input
        className="baa-fup-input"
        autoFocus
        defaultValue={value}
        aria-label={fld.pin ? fld.label : t(fld.label)}
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') done(ev.currentTarget.value);
          else if (ev.key === 'Escape') c.stop();
        }}
        onBlur={(ev) => done(ev.currentTarget.value)}
      />
    );
  }
  const live = pinValues(c.monitor, item)[fld.key];
  return (
    <span
      className={`baa-fup-op${value === '' ? ' baa-fup-op--empty' : ''}`}
      onDoubleClick={() => c.edit(item.id, fld.key)}
    >
      {value || EMPTY}
      {live !== undefined ? <i className="baa-lad-val">{live}</i> : null}
    </span>
  );
}

const Neg = () => <span className="baa-fup-neg" aria-hidden="true" />;

/** Riquadro con titolo; `ins` sono le entrate (a sinistra), `outs` le uscite (a destra). */
function Gate({ title, ins, outs }: { title: ReactNode; ins: ReactNode[]; outs?: ReactNode[] }) {
  return (
    <div className="baa-fup-gate">
      <div className="baa-fup-pins">
        {ins.map((x, i) => (
          <div className="baa-fup-in" key={i}>
            {x}
          </div>
        ))}
      </div>
      <div className="baa-fup-title">{title}</div>
      {outs ? (
        <div className="baa-fup-pins">
          {outs.map((x, i) => (
            <div className="baa-fup-in" key={i}>
              {x}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** `input`: la logica che entra nel primo pin (EN o S/CU…), se il box non è il primo della serie. */
function BoxView({ b, input }: { b: LadBox; input?: ReactNode }) {
  const def = BOX_CATALOG[b.box];
  const flow = flowPin(b.box);
  const flds = fieldsOf(b);
  const inst = flds.find((f) => !f.pin);
  const isOut = (n: string) => def.outputs.some((o) => o.name === n);
  const pin = (f: LadField) => (
    <span className="baa-fup-pin" key={f.key}>
      {f.key}
      <Operand item={b} fld={f} />
    </span>
  );
  const ins: ReactNode[] = [];
  const first = def.firstPin || (def.en ? 'EN' : '');
  if (first)
    ins.push(
      <span className="baa-fup-pin">
        {first}
        {input}
      </span>,
    );
  for (const n of def.boolInputs)
    ins.push(
      <span className="baa-fup-pin">
        {n}
        <Logic elems={b.boolPins[n] ?? []} />
      </span>,
    );
  ins.push(...flds.filter((f) => f.pin && !isOut(f.key)).map(pin));
  const outs = flds.filter((f) => f.pin && isOut(f.key)).map(pin);
  if (flow) outs.push(<span className="baa-fup-pin">{flow}</span>);
  return (
    <Sel item={b} className="baa-fup-boxel">
      {inst ? <Operand item={b} fld={inst} /> : null}
      <Gate title={b.box} ins={ins} outs={outs} />
    </Sel>
  );
}

function Input({ e }: { e: LadElem }) {
  const flds = fieldsOf(e);
  switch (e.k) {
    case 'contact':
      return (
        <Sel item={e} className="baa-fup-leaf">
          <Operand item={e} fld={flds[0]!} />
          {e.neg ? <Neg /> : null}
        </Sel>
      );
    case 'parallel':
      return (
        <Sel item={e} className="baa-fup-boxel">
          <Gate
            title=">=1"
            ins={e.branches.map((br, i) => (
              <Logic key={i} elems={br} />
            ))}
          />
        </Sel>
      );
    case 'box':
      return <BoxView b={e} />;
    case 'not':
      return null; // `Logic` lo disegna come cerchietto sul pin
    default: {
      // cmp, edge, posneg, midline: riquadro con i suoi operandi in entrata.
      const title =
        e.k === 'cmp'
          ? `CMP ${e.fn}`
          : e.k === 'midline'
            ? '#'
            : e.k === 'edge'
              ? e.dir
              : e.dir === 'P'
                ? 'POS'
                : 'NEG';
      return (
        <Sel item={e} className="baa-fup-boxel">
          <Gate
            title={title}
            ins={flds.map((f) => (
              <span className="baa-fup-pin" key={f.key}>
                {e.k === 'cmp' ? f.key.toUpperCase() : null}
                <Operand item={e} fld={f} />
              </span>
            ))}
          />
        </Sel>
      );
    }
  }
}

type Chain = Extract<LadElem, { k: 'edge' | 'midline' | 'box' }>;
/** Elementi che in AWL lavorano sull'RLO di ciò che li precede (FP/FN, `= op`, EN o primo pin). */
const isChain = (e: LadElem): e is Chain => e.k === 'edge' || e.k === 'midline' || e.k === 'box';

/** Un elemento a catena con la logica che lo precede come entrata. */
function Chained({ e, before }: { e: Chain; before: LadElem[] }) {
  const input = <Logic elems={before} />;
  if (e.k === 'box') return <BoxView b={e} input={input} />;
  return (
    <Sel item={e} className="baa-fup-boxel">
      <Operand item={e} fld={fieldsOf(e)[0]!} />
      <Gate title={e.k === 'midline' ? '#' : e.dir} ins={[input]} />
    </Sel>
  );
}

/**
 * La logica di una serie: vuota = sempre vera, una voce sola = l'entrata, più voci = riquadro `&`.
 * Un `NOT` nega tutto ciò che lo precede nella serie: è il cerchietto sull'uscita di quella
 * logica, cioè sul pin con cui entra, negata, nel resto della serie. Allo stesso modo un fronte
 * (P)/(N), un `#` o un box dopo la prima voce prendono come entrata tutto ciò che li precede.
 */
function Logic({ elems }: { elems: LadElem[] }) {
  let k = elems.length - 1;
  while (k >= 0 && elems[k]!.k !== 'not' && !(k > 0 && isChain(elems[k]!))) k--;
  if (k >= 0) {
    const e = elems[k]!;
    const head = isChain(e) ? (
      <Chained e={e} before={elems.slice(0, k)} />
    ) : (
      <div className="baa-fup-in">
        <Logic elems={elems.slice(0, k)} />
        <Sel item={e} className="baa-fup-leaf">
          <Neg />
        </Sel>
      </div>
    );
    const rest = elems.slice(k + 1);
    if (rest.length === 0) return head;
    return <Gate title="&" ins={[head, ...rest.map((x) => <Input key={x.id} e={x} />)]} />;
  }
  if (elems.length === 0) return <span className="baa-fup-op">1</span>;
  if (elems.length === 1) return <Input e={elems[0]!} />;
  return (
    <Gate
      title="&"
      ins={elems.map((e) => (
        <Input key={e.id} e={e} />
      ))}
    />
  );
}

function OutView({ o }: { o: LadOut }) {
  const flds = fieldsOf(o);
  const title = OUT_TITLE[o.k] ?? (o.k === 'tcoil' || o.k === 'ccoil' ? o.fn : o.k.toUpperCase());
  return (
    <Sel item={o} className="baa-fup-boxel">
      {flds.length === 1 ? <Operand item={o} fld={flds[0]!} /> : null}
      <div className="baa-fup-title baa-fup-title--out">{title}</div>
      {flds.length > 1
        ? flds.map((f) => (
            <span className="baa-fup-pin" key={f.key}>
              <Operand item={o} fld={f} />
            </span>
          ))
        : null}
    </Sel>
  );
}

/** Ogni uscita ha come entrata la serie; un ramo a T aggiunge la sua serie e le sue uscite. */
function NodeView({ node, inherited }: { node: LadNode; inherited: LadElem[] }) {
  const series = [...inherited, ...node.series];
  return (
    <>
      {node.outs.map((o) =>
        isNode(o) ? (
          <NodeView key={o.id} node={o} inherited={series} />
        ) : (
          <div className="baa-fup-row" key={o.id}>
            <Logic elems={series} />
            <span className="baa-fup-wire" />
            <OutView o={o} />
          </div>
        ),
      )}
    </>
  );
}

/** Quante voci la serie del nodo `id` eredita dai nodi sopra di lui (come in `NodeView`). */
function inheritedLen(n: LadNode, id: string, acc = 0): number | undefined {
  if (n.id === id) return acc;
  for (const o of n.outs) {
    const r = isNode(o) ? inheritedLen(o, id, acc + n.series.length) : undefined;
    if (r !== undefined) return r;
  }
  return undefined;
}

const defaultId = () => globalThis.crypto.randomUUID();
const FUP_KEYS = { ...LAD_TOOL_KEYS, negate: 'N' } as const;

export function FupNetworkView({
  net,
  diagnostics,
  readOnly,
  onChange,
  callParams,
  newId = defaultId,
  onActive,
  callOfDrop,
  monitor,
}: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const ed = useLadEdit({
    net,
    readOnly,
    onChange,
    newId,
    callParams,
    onActive,
    callOfDrop,
    root,
    idAttr: 'data-fup-id',
    busy: editing !== null,
  });
  const sel = ed.sel?.t === 'elem' ? ed.sel.id : null;
  const itemOf = (id: string) => findElem(net, id) as Item | LadNode | undefined;
  const ctx: Ctx = {
    sel,
    select: (id) => ed.setSel({ t: 'elem', id }),
    editing,
    edit: (id, key) => {
      if (!readOnly) setEditing({ id, key });
    },
    commit: (id, fld, value) => {
      setEditing(null);
      ed.wantFocus.current = true;
      const e = itemOf(id);
      if (readOnly || !e || isNode(e as LadOut | LadNode)) return;
      if (value === fieldValue(e as Item, fld)) return;
      ed.apply(() => updateElem(net, id, fieldPatch(e as Item, fld, value, callParams)));
    },
    stop: () => {
      setEditing(null);
      ed.wantFocus.current = true;
    },
    diagnostics,
    monitor,
  };

  /**
   * N: nega l'entrata selezionata. Un contatto cambia NA/NC; la prima entrata di una serie che
   * parte da capo riceve un `NOT` subito dopo (nega solo lei); un `NOT` selezionato si toglie. In
   * un ramo a T che eredita logica il `NOT` negherebbe anche quella: si rifiuta.
   */
  function negate() {
    const e = sel ? itemOf(sel) : undefined;
    const p = sel ? placeOf(net, sel) : undefined;
    if (!sel || !e || p?.t !== 'elem') return ed.setStatus(t('lad.cannotNegate'));
    const id = sel;
    const el = e as LadElem;
    if (el.k === 'contact') ed.apply(() => updateElem(net, id, { neg: !el.neg }));
    else if (el.k === 'not') ed.run('delete');
    else if (p.index === 0 && !('node' in p.at(0) && inheritedLen(net.root, p.nodeId)))
      ed.apply(() => insertElem(net, p.at(1), { id: newId(), k: 'not' }));
    else ed.setStatus(t('lad.cannotNegate'));
  }

  /** Frecce: elemento precedente o successivo nell'ordine del disegno. */
  function move(delta: number) {
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[data-fup-id]') ?? [])];
    const i = els.findIndex((x) => x.dataset.fupId === sel);
    const to = els[i < 0 ? 0 : i + delta];
    if (to) ed.setSel({ t: 'elem', id: to.dataset.fupId! });
    ed.wantFocus.current = true;
  }

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (editing || (ev.target as HTMLElement).tagName === 'INPUT') return;
    const a = ladAction(ev);
    if (a === 'left' || a === 'up' || a === 'right' || a === 'down') {
      ev.preventDefault();
      move(a === 'left' || a === 'up' ? -1 : 1);
      return;
    }
    if (readOnly) return;
    if (a === 'edit') {
      const e = sel ? itemOf(sel) : undefined;
      const first = e && !isNode(e as LadOut | LadNode) ? fieldsOf(e as Item)[0] : undefined;
      if (sel && first) setEditing({ id: sel, key: first.key });
    } else if (a) {
      ev.preventDefault();
      ed.run(a);
    } else if (ev.key.toLowerCase() === 'n' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      negate();
    }
  };

  /** Rilascio su un elemento: dopo di lui, come se fosse selezionato; altrove in fondo alla serie. */
  function onDrop(ev: DragEvent<HTMLDivElement>) {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-fup-id]')?.dataset.fupId;
    if (ed.drop(ev.dataTransfer, ed.target(id ? { t: 'elem', id } : null).at)) ev.preventDefault();
  }

  const tool = (key: keyof typeof FUP_KEYS, run: () => void) => ({
    key,
    label: t(`lad.fupTool.${key}`),
    title: `${t(`lad.fupTool.${key}`)} (${FUP_KEYS[key]})`,
    run,
  });
  const tools = [
    tool('contactNo', () => ed.addContact(false)),
    tool('contactNc', () => ed.addContact(true)),
    tool('openBranch', ed.doOpenBranch),
    tool('closeBranch', ed.doCloseBranch),
    tool('negate', negate),
    tool('coil', ed.addCoil),
    tool('tBranch', ed.addTBranch),
  ];

  return (
    <FupCtx.Provider value={ctx}>
      <div className="baa-lad" onFocus={() => onActive?.(ed.api, true)}>
        <LadToolbar
          tools={tools}
          readOnly={readOnly}
          onBox={(k) => ed.insertBox(k)}
          done={() => {
            ed.wantFocus.current = true;
            root.current?.focus();
          }}
        />
        <div
          ref={root}
          className="baa-fup"
          role="group"
          aria-label={t('lad.fupView')}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={() => ed.setSel(null)}
          onDragOver={(ev) => {
            if (ed.accepts(ev.dataTransfer.types)) ev.preventDefault();
          }}
          onDrop={onDrop}
        >
          <NodeView node={net.root} inherited={[]} />
        </div>
        <div className="baa-lad-status" role="status">
          {ed.status}
        </div>
      </div>
    </FupCtx.Provider>
  );
}
