import { S7Error } from '../errors';
import { lineWriter, type PduLink, type PduLinkFactory } from '../link';
import { assertOutgoingPdu, type ConnectionMode } from '../readOnlyGuard';
import type { Transport } from '../transport';
import { DLE, MpiFrameDecoder, STX, encodeMpiFrame, type MpiItem } from './framing';

/*
 * PC Adapter MPI (RS232 o USB-COM), varianti v1 e v2 del protocollo. Fonte di tutti i byte:
 * libnodave (nodave.c, nodave.h, doc/MPI.html), riscritti come fatti; niente codice copiato.
 * Ogni costante è da verificare su adattatore reale: il protocollo non è mai stato provato qui.
 */

export type MpiOptions = {
  /** Indirizzo MPI dell'adattatore (di solito 0). */
  localAddress: number;
  /** Indirizzo MPI della CPU (di solito 2). */
  cpuAddress: number;
  /** Indirizzo più alto del bus (HSA, di solito 31). */
  highestAddress: number;
  busSpeed: '187.5k' | '19.2k' | '1.5M';
  /** `auto` prova v1 e poi v2 a ogni apertura. */
  variant: 'auto' | 'v1' | 'v2';
};

type Variant = 'v1' | 'v2';

const NO_ADAPTER = 'Adattatore MPI non risponde: controllare porta, velocità e cavo';

// Codice della velocità del bus nel byte 15 della configurazione.
// libnodave nodave.h (righe 148-154); da verificare su adattatore reale.
const SPEED_CODE = { '19.2k': 0x01, '187.5k': 0x02, '1.5M': 0x04 } as const;
// Byte 7 della configurazione (probabilmente Tslot): 3C, 96 a 1,5M.
// libnodave nodave.c, init MPI v1 e v2 (righe 2559-2562, 2621-2624); da verificare su adattatore reale.
const TSLOT = { '19.2k': 0x3c, '187.5k': 0x3c, '1.5M': 0x96 } as const;
// Numero di connessione locale: 0x14 in v1, 0x03 in v2.
// libnodave nodave.c (righe 154, 187); da verificare su adattatore reale.
const OWN_CN = { v1: 0x14, v2: 0x03 } as const;
// Comandi dell'adattatore `01 cmd 02`: versione, elenco dei nodi, chiusura, passo E=03xx.
// libnodave nodave.c (righe 2579, 3442, 3408, 2596); da verificare su adattatore reale.
const CMD_VERSION = Uint8Array.of(0x01, 0x0d, 0x02);
const CMD_PARTNERS = Uint8Array.of(0x01, 0x07, 0x02);
const CMD_DISCONNECT = Uint8Array.of(0x01, 0x04, 0x02);
const CMD_E03 = Uint8Array.of(0x01, 0x0c, 0x02);
// Blocco E0 della richiesta di connessione dopo l'intestazione.
// libnodave nodave.c, connect MPI v1 (righe 3606-3660) e v2 (3525-3598); da verificare su adattatore reale.
const E0_V1 = [0xe0, 0x04, 0x00, 0x80, 0x00, 0x02, 0x00, 0x02, 0x01, 0x00, 0x01, 0x00];
const E0_V2_HEAD = [0xe0, 0x04, 0x00, 0x80, 0x00, 0x02, 0x01, 0x06, 0x01, 0x00, 0x00, 0x01, 0x02];

// Tipo del telegramma dopo l'intestazione: dati, ack, conferma di connessione, disconnessione.
// libnodave nodave.c (righe 2331-2370, 3606-3660, 3456-3493); da verificare su adattatore reale.
const T_DATA = 0xf1;
const T_ACK = 0xb0;
const T_CONFIRM = 0xd0;
const T_DISCONNECT = 0x80;
const T_DISCONNECT_REPLY = 0xc0; // risposta presunta: contenuto non confermato dalla fonte
// Stato «stazione attiva» nell'elenco dei nodi. libnodave nodave.h (righe 875-878); da verificare.
const NODE_ACTIVE = 0x30;
/** Tentativi di un telegramma senza DLE di risposta (3964R). */
const ATTEMPTS = 3;
/** Timeout di `listMpiNodes` se non è dato, e massimo per un DLE. libnodave nodave.c riga 153 (1 s). */
const LIST_TIMEOUT_MS = 1000;

/**
 * Attesa di un DLE: un quarto del timeout (al più 1 s), così i tentativi finiscono prima del
 * timeout della richiesta S7 e l'errore resta «Adattatore MPI non risponde».
 */
const dleWaitMs = (timeoutMs: number): number =>
  Math.min(LIST_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / (ATTEMPTS + 1))));

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const describe = (it: MpiItem): string => (typeof it === 'string' ? it : `frame [${hex(it)}]`);
const isTimeout = (e: unknown): boolean => e instanceof S7Error && e.code === 'MPI_NO_ADAPTER';

function checkOptions(o: Omit<MpiOptions, 'cpuAddress'> & { cpuAddress?: number }): void {
  for (const [name, v] of [
    ['localAddress', o.localAddress],
    ['cpuAddress', o.cpuAddress],
    ['highestAddress', o.highestAddress],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 126)) {
      throw new RangeError(`${name} ${v} fuori 0-126`);
    }
  }
  if (o.cpuAddress !== undefined && o.cpuAddress === o.localAddress) {
    throw new RangeError(`indirizzo MPI ${o.cpuAddress} uguale per adattatore e CPU`);
  }
  if (!Object.hasOwn(SPEED_CODE, o.busSpeed)) {
    throw new RangeError(`velocità del bus "${String(o.busSpeed)}" sconosciuta`);
  }
  if (o.variant !== 'auto' && o.variant !== 'v1' && o.variant !== 'v2') {
    throw new RangeError(`variante MPI "${String(o.variant)}" sconosciuta`);
  }
}

/**
 * Configurazione dell'adattatore (`01 03 02`, 23 byte): indirizzo locale nel byte 16, velocità
 * nel 15, HSA nel 17. Gli altri byte sono quelli di libnodave, senza significato noto.
 * libnodave nodave.c, init MPI v1 (righe 2588-2595) e v2 (2546-2553); da verificare su adattatore reale.
 */
function configTelegram(v: Variant, o: Omit<MpiOptions, 'cpuAddress'>): Uint8Array {
  return Uint8Array.of(
    0x01,
    0x03,
    0x02,
    v === 'v1' ? 0x27 : 0x17,
    0x00,
    0x9f,
    0x01,
    TSLOT[o.busSpeed],
    0x00,
    0x90,
    0x01,
    0x14,
    0x00,
    0x00,
    0x05,
    SPEED_CODE[o.busSpeed],
    o.localAddress,
    o.highestAddress,
    v === 'v1' ? 0x02 : 0x05,
    0x01,
    0x01,
    0x03,
    0x80,
  );
}

/** Risposta `01 ?? 20` seguita da un testo: v1 vuole "V00.", "E=03" chiede il passo in più. */
function replyText(p: Uint8Array): string | undefined {
  if (p.length < 3 || p[0] !== 0x01 || p[2] !== 0x20) return undefined;
  return String.fromCharCode(...p.subarray(3, 7));
}

// ---- linea: byte in arrivo e attese con timeout ---------------------------------------------

/** La porta verso l'adattatore: elementi in arrivo in coda, un solo lettore alla volta. */
class Line {
  #items: MpiItem[] = [];
  readonly #dec = new MpiFrameDecoder();
  /** Si risolve quando la porta è chiusa davvero (dopo `fail`). */
  #closed: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #err: Error | undefined;
  readonly #write: (b: Uint8Array) => void;
  readonly #close: () => void | Promise<void>;
  onFail: ((err: Error) => void) | undefined;

  constructor(t: Transport) {
    this.#write = lineWriter(t);
    this.#close = () => t.close();
    t.onData((chunk) => {
      if (this.#err) return;
      this.#items.push(...this.#dec.push(chunk));
      this.poke();
    });
    t.onClose((err) =>
      this.fail(
        err instanceof S7Error
          ? err
          : new S7Error(
              'CLOSED',
              `porta dell'adattatore MPI chiusa${err ? `: ${err.message}` : ''}`,
            ),
      ),
    );
  }

  get error(): Error | undefined {
    return this.#err;
  }

  write(b: number | Uint8Array): void {
    if (this.#err) throw this.#err;
    this.#write(typeof b === 'number' ? Uint8Array.of(b) : b);
  }

  peek(): MpiItem | undefined {
    return this.#items[0];
  }

  shift(): MpiItem | undefined {
    return this.#items.shift();
  }

  /** Scarta ciò che è arrivato, compreso un frame a metà. */
  clear(): void {
    this.#items = [];
    this.#dec.reset();
  }

  /** Il prossimo dato dopo il nostro DLE è un frame. */
  expectFrame(): void {
    this.#dec.expectFrame();
  }

  /** La porta chiusa davvero: subito se la linea è ancora aperta (nessuna chiusura chiesta). */
  get closed(): Promise<void> {
    return this.#closed ?? Promise.resolve();
  }

  /** Il prossimo elemento entro `timeoutMs`; se non arriva, `MPI_NO_ADAPTER`. */
  async next(timeoutMs: number, what: string): Promise<MpiItem> {
    const deadline = Date.now() + timeoutMs;
    while (this.#items.length === 0) {
      if (this.#err) throw this.#err;
      if (!(await this.wait(Math.max(0, deadline - Date.now())))) {
        throw new S7Error('MPI_NO_ADAPTER', `${NO_ADAPTER} (atteso ${what} entro ${timeoutMs} ms)`);
      }
    }
    return this.#items.shift()!;
  }

  /** Aspetta un dato, un errore o `poke`; `false` se scade `ms` (senza `ms`, solo `poke`). */
  wait(ms?: number): Promise<boolean> {
    if (this.#err || this.#items.length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer =
        ms === undefined
          ? undefined
          : setTimeout(() => {
              this.#wake = undefined;
              resolve(false);
            }, ms);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve(true);
      };
    });
  }

  poke(): void {
    this.#wake?.();
  }

  fail(err: Error): void {
    if (this.#err) return;
    this.#err = err;
    this.#items = [];
    try {
      this.#closed = Promise.resolve(this.#close()).catch(() => undefined);
    } catch {
      // già chiusa
    }
    this.poke();
    this.onFail?.(err);
  }
}

// ---- procedura 3964R: un telegramma in uscita, uno in arrivo --------------------------------

interface TransmitOptions {
  /** Frame dell'adattatore arrivato in collisione (vince lui); il nostro riparte dopo. */
  onCollision?: (frame: Uint8Array) => void;
  attempts?: number;
  /**
   * Telegramma dati (una PDU S7): una volta sul filo si rimanda solo dopo un NAK. Senza DLE non si
   * sa se l'adattatore l'ha preso (DLE perso) e rimandarlo potrebbe far eseguire due volte una
   * scrittura alla CPU; in quel caso il collegamento cade.
   */
  data?: boolean;
}

/**
 * PC → adattatore: STX, DLE, frame, DLE. Fino a `attempts` tentativi interi se manca un DLE o
 * arriva un NAK. Se all'STX risponde un altro STX (collisione) vince l'adattatore: il suo frame
 * va a `onCollision` e il nostro riparte dopo. libnodave nodave.c `_daveSendDialog2`; doc/MPI.html.
 */
async function transmit(
  line: Line,
  payload: Uint8Array,
  timeoutMs: number,
  o: TransmitOptions = {},
): Promise<void> {
  const frame = encodeMpiFrame(payload);
  const dleMs = dleWaitMs(timeoutMs);
  const attempts = o.attempts ?? ATTEMPTS;
  for (let n = 1; ; n++) {
    let collided: Uint8Array | undefined;
    let onWire = false;
    let nak = false;
    try {
      line.write(STX);
      let r = await line.next(dleMs, 'DLE dopo STX');
      if (r === 'STX' && o.onCollision) {
        collided = await receiveFrame(line, timeoutMs);
      } else {
        if (r !== 'DLE') throw new S7Error('MPI_FRAME', `dopo STX arrivato ${describe(r)}`);
        line.write(frame);
        onWire = true;
        r = await line.next(dleMs, 'DLE dopo il frame');
        nak = r === 'NAK';
        if (r !== 'DLE') throw new S7Error('MPI_FRAME', `dopo il frame arrivato ${describe(r)}`);
        return;
      }
    } catch (e) {
      const unsure = o.data && onWire && !nak;
      if (line.error || n >= attempts || !(e instanceof S7Error) || unsure) throw e;
      line.clear();
    }
    if (collided && o.onCollision) {
      o.onCollision(collided); // fuori dal try: un suo errore non si ritenta
      n--;
    }
  }
}

/**
 * Adattatore → PC, dopo il suo STX già letto: DLE, frame, DLE. Un frame rovinato si scarta senza
 * DLE: l'adattatore riparte con uno STX e si risponde di nuovo, fino a `ATTEMPTS` volte.
 */
async function receiveFrame(line: Line, timeoutMs: number): Promise<Uint8Array> {
  for (let n = 1; ; n++) {
    line.expectFrame();
    line.write(DLE);
    const f = await line.next(timeoutMs, 'frame dell’adattatore');
    if (f instanceof Uint8Array) {
      line.write(DLE);
      return f;
    }
    if (f !== 'STX' || n >= ATTEMPTS) {
      throw new S7Error('MPI_FRAME', `atteso un frame, arrivato ${f}`);
    }
  }
}

/** Un telegramma dall'adattatore: STX, poi `receiveFrame`. */
async function receive(line: Line, timeoutMs: number): Promise<Uint8Array> {
  const s = await line.next(timeoutMs, 'STX dell’adattatore');
  if (s !== 'STX') throw new S7Error('MPI_FRAME', `atteso STX, arrivato ${describe(s)}`);
  return receiveFrame(line, timeoutMs);
}

async function exchange(line: Line, payload: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  await transmit(line, payload, timeoutMs);
  return receive(line, timeoutMs);
}

// ---- inizializzazione e connessione ---------------------------------------------------------

/**
 * Init v1: versione, configurazione (con il passo `01 0C 02` per gli adattatori "E=03xx").
 * Init v2: solo configurazione; la risposta deve essere `01 ?? 20 …` (libnodave non la
 * controlla). libnodave nodave.c righe 2544-2672; da verificare su adattatore reale.
 */
async function initVariant(
  line: Line,
  v: Variant,
  o: Omit<MpiOptions, 'cpuAddress'>,
  t: number,
): Promise<void> {
  const bad = (what: string, p: Uint8Array): S7Error =>
    new S7Error('MPI_FRAME', `adattatore MPI (${v}): risposta inattesa ${what}: ${hex(p)}`);
  if (v === 'v1') {
    const version = await exchange(line, CMD_VERSION, t);
    if (replyText(version) !== 'V00.') throw bad('alla richiesta di versione', version);
  }
  const conf = await exchange(line, configTelegram(v, o), t);
  const text = replyText(conf);
  if (v === 'v1' && text === 'E=03') {
    await exchange(line, CMD_E03, t); // risposta ignorata, come nella fonte
  } else if (v === 'v1' ? text !== 'V00.' : text === undefined) {
    throw bad('alla configurazione', conf);
  }
}

/** Prova le varianti in ordine; restituisce la prima che risponde. */
async function initAdapter(
  line: Line,
  o: Omit<MpiOptions, 'cpuAddress'>,
  t: number,
): Promise<Variant> {
  const variants: Variant[] = o.variant === 'auto' ? ['v1', 'v2'] : [o.variant];
  let last: unknown;
  for (const v of variants) {
    line.clear();
    try {
      await initVariant(line, v, o, t);
      return v;
    } catch (e) {
      if (line.error) throw line.error;
      last = e;
    }
  }
  throw last;
}

/**
 * Nodi attivi del bus: risposta di 133 byte, stato del nodo k nel byte 6 + k (k = 0..125).
 * libnodave nodave.c `_daveListReachablePartnersMPI` (righe 3440-3454); da verificare.
 */
async function readPartners(line: Line, t: number): Promise<number[]> {
  const p = await exchange(line, CMD_PARTNERS, t);
  if (p.length < 6 + 126) {
    throw new S7Error('MPI_FRAME', `elenco dei nodi MPI di ${p.length} byte: ${hex(p)}`);
  }
  const nodes: number[] = [];
  for (let k = 0; k < 126; k++) if (p[6 + k] === NODE_ACTIVE) nodes.push(k);
  return nodes;
}

/** Chiusura verso l'adattatore, un solo tentativo e risposta ignorata (come nella fonte). */
async function disconnectAdapter(line: Line, t: number): Promise<void> {
  await transmit(line, CMD_DISCONNECT, t, { attempts: 1 });
  await receive(line, t);
}

/** Apre la porta; riceve il tempo massimo (una porta occupata da noi stessi si aspetta fin lì). */
export type SerialOpener = (timeoutMs?: number) => Promise<Transport>;

async function openLine(
  transport: SerialOpener,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Line> {
  if (signal?.aborted) throw new S7Error('ABORTED', 'operazione annullata');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  const opening = transport(timeoutMs);
  try {
    const t = await Promise.race([
      opening,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          late = true;
          reject(
            new S7Error(
              'TIMEOUT',
              `la porta dell'adattatore MPI non si apre entro ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    return new Line(t);
  } finally {
    clearTimeout(timer);
    // una porta che si apre dopo il timeout si richiude subito
    if (late) void opening.then((t) => t.close()).catch(() => undefined);
  }
}

/** Apre la linea e la passa a `body`; un errore o l'annullamento chiudono la porta. */
async function withLine<T>(
  transport: SerialOpener,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  body: (line: Line) => Promise<T>,
): Promise<T> {
  const line = await openLine(transport, timeoutMs, signal);
  const onAbort = (): void => line.fail(new S7Error('ABORTED', 'operazione annullata'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await body(line);
  } catch (e) {
    line.fail(e instanceof Error ? e : new S7Error('MPI_FRAME', String(e)));
    await line.closed; // la porta è libera quando l'errore arriva
    throw signal?.aborted ? new S7Error('ABORTED', 'operazione annullata') : e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---- il link ---------------------------------------------------------------------------------

/**
 * Collegamento a una CPU attraverso il PC Adapter: ogni PDU va in un telegramma `F1 nr`, ogni
 * telegramma `F1` ricevuto si conferma con `B0 01 nr`. Un solo ciclo serve la linea: prima ciò
 * che manda l'adattatore (ha la precedenza), poi gli ack, poi le PDU.
 */
class MpiAdapterLink implements PduLink {
  readonly variant: Variant;
  readonly #line: Line;
  readonly #t: number;
  readonly #cpu: number;
  readonly #cn: number;
  readonly #mode: ConnectionMode;
  readonly #pduLength: () => number;
  #cn2 = 0;
  /** Numero del prossimo telegramma dati: 00..FF, poi da 01 (lo 0 solo la prima volta). */
  #nr = 0;
  readonly #acks: Uint8Array[] = [];
  readonly #outbox: Uint8Array[] = [];
  #closed = false;
  #closing = false;
  /** Entro quando deve arrivare il B0 dell'ultimo telegramma dati mandato. */
  #ackDeadline: number | undefined;
  #run: Promise<void> | undefined;
  #pduCb: ((s7: Uint8Array) => void) | undefined;
  #backlog: Uint8Array[] = [];
  #closeCb: ((err?: Error) => void) | undefined;
  #closedErr: Error | undefined;

  constructor(
    line: Line,
    variant: Variant,
    cpu: number,
    timeoutMs: number,
    mode: ConnectionMode,
    pduLength: () => number,
  ) {
    this.#line = line;
    this.#mode = mode;
    this.#pduLength = pduLength;
    this.variant = variant;
    this.#cpu = cpu;
    this.#t = timeoutMs;
    this.#cn = OWN_CN[variant];
  }

  /**
   * Intestazione dei telegrammi dopo la connessione. v1: `04 80|cpu 80 0C cn2 cn`;
   * v2: `00 0C cn2 cn`. libnodave nodave.c `_daveSendWithPrefix2` (righe 2331-2357); da verificare.
   */
  #header(): number[] {
    return this.variant === 'v1'
      ? [0x04, 0x80 | this.#cpu, 0x80, 0x0c, this.#cn2, this.#cn]
      : [0x00, 0x0c, this.#cn2, this.#cn];
  }

  get #hdrLen(): number {
    return this.variant === 'v1' ? 6 : 4;
  }

  /**
   * Richiesta di connessione E0, conferma D0 con il numero della CPU, poi `05 01` in tutte e
   * due le direzioni. libnodave nodave.c righe 3525-3660; da verificare su adattatore reale.
   */
  async connect(): Promise<void> {
    const line = this.#line;
    const cpu = this.#cpu;
    const req =
      this.variant === 'v1'
        ? Uint8Array.of(0x04, 0x80 | cpu, 0x80, 0x0d, 0x00, this.#cn, ...E0_V1)
        : Uint8Array.of(0x00, 0x0d, 0x00, this.#cn, ...E0_V2_HEAD, cpu, 0x01, 0x00);
    await transmit(line, req, this.#t);
    let confirm: Uint8Array | undefined;
    try {
      confirm = await receive(line, this.#t);
    } catch (e) {
      if (line.error || !isTimeout(e)) throw e;
    }
    const h = this.#hdrLen;
    if (confirm?.[h] !== T_CONFIRM) throw await this.#noCpu(confirm);
    this.#cn2 = confirm[h - 1]!;
    const ack = await exchange(line, Uint8Array.of(...this.#header(), 0x05, 0x01), this.#t);
    if (ack[h] !== 0x05 || ack[h + 1] !== 0x01) {
      throw new S7Error('MPI_FRAME', `conferma della connessione MPI inattesa: ${hex(ack)}`);
    }
    this.#run = this.#loop();
  }

  async #noCpu(reply: Uint8Array | undefined): Promise<S7Error> {
    const line = this.#line;
    line.clear();
    let seen: string;
    try {
      const nodes = await readPartners(line, this.#t);
      seen = nodes.length ? nodes.join(', ') : 'nessuno';
    } catch {
      if (line.error) throw line.error;
      seen = 'non letti';
    }
    const why = reply ? ` (risposta ${hex(reply)})` : '';
    return new S7Error(
      'MPI_NO_CPU',
      `Nessuna CPU risponde all'indirizzo MPI ${this.#cpu}${why}: nodi sul bus: ${seen}`,
    );
  }

  sendPdu(s7: Uint8Array): void {
    if (this.#closed || this.#closing) throw new S7Error('CLOSED', 'collegamento MPI chiuso');
    // secondo controllo, come `guardedSender` su ISO-on-TCP: il primo è in `S7Connection`
    assertOutgoingPdu(s7, this.#mode, this.#pduLength());
    const nr = this.#nr;
    this.#nr = nr === 0xff ? 1 : nr + 1;
    this.#outbox.push(Uint8Array.of(...this.#header(), T_DATA, nr, ...s7));
    this.#line.poke();
  }

  onPdu(cb: (s7: Uint8Array) => void): void {
    this.#pduCb = cb;
    const pending = this.#backlog;
    this.#backlog = [];
    for (const p of pending) cb(p);
  }

  onClose(cb: (err?: Error) => void): void {
    this.#closeCb = cb;
    if (this.#closedErr) cb(this.#closedErr);
  }

  /**
   * Disconnessione dalla CPU e dall'adattatore (un tentativo ciascuna), poi la porta. Si risolve
   * a porta chiusa davvero, anche dopo un errore.
   */
  async close(): Promise<void> {
    if (!this.#closed && !this.#closing) {
      this.#closing = true;
      this.#outbox.length = 0;
      this.#line.poke();
    }
    await this.#run;
    await this.#line.closed;
  }

  async #loop(): Promise<void> {
    const line = this.#line;
    this.#line.onFail = (err) => this.#fail(err);
    try {
      for (;;) {
        if (line.error) return;
        const item = line.shift();
        if (item === 'STX') {
          this.#incoming(await receiveFrame(line, this.#t));
          continue;
        }
        if (item instanceof Uint8Array) {
          throw new S7Error('MPI_FRAME', `frame MPI senza STX: ${hex(item)}`);
        }
        if (item === 'DLE' || item === 'NAK') continue; // fuori sequenza: niente da fare
        const out = this.#acks.shift() ?? this.#outbox.shift();
        if (out) {
          await transmit(line, out, this.#t, {
            onCollision: (f) => this.#incoming(f),
            data: out[this.#hdrLen] === T_DATA,
          });
          // ogni telegramma dati riceve un B0 (doc/MPI.html, «Payload»): metà timeout, così
          // il silenzio dell'adattatore si vede prima del timeout della richiesta S7
          if (out[this.#hdrLen] === T_DATA) this.#ackDeadline = Date.now() + this.#t / 2;
          continue;
        }
        if (this.#closing) break;
        const d = this.#ackDeadline;
        if (!(await line.wait(d === undefined ? undefined : Math.max(0, d - Date.now())))) {
          throw new S7Error('MPI_NO_ADAPTER', `${NO_ADAPTER} (nessun ack B0 dopo una PDU)`);
        }
      }
      await this.#disconnect();
    } catch (e) {
      this.#fail(e instanceof Error ? e : new S7Error('MPI_FRAME', String(e)));
    }
  }

  async #disconnect(): Promise<void> {
    const line = this.#line;
    try {
      await transmit(line, Uint8Array.of(...this.#header(), T_DISCONNECT), this.#t, {
        attempts: 1,
      });
      await receive(line, this.#t); // risposta non controllata dalla fonte
      await disconnectAdapter(line, this.#t);
    } catch {
      // si chiude comunque
    }
    this.#closed = true;
    line.fail(new S7Error('CLOSED', 'connessione chiusa'));
  }

  /** Telegramma dall'adattatore nel ciclo dati. */
  #incoming(f: Uint8Array): void {
    const h = this.#hdrLen;
    // un B0 o anche la risposta stessa (se l'adattatore non manda il B0): la linea è viva
    this.#ackDeadline = undefined;
    switch (f[h]) {
      case T_DATA: {
        if (f.length < h + 2) throw new S7Error('MPI_FRAME', `telegramma dati corto: ${hex(f)}`);
        this.#acks.push(Uint8Array.of(...this.#header(), T_ACK, 0x01, f[h + 1]!));
        const pdu = f.slice(h + 2);
        if (this.#pduCb) this.#pduCb(pdu);
        else this.#backlog.push(pdu);
        return;
      }
      case T_ACK:
        return; // la risposta della CPU arriva dopo, senza limite qui
      case T_DISCONNECT:
      case T_DISCONNECT_REPLY:
        throw new S7Error('CLOSED', 'la CPU ha chiuso il collegamento MPI');
      default:
        throw new S7Error('MPI_FRAME', `telegramma MPI sconosciuto: ${hex(f)}`);
    }
  }

  #fail(err: Error): void {
    if (this.#closedErr) return;
    this.#closedErr = err;
    const deliberate = this.#closing;
    this.#closed = true;
    this.#line.fail(err);
    if (!deliberate) this.#closeCb?.(err);
  }
}

/**
 * Link verso una CPU attraverso il PC Adapter MPI, da passare a `S7Connection.open({ link })`.
 * A ogni apertura: porta, init dell'adattatore (con `auto` prima v1 e poi v2), connessione.
 * Le opzioni fuori campo danno RangeError subito, senza aprire la porta.
 */
export function mpiAdapterLink(transport: SerialOpener, o: MpiOptions): PduLinkFactory {
  checkOptions(o);
  return ({ timeoutMs, signal, mode = 'read-only', pduLength = () => 240 }) =>
    withLine(transport, timeoutMs, signal, async (line) => {
      const variant = await initAdapter(line, o, timeoutMs);
      const link = new MpiAdapterLink(line, variant, o.cpuAddress, timeoutMs, mode, pduLength);
      await link.connect();
      return link;
    });
}

/** Indirizzi delle stazioni attive sul bus MPI (per «Cerca»), poi l'adattatore si chiude. */
export async function listMpiNodes(
  transport: SerialOpener,
  o: Omit<MpiOptions, 'cpuAddress'> & { timeoutMs?: number; signal?: AbortSignal },
): Promise<number[]> {
  checkOptions(o);
  const t = o.timeoutMs ?? LIST_TIMEOUT_MS;
  return withLine(transport, t, o.signal, async (line) => {
    await initAdapter(line, o, t);
    const nodes = await readPartners(line, t);
    try {
      await disconnectAdapter(line, t);
    } catch {
      // la risposta alla chiusura non conta
    }
    line.fail(new S7Error('CLOSED', 'connessione chiusa'));
    await line.closed;
    return nodes;
  });
}
