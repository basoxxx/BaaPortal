# Aggiornamenti dell'app

Guida breve agli aggiornamenti automatici (piano 3U). Valgono solo per l'app installata, non in sviluppo.

1. **Quando controlla.** BaaPortal cerca una nuova versione circa 10 secondi dopo l'avvio e poi ogni 6 ore. Si può controllare a mano da _Guida → Controlla aggiornamenti…_ oppure, nel portale, da _Software installato_. L'impostazione _Controlla gli aggiornamenti all'avvio_ (_Opzioni → Impostazioni → Aggiornamenti_) spegne i controlli automatici.
2. **Versioni di prova e stabili.** Una build di prova riceve sia le versioni di prova sia le stabili; una build stabile solo le stabili. La casella _Ricevi anche le versioni di prova_ cambia la scelta; _Ripristina predefiniti_ torna a quella della build. Non si riceve mai una versione più vecchia di quella installata.
3. **Windows.** Compare un avviso con _Scarica_ e _Più tardi_ (e il link alle note di rilascio). Finito lo scaricamento, _Riavvia e aggiorna_ chiude l'app e installa; _Al prossimo avvio_ installa alla prossima chiusura normale. L'installazione non parte durante un lavoro sul PLC (carica nel dispositivo, scrittura, caricamento dal dispositivo, backup): finito quello, si riprova. Prima di installare BaaPortal chiede di salvare le modifiche e chiude il collegamento online.
4. **macOS.** _Scarica_ salva il file `.dmg` giusto per il tuo Mac nella cartella _Download_ e lo apre. Chiudi BaaPortal, trascina BaaPortal nella cartella _Applicazioni_ sostituendo quella vecchia, poi riaprilo. _Mostra nel Finder_ indica il file se non si è aperto da solo.
5. **Chi ha la 0.11.0 o una più vecchia** deve installare la 0.12.0 a mano una volta, dalla pagina delle release. Da lì in poi gli aggiornamenti arrivano da soli.
6. **Senza rete.** Se manca la rete o GitHub non risponde, il controllo automatico tace e riprova dopo 6 ore; quello a mano mostra il motivo.
