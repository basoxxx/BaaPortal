# BaaPortal — Documento di progetto

Data: 2026-10-18
Stato: approvato dall'utente (decisioni aperte delegate al progettista, §6)

## 1. Scopo e perché

La ditta programma PLC Siemens **S7-300**. Le licenze TIA Portal costano troppo, quindi serve un ambiente di programmazione proprio, **BaaPortal**, scritto da zero, che giri su **Windows e macOS**.

L'interfaccia deve ricalcare il più possibile quella di TIA Portal, così chi lo conosce già si ritrova subito: stessa organizzazione delle finestre, stessi nomi, stesso flusso di lavoro, stesse scorciatoie. Grafica, icone e codice sono però tutti nostri (vedi §4).

**Successo** vuol dire che la ditta fa in BaaPortal tutto il lavoro quotidiano che oggi farebbe con TIA Portal sugli S7-300:

- scrivere e modificare il programma (KOP, FUP, AWL, SCL);
- provarlo nel simulatore, senza PLC;
- caricarlo nel PLC vero e osservarlo online;
- recuperare i programmi già presenti sulle macchine.

## 2. Obiettivi

1. Ambiente completo di programmazione per CPU S7-300: progetto, variabili, blocchi, compilazione, simulazione, collegamento online.
2. Interfaccia che ricalca TIA Portal: Vista portale, Vista progetto e tutti i loro elementi (§8).
3. Linguaggi KOP, FUP, AWL e SCL, compilati in codice macchina MC7 che la CPU S7-300 accetta ed esegue.
4. Simulatore integrato, equivalente a PLCSIM.
5. Comunicazione con S7-300 reali via Ethernet: caricamento nel dispositivo e dal dispositivo, RUN/STOP, osservazione, tabelle di controllo, diagnostica.
6. Recupero dei programmi esistenti caricandoli dal PLC, più l'importazione di sorgenti e tabelle variabili esportate da altri strumenti.
7. Installatori per Windows (x64) e macOS (Apple Silicon e Intel).
8. Nessuna funzione TIA Portal pertinente all'S7-300 viene dimenticata: ognuna è assegnata a una tappa oppure esclusa esplicitamente con il motivo (Appendice A).

## 3. Non-obiettivi (per ora)

- **S7-1200 / S7-1500 / ET 200SP CPU**: il loro protocollo di caricamento è protetto da Siemens e non si può implementare senza aggirare quella protezione.
- **CPU di sicurezza (F-CPU, Safety)**: richiedono certificazione, fuori portata.
- **Aprire direttamente i progetti TIA Portal (.ap13…ap21)**: il formato è proprietario e leggerlo richiederebbe reverse engineering. Si importano invece le sorgenti e le tabelle che TIA Portal stesso esporta (§9, tappa 1 e 7).
- **WinCC / pannelli HMI**: è un progetto separato a sé (tappa 8), da affrontare dopo.
- **Azionamenti (Startdrive), Motion, Openness, Multiuser, Teamcenter, Energy Suite**: non servono per gli S7-300 della ditta.

## 4. Anti-obiettivi (cose che renderebbero il progetto un fallimento anche se "funziona")

- **Nessun reverse engineering, decompilazione o analisi dei programmi Siemens** (TIA Portal, STEP 7, PLCSIM, ecc.). Lo strumento REA non viene usato su software Siemens.
- **Nessun codice, icona, immagine, testo o file copiato da prodotti Siemens.** Il layout si ricalca guardando la documentazione pubblica e gli screenshot, ma ogni icona e ogni elemento grafico viene disegnato da zero.
- **Nessun marchio Siemens** nel nome, nel logo o nell'installatore di BaaPortal. Le parole "S7-300", "KOP", "AWL" ecc. si usano solo per indicare compatibilità.
- **Mai caricare nel PLC senza conferma esplicita**: la finestra di conferma mostra quali blocchi, su quale IP/CPU e in quale stato (RUN/STOP).
- **Mai dichiarare "compatibile" qualcosa che non è stato verificato** su CPU reale o con i test di andata e ritorno (§10).

## 5. Vincoli

### Legali (sviluppo "clean room")

Fonti ammesse:

- manuali Siemens **pubblici**: AWL/STL, KOP, FUP, SCL per S7-300/400, "Software di sistema per S7-300/400 – Funzioni standard e di sistema", manuali delle CPU 31x;
- documentazione online pubblica di TIA Portal (es. docs.tia.siemens.cloud), da usare **solo** per layout, nomi e comportamento dell'interfaccia;
- progetti open source come documentazione di protocollo e formati: snap7 (LGPL-3), libnodave, DotNetSiemensPLCToolBoxLibrary (LGPL-2.1), il dissector S7comm di Wireshark (GPL). **Non si copia codice da questi progetti** dentro BaaPortal: si leggono come documentazione e si scrive un'implementazione nostra in TypeScript;
- i blocchi caricati dai PLC della ditta e il traffico di rete tra BaaPortal e quei PLC. Analizzarli è lecito, perché serve all'interoperabilità con hardware di proprietà.

### Piattaforme

- Windows 10/11 x64; macOS 13+ (Apple Silicon e Intel).
- Linux viene "gratis" con la tecnologia scelta, ma non viene testato né garantito.

### Lingua

- Interfaccia in italiano, con i termini della versione italiana di TIA Portal.
- Tutti i testi in file di traduzione, così l'inglese si aggiunge senza toccare il codice.

### Sicurezza sulle macchine

- Ogni funzione che scrive nel PLC (caricamento, RUN/STOP, forzamento, scrittura variabili) viene provata prima su una **CPU S7-300 di prova** fornita dalla ditta, con collegamento Ethernet (CPU PN oppure CP 343-1). Mai prima su una macchina in produzione.
- Il simulatore è il primo banco di prova di ogni programma.

### Firma degli installatori

- Gli installatori iniziali **non sono firmati**: per uso interno basta autorizzarli al primo avvio (macOS 13–14: tasto destro → Apri; macOS 15+: Impostazioni di Sistema → Privacy e sicurezza → "Apri comunque", oppure `xattr -dr com.apple.quarantine /Applications/BaaPortal.app`; un dmg costruito in locale non è in quarantena; Windows: "Esegui comunque").
- La firma (Apple Developer ID, certificato Windows) si aggiunge se e quando la ditta vuole distribuirlo più largamente.

## 6. Decisioni prese

### Prese dall'utente

- BaaPortal è scritto **da zero**, per **Windows e macOS**.
- Interfaccia **simile a TIA Portal**.
- PLC di riferimento: **S7-300**.
- Linguaggi: **KOP, FUP, AWL, SCL**. GRAPH dopo.
- Deve saper **caricare dal PLC** i programmi già presenti sulle macchine.
- Collegamento al PLC **via Ethernet**.
- Lavoro **a tappe**, ognuna finita e collaudata prima della successiva.
- Caricamenti provati prima su una **CPU di prova**.

### Scelte del progettista (modificabili su richiesta)

- **Tecnologia**: Electron + TypeScript + React. Un solo programma per Windows e macOS, adatto a un'interfaccia complessa con pannelli.
- **Comunicazione S7 scritta in TypeScript puro**, senza librerie native: niente da ricompilare per ogni sistema operativo, pieno controllo su errori e tempi.
- **Catena di compilazione unica**: KOP, FUP e SCL si traducono in AWL, e l'AWL si traduce in MC7. È lo stesso schema degli strumenti Siemens classici, e AWL e MC7 si corrispondono quasi uno a uno.
- **Il simulatore esegue lo stesso MC7** che va nel PLC: ciò che si prova nel simulatore è esattamente ciò che si carica.
- **Formato di progetto proprio** (`.baap`): un file zip con dentro file di testo/JSON leggibili (sorgenti AWL/SCL, KOP/FUP in JSON, variabili, configurazione). Archivio di progetto: `.baapz`.
- **Banco di prova PLC dalla tappa 1**: il nucleo di `s7comm` (lettura/scrittura variabili, carica nel/dal dispositivo, RUN/STOP) si costruisce già nella tappa 1, come strumento interno di test senza interfaccia. Serve a collaudare il compilatore sulla CPU vera fin dall'inizio (§10). Nell'interfaccia arriva con la tappa 3.
- **Ricerca dei dispositivi**:
  - tappa 3: scansione della sottorete sulla porta 102 più inserimento manuale dell'IP, in TypeScript puro;
  - tappa 6: trovare CPU senza IP e assegnare nome/IP PROFINET (DCP) richiede una libreria nativa di rete (Npcap su Windows, BPF su macOS, con permessi di amministratore). È l'unica eccezione ammessa al "TypeScript puro".
- **Blocchi con protezione know-how trovati sulle macchine**: la protezione si rispetta. Si mostra solo l'interfaccia del blocco, il codice non viene decodificato né mostrato, e questi blocchi restano fuori dai test.
- **Programmi della ditta fuori dal repository**: i blocchi reali usati nei test restano sui computer della ditta e girano con un comando di test locale. GitHub Actions usa solo blocchi di prova scritti da noi.
- **Lettore di schede / memoria USB (scrittura delle Micro Memory Card)**: escluso, perché il formato della scheda non è documentato e serve un programmatore Siemens. Il programma si carica via rete.

### Decisioni sulle domande aperte (delegate al progettista dall'utente)

- **Collegamento alle CPU**:
  - si supportano dalla tappa 3 sia le CPU con Ethernet integrata (PN) sia quelle con CP 343-1;
  - sempre dalla tappa 3 si supportano gli **adattatori/gateway Ethernet-MPI/DP che parlano ISO-on-TCP (RFC 1006)**: per il client S7 cambiano solo i parametri di connessione (indirizzo MPI/DP di destinazione);
  - i gateway con protocollo proprietario vanno alla tappa 9;
  - gli adattatori USB-MPI con driver Siemens sono esclusi.
- **Catalogo CPU**: tutte le CPU S7-300 31x presenti nei manuali pubblici. Le funzioni che variano da CPU a CPU (forzamento, copia RAM→ROM, punti di arresto) si leggono dalla CPU collegata tramite SZL, non dal catalogo.
- **CPU di prova**:
  - consigliata una **CPU 315-2 PN/DP**, che ha sia Ethernet sia MPI/DP;
  - dalla tappa 3 si aggiunge al banco un CP 343-1, così si collaudano entrambe le vie Ethernet;
  - la CPU di prova serve **dalla tappa 1**, e la tappa 1 non si chiude senza i test di conformità su CPU reale (§10).
- **Sostituzione di CPU**: si assume che sia rara. Sugli S7-300 con Micro Memory Card basta spostare la scheda nella CPU nuova. Come rete di sicurezza, il _Backup online_ della tappa 3 copia anche i blocchi di sistema (SDB) così come sono e li sa ricaricare, senza bisogno di capirne il formato (da verificare sulla CPU di prova). Il caricamento di una configurazione hardware _nuova_ e l'assegnazione dell'IP a una CPU vuota restano alla tappa 6.
- **Compatibilità con gli strumenti Siemens**: i blocchi caricati con BaaPortal devono aprirsi correttamente in STEP 7 / TIA Portal, almeno in AWL e con l'interfaccia giusta. Per questo:
  - testata del blocco (linguaggio, autore, famiglia, nome, versione) e tabella delle reti rispettano le convenzioni viste nei blocchi della ditta;
  - il codice generato da KOP/FUP segue gli schemi che STEP 7 riconosce, ricavati dai manuali pubblici e dai blocchi caricati dai PLC della ditta, così si riapre in KOP/FUP;
  - se la ditta, o un cliente, ha una licenza Siemens regolare, la si usa solo normalmente: si aprono i blocchi caricati da BaaPortal e si controlla che si vedano bene. Il programma Siemens in sé non si analizza.

## 7. Architettura

### Processi

- **Processo principale (Electron main)**: file system, comunicazione con i PLC, finestre, menu nativi.
- **Interfaccia (renderer, React)**: tutto ciò che si vede.
- **Worker** separati per compilatore e simulatore, così l'interfaccia non si blocca mai.

### Moduli (monorepo, un pacchetto ciascuno, ciascuno testabile da solo)

| Modulo      | Compito                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`       | Shell Electron, finestre, menu, installatori                                                                                                                                                               |
| `ui`        | Interfaccia React: Vista portale, Vista progetto, editor, tabelle                                                                                                                                          |
| `project`   | Modello del progetto, salvataggio/apertura `.baap`, annulla/ripeti                                                                                                                                         |
| `s7-types`  | Tipi di dati S7 (BOOL…DT, STRING, ARRAY, STRUCT, UDT), aree e indirizzi (I, Q, M, DB, L, T, C, P)                                                                                                          |
| `awl`       | Parser, controllo semantico e risoluzione simboli dell'AWL                                                                                                                                                 |
| `scl`       | Parser e compilatore SCL → AWL                                                                                                                                                                             |
| `ladfbd`    | Modello di reti KOP/FUP, traduzione KOP/FUP ↔ AWL                                                                                                                                                          |
| `mc7`       | Codificatore AWL → MC7, decodificatore MC7 → AWL, formato del blocco (testata, interfaccia, codice, tabella reti)                                                                                          |
| `sim`       | Simulatore CPU S7-300: esecuzione MC7, ciclo OB, temporizzatori, contatori, immagini di processo, SFC/SFB principali                                                                                       |
| `s7comm`    | Client S7 su ISO-on-TCP (porta 102): connessione, lettura/scrittura variabili, SZL, elenco/informazioni blocchi, carica nel e dal dispositivo, cancellazione blocchi, RUN/STOP, ora, buffer di diagnostica |
| `catalog`   | Catalogo delle CPU e dei moduli S7-300 (dati tecnici da manuali pubblici)                                                                                                                                  |
| `importers` | Importazione/esportazione: sorgenti AWL/SCL, tabelle variabili (xlsx/csv), progetti STEP 7 V5.5 (.s7p)                                                                                                     |

### Flusso

```
editor (KOP/FUP/AWL/SCL) → AST → controllo (simboli, tipi, indirizzi)
   → AWL intermedio → MC7 + testata e interfaccia del blocco
   → simulatore   oppure   → PLC (s7comm)
PLC → carica dal dispositivo → MC7 → decodificatore → AWL (→ KOP/FUP quando rappresentabile)
```

## 8. Interfaccia

Riferimento: la struttura dell'interfaccia descritta nella documentazione pubblica di TIA Portal, in italiano. I nomi qui sotto sono quelli da usare.

### 8.1 Vista portale (all'avvio)

- **Portali** a sinistra: _Avvio_, _Dispositivi e reti_, _Programmazione PLC_, _Online e diagnostica_. _Visualizzazione_ compare con la tappa 8.
- **Operazioni del portale selezionato** al centro. Per _Avvio_: Apri progetto esistente, Crea nuovo progetto, Migra progetto (= importa), Chiudi progetto, Primi passi, Software installato, Guida, Lingua dell'interfaccia utente.
- **Finestra di selezione** a destra: il contenuto cambia con l'operazione scelta, per esempio l'elenco dei progetti recenti o il modulo di creazione di un progetto.
- **Link "Vista progetto"** in basso a sinistra.
- **Progetto aperto** in basso: nome e percorso.
- Aspetto: sfondo scuro sfumato con accento petrolio/turchese, come lo stile di TIA Portal, ma con grafica nostra.

### 8.2 Vista progetto (13 elementi, come TIA Portal)

1. **Barra del titolo**: nome del progetto.
2. **Barra dei menu**: Progetto, Modifica, Visualizza, Inserisci, Online, Opzioni, Strumenti, Finestra, Guida.
3. **Barra degli strumenti**: Nuovo, Apri, Salva, Stampa, Taglia/Copia/Incolla/Elimina, Annulla/Ripeti, Compila, Carica nel dispositivo, Carica dal dispositivo, Avvia simulazione, Collegamento online, Interrompi collegamento online, Dispositivi accessibili, Avvia/Arresta CPU, Dividi area di lavoro, Ricerca.
4. **Navigazione del progetto**, l'albero a sinistra:
   - Progetto
     - Aggiungi nuovo dispositivo
     - Dispositivi e reti
     - PLC_1 [CPU …]
       - Configurazione dispositivi
       - Online e diagnostica
       - Blocchi di programma: Aggiungi nuovo blocco, Main [OB1]…, Blocchi di sistema
       - Sorgenti esterne
       - Variabili PLC: Mostra tutte le variabili, Aggiungi nuova tabella delle variabili, Tabella delle variabili standard
       - Tipi di dati PLC
       - Tabelle di controllo e forzamento
       - Backup online
       - Informazioni sul programma
     - Dati di base comuni
     - Impostazioni della documentazione
     - Lingue e risorse
   - Accessi online

   Ogni oggetto ha a destra l'icona di stato: compilato, da compilare, errore e, online, i simboli di confronto (uguale / diverso / solo offline / solo online).

5. **Progetti di riferimento**: un progetto aperto in sola lettura, da cui copiare.
6. **Vista dettagli**: contenuto dell'oggetto selezionato nell'albero, per esempio le variabili di una tabella, da trascinare negli editor.
7. **Area di lavoro**: gli editor. Si può dividere in orizzontale/verticale e staccare in finestra separata.
8. **Barre di divisione** con frecce per mostrare/nascondere i pannelli; ogni pannello si può fissare o nascondere automaticamente.
9. **Finestra di ispezione**, con tre schede:
   - _Proprietà_: proprietà modificabili dell'oggetto selezionato;
   - _Informazioni_: sottoschede Generale, Riferimenti incrociati, Compila, con i messaggi cliccabili che portano al punto dell'errore;
   - _Diagnostica_: eventi di sistema e di diagnostica.
10. **Link "Vista portale"** in basso a sinistra.
11. **Barra degli editor**: un pulsante per ogni editor aperto; quelli dello stesso tipo si raggruppano.
12. **Barra di stato**: avanzamento delle operazioni in corso con pulsante di interruzione; altrimenti l'ultimo messaggio.
13. **Task card** a destra, a schede verticali:

- _Istruzioni_: Preferiti, Istruzioni di base, Istruzioni avanzate, Comunicazione, Pacchetti opzionali;
- _Test_: Pannello di comando CPU, Stack di chiamata;
- _Task_: Trova e sostituisci;
- _Librerie_: Libreria di progetto, Librerie globali.

### 8.3 Editor

- **Editor di blocco**, come in TIA:
  - interfaccia del blocco in alto (Input, Output, InOut, Static, Temp, con Nome, Tipo di dati, Valore iniziale, Commento);
  - barra delle istruzioni preferite;
  - sotto, i segmenti (reti) con titolo e commento.
  - AWL e SCL sono editor di testo con evidenziazione, completamento dei simboli ed errori sottolineati. KOP e FUP sono editor grafici con trascinamento delle istruzioni.
- **Editor delle tabelle variabili**: griglia stile foglio di calcolo (Nome, Tipo di dati, Indirizzo, Ritenzione, Accessibile da HMI, Commento), con riempimento automatico trascinando e controllo degli indirizzi sovrapposti.
- **Editor DB**: dichiarazione, valori iniziali e, online, valori attuali.
- **Tabelle di controllo e forzamento**: Indirizzo, Nome, Formato di visualizzazione, Valore di controllo, Valore di comando.
- **Configurazione dispositivi** (tappa 6): Vista dispositivi (rack S7-300 con posti connettore), Vista di rete, Panoramica dispositivi, catalogo hardware nella task card.

### 8.4 Modalità online

Come in TIA Portal:

- barra del titolo e intestazioni degli editor arancioni quando si è online;
- simboli di confronto online/offline nell'albero;
- in osservazione, in KOP/FUP i collegamenti diventano verdi (continui) dove passa corrente e blu tratteggiati dove non passa, e in AWL compaiono le colonne RLO/STA/ACCU1/ACCU2/Stato.

### 8.5 Scorciatoie

Le stesse di TIA Portal. Il costruttore le verifica sulla documentazione pubblica: per esempio Ctrl+S salva, Ctrl+B compila, Ctrl+L carica nel dispositivo, Ctrl+K collegamento online, Ctrl+M interrompi collegamento online. Su macOS Ctrl diventa ⌘.

### 8.6 Aspetto

- Tema chiaro grigio come TIA Portal, con densità alta (righe compatte).
- Le icone sono **disegnate da zero** ma con lo stesso significato e lo stesso codice colore per tipo di oggetto (OB, FB, FC, DB, UDT, tabelle variabili…), così l'occhio di chi conosce TIA le riconosce.

## 9. Tappe

Ogni tappa si chiude solo quando i criteri "Fatto quando" sono verificati.

### Tappa 1 — Fondamenta: interfaccia, progetto, AWL, compilatore

- Vista portale e Vista progetto complete (§8.1, §8.2) con tutti i pannelli, divisioni, nascondi/mostra, barra degli editor e barra di stato.
- Progetto: nuovo, apri, salva, salva con nome, chiudi, progetti recenti, archivia/ritira archivio, proprietà del progetto, salvataggio di recupero automatico.
- Annulla/ripeti, taglia/copia/incolla, trascinamento, trova e sostituisci.
- Aggiunta di una CPU S7-300 dal catalogo (solo la CPU; il rack completo arriva alla tappa 6) con le proprietà principali: indirizzo IP, rack/posto, merker di clock, merker di sistema, tempo di ciclo massimo, ritentività. Fino alla tappa 6 queste proprietà valgono solo per il simulatore, per i controlli offline e per l'indirizzo di collegamento: nel PLC non si caricano, e l'interfaccia lo dice chiaramente.
- Banco di prova PLC interno (§6) e test di conformità delle istruzioni AWL sulla CPU di prova (§10).
- Variabili PLC: tabelle, tutti i tipi di dati elementari e composti, controllo di indirizzi e nomi, costanti utente.
- Tipi di dati PLC (UDT).
- Blocchi OB, FB, FC, DB globali, DB di istanza, con interfaccia, multi-istanza, protezione know-how (flag del blocco).
- Editor AWL completo, con tutte le istruzioni AWL dell'S7-300.
- Compilazione (solo modifiche / tutto) AWL → MC7, con errori e avvisi in _Informazioni → Compila_.
- Decodificatore MC7 → AWL, necessario per i test di andata e ritorno.
- Definizioni (interfaccia) di tutte le SFC/SFB dell'S7-300 elencate nel manuale pubblico, richiamabili dai blocchi.
- Sorgenti esterne AWL: genera blocchi da sorgente / genera sorgente dai blocchi, nel formato di testo standard Siemens che anche TIA Portal e STEP 7 esportano.
- Importazione/esportazione delle tabelle variabili (xlsx/csv).
- Opzioni → Impostazioni: lingua, aspetto, comportamento editor.
- Installatori Windows e macOS.

**Fatto quando:**

- un progetto con OB1, FB/FC/DB e tabelle variabili si crea, si salva, si riapre e si compila;
- l'MC7 prodotto passa i test di andata e ritorno (§10);
- l'interfaccia ha tutti gli elementi di §8.1–8.2 e funziona su Windows e macOS.

### Tappa 2 — Simulatore (equivalente PLCSIM)

- CPU simulata S7-300: STOP/RUN, cancellazione totale, OB1 ciclico, OB100 all'avvio, OB di schedulazione orologio (OB35) e di errore principali (OB80, OB82, OB85, OB86, OB121, OB122).
- Esecuzione MC7 completa: parola di stato (RLO, STA, OR, OS, OV, CC0/CC1, BR, /FC), ACCU1/ACCU2, registri di indirizzo AR1/AR2, registri DB, stack L, stack di annidamento.
- Temporizzatori S5 (SI, SV, SE, SS, SA), contatori (ZV, ZR), temporizzatori/contatori IEC (SFB 0–5), merker di clock.
- SFC/SFB più usati simulati (SFC 0, 1, 20, 21, 46, 51 per le SZL principali, ecc.). Le altre, se richiamate, danno un avviso chiaro "non simulata".
- Pannello di comando CPU nella task card _Test_.
- Pannello I/O del simulatore: forzare ingressi, vedere uscite.
- Osservazione del programma in AWL; tabelle di controllo sul simulatore.
- Carica nel simulatore come se fosse un PLC (stesso percorso del caricamento reale).

**Fatto quando:** una batteria di programmi di prova, scritti a partire dagli esempi dei manuali pubblici, dà nel simulatore i risultati attesi istruzione per istruzione.

### Tappa 3 — Collegamento a S7-300 reali

- Dispositivi accessibili (scansione della sottorete e IP manuale, §6), collegamento online / interruzione.
- Collegamento diretto (CPU PN, CP 343-1) e tramite gateway Ethernet-MPI/DP RFC 1006 (§6).
- Carica nel dispositivo, con finestra di confronto e conferma (§4), anche di singoli blocchi.
- Carica dal dispositivo, che crea un progetto nuovo dal PLC: i blocchi arrivano in AWL e con indirizzi assoluti, perché simboli e commenti non stanno nel PLC.
- Confronto online/offline con simboli nell'albero ed editor di confronto.
- RUN / STOP / cancellazione totale; copia RAM in ROM, per le CPU che la richiedono; compressione della memoria.
- Online e diagnostica: informazioni generali CPU, buffer di diagnostica, tempo di ciclo, memoria, ora del PLC (lettura/impostazione).
- Osservazione del programma online, tabelle di controllo online e tabelle di forzamento (sulle CPU che supportano il forzamento).
- Backup online, compresi i blocchi di sistema (SDB) copiati così come sono, e ripristino (§6).

**Fatto quando:**

- sulla CPU di prova un programma creato in BaaPortal si carica, va in RUN, si osserva e si ricarica identico;
- un programma esistente della ditta si carica dal PLC, si ricodifica identico byte per byte e si ricarica senza differenze.

### Tappa 4 — KOP e FUP

- Editor grafici KOP e FUP con tutte le istruzioni di base S7-300: contatti, bobine, set/reset, fronti, temporizzatori, contatori, confronto, matematica, conversione, trasferimento, logica a parole, scorrimento/rotazione, salti, richiami di blocco.
- Cambio linguaggio di un segmento KOP ↔ FUP ↔ AWL, come in STEP 7: AWL → KOP/FUP solo quando il codice è rappresentabile, altrimenti il segmento resta in AWL.
- Visualizzazione in KOP/FUP dei blocchi caricati dal PLC, quando rappresentabili.
- Osservazione online/simulatore in KOP/FUP (§8.4).

**Fatto quando:** reti KOP/FUP di prova compilano in AWL equivalente a quello atteso, e girano identiche nel simulatore e sulla CPU di prova.

### Tappa 5 — SCL

- Editor SCL e compilatore SCL → AWL → MC7: IF, CASE, FOR, WHILE, REPEAT, espressioni, richiami di blocco, accesso a DB/UDT/ARRAY/STRUCT.
- Sorgenti esterne SCL.
- Osservazione SCL.

**Fatto quando:** i programmi SCL di prova danno nel simulatore e sulla CPU di prova gli stessi risultati della loro versione AWL scritta a mano.

### Tappa 6 — Configurazione dispositivi e reti

- Vista dispositivi del rack S7-300: CPU, PS, SM digitali/analogici, FM, CP.
- Catalogo hardware dai manuali pubblici, con indirizzi I/O automatici e modificabili e proprietà dei moduli.
- Vista di rete e Panoramica dispositivi, configurazione indirizzi PROFINET/MPI/PROFIBUS, periferia decentrata ET 200 (quanto basta per gli impianti della ditta).
- Lettura della configurazione reale dal PLC (moduli presenti, stato).
- **Da verificare:** il caricamento nel PLC della configurazione hardware (blocchi di sistema SDB) ha un formato non documentato pubblicamente. Si studia analizzando solo ciò che sta sul PLC della ditta. Finché non è verificato, la configurazione hardware resta un documento offline e serve per indirizzi e controlli, mentre il programma si carica normalmente.

### Tappa 7 — Completamento e strumenti per la manutenzione

- Riferimenti incrociati, struttura di richiamo, struttura delle dipendenze, assegnazione (uso di I/Q/M/T/C), occupazione memoria.
- Ricablaggio (sostituzione di indirizzi in tutto il programma).
- Librerie di progetto e librerie globali.
- Importazione di progetti STEP 7 V5.5 (.s7p), che recupera simboli e commenti dei programmi vecchi.
- Stampa e anteprima di stampa, impostazioni della documentazione (cornici, copertine).
- Testi multilingua del progetto.
- Libreria IEC standard dell'S7-300 (funzioni su stringhe, date, ecc.), scritta da zero in AWL/SCL.
- Guida in linea di BaaPortal.

### Tappa 8 — HMI (progetto separato)

Pagine operatore e runtime. Si progetta a parte, con il suo documento, dopo la tappa 7.

### Tappa 9 — Estensioni

GRAPH, regolatori PID (equivalenti funzionali scritti da zero), punti di arresto sulle CPU che li supportano, supporto S7-400 (stesso MC7), gateway Ethernet-MPI con protocollo proprietario.

## 10. Qualità e test

- **Test automatici per ogni modulo**: Vitest per la logica, Playwright per l'interfaccia Electron, eseguiti su Windows e macOS (GitHub Actions).
- **Andata e ritorno MC7**: i blocchi caricati dai PLC della ditta (raccolti con la CPU di prova o dalle macchine, in sola lettura) si decodificano in AWL e si ricodificano. Il risultato deve essere **identico byte per byte**. Questo verifica il formato dei blocchi e che codificatore e decodificatore siano coerenti tra loro. Da solo però non basta: se una tabella di codici fosse sbagliata in entrambi, il test passerebbe lo stesso.
- **Conformità sulla CPU reale (verifica indipendente)**: per ogni istruzione AWL c'è un blocco di prova che il banco di prova (§6) carica sulla CPU di prova, esegue e rilegge. Il risultato si confronta con quello descritto nel manuale pubblico. È la CPU stessa a fare da giudice, quindi un codice MC7 sbagliato viene scoperto anche se codificatore e decodificatore concordano. Si fa fin dalla tappa 1.
- **Programmi reali della ditta**: i test che li usano girano solo sui computer della ditta (§6).
- **Simulatore**: test istruzione per istruzione sulla parola di stato e sugli accumulatori, secondo i manuali pubblici.
- **Collaudo su CPU di prova**: lista di controllo scritta per ogni tappa che tocca il PLC (3, 4, 5, 6).
- **Nessuna regressione**: ogni bug corretto aggiunge un test.

## 11. Rischi e incognite

| Rischio                                                                                     | Gestione                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Codifica MC7 di tutte le istruzioni: le informazioni pubbliche sono parziali                | Decodificatori open source come documentazione, poi andata e ritorno su blocchi reali; la CPU di prova rifiuta blocchi errati |
| Sequenza esatta di caricamento nel PLC (richiesta, trasferimento, fine, inserimento blocco) | Documentata da snap7 e Wireshark; verifica sulla CPU di prova                                                                 |
| I blocchi caricati dal PLC non hanno simboli né commenti                                    | Previsto: si recuperano importando sorgenti, tabelle variabili o progetti .s7p (tappe 1 e 7)                                  |
| Configurazione hardware (SDB) non documentata                                               | Tappa 6 la tratta come "da verificare"; il programma si carica comunque                                                       |
| Mole di lavoro: TIA Portal è un prodotto enorme                                             | Tappe chiuse una alla volta; ogni tappa è già utilizzabile da sola                                                            |

## 12. Lasciato al costruttore

- Scelta delle librerie dentro la tecnologia indicata (editor di testo, griglie, pannelli, gestione dello stato).
- Struttura interna dei file e dei pacchetti.
- Colori, dimensioni e spaziature esatti, ricavati dagli screenshot pubblici.
- Struttura interna del formato `.baap`, rispettando il vincolo "zip di file di testo/JSON leggibili".
- Ordine interno dei lavori dentro ogni tappa.

---

## Appendice A — Mappa delle funzioni TIA Portal (per S7-300) → tappa

| Area           | Funzione                                                                         | Tappa                                                         |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Progetto       | Nuovo, apri, salva, salva con nome, chiudi, recenti                              | 1                                                             |
| Progetto       | Archivia / ritira archivio                                                       | 1                                                             |
| Progetto       | Progetti di riferimento                                                          | 1                                                             |
| Progetto       | Annulla/ripeti, copia/incolla, trova e sostituisci                               | 1                                                             |
| Progetto       | Stampa, anteprima, impostazioni documentazione                                   | 7                                                             |
| Progetto       | Lingue del progetto, testi multilingua                                           | 7                                                             |
| Progetto       | Migra/importa progetto STEP 7 V5.5                                               | 7                                                             |
| Progetto       | Aprire progetti TIA Portal                                                       | No (formato proprietario); si importano le sorgenti esportate |
| Dispositivi    | Aggiungi CPU S7-300 e proprietà principali                                       | 1                                                             |
| Dispositivi    | Vista dispositivi, rack, moduli, indirizzi                                       | 6                                                             |
| Dispositivi    | Vista di rete, PROFINET/MPI/PROFIBUS, ET 200                                     | 6                                                             |
| Dispositivi    | Vista topologica                                                                 | 9                                                             |
| Dispositivi    | Caricamento configurazione hardware                                              | 6 (da verificare)                                             |
| Programmazione | OB, FB, FC, DB, DB di istanza, multi-istanza                                     | 1                                                             |
| Programmazione | Tipi di dati PLC (UDT)                                                           | 1                                                             |
| Programmazione | Tabelle variabili, costanti                                                      | 1                                                             |
| Programmazione | AWL                                                                              | 1                                                             |
| Programmazione | KOP, FUP, conversione tra linguaggi                                              | 4                                                             |
| Programmazione | SCL                                                                              | 5                                                             |
| Programmazione | GRAPH                                                                            | 9                                                             |
| Programmazione | Sorgenti esterne AWL                                                             | 1                                                             |
| Programmazione | Sorgenti esterne SCL                                                             | 5                                                             |
| Programmazione | Protezione know-how                                                              | 1                                                             |
| Programmazione | Istruzioni di base                                                               | 1 (AWL), 4 (KOP/FUP), 5 (SCL)                                 |
| Programmazione | Temporizzatori S5 e IEC, contatori                                               | 1 (AWL), 4 (KOP/FUP), 5 (SCL)                                 |
| Programmazione | SFC/SFB di sistema (interfacce)                                                  | 1                                                             |
| Programmazione | Libreria IEC standard                                                            | 7                                                             |
| Programmazione | Riferimenti incrociati, struttura di richiamo, dipendenze, assegnazione, memoria | 7                                                             |
| Programmazione | Ricablaggio                                                                      | 7                                                             |
| Programmazione | Librerie di progetto e globali                                                   | 7                                                             |
| Programmazione | Regolatori PID                                                                   | 9                                                             |
| Compilazione   | Compila (modifiche / tutto), messaggi cliccabili                                 | 1                                                             |
| Test           | Simulatore (PLCSIM)                                                              | 2                                                             |
| Test           | Pannello di comando CPU                                                          | 2 (sim), 3 (reale)                                            |
| Test           | Osservazione programma AWL                                                       | 2/3                                                           |
| Test           | Osservazione programma KOP/FUP                                                   | 4                                                             |
| Test           | Osservazione programma SCL                                                       | 5                                                             |
| Test           | Tabelle di controllo                                                             | 2 (sim), 3 (reale)                                            |
| Test           | Tabelle di forzamento                                                            | 3                                                             |
| Test           | Stack di chiamata                                                                | 3                                                             |
| Test           | Punti di arresto                                                                 | 9                                                             |
| Online         | Dispositivi accessibili, collegamento online/offline                             | 3                                                             |
| Online         | Carica nel dispositivo / dal dispositivo                                         | 3                                                             |
| Online         | Confronto online/offline                                                         | 3                                                             |
| Online         | Confronto offline/offline                                                        | 7                                                             |
| Online         | RUN/STOP, cancellazione totale, copia RAM→ROM, compressione                      | 3                                                             |
| Online         | Buffer di diagnostica, info CPU, tempo di ciclo, memoria, ora                    | 3                                                             |
| Online         | Backup online                                                                    | 3                                                             |
| Online         | Stato dei moduli                                                                 | 6                                                             |
| Online         | Assegnazione nome/IP PROFINET                                                    | 6                                                             |
| Online         | Aggiornamento firmware                                                           | No (rischio di danneggiare la CPU)                            |
| Online         | Lettore di schede / memoria USB (Micro Memory Card)                              | No (formato non documentato, serve programmatore Siemens)     |
| Online         | Blocchi con protezione know-how                                                  | Si rispetta la protezione: solo interfaccia, niente codice    |
| HMI            | WinCC, pannelli operatore                                                        | 8 (progetto separato)                                         |
| Altro          | Lingua interfaccia, impostazioni                                                 | 1                                                             |
| Altro          | Guida in linea                                                                   | 7                                                             |
| Altro          | Safety, Startdrive, Motion, Openness, Multiuser, Teamcenter, Energy Suite        | No (§3)                                                       |
| Altro          | Trace, ProDiag, funzioni solo S7-1200/1500                                       | No (non esistono per S7-300)                                  |
