import { decodeEventId, describeEvent, modeTransition, type ModeCode } from '@baaportal/s7comm';
import type { S7DateTime } from '@baaportal/s7comm';
import type { DiagEventView } from './plcTypes';

const two = (n: number) => String(n).padStart(2, '0');

/** Data e ora della CPU così come arrivano, senza conversioni di fuso. */
export function formatS7Time(
  t: Pick<S7DateTime, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>,
): string {
  return `${two(t.day)}/${two(t.month)}/${t.year} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}`;
}

/** Ora di una voce: la data, o gli 8 byte grezzi in esadecimale se la CPU non ne ha data una valida. */
export function formatEventTime(e: DiagEventView): string {
  if (e.time) return formatS7Time(e.time);
  if (e.rawTime) return (e.rawTime.match(/../g) ?? []).join(' ').toUpperCase();
  return '';
}

export const hexNum = (n: number, width: number): string =>
  `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;

/** Parti del cambio di modo (classe 4): `obNumber` porta il byte di modo (vedi `modeTransition`). */
export function modeChangeOf(e: DiagEventView): { from: ModeCode; to: ModeCode } | undefined {
  return decodeEventId(e.eventId).cls === 4 ? modeTransition(e.obNumber) : undefined;
}

export interface EventDetails {
  idHex: string;
  text: string;
  generic: boolean;
  cls: number;
  incoming: boolean;
  priority: number;
  obNumber: number;
  mode?: { from: ModeCode; to: ModeCode };
  datId: string;
  info1: string;
  info2: string;
}

export function eventDetails(e: DiagEventView, lang: 'it' | 'en'): EventDetails {
  const d = describeEvent(e.eventId, lang);
  const id = decodeEventId(e.eventId);
  const mode = modeChangeOf(e);
  return {
    idHex: hexNum(e.eventId, 4),
    text: d.text,
    generic: d.source === 'generic',
    cls: id.cls,
    incoming: id.incoming,
    priority: e.priority,
    obNumber: e.obNumber,
    ...(mode ? { mode } : {}),
    datId: hexNum(e.datId, 4),
    info1: hexNum(e.info1, 4),
    info2: hexNum(e.info2, 8),
  };
}

export interface ClockFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type ClockFieldError =
  { field: 'date' | 'time'; key: 'format' | 'range' | 'day' } | undefined;

/** Legge «AAAA-MM-GG» e «hh:mm:ss»; stessi limiti del processo principale (anno 1990-2089, giorno esistente). */
export function parseClockFields(
  date: string,
  time: string,
): { ok: true; time: ClockFields } | { ok: false; error: NonNullable<ClockFieldError> } {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (!d) return { ok: false, error: { field: 'date', key: 'format' } };
  const t = /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(time.trim());
  if (!t) return { ok: false, error: { field: 'time', key: 'format' } };
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])] as const;
  const [hour, minute, second] = [Number(t[1]), Number(t[2]), Number(t[3])] as const;
  if (year < 1990 || year > 2089 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, error: { field: 'date', key: 'range' } };
  }
  const days = [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > days) return { ok: false, error: { field: 'date', key: 'day' } };
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, error: { field: 'time', key: 'range' } };
  }
  return { ok: true, time: { year, month, day, hour, minute, second } };
}

/** Differenza CPU meno PC in secondi, confrontando i campi di data e ora così come sono. */
export function clockDiffSeconds(cpu: ClockFields, pc: Date): number {
  const u = (f: ClockFields) => Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const pcFields: ClockFields = {
    year: pc.getFullYear(),
    month: pc.getMonth() + 1,
    day: pc.getDate(),
    hour: pc.getHours(),
    minute: pc.getMinutes(),
    second: pc.getSeconds(),
  };
  return Math.round((u(cpu) - u(pcFields)) / 1000);
}
