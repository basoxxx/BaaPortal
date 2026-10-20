import {
  decodeReadResponse,
  decodeUserdata,
  type DecodedUserdata,
  type ItemResult,
  type S7Pdu,
} from '@baaportal/s7comm';

export interface CompareOptions {
  /**
   * La risposta è a una richiesta di continuazione: il payload non comincia con l'intestazione
   * della lista SZL, quindi quella non si confronta.
   */
  continuation?: boolean;
  /**
   * Se la CPU vera ha risposto con un errore dovuto al suo stato (un DB che là non esiste, un
   * livello di protezione) e la finta no, non è una differenza di forma: entrambe hanno risposto.
   */
  allowStateErrors?: boolean;
}

/**
 * Descrizione del codice d'errore di una risposta, `undefined` se non è un errore. Per le
 * letture variabili è un errore solo se falliscono tutti gli item.
 */
export function errorOf(p: S7Pdu): string | undefined {
  if (p.rosctr === 7) {
    const u = userdataOf(p);
    if (!u) return 'userdata illeggibile';
    const code = u.param.errorCode ?? 0;
    if (code !== 0) return `userdata errore ${h(code)}`;
    if (u.hasData && u.returnCode !== 0xff) return `userdata return code ${h(u.returnCode)}`;
    return undefined;
  }
  if (p.errorClass !== 0 || p.errorCode !== 0) {
    return `header classe ${h(p.errorClass)} codice ${h(p.errorCode)}`;
  }
  if (p.param[0] === 0x04) {
    const r = items(p);
    if (r && r.length > 0 && r.every((x) => !x.ok)) {
      return `item: ${r.map((x) => (x.ok ? 'ok' : h(x.returnCode))).join(',')}`;
    }
  }
  return undefined;
}

const h = (n: number | undefined): string => (n === undefined ? '-' : `0x${n.toString(16)}`);

/** Classe del return code di un item: riuscito o in errore (il codice esatto dipende dallo stato). */
const rcClass = (r: ItemResult): 'ok' | 'errore' => (r.ok ? 'ok' : 'errore');

function items(p: S7Pdu): ItemResult[] | undefined {
  try {
    return decodeReadResponse(p.param, p.data);
  } catch {
    return undefined;
  }
}

function userdataOf(p: S7Pdu): DecodedUserdata | undefined {
  try {
    return decodeUserdata(p.param, p.data);
  } catch {
    return undefined;
  }
}

/** Intestazione di una lista SZL: id, indice, lunghezza del record (proto §7.1). */
function szlHeader(
  payload: Uint8Array,
): { id: number; index: number; recordLength: number } | null {
  if (payload.length < 8) return null;
  return {
    id: (payload[0]! << 8) | payload[1]!,
    index: (payload[2]! << 8) | payload[3]!,
    recordLength: (payload[4]! << 8) | payload[5]!,
  };
}

/**
 * Confronta la STRUTTURA di due risposte S7, non i valori: ROSCTR, presenza di un errore
 * nell'header, funzione, lunghezza del parametro, intestazione dei dati (return code e
 * transport size), intestazione della lista SZL (id, indice, lunghezza del record), presenza di
 * frammentazione, e per le letture variabili classe del return code e transport size di ogni
 * item. Restituisce le differenze, `[]` se la forma è la stessa.
 */
export function compareShape(real: S7Pdu, fake: S7Pdu, opts: CompareOptions = {}): string[] {
  const out: string[] = [];
  const diff = (what: string, a: unknown, b: unknown): void => {
    if (a !== b) out.push(`${what}: vera ${String(a)}, finta ${String(b)}`);
  };
  if (opts.allowStateErrors && errorOf(real) !== undefined && errorOf(fake) === undefined) {
    return out; // la CPU vera ha un altro stato: entrambe hanno risposto
  }
  diff('ROSCTR', real.rosctr, fake.rosctr);
  if (real.rosctr !== fake.rosctr) return out;
  diff('lunghezza parametro', real.param.length, fake.param.length);

  if (real.rosctr === 7) {
    const a = userdataOf(real);
    const b = userdataOf(fake);
    if (!a || !b) {
      if (!a !== !b) out.push('userdata: una sola delle due è decodificabile');
      return out;
    }
    diff('metodo (type)', a.param.method, b.param.method);
    diff('byte method', h(a.param.methodByte), h(b.param.methodByte));
    diff('gruppo', a.param.group, b.param.group);
    diff('sottofunzione', a.param.subfunction, b.param.subfunction);
    diff('errore nel parametro', (a.param.errorCode ?? 0) !== 0, (b.param.errorCode ?? 0) !== 0);
    const szlFirst = a.param.group === 4 && !opts.continuation && a.returnCode === 0xff;
    if (!szlFirst || b.returnCode !== 0xff) {
      diff('frammentazione (last data unit)', !!a.param.lastDataUnit, !!b.param.lastDataUnit);
    }
    diff('parte dati presente', a.hasData, b.hasData);
    if (a.hasData && b.hasData) {
      diff('return code dati', h(a.returnCode), h(b.returnCode));
      diff('transport size dati', h(a.transportSize), h(b.transportSize));
      if (a.returnCode === 0xff && b.returnCode === 0xff) {
        const key = `${a.param.group}/${a.param.subfunction}`;
        if (key === '4/1' && !opts.continuation) {
          const ha = szlHeader(a.payload);
          const hb = szlHeader(b.payload);
          if (!ha || !hb) {
            if (!ha !== !hb) out.push('SZL: intestazione presente solo in una delle due');
          } else {
            diff('SZL id', h(ha.id), h(hb.id));
            diff('SZL indice', h(ha.index), h(hb.index));
            diff('SZL lunghezza record', ha.recordLength, hb.recordLength);
            // Quanti pezzi servono dipende da quanti record ha la lista, che è un valore; la
            // forma è che il flag di frammentazione dica il vero: altri record da inviare.
            const nDr = (p: DecodedUserdata): number => (p.payload[6]! << 8) | p.payload[7]!;
            // "solo intestazione" (0x0Fxx) e conteggio ignoto (0xFFFF): nessun totale da confrontare
            const sized = (p: DecodedUserdata, id: number): boolean =>
              nDr(p) !== 0xffff && (id & 0x0f00) !== 0x0f00;
            const more = (p: DecodedUserdata, hd: { recordLength: number }): boolean =>
              8 + hd.recordLength * nDr(p) > p.payload.length;
            const sameSize =
              !sized(a, ha.id) ||
              !sized(b, hb.id) ||
              ha.recordLength * nDr(a) === hb.recordLength * nDr(b);
            if (sameSize) {
              diff(
                'frammentazione (last data unit)',
                !!a.param.lastDataUnit,
                !!b.param.lastDataUnit,
              );
            }
            if (sized(a, ha.id)) {
              diff(
                'SZL vera: frammentazione coerente con la lunghezza',
                more(a, ha),
                !!a.param.lastDataUnit,
              );
            }
            if (sized(b, hb.id)) {
              diff(
                'SZL finta: frammentazione coerente con la lunghezza',
                more(b, hb),
                !!b.param.lastDataUnit,
              );
            }
          }
        }
        // payload a lunghezza fissa: info blocco (78 byte) e orologio (10 byte)
        if (key === '3/3' || key === '7/1' || key === '7/3') {
          diff('lunghezza payload', a.payload.length, b.payload.length);
        }
      }
    }
    return out;
  }

  // job (ack, ROSCTR 2 o 3)
  diff(
    "errore nell'header",
    real.errorClass !== 0 || real.errorCode !== 0,
    fake.errorClass !== 0 || fake.errorCode !== 0,
  );
  diff('funzione', h(real.param[0]), h(fake.param[0]));
  const fn = real.param[0];
  if (fn === 0x1e && real.param.length > 1 && fake.param.length > 1) {
    diff('upload: altri pezzi in arrivo', real.param[1] !== 0, fake.param[1] !== 0);
  }
  if (fn === 0x04) {
    const a = items(real);
    const b = items(fake);
    if (a && b) {
      diff('numero di item', a.length, b.length);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (opts.allowStateErrors && !x.ok && y.ok) continue;
        diff(`item ${i} classe del return code`, rcClass(x), rcClass(y));
        if (x.ok && y.ok) {
          diff(`item ${i} transport size`, h(x.transportSize), h(y.transportSize));
        }
      }
    } else if (!a !== !b) {
      out.push('lettura: risposta decodificabile solo da una delle due');
    }
  } else if (fn === 0x1e) {
    // upload: dati = lunghezza (2 byte, dipende dal contenuto) e 2 byte d'intestazione (`00 fb`)
    if (real.data.length >= 4 && fake.data.length >= 4) {
      diff(
        'upload: intestazione dati',
        h((real.data[2]! << 8) | real.data[3]!),
        h((fake.data[2]! << 8) | fake.data[3]!),
      );
    } else {
      diff('parte dati presente', real.data.length > 0, fake.data.length > 0);
    }
  } else if (real.data.length >= 4 && fake.data.length >= 4) {
    // intestazione dei dati: return code e transport size (poi la lunghezza, che dipende dal contenuto)
    diff('return code dati', h(real.data[0]), h(fake.data[0]));
    diff('transport size dati', h(real.data[1]), h(fake.data[1]));
  } else {
    diff('parte dati presente', real.data.length > 0, fake.data.length > 0);
  }
  return out;
}
