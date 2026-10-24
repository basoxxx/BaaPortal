import { S7Error } from './errors';
import { S7Connection, type ConnectOptions } from './connection';
import {
  decodeBlockCounts,
  decodeBlockInfo,
  decodeBlockListOfType,
  type BlockInfo,
  type BlockListEntry,
  type BlockType,
} from './s7/blocks';
import { decodeBcdDateTime, type S7DateTime } from './s7/clock';
import { errorName, itemReturnName } from './s7/errorCodes';
import { planReads, splitArea } from './s7/plan';
import {
  decodeReadResponse,
  encodeReadRequest,
  itemByteLength,
  type Area,
  type ItemResult,
  type ReadItem,
} from './s7/readVar';
import type { S7Pdu } from './s7/header';
import { parseSzl, type SzlList } from './s7/szl';
import {
  commFrom,
  diagFrom,
  identityFrom,
  modeFrom,
  protectionFrom,
  type CommCapabilities,
  type CpuIdentity,
  type CpuMode,
  type DiagEntry,
  type ProtectionInfo,
} from './s7/szlLists';
import {
  blockFileName,
  decodeEndUploadResponse,
  decodeStartUploadResponse,
  decodeUploadResponse,
  encodeEndUpload,
  encodeStartUpload,
  encodeUpload,
} from './s7/upload';
import { decodeUserdata, type DecodedUserdata } from './s7/userdata';
import {
  reqBlockCounts,
  reqBlockInfo,
  reqBlockListOfType,
  reqContinue,
  reqReadClock,
  reqReadSzl,
  type UserdataFrame,
} from './s7/userdataRequests';

/**
 * Tetto ai pezzi di una SZL (proto §6.7): oltre, la CPU sta sbagliando. Un buffer diagnostico
 * pieno (qualche centinaio di voci da 20 byte) a PDU 240 richiede più di 64 pezzi.
 */
const MAX_SZL_FRAGMENTS = 1024;
/** Tetto ai byte totali di una SZL ricomposta. */
const MAX_SZL_BYTES = 4 * 1024 * 1024;
/** Tetto ai pezzi di una lista di blocchi (una DB-list di 65536 voci sta in meno di 256 pezzi). */
const MAX_LIST_FRAGMENTS = 256;
/** Tetto ai byte di un blocco caricato: protegge da lunghezze assurde. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Filesystem del nome nelle richieste di info blocco e di upload. Verificato sulle catture:
 * STEP 7 e TIA mandano `A` (96 richieste riuscite su CPU S300 reali, anche `B` nei nomi più
 * vecchi); snap7 manda `A`. `A` funziona sempre, `B` è la vista "attiva" dei vecchi STEP 7.
 */
const FILESYSTEM = 'A';

const h2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

function cpuError(errorClass: number, errorCode: number, what: string): S7Error {
  return new S7Error(
    'CPU_ERROR',
    `${what}: classe ${h2(errorClass)} codice ${h2(errorCode)} (${errorName(errorClass, errorCode)})`,
    { errorClass, errorCode },
  );
}

/** Un errore nell'header di una risposta (ROSCTR 2 o 3) diventa CPU_ERROR. */
export function checkHeader(pdu: S7Pdu, what: string): void {
  if (pdu.errorClass !== 0 || pdu.errorCode !== 0) {
    throw cpuError(pdu.errorClass, pdu.errorCode, what);
  }
}

/**
 * Client di lettura per S7-300. Niente scritture: non esiste alcun metodo che scriva, e comunque
 * ogni frame passa dal filtro di sola lettura di `S7Connection`. I byte non si costruiscono
 * qui: lo fanno i codec.
 */
export class S7Client {
  readonly #conn: S7Connection;

  protected constructor(conn: S7Connection) {
    this.#conn = conn;
  }

  static async connect(o: ConnectOptions): Promise<S7Client> {
    return new S7Client(await S7Connection.open(o));
  }

  get pduLength(): number {
    return this.#conn.pduLength;
  }

  /** Frame rifiutati dal filtro di sola lettura (mai inviati). */
  get refusedCount(): number {
    return this.#conn.refusedCount;
  }

  /** True quando la connessione è chiusa (da noi, dalla CPU o per un guasto): non si riusa. */
  get closed(): boolean {
    return this.#conn.closed;
  }

  close(): Promise<void> {
    return this.#conn.close();
  }

  // ---- variabili ---------------------------------------------------------------------------

  /** Risultato per item, nell'ordine; gli errori di item restano per item. */
  async readItems(items: ReadItem[]): Promise<ItemResult[]> {
    const out: ItemResult[] = [];
    for (const group of planReads(items, this.#conn.pduLength)) {
      out.push(...(await this.#readGroup(group)));
    }
    return out;
  }

  /** Legge `length` byte dividendo in richieste che entrano nella PDU; il primo errore di item lancia. */
  async readArea(area: Area, db: number, start: number, length: number): Promise<Uint8Array> {
    const items = splitArea(area, db, start, length, this.#conn.pduLength);
    const out = new Uint8Array(length);
    let at = 0;
    for (const group of planReads(items, this.#conn.pduLength)) {
      const results = await this.#readGroup(group);
      for (const [i, r] of results.entries()) {
        if (!r.ok) {
          const it = group[i]!;
          throw new S7Error(
            'CPU_ERROR',
            `lettura ${area}${area === 'DB' ? db : ''} da ${it.start} (${it.count} byte): codice item ${h2(r.returnCode)} (${itemReturnName(r.returnCode)})`,
            { returnCode: r.returnCode },
          );
        }
        out.set(r.data, at);
        at += r.data.length;
      }
    }
    return out;
  }

  async #readGroup(group: ReadItem[]): Promise<ItemResult[]> {
    const pdu = await this.#conn.request(encodeReadRequest(group), new Uint8Array(0), 1);
    if (pdu.rosctr !== 2 && pdu.rosctr !== 3) {
      throw new S7Error('PROTOCOL', `risposta alla lettura con ROSCTR ${pdu.rosctr}`);
    }
    checkHeader(pdu, 'lettura rifiutata dalla CPU');
    const results = decodeReadResponse(pdu.param, pdu.data);
    if (results.length !== group.length) {
      throw new S7Error(
        'PROTOCOL',
        `la CPU ha risposto con ${results.length} item invece di ${group.length}`,
      );
    }
    results.forEach((r, i) => {
      const want = itemByteLength(group[i]!);
      if (r.ok && r.data.length !== want) {
        throw new S7Error(
          'PROTOCOL',
          `item ${i}: ${r.data.length} byte ricevuti invece di ${want}`,
        );
      }
    });
    return results;
  }

  // ---- userdata ----------------------------------------------------------------------------

  async #userdata(frame: UserdataFrame, what: string): Promise<DecodedUserdata> {
    const pdu = await this.#conn.request(frame.param, frame.data, 7);
    if (pdu.rosctr !== 7)
      throw new S7Error('PROTOCOL', `${what}: risposta con ROSCTR ${pdu.rosctr}`);
    const u = decodeUserdata(pdu.param, pdu.data);
    const code = u.param.errorCode ?? 0;
    if (code !== 0) throw cpuError(code >> 8, code & 0xff, `${what} rifiutata dalla CPU`);
    if (!u.hasData) throw new S7Error('PROTOCOL', `${what}: risposta senza parte dati`);
    if (u.returnCode !== 0xff) {
      throw new S7Error(
        'CPU_ERROR',
        `${what}: codice di ritorno ${h2(u.returnCode)} (${itemReturnName(u.returnCode)})`,
        { returnCode: u.returnCode },
      );
    }
    return u;
  }

  /** Risposta a pezzi (proto §6.7): continua con il sequence della CPU finché `lastDataUnit` è 0. */
  async #fragments(
    first: UserdataFrame,
    group: number,
    sub: number,
    cap: number,
    what: string,
    maxBytes = Infinity,
  ): Promise<Uint8Array[]> {
    let u = await this.#userdata(first, what);
    const out = [u.payload];
    let bytes = u.payload.length;
    while (u.param.lastDataUnit) {
      if (out.length >= cap) throw new S7Error('PROTOCOL', `${what}: oltre ${cap} pezzi`);
      u = await this.#userdata(reqContinue(group, sub, u.param.sequence), what);
      out.push(u.payload);
      bytes += u.payload.length;
      if (bytes > maxBytes) throw new S7Error('PROTOCOL', `${what}: oltre ${maxBytes} byte`);
    }
    return out;
  }

  /** Lista SZL ricomposta. Le liste "solo intestazione" tornano così come sono. */
  async readSzl(id: number, index: number): Promise<SzlList> {
    const what = `SZL 0x${id.toString(16).padStart(4, '0')}`;
    const list = parseSzl(
      await this.#fragments(reqReadSzl(id, index), 4, 1, MAX_SZL_FRAGMENTS, what, MAX_SZL_BYTES),
    );
    if (list.id !== id) {
      throw new S7Error(
        'PROTOCOL',
        `${what}: la CPU ha risposto con la lista 0x${list.id.toString(16)}`,
      );
    }
    return list;
  }

  async identity(): Promise<CpuIdentity> {
    const base = await this.readSzl(0x0011, 0);
    let extra: SzlList | undefined;
    try {
      extra = await this.readSzl(0x001c, 0);
    } catch (e) {
      if (!(e instanceof S7Error && e.code === 'CPU_ERROR')) throw e;
    }
    return identityFrom(base, extra);
  }

  /**
   * Modo CPU (SZL 0x0424). I campi mancanti degradano (restano assenti), ma un rifiuto dell'intera lista da parte
   * della CPU (p.es. 0xD402) lancia `CPU_ERROR`: chi chiama (il kit) lo registra per passo.
   */
  async mode(): Promise<CpuMode> {
    return modeFrom(await this.readSzl(0x0424, 0));
  }

  /**
   * Protezione (SZL 0x0132 indice 4, poi 0x0232 se la CPU rifiuta la prima: STEP 7/TIA usano la 0x0132). I campi mancanti degradano (restano assenti), ma un rifiuto dell'intera lista da parte
   * della CPU (p.es. 0xD402) lancia `CPU_ERROR`: chi chiama (il kit) lo registra per passo.
   */
  async protection(): Promise<ProtectionInfo> {
    try {
      return protectionFrom(await this.readSzl(0x0132, 4));
    } catch (e) {
      if (!(e instanceof S7Error && e.code === 'CPU_ERROR')) throw e;
    }
    return protectionFrom(await this.readSzl(0x0232, 4));
  }

  /**
   * Comunicazione (SZL 0x0131). I campi mancanti degradano (restano assenti), ma un rifiuto dell'intera lista da parte
   * della CPU (p.es. 0xD402) lancia `CPU_ERROR`: chi chiama (il kit) lo registra per passo.
   */
  async communication(): Promise<CommCapabilities> {
    return commFrom(await this.readSzl(0x0131, 1));
  }

  /**
   * Buffer diagnostico (SZL 0x00A0). I campi mancanti degradano (restano assenti), ma un rifiuto dell'intera lista da parte
   * della CPU (p.es. 0xD402) lancia `CPU_ERROR`: chi chiama (il kit) lo registra per passo.
   */
  async diagnosticBuffer(): Promise<DiagEntry[]> {
    return diagFrom(await this.readSzl(0x00a0, 0));
  }

  // ---- blocchi -----------------------------------------------------------------------------

  async blockCounts(): Promise<Record<BlockType, number>> {
    return decodeBlockCounts((await this.#userdata(reqBlockCounts(), 'conteggio blocchi')).payload);
  }

  /**
   * Elenco dei blocchi di un tipo. Un tipo senza blocchi dà `[]`, sia con l'errore 0xD20E
   * ("nessun blocco disponibile") sia con una lista valida e vuota: nessuna cattura mostra
   * come risponde una CPU vera. Il kit e gli altri chiamanti chiamino comunque prima
   * `blockCounts()` e saltino i tipi con conteggio 0, come fa STEP 7.
   */
  async listBlocks(type: BlockType): Promise<BlockListEntry[]> {
    try {
      return decodeBlockListOfType(
        await this.#fragments(
          reqBlockListOfType(type),
          3,
          2,
          MAX_LIST_FRAGMENTS,
          `lista blocchi ${type}`,
        ),
      );
    } catch (e) {
      if (
        e instanceof S7Error &&
        e.code === 'CPU_ERROR' &&
        e.detail?.errorClass === 0xd2 &&
        e.detail.errorCode === 0x0e
      ) {
        return [];
      }
      throw e;
    }
  }

  async blockInfo(type: BlockType, number: number): Promise<BlockInfo> {
    const u = await this.#userdata(
      reqBlockInfo(type, number, FILESYSTEM),
      `info blocco ${type}${number}`,
    );
    return decodeBlockInfo(u.payload);
  }

  // ---- orologio ----------------------------------------------------------------------------

  async readClock(): Promise<S7DateTime> {
    return decodeBcdDateTime((await this.#userdata(reqReadClock(), 'lettura orologio')).payload);
  }

  // ---- upload ------------------------------------------------------------------------------

  /**
   * Carica un blocco dalla CPU: start, upload fino a EoU = 0, end. Restituisce i byte grezzi
   * (`parseBlockFile` li interpreta). `EndUpload` parte sempre, salvo a connessione chiusa, e
   * un suo errore non nasconde mai quello originale.
   */
  async upload(type: BlockType, number: number): Promise<Uint8Array> {
    return (await this.uploadWithInfo(type, number)).bytes;
  }

  /**
   * Come `upload`, ma una lunghezza dichiarata diversa dai byte ricevuti non è un errore:
   * resta un avviso (la CPU può dichiarare p.es. la lunghezza in memoria di caricamento).
   * Solo il tetto di 16 MiB è un errore duro. Una risposta di start malformata chiude la
   * connessione (libera la sessione della CPU, proto §15.3) e dà PROTOCOL.
   */
  async uploadWithInfo(
    type: BlockType,
    number: number,
  ): Promise<{ bytes: Uint8Array; declaredLength: number | null; warnings: string[] }> {
    const name = `blocco ${type}${number}`;
    const start = await this.#conn.request(
      encodeStartUpload(blockFileName(type, number, FILESYSTEM)),
      new Uint8Array(0),
      1,
    );
    checkHeader(start, `start upload ${name} rifiutato dalla CPU`);
    if (start.rosctr !== 3) {
      throw new S7Error('PROTOCOL', `risposta allo start upload con ROSCTR ${start.rosctr}`);
    }
    let started: ReturnType<typeof decodeStartUploadResponse>;
    try {
      started = decodeStartUploadResponse(start.param);
    } catch (e) {
      // Nessun id per l'EndUpload: si chiude la connessione per liberare la sessione.
      await this.#conn.close();
      throw e instanceof S7Error
        ? e
        : new S7Error('PROTOCOL', `risposta allo start upload malformata: ${String(e)}`);
    }
    const warnings: string[] = [];
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const res = await this.#conn.request(encodeUpload(started.uploadId), new Uint8Array(0), 1);
        checkHeader(res, `upload ${name} rifiutato dalla CPU`);
        if (res.rosctr !== 3) {
          throw new S7Error('PROTOCOL', `risposta all'upload con ROSCTR ${res.rosctr}`);
        }
        const r = decodeUploadResponse(res.param, res.data);
        chunks.push(r.chunk);
        total += r.chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
          throw new S7Error('PROTOCOL', `upload ${name}: oltre ${MAX_UPLOAD_BYTES} byte`);
        }
        if (!r.more) break;
        if (r.chunk.length === 0) {
          throw new S7Error('PROTOCOL', `upload ${name}: pezzo vuoto con altri in arrivo`);
        }
      }
      if (started.totalLength !== null && total !== started.totalLength) {
        warnings.push(`lunghezza dichiarata ${started.totalLength}, ricevuti ${total}`);
      }
    } finally {
      await this.#endUpload(started.uploadId);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return { bytes: out, declaredLength: started.totalLength, warnings };
  }

  /**
   * Chiude la sequenza. Un errore qui non maschera mai quello dell'upload; se i dati sono già
   * completi e verificati, anche un EndUpload fallito è ignorato (il blocco è comunque valido).
   */
  async #endUpload(uploadId: number): Promise<void> {
    if (this.#conn.closed) return;
    try {
      const res = await this.#conn.request(encodeEndUpload(uploadId), new Uint8Array(0), 1);
      if (res.errorClass === 0 && res.errorCode === 0) decodeEndUploadResponse(res.param);
    } catch {
      // chiusura "best effort"
    }
  }
}
