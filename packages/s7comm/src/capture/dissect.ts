import { decodeCotp, type CotpPdu } from '../cotp';
import { decodeS7, type S7Pdu } from '../s7/header';
import { decodeUserdata } from '../s7/userdata';

export type DissectKind =
  | 'connect'
  | 'setup'
  | 'readVar'
  | 'szl'
  | 'blockList'
  | 'blockInfo'
  | 'clock'
  | 'upload'
  | 'other'
  | 'malformed';

export interface Dissected {
  /** Assente solo se il COTP stesso è malformato. */
  cotp?: CotpPdu;
  /** Presente se il COTP è un DT finale con una PDU S7 valida. */
  s7?: S7Pdu;
  kind: DissectKind;
  /** Messaggio, solo per `kind: 'malformed'`. */
  error?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Classifica un frame TPKT (il payload, senza i 4 byte dell'header). Non lancia mai:
 * COTP o S7 malformati danno `kind: 'malformed'`.
 *
 * Vale per un frame alla volta: l'ultimo segmento di una PDU spezzata in più DT non è una PDU
 * S7 completa e risulta 'malformed'; un DT non finale è 'other'. Scritture, controllo, download
 * e tutto ciò che il kit di sola lettura non conosce sono 'other'; anche il set clock.
 */
export function dissect(tpktPayload: Uint8Array): Dissected {
  let cotp: CotpPdu;
  try {
    cotp = decodeCotp(tpktPayload);
  } catch (e) {
    return { kind: 'malformed', error: `COTP: ${message(e)}` };
  }
  if (cotp.type === 'CR' || cotp.type === 'CC' || cotp.type === 'DR') {
    return { cotp, kind: 'connect' };
  }
  if (cotp.type !== 'DT' || !cotp.eot) return { cotp, kind: 'other' };
  let s7: S7Pdu;
  try {
    s7 = decodeS7(cotp.data);
  } catch (e) {
    return { cotp, kind: 'malformed', error: `S7: ${message(e)}` };
  }
  return { cotp, s7, kind: classify(s7) };
}

function classify(pdu: S7Pdu): DissectKind {
  if (pdu.rosctr === 7) {
    let group: number;
    let sub: number;
    try {
      const u = decodeUserdata(pdu.param, pdu.data);
      group = u.param.group;
      sub = u.param.subfunction;
    } catch {
      return 'other';
    }
    if (group === 4 && sub === 1) return 'szl';
    if (group === 3 && (sub === 1 || sub === 2)) return 'blockList';
    if (group === 3 && sub === 3) return 'blockInfo';
    if (group === 7 && (sub === 1 || sub === 3)) return 'clock';
    return 'other';
  }
  const fn = pdu.param[0];
  if (fn === 0xf0 && pdu.param.length === 8) return 'setup';
  if (fn === 0x04) return 'readVar';
  if (fn === 0x1d || fn === 0x1e || fn === 0x1f) return 'upload';
  return 'other';
}
