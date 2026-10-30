# Vista dispositivi

Guida breve alla configurazione hardware del rack S7-300 (tappa 6A): quali moduli ci sono, in quale posto e con quali indirizzi. La configurazione si modifica e si salva nel progetto, ma **non si carica nella CPU** (vedi in fondo).

1. **Aprirla.** Nell'albero del progetto, doppio clic su _Configurazione dispositivi_ sotto il PLC. La scheda _Vista dispositivi_ ha il rack, la panoramica, le proprietà del modulo scelto e il catalogo hardware.
2. **Il rack.** Undici posti, come in STEP 7 e TIA Portal:
   - posto 1: alimentatore (PS 307);
   - posto 2: la CPU del PLC, fissa nel rack 0 (si cambia dalle proprietà del PLC, non qui);
   - posto 3: modulo di interfaccia (IM 360 o IM 365 nel rack 0, IM 361 o IM 365 nei rack di ampliamento);
   - posti 4–11: moduli di ingressi e uscite (SM), CP e FM.
   - In alto si sceglie il rack: 0 con la CPU, da 1 a 3 per gli ampliamenti. Un rack di ampliamento funziona solo con la IM 360 nel posto 3 del rack 0 e una IM 361 nel posto 3 del rack; con la coppia IM 365 c'è un solo rack di ampliamento (il rack 1).
3. **Inserire un modulo.** Nel catalogo si cerca per nome, numero d'articolo o descrizione, oppure si sceglie una famiglia. Doppio clic (o Invio) inserisce il modulo nel primo posto libero adatto del rack mostrato; si può anche trascinarlo su un posto. Un posto non adatto o occupato non accetta il modulo e compare un avviso.
4. **Spostare e cancellare.** Si trascina il modulo su un altro posto, oppure lo si seleziona e si usa Ctrl+freccia (Cmd+freccia su macOS). Canc o _Cancella modulo_ lo toglie. Ogni modifica si annulla e si ripristina con Annulla e Ripristina, come il resto del progetto.
5. **Indirizzi.** All'inserimento il modulo prende gli indirizzi fissi del posto:
   - digitali: byte 32 × rack + 4 × (posto − 4), cioè 0, 4, 8… nel rack 0;
   - analogici, CP e FM: 256 + 128 × rack + 16 × (posto − 4), cioè 256, 272, 288… nel rack 0.
   - Nelle proprietà si possono scrivere indirizzi iniziali diversi. Spostando un modulo, gli indirizzi fissi seguono il nuovo posto; quelli scritti a mano restano.
6. **Controlli.** Sono errori, segnati in rosso sul posto e nelle proprietà: un modulo in un posto non adatto, due moduli nello stesso posto, un rack di ampliamento senza le IM giuste, indirizzi che si sovrappongono a quelli di un altro modulo, indirizzi oltre i limiti di I e Q della CPU.
7. **Panoramica dispositivi.** Sotto il rack, una riga per modulo: rack, posto, nome, numero d'articolo, indirizzi I e Q, commento. Un clic sul nome seleziona il modulo.
8. **Con il programma.** Se il rack ha almeno un modulo di ingressi o uscite:
   - nella tabella delle variabili, un tag su I o Q (anche PI e PQ) che nessun modulo copre ha un avviso;
   - nell'elenco di assegnazione, i byte di I e Q senza modulo sono segnati «senza modulo».
   - Sono solo avvisi: la compilazione e il caricamento del programma non cambiano.
9. **Non si carica nella CPU.** Il pulsante _Carica configurazione hardware nel dispositivo_ è disattivato: la CPU riceve la configurazione hardware nei blocchi dati di sistema (SDB), il cui formato non è documentato. Per configurare l'hardware della CPU si usa ancora STEP 7 o TIA Portal. _Carica nel dispositivo_ carica solo i blocchi del programma, come prima, e lo ricorda con una nota quando il progetto ha una configurazione hardware.
