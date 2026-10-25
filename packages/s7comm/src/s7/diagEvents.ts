/**
 * Event ID del buffer diagnostico (proto §7.6.2) e tabella degli eventi (§7.6.3). I testi
 * italiani sono quelli del documento di protocollo; quelli inglesi sono nostri. Un test tiene
 * allineati gli ID e i testi italiani con la tabella del documento.
 */

export interface EventId {
  /** Classe (bit 15-12). */
  cls: number;
  /** Numero dell'evento (bit 7-0). */
  number: number;
  /** Bit 8: 1 = entrante, 0 = uscente. */
  incoming: boolean;
  /** Bit 10: errore interno. */
  internal: boolean;
  /** Bit 11: errore esterno. */
  external: boolean;
  /** Bit 9: la voce è nel buffer diagnostico. */
  inBuffer: boolean;
}

export function decodeEventId(id: number): EventId {
  return {
    cls: (id >> 12) & 0xf,
    number: id & 0xff,
    incoming: (id & 0x100) !== 0,
    internal: (id & 0x400) !== 0,
    external: (id & 0x800) !== 0,
    inBuffer: (id & 0x200) !== 0,
  };
}

export interface Text {
  it: string;
  en: string;
}

/** Nomi delle classi, indicizzati dal valore numerico della classe (1-15). */
export const EVENT_CLASSES: Record<number, Text> = {
  1: { it: 'eventi OB standard', en: 'standard OB events' },
  2: { it: 'errori sincroni', en: 'synchronous errors' },
  3: { it: 'errori asincroni', en: 'asynchronous errors' },
  4: { it: 'cambi di modo', en: 'mode changes' },
  5: { it: 'eventi di esecuzione', en: 'runtime events' },
  6: { it: 'eventi di comunicazione', en: 'communication events' },
  7: { it: 'sistemi H e F', en: 'H and F systems' },
  8: { it: 'diagnostica standard dei moduli', en: 'standard module diagnostics' },
  9: { it: 'eventi utente predefiniti', en: 'predefined user events' },
  10: { it: "eventi liberi dell'utente", en: 'free user events' },
  11: { it: "eventi liberi dell'utente", en: 'free user events' },
  0: { it: 'classe 0 (non definita)', en: 'class 0 (undefined)' },
  12: { it: 'classe riservata', en: 'reserved class' },
  13: { it: 'classe riservata', en: 'reserved class' },
  14: { it: 'classe riservata', en: 'reserved class' },
  15: { it: 'eventi di moduli che non sono CPU', en: 'events of non-CPU modules' },
};

const UNKNOWN_CLASS: Text = { it: 'classe sconosciuta', en: 'unknown class' };

const TABLE: readonly (readonly [number, string, string])[] = [
  [0x1381, 'richiesta di avviamento a caldo manuale', 'manual warm restart requested'],
  [
    0x1382,
    'richiesta di avviamento a caldo automatico (rete tornata)',
    'automatic warm restart requested (power returned)',
  ],
  [0x1383, 'richiesta di riavvio (ripresa) manuale', 'manual restart (resume) requested'],
  [0x1384, 'richiesta di riavvio (ripresa) automatico', 'automatic restart (resume) requested'],
  [0x1385, 'richiesta di avviamento a freddo manuale', 'manual cold restart requested'],
  [0x1386, 'richiesta di avviamento a freddo automatico', 'automatic cold restart requested'],
  [0x2521, 'errore di conversione BCD', 'BCD conversion error'],
  [0x2522, "lunghezza d'area errata in lettura", 'wrong area length on read'],
  [0x2523, "lunghezza d'area errata in scrittura", 'wrong area length on write'],
  [0x2524, 'area errata in lettura', 'wrong area on read'],
  [0x2525, 'area errata in scrittura', 'wrong area on write'],
  [0x2526, 'numero di temporizzatore non valido', 'invalid timer number'],
  [0x2527, 'numero di contatore non valido', 'invalid counter number'],
  [0x2528, 'allineamento errato in lettura', 'wrong alignment on read'],
  [0x2529, 'allineamento errato in scrittura', 'wrong alignment on write'],
  [0x2530, 'scrittura su DB protetto in scrittura', 'write to a write-protected DB'],
  [
    0x2531,
    'scrittura su DB di istanza protetto in scrittura',
    'write to a write-protected instance DB',
  ],
  [0x2532, "numero di DB non valido all'apertura", 'invalid DB number on open'],
  [0x2533, "numero di DB di istanza non valido all'apertura", 'invalid instance DB number on open'],
  [0x2534, 'numero di FC non valido nella chiamata', 'invalid FC number in call'],
  [0x2535, 'numero di FB non valido nella chiamata', 'invalid FB number in call'],
  [0x253a, 'DB non caricato', 'DB not loaded'],
  [0x253c, 'FC non caricata', 'FC not loaded'],
  [0x253d, 'SFC non presente', 'SFC not present'],
  [0x253e, 'FB non caricato', 'FB not loaded'],
  [0x253f, 'SFB non presente', 'SFB not present'],
  [0x2942, 'errore di accesso alla periferia in lettura', 'I/O access error on read'],
  [0x2943, 'errore di accesso alla periferia in scrittura', 'I/O access error on write'],
  [0x3501, 'tempo di ciclo superato', 'cycle time exceeded'],
  [0x3502, 'errore nella richiesta di un OB', 'error requesting an OB'],
  [
    0x3503,
    "ritardo eccessivo nell'elaborazione di una classe di priorità",
    'excessive delay in processing a priority class',
  ],
  [
    0x3505,
    "interrupt orari saltati per il cambio dell'ora",
    'time-of-day interrupts skipped because of a clock change',
  ],
  [
    0x3507,
    'troppe richieste di OB: buffer interno pieno',
    'too many OB requests: internal buffer full',
  ],
  [0x3571, 'troppi livelli di parentesi annidate', 'too many nested parentheses'],
  [0x3572, 'troppi annidamenti di MCR', 'too many nested MCRs'],
  [0x3573, 'troppi annidamenti di errori sincroni', 'too many nested synchronous errors'],
  [0x3574, 'stack delle chiamate (U-stack) troppo profondo', 'call stack (U stack) too deep'],
  [0x3575, 'stack dei blocchi (B-stack) troppo profondo', 'block stack (B stack) too deep'],
  [0x3576, 'errore di allocazione dei dati locali', 'local data allocation error'],
  [0x3578, 'istruzione sconosciuta', 'unknown instruction'],
  [0x357a, 'salto fuori dal blocco', 'jump outside the block'],
  [0x35a1, 'OB richiesto non trovato', 'requested OB not found'],
  [
    0x35a2,
    'OB non caricato (avviato da SFC o dal sistema operativo)',
    'OB not loaded (started by SFC or the operating system)',
  ],
  [
    0x35a3,
    "errore del sistema operativo nell'accesso a un blocco",
    'operating system error accessing a block',
  ],
  [0x3821, 'batteria tampone guasta (BATTF) (uscente)', 'backup battery failed (BATTF) (outgoing)'],
  [
    0x3921,
    'batteria tampone guasta (BATTF) (entrante)',
    'backup battery failed (BATTF) (incoming)',
  ],
  [0x3822, 'tensione di backup assente (BAF) (uscente)', 'backup voltage missing (BAF) (outgoing)'],
  [
    0x3922,
    'tensione di backup assente (BAF) (entrante)',
    'backup voltage missing (BAF) (incoming)',
  ],
  [
    0x3823,
    'alimentazione 24 V del rack centrale mancante (uscente)',
    '24 V supply of the central rack missing (outgoing)',
  ],
  [
    0x3923,
    'alimentazione 24 V del rack centrale mancante (entrante)',
    '24 V supply of the central rack missing (incoming)',
  ],
  [
    0x3842,
    'modulo tornato a posto (interrupt di diagnostica)',
    'module OK again (diagnostic interrupt)',
  ],
  [0x3942, 'modulo guasto (interrupt di diagnostica)', 'module faulty (diagnostic interrupt)'],
  [0x3861, 'modulo inserito, tipo corretto', 'module inserted, correct type'],
  [0x3863, 'modulo inserito ma di tipo sbagliato', 'module inserted but of the wrong type'],
  [0x3961, 'modulo tolto o non indirizzabile', 'module removed or not addressable'],
  [
    0x3866,
    'modulo di nuovo indirizzabile (tensione di carico tornata)',
    'module addressable again (load voltage returned)',
  ],
  [
    0x3966,
    'modulo non indirizzabile per mancanza di tensione di carico',
    'module not addressable: load voltage missing',
  ],
  [0x38c1, 'rack di ampliamento di nuovo funzionante', 'expansion rack working again'],
  [0x39c1, 'rack di ampliamento guasto', 'expansion rack failed'],
  [0x38c4, 'periferia decentrata: stazione tornata', 'distributed I/O: station returned'],
  [0x39c4, 'periferia decentrata: stazione guasta', 'distributed I/O: station failed'],
  [
    0x39c3,
    'periferia decentrata: guasto del sistema master',
    'distributed I/O: master system failure',
  ],
  [
    0x39b1,
    "errore di periferia nell'aggiornamento dell'immagine degli ingressi",
    'I/O error while updating the input image',
  ],
  [
    0x39b2,
    "errore di periferia nel trasferimento dell'immagine delle uscite",
    'I/O error while transferring the output image',
  ],
  [0x4300, 'rete inserita con memoria tamponata', 'power on with backup memory'],
  [0x4301, 'passaggio da STOP ad AVVIAMENTO', 'transition from STOP to STARTUP'],
  [0x4302, 'passaggio da AVVIAMENTO a RUN', 'transition from STARTUP to RUN'],
  [0x4303, 'STOP dal selettore dei modi', 'STOP from the mode selector'],
  [0x4304, 'STOP dal PG o da SFB 20', 'STOP from the PG or SFB 20'],
  [0x4305, 'HOLD: raggiunto un breakpoint', 'HOLD: breakpoint reached'],
  [0x4306, 'HOLD: uscita dal breakpoint', 'HOLD: breakpoint exited'],
  [0x4307, 'cancellazione totale avviata dal PG', 'memory reset started by the PG'],
  [0x4308, 'cancellazione totale avviata dal selettore', 'memory reset started by the selector'],
  [
    0x4309,
    'cancellazione totale automatica (rete inserita senza tampone)',
    'automatic memory reset (power on without backup)',
  ],
  [0x430a, 'uscita da HOLD con passaggio a STOP', 'exit from HOLD to STOP'],
  [0x430e, 'cancellazione totale eseguita', 'memory reset completed'],
  [0x43b0, 'aggiornamento del firmware riuscito', 'firmware update successful'],
  [0x4520, 'DIFETTO: STOP impossibile', 'DEFECTIVE: STOP not possible'],
  [
    0x4530,
    'DIFETTO: errore nel test della memoria interna',
    'DEFECTIVE: internal memory test error',
  ],
  [0x4543, 'STOP causato dalle funzioni di test', 'STOP caused by test functions'],
  [0x4545, 'STOP causato dal sistema di comunicazione', 'STOP caused by the communication system'],
  [
    0x4555,
    'riavvio impossibile: scaduto il tempo di sorveglianza',
    'restart not possible: monitoring time expired',
  ],
  [
    0x4556,
    'STOP: il sistema chiede la cancellazione totale (dati incoerenti)',
    'STOP: the system requests a memory reset (inconsistent data)',
  ],
  [
    0x4562,
    'STOP per errore di programmazione (OB121 assente)',
    'STOP on programming error (OB121 missing)',
  ],
  [
    0x4563,
    'STOP per errore di accesso alla periferia (OB122 assente)',
    'STOP on I/O access error (OB122 missing)',
  ],
  [0x4568, 'STOP per errore di tempo (OB80 assente)', 'STOP on time error (OB80 missing)'],
  [
    0x456a,
    'STOP per interrupt di diagnostica (OB82 assente)',
    'STOP on diagnostic interrupt (OB82 missing)',
  ],
  [
    0x456b,
    'STOP per estrazione/inserimento di un modulo (OB83 assente)',
    'STOP on module removal/insertion (OB83 missing)',
  ],
  [
    0x456c,
    'STOP per errore hardware della CPU (OB84 assente)',
    'STOP on CPU hardware error (OB84 missing)',
  ],
  [
    0x456d,
    'STOP per errore di esecuzione del programma (OB85 assente)',
    'STOP on program execution error (OB85 missing)',
  ],
  [
    0x456e,
    'STOP per errore di comunicazione (OB87 assente)',
    'STOP on communication error (OB87 missing)',
  ],
  [0x456f, 'STOP per guasto del rack (OB86 assente)', 'STOP on rack failure (OB86 missing)'],
  [0x4571, 'STOP per errore nello stack delle parentesi', 'STOP on parenthesis stack error'],
  [0x4575, 'STOP per stack dei blocchi troppo profondo', 'STOP: block stack too deep'],
  [
    0x4576,
    "STOP per errore nell'allocazione dei dati locali",
    'STOP on local data allocation error',
  ],
  [0x4578, 'STOP per codice operativo sconosciuto', 'STOP on unknown operation code'],
  [0x457a, 'STOP per lunghezza del codice errata', 'STOP on wrong code length'],
  [0x457f, 'STOP per comando di STOP (istruzione STP)', 'STOP on STOP command (STP instruction)'],
  [
    0x4580,
    'STOP: contenuto del buffer di backup incoerente',
    'STOP: backup buffer contents inconsistent',
  ],
  [
    0x4926,
    'DIFETTO: guasto della sorveglianza degli accessi in periferia',
    'DEFECTIVE: I/O access monitoring failure',
  ],
  [
    0x4931,
    'STOP o DIFETTO: errore nel test della memoria del modulo di memoria',
    'STOP or DEFECTIVE: memory module test error',
  ],
  [0x4933, 'errore di checksum', 'checksum error'],
  [0x4934, 'DIFETTO: memoria non disponibile', 'DEFECTIVE: memory not available'],
  [0x494d, 'STOP per errore di periferia', 'STOP on I/O error'],
  [0x494e, 'STOP per mancanza di rete', 'STOP on power failure'],
  [0x494f, 'STOP per errore di configurazione', 'STOP on configuration error'],
  [0x4959, 'uno o più moduli non pronti', 'one or more modules not ready'],
  [
    0x49a0,
    'STOP per errore di parametrizzazione o configurazione reale ≠ prevista: avviamento bloccato',
    'STOP on parameterization error or actual configuration different from expected: startup blocked',
  ],
  [0x49a4, 'STOP: dati di configurazione incoerenti', 'STOP: inconsistent configuration data'],
  [0x530d, 'nuove informazioni di avviamento in STOP', 'new startup information in STOP'],
  [0x5311, 'avviamento nonostante un modulo non pronto', 'startup despite a module not ready'],
  [0x5961, 'errore di parametrizzazione', 'parameterization error'],
  [
    0x6390,
    'formattazione della Micro Memory Card completata',
    'Micro Memory Card formatting completed',
  ],
  [0x6500, 'id di collegamento doppio sul modulo', 'duplicate connection id on the module'],
  [0x6501, 'risorse di collegamento insufficienti', 'insufficient connection resources'],
  [0x6502, 'errore nella descrizione del collegamento', 'error in the connection description'],
  [
    0x6523,
    'richiesta di cancellazione totale: errore di accesso al modulo di memoria',
    'memory reset request: memory module access error',
  ],
  [
    0x6524,
    "richiesta di cancellazione totale: errore nell'intestazione di un blocco",
    'memory reset request: error in a block header',
  ],
  [
    0x6526,
    'richiesta di cancellazione totale: memoria sostituita',
    'memory reset request: memory replaced',
  ],
  [
    0x6528,
    'gestione oggetti in STOP/HOLD: riavvio impossibile',
    'object management in STOP/HOLD: restart not possible',
  ],
  [
    0x6529,
    'avviamento impossibile durante il caricamento del programma',
    'startup not possible while loading the program',
  ],
  [
    0x6548,
    'errore di plausibilità nel controllo di un blocco',
    'plausibility error checking a block',
  ],
  [0x6549, 'errore di struttura in un blocco', 'structure error in a block'],
  [0x6981, 'errore di interfaccia (entrante)', 'interface error (incoming)'],
  [0x6881, 'errore di interfaccia (uscente)', 'interface error (outgoing)'],
  [0x8000, 'guasto o ripristino del modulo', 'module fault or recovery'],
  [0x8001, 'errore interno del modulo', 'module internal error'],
  [0x8002, 'errore esterno', 'external error'],
  [0x8003, 'errore di canale', 'channel error'],
  [0x8004, 'tensione ausiliaria esterna mancante', 'external auxiliary voltage missing'],
  [0x8005, 'connettore frontale mancante', 'front connector missing'],
  [0x8006, 'modulo non parametrizzato', 'module not parameterized'],
  [0x8007, 'parametri errati', 'wrong parameters'],
];

/** Un ID per voce (proto §7.6.3). */
export const EVENTS: ReadonlyMap<number, Text> = new Map(
  TABLE.map(([id, it, en]) => [id, { it, en }] as const),
);

export type EventSource = 'exact' | 'flipped' | 'masked' | 'user' | 'generic';

const hex4 = (id: number): string => `0x${id.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Testo di un event ID, con la regola di proto §7.6.2 nell'ordine: ID esatto; classi 1-7 con il
 * verso invertito (bit 8) più "(entrante)"/"(uscente)"; classi 8 e 9 con la maschera 0xF0FF;
 * classi A/B "evento utente"; altrimenti un testo generico con classe, numero, verso e, se i
 * bit 10/11 sono a 1, "errore interno/esterno".
 */
export function describeEvent(
  id: number,
  lang: 'it' | 'en',
): { text: string; source: EventSource } {
  const exact = EVENTS.get(id);
  if (exact) return { text: exact[lang], source: 'exact' };
  const e = decodeEventId(id);
  if (e.cls >= 1 && e.cls <= 7) {
    const other = EVENTS.get(id ^ 0x100);
    if (other) {
      const dir =
        lang === 'it'
          ? e.incoming
            ? 'entrante'
            : 'uscente'
          : e.incoming
            ? 'incoming'
            : 'outgoing';
      return { text: `${other[lang]} (${dir})`, source: 'flipped' };
    }
  }
  if (e.cls === 8 || e.cls === 9) {
    const masked = EVENTS.get(id & 0xf0ff);
    if (masked) return { text: masked[lang], source: 'masked' };
  }
  if (e.cls === 0xa || e.cls === 0xb) {
    return {
      text: lang === 'it' ? `evento utente ${hex4(id)}` : `user event ${hex4(id)}`,
      source: 'user',
    };
  }
  const cls = (EVENT_CLASSES[e.cls] ?? UNKNOWN_CLASS)[lang];
  const num = `0x${e.number.toString(16).toUpperCase().padStart(2, '0')}`;
  let text: string;
  if (lang === 'it') {
    text = `${cls}, evento ${num}, ${e.incoming ? 'entrante' : 'uscente'}`;
    if (e.internal && e.external) text += ', errore interno ed esterno';
    else if (e.internal) text += ', errore interno';
    else if (e.external) text += ', errore esterno';
  } else {
    text = `${cls}, event ${num}, ${e.incoming ? 'incoming' : 'outgoing'}`;
    if (e.internal && e.external) text += ', internal and external error';
    else if (e.internal) text += ', internal error';
    else if (e.external) text += ', external error';
  }
  return { text, source: 'generic' };
}
