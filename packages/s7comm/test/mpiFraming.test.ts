import { describe, expect, it } from 'vitest';
import { MpiFrameDecoder, encodeMpiFrame, fromHex, hex, mpiBcc } from '../src';

// Esempi calcolati a mano dalle regole del framing (scheda del protocollo, §9).
const VECTORS: [string, string, string][] = [
  ['richiesta di versione', '01 0D 02', '01 0D 02 10 03 1D'],
  ['elenco dei nodi', '01 07 02', '01 07 02 10 03 17'],
  ['chiusura adattatore', '01 04 02', '01 04 02 10 03 14'],
  [
    'configurazione v1, indirizzo 0, 187,5k',
    '01 03 02 27 00 9F 01 3C 00 90 01 14 00 00 05 02 00 1F 02 01 01 03 80',
    '01 03 02 27 00 9F 01 3C 00 90 01 14 00 00 05 02 00 1F 02 01 01 03 80 10 03 8A',
  ],
  [
    'configurazione v2, indirizzo 0, 187,5k',
    '01 03 02 17 00 9F 01 3C 00 90 01 14 00 00 05 02 00 0F 05 01 01 03 80',
    '01 03 02 17 00 9F 01 3C 00 90 01 14 00 00 05 02 00 0F 05 01 01 03 80 10 03 AD',
  ],
  [
    'connessione v1 alla CPU 2',
    '04 82 80 0D 00 14 E0 04 00 80 00 02 00 02 01 00 01 00',
    '04 82 80 0D 00 14 E0 04 00 80 00 02 00 02 01 00 01 00 10 03 68',
  ],
  [
    'connessione v2 alla CPU 2',
    '00 0D 00 03 E0 04 00 80 00 02 01 06 01 00 00 01 02 02 01 00',
    '00 0D 00 03 E0 04 00 80 00 02 01 06 01 00 00 01 02 02 01 00 10 03 7D',
  ],
  [
    'ack v1 con DLE raddoppiati',
    '04 82 80 0C 10 14 B0 01 10',
    '04 82 80 0C 10 10 14 B0 01 10 10 10 03 BC',
  ],
  [
    'prima PDU v1 (setup communication)',
    '04 82 80 0C 10 14 F1 00 32 01 00 00 FF FF 00 08 00 00 F0 00 00 01 00 01 03 C0',
    '04 82 80 0C 10 10 14 F1 00 32 01 00 00 FF FF 00 08 00 00 F0 00 00 01 00 01 03 C0 10 03 F4',
  ],
  ['disconnessione v2 dalla CPU', '00 0C 05 03 80', '00 0C 05 03 80 10 03 99'],
];

describe('framing del PC Adapter MPI', () => {
  it.each(VECTORS)('%s: byte sul filo e BCC come negli esempi', (_n, payload, wire) => {
    const p = fromHex(payload);
    expect(hex(encodeMpiFrame(p))).toBe(hex(fromHex(wire)));
    expect(mpiBcc(p)).toBe(fromHex(wire).at(-1));
  });

  it('un payload con 0x10 esce raddoppiato, il BCC no', () => {
    expect(hex(encodeMpiFrame(Uint8Array.of(0x10)))).toBe('1010' + '1003' + '13');
    // BCC = 0x10: non si raddoppia (segue il trailer)
    expect(hex(encodeMpiFrame(Uint8Array.of(0x03)))).toBe('03100310');
  });

  it.each(VECTORS)(
    '%s: il decoder ridà il payload anche a pezzi da 1 byte',
    (_n, payload, wire) => {
      const d = new MpiFrameDecoder();
      const got = [];
      for (const b of fromHex(wire)) got.push(...d.push(Uint8Array.of(b)));
      expect(got).toEqual([fromHex(payload)]);
    },
  );

  it('STX e DLE isolati sono segnali; più frame nello stesso blocco', () => {
    const d = new MpiFrameDecoder();
    const chunk = new Uint8Array([
      0x10,
      0x02,
      ...fromHex('010d0210031d'),
      0x10,
      ...encodeMpiFrame(Uint8Array.of(0x01, 0x10)),
    ]);
    expect(d.push(chunk)).toEqual(['DLE', 'STX', fromHex('010d02'), 'DLE', Uint8Array.of(1, 16)]);
  });

  it('un BCC sbagliato dà MPI_FRAME', () => {
    const d = new MpiFrameDecoder();
    expect(() => d.push(fromHex('010d0210031e'))).toThrowError(
      expect.objectContaining({ code: 'MPI_FRAME' }),
    );
  });

  it('DLE seguito da un byte che non è DLE né ETX dà MPI_FRAME', () => {
    expect(() => new MpiFrameDecoder().push(fromHex('011005'))).toThrowError(
      expect.objectContaining({ code: 'MPI_FRAME' }),
    );
  });

  it('un frame senza fine oltre il limite dà MPI_FRAME', () => {
    expect(() => new MpiFrameDecoder().push(new Uint8Array(5000).fill(0x41))).toThrowError(
      expect.objectContaining({ code: 'MPI_FRAME' }),
    );
  });
});
