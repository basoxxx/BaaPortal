// Osservazione nei segmenti KOP e FUP: attributi e testi comuni alle due viste.
import { BOX_CATALOG } from '@baaportal/ladfbd';
import type { ElemStatus, LadElem, LadOut } from '@baaportal/ladfbd';
import { formatAccu } from '../awl/monitorExtension';

/** Stato osservato di un segmento: per elemento (assente = sconosciuto) e formato degli ACCU. */
export type LadMonitor = { status: ReadonlyMap<string, ElemStatus>; hex: boolean };

/**
 * `data-mon`: «1» flusso, «0» niente flusso, «off» non elaborato; `undefined` senza osservazione o
 * con stato sconosciuto (fuori finestra, in attesa): nessun colore.
 */
export type MonAttr = '1' | '0' | 'off' | undefined;

export function monAttr(mon: LadMonitor | undefined, id: string, side: 'in' | 'out'): MonAttr {
  if (!mon) return undefined;
  const st = mon.status.get(id);
  if (st?.notRun) return 'off';
  const v = st?.[side];
  return v === undefined ? undefined : v ? '1' : '0';
}

/** Valore di un pin nel suo tipo: REAL in virgola mobile, INT/DINT con segno, il resto in esadecimale. */
export function formatPinValue(v: number, type: string, hex: boolean): string {
  const t = type.toUpperCase();
  if (t === 'REAL') {
    const d = new DataView(new ArrayBuffer(4));
    d.setUint32(0, v >>> 0);
    return String(Number(d.getFloat32(0).toPrecision(7)));
  }
  if (!hex && t === 'INT') return String((v << 16) >> 16);
  if (!hex && t === 'DINT') return String(v | 0);
  if (t === 'WORD' || t === 'S5TIME' || t === 'INT' || t === 'BYTE')
    return `16#${(v & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
  return formatAccu(v, hex);
}

/** Tipo del pin (o del campo `in1`/`in2`/`value`) di un elemento, per il formato del valore. */
export function pinType(e: LadElem | LadOut, pin: string): string {
  if (e.k === 'cmp') return e.fn.endsWith('R') ? 'REAL' : e.fn.endsWith('D') ? 'DINT' : 'INT';
  if (e.k === 'tcoil') return 'S5TIME';
  if (e.k === 'ccoil') return 'WORD';
  if (e.k !== 'box') return '';
  const def = BOX_CATALOG[e.box];
  return [...def.dataInputs, ...def.outputs].find((p) => p.name === pin)?.type ?? '';
}

/**
 * Valori osservati dei pin di un elemento, già formattati; i pin BOOL con logica di un box
 * mostrano il loro flusso, `1` o `0`.
 */
export function pinValues(
  mon: LadMonitor | undefined,
  e: LadElem | LadOut,
): Record<string, string> {
  const st = mon?.status.get(e.id);
  const out = Object.fromEntries(
    Object.entries(st?.values ?? {}).map(([pin, x]) => [
      pin,
      formatPinValue(x, pinType(e, pin), mon!.hex),
    ]),
  );
  if (e.k === 'box' && st && !st.notRun)
    for (const [pin, list] of Object.entries(e.boolPins)) {
      const v = st.pins?.[pin];
      if (list.length > 0 && v !== undefined) out[pin] = v ? '1' : '0';
    }
  return out;
}

/**
 * Lo stato come testo, per `aria-label` e `title`: «1», «0», «non elaborato» o «fuori dalla
 * finestra», con i valori dei pin; `''` senza osservazione.
 */
export function monText(
  mon: LadMonitor | undefined,
  e: LadElem | LadOut,
  t: (k: string) => string,
): string {
  if (!mon) return '';
  const st = mon.status.get(e.id);
  if (st?.notRun) return t('lad.mon.none');
  if (!st) return t('lad.mon.outside');
  const parts: string[] = st.unknown ? [t('lad.mon.outside')] : [];
  if (st.out !== undefined) parts.push(`${t('lad.mon.state')} ${st.out ? '1' : '0'}`);
  if (st.sta !== undefined) parts.push(`${t('lad.mon.operand')} ${st.sta ? '1' : '0'}`);
  for (const [pin, v] of Object.entries(pinValues(mon, e))) parts.push(`${pin} ${v}`);
  return parts.join(', ');
}
