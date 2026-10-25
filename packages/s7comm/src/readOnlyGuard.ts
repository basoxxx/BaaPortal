import { readU16 } from './bytes';
import { decodeCotp, encodeCotp } from './cotp';
import { S7Error } from './errors';
import { decodeBlockInfoRequest, decodeBlockListOfTypeRequest } from './s7/blocks';
import { decodeBcdDateTime } from './s7/clock';
import { decodeS7, encodeS7, type S7Pdu } from './s7/header';
import { MAX_ITEMS_PER_REQUEST } from './s7/plan';
import { decodeReadRequest, encodeReadRequest } from './s7/readVar';
import { decodeSetup, encodeSetup } from './s7/setup';
import { decodeSzlRequest } from './s7/szl';
import {
  decodePlcControlRequest,
  encodeCompressMemory,
  encodeCopyRamToRom,
  encodeDeleteBlock,
  encodeInsertBlock,
  encodePlcStop,
  encodeWarmRestart,
} from './s7/control';
import {
  decodeDownloadBlockAck,
  decodeDownloadEnded,
  decodeRequestDownload,
  encodeDownloadBlockAck,
  encodeDownloadEnded,
  encodeRequestDownload,
} from './s7/download';
import { decodeWriteRequest, encodeWriteRequest } from './s7/writeVar';
import {
  decodeEndUpload,
  decodeStartUpload,
  decodeUploadRequest,
  encodeEndUpload,
  encodeStartUpload,
  encodeUpload,
  parseBlockFileName,
} from './s7/upload';
import { decodeUserdata, encodeUserdata, type DecodedUserdata } from './s7/userdata';
import {
  reqBlockCounts,
  reqBlockInfo,
  reqBlockListOfType,
  reqContinue,
  reqReadClock,
  reqReadSzl,
  reqSetClock,
  type UserdataFrame,
} from './s7/userdataRequests';

/** Modo della connessione, fissato all'apertura (mai modificabile su una connessione viva). */
export type ConnectionMode = 'read-only' | 'online-write';

/** Richieste userdata ammesse (proto §15.1): SZL, conteggi/lista/info blocchi, lettura orologio. */
const USERDATA_ALLOWED = new Set(['4/1', '3/1', '3/2', '3/3', '7/1', '7/3']);

function refuse(msg: string): never {
  throw new S7Error('FORBIDDEN', `${msg}: BaaPortal 1D è in sola lettura`);
}

const h2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

const EMPTY = new Uint8Array(0);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function must(ok: boolean, why: string): void {
  if (!ok) throw new Error(why);
}

/**
 * Filtro di sola lettura, puro. Lancia `S7Error('FORBIDDEN')` per tutto ciò che non è
 * nell'allowlist di proto §15.1. Accetta solo la forma canonica: i byte devono essere
 * identici alla ricodifica del loro significato decodificato con i codificatori di sola
 * lettura; ogni altra variante (byte in più, campi riservati, payload insoliti) è vietata.
 */
export function assertReadOnly(pdu: S7Pdu): void {
  if (pdu.rosctr === 7) return assertUserdata(pdu);
  if (pdu.rosctr !== 1) {
    refuse(`ROSCTR ${pdu.rosctr} non ammesso (il client non risponde mai ai job)`);
  }
  if (pdu.param.length === 0) refuse('job con parametro vuoto non ammesso');
  const fn = pdu.param[0]!;
  const label = `funzione ${h2(fn)}`;
  const p = pdu.param;
  try {
    switch (fn) {
      case 0xf0: {
        const s = decodeSetup(p);
        must(sameBytes(p, encodeSetup(s)), 'setup non canonico');
        must(s.amqCalling === 1 && s.amqCalled === 1, 'AmQ diverso da 1/1');
        break;
      }
      case 0x04: {
        const items = decodeReadRequest(p);
        must(items.length >= 1, 'read var senza item');
        must(items.length <= MAX_ITEMS_PER_REQUEST, `read var con ${items.length} item`);
        must(sameBytes(p, encodeReadRequest(items)), 'read var non canonico');
        break;
      }
      case 0x1d: {
        const { fileName } = decodeStartUpload(p);
        const f = parseBlockFileName(fileName);
        must(['A', 'P', 'B'].includes(f.filesystem), 'filesystem diverso da A, P, B');
        must(sameBytes(p, encodeStartUpload(fileName)), 'start upload non canonico');
        break;
      }
      case 0x1e:
        must(sameBytes(p, encodeUpload(decodeUploadRequest(p).uploadId)), 'upload non canonico');
        break;
      case 0x1f:
        must(sameBytes(p, encodeEndUpload(decodeEndUpload(p).uploadId)), 'end upload non canonico');
        break;
      default:
        refuse(`${label} non ammessa`);
    }
    must(pdu.data.length === 0, 'parte dati presente');
  } catch (e) {
    if (e instanceof S7Error && e.code === 'FORBIDDEN') throw e;
    refuse(`${label} non canonica (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** La richiesta userdata canonica corrispondente al significato decodificato (o eccezione). */
function canonicalUserdata(d: DecodedUserdata): UserdataFrame {
  const { group, subfunction, sequence } = d.param;
  if (d.param.dataUnitRef !== undefined) return reqContinue(group, subfunction, sequence);
  switch (`${group}/${subfunction}`) {
    case '4/1': {
      const r = decodeSzlRequest(d.payload);
      return reqReadSzl(r.id, r.index, sequence);
    }
    case '3/1':
      return reqBlockCounts(sequence);
    case '3/2':
      return reqBlockListOfType(decodeBlockListOfTypeRequest(d.payload), sequence);
    case '3/3': {
      const r = decodeBlockInfoRequest(d.payload);
      return reqBlockInfo(r.type, r.number, r.filesystem, sequence);
    }
    case '7/1':
      return reqReadClock(sequence);
    case '7/3':
      return encodeUserdata({ method: 'request', group: 7, subfunction: 3, sequence }, EMPTY, 0x0a);
    default:
      throw new Error('gruppo/sottofunzione non in allowlist');
  }
}

function assertUserdata(pdu: S7Pdu): void {
  let d: DecodedUserdata;
  try {
    d = decodeUserdata(pdu.param, pdu.data);
  } catch (e) {
    refuse(`userdata malformato (${e instanceof Error ? e.message : String(e)})`);
  }
  if (d.param.method !== 'request' || d.param.type !== 4) {
    refuse('userdata in versione risposta non ammesso');
  }
  const key = `${d.param.group}/${d.param.subfunction}`;
  if (!USERDATA_ALLOWED.has(key)) {
    refuse(`userdata gruppo ${d.param.group} sottofunzione ${d.param.subfunction} non ammesso`);
  }
  try {
    const want = canonicalUserdata(d);
    must(sameBytes(pdu.param, want.param) && sameBytes(pdu.data, want.data), 'forma non canonica');
  } catch (e) {
    refuse(`userdata ${key} non canonico (${e instanceof Error ? e.message : String(e)})`);
  }
}

function refuseWrite(msg: string): never {
  throw new S7Error('FORBIDDEN', `${msg}: non ammesso nemmeno in modo online-write`);
}

/**
 * Filtro del modo `online-write` (proto §15): allowlist di lettura (delegata a `assertReadOnly`,
 * invariato) PIU': write var 0x05, request download 0x1A, download ended 0x1C, 0x28 solo warm
 * restart (`P_PROGRAM`), `_INSE`, `_DELE`, `_MODU` e `_GARB`, 0x29 stop `P_PROGRAM`, ack-data 0x1B (ROSCTR 3). Come in sola
 * lettura, ogni PDU deve combaciare byte per byte con la ricodifica del suo significato.
 * Tutto il resto (cold/hot restart, MRES, force...) e' FORBIDDEN.
 */
export function assertOnlineWrite(pdu: S7Pdu): void {
  if (pdu.rosctr === 3) return assertDownloadAck(pdu);
  if (pdu.rosctr === 7 && isSetClock(pdu)) return assertSetClock(pdu);
  if (pdu.rosctr !== 1 || pdu.param.length === 0) return assertReadOnly(pdu);
  const fn = pdu.param[0]!;
  if (fn !== 0x05 && fn !== 0x1a && fn !== 0x1c && fn !== 0x28 && fn !== 0x29) {
    return assertReadOnly(pdu);
  }
  const p = pdu.param;
  const label = `funzione ${h2(fn)}`;
  try {
    switch (fn) {
      case 0x05: {
        const items = decodeWriteRequest(p, pdu.data);
        must(items.length >= 1, 'write var senza item');
        must(items.length <= MAX_ITEMS_PER_REQUEST, `write var con ${items.length} item`);
        const want = encodeWriteRequest(items);
        must(sameBytes(p, want.param) && sameBytes(pdu.data, want.data), 'write var non canonico');
        return;
      }
      case 0x1a: {
        const r = decodeRequestDownload(p);
        must(
          sameBytes(p, encodeRequestDownload(r.type, r.number, r.fs, r.loadLength, r.mc7Length)),
          'request download non canonico',
        );
        break;
      }
      case 0x1c: {
        const r = decodeDownloadEnded(p);
        must(
          sameBytes(p, encodeDownloadEnded(r.type, r.number, r.fs)),
          'download ended non canonico',
        );
        break;
      }
      case 0x29: {
        const r = decodePlcControlRequest(p);
        must(r.service === 'P_PROGRAM', 'stop con servizio diverso da P_PROGRAM');
        must(sameBytes(p, encodePlcStop()), 'stop non canonico');
        break;
      }
      case 0x28: {
        const r = decodePlcControlRequest(p);
        if (r.service === 'P_PROGRAM') {
          must(sameBytes(p, encodeWarmRestart()), 'warm restart non canonico');
        } else if (r.service === '_INSE' && r.block) {
          // il filesystem e' la lettera finale del nome (ultimo byte del nome, prima di len2 + "_INSE")
          const fs = String.fromCharCode(p[19]!);
          must(fs === 'A' || fs === 'P' || fs === 'B', 'filesystem diverso da A, P, B');
          must(
            sameBytes(p, encodeInsertBlock(r.block.type, r.block.number, fs as 'A' | 'P' | 'B')),
            '_INSE non canonico',
          );
        } else if (r.service === '_DELE' && r.block) {
          // solo la forma canonica, filesystem A (come TIA, §10.5), solo OB/FB/FC/DB
          must(['OB', 'FB', 'FC', 'DB'].includes(r.block.type), '_DELE: tipo non cancellabile');
          must(
            sameBytes(p, encodeDeleteBlock(r.block.type, r.block.number, 'A')),
            '_DELE non canonico',
          );
        } else if (r.service === '_MODU') {
          must(sameBytes(p, encodeCopyRamToRom()), '_MODU non canonico');
        } else if (r.service === '_GARB') {
          must(sameBytes(p, encodeCompressMemory()), '_GARB non canonico');
        } else {
          refuseWrite(`${label} (servizio fuori allowlist)`);
        }
        break;
      }
    }
    must(pdu.data.length === 0, 'parte dati presente');
  } catch (e) {
    if (e instanceof S7Error && e.code === 'FORBIDDEN') throw e;
    refuseWrite(`${label} non canonica (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Userdata richiesta 7/2 (set clock): l'unico userdata di scrittura ammesso (proto §12.0). */
function isSetClock(pdu: S7Pdu): boolean {
  try {
    const d = decodeUserdata(pdu.param, pdu.data);
    return d.param.method === 'request' && d.param.group === 7 && d.param.subfunction === 2;
  } catch {
    return false;
  }
}

/**
 * Set clock canonico: sottofunzione 0x02 (mai 0x04), giorno della settimana 0, e i byte identici
 * a `reqSetClock` dell'ora decodificata (anno 1990-2089 compreso).
 */
function assertSetClock(pdu: S7Pdu): void {
  try {
    const d = decodeUserdata(pdu.param, pdu.data);
    must(d.param.type === 4 && d.param.dataUnitRef === undefined, 'set clock non è una richiesta');
    const want = reqSetClock(decodeBcdDateTime(d.payload), d.param.sequence);
    must(
      sameBytes(pdu.param, want.param) && sameBytes(pdu.data, want.data),
      'set clock non canonico',
    );
  } catch (e) {
    refuseWrite(`set clock non canonico (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Ack-data del download (proto §10.2): solo la risposta 0x1B/0x1C del PG ai job della CPU. */
function assertDownloadAck(pdu: S7Pdu): void {
  try {
    must(pdu.errorClass === 0 && pdu.errorCode === 0, "errore nell'header");
    if (pdu.param.length === 1 && pdu.param[0] === 0x1c) {
      must(pdu.data.length === 0, 'ack 0x1C con dati');
      return;
    }
    const a = decodeDownloadBlockAck(pdu.param, pdu.data);
    const want = encodeDownloadBlockAck(a.eos, a.chunk);
    must(sameBytes(pdu.param, want.param) && sameBytes(pdu.data, want.data), 'ack non canonica');
  } catch (e) {
    refuseWrite(`ack-data non ammessa (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Controllo sui byte che stanno per uscire (TPKT, COTP, S7). Ammette solo: COTP CR, COTP DR
 * e COTP DT con EOT che porta una PDU S7 accettata da `assertReadOnly` (default) o, solo in
 * modo `online-write`, da `assertOnlineWrite`. Un frame che non si
 * decodifica, con byte in più, con più frame o di un altro tipo (CC, ER...) dà FORBIDDEN.
 */
export function assertOutgoingFrame(bytes: Uint8Array, mode: ConnectionMode = 'read-only'): void {
  try {
    if (
      bytes.length < 7 ||
      bytes[0] !== 3 ||
      bytes[1] !== 0 ||
      readU16(bytes, 2) !== bytes.length
    ) {
      refuse('frame TPKT non valido o con byte in più');
    }
    const payload = bytes.subarray(4);
    const cotp = decodeCotp(payload);
    switch (cotp.type) {
      case 'CR':
      case 'DR':
        if (!sameBytes(payload, encodeCotp(cotp))) refuse(`COTP ${cotp.type} non canonico`);
        return;
      case 'DT': {
        // Intestazione esattamente 02 F0 80: EOT, numero TPDU 0, credito 0.
        if (payload[0] !== 2 || payload[1] !== 0xf0 || payload[2] !== 0x80) {
          refuse('intestazione COTP DT non canonica');
        }
        const raw = payload.subarray(3);
        const pdu = decodeS7(raw);
        if (!sameBytes(raw, encodeS7(pdu))) refuse('intestazione S7 non canonica');
        if (mode === 'online-write') assertOnlineWrite(pdu);
        else if (mode === 'read-only') assertReadOnly(pdu);
        else refuse(`modo "${String(mode)}" sconosciuto`);
        return;
      }
      default:
        refuse(`COTP ${cotp.type} non ammesso in uscita`);
    }
  } catch (e) {
    if (e instanceof S7Error && e.code === 'FORBIDDEN') throw e;
    refuse(`frame in uscita non decodificabile (${e instanceof Error ? e.message : String(e)})`);
  }
}
