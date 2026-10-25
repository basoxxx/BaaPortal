# Piano 3D — Osservazione online, stack e ripristino — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** dopo la diagnostica del 3C, l'utente osserva il programma sulla CPU vera e vede quando c'è un forzamento attivo. Con le funzioni sperimentali attive legge gli stack e ripristina un backup. L'utente:

- apre un blocco AWL, preme «Osservazione on/off» e vede, accanto a ogni riga visibile, RLC, STA, ACCU1 e la parola di stato, a richiesta anche ACCU2 e AR1, come in TIA. Le righe non elaborate sono grigie;
- vede «Forzamento attivo sulla CPU» nella diagnostica e nella barra di stato quando il LED FRCE è acceso;
- con «Funzioni sperimentali» attivo in Opzioni → Impostazioni:
  - legge gli stack di chiamata (BSTACK, USTACK, LSTACK) con la CPU in STOP;
  - ripristina nella CPU un file `.baapbak` del 3C, SDB compresi.

**Architettura:**

- **Protocollo** (`@baaportal/s7comm`):
  - codifica e decodifica delle funzioni di test (TIS, `docs/protocollo/s7comm.md` §18): block status v2, enable, delete, lista dei job, stack, funzioni TIS supportate (§7.5.9);
  - testi degli error code TIS di §18.7.1;
  - le indication non sollecitate arrivano al client;
  - due modi nuovi del filtro: `online-test`, che ammette solo le richieste TIS canoniche, e `online-restore`, che ammette in più gli SDB nella forma di §19.3.1;
  - `S7TestClient`.
- **Server di prova e CPU simulata** (`@baaportal/s7-server`, `@baaportal/sim`): rispondono a block status, enable, delete, lista dei job, stack, SZL `0x0174` con FRCE, download e `_DELE` degli SDB. Così test ed e2e girano senza CPU.
- **Osservazione nel main:**
  - `BlockStatusService` apre per ogni osservazione un suo collegamento `online-test`, crea un solo job e lo cancella sempre;
  - è il renderer a chiedere ogni risultato (un enable per richiesta);
  - un controllo nel main ferma il job se il renderer tace per 5 s.
- **Ripristino nel main:** `PlcWriteService.restore`, con le conferme native del 3B, su un collegamento `online-restore`. Il piano del ripristino lo costruisce il main dai byte del file: il renderer non manda mai byte di blocchi.
- **Interfaccia:** il comando «Osservazione on/off» del 2C vale anche per il PLC; la pagina «Stack di chiamata» sta in «Online e diagnostica»; la finestra «Ripristina backup nel dispositivo (sperimentale)» mostra l'esito per blocco.

**Tecnologie:** TypeScript, Electron (main, IPC, `dialog`), React 19, zustand, CodeMirror 6, fflate (lettura a flusso del `.baapbak`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §9 Tappa 3: «Osservazione del programma online, tabelle di controllo online e tabelle di forzamento (sulle CPU che supportano il forzamento)»; «Backup online, compresi i blocchi di sistema (SDB) copiati così come sono, e ripristino»;
- §8.4 Modalità online (colonne RLO/STA/ACCU1/ACCU2/Stato in AWL);
- §5 Sicurezza sulle macchine.

Piano generale: riga 3D. Protocollo: `docs/protocollo/s7comm.md` §7.5.4, §7.5.9, §10.4, §10.5, §15, §15.1bis, §15bis, §18 (in particolare §18.4.1, §18.5.1, §18.6, §18.7, §18.7.1, §18.9), §19.

## Global Constraints

- **Sicurezza per classe (§15, §15.1bis):**
  - il collegamento della sorveglianza resta `read-only`: aggiunge solo la lettura di `0x0174`;
  - il block status è «zona grigia», cioè cambia lo stato della sessione e non del processo. Passa da un collegamento `online-test` che ammette solo le forme canoniche di §18.4.1 e §18.7: block status v2, enable e delete di un job `0x13`, lista dei job, stack. Non c'è conferma, ma la barra di stato dice «Osservazione attiva — il tempo di ciclo della CPU aumenta»;
  - il ripristino è una **modifica**: conferme native e collegamento `online-restore`;
  - variable status (`0x02`), modify (`0x08`), force (`0x09`), force selection (`0x07`), breakpoint e HOLD (`0x0A`/`0x0B`), memory reset (`0x0C`), disable (`0x0D`), read job (`0x11`), replace job (`0x12`) e flash LED (`0x16`) restano FORBIDDEN in ogni modo.
- **Nessun job lasciato sulla CPU:**
  - un solo job di block status per CPU, fra tutte le finestre;
  - il job si cancella all'arresto, al cambio di finestra o di blocco, offline, alla perdita del collegamento, all'uscita dall'app e al silenzio del renderer;
  - alla connessione si cancellano solo i job orfani **nostri**, cioè quelli registrati in `tis-jobs.json`.
- **Ritmo:**
  - un enable al massimo ogni 250 ms, mai un secondo enable prima del risultato del precedente;
  - gli stack si leggono solo a richiesta (pulsante), mai a intervalli;
  - il LED FRCE si legge ogni 5 s dentro la sorveglianza del 3A.
- **Funzioni sperimentali:** stack e ripristino:
  - stanno dietro «Funzioni sperimentali (non provate su una CPU reale)», spento per default;
  - ogni loro testo, conferma ed esito dice «sperimentale».
- **Decodifica tollerante:** una risposta che non torna con i layout di §18 si mostra come «risposta non riconosciuta» più l'esadecimale. Mai un'eccezione verso il renderer, mai una pagina rotta.
- **Le incognite restano incognite (§18.9):** la SAZ come fine esclusiva, le dimensioni di DB1 e DB2, il modo in cui la CPU segnala una riga non eseguita, i layout degli stack, l'ordine dei blocchi utente nel ripristino, i valori dei DB. Il codice le marca `// ipotesi §18.x` e i limiti noti le elencano.
- **Mai provato su una CPU reale (spec §5):** tutto il 3D lo dice nei limiti noti e nelle note di rilascio.
- **Lingua e testi:**
  - italiano, con i termini di TIA Portal («Osservazione on/off», «Stack di chiamata», «Forzamento», «Carica backup nel dispositivo»);
  - le chiavi in `it.json` ed `en.json` sono uguali;
  - le conferme native restano solo in italiano, come nel 3B.
- **Clean-room e dati:**
  - chi realizza usa solo `docs/protocollo/s7comm.md`;
  - i vettori di test vengono solo dagli esempi del documento;
  - gli SDB dei test sono sintetici (`syntheticSdb`);
  - nei test e nei documenti solo IP di documentazione (192.0.2.x, 198.51.100.x, 203.0.113.x) e 127.0.0.1.

## Review Focus

1. **Un job che resta sulla CPU.** Il job deve essere cancellato in ognuno di questi casi: arresto, scorrimento, cambio di blocco, offline, cavo staccato, uscita dall'app, renderer bloccato, passaggio in STOP, `0xD0C8` a metà. Alla riconnessione si cancellano solo i job registrati da noi; `0xD0AE` li lascia stare. → test in Task 1, Task 2, Task 3 e Task 8.
2. **Il filtro ammette esattamente le forme canoniche per modo:**
   - `online-test`: block status v2 con trigger `0x0600`, maschere ⊆ `0x0F`, p4 uguale alla dimensione calcolata; enable e delete solo per `0x13`; lista dei job; stack;
   - `online-restore`: in più gli SDB negli intervalli documentati, con `'P'` nel download e in `_INSE` e `'A'` in `_DELE`, più la lista dei job;
   - nessun altro modo ammette gruppo 1 o SDB.
   → test in Task 1 e Task 6.
3. **Risposte inattese:**
   - block status con righe mancanti, troncato, con offset diversi o byte in più;
   - stack più corti, più lunghi o con la lunghezza sbagliata dell'IM151-8;
   - indication fuori tempo o di un altro job.
   Ogni caso dà righe grigie, «risposta non riconosciuta» con esadecimale, oppure lo scarto, mai un crash. → test in Task 1, Task 3 e Task 5.
4. **Ripristino interrotto o rifiutato:**
   - `0xD2A9` per più di 10 volte;
   - collegamento perso durante un SDB;
   - uscita dall'app;
   - lista dei job non vuota;
   - FRCE acceso;
   - CPU diversa.
   La tabella dell'esito dice il vero per ogni blocco («Esito sconosciuto» per quello in corso) e dice se la CPU è rimasta in STOP. → test in Task 6 e Task 7.
5. **Blocco online diverso da quello offline e finestra entro la PDU:**
   - compilato non aggiornato, testo modificato, checksum diverso, `0xD0C8`;
   - più righe visibili del limite;
   - PDU 240 e 480, con le maschere `0x03` e `0x0F`.
   → test in Task 1, Task 3 e Task 4.

---

### Task 1: Protocollo TIS, indication, filtro e client di test

**Files:**

- Create:
  - `packages/s7comm/src/s7/tis.ts`: codifica e decodifica TIS;
  - `packages/s7comm/src/s7/tisStacks.ts`: decodifica tollerante degli stack;
  - `packages/s7comm/src/testClient.ts`: `S7TestClient`.
- Modify:
  - `packages/s7comm/src/connection.ts`: modi `online-test` e `online-restore` (solo accettati qui, il filtro di `online-restore` è del Task 6), coda delle indication;
  - `packages/s7comm/src/readOnlyGuard.ts`: `assertOnlineTest`, `ConnectionMode`;
  - `packages/s7comm/src/s7/szlDiag.ts`: `tisFunctionsFrom`;
  - `packages/s7comm/src/index.ts`, `packages/s7comm/src/node/*` (`connectTestTcp`).
- Test: `packages/s7comm/test/tis.test.ts`, `packages/s7comm/test/tisStacks.test.ts`, `packages/s7comm/test/tisGuard.test.ts`, `packages/s7comm/test/indications.test.ts`

**Interfaces:**

- `TIS_SUB = { ISTACK: 0x03, BSTACK: 0x04, LSTACK: 0x05, ENABLE: 0x0e, DELETE: 0x0f, JOB_LIST: 0x10, BLOCK_STATUS: 0x13 }`.
- `REG = { STW: 0x01, ACCU1: 0x02, ACCU2: 0x04, AR1: 0x08 }`. `regBytes(mask)`: 2 per STW, 4 per ogni altro bit. Un bit fuori da `0x0F` dà `RangeError`.
- `encodeTisRequest(sub, tisParam, tisData): UserdataFrame`:
  - parametro userdata di 8 byte `00 01 12 08 12 41 SS 00 00 00 00 00`;
  - dati `ff 09 LLLL` + dimensione del parametro TIS (2) + dimensione dei dati TIS (2) + parametro + dati.
  - Non passa da `encodeUserdata`, che resta di sola lettura.
- `MGMT_PARAM` (enable e delete) e `JOB_LIST_PARAM`, 20 byte ciascuno, da §18.7. `STACK_PARAM` = `JOB_LIST_PARAM` (ipotesi di §18.6, «forma come read job list»).
- `reqReadJobList()`, `reqEnableJob(fn, job)` con dati `fn job`, `reqDeleteJob(fn, job)` con dati `00 01 fn job`.
- `BlockStatusRequest = { type: 'OB' | 'FB' | 'FC'; number; initMask; lines: { offset; mask }[] }`:
  - `blockStatusResultSize(r)` = `2 + regBytes(initMask) + Σ (2 + regBytes(mask))`;
  - `reqBlockStatus(r)` costruisce il parametro TIS di 28 byte (p2 = 1, p3 = 0, p4 = `blockStatusResultSize`, p5…p9 = 1, trigger `0x0600`, tipo `08`/`0C`/`0E`, numero, offset della prima riga, SAZ). La SAZ la passa il chiamante (`saz`), come fine esclusiva della finestra (ipotesi §18.4.1);
  - `maxBlockStatusLines(pduLength, mask)` è il minimo fra `floor((pdu − 36 − regBytes(mask)) / (2 + regBytes(mask)))` (risultato ≤ PDU − 34) e il limite della richiesta di §18.4.1.
- `decodeTisReply(param, data) → { kind: 'ack' | 'indication' | 'data'; sub; job; errorCode; tisParam?; tisData? }`:
  - `ack` = tg `0x81` senza dati TIS;
  - `data` = tg `0x81` con parametro TIS di 4 byte, come la lista dei job;
  - `indication` = tg `0x01`.
- `decodeBlockStatusResult(bytes, r) → { ok: true; initial: Regs; lines: (Regs | null)[]; trailing?: string } | { ok: false; why: string; hex: string }`, con `Regs = { stw?; accu1?; accu2?; ar1? }` e `null` = riga non elaborata.
- `stwBits(stw) → { er; rlo; sta; or; os; ov; cc0; cc1; br }` (bit 0–8 di §18.4).
- `decodeJobList(tisData) → { fn; job }[]`: voci da 4 byte. Una lunghezza non multipla di 4 dà `PROTOCOL`.
- `tisFunctionsFrom(s0131_2) → { blockStatusV2; istack; bstack; lstack; jobList; enable; del; codeAreaTrigger; forceMax }`, dalla mappatura di §7.5.9.
- `TIS_ERRORS: ReadonlyMap<number, { text: string; action: 'hide' | 'retry' | 'stop' | 'recreate' | 'ignore' | 'leave' | 'partial' | 'protection' | 'mode' }>` e `tisErrorText(code)`, con i testi italiani di §18.7.1. Un codice sconosciuto dà «errore TIS 0xDxxx».
- `tisStacks.ts`. Ogni funzione restituisce `{ ok: true; value } | { ok: false; why; hex }`:
  - `decodeBStack(data) → { entries: BStackEntry[]; rest?: string }`, con `BStackEntry = { blockType; number; returnAddress; db1; db2; ob?: { priority; time?: S7DateTime; rawTime? } }`;
  - `decodeIStack(data) → IStack`, con i 76 byte di §18.6;
  - `decodeLStack(data) → { block; address; local: Uint8Array; priority; time? }`;
  - `reqStack('ISTACK' | 'BSTACK')` con dati `00 00`, e `reqStack('LSTACK', { priority, depth })`.
- `S7Connection.nextIndication(match: { group; sub; seq }, timeoutMs, signal?) → Promise<DecodedUserdata | undefined>`. `undefined` vuol dire tempo scaduto; la connessione resta aperta.
- `S7TestClient extends S7Client`, con `connect(o)` sempre in `online-test`:
  - `tisFunctions()`, `readJobList()`;
  - `createBlockStatus(r, saz) → number`: il numero del job dall'ack della creazione;
  - `enableAndWait(fn, job, timeoutMs) → { result: Uint8Array } | { timeout: true }`;
  - `deleteJob(fn, job) → 'deleted' | 'notFound' | 'otherConnection'`;
  - `readStack(kind, args?) → Uint8Array`.
  - Un error code TIS diverso da 0 nell'ack lancia `S7Error('CPU_ERROR', tisErrorText(code), { errorClass, errorCode })`.

Regole:

- **Indication (§18.1):**
  - una PDU userdata con nibble di tipo 0 non risolve mai la richiesta in corso: va nella coda delle indication;
  - la coda tiene al massimo 8 PDU; le più vecchie si scartano e si contano in `ignoredCount`;
  - nei modi `read-only` e `online-write` le indication si scartano come oggi;
  - il `pduRef` delle indication non si usa (sconosciuto);
  - una indication che arriva dopo la richiesta di delete si scarta (verificato, §18.4.1).
- **Numero del job:** si usa solo quello dell'ack della richiesta che crea il job, mai quello degli ack di enable e delete (§18.1).
- **Delete:** `0xD0A5` → `notFound`; `0xD0AE` → `otherConnection`; ogni altro codice lancia.
- **Risultato del block status, tollerante:**
  - i primi 2 byte devono essere l'offset della prima riga, altrimenti `ok: false`;
  - poi si leggono le righe una per una, e ogni riga deve ripetere il suo offset (§18.4.1). Se al posto della riga attesa c'è l'offset di una riga successiva della richiesta, quelle in mezzo diventano `null` e la lettura continua;
  - se i byte finiscono, le righe restanti sono `null` (ipotesi su come la CPU segnala una riga non eseguita);
  - un offset che non è di nessuna riga chiesta dà `ok: false` con l'esadecimale;
  - byte in più dopo l'ultima riga: i valori restano, con `trailing` in esadecimale.
  - La risincronizzazione vale quando tutte le righe hanno la stessa maschera, come sempre nel client. Con maschere diverse, il primo offset diverso dà `ok: false`.
- **Stack, tolleranti:**
  - BSTACK usa la lunghezza vera del messaggio, non quella dichiarata (difetto dell'IM151-8, §18.6);
  - una voce incompleta finisce in `rest` in esadecimale, e le voci intere restano;
  - ISTACK più corto di 76 byte dà `ok: false`; più lungo si decodifica nei primi 76, con il resto in esadecimale;
  - un'ora non valida resta come `rawTime`, come nel 3C.
- **Filtro `online-test`:** è `assertReadOnly` più gli userdata del gruppo 1 di forma TIS (`00 01 12 08 12 41`), e solo se i byte coincidono con la ricodifica:
  - `0x13`: tipo OB, FB o FC; p1 = 0, p2 = 1, p3 = 0, p5…p9 = 1, trigger `0x0600`; maschere ⊆ `0x0F` e uguali su tutte le righe; offset pari e crescenti; da 1 a `maxBlockStatusLines(pdu, mask)` righe; p4 uguale a `blockStatusResultSize`; offset della prima riga < SAZ; ultima riga < SAZ;
  - `0x0E` enable e `0x0F` delete: solo con funzione `0x13`, e il delete con `00 01`;
  - `0x10`, `0x03`, `0x04` e `0x05`: solo la forma canonica;
  - ogni altro gruppo 1, gruppo 2 e gruppo 5, write var, download e PI service danno FORBIDDEN.
- **Gli altri modi:** `read-only` e `online-write` continuano a rifiutare tutto il gruppo 1.

- [ ] **Step 1: Test** (vettori da §18)
  - `reqBlockStatus dell'esempio §18.4 (OB1, iniziali 0x03, righe 0/01, 2/01, 6/03, 8/02, A/03, E/03, SAZ 0x0010) → param TIS 0000 0001 0000 002e 0001×5 0600 0008 0001 0000 0010 e dati 00 06 00 03 | 0000 00 01 | … | 000e 00 03`
  - `encodeTisRequest del block status: parametro 00 01 12 08 12 41 13 00 00 00 00 00, dati ff 09 00 3c 00 1c 00 1c + 56 byte`
  - `blockStatusResultSize dell'esempio → 46`
  - `reqEnableJob(0x02, 2) uguale a §18.3: ff 09 00 1a 00 14 00 02 + MGMT_PARAM + 02 02`
  - `reqDeleteJob(0x13, 3) → dati TIS 00 01 13 03`
  - `reqReadJobList uguale alla forma di §18.7 (p5 = 1)`
  - `maxBlockStatusLines: PDU 240 maschera 0x03 → 24; 0x07 → 16; 0x0F → 11; PDU 480 0x03 → 54`
  - `decodeBlockStatusResult del risultato §18.4 → iniziali STW 0x0007 ACCU1 0; 0x0006 STW 0x0106 ACCU1 2; 0x0008 ACCU1 0x1111; 0x000E ACCU1 0x4444`
  - `stwBits(0x0106) → BR 1, STA 1, RLO 1, gli altri 0`
  - `risultato troncato dopo 4 righe (maschera 0x03) → ultime 2 righe null`
  - `risultato senza la riga 0x0002 (maschera 0x03) → 0x0002 null, 0x0006 con i suoi valori`
  - `offset 0x0004 che non è chiesto → ok:false con esadecimale`
  - `primo offset diverso da quello chiesto → ok:false`
  - `2 byte in più in coda → valori tenuti, trailing "abcd"`
  - `decodeTisReply: ack con seq 03 → job 3; indication tg 01 sub 13 seq 03 → indication`
  - `decodeJobList(10 03 00 00) → [{ fn: 0x10, job: 3 }]`
  - `tisFunctionsFrom: funkt be fd 4f, trgereig 7d → v2, ISTACK, BSTACK, LSTACK, lista, enable, delete, area di codice; be fd 03 → niente v2`
  - `tisErrorText(0xD0C8) → «block status interrotto per incoerenza fra job e programma»; 0xD0FF → «errore TIS 0xD0FF»`
  - `decodeBStack: OB1 + FC10 → 2 voci, OB1 con priorità 1; lunghezza dichiarata 4 byte più corta → stesse voci`
  - `decodeBStack con 10 byte in più → voci intere più rest in esadecimale`
  - `decodeIStack: 76 byte → STW, ACCU1, blocco interrotto; 40 byte → ok:false con esadecimale`
  - `indication arrivata prima della richiesta di attesa → consegnata da nextIndication`
  - `9 indication non chieste → la più vecchia scartata, ignoredCount + 1`
  - `nextIndication senza risultato in 2 s → undefined, connessione aperta`
  - `indication in modo read-only → scartata, nessuna richiesta risolta`
  - `online-test ammette create, enable, delete, lista e stack canonici`
  - `online-test rifiuta: p2 = 2, p3 = 1, trigger 0x0200, p4 sbagliato, maschera 0x10 o 0x20, maschere diverse, offset dispari o decrescenti, 25 righe con PDU 240, tipo DB`
  - `online-test rifiuta 0x02, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x11, 0x12, 0x16, enable con funzione 0x02, delete con 00 00`
  - `online-test rifiuta write var, request download, PLC stop`
  - `read-only e online-write rifiutano lista dei job e block status`
- [ ] **Step 2–4:** `--project s7comm`.
- [ ] **Step 5: Commit** — `feat(s7comm): funzioni di test TIS, indication e modo online-test`

### Task 2: Server di prova e CPU simulata per TIS e FRCE

**Files:**

- Create: `packages/s7-server/src/tis.ts`: tabella dei job per CPU, risposte a create, enable, delete, lista e stack.
- Modify:
  - `packages/s7-server/src/session.ts`: gruppo 1 (oggi risponde «non implementato»), invio di una PDU non sollecitata (`pushIndication`), cancellazione dei job della sessione quando si chiude;
  - `packages/s7-server/src/backend.ts`:
    - `blockStatus?(type, number, lines: { offset; mask }[]): Promise<(Regs | null)[] | undefined>`, il prossimo ciclo;
    - `stacks?(): { bstack; istack; lstack(priority, depth) } | undefined`;
    - `forceActive?: boolean`;
  - `packages/s7-server/src/szlData.ts`: `0x0131` indice 2 (`be fd 4f` / `7d 00`, force 10; con `tisV2: false`, `be fd 03`); FRCE in `0x0019`, `0x0074` e `0x0174` da `forceActive`;
  - `packages/s7-server/src/faults.ts`:
    - `orphanJobs?: boolean`: i job sopravvivono alla chiusura della sessione e si cancellano da un'altra;
    - `tisError?: { sub: number; code: number }`;
    - `tisMalformed?: number[]`: sottofunzioni a cui rispondere con dati troncati;
  - `packages/s7-server/src/fakeCpu.ts`: opzioni `forceActive`, `tisV2`, valori sintetici del block status;
  - `packages/sim/src/backend.ts`: `blockStatus` con `setMonitor` e `monitorSnapshot` dopo il ciclo successivo, `stacks` in STOP.
- Test: `packages/s7-server/test/tis.test.ts`, `packages/sim/test/backend.test.ts`

Regole (sono scelte del server di prova; quelle che non vengono dal documento sono scritte nel codice come «scelta del server di prova»):

- **Create `0x13`:**
  - controlla la forma come il filtro;
  - p4 diverso dalla dimensione calcolata → `0xD032`;
  - blocco assente → `0xD012`;
  - CPU in STOP → `0xD081` (ipotesi §18.4.1);
  - più di 4 job → `0xD062`;
  - lo stesso blocco osservato da un'altra sessione → `0xD063`;
  - numero del job = contatore della CPU, che cresce a ogni richiesta TIS (§18.1).
- **Enable:**
  - ack, poi **una** indication quando il blocco è eseguito (FakeCpu subito; CPU simulata alla fine del ciclo successivo);
  - le righe non eseguite nel ciclo **mancano** dall'indication (scelta coerente con l'ipotesi del client);
  - un blocco mai chiamato non manda nessuna indication;
  - job inesistente → `0xD0A5`; job di un'altra sessione → `0xD0AE`.
- **Delete:** `00 01 fn job`; `0xD0A5` se non c'è; `0xD0AE` se è di un'altra sessione, salvo `orphanJobs`.
- **Cambio di modo:** al passaggio in STOP la CPU cancella i job di block status (indizio `0xD0C2`/`0xD0C7` di §18.4.1). Un download del blocco osservato fa rispondere all'enable successivo `0xD0C8`.
- **Lista dei job:** i job vivi più la chiamata stessa (`10 nn`).
- **Stack:**
  - solo in STOP o HOLD; in RUN `0xD081`;
  - FakeCpu: BSTACK = OB1 + FC 10 (con priorità 1 e un'ora), ISTACK di 76 byte, LSTACK di 20 byte;
  - CPU simulata: BSTACK = OB1 se esiste, LSTACK a zero.
- **FRCE:** acceso solo con `forceActive`. Il server non implementa il forzamento.

- [ ] **Step 1: Test**
  - `0x0131/2 → be fd 4f, 7d 00, force 10; tisV2 false → be fd 03`
  - `create + enable su OB1 della FakeCpu → ack seq n, poi indication sub 13 seq n con la dimensione p4`
  - `p4 sbagliato → 0xD032; FC 99 assente → 0xD012; in STOP → 0xD081`
  - `cinque job → il quinto 0xD062`
  - `enable senza un risultato pendente → una sola indication per enable`
  - `CPU simulata: L 5 / T MW 10 in OB1 → ACCU1 5 sulla riga di T; riga dopo un salto preso → assente dall'indication`
  - `FC mai chiamato → nessuna indication in 1 s`
  - `delete → la lista dei job contiene solo 10 nn; secondo delete → 0xD0A5`
  - `job di un'altra sessione → 0xD0AE; con orphanJobs → cancellabile`
  - `sessione chiusa → i suoi job spariscono; con orphanJobs → restano`
  - `RUN → STOP → enable → 0xD0A5`
  - `download di OB1 osservato → enable → 0xD0C8`
  - `stack in RUN → 0xD081; in STOP BSTACK con OB1 e FC10, ISTACK di 76 byte`
  - `tisMalformed [0x04] → BSTACK di 7 byte`
  - `forceActive → LED FRCE 0x0006 acceso in 0x0174 indice 6`
- [ ] **Step 2–4:** `--project s7-server --project sim`.
- [ ] **Step 5: Commit** — `feat(s7-server,sim): block status, job e stack nel PLC di prova`

### Task 3: Osservazione del blocco nel processo principale

**Files:**

- Create:
  - `apps/desktop/src/main/plc/blockStatus.ts`: `BlockStatusService`;
  - `apps/desktop/src/main/plc/tisJobs.ts`: registro dei job nostri in `userData/tis-jobs.json`.
- Modify:
  - `plcService.ts`: `onLinkEnd(owner, cb) → () => void`, chiamato da `drop`, `lost` e `disconnect`; `onConnect(cb)` per la pulizia dei job orfani;
  - `plcIpc.ts`: `plc:statusStart`, `plc:statusWindow`, `plc:statusRead`, `plc:statusStop`;
  - il preload, `packages/ui/src/bridge.ts`, `packages/ui/src/online/plcTypes.ts`;
  - `apps/desktop/src/main/index.ts`: `before-quit` aspetta `statusService.stopAll()` (al massimo 1 s).
- Test: `apps/desktop/test/plc/blockStatus.test.ts`, `apps/desktop/test/plc/tisJobs.test.ts`

**Interfaces:**

- `PlcStatusRequest = { type: 'OB' | 'FB' | 'FC'; number; expect: { checksum; mc7Length }; offsets: number[]; saz: number; mask: number }`.
- `parseStatusRequest(raw, maxLines?) → PlcStatusRequest | string`:
  - `mask` ⊆ `0x0F` e contiene `0x01`;
  - offsets pari, crescenti, `< saz ≤ mc7Length`;
  - da 1 a 64 righe; il limite vero lo applica `start`.
- `start(owner, raw) → { ok: true; maxLines; pduLength } | { ok: false; reason: 'offline' | 'different' | 'missing' | 'unsupported' | 'busy' | 'protection' | 'error'; error }`.
- `window(owner, raw) → { ok: true } | { ok: false; error }`.
- `read(owner) → PlcStatusReadResult`:
  - `{ ok: true; state: 'values'; lines: { offset; regs: Regs | null }[]; partial?: boolean }`;
  - `{ ok: true; state: 'stop' }`;
  - `{ ok: true; state: 'waiting' }`;
  - `{ ok: false; ended: true; error }`.
- `stop(owner): Promise<void>`, `stopAll(): Promise<void>`, `active(owner): boolean`.
- `TisJobStore = { add(cpu, fn, job); remove(cpu, fn, job); list(cpu) }`, su file, iniettabile.
- Costruttore `{ service: Pick<PlcService, 'target' | 'modeOf' | 'onLinkEnd'>; connect?; jobs: TisJobStore; now?; timers?; idleMs = 5000; resultTimeoutMs = 2000; minEnableMs = 250 }`.

Regole:

- **Avvio:**
  1. bersaglio da `service.target(owner)`, come nel 3B, e nessun indirizzo dal renderer;
  2. una sola osservazione per CPU (`cpuKey`) fra tutte le finestre. Un'altra finestra riceve `busy`: «Osservazione già attiva su questa CPU in un'altra finestra». Una nuova `start` della stessa finestra chiude prima la vecchia;
  3. collegamento `online-test`, identità uguale a quella del bersaglio (come `PlcWriteService.open`);
  4. `tisFunctions()`: senza v2 o senza trigger di area di codice → `unsupported`, «Questa CPU non supporta lo stato del blocco v2»;
  5. block info del blocco: assente → `missing`; checksum o lunghezza MC7 diversi da `expect` → `different`, «Il blocco nella CPU è diverso da quello del progetto: caricarlo o confrontarlo prima di osservarlo»;
  6. pulizia degli orfani nostri (vedi sotto);
  7. finestra ridotta a `maxBlockStatusLines(pduLength, mask)` righe, dalla prima;
  8. se il modo è RUN, `createBlockStatus` e registrazione nel `TisJobStore`.
- **Lettura** (una per chiamata, guidata dal renderer):
  - una sola alla volta: una seconda chiamata mentre la prima aspetta riceve `waiting`;
  - fra due enable passano almeno 250 ms (si attende il resto);
  - modo STOP o HOLD, da `service.modeOf`: se c'è un job si cancella, e il risultato è `stop`. Al ritorno in RUN il job si ricrea alla lettura successiva;
  - nessun risultato in 2 s → `waiting`, e le righe vanno grigie nell'interfaccia. Il job resta e non parte un altro enable finché il risultato non arriva;
  - un risultato si decodifica con `decodeBlockStatusResult`; `ok: false` → `ended`, con il messaggio «risposta non riconosciuta» e l'esadecimale.
- **Reazione agli error code (§18.7.1):**
  - `0xD0A5`, `0xD0C2` o `0xD0C7` sull'enable: job finito; si ricrea alla lettura successiva se il modo è RUN;
  - `0xD0C8`: fine, con «Il blocco nella CPU è cambiato: confrontarlo di nuovo»;
  - `0xD062`: fine, con «troppi job di test sulla CPU»; `0xD063`: fine, con «un altro PG osserva lo stesso punto»;
  - `0xD0A1` → `protection`; `0xD003` → `unsupported`; `0xD0AB`/`0xD0AC` → «CPU in modo processo: lo stato del blocco è limitato»;
  - `0xD0CC` → valori con `partial: true`;
  - `0xD012` o `0xD032` → fine, con il messaggio TIS (errore interno da segnalare).
- **Fine garantita:** `deleteJob`, poi rimozione dal registro, poi chiusura del collegamento. Succede a ognuno di questi eventi:
  - `stop`;
  - una nuova `start` della stessa finestra, cioè cambio di blocco;
  - `onLinkEnd` (offline, collegamento perso);
  - `before-quit`;
  - finestra distrutta;
  - nessuna `read` né `window` per `idleMs`.
  Il delete ha un limite di 1 s; se fallisce, il job resta nel registro per la pulizia successiva.
- **Cambio di finestra:** `window` cancella il job e ne crea uno nuovo con le nuove righe. Più cambi entro 250 ms si riducono all'ultimo.
- **Orfani:** all'avvio dell'osservazione e a ogni `onConnect` di una CPU con voci nel registro:
  - lista dei job; per ogni voce `0x13` presente **e** registrata si fa delete;
  - `deleted` o `notFound` tolgono la voce dal registro; `otherConnection` la toglie e lascia il job;
  - le voci del registro che non sono nella lista si tolgono;
  - i job non registrati non si toccano mai.
- **Registro:** il file si scrive in modo atomico (temporaneo + rinomina), al massimo 64 voci. Un file illeggibile vale come vuoto, con un avviso nel log.

- [ ] **Step 1: Test**
  - `start + read contro il PLC di prova con OB1 L 5 / T MW 10 → riga di T con ACCU1 5, STW presente`
  - `start con checksum diverso → different, nessun job creato (lista dei job vuota)`
  - `blocco assente → missing; CPU con tisV2 false → unsupported`
  - `30 righe con PDU 240 e maschera 0x03 → maxLines 24, job creato con 24 righe`
  - `due read di fila → il secondo enable parte ≥ 250 ms dopo il primo (orologio iniettato)`
  - `read durante un'altra read → waiting, un solo enable`
  - `FC mai chiamato → waiting dopo 2 s, nessun secondo enable`
  - `CPU in STOP → state stop, job cancellato; di nuovo RUN → job ricreato e valori`
  - `stop → lista dei job vuota, collegamento chiuso, registro vuoto`
  - `window da [0..10] a [20..30] → delete, poi create con le nuove righe; tre window in 100 ms → un solo create`
  - `seconda finestra sulla stessa CPU → busy`
  - `onLinkEnd (offline) → job cancellato`
  - `renderer muto per 5 s → job cancellato`
  - `stopAll all'uscita → ogni job cancellato entro 1 s`
  - `0xD0C8 sull'enable → ended con «confrontarlo di nuovo»; 0xD0A5 → ricreato alla read successiva`
  - `risultato malformato (tisMalformed) → ended con esadecimale, nessuna eccezione`
  - `orfani: job 0x13 n. 5 registrato e presente (orphanJobs) → cancellato; job 0x13 n. 6 non registrato → lasciato`
  - `orfano di un'altra connessione → 0xD0AE, voce tolta, job lasciato`
  - `parseStatusRequest: offset dispari, decrescenti, ≥ saz, maschera 0x10, 65 righe → errore senza collegamento`
  - `tisJobs: file corrotto → vuoto; 65 voci → la più vecchia esce`
- [ ] **Step 2–4:** `--project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(desktop): stato del blocco online con job unico e cancellazione garantita`

### Task 4: «Osservazione on/off» del blocco AWL sul PLC

**Files:**

- Create: `packages/ui/src/online/plcMonitor.ts`: `PlcMonitorController`, che interroga ogni 250 ms dalla fine della richiesta precedente, con temporizzatore iniettabile.
- Modify:
  - `state/store.ts`: `online.monitor: PlcMonitorUiState | null`, `online.monitorLines`, `online.monitorRegs: { accu2: boolean; ar1: boolean }`;
  - `commands/commands.ts`: `online.monitor`:
    - online sul dispositivo del blocco → PLC;
    - simulazione attiva → simulatore, come oggi;
    - `isChecked` sull'uno o sull'altro;
  - `sim/monitorStatus.ts`: `plcMonitorReasonOf(s, deviceId, blockId)`, che riusa le regole del 2C (`stale`, `noLines`) e la firma del compilato (`signatureOf` di `online/compare.ts`, esportata);
  - `editors/awl/monitorExtension.ts`: `MonitorCell` con `accu2?` e `ar1?` facoltativi e i bit della STW; la cella diventa una colonna allineata a destra (CSS), anche per il simulatore;
  - `editors/block/NetworksView.tsx`: righe visibili con `IntersectionObserver` sulle reti; la sorgente dei valori è il simulatore o il PLC;
  - `editors/block/MonitorBar.tsx`: stato, motivi e caselle «ACCU2» e «AR1»;
  - `project/StatusBar.tsx`: «Osservazione attiva — il tempo di ciclo della CPU aumenta»;
  - `i18n` (`plcMonitor.*`).
- Test: `packages/ui/test/online/plcMonitor.test.ts`, `packages/ui/test/editors/monitorExtension.test.ts`, `packages/ui/test/editors/networksViewPlc.test.tsx`

**Interfaces:**

- `PlcMonitorUiState = { deviceId; blockId; reason: 'ok' | 'stale' | 'noLines' | 'edited' | 'different' | 'missing' | 'unsupported' | 'busy' | 'stop' | 'waiting' | 'ended'; message?: string; partial?: boolean }`.
- `windowFor(lineMap: LineMapRow[], visibleNetworks: number[], maxLines) → { offsets: number[]; saz: number }`:
  - offsets delle istruzioni delle reti visibili, dalla prima, al massimo `maxLines`;
  - `saz` = offset dell'istruzione dopo l'ultima scelta, oppure la lunghezza MC7.
- `monitorLinesFromPlc(lineMap, lines, hex) → Map<number, MonitorLines>`, con le stesse regole di `monitorLinesByNetwork` (una `CALL` espansa mostra l'ultima voce eseguita).

Regole:

- **Quando si può:**
  - blocco OB, FB o FC del dispositivo collegato;
  - compilato aggiornato (`stale` → «Compilare il blocco»);
  - mappa delle righe presente;
  - testo confermato (`edited` sospende come nel 2C).
  - Il confronto con la CPU lo fa il main con la firma del compilato; `different` mostra il messaggio e il pulsante «Confronta con la CPU».
- **Colonne, come TIA:** RLC, STA, STANDARD (ACCU1), poi la STW in 9 bit, e a richiesta ACCU2 e AR1:
  - la maschera è `0x03`, più `0x04` con ACCU2 e `0x08` con AR1;
  - cambiare le caselle rifà la finestra (meno righe con più registri);
  - i bit OR, OS, OV, A0 (CC0) e A1 (CC1) vengono da `stwBits`, nel suggerimento della cella.
- **Righe non elaborate:** `null` → grigie, senza valori. Con `waiting` tutte le righe della finestra sono grigie e la barra dice «Nessun risultato: il blocco non è elaborato o la finestra non è raggiunta».
- **In STOP:** nessun valore. La barra dice «CPU in STOP: nessun valore» e l'osservazione resta accesa.
- **Finestra:** cambia con lo scorrimento (al massimo una `plcStatusWindow` ogni 250 ms) e al cambio delle caselle. Le righe visibili oltre `maxLines` restano senza valori, e la barra dice «Osservate le prime N righe visibili».
- **Fine:** si spegne con il comando, con la chiusura o il cambio dell'editor, con il blocco non più visibile, offline o al collegamento perso. Ogni volta chiama `plcStatusStop`. Un `ended` spegne e mostra il messaggio.
- **Barra di stato:** mentre l'osservazione PLC è accesa compare «Osservazione attiva — il tempo di ciclo della CPU aumenta» (stile di avviso).
- **Esclusione:** simulazione e online non convivono già dal 3A. L'osservazione segue la sorgente attiva.

- [ ] **Step 1: Test**
  - `plcMonitor: on → plcStatusStart con la firma del compilato e gli offset delle reti visibili, poi plcStatusRead ogni 250 ms dalla fine della precedente`
  - `read lenta (1 s) → nessuna sovrapposizione`
  - `windowFor: 3 reti visibili con 40 istruzioni, maxLines 24 → prime 24, saz = offset della 25ª`
  - `windowFor: ultima istruzione del blocco → saz = lunghezza MC7`
  - `casella ACCU2 → maschera 0x07 e nuova finestra`
  - `scorrimento → una sola plcStatusWindow in 250 ms`
  - `different → barra con «Confronta con la CPU», nessuna read`
  - `stale e edited → nessuna start`
  - `state stop → «CPU in STOP: nessun valore», nessuna cella`
  - `riga null → classe baa-mon-off; waiting → tutte grigie con il messaggio`
  - `monitorLinesFromPlc: CALL espansa su 3 offset → valori dell'ultimo eseguito`
  - `editor chiuso, cambio di blocco, offline → plcStatusStop`
  - `ended → osservazione spenta con il messaggio`
  - `cella: STW 0x0106 → RLC 1, STA 1, suggerimento con OR 0 OS 0 OV 0 A0 0 A1 0`
  - `barra di stato: «Osservazione attiva» solo con l'osservazione PLC accesa`
  - `simulazione attiva → online.monitor usa il simulatore, nessuna chiamata al PLC`
  - `en: «Monitoring active — CPU cycle time increases»`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): osservazione del blocco AWL sulla CPU con colonne a destra`

### Task 5: FRCE, stack di chiamata e impostazione sperimentale

**Files:**

- Create:
  - `apps/desktop/src/main/plc/stacks.ts`: `readStacks(owner)`;
  - `packages/ui/src/editors/diag/StacksPage.tsx`.
- Modify:
  - `plcService.ts`: la sorveglianza legge `0x0174` indice 6 ogni 5 giri, con l'evento `{ kind: 'force'; active: boolean }`; `PlcConnectResult` ha `force?: boolean`;
  - `diagnostics.ts`: `DiagPart` `'force'`;
  - `plcIpc.ts` (`plc:readStacks`), il preload, il bridge, `plcTypes.ts`;
  - `packages/ui/src/settings/settings.ts`: `online: { experimental: boolean }`, predefinito `false`, con `normalizeSettings`;
  - `dialogs/SettingsDialog.tsx`: sezione «Online» con la casella «Funzioni sperimentali (non provate su una CPU reale)» e una nota;
  - `online/diagController.ts` (`DiagPage` `'stacks'`), `editors/diag/OnlineDiagView.tsx`;
  - `project/StatusBar.tsx`: «Forzamento attivo sulla CPU»;
  - `online/plcController.ts`: l'evento `force`;
  - `i18n` (`diag.stacks.*`, `diag.force.*`, `settings.online.*`).
- Test: `apps/desktop/test/plc/stacks.test.ts`, `apps/desktop/test/plc/plcService.test.ts` (FRCE), `packages/ui/test/editors/stacksPage.test.tsx`, `packages/ui/test/settings/settings.test.ts`, `packages/ui/test/project/statusBarForce.test.tsx`

**Interfaces:**

- `readStacks(owner, opts) → { ok: true; mode; bstack: Decoded<BStack>; ustack: Decoded<IStack>; lstack: { depth; value: Decoded<LStack> }[] } | { ok: false; reason: 'run' | 'unsupported' | 'offline' | 'error'; error }`.
  - `Decoded<T> = { ok: true; value: T } | { ok: false; why; hex }`.
  - `Uint8Array` viaggia come esadecimale.

Regole:

- **FRCE:**
  - la sorveglianza legge `0x0174` indice `0x0006` (§7.5.4) una volta ogni 5 giri (circa 5 s), nella stessa coda;
  - `0xD401`–`0xD409` → `force` assente, e la lettura non si ripete più su quel collegamento;
  - l'evento parte solo a un cambio;
  - un errore di questa lettura non conta nei `failures` della sorveglianza.
  - Nella diagnostica, la pagina «Generale» mostra «Forzamento attivo sulla CPU», con la nota «Per forzare o terminare il forzamento usare TIA Portal o STEP 7».
  - Nella barra di stato compare lo stesso testo, in stile di avviso, solo online e con FRCE acceso.
  - Nessuna colonna «Forza» nelle tabelle di controllo.
- **Stack** (solo con l'impostazione sperimentale):
  - pagina «Stack di chiamata (sperimentale)» in «Online e diagnostica», sempre in elenco;
  - con l'impostazione spenta dice «Attivare le funzioni sperimentali in Opzioni → Impostazioni»;
  - in RUN dice «disponibile solo in STOP» e il pulsante «Leggi stack» è disabilitato;
  - il pulsante è l'unico modo di leggere: niente interrogazione periodica.
- **Lettura nel main:**
  1. modo da `service.modeOf`, che deve essere STOP o HOLD;
  2. collegamento `online-test` a parte, con l'identità ricontrollata;
  3. rilettura di `0x0424`, che deve dare ancora STOP o HOLD, altrimenti `run`;
  4. `tisFunctions()`;
  5. BSTACK, poi USTACK (ISTACK `0x03`), poi un LSTACK per ogni voce del BSTACK (priorità della voce OB, profondità = indice), al massimo 16;
  6. chiusura.
  - Ogni risposta è decodificata a parte: una malformata non ferma le altre. `0xD081` → `run`; `0xD0C5` → «stack incoerente: blocchi ricaricati dopo lo STOP».
- **Presentazione:**
  - **BSTACK:** tabella con blocco, indirizzo di ritorno, DB1 e DB2, e per gli OB la priorità e l'ora;
  - **USTACK** (stack delle interruzioni): blocco interrotto e indirizzo, blocco di ripresa, ACCU1 e ACCU2, AR1 e AR2, STW in bit, DB1 e DB2, i 12 byte di avvio dell'OB in esadecimale, l'ora;
  - **LSTACK:** dati locali in esadecimale (16 byte per riga) per la voce scelta;
  - `ok: false` → «risposta non riconosciuta» più l'esadecimale;
  - una nota fissa: «Formato degli stack da una sola fonte, mai visto su una CPU reale».

- [ ] **Step 1: Test**
  - `sorveglianza: forceActive → evento force true entro 5 giri; spento → force false; una sola lettura 0x0174 ogni 5 giri`
  - `0x0174 non disponibile → nessun evento e nessuna nuova lettura`
  - `errore della lettura FRCE → sorveglianza non perde il collegamento`
  - `readDiagnostics(['force']) → value true con forceActive`
  - `readStacks in RUN → run, nessun collegamento online-test aperto`
  - `readStacks in STOP contro FakeCpu → BSTACK OB1 + FC10, USTACK con STW, 2 LSTACK`
  - `CPU che passa in RUN fra la sorveglianza e la rilettura → run`
  - `tisMalformed [0x04] → bstack ok:false con esadecimale, ustack ok`
  - `settings: experimental assente → false; valore non booleano → false`
  - `pagina stack con impostazione spenta → invito alle impostazioni, nessuna chiamata`
  - `pagina stack in RUN → «disponibile solo in STOP», pulsante disabilitato`
  - `pagina stack: risposta non riconosciuta → testo e esadecimale`
  - `barra di stato: FRCE acceso online → «Forzamento attivo sulla CPU»; offline → niente`
  - `Generale: FRCE acceso → riga e nota su TIA/STEP 7`
- [ ] **Step 2–4:** `--project @baaportal/desktop --project ui`.
- [ ] **Step 5: Commit** — `feat(desktop,ui): forzamento attivo dal LED FRCE e stack di chiamata sperimentali`

### Task 6: Ripristino nel main, SDB nel protocollo e lettura sicura del `.baapbak`

**Files:**

- Create: `apps/desktop/src/main/plc/restore.ts`: `planRestore`, `restoreLines`, ordine e intervalli degli SDB.
- Modify:
  - `packages/s7comm/src/readOnlyGuard.ts`: `assertOnlineRestore`;
  - `packages/s7comm/src/writeClient.ts`:
    - `S7WriteClient.connect(o, mode: 'online-write' | 'online-restore' = 'online-write')`;
    - `deleteSystemBlock(number)`;
    - `downloadBlock(file, { busyRetry? })`;
    - `readJobList()`, che riusa `tis.ts`;
  - `packages/s7comm/src/s7/download.ts`: SDB nel request download, se manca;
  - `plcWrite.ts`: `restorePlan(owner)`, `restore(owner, raw)`, `WriteClient` con i metodi nuovi, `connect` con il modo;
  - `plcIpc.ts` (`plc:restorePlan`, `plc:restore`, `plc:restoreInterrupt`), il preload, il bridge, `plcTypes.ts`;
  - `confirm.ts`: `e2eOpenPath()` (`BAAPORTAL_E2E_OPEN_PATH`, solo `!app.isPackaged`);
  - `packages/project/src/backupFile.ts`: lettura a flusso con un tetto sui byte veri;
  - `packages/s7-server/src/session.ts`, `backend.ts`, `faults.ts` (`insertBusy?: number`), `packages/sim/src/backend.ts`: download, `_INSE` e `_DELE` degli SDB.
- Test: `packages/s7comm/test/restoreGuard.test.ts`, `packages/s7comm/test/writeClient.test.ts`, `packages/project/test/backupFile.test.ts`, `packages/s7-server/test/sdbWrite.test.ts`, `apps/desktop/test/plc/restore.test.ts`

**Interfaces:**

- `RESTORE_SDB = { single: [0, 1, 3, 4, 5, 6, 7], ranges: [[1000, 1999], [2000, 2999]] }` e `isRestorableSdb(n)`. SDB 2 non è mai ripristinabile.
- `RestorePlan`:
  - `cpuMismatch?: { backup: string; online: string }`;
  - `steps: RestoreStep[]`, dove `RestoreStep = { kind: 'deleteSdb' | 'load'; type; number; file?: Uint8Array }`;
  - `skipped: { type; number; why }[]`;
  - `cpuOnly: { type; number }[]`.
- `planRestore(manifest, files, online: OnlineBlock[]) → RestorePlan | string`.
- `PlcWriteService.restorePlan(owner) → { ok: true; token; rows: RestoreRow[]; cpuMismatch?; warnings: string[] } | { ok: false; error } | { ok: false; cancelled: true }`.
  - `RestoreRow = { name; action: 'load' | 'delete' | 'skip' | 'keep'; why? }`.
- `PlcWriteService.restore(owner, raw: { token; restart: boolean }) → { ok: boolean; cancelled?: true; error?; rows: RestoreOutcomeRow[]; cpuStopped: boolean; restarted?: boolean; diag?: DiagRecordView[] }`.
  - `RestoreOutcomeRow = { name; outcome: 'loaded' | 'deleted' | 'skipped' | 'kept' | 'rejected' | 'unknown' | 'notDone'; error? }`.
- `decodeBackup(bytes, hash, opts?: { maxFileBytes })`: stessa firma; dentro usa `Unzip` + `UnzipInflate` di fflate.

Regole:

- **Lettura sicura del `.baapbak` (problema rimasto dal 3C):**
  - i byte si contano mentre si decomprimono, e la decompressione si ferma appena si supera un tetto: 64 KB per `manifest.json`, la `length` del manifest (al massimo 1 MB) per ogni blocco, `BACKUP_MAX_BYTES` in tutto;
  - `originalSize` non conta più per il tetto;
  - oltre il tetto → `BackupFormatError('contenuto troppo grande')`.
- **Piano (§19.5), nel main, nessuna rete fino al punto 3:**
  1. finestra di apertura nativa (filtro `.baapbak`); «Annulla» → `cancelled`. Il file oltre `BACKUP_MAX_BYTES` si rifiuta prima di leggerlo. Segue `decodeBackup`;
  2. ogni file passa da `parseBlockFile`, e tipo e numero devono coincidere con il manifest. Un SDB del backup fuori da `RESTORE_SDB` (SDB 2 escluso) → rifiuto: «SDB n fuori dagli intervalli documentati: ripristino non possibile». SDB 2 → `skip`, «creato dalla CPU»;
  3. lettura dalla CPU sul collegamento della sorveglianza (`service.read`): elenco dei blocchi di ogni tipo, SDB compresi, e `0x0174`. Con FRCE acceso → rifiuto: «Forzamento attivo sulla CPU: terminarlo con TIA o STEP 7 prima del ripristino»;
  4. il numero d'ordine del backup diverso da quello del collegamento → `cpuMismatch` (serve una conferma in più, vedi sotto);
  5. passi, in questo ordine:
     - `_DELE` `'A'` degli SDB sulla CPU e non nel backup, solo se `isRestorableSdb`. Gli altri restano e finiscono in `skipped`, «fuori dagli intervalli documentati: lasciato sulla CPU»;
     - gli SDB del backup in ordine crescente, con SDB 0 per ultimo;
     - DB, FC, FB, poi OB, in ordine crescente, con OB1 per ultimissimo;
     - i blocchi utente presenti solo sulla CPU restano (`keep`);
  6. il piano resta nel main, legato a `linkId`, e il renderer riceve solo le righe e un `token`. Un `token` di un altro collegamento o già usato → errore.
- **Esecuzione** (dentro `exclusive`: una per finestra e una per CPU, `abortAll`, `closeGuard`):
  1. prima si ferma l'osservazione del Task 3 su questa CPU (`statusService.stopForCpu`);
  2. con `cpuMismatch`, una conferma in più: «Il backup è di una CPU diversa (‹backup›) da quella collegata (‹online›). Ripristinare comunque?»;
  3. conferma «Ripristina backup (sperimentale)». Il messaggio nomina la CPU; il dettaglio ha le righe costruite dal main (`Cancella SDB 1000`, `Carica SDB 7`, `Carica OB1`, `Restano nella CPU: FC 5`, troncate dopo 20) e «FUNZIONE SPERIMENTALE, mai provata su una CPU reale. La CPU andrà in STOP»;
  4. collegamento `online-restore`, identità come in `open`;
  5. `readJobList()`: una voce diversa dalla chiamata stessa → rifiuto prima di toccare la CPU, con il testo di `0xD2A8`: «Una funzione di test attiva impedisce l'assegnazione dei parametri (job di test sulla CPU). Chiudere osservazioni e forzamenti in TIA o STEP 7 e riprovare»;
  6. conferma «Portare la CPU in STOP?», poi `stop()` e rilettura di `0x0424` ogni 200 ms per al massimo 5 s. Senza STOP → errore «La CPU non è andata in STOP: nulla è stato scritto»;
  7. i passi, con l'avanzamento `plc:writeProgress`. Fra un passo e l'altro, `op.aborted`, la finestra distrutta o `plc:restoreInterrupt` fermano tutto;
  8. con `restart` e tutti i passi riusciti: conferma «Avviare la CPU (avviamento a caldo)?», poi `start()` e attesa di RUN fino a 10 s. Se resta in STOP si leggono le prime 5 voci del buffer di diagnostica, che vanno in `diag`;
  9. elenco dei blocchi riletto: ogni riga `loaded` il cui blocco non c'è diventa `unknown`.
- **Ritentativi:** su `0xD2A9` o `0xD2AA` nel `_INSE` o nel request download si ripete la **stessa** richiesta dopo 200 ms, al massimo 10 volte. Poi la riga è `rejected` con «la CPU sta assegnando nuovi parametri» e il ripristino si ferma. L'attesa è iniettabile.
- **Esito per riga, con le parole del 3B e 3C:**
  - `loaded`/`deleted` → «Caricato» e «Cancellato»;
  - un rifiuto della CPU → `rejected`, «Rifiutato dalla CPU: …»;
  - il passo in corso quando il collegamento cade o arriva un errore di trasporto → `unknown`, «Esito sconosciuto»;
  - i passi dopo un errore → `notDone`, «Non caricato»;
  - `cpuStopped` è vero se la CPU è stata arrestata da noi e non è ripartita;
  - nessuna ripetizione automatica, nessun annullamento delle cose già fatte.
- **Filtro `online-restore`:** è `assertOnlineWrite` più:
  - request download, download ended, ack del download e `_INSE` di SDB con `'P'` e `isRestorableSdb`;
  - `_DELE` di SDB con `'A'` e `isRestorableSdb`;
  - `reqReadJobList` canonico.
  - Il resto del gruppo 1 è FORBIDDEN. `online-write` continua a rifiutare gli SDB.
- **Server di prova:**
  - il download degli SDB si accetta solo in STOP; in RUN il rifiuto ha l'errore dei download rifiutati (scelta del server di prova);
  - `_DELE` di SDB solo in STOP;
  - `insertBusy: n` → i primi n `_INSE` rispondono `0xD2A9`;
  - la CPU simulata tiene gli SDB come blob opachi.

- [ ] **Step 1: Test**
  - `decodeBackup: voce con originalSize 10 che si gonfia a 2 MB → «contenuto troppo grande», byte decompressi ≤ tetto + un pezzo`
  - `decodeBackup: manifest dichiarato di 100 byte che diventa 100 KB → errore`
  - `decodeBackup: andata e ritorno del 3C ancora identica`
  - `online-restore ammette _DELE "0B01000A" e request download "_0B00007P" e _INSE "0B00000P" di §19.3.1`
  - `online-restore rifiuta: SDB 2, SDB 999, SDB 3000, _DELE SDB con 'P', download SDB con 'A', block status`
  - `online-write rifiuta download e _DELE di SDB`
  - `downloadBlock con busyRetry: due 0xD2A9 poi ok → 3 _INSE identici, 200 ms fra l'uno e l'altro (attesa iniettata)`
  - `11 risposte 0xD2A9 → errore dopo 10 ritentativi`
  - `planRestore: backup SDB 0, 1, 2, 7, 1000 + DB1, FC2, FB3, OB1, OB35; CPU con SDB 0, 1, 2, 4, 2000 + FC9 → _DELE SDB 4 e 2000; carica 1, 7, 1000, 0; DB1, FC2, FB3, OB35, OB1; SDB 2 saltato; FC9 resta`
  - `planRestore: SDB 998 sulla CPU e non nel backup → lasciato e segnalato`
  - `planRestore: SDB 500 nel backup → rifiuto`
  - `planRestore: file OB2 dichiarato OB1 nel manifest → rifiuto`
  - `restorePlan: FRCE acceso → rifiuto prima di ogni conferma`
  - `restorePlan: numero d'ordine diverso → cpuMismatch`
  - `restore: Annulla alla conferma della CPU diversa → nessun collegamento`
  - `restore: lista dei job con un job 0x13 di un altro → rifiuto, CPU non arrestata`
  - `restore contro il PLC di prova → SDB 0 e 1 e OB1 caricati, CPU in STOP, blocchi identici al backup`
  - `restore con restart e conferma → RUN; con restart ma conferma negata → resta in STOP, cpuStopped true`
  - `collegamento chiuso durante SDB 1 → SDB 1 unknown, i seguenti notDone, cpuStopped true`
  - `abortAll durante il ripristino → si ferma prima del passo successivo`
  - `token di un collegamento precedente → errore senza conferma`
  - `il testo della conferma contiene «FUNZIONE SPERIMENTALE» e le righe del main`
  - `l'osservazione attiva sulla stessa CPU si ferma prima del ripristino`
- [ ] **Step 2–4:** `--project s7comm --project project --project s7-server --project sim --project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(desktop,s7comm,project): ripristino sperimentale di un backup con SDB e lettura sicura del .baapbak`

### Task 7: Finestra «Ripristina backup nel dispositivo (sperimentale)»

**Files:**

- Create:
  - `packages/ui/src/dialogs/RestoreDialog.tsx` e `restore.css`;
  - `packages/ui/src/online/plcRestore.ts`: avvio, esito e testi delle righe.
- Modify:
  - `commands/commands.ts`: `online.restore`, abilitato solo online, con l'impostazione sperimentale e senza nessuna operazione in corso;
  - `project/menuModel.ts`: menu Online «Ripristina backup nel dispositivo… (sperimentale)»;
  - il menu contestuale di «Backup online» nell'albero;
  - `state/store.ts` (`dialog` `'restore'`, `online.restoring`);
  - la barra di stato (avanzamento con «Interrompi»);
  - `i18n` (`restore.*`).
- Test: `packages/ui/test/online/plcRestore.test.ts`, `packages/ui/test/dialogs/restoreDialog.test.tsx`

Regole:

- **Flusso:**
  1. «Scegli file…» chiama `plcRestorePlan`. La finestra di apertura è nativa, nel main;
  2. la tabella mostra Blocco, Azione («Carica», «Cancella», «Saltato», «Resta nella CPU») e il motivo;
  3. avvisi in testa: «Funzione sperimentale, mai provata su una CPU reale», «La CPU andrà in STOP», «Il backup è di una CPU diversa» se serve, e «I DB tornano ai valori salvati nel backup; merker, temporizzatori e contatori no» (§19.5);
  4. la casella «Avvia la CPU al termine (avviamento a caldo)», spenta per default;
  5. «Ripristina» chiama `plcRestore({ token, restart })`; le conferme native sono nel main.
- **Esito:** la stessa tabella con la colonna Esito («Caricato», «Cancellato», «Saltato», «Resta nella CPU», «Rifiutato dalla CPU: …», «Esito sconosciuto», «Non caricato»).
  - Con `cpuStopped` compare «CPU lasciata in STOP» e il pulsante «Avvia CPU» (comando del 3B, con la sua conferma).
  - Con `diag`, le voci del buffer si mostrano con i testi del 3C.
- **Annullamenti:** «Annulla» in una conferma nativa non mostra messaggi e lascia la finestra aperta. Un errore prima di toccare la CPU (FRCE, job, SDB fuori intervallo) mostra il messaggio e dice «Nessuna modifica alla CPU».
- **Dopo:** si rilancia il confronto online del 3B, perché i blocchi della CPU sono cambiati.
- **Durante:** «Interrompi» nella barra chiama `plcRestoreInterrupt`, e il ripristino si ferma prima del passo successivo. Chiudere la finestra o uscire passa da `closeGuard`, come nel 3B.

- [ ] **Step 1: Test**
  - `online.restore disabilitato offline, con l'impostazione spenta, durante un caricamento`
  - `piano con cpuMismatch → avviso «CPU diversa» in testa`
  - `riga SDB 2 → «Saltato: creato dalla CPU»; FC9 → «Resta nella CPU»`
  - `Avvia la CPU spenta per default → plcRestore con restart false`
  - `esito con SDB 1 unknown e il resto notDone → «Esito sconosciuto» e «Non caricato», «CPU lasciata in STOP» con «Avvia CPU»`
  - `conferma annullata → nessun messaggio, finestra aperta`
  - `rifiuto per FRCE → messaggio e «Nessuna modifica alla CPU»`
  - `dopo l'esito → confronto online rilanciato`
  - `Interrompi → plcRestoreInterrupt`
  - `en: titoli e azioni in inglese`
- [ ] **Step 2–4:** `--project ui`.
- [ ] **Step 5: Commit** — `feat(ui): ripristino sperimentale di un backup con anteprima ed esito per blocco`

### Task 8: E2E, documenti, limiti noti, versione

**Files:**

- Create: `apps/desktop/e2e/plc-osservazione.spec.ts`
- Modify:
  - `apps/desktop/src/main/plc/testPlc.ts`: l'handle espone `tisJobs()` per la e2e (lista dei job del server), solo dentro il PLC di prova;
  - `docs/uso/online.md`: sezioni «Osservazione del programma online», «Forzamento», «Funzioni sperimentali», «Stack di chiamata (sperimentale)», «Ripristino di un backup (sperimentale)»;
  - `docs/limiti-noti.md`: sezione «Osservazione online, stack e ripristino (piano 3D)». Si aggiornano anche le voci del 3C sul `.baapbak` («la lettura si fida delle dimensioni dichiarate»: risolto; «il ripristino arriva nel 3D»; «I file `.baapbak` non compaiono nell'albero»);
  - `docs/protocollo/s7comm.md`: §15.1bis e il riepilogo di §15.2, con la colonna «decisione 3D» che nomina i modi `online-test` e `online-restore`. Nessun layout cambia;
  - il piano generale: riga 3D «Stato: fatto (v0.13.0)». Le tabelle di forzamento non sono fatte (protocollo non stabilito, §18.5.1) e restano nelle mancanze aperte;
  - `apps/desktop/package.json` 0.13.0 e `package-lock.json`.

Regole della e2e, sull'app costruita, con il PLC di prova avviato nel processo di Playwright e l'aggancio `BAAPORTAL_E2E_CONFIRM` del 3B:

- **Osservazione:**
  1. progetto con OB1 `L 5` / `T MW 10`, caricamento, collegamento;
  2. editor di OB1, «Osservazione on/off»: la riga di `T MW 10` mostra STANDARD 5, la barra di stato dice «Osservazione attiva», e `tisJobs()` ha un job `0x13`;
  3. «Osservazione on/off» di nuovo: entro 1 s `tisJobs()` è vuoto;
  4. di nuovo on, poi «Interrompi collegamento online»: `tisJobs()` è vuoto;
  5. OB1 modificato e compilato senza caricarlo, «Osservazione on/off»: compare «Il blocco nella CPU è diverso…» e nessun job.
- **Ripristino** (impostazione sperimentale attiva dalla finestra Impostazioni; `BAAPORTAL_E2E_SAVE_PATH` del 3C, più `BAAPORTAL_E2E_OPEN_PATH` per l'apertura):
  1. backup online (3C);
  2. OB1 cambiato in `L 7` e caricato;
  3. «Ripristina backup nel dispositivo…»: la tabella ha OB1 «Carica» e SDB 0 e 1 «Carica»;
  4. «Ripristina» (conferme sì, avvio spento): l'esito ha «Caricato» per tutti e «CPU lasciata in STOP»; il confronto dice OB1 diverso dal progetto (`L 7`) e uguale al backup (`L 5`, dall'upload).
- **Conferma negata:** con `BAAPORTAL_E2E_CONFIRM=no` il ripristino non cambia nulla e la CPU resta in RUN.
- **Impostazione spenta:** il comando di ripristino è disabilitato e la pagina degli stack invita alle impostazioni.

**Limiti noti** (sezione «Osservazione online, stack e ripristino (piano 3D)»):

- **Mai provato su una CPU reale.** Lo stato del blocco, gli stack, la lettura di FRCE e il ripristino sono provati solo contro il PLC di prova. Stack e ripristino sono «sperimentali».
- **Lo stato del blocco è verificato su una sola cattura** (OB1, 6 righe, §18.4.1). Ipotesi:
  - la SAZ come fine esclusiva della finestra;
  - una riga mancante dal risultato vuol dire «non elaborata»;
  - nessun risultato in 2 s vuol dire «blocco non elaborato».
- **DB1 e DB2 non si osservano:** la loro dimensione nel risultato è sconosciuta. Nemmeno AR2.
- **Finestra limitata dalla PDU:** con PDU 240, 24 righe con STW e ACCU1, 16 con ACCU2, 11 con ACCU2 e AR1. Le altre righe visibili restano senza valori.
- **Ritmo:** un risultato ogni 250 ms al massimo, non a ogni ciclo come STEP 7: i valori sono quelli di un ciclo ogni tanto.
- **Un'osservazione per CPU**, su un collegamento PG in più.
- **Il blocco deve essere uguale a quello del progetto** (checksum e lunghezza MC7, con la stessa ipotesi del confronto del 3B).
- **Il tempo di ciclo aumenta** mentre si osserva (da documentazione). Una CPU in modo processo può limitare lo stato (`0xD0AB`/`0xD0AC`/`0xD0CC`, una sola fonte).
- **In STOP nessun valore.** Cosa risponde la CPU a un block status in STOP è sconosciuto, e il client non lo chiede.
- **Job orfani:** si suppone che la CPU cancelli i job quando il collegamento cade (ipotesi). BaaPortal cancella alla connessione solo quelli che ha registrato. Un job di un'altra connessione (`0xD0AE`) resta.
- **Forzamento non implementato.** Il protocollo di forzamento della S7-300 non è stabilito (§18.5.1: nessuna cattura; la CPU dichiara force selection `0x07` e non force `0x09`). BaaPortal mostra solo «Forzamento attivo sulla CPU» dal LED FRCE. Per forzare o terminare un forzamento si usa TIA Portal o STEP 7. Mancano le tabelle di forzamento e la colonna «Forza».
- **Stack sperimentali:**
  - layout da una sola fonte, mai visti in cattura;
  - forma della richiesta ipotizzata come la lista dei job;
  - la risposta in RUN non si conosce, e BaaPortal non chiede;
  - il tipo del registro DB è sconosciuto.
- **Ripristino sperimentale:**
  - verificato sul formato solo per gli SDB (una cattura TIA);
  - l'ordine dei blocchi utente dopo gli SDB è una scelta;
  - i ritentativi 200 ms × 10 sono una scelta;
  - `_DELE` dei blocchi utente non si usa: quelli presenti solo nella CPU restano;
  - SDB solo negli intervalli 0, 1, 3–7, 1000–2999;
  - non si sa se i DB del backup hanno i valori attuali (§19.4);
  - merker, temporizzatori e contatori non tornano;
  - un ripristino interrotto lascia la CPU in STOP con una configurazione parziale.
- **Funzioni sperimentali solo dall'interfaccia:** l'impostazione è del renderer. La difesa nel main sono le conferme native, che dicono «sperimentale».
- **I backup non compaiono nell'albero:** si aprono con la finestra dei file.

**Note di rilascio della 0.13.0** (da scrivere nella release, non nel repo):

- l'osservazione del programma, la lettura di FRCE, gli stack e il ripristino non sono mai stati provati su una CPU reale;
- stack e ripristino sono sperimentali e spenti per default;
- il forzamento si fa con TIA o STEP 7.

**Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 1–3:** e2e, documenti, collaudo.
- [ ] **Step 4: Commit** — `docs: piano 3D — osservazione online, forzamento visibile, stack e ripristino sperimentali, versione 0.13.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Stato del programma per i blocchi AWL: sì,** con block status v2 (`0x13`, §18.4.1) e «Osservazione on/off» nell'editor:
  - il blocco online deve coincidere con quello offline (la firma del confronto del 3B), altrimenti un messaggio;
  - righe da `packages/mc7` tramite la mappa di compilazione (offset MC7 → riga);
  - colonne a destra con RLC, STA, ACCU1 e STW, più ACCU2 e AR1 a richiesta;
  - righe non elaborate in grigio;
  - un job per CPU; finestra = righe visibili entro una PDU; un enable ogni 250 ms al massimo;
  - delete garantito; pulizia dei soli job nostri;
  - in STOP stato senza valori.
  _Se fosse sbagliato:_ una cattura su CPU vera corregge SAZ e righe non eseguite nel solo `decodeBlockStatusResult`.
- **R2. Stack di chiamata: sperimentali, solo in STOP/HOLD,** dietro «Funzioni sperimentali (non provate su una CPU reale)», spenta per default, nella pagina «Stack di chiamata» di «Online e diagnostica». Decodifica tollerante con l'esadecimale. USTACK è lo stack delle interruzioni, cioè ISTACK `0x03` del documento.
- **R3. Forzamento non implementato.** Si legge FRCE (`0x0174`/`0x0006`) e si mostra «Forzamento attivo sulla CPU» nella diagnostica e nella barra di stato. Niente colonna «Forza» né tabelle di forzamento. I limiti noti spiegano il perché e rimandano a TIA/STEP 7.
- **R4. Ripristino sperimentale,** dietro la stessa impostazione, con la ricetta di §19.5:
  - controlli: CPU uguale o seconda conferma, lista dei job vuota, FRCE spento;
  - STOP con conferma;
  - `_DELE` `'A'` degli SDB in più (solo negli intervalli documentati);
  - SDB con `'P'` e `_INSE`, SDB 0 per ultimo, ritentativo su `0xD2A9` (10 × 200 ms);
  - poi DB, FC/FB, OB;
  - riavvio solo se scelto (predefinito no).
  Esito per blocco con le parole del 3B. In più si corregge la lettura del `.baapbak`, che si fidava di `originalSize`.
- **R5. Tutto il 3D è «mai provato su una CPU reale»** (spec §5), nei limiti noti e nelle note di rilascio.
- **R6. Versione 0.13.0.** Documenti: `docs/uso/online.md`, la sezione dei limiti noti, la riga 3D del piano generale.
- **R7. Il PLC di prova risponde a tutto ciò che è nuovo:** block status, job, stack, FRCE, SDB. La e2e copre l'osservazione on/off e il ripristino con l'impostazione attiva.
- **R8. Clean-room:** solo `docs/protocollo/s7comm.md`, IP di documentazione.

Decisioni prese da me durante la stesura (modificabili):

- **R9. Due modi nuovi del collegamento invece di allargare quelli esistenti:**
  - `online-test` per la «zona grigia» di §15.1bis: block status, enable e delete di `0x13`, lista dei job e stack, senza conferma;
  - `online-restore` per il ripristino: `online-write` più SDB e lista dei job.
  - `read-only` e `online-write` non cambiano: un caricamento normale non può mai scrivere un SDB, e la sorveglianza non può mai creare un job.
  _Se fosse sbagliato:_ i modi si fondono senza toccare i codificatori.
- **R10. L'osservazione usa un collegamento suo,** non quello della sorveglianza:
  - i job sono legati al collegamento (`0xD0AE`);
  - chiuderlo è l'ultima difesa se il delete non arriva;
  - la sorveglianza resta `read-only`.
  Costa un collegamento PG in più, come le scritture del 3B.
- **R11. Il renderer chiede ogni risultato** (un enable per `plc:statusRead`), come R10 del 3C. Il main ha un solo temporizzatore nuovo: il controllo che cancella il job dopo 5 s di silenzio del renderer. È una sicurezza, non un'interrogazione.
- **R12. Una maschera di registri uguale su tutte le righe:** STW + ACCU1 (`0x03`) per default; ACCU2 e AR1 si aggiungono dalle caselle e riducono la finestra. Non si chiedono AR2, DB1 e DB2. La maschera uniforme permette di risincronizzare un risultato con righe mancanti.
- **R13. Come si riconosce una riga non elaborata (ipotesi):**
  - riga assente dal risultato → grigia;
  - nessun risultato in 2 s → tutta la finestra grigia con un messaggio, senza cancellare il job (un FC non chiamato è un caso normale);
  - il server di prova toglie le righe non eseguite, per provare questa strada.
  _Se fosse sbagliato:_ cambia solo il decodificatore.
- **R14. «Solo i nostri job» = quelli registrati** in `userData/tis-jobs.json` (CPU, funzione, numero). La CPU stessa protegge i job degli altri collegamenti con `0xD0AE`. `read job` (`0x11`) non si usa perché è da una sola fonte.
- **R15. In STOP non si crea il job:** la risposta della CPU è sconosciuta (§18.4.1). Il job si ricrea al ritorno in RUN.
- **R16. Stack solo a richiesta,** con un collegamento `online-test` breve e il modo riletto subito prima. In RUN non parte nessuna richiesta di stack.
- **R17. FRCE nella sorveglianza del 3A,** ogni 5 giri. È una SZL già nell'allowlist e serve alla barra di stato anche senza la diagnostica aperta. Con FRCE acceso il ripristino si rifiuta (§19.5 punto 1).
- **R18. Il piano del ripristino lo fa il main.** Il renderer vede righe e `token`, mai i byte. Le conferme native sono:
  - CPU diversa, se serve;
  - sovrascrittura, con le righe del main;
  - STOP;
  - avvio, se scelto.
  I blocchi utente presenti solo nella CPU restano (`_DELE` dei blocchi utente è un'ipotesi, §10.5). Un SDB del backup fuori dagli intervalli fa rifiutare tutto, per non lasciare una configurazione a metà. Intervalli: 0, 1, 3–7, 1000–2999. SDB 2 non si tocca mai.
- **R19. L'impostazione sperimentale vive nel renderer,** con le altre impostazioni. Il main non la ricontrolla: per il ripristino la difesa sono le conferme native, che dicono «sperimentale»; gli stack sono in sola lettura.
- **R20. I backup non si elencano nell'albero:** si aprono con la finestra dei file. Tenerne l'elenco vorrebbe dire salvare percorsi nel progetto.
- **R21. Il `.baapbak` si legge a flusso,** con tetti sui byte veri (64 KB per il manifest, la lunghezza dichiarata per ogni blocco, 256 MB in tutto). `originalSize` non conta più.
- **R22. Testi degli error code TIS in `@baaportal/s7comm`,** in italiano, da §18.7.1, ciascuno con la reazione del client, così main e interfaccia reagiscono allo stesso modo.
