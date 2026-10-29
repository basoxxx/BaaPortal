// Disegno di un elemento KOP (contatto, bobina, box…) come pulsante posato sulla griglia.
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { LadBox, LadElem, LadOut } from '@baaportal/ladfbd';
import type { LadCell } from './ladLayout';
import { fieldValue, fieldsOf, flowPin, paletteIdOf } from './ladOps';
import { monAttr, monText, pinValues, type LadMonitor, type MonAttr } from './ladMonitor';

/** Dimensioni in pixel di una cella della griglia. */
export const CELL_W = 64;
export const CELL_H = 40;
export const EMPTY_OPERAND = '??.?';

type Props = {
  elem: LadElem | LadOut;
  cell: LadCell;
  selected: boolean;
  /** Messaggi di diagnostica dell'elemento (vuoto = nessuno). */
  messages: string[];
  onSelect: () => void;
  /** Doppio clic; `pin` è il nome del pin se il clic cade sull'etichetta o sull'operando di un pin. */
  onEdit: (pin?: string) => void;
  /** Osservazione del segmento (assente se non si osserva). */
  monitor?: LadMonitor;
};

/** Testo dentro il simbolo; le bobine con lettera usano le parentesi `( )`. */
const RECT_TEXT: Record<string, string> = {
  not: 'NOT',
  posneg: '',
  jmp: 'JMP',
  jmpn: 'JMPN',
  ret: 'RET',
  save: 'SAVE',
  mcrOpen: 'MCR<',
  mcrClose: 'MCR>',
  mcra: 'MCRA',
  mcrd: 'MCRD',
  callCoil: 'CALL',
  opn: 'OPN',
};
const COIL_LETTER: Record<string, string> = { coil: '', set: 'S', reset: 'R', midline: '#' };

function rectText(e: LadElem | LadOut): string {
  if (e.k === 'cmp' || e.k === 'tcoil' || e.k === 'ccoil') return e.fn;
  if (e.k === 'posneg') return e.dir === 'P' ? 'POS' : 'NEG';
  return RECT_TEXT[e.k] ?? '';
}

function coilLetter(e: LadElem | LadOut): string | undefined {
  if (e.k === 'edge') return e.dir;
  return COIL_LETTER[e.k];
}

/** `inM`/`outM`: stato osservato del flusso in entrata e in uscita (`data-mon`). */
function Symbol({ e, inM, outM }: { e: LadElem | LadOut; inM: MonAttr; outM: MonAttr }) {
  const mid = CELL_H / 2;
  if (e.k === 'contact') {
    return (
      <>
        <line x1={0} y1={mid} x2={26} y2={mid} data-mon={inM} />
        <line x1={38} y1={mid} x2={CELL_W} y2={mid} data-mon={outM} />
        <line x1={26} y1={10} x2={26} y2={30} data-mon={outM} />
        <line x1={38} y1={10} x2={38} y2={30} data-mon={outM} />
        {e.neg && <line x1={28} y1={30} x2={36} y2={10} data-mon={outM} />}
      </>
    );
  }
  const letter = coilLetter(e);
  if (letter !== undefined) {
    return (
      <>
        <line x1={0} y1={mid} x2={22} y2={mid} data-mon={inM} />
        <line x1={42} y1={mid} x2={CELL_W} y2={mid} data-mon={outM} />
        <path d="M26 10 Q18 20 26 30" fill="none" data-mon={outM} />
        <path d="M38 10 Q46 20 38 30" fill="none" data-mon={outM} />
        <text x={32} y={24} textAnchor="middle" className="baa-lad-sym-text">
          {letter}
        </text>
      </>
    );
  }
  const tall = e.k === 'cmp' || e.k === 'posneg' || e.k === 'tcoil' || e.k === 'ccoil';
  const top = tall ? 3 : 8;
  const bottom = tall ? 37 : 32;
  return (
    <>
      <line x1={0} y1={mid} x2={8} y2={mid} data-mon={inM} />
      <line x1={56} y1={mid} x2={CELL_W} y2={mid} data-mon={outM} />
      <rect x={8} y={top} width={48} height={bottom - top} fill="none" data-mon={outM} />
      <text x={32} y={mid + 4} textAnchor="middle" className="baa-lad-sym-text">
        {rectText(e)}
      </text>
    </>
  );
}

function BoxSymbol({ b, cell, monitor }: { b: LadBox; cell: LadCell; monitor?: LadMonitor }) {
  const w = cell.w * CELL_W;
  const h = cell.h * CELL_H;
  const st = monitor?.status.get(b.id);
  const flow = flowPin(b.box);
  // Solo i pin BOOL hanno un flusso; i pin di dati restano del colore normale.
  const pinM = (name: string): MonAttr => {
    if (!monitor) return undefined;
    if (!st) return 'off';
    const v = name === flow ? st.out : st.pins?.[name];
    return v === undefined ? undefined : v ? '1' : '0';
  };
  return (
    <>
      {Object.entries(cell.pinRows ?? {}).map(([name, r]) => (
        <line
          key={`i${r}`}
          x1={0}
          y1={r * CELL_H + 20}
          x2={8}
          y2={r * CELL_H + 20}
          data-mon={pinM(name)}
        />
      ))}
      {Object.entries(cell.outRows ?? {}).map(([name, r]) => (
        <line
          key={`o${r}`}
          x1={w - 8}
          y1={r * CELL_H + 20}
          x2={w}
          y2={r * CELL_H + 20}
          data-mon={pinM(name)}
        />
      ))}
      <rect x={8} y={12} width={w - 16} height={Math.max(h - 16, 24)} fill="none" />
      <text x={w / 2} y={28} textAnchor="middle" className="baa-lad-sym-text">
        {b.box}
      </text>
    </>
  );
}

const pinStyle = (row: number): CSSProperties => ({ top: row * CELL_H + 20 - 7 });

export function LadElement({ elem, cell, selected, messages, onSelect, onEdit, monitor }: Props) {
  const { t } = useTranslation();
  const fields = fieldsOf(elem);
  const values = fields.map((f) => fieldValue(elem, f));
  const live = pinValues(monitor, elem);
  const mon = monText(monitor, elem, t);

  let name: string;
  if (elem.k === 'box') {
    name = t('lad.boxEl', { kind: elem.box });
    if (elem.instance) name += ` ${elem.instance}`;
  } else {
    name = t(`lad.palette.${paletteIdOf(elem)}`);
    if (elem.k === 'cmp') name += ` ${elem.fn}`;
    if (values.length > 0) name += ` ${values[0] || EMPTY_OPERAND}`;
    for (const v of values.slice(1)) if (v) name += ` ${v}`;
  }
  if (mon) name += ` (${mon})`;
  const tip = [...messages, ...(mon ? [mon] : [])].join('\n');

  const style: CSSProperties = {
    left: cell.col * CELL_W,
    top: cell.row * CELL_H,
    width: cell.w * CELL_W,
    height: cell.h * CELL_H,
  };
  const cls = ['baa-lad-el'];
  if (selected) cls.push('baa-lad-el--selected');
  if (messages.length > 0) cls.push('baa-lad-el--error');

  const operand = (text: string | undefined, pos: 'top' | 'bottom', key?: string) =>
    text === undefined ? null : (
      <span className={`baa-lad-op baa-lad-op--${pos}${text === '' ? ' baa-lad-op--empty' : ''}`}>
        {text === '' ? EMPTY_OPERAND : text}
        {key && live[key] !== undefined ? <i className="baa-lad-val">{live[key]}</i> : null}
      </span>
    );

  return (
    <button
      type="button"
      className={cls.join(' ')}
      style={style}
      aria-label={name}
      aria-pressed={selected}
      title={tip || undefined}
      tabIndex={selected ? 0 : -1}
      data-lad-id={elem.id}
      onClick={onSelect}
      onDoubleClick={(ev) =>
        onEdit(
          (ev.target as HTMLElement).closest('[data-pin]')?.getAttribute('data-pin') ?? undefined,
        )
      }
    >
      <svg
        className="baa-lad-svg"
        width={cell.w * CELL_W}
        height={cell.h * CELL_H}
        aria-hidden="true"
      >
        {elem.k === 'box' ? (
          <BoxSymbol b={elem} cell={cell} monitor={monitor} />
        ) : (
          <Symbol
            e={elem}
            inM={monAttr(monitor, elem.id, 'in')}
            outM={monAttr(monitor, elem.id, 'out')}
          />
        )}
      </svg>
      {elem.k === 'box' ? (
        <BoxLabels b={elem} cell={cell} live={live} />
      ) : (
        <>
          {operand(values[0], 'top', fields[0]?.key)}
          {operand(values[1], 'bottom', fields[1]?.key)}
        </>
      )}
    </button>
  );
}

function BoxLabels({ b, cell, live }: { b: LadBox; cell: LadCell; live: Record<string, string> }) {
  const flow = flowPin(b.box);
  const outs = Object.entries(cell.outRows ?? {});
  return (
    <>
      {b.instance && <span className="baa-lad-op baa-lad-op--top">{b.instance}</span>}
      {Object.entries(cell.pinRows ?? {}).map(([name, row]) => (
        <span
          key={`i${name}`}
          className="baa-lad-pin baa-lad-pin--in"
          data-pin={name}
          style={pinStyle(row)}
        >
          {name}
          {b.pins[name] ? <b>{b.pins[name]}</b> : null}
          {live[name] !== undefined ? <i className="baa-lad-val">{live[name]}</i> : null}
        </span>
      ))}
      {outs.map(([name, row]) => (
        <span
          key={`o${name}`}
          className="baa-lad-pin baa-lad-pin--out"
          data-pin={name}
          style={pinStyle(row)}
        >
          {live[name] !== undefined ? <i className="baa-lad-val">{live[name]}</i> : null}
          {b.pins[name] && name !== flow ? <b>{b.pins[name]}</b> : null}
          {name}
        </span>
      ))}
    </>
  );
}
