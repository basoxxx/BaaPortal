export type SourceEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252';

/** Decodifica i byte di un file: BOM UTF-8, UTF-8 valido, altrimenti Windows-1252. I fine riga restano com'erano. */
export function decodeSourceBytes(bytes: Uint8Array): { text: string; encoding: SourceEncoding } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** UTF-8 con BOM e CRLF (un LF isolato diventa CRLF). */
export function encodeSourceText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'));
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
