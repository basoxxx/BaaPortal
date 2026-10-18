# BaaPortal — Piano di lavoro generale

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`

Questo documento divide tutte le tappe del progetto in **piani** più piccoli. Ogni piano produce software funzionante e testato, utilizzabile da solo.

Il piano dettagliato, cioè i task passo per passo, si scrive per un piano alla volta, quando il precedente è chiuso, così parte dalle interfacce reali e non da ipotesi. Il primo è già pronto:
`docs/superpowers/plans/2026-10-18-tappa1a-shell-interfaccia.md`

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
| CPU di prova S7-300, consigliata 315-2 PN/DP, con alimentatore, Micro Memory Card e cavo Ethernet | Inizio piano 1D |
| Elenco delle CPU sulle macchine e di come ci si collega (Ethernet integrata, CP 343-1, MPI/DP con gateway) | Inizio tappa 3 |
| Un CP 343-1 per il banco di prova | Inizio tappa 3 |
| Programmi esistenti caricati dalle macchine, in sola lettura | Piano 1E (andata e ritorno) |

## Tappa 1 — Fondamenta

| Piano | Contenuto | Dipende da | Fatto quando |
|---|---|---|---|
| **1A Shell e interfaccia** | Monorepo, app Electron, Vista portale, Vista progetto con i 13 elementi, file `.baap` (nuovo/apri/salva/chiudi/recenti), italiano/inglese, installatori Windows e macOS, CI | — | L'app si installa e si avvia su Windows e macOS; un progetto si crea, si salva e si riapre; tutti gli elementi di spec §8.1–8.2 sono presenti |
| **1B Modello dati PLC** | CPU S7-300 dal catalogo (solo CPU) e proprietà; tipi di dati S7; tabelle variabili con editor a griglia; costanti; UDT; blocchi OB/FB/FC/DB/DB di istanza con interfaccia e multi-istanza; annulla/ripeti; taglia/copia/incolla; trascinamento; recupero automatico; editor nella barra degli editor (con raggruppamento); divisione dell'area di lavoro ed editor in finestra separata | 1A | Un progetto con CPU, tabelle variabili, UDT e blocchi (interfaccia) si crea, si modifica con annulla/ripeti e si salva |
| **1C Linguaggio AWL** | Parser e controllo semantico AWL (tutte le istruzioni S7-300); editor AWL con evidenziazione, completamento simboli ed errori; interfacce SFC/SFB dal manuale pubblico; sorgenti esterne AWL (genera blocchi da sorgente e viceversa) | 1B | Sorgenti AWL di prova si importano, si modificano, si controllano con errori precisi e si riesportano identiche |
| **1D Banco di prova PLC** | Nucleo `s7comm` in TypeScript (ISO-on-TCP, lettura/scrittura, SZL, elenco blocchi, carica nel/dal dispositivo, RUN/STOP), come strumento interno a riga di comando, senza interfaccia; raccolta dei blocchi reali | 1A (può partire in parallelo a 1B/1C appena c'è la CPU di prova) | Sulla CPU di prova si leggono e scrivono variabili, si scaricano dal PLC tutti i blocchi e si ricaricano identici |
| **1E Compilatore MC7** | Formato del blocco (testata, interfaccia, codice, tabella reti); codificatore AWL → MC7; decodificatore MC7 → AWL; flag know-how; *Compila* con messaggi in *Informazioni → Compila*; test di andata e ritorno e di conformità sulla CPU | 1C, 1D | Andata e ritorno identica byte per byte sui blocchi della ditta; ogni istruzione AWL supera il test di conformità sulla CPU di prova |
| **1F Completamento tappa 1** | Import/export tabelle variabili (xlsx/csv); archivia/ritira archivio (`.baapz`); progetti di riferimento; trova e sostituisci; *Opzioni → Impostazioni*; collaudo finale della tappa | 1B–1E | Tutti i criteri "Fatto quando" della tappa 1 nella spec sono verificati |

**Punto di decisione dopo 1E.** Se la CPU di prova rifiuta i blocchi generati da BaaPortal e non si trova la causa, ci si ferma e si decide insieme prima di andare avanti. È il rischio più grande del progetto, ed è per questo che si affronta subito.

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
