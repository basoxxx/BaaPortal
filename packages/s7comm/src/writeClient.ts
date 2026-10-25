import { S7Client, checkHeader } from './client';
import { S7Connection, type ConnectOptions } from './connection';
import { S7Error } from './errors';
import { itemReturnName } from './s7/errorCodes';
import { parseBlockFile } from './s7/blockFile';
import type { BlockType } from './s7/blocks';
import {
  decodeControlResponse,
  encodeCompressMemory,
  encodeCopyRamToRom,
  encodeDeleteBlock,
  encodeInsertBlock,
  encodePlcStop,
  encodeWarmRestart,
  type ControlResult,
} from './s7/control';
import { encodeRequestDownload, sliceBlockForDownload } from './s7/download';
import type { Area } from './s7/readVar';
import {
  decodeWriteResponse,
  encodeWriteRequest,
  planWrites,
  splitWrite,
  type WriteItem,
} from './s7/writeVar';

const NOTHING = new Uint8Array(0);
/** Filesystem dei blocchi scaricati: il passivo `P`, come STEP 7 (proto §10.1, §10.4). */
const DOWNLOAD_FS = 'P';
/** Filesystem della cancellazione: `A`, come TIA nella cattura reale (proto §10.5). */
const DELETE_FS = 'A';
/** Tipi cancellabili con `_DELE`: SDB, SFC e SFB non si cancellano. */
const DELETABLE: readonly BlockType[] = ['OB', 'FB', 'FC', 'DB'];

const h2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/**
 * Client con scrittura per le CPU proprie (proto §5, §10, §11): apre la connessione sempre in
 * `online-write`. La lettura è quella di `S7Client`, ereditata senza copie; `S7Client` e il kit
 * restano di sola lettura. Nessun tentativo di ripetere una scrittura o un download interrotto.
 */
export class S7WriteClient extends S7Client {
  readonly #wconn: S7Connection;

  private constructor(conn: S7Connection) {
    super(conn);
    this.#wconn = conn;
  }

  static override async connect(o: ConnectOptions): Promise<S7WriteClient> {
    return new S7WriteClient(await S7Connection.open({ ...o, mode: 'online-write' }));
  }

  // ---- variabili ---------------------------------------------------------------------------

  /** Un return code per item, nell'ordine; gli errori di item restano per item. */
  async writeItems(items: WriteItem[]): Promise<{ returnCode: number; name: string }[]> {
    const out: { returnCode: number; name: string }[] = [];
    for (const group of planWrites(items, this.pduLength)) {
      const { param, data } = encodeWriteRequest(group);
      const pdu = await this.#wconn.request(param, data, 1);
      if (pdu.rosctr !== 2 && pdu.rosctr !== 3) {
        throw new S7Error('PROTOCOL', `risposta alla scrittura con ROSCTR ${pdu.rosctr}`);
      }
      checkHeader(pdu, 'scrittura rifiutata dalla CPU');
      const results = decodeWriteResponse(pdu.param, pdu.data);
      if (results.length !== group.length) {
        throw new S7Error(
          'PROTOCOL',
          `la CPU ha risposto con ${results.length} esiti invece di ${group.length}`,
        );
      }
      out.push(...results);
    }
    return out;
  }

  /** Scrive `data` dividendo in item che entrano nella PDU; il primo errore di item lancia. */
  async writeArea(area: Area, db: number, start: number, data: Uint8Array): Promise<void> {
    const items = splitWrite(area, db, start, data, this.pduLength);
    for (const group of planWrites(items, this.pduLength)) {
      const results = await this.writeItems(group);
      for (const [i, r] of results.entries()) {
        if (r.returnCode !== 0xff) {
          const it = group[i]!;
          throw new S7Error(
            'CPU_ERROR',
            `scrittura ${area}${area === 'DB' ? db : ''} da ${it.start} (${it.data.length} byte): codice item ${h2(r.returnCode)} (${itemReturnName(r.returnCode)})`,
            { returnCode: r.returnCode },
          );
        }
      }
    }
  }

  // ---- download ----------------------------------------------------------------------------

  /**
   * Scrive un file di blocco nella CPU (proto §10): request download, fette su richiesta della
   * CPU, poi `_INSE` per attivarlo. Se la connessione cade a metà l'errore sale così com'è.
   */
  async downloadBlock(file: Uint8Array): Promise<void> {
    const { header } = parseBlockFile(file);
    const type = header.type;
    if (type === undefined) {
      throw new S7Error('PROTOCOL', `tipo di blocco 0x${header.typeCode.toString(16)} sconosciuto`);
    }
    const slices = sliceBlockForDownload(file, this.pduLength);
    let next = 0;
    await this.#wconn.runDownload(
      encodeRequestDownload(type, header.number, DOWNLOAD_FS, header.loadLength, header.mc7Length),
      () => {
        const chunk = slices[next++];
        if (chunk === undefined) {
          throw new S7Error('PROTOCOL', 'la CPU chiede più fette di quelle del blocco');
        }
        return { eos: next < slices.length, chunk };
      },
      () => undefined,
    );
    const pdu = await this.#wconn.request(
      encodeInsertBlock(type, header.number, DOWNLOAD_FS),
      NOTHING,
      1,
    );
    checkHeader(pdu, `_INSE ${type}${header.number} rifiutato dalla CPU`);
    if (pdu.rosctr !== 3) {
      throw new S7Error('PROTOCOL', `risposta a _INSE con ROSCTR ${pdu.rosctr}`);
    }
    const r = decodeControlResponse(pdu.param);
    if (r.code !== 0) {
      throw new S7Error(
        'CPU_ERROR',
        `_INSE ${type}${header.number} non eseguito dalla CPU: ${r.name} (0x${r.code.toString(16).padStart(2, '0')})`,
        { returnCode: r.code },
      );
    }
  }

  // ---- controllo ---------------------------------------------------------------------------

  /** Stop. "Già STOP" è un risultato; un errore nell'header (p.es. 0xD241) lancia CPU_ERROR. */
  stop(): Promise<ControlResult> {
    return this.#control(encodePlcStop(), 'stop');
  }

  /** Riavvio a caldo. "Già RUN" è un risultato; un errore nell'header lancia CPU_ERROR. */
  start(): Promise<ControlResult> {
    return this.#control(encodeWarmRestart(), 'avvio');
  }

  /** Cancella un blocco nel filesystem B (proto §10.5); solo OB, FB, FC, DB. Un esito diverso da 0 lancia CPU_ERROR. */
  deleteBlock(type: BlockType, number: number): Promise<void> {
    if (!DELETABLE.includes(type)) {
      return Promise.reject(
        new S7Error('PROTOCOL', `_DELE: il tipo ${type} non si cancella (solo OB, FB, FC, DB)`),
      );
    }
    return this.#controlOk(encodeDeleteBlock(type, number, DELETE_FS), `_DELE ${type}${number}`);
  }

  /** Copia la RAM in ROM (`_MODU`, proto §11.3). Un esito diverso da 0 lancia CPU_ERROR. */
  copyRamToRom(): Promise<void> {
    return this.#controlOk(encodeCopyRamToRom(), '_MODU');
  }

  /** Comprime la memoria (`_GARB`, proto §11.3). Un esito diverso da 0 lancia CPU_ERROR. */
  compressMemory(): Promise<void> {
    return this.#controlOk(encodeCompressMemory(), '_GARB');
  }

  async #controlOk(param: Uint8Array, what: string): Promise<void> {
    const r = await this.#control(param, what);
    if (r.code !== 0) {
      throw new S7Error('CPU_ERROR', `${what} non eseguito dalla CPU: ${r.name} (${h2(r.code)})`, {
        returnCode: r.code,
      });
    }
  }

  async #control(param: Uint8Array, what: string): Promise<ControlResult> {
    const pdu = await this.#wconn.request(param, NOTHING, 1);
    if (pdu.rosctr !== 2 && pdu.rosctr !== 3) {
      throw new S7Error('PROTOCOL', `risposta a ${what} con ROSCTR ${pdu.rosctr}`);
    }
    checkHeader(pdu, `${what} rifiutato dalla CPU`);
    return decodeControlResponse(pdu.param);
  }
}
