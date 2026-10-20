/** Nomi dei codici di errore S7. Fonte: proto §3.3 (header/parametro) e §5.6 (item). */

const EXACT: Record<number, string> = {
  0x0000: 'nessun errore',
  0x0110: 'numero blocco non valido',
  0x0111: 'lunghezza richiesta non valida',
  0x0112: 'parametro non valido',
  0x0113: 'tipo blocco non valido',
  0x0114: 'blocco non trovato',
  0x0115: 'blocco già esistente',
  0x0116: 'blocco protetto in scrittura',
  0x0117: 'blocco/aggiornamento OS troppo grande',
  0x0118: 'numero blocco non valido',
  0x0119: 'password errata',
  0x011a: 'errore risorse PG',
  0x011b: 'errore risorse PLC',
  0x011c: 'errore di protocollo',
  0x011d: 'troppi blocchi (limite del modulo)',
  0x011e: 'connessione al DB persa o handle S7DOS non valido',
  0x011f: 'buffer risultato troppo piccolo',
  0x0120: 'fine della lista blocchi',
  0x0140: 'memoria insufficiente',
  0x0141: 'job non processabile per mancanza di risorse',
  0x8001: 'servizio non eseguibile nello stato attuale del blocco',
  0x8003: 'errore durante il trasferimento del blocco',
  0x8100: 'errore generale: servizio sconosciuto al modulo remoto',
  0x8104: 'servizio non implementato sul modulo / errore di frame',
  0x8204: "specifica di tipo dell'oggetto incoerente",
  0x8205: 'blocco copiato già esistente e non linkato',
  0x8301: 'memoria insufficiente sul modulo o supporto non accessibile',
  0x8302: 'troppe poche risorse / risorse processore non disponibili',
  0x8304: 'nessun ulteriore upload parallelo possibile (risorse)',
  0x8305: 'funzione non disponibile',
  0x8306: 'memoria di lavoro insufficiente (copia/link/load)',
  0x8307: 'memoria ritentiva insufficiente',
  0x8401: 'sequenza di servizio non valida (es. load/upload blocco)',
  0x8402: "servizio non eseguibile per lo stato dell'oggetto",
  0x8404: 'funzione non eseguibile',
  0x8405: 'blocco remoto in stato DISABLE (CFB)',
  0x8500: 'frame errati (wrong frames)',
  0x8503: 'allarme dal modulo: servizio annullato in anticipo',
  0x8701: "errore di indirizzamento dell'oggetto (es. area length error)",
  0x8702: 'servizio non supportato dal modulo',
  0x8703: "accesso all'oggetto rifiutato",
  0x8704: 'errore di accesso: oggetto danneggiato',
  0xd03f: 'coding error nella sezione parametri',
  0xd081: 'funzione non permessa nel modo attuale',
  0xd0a1: 'funzione non permessa nel livello di protezione attuale',
  0xd0a4: 'forcing già attivo',
  0xd201: 'errore sintassi nel nome del blocco',
  0xd202: 'errore sintassi nei parametri di funzione',
  0xd209: 'almeno uno dei blocchi indicati non trovato sul modulo',
  0xd20a: 'superato il max di blocchi linkabili in un job',
  0xd20b: 'superato il max di blocchi cancellabili in un job',
  0xd20e: 'nessun (ulteriore) blocco disponibile',
  0xd20f: 'superata la dimensione max blocco specifica del modulo',
  0xd210: 'numero blocco non valido',
  0xd241: 'funzione non permessa nel livello di protezione attuale',
  0xd242: 'violazione di protezione su blocchi F',
  0xd280: 'errore di compilazione blocco in CPU S7-300',
  0xd601: 'errore sintassi nel parametro di funzione (security)',
  0xd602: 'password errata',
  0xd603: 'connessione già legittimata',
  0xd604: 'connessione già abilitata',
  0xd605: 'legittimazione impossibile: password inesistente',
  0xdc01: 'data e/o ora non valide',
};

/** Intervalli di §3.3, valgono solo se non c'è una voce esatta. */
const RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0xd001, 0xd00b, 'errore parametro funzioni di debug'],
  [0xd011, 0xd033, 'errore parametro programming/debug'],
  [0xd041, 0xd0cc, 'errore dati/modo/protezione nelle funzioni TIS'],
  [0xd205, 0xd20c, 'blocco già linkato in RAM/EPROM, troppi blocchi o blocco non trovato'],
  [0xd212, 0xd241, 'attributi/lunghezze/linguaggio del blocco non validi'],
  [
    0xd2a1,
    0xd2c2,
    'blocco occupato da altra funzione, parametri CPU in assegnazione o download non possibile',
  ],
  [0xd401, 0xd409, 'funzione informativa non disponibile / errore diagnostica'],
  [0xd801, 0xd807, 'errore funzioni cicliche (indirizzo tag, job, tempo ciclo, overload)'],
  [0xe201, 0xe206, 'errore connect&update H-system'],
  [0xef01, 0xef02, 'ID2 errato'],
];

function hexN(n: number, w: number): string {
  return `0x${n.toString(16).padStart(w, '0')}`;
}

/** Codice a 16 bit = (errorClass << 8) | errorCode, uguale per header e parametro (proto §3.2). */
export function errorName(errorClass: number, errorCode: number): string {
  const key = ((errorClass & 0xff) << 8) | (errorCode & 0xff);
  const exact = EXACT[key];
  if (exact !== undefined) return exact;
  for (const [lo, hi, name] of RANGES) if (key >= lo && key <= hi) return name;
  return `sconosciuto (${hexN(key, 4)})`;
}

const ITEM_RETURN: Record<number, string> = {
  0x00: 'riservato',
  0x01: 'errore hardware',
  0x03: "accesso all'oggetto non consentito",
  0x05: 'indirizzo non valido / fuori range',
  0x06: 'tipo di dato non supportato',
  0x07: 'tipo di dato incoerente (size mismatch)',
  0x0a: 'oggetto non disponibile',
  0xff: 'successo',
};

export function itemReturnName(code: number): string {
  return ITEM_RETURN[code] ?? `sconosciuto (${hexN(code, 2)})`;
}
