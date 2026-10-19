import { describe, expect, it } from 'vitest';
import { decodeSourceBytes, encodeSourceText } from '../src/index';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('decodeSourceBytes', () => {
  it('BOM UTF-8: codifica utf-8-bom e testo senza BOM', () => {
    const r = decodeSourceBytes(bytes(0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa0));
    expect(r).toEqual({ text: 'Aà', encoding: 'utf-8-bom' });
  });

  it('UTF-8 valido senza BOM', () => {
    expect(decodeSourceBytes(bytes(0x56, 0xc3, 0xa0))).toEqual({ text: 'Và', encoding: 'utf-8' });
  });

  it('Windows-1252 con accenti: Velocit\\xe0 -> Velocità', () => {
    const r = decodeSourceBytes(bytes(0x56, 0x65, 0x6c, 0x6f, 0x63, 0x69, 0x74, 0xe0));
    expect(r).toEqual({ text: 'Velocità', encoding: 'windows-1252' });
  });

  it('non normalizza i fine riga', () => {
    expect(decodeSourceBytes(bytes(0x41, 0x0d, 0x0a, 0x42, 0x0a)).text).toBe('A\r\nB\n');
  });

  it('file vuoto', () => {
    expect(decodeSourceBytes(bytes())).toEqual({ text: '', encoding: 'utf-8' });
  });
});

describe('encodeSourceText', () => {
  it('UTF-8 con BOM e CRLF', () => {
    const out = encodeSourceText('A\nB\r\nC');
    expect([...out.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(out.slice(3))).toBe('A\r\nB\r\nC');
  });

  it('andata e ritorno con accenti', () => {
    const r = decodeSourceBytes(encodeSourceText('Velocità\n'));
    expect(r).toEqual({ text: 'Velocità\r\n', encoding: 'utf-8-bom' });
  });
});
