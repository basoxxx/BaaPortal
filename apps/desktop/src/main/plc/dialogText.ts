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

const EN: Record<string, string> = {
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
  'Avviare la CPU (avviamento a caldo)?': 'Start the CPU (warm restart)?',
};

/** Il testo nella lingua corrente, con i segnaposto sostituiti. */
export function tr(it: string, params: Record<string, string | number> = {}): string {
  const text = lang === 'en' ? (EN[it] ?? it) : it;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
