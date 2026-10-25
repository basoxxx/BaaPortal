import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Registro dei job di test creati da questa app: solo questi si cancellano come orfani. */
export interface TisJobStore {
  add(cpu: string, fn: number, job: number): void;
  remove(cpu: string, fn: number, job: number): void;
  list(cpu: string): { fn: number; job: number }[];
}

interface Entry {
  cpu: string;
  fn: number;
  job: number;
}

/** Al massimo tante voci: la più vecchia esce. */
export const MAX_TIS_JOBS = 64;

const isEntry = (e: unknown): e is Entry => {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r['cpu'] === 'string' &&
    Number.isInteger(r['fn']) &&
    Number.isInteger(r['job']) &&
    (r['fn'] as number) >= 0 &&
    (r['fn'] as number) <= 255 &&
    (r['job'] as number) >= 0 &&
    (r['job'] as number) <= 255
  );
};

class Store implements TisJobStore {
  constructor(
    private entries: Entry[],
    private readonly save: (entries: Entry[]) => void,
  ) {}

  add(cpu: string, fn: number, job: number): void {
    const rest = this.entries.filter((e) => !(e.cpu === cpu && e.fn === fn && e.job === job));
    rest.push({ cpu, fn, job });
    this.entries = rest.slice(-MAX_TIS_JOBS);
    this.save(this.entries);
  }

  remove(cpu: string, fn: number, job: number): void {
    const rest = this.entries.filter((e) => !(e.cpu === cpu && e.fn === fn && e.job === job));
    if (rest.length === this.entries.length) return;
    this.entries = rest;
    this.save(this.entries);
  }

  list(cpu: string): { fn: number; job: number }[] {
    return this.entries.filter((e) => e.cpu === cpu).map((e) => ({ fn: e.fn, job: e.job }));
  }
}

/** Registro solo in memoria (test e valore predefinito senza disco). */
export function memoryJobStore(): TisJobStore {
  return new Store([], () => undefined);
}

/**
 * Registro su file JSON, scritto in modo atomico (temporaneo + rinomina). Un file illeggibile vale
 * come vuoto, con un avviso. Un errore di scrittura non ferma l'osservazione: lo si avvisa e basta.
 */
export function fileJobStore(
  path: string,
  warn: (msg: string) => void = (m) => console.warn(m),
): TisJobStore {
  let entries: Entry[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('non è un elenco');
    entries = raw.filter(isEntry).slice(-MAX_TIS_JOBS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`Registro dei job di test illeggibile, riparto vuoto: ${String(err)}`);
    }
  }
  return new Store(entries, (list) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(list));
      renameSync(tmp, path);
    } catch (err) {
      warn(`Registro dei job di test non scritto: ${String(err)}`);
    }
  });
}
