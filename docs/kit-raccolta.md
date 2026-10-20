# Raccolta dati da una CPU S7-300 (sola lettura)

Questa guida è per chi ci aiuta raccogliendo i dati di una CPU S7-300 vera. BaaPortal legge la
CPU e crea un file `.zip` da inviarci. Non serve installare altro (né Node né TIA Portal).

**La raccolta legge soltanto.** Non scrive nulla nel PLC, non cambia il programma, non avvia né
ferma la CPU (RUN/STOP), non scrive variabili e non cambia l'orologio. Il programma stesso rifiuta
qualunque richiesta che non sia di lettura, e nel riepilogo (`summary.json`, campo `refusedCount`)
si può verificare che le richieste rifiutate siano state 0.

## Passo per passo

1. **Scarica e installa BaaPortal.**
   Vai alla pagina _Releases_ del progetto su GitHub e scarica l'ultima versione per il tuo
   sistema (Windows o macOS), poi installala.
   - L'installatore **non è firmato**, quindi il sistema mostra un avviso:
     - Windows: _"Windows ha protetto il PC"_ (SmartScreen). Scegli **Ulteriori informazioni**,
       poi **Esegui comunque**.
     - macOS: _"non può essere aperta perché proviene da uno sviluppatore non identificato"_.
       Apri **Impostazioni di Sistema → Privacy e sicurezza** e scegli **Apri comunque**
       (oppure clic destro sull'app, **Apri**).
2. **Collega il PC alla rete della CPU.**
   Basta un cavo Ethernet verso la porta PROFINET della CPU (o verso lo switch a cui è collegata).
   Imposta sul PC un indirizzo della stessa rete della CPU (per esempio CPU `192.168.0.1` e PC
   `192.168.0.50`, maschera `255.255.255.0`). L'indirizzo IP della CPU lo trovi nel progetto
   TIA/STEP 7 oppure te lo dà chi gestisce l'impianto. Verifica che risponda al `ping`.
3. **Apri la finestra di raccolta.**
   Avvia BaaPortal e apri **Strumenti → Raccolta dati CPU (sola lettura)…**. Se non hai ancora
   un progetto aperto, la stessa funzione è nella schermata iniziale, tra le operazioni a sinistra
   (_Raccolta dati CPU (sola lettura)_).
4. **Inserisci l'indirizzo.**
   Scrivi l'**indirizzo IP** della CPU. Lascia **rack 0** e **slot 2**, a meno che la CPU sia
   raggiunta tramite un **CP 343-1** (Ethernet su scheda separata): in quel caso lo **slot** è
   quello del CP. Porta (102) e tipo di connessione (PG) di solito non vanno cambiati (sono sotto
   _Avanzate_). Lascia attiva la casella **Carica anche i blocchi dal PLC**: serve a noi per
   capire come è fatto il programma.
5. **Avvia e salva.**
   Premi **Avvia** e attendi: la finestra mostra la fase e quanto manca. Puoi premere
   **Interrompi** quando vuoi. Alla fine compare la finestra di salvataggio: scegli dove salvare
   il file `raccolta-<numero di articolo>-<data>.zip`. Se annulli il salvataggio non perdi nulla:
   finché la finestra resta aperta c'è il pulsante **Salva…**.
6. **Inviaci lo zip.**
   Mandaci il file `.zip` (per email o con il servizio che preferisci).

## Che cosa contiene lo zip

- `LEGGIMI.txt`: breve spiegazione.
- `summary.json`: riepilogo (identità della CPU, modo di funzionamento, conteggi, avvisi ed
  errori, `refusedCount`).
- `capture.jsonl`: il registro completo di tutto ciò che è stato scambiato con la CPU.
- `szl/`: le liste di stato di sistema lette dalla CPU.
- `blockinfo/`: le informazioni di ciascun blocco.
- `blocchi/`: i blocchi del programma, esattamente come la CPU li ha consegnati (solo se hai
  lasciato attiva la casella _Carica anche i blocchi dal PLC_).

**Attenzione: se c'è la cartella `blocchi/`, lo zip contiene il programma del tuo PLC**, cioè il
codice e i dati del tuo impianto. Mandalo solo a chi ti fidi. Se non vuoi condividere il
programma, togli la spunta dalla casella dei blocchi: la raccolta sarà più rapida e conterrà solo
i dati di sistema.

## Quando farla

Esegui la raccolta **a macchina ferma o in un momento non critico**. Anche se non scrive nulla,
la CPU deve rispondere alle richieste e il caricamento dei blocchi le dà un po' di lavoro in più.

## Quanto dura

Qualche minuto in genere (di solito 2-10 minuti). Senza blocchi, molto meno. Con un programma
grande può arrivare a 20-30 minuti: il programma legge con calma, per non disturbare la CPU.

## Se qualcosa va storto

- Se la CPU non risponde, controlla l'indirizzo IP, il cavo e lo slot (CP 343-1).
- Se compaiono errori o interrompi la raccolta, **mandaci comunque lo zip**: contiene il registro
  di tutto ciò che è successo e ci permette di capire il problema. Se non si è salvato da solo,
  premi **Salva…**.
- Per qualunque dubbio scrivici prima di collegarti.
