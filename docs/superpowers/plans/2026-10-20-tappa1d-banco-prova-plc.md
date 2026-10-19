# Piano 1D — Banco di prova PLC (sola lettura) — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Obiettivo:** BaaPortal parla con una CPU S7-300 vera su ISO-on-TCP, **in sola lettura**: identità, stato, SZL, variabili, elenco e informazioni dei blocchi, ora, carica dal dispositivo. Tutto si sviluppa e si prova contro un finto PLC e contro catture pubbliche di CPU S7-300 reali, quindi funziona senza alcuna CPU a disposizione. Il kit di raccolta per l'amico produce un log facoltativo che, quando arriva, diventa un test di regressione.

**Architettura:**
- Pacchetto `@baaportal/s7comm`, TypeScript puro, con:
  - codifica e decodifica dei livelli TPKT, COTP e S7;
  - connessione con un solo job alla volta e un **filtro che blocca ogni PDU in uscita che non sia di sola lettura**;
  - client di lettura;
  - registratore dei telegrammi;
  - lettore pcap.
- Pacchetto `@baaportal/s7-server`: un finto S7-300 che risponde come una CPU 315-2 PN/DP. In seguito lo userà anche il simulatore (tappa 2).
- Strumento interno a riga di comando `apps/s7bench`.
- Kit di raccolta nell'app (menu *Strumenti*), che gira nel processo principale.

**Tecnologie:** TypeScript, `node:net` (solo nel modulo di trasporto), fflate (zip del kit), Vitest, Playwright, React 19 (finestra del kit).

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md` (§5 vincoli legali e di sicurezza, §6 banco di prova, §7 architettura e modulo `s7comm`, §10 test). **Riferimento di protocollo vincolante:** `docs/protocollo/s7comm.md`, citato qui con il numero di sezione (es. "proto §5.11").

## Global Constraints

- **Clean-room** (spec §4, §5):
  - fonti ammesse: manuali Siemens pubblici, RFC, e i progetti open source **letti come documentazione** (snap7, libnodave, dissector Wireshark);
  - **nessun codice copiato** da questi progetti;
  - nessuna analisi di software Siemens.
- **Sola lettura verso qualunque PLC.** Le PDU che si possono inviare sono solo quelle di proto §15.1:
  - setup communication `0xF0`;
  - read var `0x04`;
  - userdata gruppo 4 subfunc `0x01` (SZL);
  - userdata gruppo 3 subfunc `0x01`/`0x02`/`0x03` (blocchi);
  - userdata gruppo 7 lettura ora;
  - carica dal dispositivo `0x1D`/`0x1E`/`0x1F`.

  Ogni altra PDU viene rifiutata **prima** di arrivare al trasporto. Le funzioni che scrivono o cambiano lo stato della CPU non fanno parte di questo piano: arriveranno in un piano dedicato, con conferma esplicita nell'interfaccia (spec §4, tappa 3).
- **Password:** BaaPortal non invia password. Se una CPU protetta rifiuta una lettura, l'errore si riporta così com'è.
- **Valori predefiniti** (proto §2.3, §4, §14):
  - TSAP locale `0x0100`;
  - TSAP remoto da tipo connessione PG, rack 0, slot 2, configurabili;
  - TPDU size `0x0A`;
  - PDU proposta 480, accettando il valore della CPU;
  - un job alla volta;
  - timeout di connessione 5000 ms e di risposta 5000 ms.
- **Processi** (spec §7): la comunicazione con il PLC gira solo nel processo principale di Electron; l'interfaccia passa dal bridge, con il controllo del mittente su ogni canale.
- **Dipendenze:** `node:net` solo in `packages/s7comm/src/node/` e `packages/s7-server/src/node/`; nessuna nuova dipendenza di runtime oltre a fflate.
- **Catture di terzi:**
  - i due file **BSD-3** di cisagov (`snap7.pcap`, `s7ident.pcap`) entrano nel repository con la loro licenza;
  - le altre catture pubbliche (proto §16) si scaricano al momento dei test, con controllo SHA-256, e **non si salvano mai nel repository**;
  - i dati dell'amico o della ditta (blocchi, log) **non entrano mai nel repository**: il repository è pubblico.
- **Windows e macOS:** le lezioni dei piani 1A–1C valgono anche qui:
  - aiuti e2e di `apps/desktop/e2e/helpers.ts`;
  - mai `fs.cpSync`;
  - timeout espliciti di 30 s e soglie larghe nei test di tempo.

## Review Focus

1. **TCP spezza e unisce i frame.** Su una rete vera un TPKT arriva a pezzi o più TPKT arrivano insieme: client e finto PLC devono ricomporli. → Task 1 (FrameReader) e Task 9 (pezzi da 1 byte e frame accorpati).
2. **CPU lenta, muta o che chiude la connessione.**
   - Ci si aspetta un errore tipizzato entro il timeout, mai un'attesa infinita.
   - Le operazioni in corso vengono rifiutate.
   - Un caricamento dal dispositivo iniziato viene chiuso (`0x1F`) oppure cade la connessione.

   → Task 6, Task 7 e Task 9 (iniezione di guasti).
3. **Indirizzo, rack/slot o TSAP sbagliati, CPU dietro CP 343-1, troppe connessioni.** Ci si aspetta un messaggio chiaro, non un blocco. → Task 6 e Task 9 (il finto PLC rifiuta il TSAP o ha il limite di connessioni).
4. **CPU protetta, o item inesistenti** (DB mancante, indirizzo fuori campo): la lettura dà il risultato per item e il kit prosegue registrando l'errore. → Task 7, Task 9 e Task 10.
5. **Risposte grandi:**
   - SZL e liste di blocchi frammentate (proto §6.7);
   - letture più grandi della PDU, da dividere (proto §5.11);
   - blocchi grandi da caricare.

   → Task 2, Task 3, Task 7 e Task 9.

---

### Task 1: `@baaportal/s7comm`: TPKT, COTP, TSAP e ricomposizione dei frame

**Files:**
- Create: `packages/s7comm/{package.json,tsconfig.json,vitest.config.ts}`, `packages/s7comm/src/{index.ts,bytes.ts,tpkt.ts,cotp.ts,tsap.ts,errors.ts}`
- Add: `docs/protocollo/s7comm.md` (già scritto, da includere nel primo commit)
- Test: `packages/s7comm/test/{tpkt,cotp,tsap}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class S7Error extends Error {
    constructor(code: S7ErrorCode, message: string, detail?: { errorClass?: number; errorCode?: number; returnCode?: number });
    readonly code: S7ErrorCode;
  }
  export type S7ErrorCode = 'CONNECT_REFUSED' | 'CONNECT_TIMEOUT' | 'TIMEOUT' | 'CLOSED' | 'COTP_REJECTED' | 'PROTOCOL' | 'CPU_ERROR' | 'FORBIDDEN' | 'ABORTED';
  export function encodeTpkt(payload: Uint8Array): Uint8Array;
  export class FrameReader { push(chunk: Uint8Array): Uint8Array[] }   // payload TPKT completi; S7Error('PROTOCOL') su versione ≠ 3 o lunghezza < 7
  export type CotpPdu =
    | { type: 'CR' | 'CC'; dstRef: number; srcRef: number; tpduSize?: number; srcTsap?: number; dstTsap?: number }
    | { type: 'DT'; eot: boolean; data: Uint8Array }
    | { type: 'DR'; dstRef: number; srcRef: number; reason: number }
    | { type: 'ER'; dstRef: number; cause: number };
  export function encodeCotp(p: CotpPdu): Uint8Array;
  export function decodeCotp(b: Uint8Array): CotpPdu;                  // S7Error('PROTOCOL') se malformato
  export type ConnectionType = 'pg' | 'op' | 'basic';
  export function remoteTsap(type: ConnectionType, rack: number, slot: number): number;  // proto §2.3
  export const LOCAL_TSAP_PG = 0x0100;
  ```

Regole:
- `FrameReader` accumula i byte e restituisce ogni TPKT completo, anche se arriva a pezzi o insieme ad altri. Lunghezza massima del TPKT: proto §1.
- COTP: CR/CC con i parametri `0xC0`, `0xC1`, `0xC2` (proto §2.2); DT con il bit EOT. Le PDU S7 che arrivano su più DT si ricompongono finché EOT = 1 (proto §2.6).
- `remoteTsap`: tipo PG = 1, OP = 2, base = 3; rack 0–7 e slot 0–31, altrimenti `RangeError`. Formula in proto §2.3.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('CR e CC reali di proto §17.1 si decodificano e si ricodificano identici', () => { /* hex → decode → encode === hex */ });
  it('FrameReader: un frame a pezzi di 1 byte e tre frame in un solo blocco', () => { /* … */ });
  it('FrameReader rifiuta versione 2 e lunghezza 3 con S7Error PROTOCOL', () => { /* … */ });
  it('remoteTsap(pg, 0, 2) === 0x0102; remoteTsap(op, 0, 3) === 0x0203; rack 8 → RangeError', () => { /* … */ });
  it('decodeCotp su 200 sequenze casuali non lancia altro che S7Error', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project s7comm`
  Expected: FAIL.

- [ ] **Step 3: Implementa** pacchetto (struttura come `packages/awl`), framing e TSAP.

- [ ] **Step 4: Esegui test, typecheck e lint**

  Run: `npx vitest run --project s7comm && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/s7comm docs/protocollo/s7comm.md package-lock.json
  git commit -m "feat(s7comm): TPKT, COTP e TSAP per ISO-on-TCP, con il riferimento di protocollo"
  ```

---

### Task 2: Header S7, codici di errore, setup communication e read var

**Files:**
- Create: `packages/s7comm/src/s7/{header.ts,errorCodes.ts,setup.ts,readVar.ts,plan.ts}`
- Test: `packages/s7comm/test/{header,setup,readVar,plan}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface S7Pdu { rosctr: 1 | 2 | 3 | 7; pduRef: number; errorClass: number; errorCode: number; param: Uint8Array; data: Uint8Array }
  export function encodeS7(p: S7Pdu): Uint8Array;     // header da 10 byte per 1 e 7, da 12 per 2 e 3 (proto §3)
  export function decodeS7(b: Uint8Array): S7Pdu;     // S7Error('PROTOCOL') se protocol id ≠ 0x32 o lunghezze incoerenti
  export function errorName(errorClass: number, errorCode: number): string;   // da proto §3.3, 'sconosciuto' altrimenti
  export function itemReturnName(code: number): string;                        // proto §3.4/§5.6
  export interface SetupParams { amqCalling: number; amqCalled: number; pduLength: number }
  export function encodeSetup(p: SetupParams): Uint8Array;  // param, stesso formato in richiesta e risposta
  export function decodeSetup(param: Uint8Array): SetupParams;
  export type Area = 'P' | 'I' | 'Q' | 'M' | 'DB' | 'DI' | 'L' | 'V' | 'C' | 'T';
  export type TransportSize = 'BIT' | 'BYTE' | 'CHAR' | 'WORD' | 'INT' | 'DWORD' | 'DINT' | 'REAL' | 'COUNTER' | 'TIMER';
  export interface ReadItem { area: Area; db: number; start: number; bit?: number; size: TransportSize; count: number }
  export type ItemResult = { ok: true; data: Uint8Array } | { ok: false; returnCode: number; name: string };
  export function encodeReadRequest(items: ReadItem[]): Uint8Array;            // param
  export function decodeReadRequest(param: Uint8Array): ReadItem[];
  export function encodeReadResponse(results: ItemResult[]): { param: Uint8Array; data: Uint8Array };
  export function decodeReadResponse(param: Uint8Array, data: Uint8Array): ItemResult[];
  export function planReads(items: ReadItem[], pduLength: number): ReadItem[][];   // proto §5.11
  export function splitArea(area: Area, db: number, start: number, length: number, pduLength: number): ReadItem[];
  ```

Regole:
- Codici area, transport size, return code, padding tra item e lunghezze in bit o byte secondo proto §5.3–§5.10. Timer e contatori: proto §5.8.
- `planReads`: al massimo 20 item per richiesta. Ogni richiesta deve stare nella PDU sia come richiesta sia come risposta (proto §5.11). Un item da solo più grande della PDU non è ammesso: lo divide `splitArea`, che con PDU 240 fa pezzi di al massimo 222 byte.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('setup communication reale di proto §17.2: richiesta e risposta, PDU 480 → 240', () => { /* … */ });
  it('read var a 2 item di proto §17.3 e la risposta a 5 item reale di §17.4', () => { /* lunghezze in bit 0x30, 0x1B0, 0x20 */ });
  it('padding: un item da 3 byte seguito da un altro ha 1 byte di riempimento; l\'ultimo no', () => { /* … */ });
  it('item con return code 0x0A dà { ok: false, returnCode: 10 } e non interrompe gli altri', () => { /* … */ });
  it('planReads: 25 item piccoli → 2 richieste; ogni risposta stimata ≤ PDU', () => { /* … */ });
  it('splitArea(DB, 1, 0, 1000, 240) → pezzi da ≤ 222 byte che coprono 0..999 senza buchi', () => { /* … */ });
  it('encodeS7(decodeS7(x)) === x per ogni vettore di proto §17', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7comm): header S7, codici di errore, setup communication e lettura di variabili`

---

### Task 3: Userdata: SZL, funzioni blocco, ora e frammentazione

**Files:**
- Create: `packages/s7comm/src/s7/{userdata.ts,szl.ts,szlLists.ts,blocks.ts,clock.ts}`
- Test: `packages/s7comm/test/{userdata,szl,blocks,clock}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UserdataParam { method: 'request' | 'response'; group: number; subfunction: number; sequence: number; dataUnitRef?: number; lastDataUnit?: boolean; errorCode?: number }
  export function encodeUserdata(p: UserdataParam, payload: Uint8Array, returnCode?: number): { param: Uint8Array; data: Uint8Array };
  export function decodeUserdata(param: Uint8Array, data: Uint8Array): { param: UserdataParam; returnCode: number; payload: Uint8Array };
  export interface SzlList { id: number; index: number; recordLength: number; records: Uint8Array[] }
  export function parseSzl(fragments: Uint8Array[]): SzlList;     // ricompone i pezzi (proto §6.7, §7.2); ricalcola il conteggio se la CPU manda 0xFFFF
  export function encodeSzl(list: SzlList, maxPayload: number): Uint8Array[];   // per il finto PLC
  export interface CpuIdentity { orderNumber: string; version: string; asName?: string; moduleName?: string; serialNumber?: string; copyright?: string; plantId?: string; mmcSerial?: string }
  export function identityFrom(s0011: SzlList, s001c?: SzlList): CpuIdentity;
  export type CpuMode = 'RUN' | 'STOP' | 'STARTUP' | 'HOLD' | 'DEFECT' | 'UNKNOWN';
  export function modeFrom(s0424: SzlList): CpuMode;
  export interface ProtectionInfo { switchLevel: number; paramLevel: number; validLevel: number; modeSwitch: 'RUN' | 'RUN-P' | 'STOP' | 'MRES' | 'UNKNOWN' }
  export function protectionFrom(s0232: SzlList): ProtectionInfo;
  export interface CommCapabilities { maxPdu: number; maxConnections: number }
  export function commFrom(s0131: SzlList): CommCapabilities;
  export interface DiagEntry { eventId: number; info: Uint8Array; time: S7DateTime }
  export function diagFrom(s00a0: SzlList): DiagEntry[];
  export type BlockType = 'OB' | 'DB' | 'SDB' | 'FC' | 'SFC' | 'FB' | 'SFB';
  export function decodeBlockCounts(payload: Uint8Array): Record<BlockType, number>;
  export function decodeBlockListOfType(payloads: Uint8Array[]): { number: number; flags: number; language: number }[];
  export function encodeBlockCounts(c: Record<BlockType, number>): Uint8Array;                                   // per il finto PLC
  export function encodeBlockListOfType(list: { number: number; flags: number; language: number }[], maxPayload: number): Uint8Array[];
  export interface BlockInfo { type: BlockType; number: number; language: number; flags: number; loadLength: number; security: number; codeTime: S7DateTime; interfaceTime: S7DateTime; ssbLength: number; addLength: number; localDataLength: number; mc7Length: number; author: string; family: string; name: string; version: string; checksum: number }
  export function decodeBlockInfo(payload: Uint8Array): BlockInfo;   /* + encode per il finto PLC */  export function encodeBlockInfo(i: BlockInfo): Uint8Array;
  export interface S7DateTime { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number; weekday?: number }
  export function decodeBcdDateTime(b: Uint8Array): S7DateTime; export function encodeBcdDateTime(t: S7DateTime): Uint8Array;  // proto §12.1
  ```

Regole:
- Layout e valori secondo proto:
  - §6, intestazione e nibble;
  - §6.7, continuazione con lo stesso sequence number e il payload `0a 00 00 00`;
  - §7.2–§7.3, liste SZL;
  - §8, blocchi, con i codici di tipo ASCII e hex e i codici di linguaggio;
  - §12, ora.
- Stringhe ASCII: si tolgono spazi e zeri finali.
- Campi di cui il documento non conosce il significato: si conservano grezzi, senza interpretarli.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('SZL 0x0011 reale di proto §17.5: ordine "6ES7 315-2EH14-0AB0"', () => { /* … */ });
  it('SZL 0x001C in due pezzi di proto §17.6 si ricompone con tutti i record', () => { /* … */ });
  it('modeFrom: byte di modo 0x08 → RUN, 0x04 → STOP, altro → UNKNOWN', () => { /* … */ });
  it('get block info DB1 reale di proto §17.7: tipo, numero, lunghezze, autore', () => { /* … */ });
  it('lista blocchi per tipo in due pezzi e conteggio 0xFFFF ricalcolato', () => { /* … */ });
  it('ora BCD di proto §17.12 in andata e ritorno; mese 13 → S7Error PROTOCOL', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7comm): userdata, liste SZL, funzioni blocco e ora`

---

### Task 4: Carica dal dispositivo e formato del blocco

**Files:**
- Create: `packages/s7comm/src/s7/{upload.ts,blockFile.ts}`
- Test: `packages/s7comm/test/{upload,blockFile}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function blockFileName(type: BlockType, number: number, fs: 'A' | 'P' | 'B'): string;   // proto §9.1, es. '_0A00001A'
  export function encodeStartUpload(fileName: string): Uint8Array;                                  // param
  export function decodeStartUploadResponse(param: Uint8Array): { uploadId: number; totalLength: number | null };
  export function encodeUpload(uploadId: number): Uint8Array; export function decodeUploadResponse(param: Uint8Array, data: Uint8Array): { more: boolean; chunk: Uint8Array };
  export function encodeEndUpload(uploadId: number): Uint8Array;
  // lato finto PLC
  export function decodeStartUpload(param: Uint8Array): { fileName: string }; export function encodeStartUploadResponse(uploadId: number, totalLength: number): Uint8Array;
  export function decodeUploadRequest(param: Uint8Array): { uploadId: number }; export function encodeUploadResponse(more: boolean, chunk: Uint8Array): { param: Uint8Array; data: Uint8Array };
  export interface BlockHeader { type: BlockType; number: number; language: number; flags: number; loadLength: number; security: number; codeTime: S7DateTime; interfaceTime: S7DateTime; ssbLength: number; addLength: number; localDataLength: number; mc7Length: number }
  export function parseBlockFile(bytes: Uint8Array): { header: BlockHeader; mc7: Uint8Array; footer: { author: string; family: string; name: string; version: string; checksum: number } | null };
  export function buildBlockFile(h: Omit<BlockHeader, 'loadLength'>, mc7: Uint8Array, footer: { author: string; family: string; name: string; version: string; checksum: number }): Uint8Array;  // per test e finto PLC
  ```

Regole:
- Sequenza e campi di proto §9. Formato del blocco: proto §13, header verificato e footer da trattare con prudenza (⚠️).
- `parseBlockFile` non lancia mai su blocchi veri: se il footer non torna, restituisce `footer: null` e i byte restano intatti.
- I blocchi si conservano **opachi**: nessuna funzione modifica i byte di un blocco caricato.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('sequenza reale di proto §17.8: start (id e lunghezza 216), upload (EoU 0), end', () => { /* … */ });
  it('parseBlockFile sul blocco reale caricato: magic "pp", tipo e numero coerenti con get block info', () => { /* … */ });
  it('buildBlockFile → parseBlockFile restituisce gli stessi campi e l\'MC7', () => { /* … */ });
  it('parseBlockFile su un blocco troncato restituisce footer null o S7Error PROTOCOL, mai altro', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7comm): carica dal dispositivo e formato del blocco`

---

### Task 5: Catture: lettore pcap, formato del log e prova sui byte di CPU vere

**Files:**
- Create: `packages/s7comm/src/capture/{pcap.ts,tcpStreams.ts,captureLog.ts,dissect.ts}`, `packages/s7comm/test/captures/cisagov/{snap7.pcap,s7ident.pcap,LICENSE.txt,README.md}`, `scripts/fetch-s7-captures.mjs`, `packages/s7comm/test/captures/public.json`
- Modify: `.gitignore` (`.cache/`), `.github/workflows/ci.yml` (step "Scarica catture S7 pubbliche" prima di `npm test`)
- Test: `packages/s7comm/test/{pcap,realCaptures}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CapturedFrame { t: number; dir: 'tx' | 'rx'; bytes: Uint8Array }   // tx = verso la CPU
  export interface CaptureStream { client: string; server: string; frames: CapturedFrame[] }  // frame = payload TPKT interi
  export function readPcap(bytes: Uint8Array): CaptureStream[];        // pcap e pcapng, Ethernet/IPv4/TCP porta 102, TCP ricomposto in ordine
  export function framesToJsonl(frames: CapturedFrame[]): string;     // una riga { t, dir, hex }
  export function jsonlToFrames(text: string): CapturedFrame[];
  export interface CaptureRecorder { record(dir: 'tx' | 'rx', bytes: Uint8Array): void; frames(): CapturedFrame[] }
  export function createRecorder(now?: () => number): CaptureRecorder;
  export type Dissected = { cotp: CotpPdu; s7?: S7Pdu; kind: string };   // kind es. 'setup', 'readVar', 'szl', 'blockInfo', 'upload', 'other'
  export function dissect(tpktPayload: Uint8Array): Dissected;
  ```

Regole:
- I due file BSD-3 di cisagov entrano nel repository, con `LICENSE.txt` e un `README.md` che dice la provenienza, l'URL e lo SHA-256 (proto §16.3).
- `public.json` elenca le altre catture S7-300 di proto §16 con URL e SHA-256. `scripts/fetch-s7-captures.mjs` le scarica in `.cache/s7-captures/`, controlla lo SHA-256 e ritenta 3 volte. Un file che manca o ha un SHA diverso dà un avviso, non un errore.
- Nella CI lo step di download gira con `continue-on-error: true`, così la rete non rompe la build.
- `realCaptures.test.ts`:
  - per **ogni** frame di **ogni** cattura disponibile (sempre le due di cisagov; le altre se sono in `.cache`), `encodeS7(decodeS7(x))` deve dare esattamente gli stessi byte;
  - stessa cosa per i messaggi tipizzati dei Task 2–4 sui tipi che conoscono;
  - le PDU di tipi non coperti (scritture, controllo) si decodificano solo come header generico, senza errore;
  - le catture assenti risultano saltate, con il nome del file.
- Asserzioni di significato su `snap7.pcap`:
  - PDU negoziata 240;
  - ordine `6ES7 315-2EH14-0AB0`;
  - massimo 16 connessioni da SZL 0x0131;
  - il blocco caricato ha magic `pp` e tipo e numero coerenti con la richiesta di caricamento.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('readPcap su snap7.pcap: un flusso sulla porta 102, frame ricomposti, primo frame CR', () => { /* … */ });
  it('ogni PDU S7 delle catture si ricodifica identica', () => { /* per file e indice del frame */ });
  it('snap7.pcap: PDU 240, CPU 315-2EH14, 16 connessioni, blocco caricato con magic pp', () => { /* … */ });
  it('readPcap su byte casuali o pcap troncati: S7Error PROTOCOL, mai altro', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa lettore, log, script e step di CI**

- [ ] **Step 4: Esegui** `node scripts/fetch-s7-captures.mjs && npx vitest run --project s7comm && npm run typecheck && npm run lint`

  Expected: PASS, con tutte le catture di §16 controllate. Riporta nel rapporto quanti frame sono stati controllati per file e quali tipi di PDU.

- [ ] **Step 5: Commit** — `test(s7comm): verifica dei codificatori su catture pubbliche di CPU S7-300 reali`

---

### Task 6: Trasporto, connessione e filtro di sola lettura

**Files:**
- Create: `packages/s7comm/src/{transport.ts,connection.ts,readOnlyGuard.ts}`, `packages/s7comm/src/node/tcpTransport.ts`
- Test: `packages/s7comm/test/{connection,readOnlyGuard}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Transport { send(bytes: Uint8Array): void; onData(cb: (chunk: Uint8Array) => void): void; onClose(cb: (err?: Error) => void): void; close(): void }
  export type TransportFactory = (host: string, port: number, timeoutMs: number) => Promise<Transport>;
  export function memoryTransportPair(): [Transport, Transport];                // per i test e il finto PLC in memoria
  export const tcpTransport: TransportFactory;                                   // node:net; CONNECT_REFUSED / CONNECT_TIMEOUT
  export interface ConnectOptions { host: string; port?: number; rack?: number; slot?: number; connectionType?: ConnectionType; localTsap?: number; remoteTsap?: number; timeoutMs?: number; proposedPdu?: number; transport?: TransportFactory; recorder?: CaptureRecorder; signal?: AbortSignal }
  export class S7Connection {
    static open(o: ConnectOptions): Promise<S7Connection>;
    readonly pduLength: number; readonly amq: number;
    request(param: Uint8Array, data: Uint8Array, rosctr: 1 | 7, timeoutMs?: number): Promise<S7Pdu>;
    close(): Promise<void>;
    readonly closed: boolean;
  }
  export function assertReadOnly(pdu: S7Pdu): void;   // S7Error('FORBIDDEN') se la PDU non è nell'allowlist
  ```

Regole:
- **Apertura:**
  1. CR COTP con TSAP e TPDU size; serve un CC entro il timeout.
  2. Un DR o un ER dà `COTP_REJECTED`, con il motivo.
  3. Setup communication con la PDU proposta; si usa il valore della CPU.
  4. Si imposta un job alla volta, anche se la CPU ne concede di più.
- **Riferimento PDU:** cresce di uno a ogni richiesta, salta lo 0 e si riavvolge a 16 bit. Si accetta solo la risposta con lo stesso riferimento. Una risposta inattesa si registra nel log e si ignora.
- **Ogni** PDU in uscita, setup compreso, passa da `assertReadOnly` **prima** di `Transport.send`. L'allowlist è quella di proto §15.1:
  - ROSCTR 1 con funzione `0xF0`, `0x04`, `0x1D`, `0x1E` o `0x1F`;
  - ROSCTR 7 con metodo richiesta e gruppo/subfunzione `4/0x01`, `3/0x01`, `3/0x02`, `3/0x03` o lettura ora del gruppo 7.

  Tutto il resto dà `FORBIDDEN` e il trasporto non riceve nulla. Una PDU che arriva **dalla CPU** con ROSCTR 1 (un job) non riceve risposta e si chiude la connessione con `PROTOCOL`.
- **Timeout di risposta:**
  - `TIMEOUT`, e la connessione si chiude, perché il suo stato non è più affidabile;
  - le richieste in coda vengono rifiutate con `CLOSED`;
  - con `signal` annullato, `ABORTED`.
- Il registratore riceve ogni frame in entrata e in uscita, anche se poi viene rifiutato o si chiude la connessione.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('apertura su memoryTransportPair con un server di prova: TSAP inviati, PDU 240 negoziata', () => { /* … */ });
  it('DR al posto del CC → COTP_REJECTED; nessuna risposta → CONNECT_TIMEOUT entro 1,5× il timeout', () => { /* … */ });
  it('assertReadOnly: write var 0x05, 0x1A, 0x28, 0x29, userdata gruppi 1, 2 e 5 e scrittura ora sono vietati; l\'allowlist passa', () => { /* elenco esplicito di PDU costruite a mano */ });
  it('una PDU vietata non arriva mai al trasporto (spia su send)', () => { /* … */ });
  it('timeout di risposta: TIMEOUT, connessione chiusa, richiesta in coda rifiutata con CLOSED', () => { /* … */ });
  it('un job ROSCTR 1 in arrivo dalla CPU chiude la connessione con PROTOCOL', () => { /* … */ });
  it('tcpTransport verso una porta chiusa di 127.0.0.1 → CONNECT_REFUSED', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7comm): connessione ISO-on-TCP con filtro di sola lettura`

---

### Task 7: Client di lettura

**Files:**
- Create: `packages/s7comm/src/client.ts`
- Test: `packages/s7comm/test/client.test.ts`

**Interfaces:**
- Consumes: Task 2–6.
- Produces:
  ```ts
  export class S7Client {
    static connect(o: ConnectOptions): Promise<S7Client>;
    readonly pduLength: number;
    readItems(items: ReadItem[]): Promise<ItemResult[]>;                                   // usa planReads
    readArea(area: Area, db: number, start: number, length: number): Promise<Uint8Array>; // usa splitArea; un errore di item → S7Error CPU_ERROR con returnCode
    readSzl(id: number, index: number): Promise<SzlList>;                                  // segue i pezzi
    identity(): Promise<CpuIdentity>; mode(): Promise<CpuMode>; protection(): Promise<ProtectionInfo>; communication(): Promise<CommCapabilities>; diagnosticBuffer(): Promise<DiagEntry[]>;
    blockCounts(): Promise<Record<BlockType, number>>; listBlocks(type: BlockType): Promise<{ number: number; flags: number; language: number }[]>; blockInfo(type: BlockType, number: number): Promise<BlockInfo>;
    readClock(): Promise<S7DateTime>;
    upload(type: BlockType, number: number): Promise<Uint8Array>;   // EndUpload sempre, anche su errore
    close(): Promise<void>;
  }
  ```

Regole:
- Un errore nell'header della risposta dà `S7Error('CPU_ERROR')` con classe, codice e `errorName`. Nella lettura per item gli errori restano per item.
- `upload`:
  - termina con `0x1F` in un `finally`, salvo se la connessione è già chiusa;
  - un limite di 16 MiB per blocco protegge da lunghezze assurde;
  - se la CPU dichiara una lunghezza totale, i byte ricevuti devono corrispondere, altrimenti `PROTOCOL`.
- `identity` legge 0x0011 indice 0 e 0x001C indice 0. Se la 0x001C viene rifiutata, l'identità ha solo i campi della 0x0011.
- `mode`: SZL 0x0424 indice 0 (proto §7.3). `protection`: SZL 0x0232 indice 4.
- Il client non offre alcun metodo di scrittura.

- [ ] **Step 1: Scrivi i test che falliscono**

  Con un finto server minimo scritto nel test sopra `memoryTransportPair`, che risponde con i vettori di proto §17:
  ```ts
  it('identity, mode, protection e communication dai vettori reali', async () => { /* … */ });
  it('readArea di 1000 byte con PDU 240: 5 richieste, dati ricomposti in ordine', async () => { /* … */ });
  it('readItems con un DB mancante: risultato per item, gli altri letti', async () => { /* … */ });
  it('upload: errore a metà → EndUpload inviato comunque e S7Error rilanciato', async () => { /* … */ });
  it('upload con lunghezza dichiarata diversa dai byte ricevuti → PROTOCOL', async () => { /* … */ });
  it('S7Client non ha metodi di scrittura (controllo sulle chiavi del prototipo)', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7comm): client di lettura S7 per S7-300`

---

### Task 8: `@baaportal/s7-server`: il finto S7-300

**Files:**
- Create: `packages/s7-server/{package.json,tsconfig.json,vitest.config.ts}`, `packages/s7-server/src/{index.ts,fakeCpu.ts,session.ts,szlData.ts,faults.ts}`, `packages/s7-server/src/node/listen.ts`
- Test: `packages/s7-server/test/{fakeCpu,session}.test.ts`

**Interfaces:**
- Consumes: i codificatori di `@baaportal/s7comm` (Task 1–4), usati nel verso del server.
- Produces:
  ```ts
  export interface FakeCpuOptions {
    orderNumber?: string;                // '6ES7 315-2EH14-0AB0'
    firmware?: string;                   // 'V3.2'
    asName?: string; moduleName?: string; serialNumber?: string;
    pduLength?: number;                  // 240
    maxConnections?: number;             // 16
    rack?: number; slot?: number;        // 0, 2: TSAP remoto atteso
    mode?: CpuMode;                      // 'RUN'
    protectionLevel?: 1 | 2 | 3;         // 1
    sizes?: { inputBytes: number; outputBytes: number; mBytes: number; timers: number; counters: number };  // 2048, 2048, 2048, 256, 256
    clock?: () => S7DateTime;
    faults?: FaultPlan;
  }
  export interface FaultPlan { delayMs?: number; dropAfterResponses?: number; chunkSize?: number; ignoreFunction?: number; errorFor?: { function: number; errorClass: number; errorCode: number } }
  export class FakeCpu {
    constructor(o?: FakeCpuOptions);
    // API di prova, solo in memoria: nessun comando di rete la raggiunge
    setMemory(area: 'I' | 'Q' | 'M', start: number, bytes: Uint8Array): void;
    addDb(number: number, bytes: Uint8Array): void;
    addBlock(file: Uint8Array): void;    // blocco nel formato di Task 4
    setMode(m: CpuMode): void;
    addDiagnostic(e: DiagEntry): void;
    readonly connections: number;
  }
  export function serve(cpu: FakeCpu, t: Transport): { close(): void };
  export function listen(cpu: FakeCpu, opts?: { host?: string; port?: number }): Promise<{ port: number; close(): Promise<void> }>;  // porta 0 = libera
  ```

Regole:
- Risponde come una CPU 315-2 PN/DP (proto §7.4):
  - CC solo per il TSAP remoto atteso, altrimenti DR;
  - PDU ridotta al suo valore;
  - read var per I/Q/M/DB/T/C con i return code di proto §5.6: `0x0A` per un DB mancante, `0x05` fuori campo;
  - SZL 0x0000, 0x0011, 0x001C, 0x0131 indici 1 e 2, 0x0232 indice 4, 0x0424, 0x00A0, frammentate quando superano la PDU;
  - conteggio, elenco e informazioni dei blocchi, coerenti con i blocchi caricati con `addBlock`;
  - lettura dell'ora;
  - caricamento dal dispositivo con id di sessione. Un secondo caricamento in parallelo dà l'errore di proto §3.3 per "nessun upload parallelo".
- Un DB aggiunto con `addDb` è sia memoria leggibile sia blocco elencato, con un file costruito con `buildBlockFile`.
- Ogni funzione **non** di lettura che arriva dalla rete riceve una risposta di errore, la stessa che una CPU dà a una funzione non disponibile (proto §3.3). Lo stato del finto PLC non cambia mai da rete.
- Livello di protezione 3: le letture di variabili e i caricamenti dal dispositivo rispondono con l'errore di protezione di proto §14. SZL ed elenco blocchi restano leggibili, come su una CPU vera.
- Oltre `maxConnections` connessioni il CR riceve un DR.
- Le opzioni `faults` permettono di provare la robustezza del client:
  - ritardo prima di ogni risposta;
  - chiusura dopo N risposte;
  - risposte spezzate in pezzi di N byte;
  - silenzio su una funzione;
  - errore forzato.

- [ ] **Step 1: Scrivi i test che falliscono**

  Le richieste si costruiscono con i codificatori di s7comm e si mandano con `serve` su `memoryTransportPair`:
  ```ts
  it('TSAP giusto → CC; slot sbagliato → DR', () => { /* … */ });
  it('SZL 0x0011 del finto PLC si decodifica come quella della CPU vera di proto §17.5', () => { /* stessi campi, ordine 6ES7 315-2EH14-0AB0 */ });
  it('SZL 0x0000 più lunga della PDU 240 arriva in più pezzi con last-data-unit corretto', () => { /* … */ });
  it('read var su DB inesistente → 0x0A; oltre la dimensione di M → 0x05', () => { /* … */ });
  it('una write var o un comando di controllo da rete → risposta di errore e stato invariato', () => { /* PDU costruite a mano nel test */ });
  it('protezione 3: read var e upload rifiutati con l\'errore di proto §14; SZL leggibile', () => { /* … */ });
  it('17ª connessione → DR', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7-server): finto S7-300 per i test e la CI`

---

### Task 9: Conformità client ↔ finto PLC, robustezza e confronto con le CPU vere

**Files:**
- Create: `packages/s7-server/test/{conformance,robustness,vsRealCaptures}.test.ts`, `packages/s7-server/src/compareShape.ts`
- Modify: dove i test trovano difetti

**Interfaces:**
- Produces:
  ```ts
  export function compareShape(real: S7Pdu, fake: S7Pdu): string[];   // differenze di struttura, [] se uguali; non i valori
  ```

Regole:
- **Conformità.** Ogni metodo di `S7Client` contro `FakeCpu`, con:
  - `memoryTransportPair`;
  - TCP vero su `127.0.0.1` con porta libera;
  - PDU 240, 480 e 960.
  I risultati devono coincidere con lo stato messo nel finto PLC: byte di memoria, blocchi, identità, modo, ora, voci del buffer diagnostico.
- **Robustezza**, con `faults`:
  - risposte a pezzi da 1 byte;
  - ritardo oltre il timeout, che dà `TIMEOUT` entro 1,5 volte il timeout;
  - chiusura a metà di un caricamento, che dà `CLOSED`, senza promesse rimaste in attesa e con il registratore che contiene tutti i frame;
  - errore forzato su una SZL;
  - 200 sessioni aperte e chiuse in fila, con il numero di connessioni del finto PLC che torna a 0.
- **Fuzz:** 2000 PDU casuali verso il finto PLC e 2000 risposte casuali verso il client. Il client dà solo `S7Error` e il finto PLC non va mai in crash.
- **Confronto con le CPU vere:**
  1. Per ogni richiesta di lettura delle catture reali (Task 5), la stessa richiesta va al finto PLC, configurato come la CPU della cattura dove è noto (ordine, PDU).
  2. `compareShape` confronta la risposta vera con quella del finto PLC, guardando la struttura:
     - ROSCTR, funzione, lunghezze dei parametri;
     - header dei dati e header delle liste SZL (id, indice, lunghezza del record);
     - transport size;
     - presenza della frammentazione.
  3. Ogni differenza fa fallire il test con il nome della cattura e l'indice del frame. Si correggono il finto PLC o il codificatore, mai la cattura.
  4. Il rapporto elenca le richieste confrontate per cattura.

- [ ] **Step 1: Scrivi i test**

- [ ] **Step 2: Esegui e correggi quello che trovano**

  Ogni correzione di logica ha il suo test unitario nel pacchetto in cui sta.

  Run: `node scripts/fetch-s7-captures.mjs && npx vitest run --project s7comm --project s7-server`
  Expected: PASS.

- [ ] **Step 3: Esegui typecheck e lint**

- [ ] **Step 4: Commit** — `test(s7-server): conformità del client, robustezza e confronto con catture di CPU vere`

---

### Task 10: Kit di raccolta (nucleo) e regressione sul log dell'amico

**Files:**
- Create: `packages/s7comm/src/kit/{collect.ts,kitZip.ts}`, `packages/s7comm/test/kit.test.ts`, `packages/s7-server/test/kitAgainstFake.test.ts`, `packages/s7-server/test/privateKit.test.ts`
- Modify: `.gitignore` (`fixtures-private/`), `packages/s7comm/package.json` (fflate)

**Interfaces:**
- Produces:
  ```ts
  export interface KitOptions { host: string; port?: number; rack?: number; slot?: number; connectionType?: ConnectionType; includeBlocks: boolean; minIntervalMs?: number; timeoutMs?: number; transport?: TransportFactory }
  export interface KitProgress { phase: 'connect' | 'identity' | 'szl' | 'blocks' | 'upload' | 'done'; done: number; total: number; message: string }
  export interface KitSummary { baaportalVersion: string; startedAt: string; finishedAt: string; host: string; identity?: CpuIdentity; mode?: CpuMode; pduLength?: number; szlRead: number; blocksListed: number; blocksUploaded: number; errors: { step: string; code: S7ErrorCode; message: string }[] }
  export function collect(o: KitOptions, onProgress: (p: KitProgress) => void, signal?: AbortSignal, appVersion?: string): Promise<{ files: Record<string, Uint8Array>; summary: KitSummary }>;
  export function kitZip(r: { files: Record<string, Uint8Array>; summary: KitSummary }): Uint8Array;
  export function readKitZip(bytes: Uint8Array): { summary: KitSummary; frames: CapturedFrame[]; blocks: Record<string, Uint8Array> };
  ```

Regole:
- **Ordine di raccolta:**
  1. Connessione.
  2. SZL 0x0000. Poi, con indice 0, ogni SZL elencata fino a un massimo di 150, più 0x0011, 0x001C, 0x0131 indici 1–3, 0x0232 indice 4, 0x0424, 0x00A0.
  3. Conteggio blocchi, elenco per ogni tipo, informazioni di ogni blocco.
  4. Con `includeBlocks`, caricamento di ogni OB/FB/FC/DB/SFC/SFB/SDB.
  5. Ora.

  Tra una richiesta e l'altra almeno `minIntervalMs` (predefinito 50).
- **Errori:** quello di un passo si registra e la raccolta continua. Una connessione caduta si riapre una sola volta. Al secondo errore di connessione la raccolta finisce, con quello che c'è.
- **Contenuto dello zip:**
  - `LEGGIMI.txt`, in italiano: cosa contiene e che nulla è stato scritto nel PLC;
  - `summary.json`;
  - `capture.jsonl`, con **tutti** i frame;
  - `szl/<ID>-<INDICE>.json`, con i record in esadecimale e i campi decodificati;
  - `blocchi/<TIPO><N>.blk`, con i byte esatti;
  - `blockinfo/<TIPO><N>.json`.
- La raccolta usa solo `S7Client`, quindi il filtro di sola lettura del Task 6 vale anche qui.
- **Regressione privata:** `privateKit.test.ts` cerca gli zip in `fixtures-private/kit/`, cartella ignorata da git. Per ognuno:
  - ogni frame si ricodifica identico;
  - ogni blocco si legge con `parseBlockFile`;
  - le risposte vere hanno la stessa struttura di quelle del finto PLC (`compareShape`).

  Senza zip il test risulta saltato.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('collect contro il finto PLC con 5 blocchi: zip completo, blocchi identici a quelli messi', async () => { /* … */ });
  it('nel log della raccolta ci sono solo PDU dell\'allowlist', async () => { /* dissect su ogni frame tx */ });
  it('protezione 3: identità e SZL raccolte, letture e blocchi come errori nel riepilogo', async () => { /* … */ });
  it('connessione che cade al terzo blocco: riapre una volta, poi finisce con quello che ha', async () => { /* … */ });
  it('annullamento con AbortSignal: zip parziale con errore ABORTED', async () => { /* … */ });
  it('readKitZip(kitZip(x)) restituisce riepilogo, frame e blocchi', () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7comm): kit di raccolta in sola lettura e regressione sui log reali`

---

### Task 11: `s7bench`, strumento interno a riga di comando

**Files:**
- Create: `apps/s7bench/{package.json,tsconfig.json,vitest.config.ts}`, `apps/s7bench/src/{main.ts,commands.ts,format.ts}`
- Modify: `package.json` (script `"s7bench": "npm run start -w @baaportal/s7bench --"`), `tsx` in devDependencies se manca
- Test: `apps/s7bench/test/cli.test.ts`

Comandi, con uscita in italiano. Opzioni comuni: `--host`, `--port 102`, `--rack 0`, `--slot 2`, `--tipo pg|op|base`, `--timeout 5000`, `--log file.jsonl`.

| Comando | Cosa fa |
|---|---|
| `info` | identità, modo, protezione, PDU, connessioni |
| `szl <id> [indice]` | lista SZL decodificata ed esadecimale |
| `leggi <area> <db> <inizio> <lunghezza>` | byte in esadecimale |
| `blocchi [tipo]` | conteggi o elenco |
| `infoblocco <tipo> <n>` | informazioni del blocco |
| `carica <tipo> <n> -o <file>` | carica dal dispositivo e salva |
| `ora` | ora della CPU |
| `raccogli -o <file.zip> [--senza-blocchi]` | il kit del Task 10 |
| `finto [--porta 0] [--protezione 3]` | avvia il finto PLC e stampa `porta <n>` |
| `decodifica <file.pcap\|file.jsonl\|file.zip>` | elenco dei frame decodificati |

Regole:
- Codici di uscita: 0 ok, 1 errore di comunicazione, 2 argomenti sbagliati. Gli errori si scrivono su stderr, con codice e messaggio di `S7Error`.
- Non esiste alcun comando di scrittura.

- [ ] **Step 1: Scrivi i test che falliscono**

  I test avviano `finto` su una porta libera e lanciano i comandi come processi figli:
  ```ts
  it('info contro il finto PLC stampa ordine, modo RUN e PDU 240', async () => { /* … */ });
  it('raccogli produce uno zip leggibile con readKitZip', async () => { /* … */ });
  it('decodifica sulla cattura snap7.pcap elenca setup, SZL e caricamento', async () => { /* … */ });
  it('host irraggiungibile → codice 1 e messaggio CONNECT_REFUSED; argomenti mancanti → 2', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, typecheck e lint**

- [ ] **Step 5: Commit** — `feat(s7bench): strumento a riga di comando di sola lettura e finto PLC`

---

### Task 12: Kit di raccolta nell'app

**Files:**
- Create: `packages/ui/src/project/dialogs/KitDialog.tsx`, `apps/desktop/src/main/kit.ts`, `docs/kit-raccolta.md`
- Modify:
  - `packages/ui/src/project/menuModel.ts`: voce `tools.collectCpuData` nel menu *Strumenti*, attiva anche senza progetto aperto;
  - `packages/ui/src/bridge.ts`, `packages/ui/test/fakeBridge.ts`;
  - `apps/desktop/src/{main/ipc.ts,preload/index.ts,shared/rawBridge.ts}`;
  - `packages/ui/src/i18n/{it,en}.json`.
- Test: `packages/ui/test/kitDialog.test.tsx`, `apps/desktop/e2e/kit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // BaaBridge
  startKit(opts: { host: string; port: number; rack: number; slot: number; connectionType: ConnectionType; includeBlocks: boolean }): Promise<{ ok: true; savedTo: string | null; summary: KitSummary } | { ok: false; error: string }>;
  cancelKit(): void;
  onKitProgress(cb: (p: KitProgress) => void): () => void;
  ```

Regole:
- **Finestra "Raccolta dati CPU (sola lettura)":**
  - campi: indirizzo IP, porta (102, sotto "Avanzate"), rack (0), slot (2), tipo di connessione (PG);
  - casella "Carica anche i blocchi dal PLC", attiva per impostazione;
  - testo fisso: "Questa funzione legge soltanto: non scrive nulla nel PLC e non cambia il suo stato. Usala a macchina ferma o non critica.";
  - avanzamento con fase e conteggio, e pulsante Annulla.
- **Alla fine** si apre il dialogo di salvataggio con nome `raccolta-<ordine>-<data>.zip`. Annullare il salvataggio non perde la raccolta: si può salvare di nuovo finché la finestra resta aperta.
- **Nel processo principale:**
  - controllo del mittente;
  - validazione degli argomenti: IPv4 o nome host; porta 1–65535; rack 0–7; slot 0–31;
  - una sola raccolta alla volta, una seconda richiesta dà errore;
  - `collect` con `tcpTransport`;
  - avanzamento al renderer;
  - scrittura con `writeFileAtomic`.
- `docs/kit-raccolta.md`: istruzioni per l'amico in italiano, passo per passo:
  - installare la release;
  - collegare il PC alla rete della CPU;
  - aprire *Strumenti → Raccolta dati CPU*;
  - inviare lo zip.

  Dice anche che cosa contiene lo zip, che contiene il suo programma, e che nulla viene scritto.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('la finestra valida l\'IP e mostra il testo di sola lettura', async () => { /* … */ });
  it('avanzamento e annullamento passano dal bridge', async () => { /* FakeBridge */ });
  // e2e: il test avvia il finto PLC (s7bench finto) su una porta libera
  it('raccolta completa contro il finto PLC e zip salvato (stub del dialogo)', async () => { /* readKitZip sul file */ });
  it('IP irraggiungibile: messaggio chiaro in pochi secondi, l\'app resta usabile', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui test, e2e, typecheck e lint**

  Run: `npm test && npm run e2e && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): kit di raccolta dati CPU in sola lettura nel menu Strumenti`

---

### Task 13: Piano generale, collaudo e versione

**Files:**
- Modify: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, `apps/desktop/package.json` (versione `0.2.0`), questo piano (caselle)

Regole:
- **Piano generale:**
  - riga 1D: "Fatto quando" diventa "client di lettura e kit verificati contro il finto PLC in CI e sui byte di catture pubbliche di CPU S7-300 reali; il log dell'amico, quando c'è, entra come test di regressione privato";
  - le funzioni che scrivono o controllano la CPU (scrittura di variabili, carica nel dispositivo, RUN/STOP) diventano un piano a parte, **1D-bis**, prima delle prove di conformità del 1E, con conferma esplicita nell'interfaccia;
  - riga 1E: l'andata e ritorno usa i blocchi disponibili (catture pubbliche, kit dell'amico se c'è, blocchi prodotti da noi);
  - sezione "Senza una CPU di prova propria": il kit è facoltativo e non blocca nessun piano.
- **Collaudo:** `npm test && for i in 1 2 3; do npm run e2e || break; done && npm run typecheck && npm run lint && npm run format:check` verde 3 volte su 3.
- **Lista di controllo manuale** (per chi ha una CPU, in sola lettura):
  - [ ] `npm run s7bench -- info --host <IP>` mostra la CPU giusta;
  - [ ] la raccolta dall'app produce lo zip;
  - [ ] lo zip dà verde in `privateKit.test.ts`.

- [ ] **Step 1: Aggiorna il piano generale e la versione**

- [ ] **Step 2: Esegui il collaudo tre volte**

- [ ] **Step 3: Commit** — `docs: piano 1D chiuso, 1D-bis per le funzioni di scrittura; versione 0.2.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Il 1D è solo lettura.** Scrittura e controllo della CPU vanno nel piano 1D-bis, con conferma nell'interfaccia. Se fosse sbagliato: il 1E aspetta il 1D-bis per le prove di conformità sulla CPU non in produzione.
- **R2. Filtro sulla PDU in uscita, non solo sull'API.** Anche un errore di programmazione nel client non può far uscire una scrittura. Se fosse sbagliato: un controllo in più per ogni PDU, costo trascurabile.
- **R3. Un job alla volta per connessione**, anche se la CPU ne concede di più (proto §14). Se fosse sbagliato: letture un po' più lente.
- **R4. Catture BSD-3 nel repository, le altre scaricate al momento dei test.** Così la CI ha sempre una verifica su byte di una CPU vera senza ridistribuire file senza licenza. Se fosse sbagliato: si toglie un file dal repository.
- **R5. Il finto PLC risponde con un errore a ogni funzione non di lettura.** Non simula scritture finché non esiste il 1D-bis. Se fosse sbagliato: il 1D-bis aggiunge le funzioni.
- **R6. I dati dell'amico non entrano mai nel repository.** Il test di regressione privato li legge da una cartella ignorata da git. Se fosse sbagliato: nessun costo.
- **R7. Il kit vive nell'app**, perché l'amico installa la release e non deve avere Node. `s7bench` resta lo strumento di sviluppo. Se fosse sbagliato: si aggiunge un eseguibile separato.
