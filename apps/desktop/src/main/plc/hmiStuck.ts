import { readFileSync } from 'node:fs';
import type { PlcHmiStuckEntry } from '@baaportal/ui';
import { writeFileAtomic } from '../fsAtomic';
import type { HmiStuckLog } from './plcWrite';

/** Al massimo tante voci: la più vecchia esce. */
export const MAX_HMI_STUCK = 50;

const isEntry = (e: unknown): e is PlcHmiStuckEntry => {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return ['key', 'address', 'cpu', 'at'].every(
    (k) => typeof r[k] === 'string' && (r[k] as string).length <= 500,
  );
};

/**
 * Impulsi del runtime HMI il cui 0 automatico non è riuscito (il bit può essere rimasto a 1). Resta
 * su disco finché l'utente non lo prende visione o uno 0 riuscito sullo stesso bit lo toglie;
 * `changed` avvisa la finestra (e `added` dice quale voce è nuova).
 */
export class HmiStuckStore implements HmiStuckLog {
  private entries: PlcHmiStuckEntry[] = [];
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly changed: (list: PlcHmiStuckEntry[], added?: PlcHmiStuckEntry) => void,
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('non è un elenco');
      this.entries = raw.filter(isEntry).slice(-MAX_HMI_STUCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn(`Registro degli impulsi HMI illeggibile, riparto vuoto: ${String(err)}`);
      }
    }
  }

  list(): PlcHmiStuckEntry[] {
    return [...this.entries];
  }

  add(e: PlcHmiStuckEntry): Promise<void> {
    this.entries = [...this.entries.filter((x) => x.key !== e.key), e].slice(-MAX_HMI_STUCK);
    this.changed(this.list(), e);
    return this.save();
  }

  clear(key: string): Promise<void> {
    if (!this.entries.some((x) => x.key === key)) return this.saving;
    this.entries = this.entries.filter((x) => x.key !== key);
    this.changed(this.list());
    return this.save();
  }

  /** L'utente ha visto l'avviso: le voci mostrate escono. */
  ack(keys: unknown): Promise<void> {
    if (!Array.isArray(keys)) return this.saving;
    const seen = new Set(keys.filter((k): k is string => typeof k === 'string'));
    const before = this.entries.length;
    this.entries = this.entries.filter((x) => !seen.has(x.key));
    if (this.entries.length === before) return this.saving;
    this.changed(this.list());
    return this.save();
  }

  /** Scritture una dopo l'altra, sempre dell'elenco di adesso. */
  private save(): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await writeFileAtomic(this.path, new TextEncoder().encode(JSON.stringify(this.entries)));
      } catch (err) {
        this.warn(`Registro degli impulsi HMI non scritto: ${String(err)}`);
      }
    };
    this.saving = this.saving.then(run);
    return this.saving;
  }
}
