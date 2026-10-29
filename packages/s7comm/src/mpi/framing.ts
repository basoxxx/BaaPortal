import { S7Error } from '../errors';

// Caratteri di controllo del line procedure in stile 3964R.
// libnodave nodave.h (righe 112-116); da verificare su adattatore reale.
export const STX = 0x02;
export const ETX = 0x03;
export const DLE = 0x10;

/** Payload massimo accettato: PDU da 960 più intestazione MPI, con margine. */
const MAX_PAYLOAD = 2048;

/**
 * BCC: XOR dei byte del payload partendo da DLE ^ ETX; un DLE del payload esce raddoppiato e
 * quindi si annulla. libnodave nodave.c `_daveSendWithCRC`; da verificare su adattatore reale.
 */
export function mpiBcc(payload: Uint8Array): number {
  let acc = DLE ^ ETX;
  for (const b of payload) if (b !== DLE) acc ^= b;
  return acc;
}

/** Payload con ogni DLE raddoppiato, poi `DLE ETX` e il BCC (mai raddoppiato). */
export function encodeMpiFrame(payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of payload) {
    out.push(b);
    if (b === DLE) out.push(DLE);
  }
  out.push(DLE, ETX, mpiBcc(payload));
  return Uint8Array.from(out);
}

/** Un segnale della procedura (STX o DLE isolati) o il payload di un frame, senza raddoppi. */
export type MpiItem = 'STX' | 'DLE' | Uint8Array;

const h = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/**
 * Riceve i byte dalla linea. Fuori da un frame, STX e DLE sono segnali; ogni altro byte apre un
 * frame (i payload del PC Adapter cominciano con 00, 01 o 04, mai con STX o DLE). Il frame
 * finisce a `DLE ETX` e il BCC si controlla: uno sbagliato dà `MPI_FRAME`.
 */
export class MpiFrameDecoder {
  #state: 'idle' | 'data' | 'dle' | 'bcc' = 'idle';
  #buf: number[] = [];

  push(chunk: Uint8Array): MpiItem[] {
    const out: MpiItem[] = [];
    for (const b of chunk) {
      switch (this.#state) {
        case 'idle':
          if (b === STX) out.push('STX');
          else if (b === DLE) out.push('DLE');
          else {
            this.#buf = [b];
            this.#state = 'data';
          }
          break;
        case 'data':
          if (b === DLE) this.#state = 'dle';
          else this.#add(b);
          break;
        case 'dle':
          if (b === DLE) {
            this.#add(DLE);
            this.#state = 'data';
          } else if (b === ETX) {
            this.#state = 'bcc';
          } else {
            this.#reset();
            throw new S7Error('MPI_FRAME', `frame MPI: DLE seguito da ${h(b)}`);
          }
          break;
        case 'bcc': {
          const payload = Uint8Array.from(this.#buf);
          this.#reset();
          const want = mpiBcc(payload);
          if (b !== want) {
            throw new S7Error('MPI_FRAME', `frame MPI: BCC ${h(b)}, atteso ${h(want)}`);
          }
          out.push(payload);
          break;
        }
      }
    }
    return out;
  }

  #add(b: number): void {
    if (this.#buf.length >= MAX_PAYLOAD) {
      this.#reset();
      throw new S7Error('MPI_FRAME', `frame MPI oltre ${MAX_PAYLOAD} byte senza fine`);
    }
    this.#buf.push(b);
  }

  #reset(): void {
    this.#state = 'idle';
    this.#buf = [];
  }
}
