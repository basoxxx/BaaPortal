# Piano 3C — Diagnostica online — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** dopo il caricamento e i comandi del piano 3B, l'utente vede come sta la CPU vera e ci lavora come in TIA. L'utente:

- apre «Online e diagnostica» della CPU e legge Generale (identità, LED, protezione, selettore, ultimo cambio di modo), Buffer di diagnostica con il testo di ogni evento, Tempo di ciclo e Memoria;
- legge l'ora della CPU e la imposta, all'ora del PC o a mano, con una conferma;
- usa le tabelle di controllo anche sul PLC: osserva i valori e li comanda, con una conferma;
- salva un backup online della CPU, SDB compresi, in un file `.baapbak`, senza scrivere nulla nella CPU.

**Architettura:**

- **Protocollo** (`@baaportal/s7comm`): parser delle SZL di diagnostica (`docs/protocollo/s7comm.md` §7.5, §7.6), modulo degli eventi con la tabella di §7.6.3 come dati, e `setClock` in `S7WriteClient` (§12.0). `_DELE` passa al filesystem `'A'` (§10.5 errata). Il filtro `online-write` ammette set clock solo nella forma canonica.
- **Server di prova e CPU simulata** (`@baaportal/s7-server`, `@baaportal/sim`): rispondono a ogni SZL nuova, a set clock, a write var e all'elenco e all'upload degli SDB, così test ed e2e girano senza CPU.
- **Letture nel main:** diagnostica, osservazione delle tabelle e backup sono in sola lettura. Diagnostica e osservazione passano dal collegamento del 3A (`PlcService.read`). Il backup apre un suo collegamento `read-only`, come `uploadAll`.
- **Scritture nel main:** set clock e comando delle variabili passano da `PlcWriteService` del 3B, con la conferma nativa, il ricontrollo di `linkId` e dell'identità, un collegamento per operazione e una scrittura per CPU.
- **Interrogazione dal renderer:** è il renderer a chiedere i dati, a intervalli, solo mentre la vista è aperta. Il main non interroga mai da solo, salvo la sorveglianza del 3A.

**Tecnologie:** TypeScript, Electron (main, IPC, `dialog`), React 19, zustand, fflate (file `.baapbak`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §9 Tappa 3: «Online e diagnostica: informazioni generali CPU, buffer di diagnostica, tempo di ciclo, memoria, ora del PLC (lettura/impostazione)»; «tabelle di controllo online»; «Backup online, compresi i blocchi di sistema (SDB) copiati così come sono»;
- §8.2 (albero: «Online e diagnostica», «Tabelle di controllo e forzamento», «Backup online») e §8.3 (colonne delle tabelle di controllo);
- §5 Sicurezza sulle macchine; §6 «Sostituzione di CPU».

Piano generale: riga 3C (la riga 3D raccoglie il resto). Protocollo: `docs/protocollo/s7comm.md` §5, §7.5, §7.6, §10.5, §12.0, §15, §19.

## Global Constraints

- **Sola lettura per default:**
  - ogni lettura nuova (SZL, read clock, read var, list blocks, upload) è nell'allowlist di §15.1;
  - le uniche scritture nuove sono set clock e write var, e solo da `PlcWriteService`.
- **Conferma per ogni scrittura:** finestra nativa del main, che nomina la CPU (modulo e indirizzo) e dice cosa si scrive. Il pulsante predefinito è «Annulla».
- **Nessuna interrogazione nascosta:**
  - la diagnostica si interroga solo con l'editor «Online e diagnostica» aperto, circa ogni 1 s;
  - le tabelle di controllo solo con «Controlla tutto» attivo, circa ogni 500 ms;
  - una richiesta non parte prima che la precedente sia finita;
  - niente iscrizione ai messaggi push (§7.6.4).
- **Lista assente non è un guasto:** una SZL che la CPU rifiuta con `0xD401`–`0xD409` si mostra «non disponibile». Il resto della pagina resta.
- **Nessuna ripetizione automatica delle scritture.** Le letture periodiche riprendono al giro successivo. Un collegamento perso ferma tutto, come nel 3A.
- **Mai provato su una CPU reale:** ogni scrittura nuova (set clock, comando delle variabili) lo dice nei limiti noti e nelle note di rilascio.
- **Lingua e testi:**
  - italiano, con i termini di TIA Portal («Online e diagnostica», «Buffer di diagnostica», «Tempo di ciclo», «Memoria», «Imposta ora», «Controlla tutto», «Backup online»);
  - le chiavi in `it.json` ed `en.json` sono uguali;
  - i testi degli eventi sono nostri, in italiano e in inglese.
- **Clean-room e dati:**
  - gli SDB dei test sono sintetici, mai byte di catture o di CPU vere;
  - i vettori di test vengono solo dagli esempi del documento di protocollo;
  - nei test e nei documenti solo IP di documentazione e 127.0.0.1.

## Review Focus

1. **CPU che risponde `0xD402` a una parte delle SZL** (per esempio `0x0013` assente sulle CPU vecchie, `0x0222/0x5050`): quella sezione dice «non disponibile», le altre si aggiornano, e il collegamento non cade. → test in Task 2, Task 4 e Task 5.
2. **Buffer di diagnostica con ID sconosciuti, orari non validi o record corti:** ogni voce compare, con il testo generico della regola di §7.6.2 e l'ID in esadecimale. Nessuna voce sparisce e la pagina non si rompe. → test in Task 2 e Task 5.
3. **Tabella di controllo mista oltre il limite della PDU** (righe valide, simboli sconosciuti, PQ, DB inesistente, più di 20 item): le richieste si dividono entro la PDU, ogni errore resta sulla sua riga, e un comando parziale dice quali righe sono fallite. → test in Task 6.
4. **Collegamento perso durante l'interrogazione** (cavo, CPU spenta): diagnostica e tabelle si fermano, nessuna richiesta riparte da sola, e la finestra mostra il messaggio del 3A. → test in Task 4, Task 5 e Task 6.
5. **Ora impostata a cavallo della mezzanotte o del cambio dell'ora legale:** data e ora vengono dallo stesso istante, l'ora del PC si prende dopo la conferma, l'ora a mano si scrive come è stata scritta, e una data impossibile si rifiuta prima della conferma. → test in Task 4.

---

### Task 1: `_DELE` con il filesystem `'A'`

**Files:**

- Modify:
  - `packages/s7comm/src/writeClient.ts`: `DELETE_FS = 'A'`;
  - `packages/s7comm/src/s7/control.ts`: il commento di `encodeDeleteBlock`;
  - `packages/s7comm/src/readOnlyGuard.ts`: la forma canonica di `_DELE` in `assertOnlineWrite` diventa `encodeDeleteBlock(type, number, 'A')`;
  - `packages/s7-server/src/session.ts`: il server accetta `_DELE` solo con `'A'`;
  - `docs/protocollo/s7comm.md` §10.5 e §15bis: la codifica implementata è `'A'`;
  - `docs/limiti-noti.md`: la voce «Cancellazione dei blocchi» del 3B.
- Test: `packages/s7comm/test/control.test.ts`, `packages/s7comm/test/writeGuard.test.ts`, `packages/s7-server/test/piServices.test.ts`

Regole:

- **Vettore:** `_DELE` di SDB 2000 con `'A'` coincide byte per byte con l'errata di §10.5: `28 00 00 00 00 00 00 fd 000a 01 00 30 42 "02000" 41 05 "_DELE"`. L'encoder lo produce anche se `deleteBlock` cancella solo OB, FB, FC e DB.
- **Filtro:** `_DELE` con `'B'` o `'P'` diventa FORBIDDEN in `online-write`. In `read-only` resta tutto FORBIDDEN.
- **Limiti noti:** «`_DELE` usa il filesystem 'A', come TIA nella cattura reale (§10.5). È verificato per gli SDB; per OB, FB, FC e DB è un'ipotesi.»

- [ ] **Step 1: Test**
  - `_DELE SDB 2000 uguale all'errata §10.5`
  - `_DELE OB1 canonico con filesystem A`
  - `online-write rifiuta _DELE con filesystem B e P`
  - `read-only rifiuta _DELE`
  - `deleteBlock contro il server di prova toglie il blocco` (aggiornato)
  - `il server rifiuta _DELE con filesystem B`
- [ ] **Step 2–4:** `--project s7comm --project s7-server`.
- [ ] **Step 5: Commit** — `fix(s7comm): _DELE con il filesystem A, come nella cattura reale`

### Task 2: Parser delle SZL di diagnostica, eventi e set clock

**Files:**

- Create:
  - `packages/s7comm/src/s7/szlDiag.ts`: parser delle liste di diagnostica;
  - `packages/s7comm/src/s7/diagEvents.ts`: struttura dell'event ID, tabella degli eventi e regola per gli ID sconosciuti.
- Modify:
  - `packages/s7comm/src/s7/userdataRequests.ts`: `reqSetClock`;
  - `packages/s7comm/src/writeClient.ts`: `setClock`;
  - `packages/s7comm/src/readOnlyGuard.ts`: set clock in `online-write`;
  - `packages/s7comm/src/index.ts`.
- Test: `packages/s7comm/test/szlDiag.test.ts`, `packages/s7comm/test/diagEvents.test.ts`, `packages/s7comm/test/clock.test.ts`, `packages/s7comm/test/writeGuard.test.ts`

**Interfaces:**

- `DiagRecord = { eventId; priority; obNumber; datId; info1; info2; time?: S7DateTime; rawTime?: Uint8Array }`, the 20-byte record of §7.6.1.
  - `diagRecordFrom(bytes)`.
  - `diagRecordsFrom(list)` accepts `0x00A0` and `0x01A0`, newest first. It replaces the use of `diagFrom`; `diagFrom` stays for the kit.
  - `lastModeChangeFrom(s0124): DiagRecord | undefined`.
- `modeTransition(byte) → { from: ModeCode; to: ModeCode }`, with `ModeCode` the codes of §7.3 (`0x6` included):
  - `1` STOP (aggiornamento), `2` STOP (cancellazione totale), `3` STOP (autoinizializzazione), `4` STOP (interno);
  - `5` avviamento a caldo, `6` avviamento, `7` riavvio;
  - `8` RUN, `A` HOLD, `D` DIFETTO;
  - anything else is `unknown`.
- `cycleTimeFrom(s0222_1) → { lastMs; minMs; maxMs; lastStart?: S7DateTime }` and `cycleConfigFrom(s0222_50) → { minMs; maxMs }`. Each checks that the index echoed in the header is the one requested.
- `memoryFrom(s0013) → MemoryArea[]` with `MemoryArea = { index; kind: 'work' | 'loadIntegrated' | 'loadMmc' | 'loadMax' | 'backup' | 'cfb' | 'unknown'; size; used; free }`.
  - `used = belegt1 + belegt2`;
  - `free = max(0, size − used)`;
  - a record shorter than 36 bytes is skipped.
- `ledsFrom(list) → Led[]` with `Led = { id; name; on: boolean; blink: 'none' | 'normal' | 'slow' | 'unknown' }`. It accepts `0x0019`, `0x0074` and `0x0174`. The names come from §7.5.4.
- `isUnavailable(err): boolean` is true for `S7Error('CPU_ERROR')` with `errorClass 0xD4` and `errorCode` from `0x01` to `0x09`.
- `diagEvents.ts`:
  - `decodeEventId(id) → { cls; number; incoming; internal; external; inBuffer }`;
  - `EVENT_CLASSES: Record<number, { it; en }>`;
  - `EVENTS: ReadonlyMap<number, { it; en }>`;
  - `describeEvent(id, lang: 'it' | 'en') → { text; source: 'exact' | 'flipped' | 'masked' | 'user' | 'generic' }`.
- `reqSetClock(t: S7DateTime, sequence = 0)` and `S7WriteClient.setClock(t): Promise<void>`.

Regole:

- **Tabella degli eventi:**
  - sono i dati di §7.6.3, un ID per voce;
  - le righe con due ID (`0x3821` / `0x3921`) diventano due voci, con «(uscente)» e «(entrante)»;
  - la riga della classe 8 diventa le otto voci `0x8000`–`0x8007`;
  - i testi inglesi sono nostri.
- **Regola per gli ID sconosciuti:** è quella di §7.6.2, nell'ordine: ID esatto, verso invertito (bit 8), maschera `0xF0FF` per le classi 8 e 9, «evento utente» per le classi A e B, poi generico.
  - Il generico dice la classe, il numero, il verso, e «errore interno/esterno» se i bit 10 e 11 sono a 1.
- **Parser tolleranti:** un record corto o un'ora non valida non fanno perdere le altre voci (`rawTime`, come `diagFrom`). La lista sbagliata (ID diverso) lancia `PROTOCOL`.
- **Set clock (§12.0):**
  - sottofunzione `0x02`, mai `0x04`;
  - giorno della settimana `0`, come nella cattura verificata;
  - anno da 1990 a 2089 (§12.1), altrimenti `RangeError` prima di inviare;
  - la risposta ha l'error code nel parametro e dati `0a 00 00 00`. Per questo `setClock` non usa il percorso di lettura, che pretende una parte dati. Un error code diverso da 0 diventa `CPU_ERROR` con il nome del codice.
- **Filtro:**
  - `online-write` ammette userdata 7/2 solo se i byte coincidono con `reqSetClock(decodificato)`, con il giorno 0;
  - 7/4 resta FORBIDDEN;
  - `read-only` rifiuta 7/2 come oggi.

- [ ] **Step 1: Test** (vettori dagli esempi del documento di protocollo)
  - `0x0222/1 del §7.5.2 → ultimo 0, minimo 0, massimo 3 ms, avvio 2016-02-08 23:17:58.211`
  - `0x0222/0x50 del §7.5.2 → massimo configurato 150 ms`
  - `0x0222 con indice diverso da quello chiesto → PROTOCOL`
  - `0x0013 con i 5 record della tabella §7.5.3 → lavoro 196608/352, MMC 131072/4906, ritentiva 1280/32, libero = totale − usato`
  - `0x0013 con un record corto → saltato, gli altri ci sono`
  - `0x0019 del §7.5.4 → 7 LED, RUN acceso fisso, gli altri spenti`
  - `0x0174/6 del §7.5.4 → FRCE spento`
  - `0x0124 del §7.5.5 → 0x4302, da avviamento (6) a RUN (8), 2016-02-08 23:08:10.264`
  - `0x00A0 con le 4 voci di §7.6.1 → ordine conservato, 0x1381 con priorità 0x1B, OB 0x64, info1 0x4304`
  - `voce con ora non valida → c'è, con rawTime`
  - `describeEvent: 0x4304 esatto; 0x3963 → testo di 0x3863 più «(entrante)»; 0x8103 → 0x8003 «errore di canale»; 0xA123 evento utente; 0x5F01 generico «eventi di esecuzione»; 0x3D99 generico con errore interno ed esterno`
  - `la tabella ha gli stessi ID di §7.6.3 (letto da docs/protocollo/s7comm.md) e gli stessi testi italiani per le righe a un ID`
  - `ogni voce ha un testo inglese non vuoto`
  - `isUnavailable: D402 e D409 sì; D241, TIMEOUT e CLOSED no`
  - `reqSetClock uguale al vettore §12.0 / §17.12 (param 00 01 12 04 11 47 02 00, dati ff 09 000a + ora, giorno 0)`
  - `setClock: anno 2090 → RangeError senza invio`
  - `online-write ammette set clock canonico e rifiuta sottofunzione 0x04 e giorno ≠ 0`
  - `read-only rifiuta set clock`
- [ ] **Step 2–4:** `--project s7comm`.
- [ ] **Step 5: Commit** — `feat(s7comm): SZL di diagnostica, testi degli eventi e impostazione dell'ora`

### Task 3: Server di prova e CPU simulata per la diagnostica

**Files:**

- Modify:
  - `packages/s7-server/src/szlData.ts`: le liste `0x0013`, `0x0019`, `0x0074`, `0x0174`, `0x0124` e `0x0222` (indici `0x0001` e `0x0050`), con le loro intestazioni `0x0Fxx`;
  - `packages/s7-server/src/backend.ts`: membri facoltativi `cycleStats?()`, `memory?()`, `setClock?(t)`, `faultLed?`, e `systemBlocks` negli `StoredBlock`;
  - `packages/s7-server/src/session.ts`: userdata 7/2;
  - `packages/s7-server/src/faults.ts`: `szlUnavailable?: number[]`, cioè ID SZL a cui rispondere `0xD402`;
  - `packages/s7-server/src/fakeCpu.ts`: opzioni `systemBlocks` e `memory`;
  - `packages/sim/src/cpu.ts`: `setClock(ms)` pubblico, lo stesso scostamento di SET_CLK;
  - `packages/sim/src/backend.ts`: `now()` dall'orologio della CPU, tempo di ciclo da `stats()`, memoria, opzione `systemBlocks`;
  - `apps/desktop/src/main/plc/testPlc.ts`: il PLC di prova parte con due SDB sintetici (0 e 1).
- Create: `packages/s7-server/src/systemBlocks.ts`: `syntheticSdb(number, length)`, un file di blocco tipo SDB con linguaggio `0x07`, corpo a zero più la scritta «BaaPortal SDB di prova».
- Test: `packages/s7-server/test/diagnostics.test.ts`, `packages/sim/test/backend.test.ts`

Regole:

- **Dati plausibili:**
  - **LED:** gli stessi 7 record di §7.5.4 (SF, RUN, STOP, FRCE, BUS1F, BUS2F, MAINT). RUN è acceso in RUN; STOP è acceso in STOP; in avviamento STOP è acceso e RUN lampeggia (2 Hz). SF segue `faultLed`, che per la CPU simulata vuol dire «l'ultima voce del buffer è un errore», come nel Pannello di comando del 2C.
  - **`0x0124`:** la voce del buffer più recente con classe 4; senza nessuna, un record `0x4302` costruito da `modeSince`.
  - **Cambi di modo nel buffer:** usano i byte di modo di §7.6.1: STOP da PG `0x84`, STOP→avviamento `0x46`, avviamento→RUN `0x68`.
  - **`0x0222/1`:** ultimo, minimo e massimo in ms. **`0x0222/0x50`:** `minCycleMs` e `maxCycleMs` della CPU. Un altro indice risponde `0xD402`.
  - **`0x0013`:** cinque record come §7.5.3:
    - lavoro = `workMemoryKB` del catalogo, usato = somma delle lunghezze MC7 caricate;
    - nessuna memoria integrata;
    - MMC 512 KB, usato = somma delle lunghezze di caricamento;
    - MMC massima 8 MB;
    - ritentiva 1280 byte.
- **Set clock:**
  - con `setClock` presente risponde error code 0 e dati `0a 00 00 00`;
  - senza, «non implementato»;
  - con il livello di protezione 3, `0xD0A1` (ipotesi di §12.0, scritta nel codice);
  - la lettura successiva ricalcola il giorno della settimana;
  - 7/4 resta rifiutata.
- **SDB:** `blockCounts`, `blockList('SDB')`, `block` e l'upload li vedono come blob opachi. Il download e `_DELE` degli SDB restano rifiutati: nessuna scrittura di SDB in 3C.

- [ ] **Step 1: Test**
  - `ogni SZL nuova ha la lunghezza di record e il numero di record di §7.5`
  - `0x0222 indice 0x5050 → 0xD402`
  - `faults.szlUnavailable [0x0013] → 0xD402 solo per 0x0013`
  - `STOP e poi RUN → in testa al buffer 0x4302 con byte 0x68 e 0x4301 con 0x46; 0x0124 = 0x4302`
  - `LED: RUN acceso in RUN, STOP acceso in STOP, SF dopo un errore di programma`
  - `tempo di ciclo della CPU simulata: minimo ≤ ultimo ≤ massimo`
  - `memoria: dopo il download di OB1 la memoria di lavoro usata cresce della lunghezza MC7`
  - `set clock in RUN: la lettura dopo dà l'ora scritta (± 1 s) con il giorno della settimana ricalcolato`
  - `set clock con livello di protezione 3 → 0xD0A1`
  - `SDB 0 e 1: elenco, block info e upload in RUN, byte identici a quelli seminati`
  - `download e _DELE di un SDB → rifiutati`
  - `write var su M e DB della CPU simulata → la lettura dopo dà il valore scritto` (se manca)
- [ ] **Step 2–4:** `--project s7-server --project sim --project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(s7-server,sim): SZL di diagnostica, ora e SDB nel PLC di prova`

### Task 4: Diagnostica e ora nel processo principale

**Files:**

- Create: `apps/desktop/src/main/plc/diagnostics.ts`
- Modify:
  - `plcService.ts`: `ReadClient` aggiunge `readSzl` e `readClock`;
  - `plcWrite.ts`: `setClock`, e `WriteClient` aggiunge `setClock`;
  - `plcIpc.ts` (`plc:diagnostics`, `plc:setClock`), il preload, `packages/ui/src/bridge.ts`, `packages/ui/src/online/plcTypes.ts`.
- Test: `apps/desktop/test/plc/diagnostics.test.ts`, `apps/desktop/test/plc/setClock.test.ts`

**Interfaces:**

- `DiagPart = 'identity' | 'mode' | 'leds' | 'protection' | 'lastModeChange' | 'cycle' | 'memory' | 'buffer' | 'clock'`.
- `readDiagnostics(service, owner, parts: DiagPart[]) → { ok: true; data: Partial<PlcDiagData> } | { ok: false; error }`.
  - Every field of `PlcDiagData` is a `DiagValue<T> = { ok: true; value: T } | { ok: false; unavailable: true } | { ok: false; error: string }`.
  - Times travel as `S7DateTime`; events travel as `DiagRecord` without `Uint8Array` (`rawTime` in hex).
- `parseDiagParts(raw): DiagPart[] | string`: an array of known, distinct parts, at most 9.
- `PlcWriteService.setClock(owner, req: PlcClockRequest) → { ok: true; written: S7DateTime } | { ok: false; error } | { ok: false; cancelled: true }`.
  - `PlcClockRequest = { source: 'pc' } | { source: 'manual'; time: { year; month; day; hour; minute; second } }`.
  - Clock and date are injectable (`now`), as already done for progress.

Regole:

- **Letture:**
  - ogni SZL è un `run` a sé dentro `service.read`, così la sorveglianza passa fra l'una e l'altra; il limite è 5 s;
  - le SZL sono quelle di §7.5.1: `identity` = `0x0011` + `0x001C`, `mode` = `0x0424`, `leds` = `0x0019`, `protection` = `0x0232/4`, `lastModeChange` = `0x0124`, `cycle` = `0x0222/1` + `0x0222/0x50`, `memory` = `0x0013`, `buffer` = `0x00A0`, `clock` = read clock;
  - `isUnavailable` → `unavailable`. Un altro errore di CPU → `error` per la sola parte. Un errore di trasporto (`CLOSED`, `TIMEOUT`) fa perdere il collegamento come in `PlcService.read`, e il risultato è `{ ok:false }`.
- **Ora del PC:**
  - si prende **dopo** la conferma, con un solo `Date`, così data e ora sono dello stesso istante;
  - si usano i campi locali, senza fuso né ora legale: la CPU S7-300 non li conosce;
  - la conferma dice «ora del PC al momento della conferma» e mostra l'ora attuale come indicazione.
- **Ora a mano:**
  - si controlla prima della conferma: data di calendario vera (29 febbraio solo negli anni bisestili), anno 1990–2089, ore 0–23, minuti e secondi 0–59;
  - si scrive così com'è, millisecondi 0, anche in un'ora che il PC salterebbe per l'ora legale;
  - la conferma la mostra per intero.
- **Conferma:** titolo «Imposta ora». Il messaggio nomina la CPU e l'indirizzo, il dettaglio dice «Gli interrupt dall'orologio (OB10) possono saltare». Poi lo stesso `prepare` del 3B: conferma, stesso `linkId`, identità.

- [ ] **Step 1: Test**
  - `readDiagnostics contro il PLC di prova: tutte le parti ok, buffer con la voce più recente in testa`
  - `faults.szlUnavailable [0x0013, 0x0124] → memory e lastModeChange non disponibili, le altre ok, collegamento vivo`
  - `una SZL con un altro errore di CPU → error solo per quella parte`
  - `CPU che chiude durante la lettura → { ok:false }, evento lost, nessuna eccezione`
  - `parti non valide o ripetute dal renderer → errore senza nessuna lettura`
  - `senza collegamento online → errore`
  - `setClock: senza conferma nessun collegamento`
  - `setClock pc: l'ora scritta è quella dopo la conferma (orologio iniettato), non quella della richiesta`
  - `setClock pc alle 23:59:59.999 del 31/12 → data e ora dello stesso istante`
  - `setClock manuale 2026-03-29 02:30:00 → scritta così com'è`
  - `setClock manuale 2026-02-29, 2090-01-01, 24:00 → errore prima della conferma`
  - `il testo della conferma nomina modulo, indirizzo e ora`
  - `setClock durante un'altra scrittura sulla stessa CPU → già in corso`
  - `setClock contro il PLC di prova → readDiagnostics(clock) dà l'ora scritta (± 1 s)`
- [ ] **Step 2–4:** `--project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(desktop): diagnostica online in sola lettura e impostazione dell'ora con conferma`

### Task 5: Editor «Online e diagnostica»

**Files:**

- Create:
  - `packages/ui/src/editors/diag/OnlineDiagView.tsx` e `diag.css`;
  - `packages/ui/src/online/diagController.ts`: interrogazione periodica, con temporizzatore iniettabile;
  - `packages/ui/src/online/diagFormat.ts`: testi delle righe (ora, LED, memoria, eventi, cambio di modo).
- Modify:
  - `state/workArea.ts` (`EditorKind` `'onlineDiag'`), `editors/registry.tsx`;
  - l'albero: doppio clic su «Online e diagnostica» (`online-diag`) apre l'editor;
  - il comando `online.diagnostics`, abilitato con una CPU nel progetto;
  - `CpuPanel.tsx`: con il PLC vero, i segnaposto «Tempo di ciclo» e «Buffer di diagnostica» diventano il link «Apri Online e diagnostica»;
  - `i18n` (`diag.*`, in italiano e in inglese).
- Test: `packages/ui/test/online/diagController.test.ts`, `packages/ui/test/editors/onlineDiagView.test.tsx`

Regole:

- **Struttura, come in TIA:** a sinistra l'elenco delle pagine, a destra la pagina scelta.
  - **Diagnostica:**
    - «Generale»: modulo, numero d'ordine, versione HW/FW, nome stazione, numero di serie, MMC, modo attuale, ultimo cambio di modo, LED, livello di protezione, selettore;
    - «Buffer di diagnostica»: elenco più dettagli;
    - «Tempo di ciclo»: ultimo, minimo, massimo e tempo di sorveglianza configurato, con una barra;
    - «Memoria»: una riga per area, con totale, occupato, libero e percentuale.
  - **Funzioni:** «Imposta ora».
- **Interrogazione:**
  - ogni 1 s, solo le parti della pagina visibile più `mode` e `leds` per l'intestazione;
  - `identity` una volta sola;
  - la richiesta successiva parte 1 s dopo la fine della precedente;
  - si ferma quando l'editor si chiude, va offline o perde il collegamento, e non riparte da sola.
- **Buffer di diagnostica:**
  - colonne N°, Data e ora, Evento;
  - si mostrano i dati della CPU così come sono, con l'ora della CPU senza conversioni;
  - la casella «Blocca visualizzazione» ferma l'aggiornamento della sola lista;
  - i dettagli della voce scelta: ID in esadecimale, testo (`describeEvent` nella lingua dell'interfaccia), classe, entrante/uscente, priorità e OB, per i cambi di modo «da ‹modo› a ‹modo›», DatID, info 1 e info 2 in esadecimale;
  - un testo generico ha la nota «Evento non in tabella: descrizione generica».
- **Parti non disponibili:** «non disponibile su questa CPU» al posto dei valori. Un `error` mostra il messaggio nella sezione.
- **Ora:**
  - mostra l'ora della CPU e quella del PC, e la differenza in secondi;
  - pulsanti «Imposta all'ora del PC» e «Applica» per data e ora a mano. Il controllo dei campi è lo stesso del main, e un campo errato è segnalato senza chiamare il bridge;
  - «Annulla» nella conferma non mostra messaggi; un errore sì; un esito positivo rilegge subito l'ora.
- **Senza collegamento:** l'editor mostra «Collegamento online necessario» e il pulsante «Collegamento online». Con la simulazione attiva dice di usare il Pannello di comando CPU.

- [ ] **Step 1: Test**
  - `diagController: con l'editor aperto chiede ogni 1 s; chiuso → nessuna richiesta`
  - `richiesta lenta (3 s) → nessuna sovrapposizione`
  - `cambio pagina → cambiano le parti chieste`
  - `collegamento perso → interrogazione ferma e messaggio; di nuovo online → riparte solo con l'editor aperto`
  - `memoria non disponibile → «non disponibile su questa CPU», Generale aggiornata`
  - `buffer: 0x4302 → «passaggio da AVVIAMENTO a RUN» e «da avviamento a RUN» nei dettagli`
  - `buffer: ID sconosciuto 0x5F01 → testo generico, nota e info in esadecimale`
  - `buffer: voce con rawTime → ora mostrata come esadecimale`
  - `Blocca visualizzazione → la lista non cambia, Generale sì`
  - `Imposta all'ora del PC → plcSetClock({ source: 'pc' })`
  - `ora a mano 2026-02-30 → errore sul campo e nessuna chiamata`
  - `conferma annullata → nessun messaggio`
  - `offline → invito al collegamento; simulazione → rimando al Pannello di comando`
  - `en: titoli delle pagine e testo di 0x4304 in inglese`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): editor Online e diagnostica con buffer, tempo di ciclo, memoria e ora`

### Task 6: Tabelle di controllo online

**Files:**

- Create:
  - `apps/desktop/src/main/plc/watchOnline.ts`: controllo degli item, conversione in `ReadItem`/`WriteItem`, lettura;
  - `packages/ui/src/online/watchOnline.ts`: interrogazione della tabella e comando, sul PLC.
- Modify:
  - `plcService.ts` (`ReadClient` aggiunge `readItems`);
  - `plcWrite.ts` (`writeVars`, e `WriteClient` aggiunge `writeItems`);
  - `plcIpc.ts` (`plc:readWatch`, `plc:writeVars`), il preload, il bridge, `plcTypes.ts`;
  - `editors/watch/watchRows.ts`: `resolveRows` riceve il limite e la sorgente (`'sim' | 'plc'`);
  - `editors/watch/WatchTableView.tsx`: la sorgente è il simulatore se è attivo, il PLC se si è online, altrimenti nessuna;
  - `i18n` (`watch.plcOff`, `watch.err.ONLINE_UNSUPPORTED`, `watch.err.ONLINE_TOO_MANY`).
- Test: `apps/desktop/test/plc/watchOnline.test.ts`, `packages/ui/test/online/watchOnline.test.ts`, `packages/ui/test/editors/watchTableView.test.tsx`

**Interfaces:**

- `ONLINE_MAX_ITEMS = 200`.
- `parseWatchItems(raw): WatchTarget[] | string`.
- `toReadItem(t: WatchTarget): ReadItem`:
  - `I`, `Q`, `M`, `DB` keep their area;
  - `PI` becomes area `P`;
  - `T` and `C` become `TIMER`/`COUNTER` with count 1;
  - `X` becomes `BIT`.
- `readWatch(service, owner, items) → { ok: true; values: ({ bytes: Uint8Array } | { error: string })[] } | { ok: false; error }`.
- `PlcWriteService.writeVars(owner, items: { target: WatchTarget; data: Uint8Array }[]) → { ok: true; results: ({ ok: true } | { ok: false; error: string })[] } | { ok: false; error } | { ok: false; cancelled: true }`.

Regole:

- **Aree:**
  - osservazione: I, Q, M, DB, PI, T, C;
  - comando: I, Q, M, DB;
  - PQ non è disponibile online (né osservazione né comando), PI e T/C non si comandano. Queste righe mostrano «non disponibile online» e non entrano nella richiesta.
- **Limite:**
  - al massimo 200 righe osservabili online; le successive hanno `ONLINE_TOO_MANY`;
  - il main rifiuta oltre 200 item prima di leggere;
  - la divisione entro la PDU è quella di `planReads`/`planWrites` (§5.11, 20 item per richiesta).
- **Errori per riga:**
  - il codice di ritorno di ogni item (§5.6) diventa il messaggio della sola riga (`itemReturnName`, per esempio «oggetto inesistente» per un DB che non c'è);
  - una lettura che fallisce intera dà l'errore a tutte le righe del giro, e l'osservazione continua al giro dopo;
  - `CLOSED`/`TIMEOUT` fanno perdere il collegamento.
- **Ritmo:** ogni 500 ms, dalla fine della richiesta precedente, solo con «Controlla tutto» attivo e la tabella aperta.
- **Comando:**
  - si comandano le righe con un valore di comando valido (`planCommand` del 2C);
  - la conferma nativa elenca, una riga per item e troncate dopo 20 come nel caricamento, l'indirizzo e il valore in esadecimale (`MW 10 ← 16#002A`, `M 0.0 ← 1`);
  - il main costruisce queste righe dai byte che scriverà, non da testi del renderer;
  - poi un collegamento `online-write`, `writeItems` e la chiusura;
  - l'esito per riga va nella colonna «Valore di comando»;
  - nessuna ripetizione.
- **Esclusione:** simulazione e online non convivono già dal 3A. La tabella segue la sorgente attiva e azzera i valori quando la sorgente cambia.

- [ ] **Step 1: Test**
  - `readWatch contro il PLC di prova: M, DB, I, PI, T e C con i valori della CPU`
  - `60 item validi → 3 richieste read var, valori nell'ordine delle righe`
  - `righe miste: DB inesistente → errore solo sulla sua riga, le altre lette`
  - `201 item → errore prima di leggere`
  - `area PQ dal renderer → rifiutata`
  - `writeVars: la conferma elenca «MW 10 ← 16#002A», troncata dopo 20 righe`
  - `writeVars: senza conferma nessun collegamento`
  - `writeVars: PI, T, C o lunghezza dei dati diversa dalla dimensione → errore prima della conferma`
  - `writeVars contro il PLC di prova → la lettura dopo dà i valori scritti`
  - `writeVars: un item rifiutato dalla CPU → errore solo per quell'item`
  - `ui: «Controlla tutto» online → plcReadWatch ogni 500 ms, mai sovrapposte; tabella chiusa → stop`
  - `ui: PQW 0 → «non disponibile online»; PIW 0 in comando → errore di riga`
  - `ui: simulazione attiva → la tabella usa il simulatore, nessuna chiamata al PLC`
  - `ui: collegamento perso → osservazione ferma, valori svuotati`
  - `ui: comando annullato → nessun messaggio; esito parziale → errore sulla sola riga fallita`
- [ ] **Step 2–4:** `--project @baaportal/desktop --project ui`.
- [ ] **Step 5: Commit** — `feat(desktop,ui): tabelle di controllo online con osservazione e comando`

### Task 7: Backup online (solo esportazione)

**Files:**

- Create:
  - `packages/project/src/backupFile.ts`: `encodeBackup(manifest, files) → Uint8Array` e `decodeBackup(bytes) → { manifest; files }`;
  - `apps/desktop/src/main/plc/backup.ts`.
- Modify:
  - `uploadAll.ts`: l'elenco dei tipi diventa un parametro del giro, così il backup riusa limiti, interruzione e avanzamento;
  - `plcIpc.ts` (`plc:backup`, `plc:backupCancel`), il preload, il bridge, `plcTypes.ts`;
  - il menu contestuale di «Backup online» nell'albero e il menu Online: «Carica backup dal dispositivo online…» (`online.backup`), abilitato solo online;
  - la barra di stato (avanzamento con il pulsante di interruzione);
  - `i18n`.
- Test: `packages/project/test/backupFile.test.ts`, `apps/desktop/test/plc/backup.test.ts`, `packages/ui/test/online/backupCommand.test.tsx`

**Interfaces:**

- `BackupManifest`:
  - `format: 'baaportal-backup'`, `version: 1`, `createdAt` (ISO), `app` (versione);
  - `cpu: { orderNumber; serial?; moduleName?; firmware?; host; port; rack; slot }`, `mode` (all'inizio);
  - `blocks: { type: 'OB' | 'FB' | 'FC' | 'DB' | 'SDB'; number; file; length; sha256 }[]`;
  - `failed: { type; number; error }[]`.
- File in the zip: `manifest.json` and `blocks/<TIPO><numero>.blk`, the raw bytes as uploaded.
- `backup(owner) → { ok: true; path; count; failed } | { ok: false; error } | { ok: false; cancelled: true }`.

Regole:

- **Cosa si copia:** OB, FB, FC, DB e SDB, con list blocks e `uploadWithInfo`. Restano fuori SFC e SFB, che stanno nel sistema operativo della CPU.
- **Collegamento:**
  - l'`access` è quello del collegamento online della finestra, presa da `PlcService.target`;
  - si apre un collegamento `read-only` a parte, come `uploadAll`, così la sorveglianza non resta ferma;
  - dopo l'apertura, l'identità deve coincidere con quella del collegamento online, altrimenti si annulla;
  - il backup funziona in RUN (§19.2).
- **Ordine:**
  1. finestra di salvataggio nativa nel main (nome proposto `‹modulo›_AAAAMMGG-hhmm.baapbak`); «Annulla» → `cancelled`, senza collegamento;
  2. caricamento, con avanzamento `plc:uploadProgress`;
  3. scrittura in un file temporaneo nella stessa cartella, poi rinomina.
- **Limiti:** gli stessi di `uploadAll` (`MAX_BLOCKS`, `MAX_BYTES`). Un'interruzione o un errore non lasciano nessun file, nemmeno il temporaneo.
- **Blocco rifiutato dalla CPU:** finisce in `failed` e il resto continua, come in `uploadAll`. L'esito lo elenca.
- **Lettura del file:** `decodeBackup` controlla formato, versione, la presenza di ogni file, lo `sha256`, e i percorsi (niente `..`, niente percorsi assoluti). Serve ai test e al ripristino del 3D, che non è in questo piano.
- **Nel progetto non cambia nulla:** il file sta fuori dal `.baap`. L'elenco dei backup sotto «Backup online» arriva con il ripristino nel 3D.

- [ ] **Step 1: Test**
  - `encodeBackup/decodeBackup: andata e ritorno identica`
  - `decodeBackup: formato sbagliato, file mancante, sha256 diverso, percorso con .. → errore`
  - `backup contro il PLC di prova con OB1, DB1, SDB 0 e SDB 1 → 4 blocchi, byte identici all'upload, manifest con la CPU`
  - `il collegamento del backup è read-only: nessuna PDU di scrittura parte`
  - `Annulla nel salvataggio → nessun collegamento`
  - `interruzione a metà → nessun file né temporaneo`
  - `CPU raggiunta diversa da quella online → annullato`
  - `blocco rifiutato dalla CPU → in failed, gli altri salvati`
  - `oltre MAX_BLOCKS → errore senza file`
  - `ui: «Carica backup dal dispositivo online…» abilitato solo online; esito con percorso e blocchi non copiati`
- [ ] **Step 2–4:** `--project project --project @baaportal/desktop --project ui`.
- [ ] **Step 5: Commit** — `feat(desktop,project): backup online con SDB in un file .baapbak`

### Task 8: E2E, documenti, limiti noti, versione

**Files:**

- Create: `apps/desktop/e2e/plc-diagnostica.spec.ts`
- Modify:
  - `docs/uso/online.md`: sezioni «Online e diagnostica», «Imposta ora», «Tabelle di controllo online», «Backup online»;
  - `docs/limiti-noti.md`: sezione «Diagnostica online (piano 3C)»;
  - il piano generale: riga 3C «Stato: fatto (v0.11.0)»;
  - `apps/desktop/package.json` 0.11.0 e `package-lock.json`.

Regole della e2e, sull'app costruita, con il PLC di prova avviato nel processo di Playwright:

- **Agganci di test:** la conferma usa l'aggancio del 3B (`BAAPORTAL_E2E_CONFIRM`). Per il salvataggio si aggiunge `BAAPORTAL_E2E_SAVE_PATH`, attivo solo con `!app.isPackaged`. Il test che controlla l'app impacchettata copre anche questo aggancio.
- **Percorso:**
  1. progetto con OB1, collegamento;
  2. «Online e diagnostica»: Generale mostra il numero d'ordine, il modo RUN e il LED RUN acceso;
  3. «Arresta CPU» (conferma sì): in testa al buffer c'è «STOP dal PG o da SFB 20»; poi «Avvia CPU»;
  4. «Tempo di ciclo» mostra tre valori in ms; «Memoria» mostra la memoria di lavoro;
  5. «Imposta ora» a mano 2030-01-01 12:00:00: l'ora della CPU è quella (± 2 s);
  6. tabella di controllo con `MW 10`, `DB1.DBW 0` e `PQW 0`: «Controlla tutto»; `PQW 0` «non disponibile online»; comando `MW 10` = 42 → il valore osservato è 42;
  7. backup online: il file esiste, e `decodeBackup` dà OB1 e gli SDB 0 e 1.
- **Conferma negata:** con `BAAPORTAL_E2E_CONFIRM=no` l'ora e `MW 10` non cambiano.

**Limiti noti** (sezione «Diagnostica online (piano 3C)»):

- mai provato su una CPU reale; set clock e comando delle variabili sono «mai provati su una CPU reale»;
- testi degli eventi da documentazione: solo 4 ID visti in cattura; gli altri hanno il testo generico;
- «ritentiva = indice 5» di `0x0013` è un'ipotesi; la memoria è verificata su una sola cattura;
- il tempo di sorveglianza (OB80) viene dalla documentazione;
- ora locale del PC, senza fuso né ora legale;
- l'osservazione usa read var, non lo stato delle variabili TIS: i valori non sono presi a un punto preciso del ciclo;
- niente PQ online, niente comando di PI, T, C, niente forzamento; al massimo 200 righe osservate online;
- il backup è solo esportazione: il ripristino arriva nel 3D; non si sa se i DB caricati hanno i valori attuali o quelli iniziali (§19.4);
- niente messaggi push: il buffer si aggiorna ogni secondo, solo con l'editor aperto;
- `_DELE` usa 'A' (dal Task 1).

**Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 1–3:** e2e, documenti, collaudo.
- [ ] **Step 4: Commit** — `docs: piano 3C — diagnostica online, tabelle online e backup, versione 0.11.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Il piano 3C si divide.** In 3C: correzione di `_DELE`, diagnostica online (Generale, LED, protezione e selettore, ultimo cambio di modo, tempo di ciclo, memoria, buffer di diagnostica con testi, ora), tabelle di controllo online (osservazione e comando) e backup online in sola esportazione, SDB compresi. Il nuovo piano **3D** (osservazione del programma online con stato del blocco/TIS, tabelle di forzamento, stack di chiamata, ripristino del backup con SDB) aspetta catture e verifiche su una CPU reale. Il piano generale si aggiorna. _Se fosse sbagliato:_ si spostano voci fra 3C e 3D; nessun codice cambia.
- **R2. `_DELE` usa il filesystem `'A'`**, come TIA nella cattura reale (§10.5 errata). Cambiano l'encoder, la forma canonica del filtro, il server di prova, i test e il documento. È verificato per gli SDB; per OB, FB, FC e DB è assunto, e lo dicono i limiti noti. _Se fosse sbagliato:_ si torna a `'B'` per i blocchi utente con una cattura che lo mostri.
- **R3. La diagnostica è in sola lettura** sul collegamento del 3A (`PlcService.read`), interrogata circa ogni 1 s e solo con una vista aperta. `0xD402`, o una SZL che manca, vuol dire «non disponibile», mai un errore che rompe la pagina. L'iscrizione ai messaggi push non si usa in 3C. _Se fosse sbagliato:_ si aggiunge l'iscrizione MODE/SYS (§7.6.4) con disiscrizione garantita.
- **R4. Ora e comando delle variabili sono scritture:** passano da `PlcWriteService` con la conferma nativa e gli stessi controlli del 3B, e il filtro ammette le loro forme canoniche solo in `online-write`. La conferma del comando elenca indirizzi e valori, troncati come nel caricamento. Solo comando, niente forzamento. L'ora si imposta all'ora del PC oppure a mano.
- **R5. L'osservazione delle tabelle usa read var** (§5), non lo stato delle variabili TIS: una lettura per giro dell'interfaccia (500 ms–1 s), con gli item divisi entro la PDU (§5.11). Valgono gli indirizzi assoluti e i simboli della tabella delle variabili che cadono in I, Q, M, DB, PI (solo lettura), T, C. Le altre righe dicono «non disponibile online». Osservazione online e simulatore si escludono, come nel 3A. _Se fosse sbagliato:_ nel 3D si passa allo stato delle variabili con un trigger di ciclo.
- **R6. Il backup è in sola lettura:** elenco dei blocchi di ogni tipo SDB compresi, poi l'upload di ciascuno su un collegamento `read-only` come `uploadAll`, in un file `.baapbak` (zip con un manifest JSON e i file MC7 grezzi). Funziona in RUN. Il ripristino è del 3D. Limiti e interruzione sono quelli di `uploadAll`.
- **R7. Il PLC di prova risponde a tutto ciò che è nuovo** (SZL, set clock, write var, SDB) con dati plausibili, così test ed e2e girano senza CPU.
- **R8. I testi sono in italiano**, compresi quelli degli eventi, con l'inglese dove l'interfaccia è tradotta. Le conferme native restano solo in italiano, come nel 3B.
- **R9. Versione 0.11.0.** Ogni nuova funzione che scrive resta segnata «mai provata su una CPU reale».

Decisioni prese da me durante la stesura (modificabili):

- **R10. L'interrogazione la guida il renderer.** Il main risponde solo a richieste: niente temporizzatori nuovi nel main, e chiudere la vista basta a fermare tutto. _Se fosse sbagliato:_ un temporizzatore nel main per finestra, con la stessa coda.
- **R11. `0xD401`–`0xD409` valgono tutti «non disponibile»** (la tabella di §3.3 li raggruppa come «funzione informativa non disponibile / errore diagnostica»). Gli altri codici sono errori della sezione.
- **R12. Set clock manda il giorno della settimana 0**, come la cattura verificata (§12.0), e la CPU lo ricalcola. L'ora del PC si prende dopo la conferma, da un solo `Date`, in ora locale.
- **R13. Le righe della conferma del comando le scrive il main** dai byte da scrivere (indirizzo e valore esadecimale). Un renderer difettoso non può mostrare un valore e scriverne un altro.
- **R14. PQ escluso online** (lettura della periferia d'uscita non possibile, scrittura diretta sulle uscite fisiche). T e C non si comandano (stessa regola del 2C). Al massimo 200 righe osservate online, per tenere basso il carico di comunicazione sulla CPU (circa 10 richieste per giro).
- **R15. Il backup esclude SFC e SFB** (sono del sistema operativo) e sta in un file fuori dal progetto. Il nome «Carica backup dal dispositivo online» è quello di TIA (§19.4).
- **R16. La tabella degli eventi sta in `@baaportal/s7comm` come dati** con `it` ed `en`, e un test la confronta con §7.6.3 del documento di protocollo, così le due copie non divergono.
- **R17. Restano fuori dal 3C** lo stato dei moduli (`0x0091`), i tipi di blocco (`0x0015`) e i contaore (`0x0132/0x0B`): non servono alle pagine richieste.
