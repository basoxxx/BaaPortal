# BaaPortal — Piano di lavoro generale

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`

Questo documento divide tutte le tappe del progetto in **piani** più piccoli. Ogni piano produce software funzionante e testato, utilizzabile da solo.

Il piano dettagliato, cioè i task passo per passo, si scrive per un piano alla volta, quando il precedente è chiuso, così parte dalle interfacce reali e non da ipotesi. Piani dettagliati scritti finora:
- 1A: `docs/superpowers/plans/2026-10-18-tappa1a-shell-interfaccia.md` (chiuso);
- 1B: `docs/superpowers/plans/2026-10-18-tappa1b-modello-dati-plc.md` (chiuso);
- 1C: `docs/superpowers/plans/2026-10-19-tappa1c-linguaggio-awl.md`.

## Come si chiude ogni piano

1. Piano dettagliato scritto e approvato.
2. Implementazione con test scritti prima del codice.
3. Revisione del codice.
4. Collaudo: test automatici verdi su Windows e macOS e, per i piani che toccano il PLC, la lista di controllo sulla CPU di prova.
5. Si passa al piano successivo.

## Cosa serve dalla ditta, e quando

| Cosa | Quando |
|---|---|
| Un computer Windows e un Mac per provare gli installatori | Fine piano 1A |
| Una sessione con l'amico che ha una CPU S7-300: lancia il kit di raccolta in sola lettura (piano 1D) e ci manda il file prodotto | Fine piano 1D |
| CPU S7-300 **non in produzione** (usata, consigliata 315-2 PN/DP o 314C-2 PN/DP, con alimentatore, Micro Memory Card e cavo Ethernet) per le prove di scrittura e di conformità | Prima del collaudo della tappa 1 (fine 1E/1F) |
| Elenco delle CPU sulle macchine e di come ci si collega (Ethernet integrata, CP 343-1, MPI/DP con gateway) | Inizio tappa 3 |
| Un CP 343-1 per il banco di prova | Inizio tappa 3 |
| Programmi esistenti caricati dalle macchine, in sola lettura (anche tramite il kit di raccolta) | Piano 1E (andata e ritorno) |

### Senza una CPU di prova propria (deciso il 19 ottobre 2026)

La ditta per ora non ha una CPU S7-300; un amico che userà BaaPortal ce l'ha. Il lavoro si divide così:

1. **Sviluppo e CI senza CPU.** Il client `s7comm` si sviluppa contro un **finto PLC** scritto da noi in TypeScript, che risponde come una CPU S7-300 per le funzioni del piano 1D: connessione, lettura/scrittura, SZL, elenco blocchi, carica nel/dal dispositivo e RUN/STOP. Gira nei test e nella CI. Il finto PLC rispecchia la nostra comprensione del protocollo, quindi da solo non basta: va confrontato con i dati veri del punto 2.
2. **Dati veri, in sola lettura, dall'amico.** Il **kit di raccolta** è un piccolo comando, senza alcuna funzione di scrittura. L'amico lo lancia una volta sul suo PC collegato alla CPU, con il suo consenso e a macchina ferma o non critica. Il kit:
   - legge l'identità della CPU (SZL);
   - legge l'elenco dei blocchi;
   - carica dal PLC tutti i blocchi;
   - registra i telegrammi scambiati.

   Tutto finisce in un file che ci manda. Con quei blocchi si fanno i test di andata e ritorno del piano 1E; con i telegrammi si verifica il finto PLC.
3. **Scrittura e conformità solo su una CPU non in produzione.** Caricare blocchi di prova ed eseguirli serve alla verifica indipendente del compilatore (spec §10). **Mai sulla CPU di una macchina che lavora.** Si usa una CPU usata comprata allo scopo o una CPU di scorta dell'amico. Fino ad allora queste prove restano in sospeso. Il punto di decisione qui sotto si fa quando girano, e la tappa 1 si chiude solo dopo di esse (spec §6).

## Tappa 1 — Fondamenta

| Piano | Contenuto | Dipende da | Fatto quando |
|---|---|---|---|
| **1A Shell e interfaccia** | Monorepo, app Electron, Vista portale, Vista progetto con i 13 elementi, file `.baap` (nuovo/apri/salva/chiudi/recenti), italiano/inglese, installatori Windows e macOS, CI | — | L'app si installa e si avvia su Windows e macOS; un progetto si crea, si salva e si riapre; tutti gli elementi di spec §8.1–8.2 sono presenti |
| **1B Modello dati PLC** | CPU S7-300 dal catalogo (solo CPU) e proprietà; tipi di dati S7; tabelle variabili con editor a griglia; costanti; UDT; blocchi OB/FB/FC/DB/DB di istanza con interfaccia e multi-istanza; annulla/ripeti; taglia/copia/incolla; trascinamento; recupero automatico; editor nella barra degli editor (con raggruppamento); divisione dell'area di lavoro ed editor in finestra separata | 1A | Un progetto con CPU, tabelle variabili, UDT e blocchi (interfaccia) si crea, si modifica con annulla/ripeti e si salva |
| **1C Linguaggio AWL** | Parser e controllo semantico AWL (tutte le istruzioni S7-300); editor AWL con evidenziazione, completamento simboli ed errori; interfacce SFC/SFB dal manuale pubblico; sorgenti esterne AWL (genera blocchi da sorgente e viceversa) | 1B | Sorgenti AWL di prova si importano, si modificano, si controllano con errori precisi e si riesportano identiche |
| **1D Banco di prova PLC** | Nucleo `s7comm` in TypeScript (ISO-on-TCP, lettura/scrittura, SZL, elenco blocchi, carica nel/dal dispositivo, RUN/STOP), come strumento interno a riga di comando, senza interfaccia; **finto PLC** per test e CI; **kit di raccolta in sola lettura** per l'amico | 1A | Contro il finto PLC tutte le funzioni passano in CI; il kit, eseguito dall'amico, restituisce identità, elenco e tutti i blocchi della sua CPU senza scrivere nulla; il finto PLC risponde come la CPU vera nei telegrammi raccolti |
| **1E Compilatore MC7** | Formato del blocco (testata, interfaccia, codice, tabella reti); codificatore AWL → MC7; decodificatore MC7 → AWL; flag know-how; *Compila* con messaggi in *Informazioni → Compila*; test di andata e ritorno; test di conformità pronti da eseguire | 1C, 1D | Andata e ritorno identica byte per byte sui blocchi raccolti dal kit; i test di conformità girano sulla CPU non in produzione appena disponibile (vedi sopra) |
| **1F Completamento tappa 1** | Import/export tabelle variabili (xlsx/csv); archivia/ritira archivio (`.baapz`); progetti di riferimento; trova e sostituisci; *Opzioni → Impostazioni*; collaudo finale della tappa | 1B–1E | Tutti i criteri "Fatto quando" della tappa 1 nella spec sono verificati |

**Punto di decisione dopo 1E** (quando girano i test di conformità sulla CPU non in produzione). Se la CPU rifiuta i blocchi generati da BaaPortal e non si trova la causa, ci si ferma e si decide insieme prima di andare avanti. È il rischio più grande del progetto, ed è per questo che si affronta subito. Intanto le tappe che non scrivono nel PLC (simulatore, KOP/FUP, SCL) possono andare avanti.

## Tappa 2 — Simulatore

| Piano | Contenuto |
|---|---|
| **2A Nucleo CPU simulata** | Esecuzione MC7, parola di stato, accumulatori, AR1/AR2, registri DB, stack L e di annidamento, ciclo OB1, OB100, STOP/RUN, cancellazione totale |
| **2B Temporizzatori, contatori, OB e SFC** | Temporizzatori S5, contatori, SFB 0–5 IEC, merker di clock, OB35 e OB di errore, SFC/SFB principali simulate, avviso "non simulata" per le altre |
| **2C Strumenti di test sul simulatore** | Pannello di comando CPU, pannello I/O, carica nel simulatore, osservazione AWL, tabelle di controllo |

## Tappa 3 — Collegamento a S7-300 reali

| Piano | Contenuto |
|---|---|
| **3A Online** | Dispositivi accessibili (scansione sottorete e IP manuale), collegamento online/interruzione, CPU PN, CP 343-1, gateway RFC 1006, modalità online arancione |
| **3B Caricamento e confronto** | Carica nel dispositivo con conferma, carica dal dispositivo in un progetto nuovo, confronto online/offline ed editor di confronto, RUN/STOP/MRES, copia RAM→ROM, compressione |
| **3C Diagnostica e test online** | Info CPU, buffer di diagnostica, tempo di ciclo, memoria, ora; osservazione online; tabelle di controllo e forzamento; stack di chiamata; backup online con SDB e ripristino |

## Tappa 4 — KOP e FUP

| Piano | Contenuto |
|---|---|
| **4A Editor KOP** | Modello di rete, editor grafico, tutte le istruzioni di base, traduzione in AWL secondo gli schemi STEP 7 |
| **4B Editor FUP** | Come 4A, per FUP |
| **4C Conversione e osservazione** | Cambio linguaggio KOP ↔ FUP ↔ AWL, AWL → KOP/FUP per i blocchi caricati, osservazione grafica |

## Tappa 5 — SCL

| Piano | Contenuto |
|---|---|
| **5A Parser e controllo SCL** | Grammatica completa SCL S7-300, controllo dei tipi |
| **5B Compilatore SCL → AWL** | Istruzioni di controllo, espressioni, richiami, accesso a DB/UDT/ARRAY/STRUCT |
| **5C Editor, sorgenti e osservazione SCL** | — |

## Tappa 6 — Configurazione dispositivi e reti

| Piano | Contenuto |
|---|---|
| **6A Catalogo e Vista dispositivi** | Rack S7-300, moduli, indirizzi, proprietà |
| **6B Vista di rete** | PROFINET/MPI/PROFIBUS, ET 200, Panoramica dispositivi, lettura configurazione reale dal PLC |
| **6C Studio SDB e DCP** | Formato SDB analizzato solo sui PLC della ditta, da verificare; DCP con libreria nativa per trovare CPU senza IP e assegnare nome/IP |

## Tappa 7 — Completamento e manutenzione

| Piano | Contenuto |
|---|---|
| **7A Informazioni sul programma** | Riferimenti incrociati, struttura di richiamo, dipendenze, assegnazione, memoria, ricablaggio |
| **7B Librerie** | Librerie di progetto e globali; libreria IEC standard scritta da zero |
| **7C Importazione STEP 7 V5.5** | Lettura `.s7p` per recuperare simboli e commenti |
| **7D Documentazione** | Stampa, anteprima, cornici e copertine, testi multilingua, guida in linea, confronto offline/offline |

## Tappe 8 e 9

- **Tappa 8 (HMI)**: progetto separato, con il suo documento di progetto, dopo la tappa 7.
- **Tappa 9 (estensioni)**: GRAPH, PID, punti di arresto, S7-400, gateway proprietari. Si pianificano su richiesta.

## Ordine

```
1A → 1B → 1C ─┐
1A → 1D ──────┴→ 1E → [decisione] → 1F → 2A → 2B → 2C → 3A → 3B → 3C → 4A → 4B → 4C → 5A → 5B → 5C → 6A → 6B → 6C → 7A…7D
```
