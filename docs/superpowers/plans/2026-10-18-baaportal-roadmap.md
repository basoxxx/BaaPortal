# BaaPortal — Piano di lavoro generale

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`

Questo documento divide tutte le tappe del progetto in **piani** più piccoli. Ogni piano produce software funzionante e testato, utilizzabile da solo.

Il piano dettagliato, cioè i task passo per passo, si scrive per un piano alla volta, quando il precedente è chiuso, così parte dalle interfacce reali e non da ipotesi. Piani dettagliati scritti finora:

- 1A: `docs/superpowers/plans/2026-10-18-tappa1a-shell-interfaccia.md` (chiuso);
- 1B: `docs/superpowers/plans/2026-10-18-tappa1b-modello-dati-plc.md` (chiuso);
- 1C: `docs/superpowers/plans/2026-10-19-tappa1c-linguaggio-awl.md` (chiuso);
- 1D: `docs/superpowers/plans/2026-10-20-tappa1d-banco-prova-plc.md` (chiuso);
- 1E: `docs/superpowers/plans/2026-10-20-tappa1e-compilatore-mc7.md` (chiuso).

## Come si chiude ogni piano

1. Piano dettagliato scritto e approvato.
2. Implementazione con test scritti prima del codice.
3. Revisione del codice.
4. Collaudo: test automatici verdi su Windows e macOS e, per i piani che toccano il PLC, la lista di controllo sulla CPU di prova.
5. Si aggiornano i limiti noti in `docs/limiti-noti.md`.
6. Si passa al piano successivo.

## Cosa serve dalla ditta, e quando

| Cosa                                                                                                                                                                                     | Quando                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Un computer Windows e un Mac per provare gli installatori                                                                                                                                | Fine piano 1A                                 |
| Una sessione con l'amico che ha una CPU S7-300: lancia il kit di raccolta in sola lettura (piano 1D) e ci manda il file prodotto (facoltativo: nessun piano lo aspetta)                  | Quando capita                                 |
| CPU S7-300 **non in produzione** (usata, consigliata 315-2 PN/DP o 314C-2 PN/DP, con alimentatore, Micro Memory Card e cavo Ethernet) per le prove di scrittura (1D-bis) e di conformità | Prima del collaudo della tappa 1 (fine 1E/1F) |
| Elenco delle CPU sulle macchine e di come ci si collega (Ethernet integrata, CP 343-1, MPI/DP con gateway)                                                                               | Inizio tappa 3                                |
| Un CP 343-1 per il banco di prova                                                                                                                                                        | Inizio tappa 3                                |
| Programmi esistenti caricati dalle macchine, in sola lettura (anche tramite il kit di raccolta)                                                                                          | Piano 1E (andata e ritorno)                   |

### Senza una CPU di prova propria (deciso il 19 ottobre 2026)

La ditta per ora non ha una CPU S7-300; un amico che userà BaaPortal ce l'ha. Il lavoro si divide così:

1. **Sviluppo e CI senza CPU.** Il client `s7comm` si sviluppa contro un **finto PLC** scritto da noi in TypeScript, che risponde come una CPU S7-300 per le funzioni di **sola lettura** del piano 1D: connessione, lettura dell'identità (SZL) ed elenco dei blocchi, carica dal dispositivo. Gira nei test e nella CI. Il finto PLC rispecchia la nostra comprensione del protocollo, quindi da solo non basta: lo confrontiamo con i byte di catture pubbliche di CPU S7-300 reali. Le funzioni che scrivono o controllano la CPU (scrittura di variabili, carica nel dispositivo, RUN/STOP) non fanno parte del 1D: sono il piano **1D-bis**.
2. **Dati veri, in sola lettura, dall'amico (facoltativo).** Il **kit di raccolta** è una funzione dell'app (_Strumenti → Raccolta dati CPU_), senza alcuna funzione di scrittura. L'amico la lancia una volta, con il suo consenso e a macchina ferma o non critica. Il kit:
   - legge l'identità della CPU (SZL);
   - legge l'elenco dei blocchi;
   - carica dal PLC tutti i blocchi;
   - registra i telegrammi scambiati.

   Tutto finisce in un file che ci manda. Il kit è **facoltativo e non blocca nessun piano**: se il file arriva, diventa un test di regressione privato (mai nel repository) e altri blocchi per l'andata e ritorno del piano 1E.

3. **Scrittura e conformità solo su una CPU non in produzione.** Caricare blocchi di prova ed eseguirli serve alla verifica indipendente del compilatore (spec §10). **Mai sulla CPU di una macchina che lavora.** Si usa una CPU usata comprata allo scopo o una CPU di scorta dell'amico. Fino ad allora queste prove restano in sospeso. Il punto di decisione qui sotto si fa quando girano, e la tappa 1 si chiude solo dopo di esse (spec §6).

## Tappa 1 — Fondamenta

| Piano                                    | Contenuto                                                                                                                                                                                                                                                                                                                                                                               | Dipende da | Fatto quando                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1A Shell e interfaccia**               | Monorepo, app Electron, Vista portale, Vista progetto con i 13 elementi, file `.baap` (nuovo/apri/salva/chiudi/recenti), italiano/inglese, installatori Windows e macOS, CI                                                                                                                                                                                                             | —          | L'app si installa e si avvia su Windows e macOS; un progetto si crea, si salva e si riapre; tutti gli elementi di spec §8.1–8.2 sono presenti                                                                                                                                                                                                               |
| **1B Modello dati PLC**                  | CPU S7-300 dal catalogo (solo CPU) e proprietà; tipi di dati S7; tabelle variabili con editor a griglia; costanti; UDT; blocchi OB/FB/FC/DB/DB di istanza con interfaccia e multi-istanza; annulla/ripeti; taglia/copia/incolla; trascinamento; recupero automatico; editor nella barra degli editor (con raggruppamento); divisione dell'area di lavoro ed editor in finestra separata | 1A         | Un progetto con CPU, tabelle variabili, UDT e blocchi (interfaccia) si crea, si modifica con annulla/ripeti e si salva                                                                                                                                                                                                                                      |
| **1C Linguaggio AWL**                    | Parser e controllo semantico AWL (tutte le istruzioni S7-300); editor AWL con evidenziazione, completamento simboli ed errori; interfacce SFC/SFB dal manuale pubblico; sorgenti esterne AWL (genera blocchi da sorgente e viceversa)                                                                                                                                                   | 1B         | Sorgenti AWL di prova si importano, si modificano, si controllano con errori precisi e si riesportano identiche                                                                                                                                                                                                                                             |
| **1D Banco di prova PLC (sola lettura)** | Nucleo `s7comm` in TypeScript che **legge soltanto** (ISO-on-TCP, SZL, elenco blocchi, carica dal dispositivo); **finto PLC** per test e CI; **kit di raccolta in sola lettura** dentro l'app; strumento a riga di comando `s7bench`                                                                                                                                                    | 1A         | Client di lettura e kit verificati contro il finto PLC in CI e sui byte di catture pubbliche di CPU S7-300 reali; il log dell'amico, quando c'è, entra come test di regressione privato. Leggere dalla CPU dell'amico non è più una condizione per chiudere il 1D                                                                                           |
| **1D-bis Funzioni di scrittura sul PLC** | Scrittura di variabili, carica nel dispositivo, RUN/STOP, tutte con conferma esplicita nell'interfaccia                                                                                                                                                                                                                                                                                 | 1D         | Nucleo di scrittura/download/stop-avvio fatto e verificato contro il finto PLC e le catture pubbliche; interfaccia online e conformità su CPU reale alla tappa 3. **Stato: nucleo chiuso.** Mai provato su una CPU reale                                                                                                                                    |
| **1E Compilatore MC7**                   | Formato del blocco (testata, interfaccia, codice, tabella reti); codificatore AWL → MC7; decodificatore MC7 → AWL; flag know-how; _Compila_ con messaggi in _Informazioni → Compila_; test di andata e ritorno; test di conformità pronti da eseguire                                                                                                                                   | 1C, 1D     | Andata e ritorno MC7 → AWL → MC7 identica al byte sui blocchi reali disponibili; compilazione dei blocchi AWL del progetto con messaggi in _Informazioni → Compila_; importazione modificabile dei blocchi del kit. **Stato: chiuso.** Le prove di conformità diventano un piano della tappa 2 (simulatore), perché manca ancora una CPU reale per provarlo |
| **1F Completamento tappa 1**             | Import/export tabelle variabili (xlsx/csv); archivia/ritira archivio (`.baapz`); progetti di riferimento; trova e sostituisci; _Opzioni → Impostazioni_; collaudo finale della tappa                                                                                                                                                                                                    | 1B–1E      | Tutti i criteri "Fatto quando" della tappa 1 nella spec sono verificati. **Fatto:** importa/esporta variabili, archivio, riferimenti, trova e sostituisci, impostazioni, barra di stato, e2e Fatto quando; la tappa 1 resta aperta solo per la conformità su CPU reale.                                                                                     |

**Punto di decisione dopo 1E** (quando girano i test di conformità sulla CPU non in produzione, con il 1D-bis). Se la CPU rifiuta i blocchi generati da BaaPortal e non si trova la causa, ci si ferma e si decide insieme prima di andare avanti. È il rischio più grande del progetto, ed è per questo che si affronta subito. Intanto le tappe che non scrivono nel PLC (simulatore, KOP/FUP, SCL) possono andare avanti. Un simulatore scritto da noi controlla la coerenza interna ma non è la verifica indipendente della spec §10, che richiede una CPU reale non di produzione; quella verifica è ancora in sospeso, perché manca ancora una CPU reale per provarlo.

## Tappa 2 — Simulatore

| Piano                                      | Contenuto                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **2A Nucleo CPU simulata**                 | Esecuzione MC7, parola di stato, accumulatori, AR1/AR2, registri DB, stack L e di annidamento, ciclo OB1, OB100, STOP/RUN, cancellazione totale **Stato: fatto** (v0.6.0).                             |
| **2B Temporizzatori, contatori, OB e SFC** | Temporizzatori S5, contatori, SFB 0–5 IEC, merker di clock, OB35 e OB di errore, SFC/SFB principali simulate, avviso "non simulata" per le altre **Stato: fatto** (v0.7.0).                            |
| **2C Strumenti di test sul simulatore**    | Pannello di comando CPU, pannello I/O, carica nel simulatore, osservazione AWL, tabelle di controllo **Stato: fatto** (v0.8.0). **Tappa 2 chiusa**, salvo la conformità su una CPU reale (in sospeso). |

## Tappa 3 — Collegamento a S7-300 reali

| Piano                           | Contenuto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3A Online**                   | Dispositivi accessibili (scansione sottorete e IP manuale), collegamento online/interruzione, CPU PN, CP 343-1, gateway RFC 1006, modalità online arancione **Stato: fatto** (v0.9.0), in sola lettura. Mai provato su una CPU reale                                                                                                                                                                                                                                                                                 |
| **3B Caricamento e confronto**  | Carica nel dispositivo con conferma, carica dal dispositivo in un progetto nuovo, confronto online/offline ed editor di confronto, RUN/STOP/MRES, copia RAM→ROM, compressione **Stato: fatto** (v0.10.0). Mai provato su una CPU reale                                                                                                                                                                                                                                                                               |
| **3C Diagnostica online**       | Correzione del filesystem di `_DELE`; Online e diagnostica (generale, LED, protezione e selettore, ultimo cambio di modo, buffer di diagnostica con testi degli eventi, tempo di ciclo, memoria, ora con impostazione); tabelle di controllo online (osservazione con read var, comando con conferma); backup online in sola esportazione con SDB (`.baapbak`). **Stato: fatto** (v0.11.0). Mai provato su una CPU reale. Piano: `docs/superpowers/plans/2026-10-25-tappa3c-diagnostica-online.md`                   |
| **3D Test online e ripristino** | Osservazione del programma online (stato del blocco v2, TIS), LED FRCE («Forzamento attivo»), stack di chiamata e ripristino del backup con SDB, questi ultimi sperimentali. **Stato: fatto** (v0.13.0). Mai provato su una CPU reale. Le tabelle di forzamento non sono fatte (protocollo non stabilito, proto §18.5.1) e restano nelle mancanze aperte. Piano: `docs/superpowers/plans/2026-10-25-tappa3d-osservazione-online.md`                                                                                  |
| **3U Aggiornamenti automatici** | Controllo degli aggiornamenti all'avvio, ogni 6 ore e da Guida; canale di prova o stabile deciso dalla build, con la casella «Ricevi anche le versioni di prova»; mai versioni più vecchie. Windows: scaricamento e installazione con electron-updater, mai durante un lavoro sul PLC. macOS: DMG dell'architettura giusta scaricato, verificato e aperto. Release con `latest*.yml` e `.blockmap`. Versione 0.12.0. **Stato: fatto** (v0.12.0). Piano: `docs/superpowers/plans/2026-10-25-tappa3u-aggiornamenti.md` |

## Tappa 4 — KOP e FUP

| Piano                             | Contenuto                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4A Editor KOP**                 | Modello di rete, editor grafico, tutte le istruzioni di base, traduzione in AWL secondo gli schemi STEP 7. **Stato: fatto** (v0.14.0). Mai provato su una CPU reale; nessun BLD, STEP 7 potrebbe riaprire i blocchi in AWL (vedi `docs/limiti-noti.md`) |
| **4B Editor FUP**                 | Come 4A, per FUP                                                                                                                                                                                                                                        |
| **4C Conversione e osservazione** | Cambio linguaggio KOP ↔ FUP ↔ AWL, AWL → KOP/FUP per i blocchi caricati, osservazione grafica                                                                                                                                                           |

## Tappa 5 — SCL

| Piano                                      | Contenuto                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| **5A Parser e controllo SCL**              | Grammatica completa SCL S7-300, controllo dei tipi                            |
| **5B Compilatore SCL → AWL**               | Istruzioni di controllo, espressioni, richiami, accesso a DB/UDT/ARRAY/STRUCT |
| **5C Editor, sorgenti e osservazione SCL** | —                                                                             |

## Tappa 6 — Configurazione dispositivi e reti

| Piano                               | Contenuto                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **6A Catalogo e Vista dispositivi** | Rack S7-300, moduli, indirizzi, proprietà                                                                                            |
| **6B Vista di rete**                | PROFINET/MPI/PROFIBUS, ET 200, Panoramica dispositivi, lettura configurazione reale dal PLC                                          |
| **6C Studio SDB e DCP**             | Formato SDB analizzato solo sui PLC della ditta, da verificare; DCP con libreria nativa per trovare CPU senza IP e assegnare nome/IP |

## Tappa 7 — Completamento e manutenzione

| Piano                             | Contenuto                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **7A Informazioni sul programma** | Riferimenti incrociati, struttura di richiamo, dipendenze, assegnazione, memoria, ricablaggio        |
| **7B Librerie**                   | Librerie di progetto e globali; libreria IEC standard scritta da zero                                |
| **7C Importazione STEP 7 V5.5**   | Lettura `.s7p` per recuperare simboli e commenti                                                     |
| **7D Documentazione**             | Stampa, anteprima, cornici e copertine, testi multilingua, guida in linea, confronto offline/offline |

## Tappe 8 e 9

- **Tappa 8 (HMI)**: progetto separato, con il suo documento di progetto, dopo la tappa 7.
- **Tappa 9 (estensioni)**: GRAPH, PID, punti di arresto, S7-400, gateway proprietari. Si pianificano su richiesta.

## Ordine

```
1A → 1B → 1C ────────┐
1A → 1D → 1D-bis ────┴→ 1E → [decisione] → 1F → 2A → 2B → 2C → 3A → 3B → 3C → 3D → 4A → 4B → 4C → 5A → 5B → 5C → 6A → 6B → 6C → 7A…7D
```

Alla fine di tutte le tappe si riguardano con l'utente, punto per punto, i limiti noti raccolti in `docs/limiti-noti.md`, per decidere che cosa sistemare.
