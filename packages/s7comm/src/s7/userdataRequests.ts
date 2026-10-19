import { encodeBlockInfoRequest, encodeBlockListOfTypeRequest, type BlockType } from './blocks';
import { encodeSzlRequest } from './szl';
import { encodeUserdata } from './userdata';

/** Costruttori delle sole richieste di lettura (proto §15.1). Niente set clock, niente scritture. */
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
      method: 'response',
      type: 4,
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
