/**
 * Testi delle finestre native del processo principale (conferme di scrittura) nella lingua
 * dell'app. La chiave è il testo italiano, con i segnaposto `{nome}`; senza traduzione resta
 * l'italiano. La lingua la manda il renderer (`app:set-language`) a ogni cambio.
 */
export type DialogLang = 'it' | 'en';

let lang: DialogLang = 'it';

export function setDialogLang(l: unknown): void {
  if (l === 'it' || l === 'en') lang = l;
}

/** Testo inglese per ogni testo italiano (chiave); esportato per il controllo dei segnaposto. */
export const EN: Record<string, string> = {
  Annulla: 'Cancel',
  Interrompi: 'Interrupt',
  'Caricamento in corso': 'Download in progress',
  'Carica nel dispositivo': 'Download to device',
  'Caricare nella CPU {cpu}?': 'Download to the CPU {cpu}?',
  'Operazione: Carica nel dispositivo': 'Operation: Download to device',
  Carica: 'Download',
  'Avvia la CPU': 'Start the CPU',
  'Avvia (RUN)': 'Start (RUN)',
  'Portare la CPU in RUN': 'Put the CPU in RUN',
  'Ferma la CPU': 'Stop the CPU',
  'Ferma (STOP)': 'Stop (STOP)',
  'Portare la CPU in STOP': 'Put the CPU in STOP',
  'Copia RAM in ROM': 'Copy RAM to ROM',
  'Comprimi la memoria': 'Compress memory',
  Comprimi: 'Compress',
  'Comprimere la memoria': 'Compress the memory',
  '{what} della CPU {cpu}?': '{what} of the CPU {cpu}?',
  'Operazione: {op}': 'Operation: {op}',
  'Imposta ora': 'Set time',
  "Impostare l'ora della CPU {cpu}?": 'Set the time of the CPU {cpu}?',
  "Gli interrupt dall'orologio (OB10) possono saltare":
    'Time-of-day interrupts (OB10) may be skipped',
  'Ora del PC al momento della conferma (adesso: {time})': 'PC time at confirmation (now: {time})',
  'Ora del PC in UTC al momento della conferma (adesso: {time})':
    'PC time in UTC at confirmation (now: {time})',
  'Nuova ora: {time}': 'New time: {time}',
  'Comanda variabili': 'Modify variables',
  'Scrivere {n} valori nella CPU {cpu}?': 'Write {n} values to the CPU {cpu}?',
  'Scrivere 1 valore nella CPU {cpu}?': 'Write 1 value to the CPU {cpu}?',
  'Operazione: Comanda variabili': 'Operation: Modify variables',
  Comanda: 'Modify',
  'Runtime HMI': 'HMI runtime',
  'Il runtime HMI può scrivere nella CPU {cpu}: consentire?':
    'The HMI runtime can write to the CPU {cpu}: allow?',
  'Consenti scritture': 'Allow writes',
  'Ripristina backup (sperimentale)': 'Restore backup (experimental)',
  'Ripristinare il backup nella CPU {cpu}?': 'Restore the backup to the CPU {cpu}?',
  'Portare la CPU in STOP?': 'Put the CPU in STOP?',
  'Il ripristino degli SDB si fa solo con la CPU in STOP.':
    'SDBs can only be restored with the CPU in STOP.',
  'Porta in STOP': 'Put in STOP',
  'Il ripristino è finito. La CPU è in STOP.': 'The restore is finished. The CPU is in STOP.',
  Avvia: 'Start',
  'Copiare la memoria di caricamento RAM nella ROM': 'Copy the RAM load memory to ROM',
  'Avviare la CPU (avviamento a caldo)?': 'Start the CPU (warm restart)?', // dettagli lunghi ed errori mostrati all'utente
  'Tipo di blocco non ammesso per il caricamento: {block} (solo OB, FB, FC, DB)':
    'Block type not allowed for download: {block} (only OB, FB, FC, DB)',
  'File di blocco non valido: {why}': 'Invalid block file: {why}',
  'Nessun blocco da caricare': 'No blocks to download',
  'Cancella {block}': 'Delete {block}',
  'Carica {block}': 'Download {block}',
  'Comando non valido': 'Invalid command',
  'Operazione interrotta': 'Operation interrupted',
  "L'ora del PC non è impostabile: {why}": 'The PC time cannot be set: {why}',
  'Le scritture partono in più richieste (fino a {n}): se una fallisce, quelle precedenti restano scritte.':
    'The writes go out in several requests (up to {n}): if one fails, the previous ones stay written.',
  'Nessun collegamento online': 'No online connection',
  'Finestra chiusa': 'Window closed',
  'Collegamento online cambiato: operazione annullata':
    'Online connection changed: operation cancelled',
  'Pulsanti e campi di immissione delle schermate scriveranno subito nella CPU (aree I, Q, M e DB), senza altre conferme, finché il runtime resta aperto e il collegamento online non cambia.\nUn pulsante a impulsi scrive 0 al rilascio e alla chiusura del runtime: se il PC o la rete cadono mentre è premuto, il bit resta a 1. Non usarli per movimenti pericolosi.':
    'Buttons and input fields on the screens will write to the CPU immediately (areas I, Q, M and DB), with no further confirmation, as long as the runtime stays open and the online connection does not change.\nA jog button writes 0 on release and when the runtime closes: if the PC or the network fails while it is pressed, the bit stays at 1. Do not use them for dangerous movements.',
  'Scritture HMI non consentite: riavviare il runtime in scrittura':
    'HMI writes not allowed: restart the runtime in write mode',
  'Pulsante a impulsi senza un bit': 'Jog button without a bit',
  'Runtime HMI chiuso: non scritto': 'HMI runtime closed: not written',
  'Non scritto: scrittura interrotta dopo un errore': 'Not written: writing stopped after an error',
  "Uscita dall'app: non scritto": 'Quitting the app: not written',
  'Finestra chiusa: non scritto': 'Window closed: not written',
  'Rifiutato dalla CPU: {why}': 'Rejected by the CPU: {why}',
  'Ripristino non disponibile': 'Restore not available',
  'File di backup troppo grande': 'Backup file too large',
  'Stato del forzamento non leggibile dalla CPU': 'Force state not readable from the CPU',
  'Il backup è di una CPU di tipo diverso ({backup}) da quella collegata ({cpu}): ripristino non possibile':
    'The backup is from a different CPU type ({backup}) than the connected one ({cpu}): restore not possible',
  'Piano di ripristino non valido o già usato: prepararlo di nuovo':
    'Restore plan invalid or already used: prepare it again',
  'Il collegamento online è cambiato dopo la preparazione: ripetere':
    'The online connection changed after the preparation: repeat',
  'Non caricato': 'Not downloaded',
  'La CPU è in HOLD (arresto su breakpoint): ripristino rifiutato':
    'The CPU is in HOLD (breakpoint stop): restore refused',
  'Elenco degli SDB della CPU non rileggibile. La CPU è rimasta in STOP, nulla è stato scritto':
    'The list of SDBs of the CPU could not be read again. The CPU stayed in STOP, nothing was written',
  'Gli SDB della CPU sono cambiati dopo la preparazione del ripristino: prepararlo di nuovo. La CPU è rimasta in STOP, nulla è stato scritto':
    'The SDBs of the CPU changed after the restore was prepared: prepare it again. The CPU stayed in STOP, nothing was written',
  'Avviamento inviato ma esito sconosciuto, lo stato della CPU non è noto ({why})':
    'Start sent but outcome unknown, the CPU state is not known ({why})',
  'Esito sconosciuto': 'Outcome unknown',
  '{why} prima di {block}': '{why} before {block}',
  Interrotto: 'Interrupted',
  Cancellato: 'Deleted',
  Caricato: 'Downloaded',
  'Esito sconosciuto: il blocco non risulta nella CPU':
    'Outcome unknown: the block is not in the CPU',
  'Chiusura in corso': 'Closing',
  'Operazione già in corso': 'Operation already in progress',
  'Operazione già in corso su questa CPU': 'Operation already in progress on this CPU',
  'La CPU raggiunta non è quella confermata (numero di ordinazione o di serie diverso): operazione annullata':
    'The CPU reached is not the confirmed one (different order or serial number): operation cancelled',
  'Verifica della CPU non riuscita: {why}': 'CPU check failed: {why}',
  '{why}: interrotto prima di {block}': '{why}: interrupted before {block}',
  "Uscita dall'app": 'Quitting the app',
  'FUNZIONE SPERIMENTALE, mai provata su una CPU reale. La CPU andrà in STOP.':
    'EXPERIMENTAL FUNCTION, never tried on a real CPU. The CPU will go to STOP.',
  "Una funzione di test attiva impedisce l'assegnazione dei parametri (job di test sulla CPU). Chiudere osservazioni e forzamenti in TIA o STEP 7 e riprovare":
    'An active test function prevents parameter assignment (test job on the CPU). Close monitoring and forcing in TIA or STEP 7 and try again',
  '{why}. La CPU è rimasta in STOP, nulla è stato scritto':
    '{why}. The CPU stayed in STOP, nothing was written',
  'Rifiutato da BaaPortal (frame non ammesso)': 'Refused by BaaPortal (frame not allowed)',
  'La protezione della CPU (livello 2 o 3) non permette la scrittura e BaaPortal non gestisce le password: ripristino rifiutato':
    'The CPU protection (level 2 or 3) does not allow writing and BaaPortal does not handle passwords: restore refused',
  'Livello di protezione della CPU non leggibile: ripristino rifiutato':
    'CPU protection level not readable: restore refused',
  'Forzamento attivo sulla CPU: terminarlo con TIA o STEP 7 prima del ripristino':
    'Forcing active on the CPU: end it with TIA or STEP 7 before the restore',
  'Stato del forzamento non leggibile dalla CPU: ripristino rifiutato':
    'Force state not readable from the CPU: restore refused',
  'Esito sconosciuto: la CPU potrebbe averlo scritto':
    'Outcome unknown: the CPU may have written it',
  'Un caricamento nella CPU è in corso. Interromperlo? La CPU può restare con un programma incompleto.':
    'A download to the CPU is in progress. Interrupt it? The CPU may be left with an incomplete program.',
  'Finestra non disponibile per la conferma': 'Window not available for the confirmation',
  'La CPU ha rifiutato il collegamento (rack/slot o TSAP)':
    'The CPU refused the connection (rack/slot or TSAP)',
  'Nessuna risposta da {where}': 'No response from {where}',
  'Collegamento non riuscito: {why}': 'Connection failed: {why}',
  'Collegamento annullato': 'Connection cancelled',
  'Lettura troppo lunga: oltre {s} s': 'Read too long: over {s} s',
  'nessuna risposta dalla CPU': 'no response from the CPU',
  'Un backup è già in corso': 'A backup is already in progress',
  'Collegamento online finito: backup interrotto': 'Online connection ended: backup interrupted',
  'Nessun blocco copiato: {why}': 'No block copied: {why}',
  'Nessun blocco copiato: la CPU non ne ha elencati': 'No block copied: the CPU listed none',
  'Scrittura del file non riuscita: {why}': 'Writing the file failed: {why}',
  'Un caricamento è già in corso': 'An upload is already in progress',
  'Troppi blocchi nella CPU (oltre {n}): caricamento non eseguito':
    'Too many blocks in the CPU (over {n}): upload not done',
  'Troppi dati dalla CPU (oltre {n} MB): caricamento non eseguito':
    'Too much data from the CPU (over {n} MB): upload not done',
  'Osservazione annullata': 'Monitoring cancelled',
  'Ripristino in corso su questa CPU': 'Restore in progress on this CPU',
  "Osservazione già attiva su questa CPU in un'altra finestra":
    'Monitoring already active on this CPU in another window',
  'Nessuna osservazione attiva': 'No active monitoring',
  'La finestra riguarda un altro blocco': 'The window refers to another block',
  'Operando non valido': 'Invalid operand',
  'La CPU ha risposto con un numero di valori inatteso':
    'The CPU answered with an unexpected number of values',
  'Valore di lunghezza inattesa': 'Value of unexpected length',
  'Porta MPI occupata da un’altra operazione (scrittura, osservazione, caricamento): riprovare al termine':
    'MPI port busy with another operation (write, monitoring, upload): try again when it ends',
  'Interfaccia di rete non disponibile': 'Network interface not available',
  'Tipo di collegamento non valido': 'Invalid connection type',
  'Indirizzo non valido': 'Invalid address',
  'Tipo di blocco non valido': 'Invalid block type',
  'Numero di blocco non valido': 'Invalid block number',
};

/** Il testo nella lingua corrente, con i segnaposto sostituiti. */
export function tr(it: string, params: Record<string, string | number> = {}): string {
  const text = lang === 'en' ? (EN[it] ?? it) : it;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
