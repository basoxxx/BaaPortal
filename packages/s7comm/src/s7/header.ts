import { readU16, writeU16 } from '../bytes';
import { S7Error } from '../errors';

/** PDU S7 (proto §3). Per ROSCTR 1 e 7 errorClass/errorCode non esistono sul filo e valgono 0. */
export interface S7Pdu {
  rosctr: 1 | 2 | 3 | 7;
  pduRef: number;
  errorClass: number;
  errorCode: number;
  param: Uint8Array;
  data: Uint8Array;
}

const PROTOCOL_ID = 0x32;

function headerLength(rosctr: number): number {
  return rosctr === 2 || rosctr === 3 ? 12 : 10;
}

export function encodeS7(p: S7Pdu): Uint8Array {
  const hl = headerLength(p.rosctr);
  const out = new Uint8Array(hl + p.param.length + p.data.length);
  out[0] = PROTOCOL_ID;
  out[1] = p.rosctr;
  // off 2-3: redundancy id = 0x0000
  writeU16(out, 4, p.pduRef);
  writeU16(out, 6, p.param.length);
  writeU16(out, 8, p.data.length);
  if (hl === 12) {
    out[10] = p.errorClass & 0xff;
    out[11] = p.errorCode & 0xff;
  }
  out.set(p.param, hl);
  out.set(p.data, hl + p.param.length);
  return out;
}

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `S7: ${msg}`);
}

export function decodeS7(b: Uint8Array): S7Pdu {
  if (b.length < 10) throw bad('PDU troppo corta');
  if (b[0] !== PROTOCOL_ID) throw bad(`protocol id 0x${b[0]!.toString(16)} diverso da 0x32`);
  const r = b[1]!;
  if (r !== 1 && r !== 2 && r !== 3 && r !== 7) throw bad(`ROSCTR 0x${r.toString(16)} sconosciuto`);
  const hl = headerLength(r);
  if (b.length < hl) throw bad('header troncato');
  const plen = readU16(b, 6);
  const dlen = readU16(b, 8);
  if (hl + plen + dlen !== b.length) {
    throw bad(`lunghezze incoerenti: header ${hl} + param ${plen} + dati ${dlen} <> ${b.length}`);
  }
  return {
    rosctr: r,
    pduRef: readU16(b, 4),
    errorClass: hl === 12 ? b[10]! : 0,
    errorCode: hl === 12 ? b[11]! : 0,
    param: b.slice(hl, hl + plen),
    data: b.slice(hl + plen),
  };
}
