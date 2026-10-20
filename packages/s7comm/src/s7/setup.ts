import { readU16, readU8, writeU16 } from '../bytes';
import { S7Error } from '../errors';

export interface SetupParams {
  amqCalling: number;
  amqCalled: number;
  pduLength: number;
}

const FN_SETUP = 0xf0;

function u16(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff)
    throw new RangeError(`${name} ${v} fuori 0-65535`);
  return v;
}

/** Parte parametro, 8 byte (proto §4); identica in richiesta e risposta. */
export function encodeSetup(p: SetupParams): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = FN_SETUP;
  writeU16(out, 2, u16('amqCalling', p.amqCalling));
  writeU16(out, 4, u16('amqCalled', p.amqCalled));
  writeU16(out, 6, u16('pduLength', p.pduLength));
  return out;
}

export function decodeSetup(param: Uint8Array): SetupParams {
  if (param.length < 8)
    throw new S7Error('PROTOCOL', 'setup communication: parametro troppo corto');
  if (readU8(param, 0) !== FN_SETUP) {
    throw new S7Error('PROTOCOL', 'setup communication: funzione diversa da 0xF0');
  }
  return {
    amqCalling: readU16(param, 2),
    amqCalled: readU16(param, 4),
    pduLength: readU16(param, 6),
  };
}
