import { encodeBlockInfoRequest, encodeBlockListOfTypeRequest, type BlockType } from './blocks';
import { encodeSzlRequest } from './szl';
import { encodeBcdDateTime, type S7DateTime } from './clock';
import { S7Error } from '../errors';
import { encodeSetClockUserdata, encodeUserdata } from './userdata';

/** Costruttori delle richieste di lettura (proto §15.1) e, solo `reqSetClock`, del set clock (proto §12.0). */
export interface UserdataFrame {
  param: Uint8Array;
  data: Uint8Array;
}

const empty = new Uint8Array(0);

function req(group: number, subfunction: number, sequence: number, payload: Uint8Array, rc = 0xff) {
  return encodeUserdata({ method: 'request', group, subfunction, sequence }, payload, rc);
}

/** Read SZL (gruppo 4, subfunction 1). */
export function reqReadSzl(id: number, index: number, sequence = 0): UserdataFrame {
  return req(4, 1, sequence, encodeSzlRequest(id, index));
}

/** Conteggi per tipo (gruppo 3, subfunction 1): payload vuoto `0a 00 00 00`. */
export function reqBlockCounts(sequence = 0): UserdataFrame {
  return req(3, 1, sequence, empty, 0x0a);
}

export function reqBlockListOfType(type: BlockType, sequence = 0): UserdataFrame {
  return req(3, 2, sequence, encodeBlockListOfTypeRequest(type));
}

export function reqBlockInfo(
  type: BlockType,
  number: number,
  filesystem = 'A',
  sequence = 0,
): UserdataFrame {
  return req(3, 3, sequence, encodeBlockInfoRequest(type, number, filesystem));
}

/** Read clock (gruppo 7, subfunction 1): payload vuoto `0a 00 00 00`. */
export function reqReadClock(sequence = 0): UserdataFrame {
  return req(7, 1, sequence, empty, 0x0a);
}

/** Richiesta di continuazione (proto §6.7): stesso sequence della CPU, payload `0a 00 00 00`. */
export function reqContinue(group: number, subfunction: number, sequence: number): UserdataFrame {
  return encodeUserdata(
    {
      method: 'request',
      methodByte: 0x12,
      group,
      subfunction,
      sequence,
      dataUnitRef: 0,
      lastDataUnit: false,
      errorCode: 0,
    },
    empty,
    0x0a,
  );
}

/**
 * Set clock (gruppo 7, subfunction `0x02`, proto §12.0; mai la `0x04`): dati `ff 09 000a` + ora
 * di 10 byte. Il giorno della settimana è sempre 0: lo ricalcola la CPU. Un campo fuori
 * intervallo (anno 1990-2089 compreso, §12.1) lancia RangeError prima di costruire i byte.
 */
export function reqSetClock(t: S7DateTime, sequence = 0): UserdataFrame {
  let payload: Uint8Array;
  try {
    payload = encodeBcdDateTime({ ...t, weekday: 0 });
  } catch (e) {
    if (e instanceof S7Error) throw new RangeError(e.message);
    throw e;
  }
  return encodeSetClockUserdata(payload, sequence);
}
