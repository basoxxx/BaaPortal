import type { ReadItem, WriteItem } from '@baaportal/s7comm';
import type { PlcReadWatchResult, PlcWatchTarget, PlcWatchValue } from '@baaportal/ui';
import type { PlcOwner, PlcService } from './plcService';

/** Al più tanti operandi per giro (10 richieste read var da 20 item). */
export const ONLINE_MAX_ITEMS = 200;
/** Tempo massimo di un giro di lettura (ms). */
const DEADLINE_MS = 5000;

const READ_AREAS = ['I', 'Q', 'M', 'DB', 'PI', 'T', 'C'];
/** Le aree che si possono scrivere: PI, PQ, T e C no (PQ non è disponibile online nemmeno in lettura). */
const WRITE_AREAS = ['I', 'Q', 'M', 'DB'];
const SIZES = ['X', 'B', 'W', 'D'];
/** Byte di dati per dimensione di operando. */
const BYTES: Record<PlcWatchTarget['size'], number> = { X: 1, B: 1, W: 2, D: 4 };
const MAX_BYTE = 0x1fffff;
const MAX_TC = 0xffff;

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Controlla un operando che arriva dal renderer; `areas` sono quelle ammesse per l'operazione. */
export function parseWatchTarget(raw: unknown, areas: readonly string[]): PlcWatchTarget | string {
  if (typeof raw !== 'object' || raw === null) return 'Operando non valido';
  const r = raw as Record<string, unknown>;
  const area = r['area'];
  if (typeof area !== 'string' || !areas.includes(area)) {
    return `Area ${typeof area === 'string' ? area : '?'} non disponibile online`;
  }
  const size = r['size'];
  if (typeof size !== 'string' || !SIZES.includes(size)) return 'Dimensione di operando non valida';
  const isTc = area === 'T' || area === 'C';
  if (isTc && size !== 'W') return 'Timer e contatori si leggono solo come parola';
  if (!isInt(r['byte'], 0, isTc ? MAX_TC : MAX_BYTE)) return 'Indirizzo non valido';
  const byte = r['byte'];
  const out: PlcWatchTarget = {
    area: area as PlcWatchTarget['area'],
    byte,
    size: size as PlcWatchTarget['size'],
  };
  if (area === 'DB') {
    if (!isInt(r['db'], 1, 65535)) return 'Numero di DB non valido';
    out.db = r['db'];
  } else if (r['db'] !== undefined) {
    return 'Numero di DB su un operando che non è di un DB';
  }
  if (size === 'X') {
    if (!isInt(r['bit'], 0, 7)) return 'Numero di bit non valido';
    out.bit = r['bit'];
  } else if (r['bit'] !== undefined) {
    return 'Bit su un operando che non è un bit';
  }
  if (!isTc && byte + BYTES[out.size] - 1 > MAX_BYTE) return 'Indirizzo oltre lo spazio della CPU';
  return out;
}

/** Controlla la forma dell'elenco da leggere: al più `ONLINE_MAX_ITEMS`. Gli operandi si controllano uno per uno. */
export function parseWatchList(raw: unknown): unknown[] | string {
  if (!Array.isArray(raw)) return 'Elenco di operandi non valido';
  if (raw.length > ONLINE_MAX_ITEMS) return `Troppi operandi (massimo ${ONLINE_MAX_ITEMS})`;
  return raw;
}

/** Controlla l'elenco di operandi da leggere: il primo non valido dà il suo motivo. */
export function parseWatchItems(raw: unknown): PlcWatchTarget[] | string {
  const list = parseWatchList(raw);
  if (typeof list === 'string') return list;
  const out: PlcWatchTarget[] = [];
  for (const r of list) {
    const t = parseWatchTarget(r, READ_AREAS);
    if (typeof t === 'string') return t;
    out.push(t);
  }
  return out;
}

/** Controlla gli operandi da scrivere e i loro dati: area scrivibile, tanti byte quanti la dimensione. */
export function parseWriteItems(
  raw: unknown,
): { target: PlcWatchTarget; data: Uint8Array }[] | string {
  if (!Array.isArray(raw)) return 'Elenco di valori non valido';
  if (raw.length === 0) return 'Nessun valore da scrivere';
  if (raw.length > ONLINE_MAX_ITEMS) return `Troppi valori (massimo ${ONLINE_MAX_ITEMS})`;
  const out: { target: PlcWatchTarget; data: Uint8Array }[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) return 'Valore da scrivere non valido';
    const { target: rt, data } = r as { target?: unknown; data?: unknown };
    const target = parseWatchTarget(rt, WRITE_AREAS);
    if (typeof target === 'string') {
      const area = (rt as { area?: unknown } | null)?.area;
      return READ_AREAS.includes(String(area)) && !WRITE_AREAS.includes(String(area))
        ? `Area ${String(area)} non comandabile online`
        : target;
    }
    if (!(data instanceof Uint8Array) || data.length !== BYTES[target.size]) {
      return `Dati di lunghezza diversa dalla dimensione dell'operando (${BYTES[target.size]} byte)`;
    }
    if (target.size === 'X' && data[0]! > 1) return 'Valore di un bit diverso da 0 e 1';
    out.push({ target, data: data.slice() });
  }
  return out;
}

const SIZE_NAME = { B: 'BYTE', W: 'WORD', D: 'DWORD' } as const;

/** L'operando come item di read var: I, Q, M e DB restano nella loro area, PI diventa P (§5.4). */
export function toReadItem(t: PlcWatchTarget): ReadItem {
  if (t.area === 'T' || t.area === 'C') {
    return {
      area: t.area,
      db: 0,
      start: t.byte,
      size: t.area === 'T' ? 'TIMER' : 'COUNTER',
      count: 1,
    };
  }
  const area = t.area === 'PI' ? 'P' : (t.area as 'I' | 'Q' | 'M' | 'DB');
  const item: ReadItem = {
    area,
    db: t.area === 'DB' ? (t.db ?? 0) : 0,
    start: t.byte,
    size: t.size === 'X' ? 'BIT' : SIZE_NAME[t.size],
    count: 1,
  };
  if (t.size === 'X') item.bit = t.bit ?? 0;
  return item;
}

/** L'operando come item di write var (solo aree scrivibili). */
export function toWriteItem(t: PlcWatchTarget, data: Uint8Array): WriteItem {
  return { ...toReadItem(t), data };
}

const hex = (b: Uint8Array): string =>
  `16#${Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join('')}`;

/** L'indirizzo come lo mostra la tabella: `MW 10`, `M 0.0`, `DB5.DBW 10`. */
export function addressName(t: PlcWatchTarget): string {
  const bit = t.size === 'X' ? `.${t.bit ?? 0}` : '';
  if (t.area === 'DB') return `DB${t.db}.DB${t.size} ${t.byte}${bit}`;
  return t.size === 'X' ? `${t.area} ${t.byte}${bit}` : `${t.area}${t.size} ${t.byte}`;
}

/** Una riga di conferma dai byte che si scriveranno: `MW 10 ← 16#002A`, `M 0.0 ← 1`. */
export function confirmLine(t: PlcWatchTarget, data: Uint8Array): string {
  return `${addressName(t)} ← ${t.size === 'X' ? String(data[0]) : hex(data)}`;
}

const expectedBytes = (t: PlcWatchTarget): number =>
  t.area === 'T' || t.area === 'C' ? 2 : BYTES[t.size];

/**
 * Lettura degli operandi di una tabella di controllo sul collegamento in sola lettura della
 * finestra. Il codice di ritorno di ogni item diventa l'errore della sola riga; un errore del
 * giro intero dà `{ ok: false }` (se è di collegamento, il collegamento è perso come nella
 * sorveglianza). Mai eccezioni.
 */
export async function readWatch(
  service: Pick<PlcService, 'read'>,
  owner: PlcOwner,
  rawItems: unknown,
  deadlineMs = DEADLINE_MS,
): Promise<PlcReadWatchResult> {
  const list = parseWatchList(rawItems);
  if (typeof list === 'string') return { ok: false, error: list };
  // Un operando non valido dà l'errore della sua sola riga e non entra nella richiesta.
  const values: PlcWatchValue[] = list.map(() => ({ error: 'Operando non valido' }));
  const valid: { at: number; target: PlcWatchTarget }[] = [];
  list.forEach((raw, at) => {
    const t = parseWatchTarget(raw, READ_AREAS);
    if (typeof t === 'string') values[at] = { error: t };
    else valid.push({ at, target: t });
  });
  if (valid.length === 0) return { ok: true, values };
  const items = valid.map((v) => toReadItem(v.target));
  const r = await service.read(owner, (run) => run((c) => c.readItems(items)), deadlineMs);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value.length !== valid.length) {
    return { ok: false, error: 'La CPU ha risposto con un numero di valori inatteso' };
  }
  r.value.forEach((res, i) => {
    const { at, target } = valid[i]!;
    if (!res.ok) values[at] = { error: res.name };
    else if (res.data.length !== expectedBytes(target)) {
      values[at] = { error: 'Valore di lunghezza inattesa' };
    } else values[at] = { bytes: res.data };
  });
  return { ok: true, values };
}
