import { S7Error, type S7Client } from '@baaportal/s7comm';
import { connectTcp } from '@baaportal/s7comm/node';
import type { ConnectOptions } from '@baaportal/s7comm';
import { toPlcIdentity, toPlcMode } from './plcMap';
import type {
  PlcAccess,
  PlcConnectResult,
  PlcEvent,
  PlcLostReason,
  PlcIdentity,
  PlcMode,
  PlcStatus,
} from '@baaportal/ui';

/** Quanto serve di una finestra: abbastanza per i test senza Electron. */
export interface PlcOwner {
  isDestroyed(): boolean;
  send(channel: string, event: PlcEvent): void;
  once(event: 'destroyed', cb: () => void): unknown;
  removeListener(event: 'destroyed', cb: () => void): unknown;
}

type Client = Pick<
  S7Client,
  'identity' | 'mode' | 'protection' | 'close' | 'closed' | 'listBlocks' | 'blockInfo'
>;
/** Il collegamento in sola lettura, come lo vedono le richieste di lettura (elenco blocchi). */
export type ReadClient = Pick<Client, 'listBlocks' | 'blockInfo'>;
export type PlcConnectFn = (o: Omit<ConnectOptions, 'transport'>) => Promise<Client>;

export interface PlcServiceOptions {
  /** Periodo della sorveglianza (ms). */
  intervalMs?: number;
  /** Tempo massimo di una lettura dello stato (ms). */
  readTimeoutMs?: number;
  /** Tempo massimo per aprire il collegamento (ms). */
  connectTimeoutMs?: number;
  /** Iniettabile nei test (trasporto finto). */
  connect?: PlcConnectFn;
}

const DEFAULT_PORT = 102;
const CONNECTION_TYPES = { PG: 'pg', OP: 'op', S7_BASIC: 'basic' } as const;

interface Link {
  /** Numero progressivo: distingue un collegamento da uno successivo allo stesso indirizzo. */
  id: number;
  access: PlcAccess;
  identity: PlcIdentity;
  client: Client;
  mode: PlcMode;
  timer: NodeJS.Timeout;
  onGone: () => void;
  /** Richieste in coda o in corso (sorveglianza compresa): se > 0 il giro di sorveglianza salta. */
  active: number;
  /** Coda: una sola richiesta alla volta sulla connessione. */
  chain: Promise<unknown>;
  failures: number;
  done: boolean;
}

export function connectMessage(err: unknown, access: PlcAccess): string {
  const port = access.port ?? DEFAULT_PORT;
  if (err instanceof S7Error) {
    if (err.code === 'COTP_REJECTED')
      return 'La CPU ha rifiutato il collegamento (rack/slot o TSAP)';
    if (['CONNECT_REFUSED', 'CONNECT_TIMEOUT', 'TIMEOUT'].includes(err.code)) {
      return `Nessuna risposta da ${access.host}:${port}`;
    }
    if (err.code === 'ABORTED') return 'Collegamento annullato';
    return `Collegamento non riuscito: ${err.message}`;
  }
  return `Collegamento non riuscito: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Collegamenti online in sola lettura, uno per finestra. Vive nel processo principale: la rete la
 * usa solo questo servizio. Dopo il collegamento sorveglia la CPU (stato ogni intervallo) e avvisa
 * la finestra di un cambio di modo o della perdita del collegamento.
 */
export class PlcService {
  private readonly links = new Map<PlcOwner, Link>();
  private linkSeq = 0;
  /** Per finestra: numero dell'ultimo connect, per scartare quelli superati mentre attendono. */
  private readonly epochs = new WeakMap<PlcOwner, number>();
  /** Finestre con un connect in attesa: servono a `closeAll` per annullarlo. */
  private readonly pending = new Map<PlcOwner, number>();
  private readonly intervalMs: number;
  private readonly readTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly connectFn: PlcConnectFn;

  constructor(o: PlcServiceOptions = {}) {
    this.intervalMs = o.intervalMs ?? 1000;
    this.readTimeoutMs = o.readTimeoutMs ?? 2000;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000;
    this.connectFn = o.connect ?? connectTcp;
  }

  async connect(owner: PlcOwner, access: PlcAccess): Promise<PlcConnectResult> {
    this.pending.set(owner, (this.pending.get(owner) ?? 0) + 1);
    try {
      return await this.doConnect(owner, access);
    } finally {
      const n = (this.pending.get(owner) ?? 1) - 1;
      if (n > 0) this.pending.set(owner, n);
      else this.pending.delete(owner);
    }
  }

  private async doConnect(owner: PlcOwner, access: PlcAccess): Promise<PlcConnectResult> {
    const epoch = this.bump(owner);
    await this.drop(owner);
    if (owner.isDestroyed()) return { ok: false, error: 'Finestra chiusa' };
    let client: Client;
    try {
      client = await this.connectFn({
        host: access.host,
        port: access.port ?? DEFAULT_PORT,
        rack: access.rack,
        slot: access.slot,
        connectionType: CONNECTION_TYPES[access.connectionType],
        ...(access.remoteTsap !== undefined ? { remoteTsap: access.remoteTsap } : {}),
        timeoutMs: this.connectTimeoutMs,
        mode: 'read-only',
      });
    } catch (err) {
      return { ok: false, error: connectMessage(err, access) };
    }
    // Un connect più recente o la chiusura della finestra durante l'attesa: questo non serve più.
    if (this.epochs.get(owner) !== epoch || owner.isDestroyed()) {
      await client.close().catch(() => undefined);
      return { ok: false, error: 'Collegamento annullato' };
    }
    let identity: PlcIdentity;
    let mode: PlcMode;
    let protection: string | undefined;
    try {
      identity = toPlcIdentity(await client.identity());
      mode = toPlcMode(await client.mode());
      try {
        const p = await client.protection();
        protection = p.modeSwitch;
      } catch {
        protection = undefined; // la protezione è un di più: la sua assenza non impedisce il collegamento
      }
    } catch (err) {
      await client.close().catch(() => undefined);
      return { ok: false, error: connectMessage(err, access) };
    }
    if (this.epochs.get(owner) !== epoch || owner.isDestroyed()) {
      await client.close().catch(() => undefined);
      return { ok: false, error: 'Collegamento annullato' };
    }
    const link: Link = {
      id: ++this.linkSeq,
      access,
      identity,
      client,
      mode,
      timer: setInterval(() => void this.tick(owner, link), this.intervalMs),
      onGone: () => void this.drop(owner),
      active: 0,
      chain: Promise.resolve(),
      failures: 0,
      done: false,
    };
    owner.once('destroyed', link.onGone);
    this.links.set(owner, link);
    return protection === undefined
      ? { ok: true, identity, mode }
      : { ok: true, identity, mode, protection };
  }

  private bump(owner: PlcOwner): number {
    const n = (this.epochs.get(owner) ?? 0) + 1;
    this.epochs.set(owner, n);
    return n;
  }

  async disconnect(owner: PlcOwner): Promise<void> {
    this.bump(owner); // annulla un connect in attesa
    await this.drop(owner);
  }

  status(owner: PlcOwner): PlcStatus {
    const link = this.links.get(owner);
    return link ? { connected: true, access: link.access } : { connected: false };
  }

  /**
   * Bersaglio delle scritture: indirizzo e identità del collegamento attivo della stessa finestra.
   * Il renderer non passa mai un indirizzo, lo decide solo questo.
   */
  target(
    owner: PlcOwner,
  ): { access: PlcAccess; identity: PlcIdentity; linkId: number } | undefined {
    const link = this.links.get(owner);
    return link ? { access: link.access, identity: link.identity, linkId: link.id } : undefined;
  }

  /**
   * Esegue una lettura sul collegamento della finestra, in coda dietro alle altre richieste e alla
   * sorveglianza: sulla connessione non corrono mai due richieste insieme. Senza collegamento
   * (o se cade durante l'attesa) dà `{ ok: false, error }`; mai eccezioni.
   */
  async read<T>(
    owner: PlcOwner,
    fn: (client: ReadClient) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const link = this.links.get(owner);
    if (!link) return { ok: false, error: 'Nessun collegamento online' };
    try {
      const value = await this.exclusive(link, async () => {
        if (link.done) throw new S7Error('CLOSED', 'collegamento chiuso');
        return fn(link.client);
      });
      return { ok: true, value };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Accoda `fn` dietro alle richieste precedenti del collegamento. */
  private exclusive<T>(link: Link, fn: () => Promise<T>): Promise<T> {
    link.active++;
    const run = link.chain.then(fn, fn);
    link.chain = run.catch(() => undefined);
    return run.finally(() => {
      link.active--;
    });
  }

  /** Chiude tutto (uscita dall'app). */
  async closeAll(): Promise<void> {
    for (const o of this.pending.keys()) this.bump(o); // annulla i connect in attesa
    await Promise.all([...this.links.keys()].map((o) => this.drop(o)));
  }

  /** Ferma la sorveglianza e chiude il socket; non manda eventi. */
  private async drop(owner: PlcOwner): Promise<void> {
    const link = this.links.get(owner);
    if (!link) return;
    this.links.delete(owner);
    this.finish(owner, link);
    await link.client.close().catch(() => undefined);
  }

  private finish(owner: PlcOwner, link: Link): void {
    link.done = true;
    clearInterval(link.timer);
    owner.removeListener('destroyed', link.onGone);
  }

  private emit(owner: PlcOwner, event: PlcEvent): void {
    if (!owner.isDestroyed()) owner.send('plc:event', event);
  }

  private lost(owner: PlcOwner, link: Link, reason: PlcLostReason): void {
    if (link.done) return;
    this.links.delete(owner);
    this.finish(owner, link);
    void link.client.close().catch(() => undefined);
    this.emit(owner, { kind: 'lost', reason });
  }

  /** Un giro di sorveglianza; se la lettura precedente non è finita, salta. */
  private async tick(owner: PlcOwner, link: Link): Promise<void> {
    if (link.done || link.active > 0) return;
    if (link.client.closed) {
      this.lost(owner, link, 'closed');
      return;
    }
    await this.exclusive(link, () => this.poll(owner, link));
  }

  private async poll(owner: PlcOwner, link: Link): Promise<void> {
    if (link.done) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new S7Error('TIMEOUT', 'nessuna risposta dalla CPU')),
          this.readTimeoutMs,
        );
      });
      const m = toPlcMode(await Promise.race([link.client.mode(), timeout]));
      if (link.done) return;
      link.failures = 0;
      if (m !== link.mode) {
        link.mode = m;
        this.emit(owner, { kind: 'mode', mode: m });
      }
    } catch (err) {
      if (link.done) return;
      link.failures++;
      const fatal = err instanceof S7Error && (err.code === 'TIMEOUT' || err.code === 'CLOSED');
      if (fatal || link.failures >= 2 || link.client.closed) {
        this.lost(
          owner,
          link,
          err instanceof S7Error && err.code === 'TIMEOUT'
            ? 'timeout'
            : fatal || link.client.closed
              ? 'closed'
              : 'errors',
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
