# Piano 3A — Online: dispositivi accessibili e collegamento — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** l'app si collega a una CPU S7-300 vera. L'utente:

- cerca i dispositivi accessibili nella sottorete, oppure scrive l'indirizzo IP a mano;
- si collega online e si scollega, con la modalità online arancione come in TIA Portal;
- vede subito chi è la CPU (modulo, numero di ordinazione, versione) e il suo stato operativo (RUN/STOP), aggiornato da solo;
- si accorge quando il collegamento cade.

In questo piano il collegamento è **in sola lettura**: nessuna scrittura nel PLC. Caricamento, RUN/STOP e cancellazione totale arrivano con il piano 3B, con conferma esplicita.

**Architettura:**

- **Rete solo nel processo principale** (spec §7). Un servizio `PlcService` in `apps/desktop/src/main/plc/` tiene i collegamenti, uno per finestra, e parla con il renderer su canali IPC `plc:*`. Il renderer non apre mai socket.
- **Protocollo:** si usa `S7Client` di `@baaportal/s7comm` (`connectTcp`), aperto in modalità `'read-only'`. Il filtro di sola lettura (`readOnlyGuard`) blocca qualunque scrittura anche per errore.
- **Ricerca:** `scanSubnet` prova la porta 102 sugli host della sottorete scelta, con molte connessioni in parallelo ma limitate. Per ogni host che risponde apre un collegamento in sola lettura e legge l'identità (SZL 0x0011) e lo stato.
- **Renderer:** un `PlcController`, gemello di `SimController` del piano 2C, tiene lo stato `online` nello store. Comandi `online.accessibleDevices`, `online.goOnline` e `online.goOffline` (già dichiarati in `commands.ts`, finora disabilitati).
- **PLC di prova:** per sviluppo, test ed e2e, un server S7 locale (`@baaportal/s7-server`, `listen`) con dietro la CPU simulata (`@baaportal/sim`, backend di `connectToSim`). Parla lo stesso protocollo di una CPU vera su TCP.

**Tecnologie:** TypeScript, Electron (main/preload/renderer, IPC), node `net` e `os`, React 19, zustand, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §9 Tappa 3: dispositivi accessibili (scansione della sottorete e IP manuale), collegamento online e interruzione, collegamento diretto (CPU PN, CP 343-1) e tramite gateway RFC 1006;
- §5 Sicurezza sulle macchine;
- §7 Processi;
- §8.4 Modalità online.

Piano generale: riga 3A. Protocollo: `docs/protocollo/s7comm.md`.

## Global Constraints

- **Lingua:** l'interfaccia è in italiano, con i testi in `packages/ui/src/i18n/it.json` (e `en.json`, con le stesse chiavi). Si usano i termini di TIA Portal: «Dispositivi accessibili», «Collegamento online», «Interrompi collegamento online», «Avvia ricerca».
- **Sola lettura:** ogni collegamento di questo piano usa `mode: 'read-only'`. Nessuna funzione di questo piano scrive nel PLC.
- **Rete solo nel main:** nessun `net`, `fetch` verso PLC o WebSocket nel renderer. I canali IPC passano dal controllo `trusted` già presente in `ipc.ts`.
- **Ricerca solo su richiesta:**
  - la sottorete si scandisce solo quando l'utente preme «Avvia ricerca», mai da sola;
  - al più 1024 host, al più 32 connessioni aperte insieme, 400 ms di attesa per la porta 102;
  - si può interrompere in ogni momento.
- **Un solo bersaglio:** simulazione e PLC vero si escludono. Con la simulazione attiva «Collegamento online» è disabilitato, e viceversa.
- **Mai provato su una CPU reale:** ogni test usa il PLC di prova locale. I limiti noti lo dicono chiaramente.
- **Clean-room e dati:** nessun dato reale; nessun indirizzo IP della ditta nei test o nei documenti (si usano 192.0.2.x, 198.51.100.x, 127.0.0.1).
- **Formato del file:** resta 4. Le nuove impostazioni di accesso sono un campo facoltativo delle proprietà CPU; un file senza il campo si apre come prima.

## Review Focus

1. **Cavo staccato durante l'online:** la CPU smette di rispondere senza chiudere il socket. Entro 5 s l'app torna offline con il messaggio «Collegamento interrotto», e la barra arancione sparisce. → test in Task 1 (trasporto finto che non risponde) e Task 4.
2. **Chiusura della finestra o del progetto mentre si è online, o durante una ricerca:** socket chiusi, nessun evento IPC verso una finestra distrutta. → test in Task 1 e Task 2.
3. **Host che risponde sulla 102 ma non è una CPU S7** (un altro dispositivo, o un CP senza CPU dietro): compare nella lista come «Dispositivo non riconosciuto» con il motivo, e non blocca la ricerca. → test in Task 2.
4. **Interfaccia di rete con maschera larga (/16) o senza IPv4:** si scandiscono al più 1024 host attorno all'indirizzo locale, e un'interfaccia senza IPv4 non compare. → test in Task 2.
5. **Indirizzo manuale scritto male** (`192.168.0.300`, spazi, nome host): un messaggio chiaro prima di tentare. Si accettano solo IPv4 con porta facoltativa. → test in Task 3.

---

### Task 1: Servizio di collegamento nel processo principale

**Files:**

- Create:
  - `apps/desktop/src/main/plc/plcService.ts`: collegamenti per finestra, stato, sorveglianza;
  - `apps/desktop/src/main/plc/plcIpc.ts`: canali `plc:connect`, `plc:disconnect`, `plc:status`, evento `plc:event`;
  - `apps/desktop/src/main/plc/testPlc.ts`: avvio del PLC di prova (solo sviluppo e test).
- Modify:
  - `apps/desktop/src/main/ipc.ts` (registrazione);
  - il preload e `packages/ui/src/bridge.ts` (metodi `plc*` tipati).
  - `packages/s7-server/src/node/listen.ts`: deve accettare un `CpuBackend` qualunque, non solo `FakeCpu`, senza cambiare gli usi esistenti.
- Test: `apps/desktop/test/plc/plcService.test.ts` (node, contro `listen` con la CPU simulata su 127.0.0.1, porta 0).

**Interfaces:**

- Produces, in un file di tipi condiviso con il renderer (es. `packages/ui/src/online/plcTypes.ts`):
  - `interface PlcAccess { host: string; port?: number; rack: number; slot: number; connectionType: 'PG' | 'OP' | 'S7_BASIC'; remoteTsap?: number }`;
  - `interface PlcIdentity { orderNumber: string; moduleName?: string; firmware?: string; serial?: string; plantId?: string }`;
  - `type PlcMode = 'RUN' | 'STOP' | 'STARTUP' | 'HOLD' | 'UNKNOWN'`;
  - `type PlcEvent = { kind: 'mode'; mode: PlcMode } | { kind: 'lost'; reason: string }`;
  - `connect(access): Promise<{ identity: PlcIdentity; mode: PlcMode; protection?: string }>`;
  - `disconnect(): Promise<void>`;
  - `status(): Promise<{ connected: boolean; access?: PlcAccess }>`.
- `PlcService.connect` usa `connectTcp(...)` con `mode: 'read-only'`, `timeoutMs` 3000. `connectionType` e `remoteTsap` passano a `ConnectOptions`. `port` serve solo al PLC di prova; il default è 102.

Regole:

- **Un collegamento per finestra.** Un secondo `connect` della stessa finestra chiude prima il precedente. La chiusura della finestra (`webContents` `destroyed`) chiude il collegamento.
- **Sorveglianza:** ogni 1000 ms `client.mode()`.
  - Un cambio di stato manda l'evento `mode`.
  - Due errori di fila, un timeout di 2000 ms sulla lettura o la chiusura del socket mandano `lost` e chiudono tutto.
  - Una sola lettura alla volta: se la precedente non è finita, il giro si salta.
- **Eventi:** mai inviati a un `webContents` distrutto.
- **Errori di `connect`:** tornano come testo leggibile, senza eccezioni grezze.
  - Host irraggiungibile: «Nessuna risposta da 192.0.2.10:102».
  - Rifiuto del collegamento COTP: «La CPU ha rifiutato il collegamento (rack/slot o TSAP)».
- **PLC di prova:** `startTestPlc({ port?: number }) => Promise<{ port: number; close(): Promise<void> }>`. Si attiva solo se la variabile d'ambiente `BAAPORTAL_TEST_PLC=1` è impostata (e2e e sviluppo). Nell'app impacchettata, senza quella variabile, non parte mai.

- [ ] **Step 1: Test**
  - `collega al PLC di prova, legge identità e stato RUN/STOP`
  - `un secondo connect chiude il primo`
  - `la sorveglianza manda mode quando la CPU passa in STOP` (si porta in STOP la CPU simulata dal lato server)
  - `CPU che non risponde → lost entro 5 s` (trasporto finto che accetta e poi tace)
  - `socket chiuso dal server → lost`
  - `finestra distrutta → collegamento chiuso, nessun evento`
  - `host irraggiungibile → messaggio leggibile`
  - `il collegamento è in sola lettura` (un tentativo di scrittura viene rifiutato dal filtro)
- [ ] **Step 2–4:** implementazione; `npx vitest run --project desktop` (o il progetto Vitest del pacchetto desktop) e `--project s7-server`.
- [ ] **Step 5: Commit** — `feat(desktop): collegamento online in sola lettura nel processo principale`

### Task 2: Ricerca dei dispositivi accessibili

**Files:**

- Create: `apps/desktop/src/main/plc/scan.ts`, `apps/desktop/src/main/plc/interfaces.ts`
- Modify: `plcIpc.ts` (canali `plc:interfaces`, `plc:scanStart`, `plc:scanCancel`, evento `plc:scanEvent`), preload, `bridge.ts`
- Test: `apps/desktop/test/plc/scan.test.ts`

**Interfaces:**

- `listInterfaces(): { name: string; address: string; netmask: string }[]`: solo IPv4, non interne. Si basa su `os.networkInterfaces()`, iniettabile nei test.
- `hostsToScan(address: string, netmask: string, max = 1024): string[]`: tutti gli host della sottorete, senza l'indirizzo di rete, il broadcast e l'indirizzo locale. Se sono più di `max`, si prendono i `max` più vicini all'indirizzo locale.
- `scanSubnet(hosts: string[], opts: { probe: (host) => Promise<boolean>; identify: (host) => Promise<PlcIdentity & { mode: PlcMode }>; concurrency?: 32; signal: AbortSignal; onFound: (d: FoundDevice) => void; onProgress: (done, total) => void }): Promise<void>`
- `type FoundDevice = { host: string; status: 'cpu'; identity: PlcIdentity; mode: PlcMode } | { host: string; status: 'unknown'; reason: string }`
- Il `probe` reale è una connessione TCP alla 102 con 400 ms di attesa. `identify` apre un collegamento in sola lettura con rack 0, slot 2 e tipo PG, legge l'identità e lo stato e chiude.

Regole:

- **Una ricerca per finestra.** Una nuova ricerca interrompe la precedente. La chiusura della finestra interrompe la ricerca.
- **Avanzamento:** al più 10 eventi al secondo, come `kit.ts`.
- **Host che apre la 102 ma non risponde come S7:** compare come `unknown`, con il motivo, e la ricerca prosegue.

- [ ] **Step 1: Test**
  - `hostsToScan /24 → 253 host senza il proprio`
  - `hostsToScan /16 → 1024 host attorno al proprio`
  - `hostsToScan /31 e /32 → vuoto`
  - `al più 32 probe insieme` (probe finto che conta)
  - `cancel ferma la ricerca e non arrivano altri onFound`
  - `host non S7 → unknown con motivo`
  - `identify reale contro il PLC di prova`
  - `listInterfaces scarta IPv6 e interne`
- [ ] **Step 2–4:** implementazione e test.
- [ ] **Step 5: Commit** — `feat(desktop): ricerca dei dispositivi accessibili nella sottorete`

### Task 3: Impostazioni di accesso e finestra «Dispositivi accessibili»

**Files:**

- Modify:
  - `packages/project/src/model.ts`: `CpuProperties.access?: PlcAccess`, con lo stesso tipo di Task 1, spostato in `@baaportal/project` se serve, e la UI che lo importa da lì;
  - lo schema di lettura in `baapFile.ts`: campo facoltativo e validato;
  - `checks.ts`: avviso se `access.host` non è un IPv4 valido.
- Create: `packages/ui/src/dialogs/AccessibleDevicesDialog.tsx`, `packages/ui/src/online/accessInput.ts` (lettura dell'indirizzo manuale)
- Test: `packages/project/test/access.test.ts`, `packages/ui/test/online/accessibleDevices.test.tsx`

Regole:

- **Contenuto della finestra:**
  - **Interfaccia PG/PC:** un elenco da `plc:interfaces`.
  - **Tipo di collegamento:** diretto (CPU PN o CP 343-1) oppure gateway RFC 1006. Per il gateway serve il TSAP remoto in esadecimale, per esempio `03.02`.
  - **Rack e slot:** valori predefiniti 0 e 2.
  - **«Avvia ricerca» e «Interrompi».**
  - **Tabella dei dispositivi trovati:** indirizzo, tipo («CPU» o «Dispositivo non riconosciuto»), modulo, numero di ordinazione, stato.
  - **Indirizzo manuale:** «Aggiungi indirizzo».
- **Indirizzo manuale:**
  - `parseAccessInput(text) => { host: string; port?: number } | { error: string }`.
  - Si accetta solo un IPv4 con porta facoltativa (`192.0.2.10`, `127.0.0.1:10102`).
  - Si rifiutano gli ottetti oltre 255, gli spazi interni e i nomi host, con un messaggio chiaro.
- **Selezione di un dispositivo:**
  - «Collega» salva l'accesso in `CpuProperties.access` della CPU scelta. È una modifica del progetto che si annulla con annulla/ripeti.
  - Poi esegue `online.goOnline`.
- **Comando:** `online.accessibleDevices` apre la finestra ed è abilitato con un progetto aperto.

- [ ] **Step 1: Test**
  - `parseAccessInput: valido, con porta, ottetto 300, spazi, nome host`
  - `access si salva e si riapre; file senza access si apre`
  - `access con host non valido → avviso dei controlli`
  - `la finestra mostra i dispositivi da eventi finti, Interrompi manda scanCancel`
  - `Collega salva access ed esegue goOnline`
- [ ] **Step 2–4:** `--project project --project ui`.
- [ ] **Step 5: Commit** — `feat(project,ui): dispositivi accessibili e impostazioni di accesso`

### Task 4: Modalità online nel renderer

**Files:**

- Create: `packages/ui/src/online/plcController.ts`
- Modify:
  - `store.ts`: stato `online`;
  - i comandi `online.goOnline` e `online.goOffline`;
  - il titolo e l'intestazione degli editor (classe `online`, arancione);
  - la barra di stato (indicatore del PLC);
  - il pannello CPU del piano 2C: con il PLC vero mostra solo i LED e l'identità, mentre RUN, STOP e MRES restano disabilitati con la spiegazione «In sola lettura»;
  - `i18n`.
- Test: `packages/ui/test/online/plcController.test.ts`, `packages/ui/test/online/onlineMode.test.tsx`

**Interfaces:**

- Consumes: `bridge.plcConnect`, `bridge.plcDisconnect` e l'evento `plc:event` (Task 1).
- Produces: `store.online: { status: 'off' | 'connecting' | 'on'; access?: PlcAccess; identity?: PlcIdentity; mode?: PlcMode; deviceId?: string }`

Regole:

- **`online.goOnline`:**
  - È abilitato con un progetto aperto, una CPU che ha `access` e la simulazione spenta. Senza `access`, apre «Dispositivi accessibili».
  - Collega la CPU del dispositivo selezionato nell'albero; se non è selezionato nulla, la prima CPU.
- **`online.goOffline`:** è abilitato quando lo stato è `on` o `connecting`.
- **Esclusione:** `online.simulation` è disabilitato quando `online.status !== 'off'`.
- **Modalità online:** la barra del titolo, l'intestazione dell'albero e quella degli editor diventano arancioni (variabile di tema `--online-accent`). La barra di stato mostra «Online: <modulo> <host>» e lo stato.
- **Identità diversa da quella del progetto:** se il numero di ordinazione della CPU collegata è diverso da quello della CPU del progetto, compare un avviso non bloccante «La CPU collegata (6ES7 …) è diversa da quella del progetto (6ES7 …)».
- **Collegamento perso:**
  - lo stato torna `off` con il messaggio «Collegamento interrotto: <motivo>»;
  - la chiusura del progetto o il cambio di progetto scollegano;
  - le risposte e gli eventi in ritardo di un collegamento vecchio si scartano, con lo stesso schema a «sessione» di `SimController`.

- [ ] **Step 1: Test**
  - `goOnline → connecting → on con identità e stato`
  - `goOnline senza access apre la finestra`
  - `esclusione con la simulazione, nei due sensi`
  - `evento mode aggiorna i LED`
  - `evento lost → off e messaggio`
  - `cambio progetto durante connecting → nessuna scrittura nello store del nuovo progetto`
  - `CPU diversa → avviso`
  - `la classe online colora titolo, albero ed editor`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): modalità online con un PLC in sola lettura`

### Task 5: E2E, documenti, limiti noti, versione

**Files:**

- Create:
  - `apps/desktop/e2e/online.spec.ts`;
  - `docs/uso/online.md`.
- Modify:
  - `docs/limiti-noti.md`: sezione "Online (piano 3A)";
  - il piano generale: riga 3A → fatto;
  - `apps/desktop/package.json` 0.9.0 e `package-lock.json`.

Regole della e2e, sull'app costruita e con `BAAPORTAL_TEST_PLC=1`:

- il test avvia il PLC di prova su una porta libera di 127.0.0.1, in RUN;
- nuovo progetto con CPU 315-2 PN/DP;
- «Dispositivi accessibili» → indirizzo manuale `127.0.0.1:<porta>` → «Collega»;
- la barra diventa arancione e mostra il modulo, i LED indicano RUN;
- il test porta in STOP la CPU di prova dal lato server e i LED passano a STOP entro 3 s;
- il test chiude il PLC di prova e l'app torna offline con «Collegamento interrotto»;
- con l'app online, «Simulazione» è disabilitata.

**Limiti noti:**

- sola lettura: niente caricamento, RUN/STOP o MRES fino al piano 3B;
- mai provato su una CPU reale, né su un CP 343-1 o un gateway;
- la ricerca trova solo dispositivi con IPv4 nella stessa sottorete dell'interfaccia scelta, e niente DCP (CPU senza IP), che arriva nella tappa 6;
- MPI/DP solo attraverso un gateway RFC 1006.

**Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 1–3:** e2e, documenti, collaudo.
- [ ] **Step 4: Commit** — `docs: piano 3A — online in sola lettura, versione 0.9.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. La rete sta solo nel processo principale** (spec §7). Il renderer usa IPC. _Se fosse sbagliato:_ nessuno; è la regola dell'architettura.
- **R2. Il collegamento del piano 3A è in sola lettura.** Il filtro già scritto nella tappa 1 lo garantisce. Le scritture arrivano nel 3B, ciascuna con conferma (spec §5). _Se fosse sbagliato:_ il 3B apre i collegamenti `'online-write'` solo per le funzioni che scrivono.
- **R3. Il PLC di prova è il server S7 locale con la CPU simulata dietro.** È lo stesso protocollo TCP di una CPU vera, quindi le e2e provano tutto il percorso. ⚠️ Non sostituisce la prova su una CPU vera, che resta dell'amico con la CPU di prova (spec §5). _Se fosse sbagliato:_ si correggono il client o il server quando la CPU vera dà risposte diverse.
- **R4. L'accesso si salva nelle proprietà della CPU**, come campo facoltativo, senza cambiare formato. TIA lo ricorda per dispositivo. _Se fosse sbagliato:_ lo si sposta nelle impostazioni dell'utente.
- **R5. Simulazione e PLC vero si escludono.** Un solo bersaglio online alla volta tiene semplici i comandi (Carica, Osserva, tabelle). _Se fosse sbagliato:_ `online.target` diventa per dispositivo.
