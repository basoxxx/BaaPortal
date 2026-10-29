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
      d.expectFrame();
      const got = [];
      for (const b of fromHex(wire)) got.push(...d.push(Uint8Array.of(b)));
      expect(got).toEqual([fromHex(payload)]);
    },
  );

  it('fuori da un frame STX, DLE e NAK sono segnali e il resto è rumore', () => {
    const d = new MpiFrameDecoder();
    // senza expectFrame un byte che non è un segnale (anche 0x00, come l'inizio di un payload) si scarta
    expect(d.push(Uint8Array.of(0x00, 0xff, 0x10, 0x41, 0x15, 0x02))).toEqual([
      'DLE',
      'NAK',
      'STX',
    ]);
    d.expectFrame();
    expect(d.push(encodeMpiFrame(Uint8Array.of(0x01, 0x10)))).toEqual([Uint8Array.of(1, 16)]);
    // dopo il frame si torna a riposo: i byte di un altro frame non danno payload
    expect(d.push(fromHex('010d0210031d'))).toEqual(['STX', 'DLE']);
  });

  it('un BCC sbagliato scarta il frame senza errori; il successivo passa', () => {
    const d = new MpiFrameDecoder();
    d.expectFrame();
    expect(d.push(fromHex('010d0210031e'))).toEqual([]);
    d.expectFrame();
    expect(d.push(fromHex('010d0210031d'))).toEqual([fromHex('010d02')]);
  });

  it('DLE seguito da un byte strano: frame scartato e il byte rivale da solo (STX)', () => {
    const d = new MpiFrameDecoder();
    d.expectFrame();
    expect(d.push(fromHex('011002'))).toEqual(['STX']);
  });

  it('uno STX al posto del frame atteso è un segnale (l’altro lato riparte)', () => {
    const d = new MpiFrameDecoder();
    d.expectFrame();
    expect(d.push(Uint8Array.of(0x02))).toEqual(['STX']);
  });

  it('un frame senza fine oltre il limite si scarta, poi reset torna a riposo', () => {
    const d = new MpiFrameDecoder();
    d.expectFrame();
    expect(d.push(new Uint8Array(5000).fill(0x41))).toEqual([]);
    d.expectFrame();
    d.push(Uint8Array.of(0x01));
    d.reset();
    expect(d.push(fromHex('0d0210031d'))).toEqual(['STX', 'DLE']);
  });
});
