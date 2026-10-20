# Piano 1D-bis — Funzioni di scrittura sul PLC — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** BaaPortal passa da *guardare* la CPU S7-300 a *programmarla e comandarla*: scrittura di variabili, carica nel dispositivo (con attivazione del blocco) e STOP/RUN, su ISO-on-TCP, chiudendo il giro con il compilatore del 1E. Tutto si sviluppa e si prova contro il **finto PLC** e contro i byte di catture pubbliche di CPU S7-300 reali, quindi funziona senza alcuna CPU a disposizione. Ogni funzione che cambia lo stato della CPU passa da una conferma esplicita.

**Architettura:**
- `@baaportal/s7comm` guadagna i **codici di scrittura, download e controllo** (write var `0x05`; download `0x1A`/`0x1B`/`0x1C`; PLC control `0x28` e stop `0x29`), un **filtro consapevole del modo** (sola lettura ↔ online-scrittura) sullo stesso choke point del 1D, e un **client di scrittura separato** (`S7WriteClient`). Il client di lettura `S7Client` e il kit restano in sola lettura (proto §15.4).
- `@baaportal/s7-server`: il finto S7-300 impara ad **accettare** scrittura, download e stop/avvio, cambiando il suo stato interno (memoria, blocchi, modo) **solo** per le funzioni dell'allowlist di scrittura. È così che si prova il client da capo a fondo senza CPU.
- `apps/s7bench`: nuovi comandi `scrivi`, `carica-nel-dispositivo`, `stop`, `avvia`, ciascuno con **conferma esplicita** che mostra IP, ordine CPU e modo, più un riconoscimento "non in produzione".
- **Nessuna interfaccia online nell'app in questo piano** (vedi R1): le tabelle di controllo in scrittura, la finestra di confronto e conferma e i pulsanti RUN/STOP arrivano con la tappa 3 (spec §6, §8.4, roadmap 3B). Il nucleo di questo piano è lo "strumento interno di test" previsto dalla spec §6.

**Tecnologie:** TypeScript, `node:net` (solo nei moduli `node/`), Vitest, `@baaportal/mc7` (sorgente dei blocchi da caricare), `node:util parseArgs` (s7bench).

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md` (§4 anti-obiettivi: mai caricare senza conferma; §5 sicurezza sulle macchine; §6 banco di prova PLC dalla tappa 1, interfaccia online alla tappa 3; §10 conformità su CPU reale). Piano generale: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md` (riga 1D-bis, dipendenza 1A→1D→1D-bis). **Riferimento di protocollo vincolante:** `docs/protocollo/s7comm.md`, citato con il numero di sezione (es. "proto §10.2"); vettori reali in proto §17.

## Global Constraints

- **Clean-room** (spec §4, §5): fonti ammesse = manuali Siemens pubblici, RFC e i progetti open source **letti come documentazione** (snap7, libnodave, DotNetSiemensPLCToolBoxLibrary, dissector Wireshark); **nessun codice copiato**; nessuna analisi di software Siemens. Il metodo è già quello di `docs/protocollo/s7comm.md`.
- **La scrittura esiste solo dietro un modo esplicito.** Il client di default (`S7Client`) e il kit restano in sola lettura e **non** acquistano alcun metodo di scrittura (proto §15.4). Le funzioni di scrittura vivono in un client separato (`S7WriteClient`) su una connessione aperta in **modo `online-write`**.
- **Filtro sulla PDU in uscita, non solo sull'API** (R2 del 1D, confermata). Il choke point `guardedSender` di `connection.ts` resta l'unico punto da cui esce un frame e diventa consapevole del modo. In modo `read-only` l'allowlist è quella di proto §15.1. In modo `online-write` si aggiunge **solo** l'allowlist di scrittura di R3. Una connessione `read-only` **non può strutturalmente** emettere una scrittura, nemmeno per un errore del client.
- **Allowlist di scrittura (modo `online-write`)** — solo questi codici, oltre a quelli di lettura: write var `0x05`; request download `0x1A`; download block ack-data `0x1B` (ROSCTR 3, risposta ai job della CPU); download ended ack `0x1C`; PLC control `0x28` **solo** warm restart `P_PROGRAM` (nessun argomento) e `_INSE`; PLC stop `0x29`. **Vietati anche in scrittura:** `_DELE`, `_GARB`, `_MODU` (copy RAM→ROM), MRES/force/TIS (userdata grp 1/2/5), set clock (grp 7 sub `0x02`/`0x04`), cold/hot restart. Restano alla tappa 3 o fuori portata.
- **Conferma esplicita** (spec §4): nessuna scrittura, download o cambio di modo parte senza una conferma che mostri **cosa** si scrive/carica, **su quale IP e CPU** (ordine) e in **quale modo** è la CPU (RUN/STOP). In questo piano la conferma vive in `s7bench`.
- **Mai su una macchina in produzione** (spec §5): ogni comando di scrittura di `s7bench` richiede anche un riconoscimento esplicito "non in produzione". I test non toccano mai una CPU vera.
- **Blocchi opachi:** nessuna funzione modifica i byte di un blocco; il blocco da caricare arriva già formato da `@baaportal/mc7` (`compileBlock().file` / `blockToMc7File`).
- **Processi** (spec §7): la comunicazione col PLC gira solo nel processo principale di Electron; qui però non c'è interfaccia online, quindi non si tocca il processo principale dell'app.
- **Dipendenze:** `node:net` solo in `packages/*/src/node/`; nessuna nuova dipendenza di runtime.
- **Catture di terzi:** `cisa/snap7.pcap` (BSD-3, già in repo) contiene write var, PLC stop e cold restart reali; la cattura del download (`s7comm_downloading_block_db1.pcap`) e quella write di libnodave si scaricano al momento dei test con controllo SHA-256 e **non entrano mai nel repository**. I dati dell'amico o della ditta non entrano mai nel repository (è pubblico).
- **Windows e macOS:** valgono le lezioni dei piani 1A–1E: niente `fs.cpSync`; percorsi normalizzati con `replaceAll('\\','/')`; timeout espliciti di 30 s e soglie larghe nei test di tempo; `.gitattributes` impone LF.

## Review Focus

1. **Una scrittura che esce da una connessione di sola lettura.** È l'errore più grave possibile. → Task 4 (il filtro per modo) e Task 7 (test che `S7Client` non ha metodi di scrittura e che una connessione `read-only` rifiuta `0x05`/`0x1A`/`0x28`/`0x29`).
2. **Inversione dei ruoli nel download.** Durante il download la CPU manda job `0x1B`/`0x1C` al PG (proto §10.2): fuori da una transazione di download un job dalla CPU deve ancora **chiudere** la connessione; dentro, va gestito. Un job di tipo diverso (non `0x1B`/`0x1C`) durante il download chiude comunque. → Task 4 e Task 6.
3. **Download interrotto a metà.** Connessione che cade tra l'ack `0x1A` e l'`_INSE`: niente promesse appese, errore tipizzato, e sul finto PLC il blocco **non** risulta inserito (un download a metà non lascia un blocco corrotto). → Task 6, Task 7, Task 9.
4. **CPU protetta o già nello stato richiesto.** Livello di protezione 2/3 → `0xD241` riportato così com'è (proto §14); stop con CPU già in STOP → `para 0x07`; avvio con CPU già in RUN → `para 0x03`; messaggio chiaro, nessun blocco. → Task 2, Task 5, Task 7.
5. **Scritture più grandi della PDU.** Una write var di molti byte va divisa come le letture (proto §5.11); un blocco più grande della PDU va in più fette `0x1B`. → Task 1, Task 3, Task 9.

---

### Task 1: `@baaportal/s7comm`: codec Write var (`0x05`)

**Files:**
- Create: `packages/s7comm/src/s7/writeVar.ts`
- Modify: `packages/s7comm/src/index.ts` (riesporta `writeVar`)
- Test: `packages/s7comm/test/writeVar.test.ts`

**Interfaces:**
- Consumes: `Area`, `TransportSize`, `ItemResult`, le mappe `AREA_CODE`/`SIZE_CODE` e `itemByteLength` di `s7/readVar.ts`; `planReads`/`splitArea` di `s7/plan.ts` come modello.
- Produces:
  ```ts
  export interface WriteItem { area: Area; db: number; start: number; bit?: number; size: TransportSize; count: number; data: Uint8Array }
  export function encodeWriteRequest(items: WriteItem[]): { param: Uint8Array; data: Uint8Array };   // function 0x05
  export function decodeWriteRequest(param: Uint8Array, data: Uint8Array): WriteItem[];                // per il finto PLC
  export function encodeWriteResponse(returnCodes: number[]): { param: Uint8Array; data: Uint8Array }; // per il finto PLC
  export function decodeWriteResponse(param: Uint8Array, data: Uint8Array): { returnCode: number; name: string }[];
  export function planWrites(items: WriteItem[], pduLength: number): WriteItem[][];                    // proto §5.11
  export function splitWrite(area: Area, db: number, start: number, data: Uint8Array, pduLength: number): WriteItem[];
  ```

Regole:
- Parte parametri identica alla read (spec item: area, size, count, db, start/bit); la **parte dati** porta per ogni item un header (return code `0x00` reserved, transport size, lunghezza in bit o byte) seguito dai byte, con padding tra item tranne l'ultimo (proto §5.5). La risposta write è `0xFF` per item ok (proto §5.9).
- `planWrites`: al massimo 20 item per richiesta; ogni richiesta deve stare nella PDU come richiesta *e* come risposta (proto §5.11). `splitWrite` divide un item più grande della PDU in fette ordinate che coprono tutti i byte senza buchi.
- Riuso: nessuna copia della logica di `readVar.ts`; i codici area/size e `itemByteLength` si importano.

- [ ] **Step 1: Scrivi i test che falliscono** (`packages/s7comm/test/writeVar.test.ts`)

  ```ts
  it('write var di M reale di cisa/snap7.pcap: param e data coincidono byte per byte', () => { /* estrae la write var dalla cattura in repo */ });
  it('encodeWriteRequest → decodeWriteRequest è identità su un item BYTE, un BIT e un DB WORD', () => { /* … */ });
  it('padding: un item da 3 byte seguito da un altro ha 1 byte di riempimento; l\'ultimo no', () => { /* … */ });
  it('write response multi-item con un 0x0A in mezzo → gli altri 0xFF restano ok', () => { /* … */ });
  it('planWrites: 25 item piccoli → 2 richieste, ciascuna ≤ PDU in richiesta e risposta', () => { /* … */ });
  it('splitWrite(DB,1,0, 1000 byte, 240) → fette ≤ 222 byte che coprono 0..999 senza buchi', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project s7comm`, atteso FAIL.
- [ ] **Step 3: Implementa** `writeVar.ts` riusando `readVar.ts`/`plan.ts`; riesporta da `index.ts`.
- [ ] **Step 4: Esegui test, typecheck e lint** — `npx vitest run --project s7comm && npm run typecheck && npm run lint`, atteso PASS.
- [ ] **Step 5: Commit** — `feat(s7comm): codec write var (0x05)`

---

### Task 2: `@baaportal/s7comm`: codec PLC control (`0x28`) e stop (`0x29`)

**Files:**
- Create: `packages/s7comm/src/s7/control.ts`
- Modify: `packages/s7comm/src/index.ts`
- Test: `packages/s7comm/test/control.test.ts`

**Interfaces:**
- Consumes: `blockTypeAscii`/`blockTypeCode` di `s7/blocks.ts`.
- Produces:
  ```ts
  export type PiService = 'P_PROGRAM' | '_INSE';          // allowlist di questo piano; altri servizi NON implementati qui
  export function encodePlcStop(): Uint8Array;            // param 0x29 + "P_PROGRAM" (proto §11.1)
  export function encodeWarmRestart(): Uint8Array;        // param 0x28 P_PROGRAM, nessun argomento (proto §11.2)
  export function encodeInsertBlock(type: BlockType, number: number, fs: BlockFilesystem): Uint8Array;  // 0x28 _INSE (proto §10.4)
  export interface ControlResult { code: number; name: string }   // 0x00 ok, 0x07 già STOP, 0x03 già RUN, 0x02 non eseguibile (proto §11.4)
  export function decodeControlResponse(param: Uint8Array): ControlResult;
  // lato finto PLC
  export function decodePlcControlRequest(param: Uint8Array): { function: 0x28 | 0x29; service?: PiService; block?: { type: BlockType; number: number } };
  export function encodeControlResponse(fn: 0x28 | 0x29, code: number): Uint8Array;
  ```

Regole:
- Layout esatto da proto §10.4 (_INSE), §11.1 (stop), §11.2 (warm restart), §11.4 (codici di risposta). Le stringhe di servizio sono ASCII con il byte di lunghezza; `encodeInsertBlock` costruisce il nome `'0'+type+number(5 ASCII)` come in proto §10.4.
- `decodePlcControlRequest` riconosce **solo** i servizi dell'allowlist (R3): un `_DELE`/`_GARB`/`_MODU`/cold-restart si decodifica come servizio non ammesso e il chiamante (finto PLC, Task 5) risponde con errore, senza implementarlo.
- Nessuna password (proto §14): se arriva `0xD241`, è l'header error, gestito dal client (Task 7), non qui.

- [ ] **Step 1: Scrivi i test che falliscono** (`control.test.ts`)

  ```ts
  it('PLC stop di proto §17.10 (snap7_s300_stop): param 0x29 + "P_PROGRAM"', () => { /* … */ });
  it('warm restart P_PROGRAM: param 0x28 senza argomenti, roundtrip', () => { /* … */ });
  it('_INSE per DB1 di proto §10.4 / §17.9: byte identici alla cattura', () => { /* … */ });
  it('decodeControlResponse: para 0x00→ok, 0x07→già STOP, 0x03→già RUN, 0x02→non eseguibile', () => { /* … */ });
  it('decodePlcControlRequest rifiuta _MODU/_GARB/cold come "non ammesso"', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** `control.ts`; riesporta da `index.ts`.
- [ ] **Step 4: Esegui test, typecheck e lint**
- [ ] **Step 5: Commit** — `feat(s7comm): codec PLC control (0x28 warm/_INSE) e stop (0x29)`

---

### Task 3: `@baaportal/s7comm`: codec Download (`0x1A`/`0x1B`/`0x1C`)

**Files:**
- Create: `packages/s7comm/src/s7/download.ts`
- Modify: `packages/s7comm/src/index.ts`
- Test: `packages/s7comm/test/download.test.ts`

**Interfaces:**
- Consumes: `blockFileName`/`parseBlockFileName` di `s7/upload.ts`; `BlockHeader`/`parseBlockFile` di `s7/blockFile.ts` (per leggere `type`, `number`, `loadLength`, `mc7Length` dal file del blocco).
- Produces:
  ```ts
  export function encodeRequestDownload(type: BlockType, number: number, fs: BlockFilesystem, loadLength: number, mc7Length: number): Uint8Array;  // 0x1A (proto §10.1)
  export function decodeRequestDownload(param: Uint8Array): { type: BlockType; number: number; fs: BlockFilesystem; loadLength: number; mc7Length: number };  // finto PLC
  export function decodeDownloadBlockJob(param: Uint8Array): { type: BlockType; number: number; fs: BlockFilesystem };   // job 0x1B dalla CPU
  export function encodeDownloadBlockJob(type: BlockType, number: number, fs: BlockFilesystem): Uint8Array;              // finto PLC: la CPU chiede la fetta
  export function encodeDownloadBlockAck(eos: boolean, chunk: Uint8Array): { param: Uint8Array; data: Uint8Array };      // ack-data del PG (ROSCTR 3), EoS 0x01=seguono / 0x00=ultimo
  export function decodeDownloadBlockAck(param: Uint8Array, data: Uint8Array): { eos: boolean; chunk: Uint8Array };      // finto PLC
  export function encodeDownloadEnded(type: BlockType, number: number, fs: BlockFilesystem): Uint8Array;                 // job 0x1C
  export function sliceBlockForDownload(file: Uint8Array, pduLength: number): Uint8Array[];   // fette per le ack-data 0x1B, ultima con EoS 0
  ```

Regole:
- Sequenza e layout da proto §10.1–§10.3 e vettore reale §17.9. Il **download block `0x1B` è server-initiated**: la CPU (finto PLC) manda job `0x1B` (ROSCTR 1) e il PG risponde ack-data (ROSCTR 3). Questi codec non orchestrano la connessione (lo fa Task 4); costruiscono e leggono solo i frame.
- `sliceBlockForDownload`: fette che stanno nella PDU, l'ultima con EoS `0x00`.
- Un filename di download usa il filesystem `'P'` (passivo) come in proto §10.1.

- [ ] **Step 1: Scrivi i test che falliscono** (`download.test.ts`)

  ```ts
  it('request download DB1 di proto §17.9: byte identici (load mem 100086, MC7 2)', () => { /* … */ });
  it('encode/decodeRequestDownload roundtrip su OB1 e FB1', () => { /* … */ });
  it('la sequenza 0x1B di §17.9 (3 cicli, ultimo EoS 0) si decodifica e si ricodifica identica', () => { /* … */ });
  it('sliceBlockForDownload di un blocco da 500 byte con PDU 240 → fette che ricompongono l\'originale, ultima EoS 0', () => { /* … */ });
  it('download ended 0x1C roundtrip', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** `download.ts`; riesporta da `index.ts`.
- [ ] **Step 4: Esegui test, typecheck e lint**
- [ ] **Step 5: Commit** — `feat(s7comm): codec download (0x1A/0x1B/0x1C)`

---

### Task 4: Filtro consapevole del modo e transazione di download in `S7Connection`

**Files:**
- Modify: `packages/s7comm/src/readOnlyGuard.ts`, `packages/s7comm/src/connection.ts`
- Test: `packages/s7comm/test/writeGuard.test.ts`, aggiunte a `packages/s7comm/test/readOnlyGuard.test.ts`

**Interfaces:**
- Consumes: codec dei Task 1–3.
- Produces / modifica:
  ```ts
  export type ConnectionMode = 'read-only' | 'online-write';
  export function assertOnlineWrite(pdu: S7Pdu): void;        // allowlist lettura + scrittura (R3); S7Error('FORBIDDEN') altrimenti
  export function assertOutgoingFrame(bytes: Uint8Array, mode?: ConnectionMode): void;   // default 'read-only' (compatibile col 1D)
  // connection.ts
  export interface ConnectOptions { /* …campi esistenti… */ mode?: ConnectionMode }     // default 'read-only'
  // S7Connection
  request(param: Uint8Array, data: Uint8Array, rosctr: 1 | 3 | 7, timeoutMs?: number): Promise<S7Pdu>;   // 3 ammesso solo in modo online-write
  runDownload(request: Uint8Array, provideChunk: (job: { type: BlockType; number: number }) => { eos: boolean; chunk: Uint8Array }, onEnded: (job: { type: BlockType; number: number }) => void, timeoutMs?: number): Promise<void>;
  ```

Regole:
- `assertReadOnly` resta invariata. `assertOnlineWrite` ammette l'allowlist di lettura **più** `0x05`, `0x1A`, `0x1C`, `0x28` (solo warm restart e `_INSE`, verificati decodificando il servizio), `0x29`, e le ack-data `0x1B` (ROSCTR 3). Mantiene il controllo di **codifica canonica** del 1D (ogni PDU deve combaciare con la ri-codifica del suo significato).
- Il choke point `guardedSender` passa il `mode` ad `assertOutgoingFrame`. In `read-only` niente cambia rispetto al 1D. Il modo si fissa all'apertura e **non** si può cambiare su una connessione viva.
- **Inversione dei ruoli (proto §10.2):** fuori da `runDownload`, un job (ROSCTR 1) in arrivo dalla CPU chiude ancora la connessione con `PROTOCOL` (comportamento del 1D, invariato). Dentro `runDownload`:
  1. invia il request download (`0x1A`) e attende l'ack `0x1A` (o `0xD241` → `S7Error('CPU_ERROR')`);
  2. per ogni job `0x1B` in arrivo chiama `provideChunk` e risponde con ack-data (ROSCTR 3);
  3. al job `0x1C` chiama `onEnded`, risponde ack `0x1C` e termina;
  4. un job di funzione diversa da `0x1B`/`0x1C`, o un timeout, chiude con `PROTOCOL`/`TIMEOUT` e `runDownload` rilancia; niente promesse appese.
- `request` accetta ROSCTR 3 **solo** in modo `online-write` (serve per le ack-data); in `read-only` resta `1 | 7`.

- [ ] **Step 1: Scrivi i test che falliscono** (`writeGuard.test.ts`)

  ```ts
  it('assertOnlineWrite: 0x05, 0x1A, 0x1C, 0x29, warm restart e _INSE passano; _DELE/_MODU/cold/MRES/force → FORBIDDEN', () => { /* … */ });
  it('su una connessione read-only una write var non arriva mai al trasporto (spia su send)', () => { /* … */ });
  it('assertOutgoingFrame(mode="online-write") accetta un DT con write var; mode default la rifiuta', () => { /* … */ });
  it('runDownload su memoryTransportPair con un server di prova: 0x1A, tre ack-data 0x1B, 0x1C', async () => { /* … */ });
  it('runDownload: job non-0x1B a metà → PROTOCOL e nessuna promessa appesa', async () => { /* … */ });
  it('fuori da runDownload un job ROSCTR 1 chiude ancora la connessione con PROTOCOL', async () => { /* comportamento 1D invariato */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** il modo nel guard e in `S7Connection`, e `runDownload`.
- [ ] **Step 4: Esegui test, typecheck e lint** — includere l'intera suite `s7comm` per provare che il 1D resta verde.
- [ ] **Step 5: Commit** — `feat(s7comm): filtro per modo (read-only/online-write) e transazione di download`

---

### Task 5: Finto PLC accetta write var e stop/avvio

**Files:**
- Modify: `packages/s7-server/src/session.ts` (casi `0x05`, `0x28`, `0x29` del `job()`), `packages/s7-server/src/fakeCpu.ts` (mutazioni raggiungibili da rete, dietro l'allowlist)
- Test: aggiunte a `packages/s7-server/test/session.test.ts`

**Interfaces:**
- Consumes: `decodeWriteRequest`/`encodeWriteResponse` (Task 1); `decodePlcControlRequest`/`encodeControlResponse` (Task 2).
- Produces (interno a `FakeCpu`):
  ```ts
  // metodi interni raggiunti SOLO dai gestori dell'allowlist di scrittura
  applyWrite(items: WriteItem[]): number[];        // scrive in areas/DB, ritorna i return code (0xFF ok, 0x0A DB mancante, 0x05 fuori campo)
  applyStop(): number;                             // cpuMode→STOP; 0x00 ok, 0x07 se già STOP
  applyWarmRestart(): number;                      // cpuMode→RUN; 0x00 ok, 0x03 se già RUN
  ```

Regole:
- Nel `job()` di `session.ts` i casi `0x05`/`0x28`/`0x29` **non** rispondono più `ERR.PROTECTED`: decodificano, chiamano il metodo `FakeCpu` corrispondente e rispondono. Un `0x28` con servizio fuori allowlist (cold/_MODU/_GARB) resta `ERR.PROTECTED`.
- **Protezione:** se `protectionLevel >= 2`, write/download/control rispondono `0xD241` come proto §14 (lettura e SZL restano libere). Il livello è opzione del finto PLC già esistente.
- Lo stato del finto PLC cambia **solo** attraverso questi metodi e **solo** per le funzioni dell'allowlist; ogni altra funzione da rete resta un errore (R5 del 1D, ristretta). La nota di `fakeCpu.ts` ("Lo stato cambia solo con i metodi di questa classe, mai per un comando di rete") va aggiornata: ora cambia anche per le funzioni di scrittura ammesse, ma mai per le altre.
- Un write var fuori dalla dimensione di un'area dà return code `0x05`; su un DB inesistente `0x0A` (coerente con la read).

- [ ] **Step 1: Scrivi i test che falliscano** (`session.test.ts`)

  ```ts
  it('write var su MW10 poi read var rilegge il valore scritto', () => { /* via rig memory */ });
  it('write var su DB inesistente → 0x0A; oltre la dimensione di M → 0x05; stato invariato per quegli item', () => { /* … */ });
  it('PLC stop porta mode a STOP; secondo stop → para 0x07; SZL 0x0424 ora dice STOP', () => { /* … */ });
  it('warm restart porta mode a RUN; secondo → para 0x03', () => { /* … */ });
  it('con protezione 2 la write var risponde 0xD241 e non cambia la memoria', () => { /* … */ });
  it('0x28 con servizio _MODU resta ERR.PROTECTED (fuori allowlist)', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project s7-server`
- [ ] **Step 3: Implementa** i gestori e i metodi `FakeCpu`.
- [ ] **Step 4: Esegui test, typecheck e lint**
- [ ] **Step 5: Commit** — `feat(s7-server): il finto PLC accetta write var e stop/avvio`

---

### Task 6: Finto PLC accetta il download (job `0x1B` server-initiated)

**Files:**
- Modify: `packages/s7-server/src/session.ts` (caso `0x1A` + `0x1C` + `_INSE`; invio di job verso il client), `packages/s7-server/src/fakeCpu.ts` (inserimento del blocco da rete)
- Test: aggiunte a `packages/s7-server/test/session.test.ts`

**Interfaces:**
- Consumes: `decodeRequestDownload`, `encodeDownloadBlockJob`, `decodeDownloadBlockAck`, `encodeDownloadEnded` (Task 3); `decodePlcControlRequest` per `_INSE` (Task 2); `parseBlockFile`/`buildBlockFile` (già in s7comm, usati da `addBlock`).
- Produces (interno a `FakeCpu`):
  ```ts
  applyDownloadedBlock(type: BlockType, number: number, file: Uint8Array): void;   // inserisce/sostituisce in blockMap SOLO dopo _INSE
  ```

Regole:
- La `Session` deve poter **iniziare** job `0x1B`/`0x1C` verso il client (inversione dei ruoli, proto §10.2), raccogliere le ack-data, ricomporre i byte del blocco e, **solo all'arrivo dell'`_INSE`**, inserire il blocco con `applyDownloadedBlock`. Un download interrotto prima dell'`_INSE` **non** lascia alcun blocco (Review Focus 3).
- Sequenza: `0x1A` (ack) → la Session manda `0x1B` finché ci sono fette, leggendo le ack-data del client → manda `0x1C` → attende l'`_INSE` del client → inserisce. La lunghezza dichiarata nel `0x1A` deve combaciare con i byte ricomposti, altrimenti errore.
- Un secondo download in parallelo sulla stessa sessione dà l'errore "nessun download possibile" (riuso del meccanismo dell'upload, proto §3.3).
- Protezione ≥ 2 → `0xD241` sul `0x1A`.

- [ ] **Step 1: Scrivi i test che falliscano** (`session.test.ts`)

  ```ts
  it('download di un blocco costruito con buildBlockFile: dopo _INSE compare in list-blocks e si rilegge in upload identico', async () => { /* client runDownload ↔ server */ });
  it('download senza _INSE finale → il blocco NON compare (stato invariato)', async () => { /* … */ });
  it('lunghezza dichiarata ≠ byte ricomposti → errore, blocco non inserito', async () => { /* … */ });
  it('secondo download in parallelo → errore "nessun download possibile"', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** l'orchestrazione del download lato server e `applyDownloadedBlock`.
- [ ] **Step 4: Esegui test, typecheck e lint**
- [ ] **Step 5: Commit** — `feat(s7-server): il finto PLC accetta il download di un blocco`

---

### Task 7: `S7WriteClient` — client di scrittura

**Files:**
- Create: `packages/s7comm/src/writeClient.ts`, `packages/s7comm/src/node/connectWrite.ts`
- Modify: `packages/s7comm/src/index.ts`, `packages/s7comm/src/node/index.ts` (riesporta `connectWriteTcp`)
- Test: `packages/s7comm/test/writeClient.test.ts`

**Interfaces:**
- Consumes: `S7Connection` in modo `online-write` (Task 4); codec dei Task 1–3; `parseBlockFile` di `s7/blockFile.ts`.
- Produces:
  ```ts
  export class S7WriteClient {
    static connect(o: ConnectOptions): Promise<S7WriteClient>;   // forza mode:'online-write'
    readonly pduLength: number; readonly closed: boolean;
    // lettura (riuso della logica del client di lettura dove serve)
    readItems(items: ReadItem[]): Promise<ItemResult[]>;
    readArea(area: Area, db: number, start: number, length: number): Promise<Uint8Array>;
    mode(): Promise<CpuMode>; identity(): Promise<CpuIdentity>; blockInfo(type: BlockType, number: number): Promise<BlockInfo>;
    upload(type: BlockType, number: number): Promise<Uint8Array>;
    // scrittura
    writeItems(items: WriteItem[]): Promise<{ returnCode: number; name: string }[]>;   // usa planWrites
    writeArea(area: Area, db: number, start: number, data: Uint8Array): Promise<void>;  // usa splitWrite; errore item → S7Error CPU_ERROR
    downloadBlock(file: Uint8Array): Promise<void>;   // legge header per type/number/lunghezze, runDownload, poi _INSE
    stop(): Promise<ControlResult>;
    start(): Promise<ControlResult>;                  // warm restart
    close(): Promise<void>;
  }
  export const connectWriteTcp: (o: Omit<ConnectOptions,'transport'|'mode'>) => Promise<S7WriteClient>;   // in ./node
  ```

Regole:
- `S7WriteClient` apre la connessione **sempre** in `mode:'online-write'`. Il `S7Client` di lettura e il kit **restano invariati** e senza metodi di scrittura (Review Focus 1).
- `downloadBlock`: ricava type/number/`loadLength`/`mc7Length` da `parseBlockFile(file)`, costruisce il request download, chiama `runDownload` fornendo le fette con `sliceBlockForDownload`, poi invia `_INSE`. Se la connessione cade a metà, rilancia `S7Error` e non ritenta da solo.
- `stop`/`start` ritornano il `ControlResult` (anche "già STOP"/"già RUN" sono risultati, non eccezioni); un `0xD241` è invece `S7Error('CPU_ERROR')` riportato così com'è.
- La lettura riusa la logica del client di lettura (estrarre le parti comuni in un modulo condiviso se serve, senza duplicare).

- [ ] **Step 1: Scrivi i test che falliscano** (`writeClient.test.ts`, contro `FakeCpu`)

  ```ts
  it('writeArea di 1000 byte su un DB poi readArea rilegge identico', async () => { /* split su più PDU */ });
  it('downloadBlock di un blocco → upload dello stesso blocco identico byte per byte', async () => { /* … */ });
  it('stop() → ControlResult ok e mode()==="STOP"; stop() di nuovo → "già STOP"', async () => { /* … */ });
  it('start() → RUN; su CPU protetta 2 la writeArea dà S7Error CPU_ERROR 0xD241', async () => { /* … */ });
  it('S7Client (lettura) non ha metodi di scrittura (chiavi del prototipo)', () => { /* invariato dal 1D */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** `writeClient.ts` e `connectWrite.ts`.
- [ ] **Step 4: Esegui test, typecheck e lint**
- [ ] **Step 5: Commit** — `feat(s7comm): client di scrittura S7WriteClient`

---

### Task 8: `s7bench`: comandi di scrittura con conferma e sicura anti-produzione

**Files:**
- Modify: `apps/s7bench/src/commands.ts` (nuovi comandi + il banner non è più "sola lettura"), `apps/s7bench/src/main.ts` (lettura conferma), `apps/s7bench/src/format.ts`
- Test: aggiunte a `apps/s7bench/test/cli.test.ts`

**Interfaces / comandi** (uscita in italiano; opzioni comuni del 1D più `--conferma` e `--non-in-produzione`):

| Comando | Cosa fa |
|---|---|
| `scrivi <area> <db> <inizio> <esadecimale>` | write var dei byte indicati |
| `carica-nel-dispositivo <file.blk>` | download del blocco nel file (formato `@baaportal/mc7`) e `_INSE` |
| `stop` | PLC stop |
| `avvia` | warm restart (RUN) |

Regole:
- **Conferma obbligatoria** (spec §4): ogni comando di scrittura, prima di agire, apre una connessione **di lettura**, legge identità (ordine) e modo, poi stampa un riepilogo — *cosa* fa, su *quale IP e ordine CPU*, in *quale modo* (RUN/STOP) — e procede **solo** se sono presenti sia `--conferma` sia `--non-in-produzione`. Senza, esce con codice 2 e il riepilogo di cosa avrebbe fatto.
- Il comando `finto` ora avvia un finto PLC che **accetta** scrittura/download/stop-avvio (Task 5–6), così i comandi si provano da capo a fondo in locale.
- Codici di uscita: 0 ok, 1 errore di comunicazione, 2 argomenti/conferma mancante, 3 come nel 1D. Gli errori su stderr con codice e messaggio di `S7Error`. Il banner di aiuto non dice più "sola lettura": elenca i comandi di lettura e, a parte, quelli di scrittura con l'avviso sulla conferma.

- [ ] **Step 1: Scrivi i test che falliscano** (`cli.test.ts`, avviando `finto` su porta libera)

  ```ts
  it('scrivi senza --conferma → codice 2 e stampa il riepilogo (IP, ordine, modo), nessuna scrittura', async () => { /* … */ });
  it('scrivi con --conferma --non-in-produzione cambia MW10; una successiva leggi lo conferma', async () => { /* … */ });
  it('stop con conferma porta il finto PLC in STOP (info lo mostra)', async () => { /* … */ });
  it('carica-nel-dispositivo di un .blk compilato → il blocco compare in blocchi', async () => { /* … */ });
  it('host irraggiungibile → codice 1 CONNECT_REFUSED', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** i comandi e la conferma.
- [ ] **Step 4: Esegui test, typecheck e lint**
- [ ] **Step 5: Commit** — `feat(s7bench): comandi di scrittura con conferma e sicura anti-produzione`

---

### Task 9: Conformità, robustezza e confronto con le CPU vere (via scrittura/download)

**Files:**
- Create: `packages/s7-server/test/writeConformance.test.ts`, `packages/s7-server/test/downloadRoundtrip.test.ts`
- Modify: `packages/s7comm/test/realCaptures.test.ts` (aggiunge write/stop/cold-start/download), `packages/s7comm/test/captures/public.json` (aggiunge, se mancano, la cattura del download e la write di libnodave con SHA-256)
- Test: i file sopra

Regole:
- **Confronto con le CPU vere** (letto come documentazione, mai ridistribuito):
  - su `cisa/snap7.pcap` (in repo): per ogni write var, PLC stop e cold restart, `encodeS7(decodeS7(x))` è identico, e i codec di Task 1–2 ricostruiscono gli stessi byte;
  - sulla cattura del download (scaricata al momento, best-effort in CI): la sequenza `0x1A`/`0x1B`/`0x1C`/`_INSE` si decodifica e si ricodifica identica; `compareShape` confronta le PDU vere con quelle del finto PLC (struttura, non valori);
  - le catture assenti risultano saltate, col nome del file.
- **Giro completo compilatore → PLC → ritorno** (è lo scopo del 1D-bis): si compila un blocco con `@baaportal/mc7` (`blockToMc7File`/`compileBlock`), lo si carica sul finto PLC con `S7WriteClient.downloadBlock`, lo si rilegge con `upload` e dev'essere **identico byte per byte**. Questo prova il giro senza CPU; la verifica *indipendente* su CPU reale resta in sospeso (vedi Task 10 e R6).
- **Robustezza:** download interrotto a metà → `CLOSED`, nessuna promessa appesa, blocco non inserito; write var oltre la PDU divisa correttamente; fuzz di 2000 PDU di scrittura/controllo verso il finto PLC senza crash e con sole `S7Error` lato client.

- [ ] **Step 1: Scrivi i test che falliscano**
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** (per lo più test; correzioni dove i test trovano difetti).
- [ ] **Step 4: Esegui l'intera suite, typecheck, lint** — `npm test && npm run typecheck && npm run lint`
- [ ] **Step 5: Commit** — `test(s7comm,s7-server): conformità scrittura/download e giro completo compilatore→PLC`

---

### Task 10: Limiti noti, piano generale, provenienza, versione e collaudo

**Files:**
- Modify: `docs/limiti-noti.md`, `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, `apps/desktop/package.json` (versione), questo piano (caselle)

Regole:
- **`docs/limiti-noti.md`:**
  - togliere "1D-bis" dalle **mancanze aperte**: scrittura, download e stop/avvio esistono, verificati contro il finto PLC e contro i byte di `cisa/snap7.pcap` (write/stop/cold) e della cattura del download;
  - aggiornare la voce **"Prove di conformità su una CPU reale"**: ora c'è il mezzo per farle (download + esecuzione), ma **restano in sospeso** perché non c'è una CPU; le farà l'amico **a prodotto finito**. Il **punto di decisione** della spec §11 resta aperto;
  - nuova voce **provenienza 1D-bis**: il giro completo "la CPU accetta ed esegue un blocco compilato da BaaPortal" non è mai stato provato su una CPU vera (spec §10); warm restart verificato parzialmente; `_DELE`, `_GARB`, `_MODU` (copy RAM→ROM), MRES, force, set clock, cold/hot restart e l'**interfaccia online nell'app** restano alla tappa 3 (R1, R3).
- **Piano generale:** riga 1D-bis → "nucleo di scrittura/download/stop-avvio fatto e verificato contro il finto PLC e le catture pubbliche; interfaccia online e conformità su CPU reale alla tappa 3"; aggiornare la catena di dipendenze se serve.
- **Versione:** proposta **0.4.0** per il 1D-bis (minore +1, come da prassi); 1F diventerà 0.5.0. L'utente conferma al momento della release.
- **Collaudo:** `npm test && for i in 1 2 3; do npm run e2e || break; done && npm run typecheck && npm run lint && npm run format:check` verde 3 volte su 3 (l'e2e qui non cambia: nessuna interfaccia nuova).
- **Lista di controllo manuale** (solo per chi ha una CPU **non in produzione**, da fare con la massima cautela): è in sospeso finché non c'è una CPU; va eseguita dall'amico a prodotto finito (download di un blocco di prova, RUN, rilettura, STOP).

- [ ] **Step 1: Aggiorna limiti noti, piano generale e versione**
- [ ] **Step 2: Esegui il collaudo tre volte**
- [ ] **Step 3: Commit** — `docs: 1D-bis chiuso (scrittura/download/stop-avvio); conformità su CPU reale ancora in sospeso; versione 0.4.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. 1D-bis = nucleo + s7bench, senza interfaccia online nell'app.** La spec §6 mette l'interfaccia online alla tappa 3; il nucleo di `s7comm` (lettura/scrittura, carica nel/dal dispositivo, RUN/STOP) si costruisce in tappa 1 come strumento interno di test. Tabelle di controllo in scrittura, finestra di confronto e conferma, pulsanti RUN/STOP e modalità online dell'app sono tappa 3 (§8.4, roadmap 3B). *Se fosse sbagliato:* si porta avanti una parte della tappa 3; le decisioni restano valide. **→ Questa è la domanda principale da confermare alla revisione del piano.**
- **R2. Client di scrittura separato; filtro sulla PDU per modo.** Il client di lettura e il kit restano in sola lettura e senza metodi di scrittura (proto §15.4). Il choke point del 1D resta l'unica uscita e diventa consapevole del modo; una connessione `read-only` non può emettere una scrittura nemmeno per un bug. *Se fosse sbagliato:* un controllo in più per frame, costo trascurabile.
- **R3. Allowlist di scrittura ristretta.** Anche in `online-write` passano solo write var, download `0x1A`/`0x1B`/`0x1C`, `0x28` warm restart + `_INSE`, `0x29`. `_DELE`/`_GARB`/`_MODU`/MRES/force/set clock/cold-hot restart restano vietati. *Se fosse sbagliato:* la tappa 3 allarga l'allowlist.
- **R4. Inversione dei ruoli confinata in `runDownload`.** Fuori dalla transazione di download, un job dalla CPU chiude ancora la connessione (comportamento 1D). Dentro, si risponde solo a `0x1B`/`0x1C`. *Se fosse sbagliato:* si sposta la logica, senza cambiare il contratto.
- **R5. Conferma e sicura anti-produzione in s7bench.** La conferma mostra IP, ordine CPU e modo (spec §4) e richiede il riconoscimento "non in produzione" (spec §5). *Se fosse sbagliato:* in tappa 3 la stessa conferma diventa una finestra.
- **R6. Conformità su CPU reale ancora in sospeso.** Niente CPU: tutto è verificato contro il finto PLC e i byte delle catture pubbliche. L'anello finale (la CPU accetta ed esegue un blocco compilato da BaaPortal, spec §10) lo farà l'amico a prodotto finito; il punto di decisione (spec §11) resta aperto. *Se fosse sbagliato:* niente, è un limite dichiarato.
- **R7. Il finto PLC cambia stato da rete solo per l'allowlist di scrittura.** Write→memoria, download→blocco (solo dopo `_INSE`), stop/avvio→modo. Ogni altra funzione resta un errore. *Se fosse sbagliato:* si aggiunge il gestore mancante.
