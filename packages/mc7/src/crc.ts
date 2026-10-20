/**
 * Checksum del blocco (mc7 §1.7): CRC-16, polinomio 0x9003, valore iniziale 0, bit più
 * significativo per primo, nessuna riflessione né XOR finale. Copre il byte di tipo, la
 * lunghezza MC7 (2 byte BE) e i byte della sezione MC7.
 */
export function blockChecksum(kindCode: number, mc7: Uint8Array): number {
  if (!Number.isInteger(kindCode) || kindCode < 0 || kindCode > 0xff) {
    throw new RangeError(`codice tipo fuori intervallo: ${kindCode}`);
  }
  if (mc7.length > 0xffff) throw new RangeError(`sezione MC7 troppo lunga: ${mc7.length}`);
  let crc = 0;
  const feed = (byte: number): void => {
    for (let bit = 7; bit >= 0; bit--) {
      const top = (crc >> 15) & 1;
      const data = (byte >> bit) & 1;
      crc = (crc << 1) & 0xffff;
      if (top !== data) crc ^= 0x9003;
    }
  };
  feed(kindCode);
  feed(mc7.length >> 8);
  feed(mc7.length & 0xff);
  for (const b of mc7) feed(b);
  return crc;
}
