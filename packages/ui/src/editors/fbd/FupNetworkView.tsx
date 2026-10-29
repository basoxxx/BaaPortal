// Vista FUP di un segmento: lo stesso modello del KOP (docs/linguaggi/kop-awl.md §1), disegnato
// come riquadri logici. Albero ricorsivo in flex, nessuna griglia.
import { createContext, useContext, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BOX_CATALOG, findElem, isNode, removeElem, updateElem } from '@baaportal/ladfbd';
import type { LadBox, LadElem, LadNetwork, LadNode, LadOut } from '@baaportal/ladfbd';
import { fieldPatch, fieldValue, fieldsOf, flowPin, paletteIdOf } from '../lad/ladOps';
import type { LadField } from '../lad/ladOps';
import './fbd.css';

type Props = {
  net: LadNetwork;
  diagnostics: Map<string, string[]>;
  readOnly: boolean;
  onChange: (net: LadNetwork) => void;
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
  const cls = [className, 'baa-fup-el'];
  if (c.sel === item.id) cls.push('baa-fup-el--selected');
  if (msgs.length > 0) cls.push('baa-fup-el--error');
  return (
    <div
      role="button"
      tabIndex={0}
      className={cls.join(' ')}
      aria-label={nameOf(item, t)}
      aria-pressed={c.sel === item.id}
      title={msgs.length > 0 ? msgs.join('\n') : undefined}
      data-fup-id={item.id}
      onClick={(ev) => {
        ev.stopPropagation();
        c.select(item.id);
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
  return (
    <span
      className={`baa-fup-op${value === '' ? ' baa-fup-op--empty' : ''}`}
      onDoubleClick={() => c.edit(item.id, fld.key)}
    >
      {value || EMPTY}
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

function BoxView({ b }: { b: LadBox }) {
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
  if (first) ins.push(<span className="baa-fup-pin">{first}</span>);
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
    case 'not':
      return (
        <Sel item={e} className="baa-fup-leaf">
          <Neg />
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

/** La logica di una serie: vuota = sempre vera, una voce sola = l'entrata, più voci = riquadro `&`. */
function Logic({ elems }: { elems: LadElem[] }) {
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

export function FupNetworkView({ net, diagnostics, readOnly, onChange }: Props) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const itemOf = (id: string) => findElem(net, id) as Item | LadNode | undefined;
  const ctx: Ctx = {
    sel,
    select: setSel,
    editing,
    edit: (id, key) => {
      if (!readOnly) setEditing({ id, key });
    },
    commit: (id, fld, value) => {
      setEditing(null);
      const e = itemOf(id);
      if (readOnly || !e || isNode(e as LadOut | LadNode)) return;
      if (value === fieldValue(e as Item, fld)) return;
      onChange(updateElem(net, id, fieldPatch(e as Item, fld, value)));
    },
    stop: () => setEditing(null),
    diagnostics,
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !sel || readOnly) return;
    const e = itemOf(sel);
    if (!e || isNode(e as LadOut | LadNode)) return;
    if (ev.key === 'Delete') {
      ev.preventDefault();
      setSel(null);
      onChange(removeElem(net, sel, () => globalThis.crypto.randomUUID()));
    } else if (ev.key === 'Enter') {
      const first = fieldsOf(e as Item)[0];
      if (first) setEditing({ id: sel, key: first.key });
    }
  };
  return (
    <FupCtx.Provider value={ctx}>
      <div
        className="baa-fup"
        role="group"
        aria-label={t('lad.fupView')}
        onKeyDown={onKeyDown}
        onClick={() => setSel(null)}
      >
        <NodeView node={net.root} inherited={[]} />
      </div>
    </FupCtx.Provider>
  );
}
