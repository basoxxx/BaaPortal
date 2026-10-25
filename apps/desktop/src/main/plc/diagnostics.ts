import {
  S7Error,
  cycleConfigFrom,
  cycleTimeFrom,
  diagRecordsFrom,
  identityFrom,
  isUnavailable,
  lastModeChangeFrom,
  ledsFrom,
  memoryFrom,
  modeFrom,
  protectionFrom,
  type DiagRecord,
} from '@baaportal/s7comm';
import type { DiagEventView, DiagPart, DiagValue, PlcDiagData, PlcDiagResult } from '@baaportal/ui';
import { toPlcIdentity, toPlcMode } from './plcMap';
import type { PlcOwner, PlcService, ReadClient } from './plcService';

const PARTS: readonly DiagPart[] = [
  'identity',
  'mode',
  'leds',
  'protection',
  'lastModeChange',
  'cycle',
  'memory',
  'buffer',
  'clock',
  'force',
];
/** Tempo massimo di tutta la lettura (ms). */
const DEADLINE_MS = 5000;
const TOO_LONG = 'Lettura troppo lunga';

/** Controlla ciò che arriva dal renderer: parti note, distinte, . */
export function parseDiagParts(raw: unknown): DiagPart[] | string {
  if (!Array.isArray(raw)) return 'Elenco di parti non valido';
  if (raw.length > PARTS.length) return `Troppe parti (massimo ${PARTS.length})`;
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== 'string' || !(PARTS as readonly string[]).includes(p)) {
      return 'Parte della diagnostica non valida';
    }
    if (seen.has(p)) return 'Parte della diagnostica ripetuta';
    seen.add(p);
  }
  return raw as DiagPart[];
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function view(r: DiagRecord): DiagEventView {
  const out: DiagEventView = {
    eventId: r.eventId,
    priority: r.priority,
    obNumber: r.obNumber,
    datId: r.datId,
    info1: r.info1,
    info2: r.info2,
  };
  if (r.time) out.time = r.time;
  if (r.rawTime) out.rawTime = hex(r.rawTime);
  return out;
}

/** Errori che fanno perdere il collegamento: non sono errori di una parte. */
function isTransport(err: unknown): boolean {
  return err instanceof S7Error && (err.code === 'CLOSED' || err.code === 'TIMEOUT');
}

/** La scadenza della lettura: i passi successivi non partono, il collegamento resta. */
function isDeadline(err: unknown): boolean {
  return err instanceof S7Error && err.code === 'ABORTED';
}

/** Il LED FRCE (0x0174, indice 6): acceso = forzamento attivo sulla CPU. */
export const FRCE_LED = 0x0006;
export function forceFrom(list: Parameters<typeof ledsFrom>[0]): boolean {
  return ledsFrom(list).some((l) => l.id === FRCE_LED && l.on);
}

type Run = <R>(fn: (c: ReadClient) => Promise<R>) => Promise<R>;

const READERS: {
  [K in DiagPart]: (
    run: Run,
  ) => Promise<NonNullable<PlcDiagData[K]> extends DiagValue<infer T> ? T : never>;
} = {
  identity: async (run) => {
    const base = await run((c) => c.readSzl(0x0011, 0));
    let extra;
    try {
      extra = await run((c) => c.readSzl(0x001c, 0));
    } catch (e) {
      if (isTransport(e)) throw e; // la 0x001C è un di più: la sua assenza non conta
    }
    return toPlcIdentity(identityFrom(base, extra));
  },
  mode: async (run) => toPlcMode(modeFrom(await run((c) => c.readSzl(0x0424, 0)))),
  leds: async (run) => ledsFrom(await run((c) => c.readSzl(0x0019, 0))),
  protection: async (run) => protectionFrom(await run((c) => c.readSzl(0x0232, 4))),
  lastModeChange: async (run) => {
    const r = lastModeChangeFrom(await run((c) => c.readSzl(0x0124, 0)));
    return r ? view(r) : null;
  },
  cycle: async (run) => {
    const time = cycleTimeFrom(await run((c) => c.readSzl(0x0222, 1)));
    const config = cycleConfigFrom(await run((c) => c.readSzl(0x0222, 0x50)));
    return { time, config };
  },
  memory: async (run) => memoryFrom(await run((c) => c.readSzl(0x0013, 0))),
  buffer: async (run) => diagRecordsFrom(await run((c) => c.readSzl(0x00a0, 0))).map(view),
  clock: (run) => run((c) => c.readClock()),
  force: async (run) => forceFrom(await run((c) => c.readSzl(0x0174, FRCE_LED))),
};

/**
 * Diagnostica in sola lettura sul collegamento della finestra. Ogni SZL è un posto a sé in coda,
 * così la sorveglianza passa fra l'una e l'altra. Una lista che la CPU non ha è `unavailable`;
 * un altro errore della CPU resta di quella sola parte; un errore di collegamento (chiuso, senza
 * risposta) fa perdere il collegamento e il risultato è `{ ok: false }`. Oltre la scadenza le parti
 * già lette restano e le altre dicono «Lettura troppo lunga»; il collegamento resta.
 */
export async function readDiagnostics(
  service: Pick<PlcService, 'read'>,
  owner: PlcOwner,
  rawParts: unknown,
  deadlineMs = DEADLINE_MS,
): Promise<PlcDiagResult> {
  const parts = parseDiagParts(rawParts);
  if (typeof parts === 'string') return { ok: false, error: parts };
  const r = await service.read(
    owner,
    async (run) => {
      const data: Record<string, DiagValue<unknown>> = {};
      let late = false;
      for (const part of parts) {
        if (late) {
          data[part] = { ok: false, error: TOO_LONG };
          continue;
        }
        try {
          data[part] = { ok: true, value: await READERS[part](run) };
        } catch (err) {
          if (isTransport(err)) throw err;
          if (isDeadline(err)) {
            late = true;
            data[part] = { ok: false, error: TOO_LONG };
            continue;
          }
          data[part] = isUnavailable(err)
            ? { ok: false, unavailable: true }
            : { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return data as Partial<PlcDiagData>;
    },
    deadlineMs,
  );
  return r.ok ? { ok: true, data: r.value } : { ok: false, error: r.error };
}
