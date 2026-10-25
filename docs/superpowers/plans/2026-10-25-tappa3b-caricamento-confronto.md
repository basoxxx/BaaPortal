# Piano 3B — Caricamento, confronto e comando della CPU — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** dopo il collegamento in sola lettura del piano 3A, l'app scrive nel PLC vero. Ogni scrittura chiede una conferma esplicita. L'utente:

- confronta il progetto con la CPU: ogni blocco è uguale, diverso, solo nel progetto o solo nella CPU, e lo vede nell'albero e in un editor di confronto;
- carica nel dispositivo l'intero programma o i blocchi scelti, con una finestra di confronto che dice cosa cambia;
- porta la CPU in RUN o in STOP, copia la RAM nella ROM e comprime la memoria;
- carica dal dispositivo e crea un progetto nuovo con i blocchi della CPU, in AWL.

**Architettura:**

- **Protocollo** (`@baaportal/s7comm`): `S7WriteClient` impara `_DELE` (cancella blocco), `_MODU` (copia RAM→ROM) e `_GARB` (comprimi), con le codifiche documentate in `docs/protocollo/s7comm.md` §10.5 e §11.3 e i vettori §17.11. Il filtro `online-write` li ammette, uno per uno e byte per byte.
- **Scritture nel main:** un servizio `PlcWriteService` apre un collegamento `S7WriteClient` per ogni operazione e lo chiude alla fine. Il collegamento di sorveglianza del 3A resta in sola lettura.
- **Conferma nel main:** ogni operazione che scrive mostra una finestra di conferma nativa (`dialog.showMessageBox`) dal processo principale, con il riassunto di cosa farà. Il renderer non può saltarla.
- **Confronto:** il main legge l'elenco dei blocchi della CPU e le loro informazioni (lunghezze, checksum, data). Il renderer le confronta con i file MC7 compilati del progetto.
- **Caricamento dal dispositivo:** si caricano tutti i blocchi OB, FB, FC e DB con `uploadWithInfo`. Il progetto nuovo si costruisce con `planImport`/`applyImport` di `@baaportal/project` (`mc7Bridge.ts`), come l'importazione esistente.

**Tecnologie:** TypeScript, Electron (main, IPC, `dialog`), React 19, zustand, CodeMirror 6 (vista di confronto), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §9 Tappa 3: «Carica nel dispositivo, con finestra di confronto e conferma, anche di singoli blocchi»; «Carica dal dispositivo»; «Confronto online/offline con simboli nell'albero ed editor di confronto»; «RUN / STOP / cancellazione totale; copia RAM in ROM; compressione»;
- §5 Sicurezza sulle macchine;
- §8.4 Modalità online.

Piano generale: riga 3B. Protocollo: `docs/protocollo/s7comm.md` §9–§11, §15.

## Global Constraints

- **Conferma per ogni scrittura:**
  - ogni operazione che modifica la CPU (caricamento, cancellazione, RUN, STOP, RAM→ROM, compressione) passa da una finestra nativa del main;
  - la finestra nomina la CPU (modulo e indirizzo) e l'operazione;
  - il pulsante predefinito è «Annulla».
- **Un collegamento in scrittura per operazione:** si apre, si esegue, si chiude. Nessun collegamento in scrittura resta aperto.
- **Nessuna ripetizione automatica:** un caricamento o un comando interrotto non si ripete da solo, e l'errore si mostra con il blocco a cui si è fermato.
- **Cancellazione totale (MRES):** non esiste un servizio documentato per farla da remoto su una S7-300. Il pulsante resta disabilitato per il PLC vero, con la spiegazione «Usa il selettore della CPU (MRES)», e lo dicono anche i limiti noti.
- **Mai provato su una CPU reale:** i test usano il PLC di prova locale (server S7 + CPU simulata). I limiti noti e le note di rilascio lo dicono.
- **Lingua e testi:** italiano, con i termini di TIA Portal («Carica nel dispositivo», «Carica dal dispositivo», «Confronto online/offline», «Copia RAM in ROM», «Comprimi»). Le chiavi in `it.json` ed `en.json` sono uguali.
- **Clean-room e dati:** nessun dato reale; nei test e nei documenti solo IP di documentazione e 127.0.0.1.

## Review Focus

1. **Caricamento interrotto a metà** (cavo, CPU che rifiuta un blocco): l'app si ferma, dice quali blocchi sono stati caricati e quale ha fallito, e non lascia un collegamento aperto. → test in Task 2 e Task 4.
2. **CPU in RUN durante il caricamento di un OB:** la finestra lo dice e propone di portarla in STOP, con una seconda conferma. Non la ferma mai da sola. → test in Task 4.
3. **Il renderer chiama un canale di scrittura senza passare dalla UI:** la conferma nativa del main compare comunque, e senza «Sì» non parte nulla. → test in Task 2.
4. **Blocco solo nella CPU durante il caricamento:** non si cancella mai da solo. La cancellazione è una scelta esplicita nella finestra di confronto, spenta in partenza. → test in Task 4.
5. **Caricamento dal dispositivo di un blocco che il decodificatore non sa leggere:** il blocco entra comunque nel progetto come importato, con i byte originali, e una nota spiega perché. Il resto continua. → test in Task 6.

---

### Task 1: Servizi `_DELE`, `_MODU` e `_GARB`

**Files:**

- Modify:
  - `packages/s7comm/src/s7/control.ts`: codifiche e decodifiche;
  - `packages/s7comm/src/writeClient.ts`: `deleteBlock(type, number)`, `copyRamToRom()`, `compressMemory()`;
  - `packages/s7comm/src/readOnlyGuard.ts`: `assertOnlineWrite` ammette i tre servizi, ciascuno solo nella sua forma canonica;
  - `packages/s7-server`: il server di prova li gestisce, e la CPU simulata cancella il blocco;
  - `docs/protocollo/s7comm.md`: §10.5, che diventa «verificato contro il server di prova, non su CPU reale».
- Test: `packages/s7comm/test/control.test.ts`, `packages/s7comm/test/readOnlyGuard.test.ts`, `packages/s7-server/test/…`

Regole:

- **Codifiche:** byte per byte, dai vettori §17.11 per `_MODU` e `_GARB`. Per `_DELE` si segue la struttura di §10.5: subfun `0x42`, argomento con il tipo di blocco e il numero come in `_INSE`, filesystem `P`.
- **Filtro:** in `read-only` i tre servizi restano FORBIDDEN, e c'è un test che lo controlla.
- **Risposte:** si decodificano come `ControlResult`. Un codice diverso da 0 diventa `S7Error('CPU_ERROR')` con il nome del codice.

- [ ] **Step 1: Test**
  - `_MODU e _GARB uguali ai vettori §17.11`
  - `_DELE OB1 canonico`
  - `online-write ammette i tre servizi canonici e rifiuta una variante non canonica`
  - `read-only li rifiuta`
  - `deleteBlock contro il server di prova toglie il blocco dalla lista`
- [ ] **Step 2–4:** `--project s7comm --project s7-server`.
- [ ] **Step 5: Commit** — `feat(s7comm): cancella blocco, copia RAM in ROM e comprimi`

### Task 2: Scritture nel processo principale con conferma nativa

**Files:**

- Create: `apps/desktop/src/main/plc/plcWrite.ts`, `apps/desktop/src/main/plc/confirm.ts`
- Modify: `plcIpc.ts`, il preload, `packages/ui/src/bridge.ts`, `packages/ui/src/online/plcTypes.ts`
- Test: `apps/desktop/test/plc/plcWrite.test.ts`

**Interfaces:**

- `PlcWriteService` con:
  - `download(owner, files: Uint8Array[], opts: { deleteBlocks?: {type, number}[] }) → { ok: true; loaded: string[] } | { ok: false; loaded: string[]; failedAt?: string; error: string } | { ok: false; cancelled: true }`;
  - `control(owner, op: 'RUN' | 'STOP' | 'COPY_RAM_TO_ROM' | 'COMPRESS') → { ok: true; result } | { ok: false; error } | { ok: false; cancelled: true }`.
- Confirmation: `confirm(owner, texts: { title; message; detail; confirmLabel }) → Promise<boolean>` is injectable in tests. The real implementation is `dialog.showMessageBox` with `defaultId` on «Annulla» and `cancelId` on «Annulla».
- Progress: event `plc:writeProgress` `{ done, total, current }`.

Regole:

- **Bersaglio:** `PlcWriteService` usa l'`access` del collegamento online attivo della stessa finestra, preso dal `PlcService` del 3A. Senza collegamento online risponde `{ ok:false, error:'Nessun collegamento online' }`, e il renderer non può passare un indirizzo diverso.
- **Ordine:** prima la conferma, poi il collegamento `connectWriteTcp`. Poi:
  1. i blocchi da cancellare;
  2. i file nell'ordine ricevuto;
  3. la chiusura nel `finally`.
- **Errori:** al primo errore ci si ferma e il risultato dice quali blocchi sono stati caricati e quale ha fallito.
- **Una sola scrittura per finestra:** una seconda richiesta durante una scrittura in corso riceve `{ ok:false, error:'Operazione già in corso' }`.
- **Annullamento:** la finestra distrutta durante la scrittura interrompe al prossimo blocco e chiude il collegamento.

- [ ] **Step 1: Test**
  - `senza conferma non si apre nessun collegamento`
  - `download contro il PLC di prova: i blocchi arrivano e la CPU li ha`
  - `errore al secondo blocco → loaded = [primo], failedAt = secondo, collegamento chiuso`
  - `RUN e STOP contro il PLC di prova`
  - `COPY_RAM_TO_ROM e COMPRESS contro il PLC di prova`
  - `seconda richiesta durante la prima → già in corso`
  - `senza collegamento online → errore`
  - `il testo della conferma nomina modulo e indirizzo`
- [ ] **Step 2–4:** `--project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(desktop): scritture nel PLC con conferma nativa`

### Task 3: Confronto online/offline

**Files:**

- Create:
  - `apps/desktop/src/main/plc/onlineBlocks.ts`: elenco e informazioni dei blocchi, in sola lettura, sul collegamento del 3A;
  - `packages/ui/src/online/compare.ts`: confronto puro.
- Modify:
  - `plcIpc.ts` (`plc:blocks`), il bridge, `store.ts` (`online.compare`);
  - l'albero del progetto: icone di confronto sui blocchi quando si è online;
  - `i18n`.
- Test: `packages/ui/test/online/compare.test.ts`, `apps/desktop/test/plc/onlineBlocks.test.ts`

**Interfaces:**

- `listOnlineBlocks(owner) → { ok: true; blocks: OnlineBlock[] } | { ok: false; error }` with `OnlineBlock = { type: 'OB'|'FB'|'FC'|'DB'|'SFC'|'SFB'|'SDB'; number: number; loadLength: number; mc7Length: number; checksum: number; codeTime?: string }`.
- `compareBlocks(project: { id; type; number; file?: Uint8Array }[], online: OnlineBlock[]) → CompareRow[]` with `CompareRow = { type; number; blockId?: string; state: 'same' | 'different' | 'offlineOnly' | 'onlineOnly' | 'notCompiled' }`.
  - `same` means identical checksum and MC7 length, read from the header of the compiled file.
  - System blocks (SFC, SFB, SDB) are left out of the comparison.

Regole:

- **Quando si confronta:** il confronto parte da solo al collegamento online, e su richiesta con il comando «Confronta» (`online.compare`). Non parte a ogni modifica.
- **Blocco modificato dopo il confronto:** risulta `notCompiled` finché non è compilato. Si usa lo stesso controllo dell'impronta attuale del piano 2C (`hashOf`/`contextHashOf`).
- **Icone nell'albero, come in TIA:**
  - cerchio verde: uguale;
  - cerchio pieno arancione: diverso;
  - mezzo cerchio: solo nel progetto o solo nella CPU;
  - icona grigia: non compilato.
    I blocchi «solo nella CPU» compaiono in una sottocartella «Solo online».

- [ ] **Step 1: Test**
  - `compareBlocks: uguale, diverso per checksum, diverso per lunghezza, solo progetto, solo CPU, non compilato, SFC escluse`
  - `listOnlineBlocks contro il PLC di prova`
  - `le icone compaiono online e spariscono offline`
  - `modifica dopo il confronto → notCompiled`
- [ ] **Step 2–4:** `--project ui --project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(desktop,ui): confronto online/offline nell'albero`

### Task 4: Carica nel dispositivo (PLC vero)

**Files:**

- Create: `packages/ui/src/dialogs/DownloadPreviewDialog.tsx`, `packages/ui/src/online/plcDownload.ts`
- Modify: il comando `online.download`, abilitato anche con il PLC online; il menu contestuale dei blocchi, «Carica nel dispositivo» per i blocchi selezionati; `i18n`.
- Test: `packages/ui/test/online/plcDownload.test.ts`, `packages/ui/test/online/downloadPreview.test.tsx`

Regole:

- **Prima di caricare:**
  - si compilano le modifiche con la stessa funzione del 2C;
  - si controlla l'impronta attuale, e un blocco non attuale ferma tutto;
  - si confronta (Task 3).
- **Finestra di anteprima «Carica nel dispositivo», come in TIA:**
  - una riga per blocco, con lo stato (nuovo, diverso, uguale) e l'azione: «Carica», oppure «Nessuna azione» per gli uguali;
  - i blocchi solo nella CPU con l'azione «Cancella» SPENTA in partenza;
  - un avviso se la CPU è in RUN e il caricamento contiene OB o cambia l'interfaccia di un FB o di un DB, con la scelta «Arresta la CPU» (spenta);
  - i pulsanti «Carica» e «Annulla».
- **Ordine:** si usa `downloadOrder.ts` del 2C (DB e istanze prima, OB per ultimi).
- **Esecuzione:**
  - se è stata scelta «Arresta la CPU», prima c'è `control('STOP')`, con la sua conferma nativa;
  - poi `download(files, { deleteBlocks })`, con la sua conferma nativa;
  - alla fine la domanda «Avviare la CPU?», che se accettata esegue `control('RUN')` con la conferma nativa;
  - poi un nuovo confronto.
- **Avanzamento:** si mostra con `plc:writeProgress`. Gli errori mostrano i blocchi caricati e quello fallito.
- **Esclusione:** con la simulazione attiva il comando resta quello del 2C. Le due strade non si mescolano.

- [ ] **Step 1: Test**
  - `anteprima: nuovo, diverso, uguale, solo CPU con Cancella spenta`
  - `RUN con un OB → avviso e Arresta spento`
  - `Annulla nell'anteprima → nessuna chiamata al bridge`
  - `ordine dei file come downloadOrder`
  - `errore a metà → messaggio con caricati e fallito`
  - `blocchi selezionati nell'albero → solo quelli`
  - `blocco non attuale → stop prima dell'anteprima`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): carica nel dispositivo con anteprima di confronto`

### Task 5: Comandi della CPU dal pannello

**Files:**

- Modify:
  - `CpuPanel.tsx`, che con il PLC vero perde lo stato «sola lettura»: RUN e STOP diventano attivi e MRES resta disabilitato con la spiegazione;
  - i comandi `online.startCpu` e `online.stopCpu`, abilitati anche con il PLC online;
  - nuovi comandi `online.copyRamToRom` e `online.compress`, nel menu Online e nel pannello;
  - `i18n`.
- Test: `packages/ui/test/online/cpuCommands.test.tsx`

Regole:

- **Dove va il comando:** ogni comando chiama `bridge.plcControl(op)`, e la conferma è quella nativa.
- **Dopo un comando:** si aspetta il prossimo evento `mode` della sorveglianza e non si forza lo stato nello store.
- **Errori e annullamento:** gli errori compaiono come messaggio. «Annulla» nella conferma non fa comparire nessun messaggio.

- [ ] **Step 1: Test**
  - `RUN e STOP chiamano plcControl`
  - `MRES disabilitato con la spiegazione`
  - `copia RAM in ROM e comprimi`
  - `annullato → nessun messaggio`
  - `errore → messaggio`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): RUN, STOP, copia RAM in ROM e comprimi sul PLC`

### Task 6: Carica dal dispositivo in un progetto nuovo

**Files:**

- Create:
  - `apps/desktop/src/main/plc/uploadAll.ts`: in sola lettura, sul collegamento del 3A, e senza bisogno di essere online nel progetto (usa un `access` dato dalla finestra «Dispositivi accessibili»);
  - `packages/ui/src/online/uploadProject.ts`.
- Modify:
  - la finestra «Dispositivi accessibili» (pulsante «Carica dal dispositivo»);
  - il menu Online (`online.upload`);
  - bridge e IPC (`plc:uploadAll` con avanzamento `plc:uploadProgress`);
  - `i18n`.
- Test: `apps/desktop/test/plc/uploadAll.test.ts`, `packages/ui/test/online/uploadProject.test.ts`

Regole:

- **Cosa si carica:** il main carica OB, FB, FC e DB con `uploadWithInfo`, lascia fuori SFC, SFB e SDB, e manda i file. Il caricamento si può interrompere.
- **Progetto nuovo:**
  - il renderer crea un progetto senza nome, con la CPU trovata nel catalogo dal numero di ordinazione, oppure con una CPU generica se non è nel catalogo, più un avviso;
  - importa i blocchi con `planImport`/`applyImport`;
  - salva l'`access` nella CPU.
- **Blocco che non si decodifica:** entra come importato con i byte originali, più una nota. Così prevede il modello del 2C.
- **Progetto aperto con modifiche:** prima di sostituirlo compare la domanda di salvataggio esistente.

- [ ] **Step 1: Test**
  - `uploadAll contro il PLC di prova con OB1, FC1, DB1 → tre file`
  - `interruzione → nessun progetto creato`
  - `progetto nuovo con la CPU del catalogo e i blocchi in AWL`
  - `CPU sconosciuta → CPU generica e avviso`
  - `blocco non decodificabile → importato con nota`
  - `andata e ritorno: carica dal dispositivo e poi confronta → tutti uguali`
- [ ] **Step 2–4:** `--project ui --project @baaportal/desktop --project project`.
- [ ] **Step 5: Commit** — `feat(desktop,ui): carica dal dispositivo in un progetto nuovo`

### Task 7: Editor di confronto

**Files:**

- Create: `packages/ui/src/editors/compare/CompareView.tsx`
- Modify:
  - `state/workArea.ts` (`EditorKind` `'compare'`);
  - `editors/registry.tsx`;
  - il menu contestuale dei blocchi «Confronta online/offline», abilitato per i blocchi `different`;
  - `i18n`.
- Test: `packages/ui/test/editors/compareView.test.tsx`

Regole:

- **Contenuto:**
  - il main carica il blocco online (`plc:uploadBlock`, in sola lettura);
  - il renderer lo decodifica in AWL con lo stesso percorso dell'importazione;
  - la vista mostra a sinistra il progetto e a destra la CPU, con le reti affiancate e le righe diverse evidenziate.
- **Sola lettura:** la vista non modifica nulla.
- **Dati di intestazione:** sopra si vedono checksum, lunghezze e date dei due lati.

- [ ] **Step 1: Test**
  - `le righe diverse sono evidenziate`
  - `reti in più su un lato`
  - `blocco online non decodificabile → si mostra in esadecimale con la nota`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): editor di confronto online/offline`

### Task 8: E2E, documenti, limiti noti, versione

**Files:**

- Create: `apps/desktop/e2e/plc-scrittura.spec.ts`
- Modify: `docs/uso/online.md` (caricamento, confronto, comandi, carica dal dispositivo), `docs/limiti-noti.md` (sezione "Caricamento e confronto (piano 3B)"), il piano generale (riga 3B), `apps/desktop/package.json` 0.10.0 e `package-lock.json`.

Regole della e2e, sull'app costruita, con il PLC di prova avviato nel processo di Playwright:

- **Conferme:** la finestra nativa di conferma va pilotata. Nel main si aggiunge un aggancio di test attivo solo con `BAAPORTAL_E2E_CONFIRM=yes|no` e `!app.isPackaged`, che risponde senza mostrare la finestra. Un test controlla che nell'app impacchettata l'aggancio non esista.
- **Percorso:**
  1. progetto con OB1 `A I 0.0` / `= Q 4.0`;
  2. collegamento;
  3. confronto: OB1 «solo nel progetto»;
  4. carica nel dispositivo;
  5. confronto: «uguale»;
  6. STOP, poi RUN, con i LED che seguono.
- **Modifica:** si modifica OB1 e il confronto dà «diverso». L'editor di confronto mostra la riga cambiata.
- **Carica dal dispositivo:** crea un progetto nuovo con OB1 in AWL, e il suo confronto dà «uguale».
- **Conferma negata:** con `BAAPORTAL_E2E_CONFIRM=no` il caricamento non cambia la CPU.

**Limiti noti:**

- mai provato su una CPU reale;
- MRES non disponibile da remoto;
- il confronto usa checksum e lunghezze, non il contenuto byte per byte;
- i blocchi di sistema (SDB) non si caricano né si confrontano: il backup arriva nel 3C;
- il caricamento dal dispositivo non porta simboli né commenti.

**Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 1–3:** e2e, documenti, collaudo.
- [ ] **Step 4: Commit** — `docs: piano 3B — caricamento, confronto e comandi della CPU, versione 0.10.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. La conferma di ogni scrittura è una finestra nativa del processo principale**, oltre alle finestre del renderer. È la difesa contro un renderer difettoso (spec §5). _Se fosse sbagliato:_ una conferma in più; si può togliere quella del renderer.
- **R2. Un collegamento `online-write` per operazione**, aperto dopo la conferma e chiuso alla fine. La sorveglianza resta in sola lettura. _Se fosse sbagliato:_ qualche centinaio di ms in più per operazione.
- **R3. Il confronto usa checksum e lunghezza MC7 delle informazioni del blocco.** È veloce e non serve caricare i blocchi. ⚠️ Da verificare su CPU reale che il checksum della CPU coincida con quello del file compilato. _Se fosse sbagliato:_ il confronto carica il blocco e confronta i byte del codice.
- **R4. MRES non si fa da remoto.** Non c'è un servizio documentato nelle fonti pubbliche per una S7-300. _Se fosse sbagliato:_ si aggiunge quando una fonte pubblica lo documenta.
- **R5. Un blocco solo nella CPU non si cancella mai senza una scelta esplicita** nella finestra di anteprima.
