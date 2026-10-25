import { buildBlockFile } from '@baaportal/s7comm';

/** La scritta in testa al corpo di un SDB di prova (non è un SDB vero: i byte sono sintetici). */
export const SYNTHETIC_SDB_TEXT = 'BaaPortal SDB di prova';

/**
 * File di blocco di un SDB sintetico (proto §13, §19): tipo SDB, linguaggio `0x07`, corpo di
 * `length` byte a zero con la scritta di prova in testa. Serve a provare l'elenco, il block info e
 * l'upload degli SDB senza usare i byte di una CPU vera.
 */
export function syntheticSdb(number: number, length: number): Uint8Array {
  if (!Number.isInteger(number) || number < 0 || number > 0xffff) {
    throw new RangeError(`numero SDB ${number} fuori 0-65535`);
  }
  if (!Number.isInteger(length) || length < 0 || length > 0xffff) {
    throw new RangeError(`lunghezza SDB ${length} fuori 0-65535`);
  }
  const body = new Uint8Array(length);
  for (let i = 0; i < Math.min(SYNTHETIC_SDB_TEXT.length, length); i++) {
    body[i] = SYNTHETIC_SDB_TEXT.charCodeAt(i);
  }
  const t = { year: 2020, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 };
  return buildBlockFile(
    {
      type: 'SDB',
      number,
      language: 0x07,
      flags: 0,
      security: 0,
      codeTime: t,
      interfaceTime: t,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: length,
    },
    body,
    { author: 'BaaPort', family: 'SDB', name: `SDB${number}`, version: '1.0', checksum: 0 },
  );
}
