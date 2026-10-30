# HMI di base

Guida breve alle schermate HMI (1.9, tappa 8 ridotta): un editor di schermate con pulsanti, lampade e valori legati alle variabili di un PLC, e un runtime sul PC che parla con la CPU (S7comm) o con il simulatore. Non è WinCC: niente allarmi, ricette, curve, script, utenti né caricamento su pannelli (vedi `docs/limiti-noti.md`).

## Dove sono

Nell'albero del progetto, sotto ogni PLC, la cartella **Schermate HMI**: _Aggiungi nuova schermata_ crea una schermata (800 × 480) e la apre. Rinomina (F2), elimina (Canc), seleziona e annulla funzionano come per le tabelle di controllo. Le schermate di un PLC usano solo le variabili di quel PLC e si salvano nel `.baap`, nel file del dispositivo.

## Editor «Schermata HMI»

- **Oggetti** (barra in alto): _Testo_, _Campo di I/O_, _Pulsante_, _Lampada_, _Barra_, _Cambia schermata_. Un clic aggiunge l'oggetto in alto a sinistra; trascinandolo sulla schermata si mette dove si rilascia.
- **Selezione:** clic su un oggetto; Maiusc o Ctrl+clic ne aggiunge altri; clic sullo sfondo o Esc toglie la selezione; Ctrl+A seleziona tutto.
- **Spostare e ridimensionare:** trascinare l'oggetto, o la maniglia in basso a destra. Le posizioni si agganciano alla griglia di 10 px (con Alt premuto no). Da tastiera, con la schermata attiva: frecce = sposta di 10 px, Alt+frecce = 1 px, Maiusc+frecce = ridimensiona.
- **Copia, taglia, incolla, elimina** dal menu _Modifica_ o con le scorciatoie solite; l'incolla mette le copie 10 px più in basso a destra. Ogni gesto è un passo di annulla (Ctrl+Z).
- **Proprietà** (a destra): senza selezione quelle della schermata (dimensioni 800 × 480, 1024 × 600 o 1280 × 800, oppure larghezza e altezza a mano; colore di sfondo); con un oggetto selezionato quelle dell'oggetto.

### Variabili

Il campo _Variabile_ accetta ciò che accetta una tabella di controllo: un simbolo (`"Motore"`), un indirizzo assoluto (`M 0.1`, `%MW10`, `Q 4.0`) o un membro di DB (`"Dati".Velocita`, `DB1.DBW 0`). Il completamento propone i simboli e i membri dei DB come nell'editor AWL. Sotto il campo compare il motivo se la variabile non va bene: simbolo sconosciuto, serve un bit (lampade e pulsanti, salvo _Scrivi valore_), formato diverso dalla dimensione (campo di I/O), variabile non numerica (barra), area non scrivibile (pulsanti e campi di immissione: solo I, Q, M e DB). Gli stessi avvisi escono nei controlli del progetto. Rinominando un simbolo o un membro, le variabili degli oggetti si aggiornano.

### Oggetti

| Oggetto          | Proprietà                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Testo            | Testo fisso.                                                                                                                                                                                                                                                                                                                   |
| Campo di I/O     | Variabile, formato (INT su una parola, DINT e REAL su una doppia parola, HEX su byte, parola o doppia parola, BOOL su un bit). Con _Immissione_ il valore si scrive premendo Invio.                                                                                                                                            |
| Pulsante         | Variabile e azione alla pressione: _Imposta bit_ (1), _Resetta bit_ (0), _Commuta bit_ (l'opposto dell'ultimo valore letto), _Scrivi valore_ (il valore scritto nelle proprietà, nel formato del tipo della variabile: `100`, `1.5`, `16#FF`), _Impulso_ (1 alla pressione, 0 al rilascio). Si preme anche con Spazio o Invio. |
| Lampada          | Variabile a bit, testo, colore acceso e spento.                                                                                                                                                                                                                                                                                |
| Barra            | Variabile numerica, minimo e massimo. Verticale se l'oggetto è più alto che largo, altrimenti orizzontale.                                                                                                                                                                                                                     |
| Cambia schermata | Testo e schermata da aprire (dello stesso PLC).                                                                                                                                                                                                                                                                                |

## Runtime

_Avvia runtime HMI_ (barra dell'editor) apre la schermata a tutta finestra, dentro la finestra di BaaPortal; _Chiudi runtime_ o Esc la chiudono. Il pulsante è attivo solo se la simulazione di quel PLC è accesa, oppure se si è online con quel PLC.

- **Letture:** un solo giro di lettura per le variabili della schermata mostrata, ciascuna una volta. Online è lo stesso giro delle tabelle di controllo (una richiesta alla volta, ogni 500 ms, al più 200 voci in tutto fra runtime e tabelle aperte; le voci in più danno un errore sull'oggetto); sul simulatore una lettura ogni 200 ms. Un valore che non si legge mostra `#####` (il motivo nel suggerimento). Se il collegamento o la simulazione si fermano, la barra del runtime lo dice e le letture non ripartono da sole.
- **Scritture:** una alla volta, nell'ordine dei gesti (il rilascio di un pulsante a impulsi non sorpassa la pressione). Un errore compare nella barra del runtime. Chiudendo il runtime con un pulsante a impulsi ancora premuto si scrive prima lo 0.

### Sicurezza delle scritture sul PLC reale

Le scritture del runtime seguono le regole delle tabelle di controllo, con una differenza: _Comanda_ chiede una conferma a ogni scrittura, che per un pannello non va bene. Quindi:

1. **Il runtime online parte in sola lettura.** Pulsanti e campi di immissione sono disattivati e non mandano nulla.
2. Per scrivere si spunta **Consenti scritture nella CPU** prima di avviarlo. All'avvio il processo principale mostra **una** finestra di conferma nativa: «Il runtime HMI può scrivere nella CPU …: consentire?». Annullando, il runtime non parte.
3. Dopo il sì, le scritture di quella finestra passano senza altre conferme **finché il runtime resta aperto e il collegamento online è lo stesso**. Chiudendo il runtime il permesso si revoca; scollegandosi o ricollegandosi non vale più (il processo principale rifiuta e il runtime va riavviato).
4. Ogni scrittura passa dal processo principale come _Comanda_: stessi controlli (solo I, Q, M e DB; dati della lunghezza giusta; bit 0 o 1), stessa CPU verificata (numero d'ordinazione e di serie), su un collegamento `online-write` separato aperto e chiuso per ogni scrittura. Il collegamento di sola lettura della finestra e il suo filtro dei frame non si toccano mai. Il renderer non può scrivere senza il permesso: lo tiene il processo principale, non l'interfaccia.

Sul simulatore pulsanti e campi scrivono subito, come _Comanda_ nelle tabelle di controllo sul simulatore.

**Attenzione:** se il collegamento cade mentre un pulsante a impulsi è premuto, lo 0 del rilascio non arriva e il bit resta a 1. Il programma del PLC deve proteggersi da sé (consenso, tempo massimo), come con qualunque pannello.

### Perché dentro la finestra e non in una finestra separata

Il runtime usa lo stesso renderer dell'editor: lo stesso simulatore (che gira in un worker di quella finestra), lo stesso giro di letture condiviso con le tabelle di controllo e lo stesso permesso di scrittura legato alla finestra. Una finestra Electron separata avrebbe richiesto un secondo collegamento al simulatore e nuovi canali IPC privilegiati; così non si aggiunge nessuna superficie nuova oltre ai tre canali del permesso (`plc:hmiArm`, `plc:hmiDisarm`, `plc:hmiWrite`).
