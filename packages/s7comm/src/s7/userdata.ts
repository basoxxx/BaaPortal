import { readU16, readU8, writeU16 } from '../bytes';
import { S7Error } from '../errors';

/**
 * Userdata (ROSCTR 7), proto §6. Il parametro ha la testa `00 01 12`, il byte di lunghezza
 * (4 o 8), poi method, type+group, subfunction, sequence e, se la lunghezza è 8, data unit
 * reference, last data unit ed error code (2 byte).
 *
 * Solo lettura: `encodeUserdata` costruisce richieste solo per SZL, blocchi in lettura e lettura
 * orologio (RangeError altrimenti) e non costruisce risposte dei gruppi 1, 2, 5 né del set clock.
 */
export interface UserdataParam {
  /** Direzione, dal nibble type: 4 = 'request'; 8 (risposta) e 0 (indication) = 'response'. */
  method: 'request' | 'response';
  /** Nibble alto del byte 5. Se manca vale 4 per 'request' e 8 per 'response'; se c'è deve essere coerente. */
  type?: number;
  /**
   * Byte 4 sul filo: 0x11 nella richiesta iniziale, 0x12 nelle risposte e nelle richieste di
   * continuazione (proto §6.2). Se manca: 0x11 per 'request', 0x12 per 'response'.
   */
  methodByte?: number;
  /** Nibble basso del byte 5. */
  group: number;
  subfunction: number;
  sequence: number;
  dataUnitRef?: number;
  lastDataUnit?: boolean;
  errorCode?: number;
}

const HEAD = [0x00, 0x01, 0x12];
const METHOD_REQUEST = 0x11;
const METHOD_RESPONSE = 0x12;

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `userdata: ${msg}`);
}

function byteIn(name: string, v: number, max: number): number {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} ${v} fuori 0-${max}`);
  return v;
}

/** Richieste ammesse (sola lettura): SZL, conteggi/lista/info blocchi, lettura orologio (proto §6.4, §12, §15.1). */
const REQUEST_ALLOWED = new Set(['4/1', '3/1', '3/2', '3/3', '7/1', '7/3']);

function checkAllowed(p: UserdataParam): void {
  if (p.method === 'request') {
    if (!REQUEST_ALLOWED.has(`${p.group}/${p.subfunction}`)) {
      throw new RangeError(
        `richiesta userdata gruppo ${p.group} sottofunzione ${p.subfunction} non ammessa (kit in sola lettura)`,
      );
    }
  } else if (
    p.group === 1 ||
    p.group === 2 ||
    p.group === 5 ||
    (p.group === 7 && (p.subfunction === 2 || p.subfunction === 4))
  ) {
    throw new RangeError(
      `risposta userdata gruppo ${p.group} sottofunzione ${p.subfunction} non ammessa`,
    );
  }
}

/**
 * Parametro e dati di un userdata. `returnCode` 0xff = OK, 0x0a nelle richieste di
 * continuazione e nelle risposte "non trovato". Il transport size vale 0x09 con payload e 0x00
 * senza. `payload === null` produce una PDU senza parte dati.
 */
export function encodeUserdata(
  p: UserdataParam,
  payload: Uint8Array | null,
  returnCode = 0xff,
  transportSize?: number,
): { param: Uint8Array; data: Uint8Array } {
  checkAllowed(p);
  return build(p, payload, returnCode, transportSize);
}

/**
 * Richiesta di set clock (gruppo 7, subfunction 2, proto §12.0): l'unica scrittura userdata,
 * fuori dall'allowlist di sola lettura di `encodeUserdata`. Il chiamante passa il payload già
 * codificato (`reqSetClock`); il filtro di `online-write` ne verifica i byte.
 */
export function encodeSetClockUserdata(
  payload: Uint8Array,
  sequence: number,
): { param: Uint8Array; data: Uint8Array } {
  return build({ method: 'request', group: 7, subfunction: 2, sequence }, payload, 0xff);
}

function build(
  p: UserdataParam,
  payload: Uint8Array | null,
  returnCode: number,
  transportSize?: number,
): { param: Uint8Array; data: Uint8Array } {
  const type = p.type ?? (p.method === 'request' ? 4 : 8);
  if (p.method === 'request' ? type !== 4 : type !== 8 && type !== 0) {
    throw new RangeError(`type ${type} incoerente con method '${p.method}'`);
  }
  const methodByte = p.methodByte ?? (p.method === 'request' ? METHOD_REQUEST : METHOD_RESPONSE);
  if (methodByte !== METHOD_REQUEST && methodByte !== METHOD_RESPONSE) {
    throw new RangeError(`methodByte 0x${methodByte.toString(16)} non è 0x11 o 0x12`);
  }
  const extended =
    p.dataUnitRef !== undefined || p.lastDataUnit !== undefined || p.errorCode !== undefined;
  const param = new Uint8Array(extended ? 12 : 8);
  param.set(HEAD, 0);
  param[3] = extended ? 8 : 4;
  param[4] = methodByte;
  param[5] = (byteIn('type', type, 15) << 4) | byteIn('group', p.group, 15);
  param[6] = byteIn('subfunction', p.subfunction, 255);
  param[7] = byteIn('sequence', p.sequence, 255);
  if (extended) {
    param[8] = byteIn('dataUnitRef', p.dataUnitRef ?? 0, 255);
    param[9] = p.lastDataUnit ? 1 : 0;
    writeU16(param, 10, byteIn('errorCode', p.errorCode ?? 0, 0xffff));
  }
  if (payload === null) return { param, data: new Uint8Array(0) };
  if (payload.length > 0xffff - 4) throw new RangeError('payload userdata troppo lungo');
  const data = new Uint8Array(4 + payload.length);
  data[0] = byteIn('returnCode', returnCode, 255);
  data[1] = transportSize ?? (payload.length > 0 ? 0x09 : 0x00);
  writeU16(data, 2, payload.length);
  data.set(payload, 4);
  return { param, data };
}

export interface DecodedUserdata {
  param: UserdataParam;
  returnCode: number;
  /** Byte di transport size della parte dati (di norma 0x09, o 0x00 se il payload è vuoto). */
  transportSize: number;
  payload: Uint8Array;
  /** False se la PDU non ha parte dati (allora returnCode e transportSize valgono 0). */
  hasData: boolean;
}

export function decodeUserdata(param: Uint8Array, data: Uint8Array): DecodedUserdata {
  if (param.length < 8) throw bad('parametro troppo corto');
  if (param[0] !== HEAD[0] || param[1] !== HEAD[1] || param[2] !== HEAD[2]) {
    throw bad('testa del parametro diversa da 00 01 12');
  }
  const plen = readU8(param, 3);
  if (plen !== 4 && plen !== 8) throw bad(`lunghezza del parametro ${plen} diversa da 4 o 8`);
  if (param.length !== 4 + plen) throw bad('lunghezza del parametro incoerente');
  const m = readU8(param, 4);
  if (m !== METHOD_REQUEST && m !== METHOD_RESPONSE) {
    throw bad(`method 0x${m.toString(16)} sconosciuto`);
  }
  const tg = readU8(param, 5);
  const nibble = tg >> 4;
  if (nibble !== 0 && nibble !== 4 && nibble !== 8) throw bad(`type ${nibble} sconosciuto`);
  const out: UserdataParam = {
    method: nibble === 4 ? 'request' : 'response',
    type: nibble,
    methodByte: m,
    group: tg & 0x0f,
    subfunction: readU8(param, 6),
    sequence: readU8(param, 7),
  };
  if (plen === 8) {
    out.dataUnitRef = readU8(param, 8);
    out.lastDataUnit = readU8(param, 9) !== 0;
    out.errorCode = readU16(param, 10);
  }
  if (data.length === 0) {
    return {
      param: out,
      returnCode: 0,
      transportSize: 0,
      payload: new Uint8Array(0),
      hasData: false,
    };
  }
  if (data.length < 4) throw bad('parte dati più corta di 4 byte');
  const len = readU16(data, 2);
  if (data.length !== 4 + len) throw bad(`lunghezza dati ${len} incoerente con ${data.length - 4}`);
  return {
    param: out,
    returnCode: data[0]!,
    transportSize: data[1]!,
    payload: data.slice(4),
    hasData: true,
  };
}
