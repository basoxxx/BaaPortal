// Caratteri di controllo del line procedure in stile 3964R.
// libnodave nodave.h (righe 112-116); da verificare su adattatore reale.
export const STX = 0x02;
export const ETX = 0x03;
export const DLE = 0x10;
// Risposta negativa (3964R): il telegramma non è stato preso, si rimanda.
export const NAK = 0x15;

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

/** Un segnale della procedura (STX, DLE o NAK isolati) o il payload di un frame, senza raddoppi. */
export type MpiItem = 'STX' | 'DLE' | 'NAK' | Uint8Array;

/**
 * Riceve i byte dalla linea. Un frame si accetta solo dopo `expectFrame()` (chi riceve ha appena
 * risposto DLE a uno STX); fuori da lì STX, DLE e NAK sono segnali e ogni altro byte è rumore e
 * si scarta. Il frame finisce a `DLE ETX` e il BCC si controlla. Non solleva mai: un frame
 * rovinato (BCC sbagliato, DLE seguito da un byte strano, troppo lungo) si scarta in silenzio,
 * così chi l'ha mandato non riceve il DLE e lo rimanda (3964R).
 */
export class MpiFrameDecoder {
  #state: 'idle' | 'expect' | 'data' | 'dle' | 'bcc' = 'idle';
  #buf: number[] = [];

  /** Il prossimo byte che non è STX apre un frame. */
  expectFrame(): void {
    this.#state = 'expect';
    this.#buf = [];
  }

  /** Torna a riposo e scarta un frame a metà. */
  reset(): void {
    this.#state = 'idle';
    this.#buf = [];
  }

  push(chunk: Uint8Array): MpiItem[] {
    const out: MpiItem[] = [];
    for (const b of chunk) this.#byte(b, out);
    return out;
  }

  #byte(b: number, out: MpiItem[]): void {
    switch (this.#state) {
      case 'idle':
        if (b === STX) out.push('STX');
        else if (b === DLE) out.push('DLE');
        else if (b === NAK) out.push('NAK');
        return; // rumore fuori da un frame
      case 'expect':
        if (b === STX) {
          // l'altro lato non ha visto il nostro DLE e riparte da capo
          this.reset();
          out.push('STX');
        } else {
          this.#state = 'data';
          this.#add(b);
        }
        return;
      case 'data':
        if (b === DLE) this.#state = 'dle';
        else this.#add(b);
        return;
      case 'dle':
        if (b === DLE) {
          this.#state = 'data';
          this.#add(DLE);
        } else if (b === ETX) {
          this.#state = 'bcc';
        } else {
          // frame rovinato: si scarta e il byte vale di nuovo da solo (può essere uno STX)
          this.reset();
          this.#byte(b, out);
        }
        return;
      case 'bcc': {
        const payload = Uint8Array.from(this.#buf);
        this.reset();
        // BCC sbagliato: niente frame, quindi niente DLE da parte nostra e l'altro lato rimanda
        if (b === mpiBcc(payload)) out.push(payload);
        return;
      }
    }
  }

  #add(b: number): void {
    if (this.#buf.length >= MAX_PAYLOAD)
      this.reset(); // frame senza fine: scartato
    else this.#buf.push(b);
  }
}
