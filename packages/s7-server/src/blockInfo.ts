import { blockTypeCode, encodeBlockInfo, type BlockInfo } from '@baaportal/s7comm';
import type { StoredBlock } from './backend';

/** Payload (78 byte) della risposta di block info per un blocco memorizzato. */
export function encodeStoredBlockInfo(b: StoredBlock): Uint8Array {
  const h = b.parsed.header;
  const f = b.parsed.footer;
  // il sottotipo è già nel tipo; la versione del footer è decimale, quella di block info esadecimale
  const ver = /^(\d+)\.(\d+)$/.exec(f?.version ?? '0.0');
  const info: BlockInfo = {
    typeCode: blockTypeCode(b.type),
    type: b.type,
    number: h.number,
    language: h.language,
    flags: h.flags,
    loadLength: h.loadLength,
    security: h.security,
    codeTime: h.codeTime,
    interfaceTime: h.interfaceTime,
    ssbLength: h.ssbLength,
    addLength: h.addLength,
    localDataLength: h.localDataLength,
    mc7Length: h.mc7Length,
    author: f?.author ?? '',
    family: f?.family ?? '',
    name: f?.name ?? '',
    version: ver ? `${Number(ver[1]).toString(16)}.${Number(ver[2]).toString(16)}` : '0.0',
    checksum: f?.checksum ?? 0,
    raw: {
      // come nelle risposte reali di una 315: `01 00 00 4a 22 00 70 70 01 ...`
      word0: 0x0100,
      codeTime: h.codeTimeRaw,
      interfaceTime: h.interfaceTimeRaw,
      author: f?.raw?.author,
      family: f?.raw?.family,
      name: f?.raw?.name,
    },
  };
  return encodeBlockInfo(info);
}
