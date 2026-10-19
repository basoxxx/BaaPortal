import { readU16 } from './bytes';
import { decodeCotp, encodeCotp } from './cotp';
import { S7Error } from './errors';
import { decodeS7, type S7Pdu } from './s7/header';
import { MAX_ITEMS_PER_REQUEST } from './s7/plan';
import { decodeReadRequest } from './s7/readVar';
import { decodeSetup } from './s7/setup';
import { decodeEndUpload, decodeStartUpload, decodeUploadRequest } from './s7/upload';
import { decodeUserdata } from './s7/userdata';

/** Richieste userdata ammesse (proto §15.1): SZL, conteggi/lista/info blocchi, lettura orologio. */
const USERDATA_ALLOWED = new Set(['4/1', '3/1', '3/2', '3/3', '7/1', '7/3']);

function refuse(msg: string): never {
  throw new S7Error('FORBIDDEN', `${msg}: BaaPortal 1D è in sola lettura`);
}

const h2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/**
 * Filtro di sola lettura, puro. Lancia `S7Error('FORBIDDEN')` per tutto ciò che non è
 * nell'allowlist di proto §15.1. L'allowlist è ristretta: ogni parametro deve anche
 * decodificarsi con il codec corrispondente, senza byte in più e (per i job) senza dati.
 */
export function assertReadOnly(pdu: S7Pdu): void {
  if (pdu.rosctr === 7) return assertUserdata(pdu);
  if (pdu.rosctr !== 1) {
    refuse(`ROSCTR ${pdu.rosctr} non ammesso (il client non risponde mai ai job)`);
  }
  if (pdu.param.length === 0) refuse('job con parametro vuoto non ammesso');
  const fn = pdu.param[0]!;
  const label = `funzione ${h2(fn)}`;
  try {
    switch (fn) {
      case 0xf0:
        if (pdu.param.length !== 8) throw new Error('setup di lunghezza errata');
        decodeSetup(pdu.param);
        break;
      case 0x04: {
        const items = decodeReadRequest(pdu.param);
        if (items.length === 0) throw new Error('read var senza item');
        if (items.length > MAX_ITEMS_PER_REQUEST) {
          throw new Error(`read var con ${items.length} item, oltre ${MAX_ITEMS_PER_REQUEST}`);
        }
        if (pdu.param.length !== 2 + 12 * items.length) throw new Error('byte in coda');
        break;
      }
      case 0x1d:
        decodeStartUpload(pdu.param);
        break;
      case 0x1e:
        decodeUploadRequest(pdu.param);
        break;
      case 0x1f:
        decodeEndUpload(pdu.param);
        break;
      default:
        refuse(`${label} non ammessa`);
    }
  } catch (e) {
    if (e instanceof S7Error && e.code === 'FORBIDDEN') throw e;
    refuse(`${label} malformata (${e instanceof Error ? e.message : String(e)})`);
  }
  if (pdu.data.length !== 0) refuse(`${label} con parte dati non ammessa`);
}

function assertUserdata(pdu: S7Pdu): void {
  let d;
  try {
    d = decodeUserdata(pdu.param, pdu.data);
  } catch (e) {
    refuse(`userdata malformato (${e instanceof Error ? e.message : String(e)})`);
  }
  if (d.param.method !== 'request') refuse('userdata in versione risposta non ammesso');
  const key = `${d.param.group}/${d.param.subfunction}`;
  if (!USERDATA_ALLOWED.has(key)) {
    refuse(`userdata gruppo ${d.param.group} sottofunzione ${d.param.subfunction} non ammesso`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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
      case 'DT':
        if (payload[0] !== 2 || !cotp.eot) refuse('COTP DT senza EOT o con header esteso');
        assertReadOnly(decodeS7(payload.subarray(3)));
        return;
      default:
        refuse(`COTP ${cotp.type} non ammesso in uscita`);
    }
  } catch (e) {
    if (e instanceof S7Error && e.code === 'FORBIDDEN') throw e;
    refuse(`frame in uscita non decodificabile (${e instanceof Error ? e.message : String(e)})`);
  }
}
