import { readU16 } from './bytes';
import { decodeCotp, encodeCotp } from './cotp';
import { S7Error } from './errors';
import { decodeBlockInfoRequest, decodeBlockListOfTypeRequest } from './s7/blocks';
import { decodeS7, encodeS7, type S7Pdu } from './s7/header';
import { MAX_ITEMS_PER_REQUEST } from './s7/plan';
import { decodeReadRequest, encodeReadRequest } from './s7/readVar';
import { decodeSetup, encodeSetup } from './s7/setup';
import { decodeSzlRequest } from './s7/szl';
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
  type UserdataFrame,
} from './s7/userdataRequests';

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

/**
 * Controllo sui byte che stanno per uscire (TPKT, COTP, S7). Ammette solo: COTP CR, COTP DR
 * e COTP DT con EOT che porta una PDU S7 accettata da `assertReadOnly`. Un frame che non si
 * decodifica, con byte in più, con più frame o di un altro tipo (CC, ER...) dà FORBIDDEN.
 */
export function assertOutgoingFrame(bytes: Uint8Array): void {
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
        assertReadOnly(pdu);
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
