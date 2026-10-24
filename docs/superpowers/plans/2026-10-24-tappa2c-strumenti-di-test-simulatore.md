# Piano 2C — Strumenti di test sul simulatore — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** rendere usabile dall'app la CPU simulata dei piani 2A e 2B. L'utente:
- avvia la simulazione e carica il programma nel simulatore con lo stesso percorso del PLC;
- comanda la CPU dal pannello: RUN, STOP, cancellazione totale, diagnostica, stack di chiamata;
- forza gli ingressi e vede le uscite dal pannello I/O;
- osserva il programma AWL in esecuzione (RLO, STA, ACCU1, ACCU2, parola di stato per riga);
- crea tabelle di controllo con cui osservare e modificare gli operandi.

**Architettura:**
- **Worker:** la CPU simulata gira in un **Web Worker** del renderer (spec §7: «Worker separati per compilatore e simulatore»). Il worker ospita `SimCpu`, il suo server S7 in memoria e il client S7. Il ciclo gira a tempo, con un orologio reale e il tempo minimo di ciclo.
- **Host puro:** la logica sta in una classe pura, `SimHost`, provata in node senza Worker. Il file del worker si limita a collegare `postMessage`.
- **Client nel renderer:** `SimSession` parla con il worker attraverso un protocollo tipato, con richieste e risposte numerate più notifiche.
- **Caricamento nel simulatore:** "Carica nel dispositivo", con la simulazione attiva, compila le modifiche e poi carica i blocchi uno a uno con `S7WriteClient.downloadBlock` dentro il worker. È lo stesso protocollo del PLC vero.
- **Osservazione:** il compilatore restituisce una tabella da offset MC7 a (rete, riga). Il simulatore registra uno stato per istruzione del blocco osservato e lo manda al renderer, al più ogni 200 ms. Il renderer lo mostra con una colonna per riga nell'editor AWL di ogni rete.
- **Tabelle di controllo:** sono un nuovo oggetto del progetto, salvato nel file `.baap` (formato 4, con migrazione), con il suo editor.

**Tecnologie:** TypeScript, React 19, zustand, CodeMirror 6, Electron/electron-vite (Worker con `new URL(…, import.meta.url)`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:
- §9 Tappa 2: pannello di comando CPU nella task card Test, pannello I/O del simulatore, osservazione AWL, tabelle di controllo sul simulatore, «Carica nel simulatore come se fosse un PLC»;
- §7: Worker separati;
- §8.2: tabelle di controllo e forzamento nell'albero;
- §8.4: modalità online.

Piano generale: riga 2C. Semantica del simulatore: `docs/protocollo/sim.md`.

## Global Constraints

- **Lingua:** tutta l'interfaccia è in italiano, con le chiavi in `packages/ui/src/i18n/it.json`. Si segue lo stile di TIA Portal dove ha senso: «Pannello di comando CPU», «Tabella di controllo», «Osserva tutto», «Comanda».
- **Nessun PLC vero:** in questo piano la modalità online riguarda **solo** il simulatore. "Carica nel dispositivo" senza simulazione attiva resta com'è, disabilitato. Il PLC vero arriva con la tappa 3.
- **Il worker non blocca mai l'interfaccia:**
  - il ciclo cede il controllo fra un ciclo e l'altro, con `setTimeout`, almeno ogni 10 ms di esecuzione;
  - le notifiche verso il renderer sono raggruppate, al più ogni 200 ms.
- **Forzamento permanente (FORCE):** non in questo piano. Il pannello I/O scrive gli ingressi fisici `physIn` del simulatore, che la CPU copia nella PII a ogni ciclo. È una "simulazione degli ingressi", non un forzamento.
- **Formato del file:** `FORMAT_VERSION` passa a 4. Un file 3 si apre migrandolo (senza tabelle di controllo). Un file 4 aperto da una versione vecchia è rifiutato con il messaggio già esistente per i formati più recenti.
- **Clean-room e dati:** nessun dato reale; le e2e usano progetti costruiti nel test.
- **Windows e macOS:** il Worker deve funzionare nell'app impacchettata, con la CSP `default-src 'self'` (worker dallo stesso origine, nessun `blob:`). La e2e lo prova sull'app costruita.
- **Versione:** **0.8.0**.

## Review Focus

1. **Programma cambiato mentre la simulazione gira.** Si modifica un blocco e si ricarica in RUN. Atteso: il blocco nuovo vale dal ciclo successivo; l'osservazione si aggiorna con la nuova tabella delle righe; nessuna riga vecchia mostra valori. → Task 3, Task 6.
2. **Ciclo infinito nel programma utente.** Atteso: la CPU va in STOP (TEMPO_CICLO_SUPERATO, oppure OB80); il pannello lo mostra; l'interfaccia resta reattiva. → Task 2, Task 4.
3. **Chiudere il progetto o l'app con la simulazione attiva.** Atteso: il worker termina e non resta niente in esecuzione. Riaprendo, la simulazione è spenta. → Task 3.
4. **Tabella di controllo con operandi sbagliati o fuori area.** Simbolo inesistente, `MW 99999`, DB non caricato. Atteso: riga marcata in errore con il motivo; le altre righe continuano a funzionare; "Comanda" non scrive niente sulla riga sbagliata. → Task 7.
5. **Osservazione di un blocco importato non ricompilato, o di un blocco non caricato.** Atteso: un messaggio chiaro ("osservazione non disponibile: …") invece di colonne vuote o sbagliate. → Task 6.

---

### Task 1: Tabella delle righe dal compilatore e traccia del simulatore

**Files:**
- Modify: `packages/mc7/src/encode.ts` (`encodeCode` restituisce `lines`), `packages/mc7/src/compile.ts` (`CompileResult.lines`), `packages/project/src/mc7Bridge.ts` (`blockToMc7File` passa `lines`)
- Modify: `packages/sim/src/executor.ts`, `src/cpu.ts` (`setMonitor`, stack dei blocchi nella voce di diagnostica)
- Test: `packages/mc7/test/lineMap.test.ts`, `packages/sim/test/monitor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // @baaportal/mc7
  export interface LineMapEntry { offset: number; length: number; network: number /* 0-based */; line: number /* 0-based, riga del testo della rete */ }
  // CompileResult: + lines?: LineMapEntry[]   (offset nel codice MC7, una voce per istruzione; tutte le istruzioni di una CALL espansa puntano alla riga della CALL)
  // @baaportal/sim
  export interface MonitorStep { offset: number; rlo: boolean; sta: boolean; stw: number; accu1: number; accu2: number; ar1: number; db: number; di: number }
  export interface MonitorRequest { kind: 'OB'|'FB'|'FC'; number: number }
  // SimCpu: + setMonitor(req: MonitorRequest | undefined): void; + monitorSnapshot(): MonitorStep[] | undefined   // stato DOPO l'istruzione, prima esecuzione nel ciclo
  // DiagEntry: + stack?: { kind: string; number: number; offset: number }[]   (stack dei blocchi al momento dell'errore)
  ```

Regole:
- **Tabella delle righe:** la riga è l'indice nel testo della rete come la conserva il progetto. Le righe vuote e i commenti contano, così la riga corrisponde alla riga dell'editor.
- **Istante del rilevamento:** è la **prima** esecuzione nel ciclo, l'unica registrata (⚠️: TIA può mostrare un'altra esecuzione).
- **Costo:** senza monitor attivo è zero, nessuna allocazione per istruzione.
- **Blocco ricaricato:** `setMonitor` si azzera da solo quando il blocco osservato viene ricaricato.

- [ ] **Step 1: Test:**
  - `lines di una rete con commento, etichetta, CALL espansa`
  - `ogni byte del codice appartiene a una voce`
  - `monitor di FC1: RLO e ACCU dopo ogni riga, prima esecuzione nel ciclo`
  - `monitor azzerato quando FC1 è ricaricata`
  - `nessuna traccia senza monitor`
  - `stack dei blocchi nella voce di STOP per un errore in FC2 chiamata da FC1`
- [ ] **Step 2–4:** fallire, implementare, `npx vitest run --project mc7 --project sim --project project && npm run typecheck && npm run lint && npm run format:check`
- [ ] **Step 5: Commit** — `feat(mc7,sim): tabella delle righe compilate e traccia per l'osservazione`

### Task 2: Ospite del simulatore e Worker

**Files:**
- Create: `packages/ui/src/sim/protocol.ts`, `packages/ui/src/sim/host.ts` (`SimHost`, puro), `packages/ui/src/sim/simWorker.ts` (solo collegamento), `packages/ui/src/sim/session.ts` (`SimSession`, lato renderer)
- Test: `packages/ui/test/sim/host.test.ts`, `packages/ui/test/sim/session.test.ts` (con un finto worker che fa girare `SimHost` in memoria)

**Interfaces:**
- Produces:
  ```ts
  export type SimRequest =
    | { op: 'start'; cpuTypeId: string; props: SimCpuProps }
    | { op: 'download'; files: Uint8Array[] }            // in ordine; via S7WriteClient.downloadBlock
    | { op: 'mode'; to: 'RUN' | 'STOP' } | { op: 'mres' }
    | { op: 'setInputs'; byte: number; bytes: Uint8Array } | { op: 'interrupt'; ob: 82 | 86 }
    | { op: 'monitor'; block?: MonitorRequest }
    | { op: 'watch'; items: WatchItem[] } | { op: 'write'; items: WriteItemReq[] }
    | { op: 'stop' };
  export type SimNotice = { kind: 'status'; mode: SimMode; stats: …; diagnostics: DiagEntry[]; warnings: …; inputs: Uint8Array; outputs: Uint8Array }
    | { kind: 'monitor'; block: MonitorRequest; steps: MonitorStep[] } | { kind: 'watch'; values: WatchValue[] };
  export class SimSession { static start(o): Promise<SimSession>; request<T>(r: SimRequest): Promise<T>; onNotice(cb): () => void; dispose(): void }
  ```
  `WatchItem` / `WatchValue` / `WriteItemReq` usano un operando già risolto: area, db, byte, bit, dimensione, formato.

Regole:
- **Ciclo:** in RUN, `cycle()` gira finché sono passati `minCycleMs`. Poi si cede con `setTimeout(0)` almeno ogni 10 ms di esecuzione; per il resto si attende fino al prossimo ciclo. L'orologio è `performance.now()`.
- **Notifiche:**
  - `status` al più ogni 200 ms, e subito a ogni cambio di modo;
  - `monitor` e `watch` al più ogni 200 ms, solo se richiesti.
- **Download:** passa da `connectToSim` + `downloadBlock` per ogni file. Un errore su un file interrompe e lo riporta con il nome del blocco.
- **`stop`:** termina tutto; il Worker si chiude con `terminate()`.

- [ ] **Step 1: Test con `SimHost` in node e un orologio iniettato:**
  - `start, download di OB1, RUN, cicli, status con modo RUN`
  - `setInputs → uscite al ciclo dopo`
  - `ciclo infinito → STOP con TEMPO_CICLO_SUPERATO, l'ospite resta reattivo`
  - `monitor e watch limitati a una notifica ogni 200 ms`
  - `download di un file corrotto → errore con il blocco`
  - `SimSession: richiesta/risposta numerate, dispose termina il worker`
- [ ] **Step 2–4:** come sopra, con `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): ospite del simulatore in un Worker`

### Task 3: Comandi online sul simulatore

**Files:**
- Modify: `packages/ui/src/state/store.ts` (stato `sim`: spento | avvio | attivo, con il dispositivo, l'ultimo `status`, gli errori), `src/commands/commands.ts` (`online.simulation` come interruttore; `online.download`, `online.startCpu`, `online.stopCpu` abilitati con la simulazione attiva), `src/project/StatusBar.tsx` (indicatore «Simulazione: RUN/STOP»), il percorso di chiusura del progetto e dell'app (`dispose`)
- Create: `packages/ui/src/sim/downloadOrder.ts` (ordine di caricamento)
- Test: `packages/ui/test/sim/commands.test.ts`, `downloadOrder.test.ts`

Regole:
- **Simulazione:** si avvia per il dispositivo selezionato, con la CPU del catalogo e le proprietà del progetto (ciclo, merker di clock, ritentività, OB35).
- **«Carica nel dispositivo»:**
  - compila le modifiche con `compileProgram`; se ci sono errori, si ferma e mostra la compilazione;
  - carica tutti i blocchi compilati validi in quest'ordine: DB e DB di istanza, poi FC, FB e infine gli OB (per numero dentro ogni gruppo);
  - un blocco importato e non modificato si carica con i suoi byte originali.
- **RUN dopo il caricamento:** se la CPU era in STOP prima del caricamento, si chiede «Avviare la CPU?» (Sì/No), come TIA.
- **Chiusura:** chiudere il progetto, cambiare progetto o chiudere la finestra spegne la simulazione.

- [ ] **Step 1: Test:**
  - `ordine di caricamento`
  - `download bloccato da errori di compilazione`
  - `startCpu/stopCpu cambiano il modo`
  - `chiusura del progetto → dispose`
  - `comandi disabilitati senza simulazione`
- [ ] **Step 2–4.**
- [ ] **Step 5: Commit** — `feat(ui): simulazione, carica nel simulatore, avvia e arresta la CPU`

### Task 4: Pannello di comando CPU e stack di chiamata

**Files:**
- Create: `packages/ui/src/project/taskcards/CpuPanel.tsx`, `CallStack.tsx`
- Modify: `TaskCards.tsx` (sezioni `cpuPanel`, `callStack`), `it.json`
- Test: `packages/ui/test/taskcards/cpuPanel.test.tsx`

Regole:
- **LED** RUN (verde), STOP (giallo), SF (rosso se l'ultima voce di diagnostica è un errore), con le scritte.
- **Pulsanti:** RUN, STOP e MRES. MRES è attivo solo in STOP e chiede conferma.
- **Dati:** tempo di ciclo ultimo, minimo e massimo; buffer di diagnostica (dal più recente, con ora, codice e testo in italiano, blocco e offset); avvisi «non simulata».
- **Stack di chiamata:** mostra lo `stack` dell'ultima voce di STOP per errore. Un clic su una voce apre il blocco.
- **Senza simulazione:** il pannello dice «Avvia la simulazione per usare il pannello».

- [ ] **Step 1–4:** test di render con uno store finto; testi da `it.json`.
- [ ] **Step 5: Commit** — `feat(ui): pannello di comando CPU e stack di chiamata`

### Task 5: Pannello I/O del simulatore

**Files:**
- Create: `packages/ui/src/project/taskcards/IoPanel.tsx`
- Modify: `TaskCards.tsx` (nuova sezione `ioPanel` nella task card Test), `it.json`
- Test: `packages/ui/test/taskcards/ioPanel.test.tsx`

Regole:
- **Byte mostrati:** quelli usati dalle variabili del progetto (tabelle delle variabili, aree I e Q), più quelli aggiunti a mano («+ byte»). Per ogni byte si vedono 8 bit con il simbolo, se c'è.
- **Ingressi:** un clic commuta il bit, che va in `setInputs`.
- **Uscite:** in sola lettura, dalla notifica `status`.
- **Parole e analogici:** un campo per una parola (PIW) in decimale.
- **«Simula guasto»:** OB82 e OB86 via `interrupt`.

- [ ] **Step 1–4.**
- [ ] **Step 5: Commit** — `feat(ui): pannello I/O del simulatore`

### Task 6: Osservazione del programma AWL

**Files:**
- Create: `packages/ui/src/editors/awl/monitorExtension.ts` (StateField + StateEffect + gutter o widget di fine riga)
- Modify: `AwlEditor.tsx` (estensione opzionale), `editors/block/NetworksView.tsx`, la barra dell'editor del blocco (pulsante «Osserva on/off», comando `online.monitor` con l'icona degli occhiali), `store.ts` (righe dei blocchi compilati: `compile.lines[blockId]`)
- Test: `packages/ui/test/editors/monitorExtension.test.ts`

Regole:
- **Accensione:** con la simulazione attiva e il blocco aperto, «Osserva» manda `monitor` con il blocco e mostra, riga per riga, le colonne RLO, STA, ACCU1 e ACCU2 (esadecimale o decimale, secondo un'impostazione) e STW.
- **Righe non eseguite** in questo ciclo: grigie, senza valori.
- **Osservazione non disponibile** se il blocco:
  - non è compilato con le modifiche correnti, cioè il suo hash non coincide;
  - non è caricato nel simulatore;
  - è importato senza righe.

  Il messaggio dice il motivo.
- **Modifica del testo:** l'osservazione si sospende fino al nuovo caricamento.
- **Una CALL espansa:** mostra lo stato dopo l'ultima istruzione della sua sequenza.

- [ ] **Step 1–4.**
- [ ] **Step 5: Commit** — `feat(ui): osservazione del programma AWL nel simulatore`

### Task 7: Tabelle di controllo

**Files:**
- Modify: `packages/project/src/model.ts` (`PlcDevice.watchTables: WatchTable[]`), `baapFile.ts` (formato 4 e migrazione da 3), il controllo del progetto (`checks.ts`)
- Modify: `packages/ui/src/project/navigation/treeModel.ts` (cartella `watch` abilitata: aggiungi, rinomina, elimina), `state/workArea.ts` (`EditorKind` + `'watchTable'`), `editors/registry.tsx`
- Create: `packages/ui/src/editors/watch/WatchTableView.tsx`, `watchRows.ts` (risoluzione degli operandi)
- Test: `packages/project/test/watchTables.test.ts`, `packages/ui/test/editors/watchTable.test.tsx`

**Interfaces:**
- Produces: `interface WatchTable { id: string; name: string; rows: WatchRow[] }` e `interface WatchRow { id: string; operand: string /* simbolo o indirizzo, come scritto */; format: 'BOOL'|'DEC'|'HEX'|'BIN'|'CHAR'|'FLOAT'|'S5TIME'|'TIME'|'BCD'; modify?: string; comment?: string }`.

Regole:
- **Operandi:** simboli delle variabili e dei DB (`"Motore".velocita`), indirizzi I, Q, M, DB…DBX/B/W/D, PIW e PQW, T e C. La risoluzione usa gli stessi servizi dell'editor AWL.
- **Formato:** quello predefinito segue il tipo.
- **Colonne:**
  - nome;
  - indirizzo;
  - formato visualizzazione;
  - valore di stato, in sola lettura, dalla notifica `watch`;
  - valore di comando, modificabile e validato per il formato;
  - commento.
- **Pulsanti:** «Osserva tutto» (on/off) e «Comanda» (una volta: scrive i valori di comando delle righe valide con `write`).
- **Errori:** una riga non valida mostra il motivo e non blocca le altre.
- **Salvataggio:** le tabelle vanno nel file; gli annulla e ripristina passano dallo store come per le altre tabelle.

- [ ] **Step 1: Test:**
  - `migrazione 3→4`
  - `salva/riapri una tabella`
  - `risoluzione di simbolo, indirizzo, DB, T/C`
  - `riga non valida`
  - `osserva e comanda con una SimSession finta`
- [ ] **Step 2–4:** `--project project --project ui`.
- [ ] **Step 5: Commit** — `feat(project,ui): tabelle di controllo sul simulatore`

### Task 8: E2E, documentazione, limiti noti, versione

**Files:**
- Create: `apps/desktop/e2e/tappa2-fatto-quando.spec.ts`
- Modify:
  - `docs/protocollo/sim.md`: ospite, Worker, protocollo, osservazione;
  - `docs/limiti-noti.md`: sezione "Strumenti di test (piano 2C)";
  - il manuale utente, se esiste una pagina per la task card Test (altrimenti `docs/uso/simulatore.md`, breve);
  - il piano generale: riga 2C → fatto e tappa 2 chiusa, salvo la conformità su CPU reale;
  - `apps/desktop/package.json` 0.8.0 e `package-lock.json`.

Regole della e2e, sull'app costruita (come le altre e2e):
- nuovo progetto, CPU 315-2 PN/DP;
- OB1 in AWL: `A I 0.0` / `= Q 4.0`, più un contatore su `I 0.1`;
- Simulazione → Carica nel dispositivo → Avvia → pannello I/O: I 0.0 = 1 → Q 4.0 = 1;
- l'osservazione dell'OB1 mostra RLO = 1 sulla riga `= Q 4.0`;
- una tabella di controllo con MW 10: si comanda 1234 e si legge 1234;
- STOP e LED;
- chiusura del progetto e simulazione spenta.

**Limiti noti:**
- l'osservazione rileva la prima esecuzione nel ciclo;
- nessun FORCE;
- il tempo di ciclo del Worker non è quello di una CPU vera;
- nessun PLC vero fino alla tappa 3;
- blocchi importati non ricompilati non osservabili.

**Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 1–3:** e2e, documenti, collaudo.
- [ ] **Step 4: Commit** — `docs: piano 2C — strumenti di test sul simulatore, versione 0.8.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Un Web Worker nel renderer, non utilityProcess** (spec §7). Il simulatore è TypeScript puro e non ha bisogno di node. Il Worker evita nuovi canali IPC e non blocca l'interfaccia. *Se fosse sbagliato:* `SimHost` è puro e si sposta in un utilityProcess cambiando solo il trasporto.
- **R2. La tabella delle righe viene dal compilatore**, non da una nuova decodifica. Il compilatore sa quale riga ha prodotto quali byte, anche per le CALL espanse. *Se fosse sbagliato:* per i blocchi importati si aggiunge la stessa tabella a `decodeCode`.
- **R3. L'osservazione registra la prima esecuzione nel ciclo.** È deterministica e costa poco. ⚠️ Una CPU vera ha le sue regole di rilevamento. *Se fosse sbagliato:* si aggiunge un'opzione «ultima esecuzione».
- **R4. Il pannello I/O simula gli ingressi fisici, non forza.** FORCE è una funzione di manutenzione della tappa 7. *Se fosse sbagliato:* si aggiunge una maschera di forzamento in `SimCpu`.
- **R5. Le tabelle di controllo funzionano solo sul simulatore in questo piano.** Il modello e l'editor sono già quelli definitivi; il PLC vero si aggancia nella tappa 3 con lo stesso `watch`/`write`. *Se fosse sbagliato:* niente da rifare.
