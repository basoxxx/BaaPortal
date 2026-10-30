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

## Vista di rete

Sottoreti, interfacce e periferia decentrata ET 200 (tappa 6B). Come il rack, si modificano e si salvano nel progetto ma **non si caricano nella CPU e non si leggono dalla CPU**: anche la configurazione di rete sta negli SDB.

1. **Aprirla.** Nell'albero del progetto, doppio clic su _Dispositivi e reti_. La vista mostra in alto le sottoreti come linee colorate (MPI viola, PROFIBUS lilla, Ethernet verde), sotto un riquadro per ogni PLC e per ogni stazione ET 200, e in fondo la _Panoramica dispositivi_.
2. **Sottoreti.** _Nuova sottorete MPI_, _PROFIBUS DP_ o _Industrial Ethernet_ ne crea una (MPI_1, PROFIBUS_1, Ethernet_1…). Un clic sulla linea ne mostra le proprietà: nome; per MPI e PROFIBUS velocità di trasmissione e indirizzo più alto (HSA, predefiniti 187,5 kbit/s e 31 per MPI, 1,5 Mbit/s e 126 per PROFIBUS); per Ethernet maschera di sottorete e router facoltativo. _Elimina sottorete_ scollega tutto ciò che vi era collegato.
3. **Interfacce.** Ogni PLC ha le interfacce della sua CPU: X1 MPI (CPU senza DP), X1 MPI e X2 DP (CPU DP), X1 MPI/DP e X2 PN (CPU PN/DP), più X3 PN sulle 319-3. Ogni CP 343-1 del rack aggiunge un'interfaccia Ethernet. L'X1 MPI/DP va su una sottorete MPI o PROFIBUS.
4. **Collegare.** Si trascina l'interfaccia sulla linea della sottorete, oppure la si seleziona e si sceglie la sottorete nelle proprietà (accessibile da tastiera). Una sottorete di tipo diverso non accetta l'interfaccia. Collegando, l'interfaccia prende il primo indirizzo libero: da 2 per MPI e PROFIBUS, 192.168.0.1, .2… per Ethernet. Nelle proprietà si cambia l'indirizzo. Canc sull'interfaccia la scollega. Ogni modifica si annulla con Annulla.
5. **Stazioni ET 200.** Si sceglie la stazione (ET 200S IM151-1 Standard o ET 200M IM 153-1 su PROFIBUS DP, ET 200S IM151-3 PN su PROFINET IO), con più PLC anche la CPU, e _Inserisci stazione_. Se la CPU ha già un'interfaccia su una sottorete adatta, la stazione vi si collega con il primo indirizzo libero. Nelle proprietà: nome, sottorete, indirizzo PROFIBUS o indirizzo IP e nome del dispositivo PROFINET; _Elimina stazione_ la toglie con i suoi moduli.
6. **Moduli della stazione.** Doppio clic sul riquadro della stazione (o _Apri vista dispositivi_) apre la sua vista dispositivi: i posti della stazione (4–11 nella ET 200M, 1–63 nella ET 200S) e il catalogo dei moduli che accetta (SM S7-300 nella ET 200M, moduli elettronici 2DI/4DI/2DO/4DO nella ET 200S). Doppio clic, Invio o trascinamento inseriscono il modulo; prende il primo indirizzo I/Q libero della CPU, da 0 per i digitali e da 256 per gli analogici, e si cambia nelle proprietà. Questi indirizzi contano nei controlli di sovrapposizione del rack, negli avvisi «nessun modulo copre l'indirizzo» e nell'elenco di assegnazione come quelli dei moduli centrali. Doppio clic sul riquadro di un PLC apre la sua vista dispositivi.
7. **Controlli.** Nelle proprietà, in rosso sull'interfaccia e nella colonna _Problemi_ della panoramica: indirizzo doppio sulla sottorete o fuori campo (0–126, non oltre l'indirizzo più alto), IP non valido o doppio, maschera o router non validi, velocità non ammessa; come avvisi l'interfaccia non collegata e la stazione la cui CPU non è sulla sua sottorete.
8. **Panoramica dispositivi.** Una riga per interfaccia di tutto il progetto: dispositivo, interfaccia, tipo, sottorete, indirizzo e problemi. Un clic sull'interfaccia la seleziona.
9. **Collegarsi online.** In _Dispositivi accessibili_, se la CPU scelta ha un indirizzo IP (o, con l'adattatore MPI, un indirizzo MPI) nella vista di rete, _Usa l'indirizzo configurato_ lo mette nella finestra. La configurazione resta solo nel progetto.
10. **File GSD.** Non si importano: il catalogo ET 200 è scritto a mano da manuali pubblici (vedi `docs/limiti-noti.md`).
