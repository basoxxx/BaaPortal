# Piano 1E — Compilatore MC7 — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Obiettivo:** BaaPortal legge e scrive il formato dei blocchi S7-300 e traduce in entrambe le direzioni tra AWL e MC7. Le funzioni sono quattro:
- un blocco reale si decodifica in AWL e si ricodifica **identico byte per byte**;
- un blocco scritto in BaaPortal si compila in un blocco MC7 valido, con *Compila* e i messaggi in *Informazioni → Compila*;
- i blocchi caricati dal kit di raccolta si importano nel progetto;
- tutto lavora **offline**.

**Architettura:**
- Nuovo pacchetto `@baaportal/mc7`, che contiene:
  - il file di blocco completo: header, interfaccia (SSB), MC7, reti e salti (ADD), footer, CRC;
  - la tabella delle istruzioni;
  - il decodificatore MC7 → AWL;
  - il codificatore AWL → MC7;
  - il compilatore dei blocchi del progetto.
- `@baaportal/project` collega i blocchi del modello a quelli MC7, con importazione ed esportazione.
- L'interfaccia aggiunge *Compila* e l'importazione dei blocchi.

**Tecnologie:** TypeScript, Vitest, React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md` (§7 modulo `mc7`; tappa 1: compilazione e decodificatore; §10 andata e ritorno; §11 rischi). **Riferimento di formato vincolante:** `docs/protocollo/mc7.md`, citato come "mc7 §x".

## Global Constraints

- **Clean-room** (spec §4, §5):
  - DotNetSiemensPLCToolBoxLibrary, rz-libmc7, snap7 e il dissector Wireshark si leggono solo come documentazione;
  - **nessun codice copiato**;
  - nessuna analisi di software Siemens.
- **Blocchi di prova di terzi** (mc7 §5.5, LGPL): si scaricano al momento dei test, con controllo SHA-256, e **non entrano mai nel repository**. Restano nel repository solo i dati già presenti di origine BSD-3, cioè le catture di cisagov.
- **Offline:** questo piano non comunica con nessun PLC.
  - Il **1D-bis** (scrittura nel PLC) è una mancanza aperta: nessun task la presuppone o la sostituisce.
  - Le prove di conformità sulla CPU restano in sospeso. I programmi di prova si scriveranno con il simulatore (tappa 2).
- **Dati della ditta o dell'amico:** mai nel repository. I test che li usano leggono `fixtures-private/`.
- **Formato `.baap`:** resta il 3. I metadati MC7 sono un campo facoltativo dei blocchi, che i lettori esistenti conservano già (`looseObject`).
- **Mnemonico:** il codice salvato resta internazionale (piano 1C, R1). Il decodificatore produce AWL internazionale in forma canonica (`formatNetwork`).
- **Windows e macOS:** si applicano le lezioni dei piani precedenti:
  - percorsi normalizzati nei test;
  - timeout espliciti di 30 s;
  - soglie larghe;
  - aiuti e2e.

## Review Focus

1. **Blocco reale con forme mai viste.** Ci si aspetta che il decodificatore non perda byte e non si fermi: le parti non riconosciute diventano un'istruzione grezza ricodificabile identica. → Task 4 (blocchi sintetici con opcode ignoti).
2. **Blocco caricato da un'altra CPU o firmware, oppure da TIA o SCL.** Rete vuota finale, NOP 0, `BLD`, BE dentro la rete: l'andata e ritorno resta identica. → Task 5 (OB1 TIA reale, FB41 SCL).
3. **Compilare un blocco con errori.** Ci si aspetta: nessun blocco prodotto, errori con segmento e riga in *Informazioni → Compila*, nessun blocco vecchio sostituito. → Task 7 e Task 9.
4. **DB grandi** (64 KB) e interfacce annidate (ARRAY di STRUCT, multi-istanze). Il layout calcolato deve coincidere con la lunghezza reale. → Task 2 (DB13 da 64 KB, DB1806).
5. **Importare un blocco che esiste già nel progetto.** Ci si aspetta una conferma prima di sostituire, un solo passo di annulla e nessun dato perso. → Task 8.

---

### Task 1: `@baaportal/mc7`: file di blocco completo e CRC

**Files:**
- Create:
  - `packages/mc7/{package.json,tsconfig.json,vitest.config.ts}`;
  - `packages/mc7/src/{index.ts,blockFile.ts,crc.ts,add.ts}`;
  - `packages/mc7/test/blocks.json`: elenco dei blocchi di terzi da scaricare, con URL, SHA-256 e licenza (mc7 §5.5);
  - `packages/mc7/test/realBlocks.ts`: carica i blocchi reali dalle catture e da `.cache/mc7-blocks/`.
- Modify: `scripts/fetch-s7-captures.mjs`, che legge anche `packages/mc7/test/blocks.json` e scarica in `.cache/mc7-blocks/`; `docs/protocollo/mc7.md`, da includere nel primo commit.
- Test: `packages/mc7/test/{blockFile,crc,add}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BlockKind = 'OB' | 'DB' | 'SDB' | 'FC' | 'SFC' | 'FB' | 'SFB';
  export interface Mc7Header { raw: Uint8Array; kind: BlockKind | undefined; kindCode: number; number: number; language: number; flags: number; knowHowProtected: boolean; mc7Length: number; ssbLength: number; addLength: number; localDataLength: number; codeTime: Uint8Array; interfaceTime: Uint8Array }  // mc7 §1.2
  export interface Mc7Add { networks: number[]; jumps: number[]; rest: Uint8Array }  // mc7 §1.5: lunghezze delle reti, offset dei salti, byte non interpretati
  export interface Mc7Footer { raw: Uint8Array; author: string; family: string; name: string; version: string; checksum: number }  // mc7 §1.6
  export interface Mc7File { header: Mc7Header; mc7: Uint8Array; ssb: Uint8Array; add: Mc7Add; addRaw: Uint8Array; footer: Mc7Footer }
  export function readBlockFile(bytes: Uint8Array): Mc7File;          // S7Error-like Mc7Error('FORMAT') solo per errori di struttura
  export function writeBlockFile(f: Mc7File): Uint8Array;             // writeBlockFile(readBlockFile(x)) === x
  export function blockChecksum(kindCode: number, mc7: Uint8Array): number;   // mc7 §1.7: CRC-16 polinomio 0x9003, init 0, MSB prima
  export class Mc7Error extends Error { constructor(code: 'FORMAT' | 'UNSUPPORTED' | 'COMPILE', message: string); readonly code: string }
  ```

Regole:
- Layout, lunghezze e relazioni come in mc7 §1.1–§1.7, verificati su 33 blocchi.
- `readBlockFile` non lancia mai su un blocco reale. Tutto ciò che non è strutturale si conserva grezzo.
- ADD strutturato: un'ADD che non si legge resta grezza, con `networks` e `jumps` vuoti.
- Il pacchetto dipende solo da `@baaportal/s7-types` e `@baaportal/awl`.

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('ogni blocco reale disponibile: writeBlockFile(readBlockFile(x)) identico', () => { /* 12 dalle catture + 21 scaricati se presenti */ });
  it('CRC: i vettori di mc7 §5.4 e i 23 blocchi attesi', () => { /* … */ });
  it('ADD dell\'OB1 reale: reti e salti come in mc7 §5.2', () => { /* … */ });
  it('header: know-how a 3 riconosciuto; tipo ignoto → kind undefined con kindCode', () => { /* … */ });
  it('5000 buffer casuali: solo Mc7Error o RangeError', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project mc7`
- [x] **Step 3: Implementa** il pacchetto, lo script esteso e il caricatore dei blocchi reali.
- [x] **Step 4: Esegui** `node scripts/fetch-s7-captures.mjs && npx vitest run --project mc7 && npm run typecheck && npm run lint`
- [x] **Step 5: Commit** — `feat(mc7): file di blocco S7-300 completo, ADD e CRC, provati su blocchi reali`

---

### Task 2: Interfaccia dei blocchi (SSB) e layout dei dati

**Files:**
- Create: `packages/mc7/src/{ssb.ts,layout.ts}`
- Test: `packages/mc7/test/{ssb,layout}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SsbSection = 'in' | 'out' | 'inOut' | 'stat' | 'temp' | 'ret';
  export interface SsbElement { name?: string; section: SsbSection; type: DataType; initial?: Uint8Array; children?: SsbElement[]; raw: Uint8Array }  // nomi assenti: l'MC7 non li contiene (mc7 §4)
  export interface SsbInterface { header: Uint8Array; elements: SsbElement[]; tail: Uint8Array }
  export function readSsb(ssb: Uint8Array, kind: BlockKind): SsbInterface;
  export function writeSsb(i: SsbInterface): Uint8Array;               // identico al byte con `raw` e `tail`
  export function buildSsb(sections: Record<SsbSection, TypedMember[]>, initials: Record<string, string>, kind: BlockKind): Uint8Array;  // per il compilatore
  export function dataLayout(i: SsbInterface): { size: number; offsets: { path: string; byte: number; bit?: number; type: DataType }[] };  // mc7 §1.4.8
  ```

Regole:
- Le righe sono descritte in mc7 §1.4.1–§1.4.7: tipi, ARRAY, STRUCT, STRING, multi-istanze, valori iniziali in little-endian, byte di riempimento.
- I flag sconosciuti si conservano in `raw`.
- `dataLayout` segue mc7 §1.4.8. Deve coincidere con la lunghezza reale su tutti i DB reali.

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('le 25 interfacce reali si leggono fino all\'ultimo byte e si riscrivono identiche', () => { /* … */ });
  it('dataLayout = lunghezza dei dati su tutti i DB globali e sul DB di istanza DB1806', () => { /* … */ });
  it('DB13 da 64 KB e ARRAY di STRUCT: layout e valori iniziali', () => { /* … */ });
  it('buildSsb da un\'interfaccia costruita a mano: readSsb dà gli stessi tipi e valori', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(mc7): interfaccia dei blocchi (SSB), valori iniziali e layout dei dati`

---

### Task 3: Tabella delle istruzioni MC7 e operandi

**Files:**
- Create: `packages/mc7/src/{opcodes.ts,operands.ts,constants.ts}`
- Test: `packages/mc7/test/{opcodes,operands}.test.ts`

**Interfaces:**
- Consumes: `INSTRUCTIONS` e `Operand` di `@baaportal/awl`.
- Produces:
  ```ts
  export interface Mc7Form { id: string; operand: 'none' | 'address' | 'indirect' | 'constant' | 'timerCounter' | 'block' | 'jump' | 'ar' | 'special'; bytes: number[]; mask?: number[]; length: number; verified: boolean }  // mc7 §2.6
  export const MC7_FORMS: readonly Mc7Form[];
  export function encodeInstruction(stmt: Statement): Uint8Array;               // senza salti: offset risolti dal Task 5
  export function decodeInstruction(code: Uint8Array, at: number): { stmt: DecodedStatement; length: number } | { raw: Uint8Array; length: number };
  export interface DecodedStatement { text: string; jumpTo?: number; constantType?: number }
  ```

Regole:
- Ogni `id` dei 155 di `INSTRUCTIONS` ha almeno una forma.
- Per ogni forma sono riportati la lunghezza (mc7 §2.7) e se è verificata su un blocco reale.
- Operandi: aree, bit, dimensioni e forme indirette (mc7 §2.2).
- Costanti (mc7 §2.3): il byte di tipo si conserva in `constantType` e si riproduce. Esempio: un REAL caricato da TIA come `L#` resta tale.
- Scelte canoniche: mc7 §3.3, cioè la forma corta dove esiste.
- I 6 disaccordi tra fonti (mc7 §6.2) si risolvono a favore della fonte confermata da un blocco reale. Se nessuna lo è, la forma resta `verified: false` e il rapporto la elenca.

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('ogni id di INSTRUCTIONS ha una forma in MC7_FORMS', () => { /* … */ });
  it('encode → decode → encode identico per ogni forma, con operandi di esempio', () => { /* … */ });
  it('le 901 sequenze distinte dei blocchi reali si decodificano e ricodificano identiche', () => { /* … */ });
  it('un opcode sconosciuto dà { raw } della lunghezza minima, mai un errore', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa** la tabella dai dati di mc7 §2.6, riscritti come struttura dati nostra.
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(mc7): tabella delle istruzioni MC7 e codifica degli operandi`

---

### Task 4: Decodificatore MC7 → AWL

**Files:**
- Create: `packages/mc7/src/decode.ts`
- Test: `packages/mc7/test/decode.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DecodedCode { networks: string[]; meta: CodeMeta }   // AWL internazionale canonico, una stringa per rete
  export interface CodeMeta { jumpOrder?: number[]; raws: { network: number; offset: number; bytes: string }[]; constantTypes: Record<string, number>; addRest?: string }
  export function decodeCode(mc7: Uint8Array, add: Mc7Add): DecodedCode;
  ```

Regole:
- **Reti** dall'ADD (mc7 §1.5). Senza ADD leggibile, una rete sola.
- **Etichette:** i salti diventano etichette generate `M001`, `M002`… in ordine di posizione, al massimo 4 caratteri (piano 1C).
- **Byte non riconosciuti:** si scrivono come istruzione grezza in una forma AWL nostra, `// MC7 grezzo: 70 0b` più un segnaposto ricodificabile. Il metadato `raws` permette la ricodifica identica.
- **Ricodifica identica:** tutto ciò che la serve e il testo non può portare va in `CodeMeta`. Esempi: l'ordine della tabella dei salti (FC100) e il resto dell'ADD (FB101).
- **CALL:** si decodificano come la sequenza vista nei blocchi reali (mc7 §2.5). Si ricostruisce `CALL` solo se la ricodifica dà gli stessi byte, altrimenti si lasciano le istruzioni espanse.

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('OB1 reale TIA: reti e istruzioni come in mc7 §5.2', () => { /* … */ });
  it('i 12 blocchi di codice reali: 0 byte persi, salti su etichette valide', () => { /* … */ });
  it('un opcode sconosciuto in mezzo a una rete: istruzione grezza e il resto decodificato', () => { /* … */ });
  it('il testo prodotto passa parseNetwork senza errori di sintassi', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(mc7): decodificatore MC7 → AWL con metadati di andata e ritorno`

---

### Task 5: Codificatore AWL → MC7 e andata e ritorno

**Files:**
- Create: `packages/mc7/src/encode.ts`
- Test: `packages/mc7/test/{encode,roundTrip}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function encodeCode(networks: string[], meta?: CodeMeta): { mc7: Uint8Array; add: Mc7Add; diagnostics: Mc7Diagnostic[] };
  export interface Mc7Diagnostic { severity: 'error' | 'warning'; code: string; network: number; line: number; message: string; params?: Record<string, string> }
  ```

Regole:
- I segmenti si analizzano con `parseNetwork` di `@baaportal/awl`, in internazionale.
- **Salti:** gli offset sono in parole dall'inizio del salto (mc7 §2.4) e si risolvono in due passate.
- **Tabella dei salti** dell'ADD: si ricostruisce. Con `meta.jumpOrder` si rispetta quell'ordine.
- **Errori di sintassi:** fermano la codifica. Danno un `error` con segmento e riga e nessun byte.
- **Istruzioni senza forma** (non dovrebbero esistere dopo il Task 3) danno `UNSUPPORTED`.

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('MC7 → AWL → MC7 identico al byte sui 12 blocchi di codice reali (ADD compresa)', () => { /* criterio del 1E */ });
  it('un salto in avanti e uno all\'indietro tra segmenti: offset giusti', () => { /* … */ });
  it('codice con un errore di sintassi: nessun byte, errore con segmento e riga', () => { /* … */ });
  it('blocco TIA con rete vuota finale e FB41 SCL: identici al byte', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(mc7): codificatore AWL → MC7, identico al byte sui blocchi reali`

---

### Task 6: Blocchi completi: decodifica e ricodifica di OB, FB, FC, DB e DB di istanza

**Files:**
- Create: `packages/mc7/src/block.ts`
- Test: `packages/mc7/test/block.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Mc7Block {
    kind: BlockKind; number: number; language: number; knowHowProtected: boolean;
    header: { author: string; family: string; name: string; version: string };
    iface: SsbInterface; networks?: string[]; data?: Uint8Array;      // data: valori attuali di un DB
    meta: BlockMeta;                                                   // tutto ciò che serve a ricodificare identico
  }
  export interface BlockMeta { headerRaw: string; ssbRaw?: string; code?: CodeMeta; checksum: number; footerRaw: string; times: { code: string; iface: string } }
  export function decodeBlock(file: Uint8Array): Mc7Block;
  export function encodeBlock(b: Mc7Block): Uint8Array;                // encodeBlock(decodeBlock(x)) === x per OB/FB/FC/DB
  ```

Regole:
- **Checksum:** si conserva quello originale se codice e dati non sono cambiati. Altrimenti si ricalcola (mc7 §1.7).
- **DB:** valori attuali e iniziali come in mc7 §1.9.
- **DB di istanza:** il legame con l'FB come in mc7 §1.9.
- **SDB:** restano opachi, con `Mc7Error('UNSUPPORTED')` se si prova a decodificarne il contenuto (mc7 §1.11).

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('encodeBlock(decodeBlock(x)) identico per i 25 blocchi reali di codice e DB', () => { /* … */ });
  it('cambiare una costante nell\'AWL ricalcola il checksum come blockChecksum', () => { /* … */ });
  it('blocco know-how protetto: decodificato, flag conservato', () => { /* FB41, FB80 */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(mc7): blocchi completi OB/FB/FC/DB, andata e ritorno al byte`

---

### Task 7: Compilatore dei blocchi del progetto

**Files:**
- Create: `packages/mc7/src/compile.ts`, `packages/mc7/src/callExpand.ts`, `packages/mc7/src/localData.ts`
- Test: `packages/mc7/test/compile.test.ts`

**Interfaces:**
- Consumes: `checkBlockCode` e `AwlContext` di `@baaportal/awl`.
- Produces:
  ```ts
  export interface CompileInput { kind: 'OB' | 'FB' | 'FC' | 'DB' | 'IDB'; number: number; knowHowProtected: boolean; header: { author: string; family: string; name: string; version: string }; sections: Record<SsbSection, TypedMember[]>; initials: Record<string, string>; networks: string[]; ctx: AwlContext; instanceOf?: { kind: 'FB' | 'SFB'; number: number; sections: Record<SsbSection, TypedMember[]> }; now: Date }
  export function compileBlock(i: CompileInput): { file?: Uint8Array; diagnostics: Mc7Diagnostic[] };
  ```

Regole:
- **Errori:** prima `checkBlockCode` del piano 1C. Con errori nessun file; gli avvisi restano.
- **CALL:** si espande secondo gli schemi visti nei blocchi reali (mc7 §2.5). Il risultato deve essere **equivalente**: stessi parametri, stesso DB di istanza, stessa semantica. Non è richiesto che sia identico a STEP 7, perché nessuna fonte ne documenta le regole (mc7 §6.3). Ogni forma di CALL non coperta da un esempio reale dà un `warning` `CALL_NON_VERIFICATO`.
- **Dati locali:** la lunghezza segue mc7 §1.2/§6.3. Per le parti non documentate si usa la regola conservativa del documento, e la si segnala con un commento nel codice.
- **Blocchi chiamati per nome:** il numero si risolve con `ctx.block()`.
- **Timestamp:** da `now`, nel formato del blocco.
- Header e footer vengono da `header`. Il checksum si calcola con `blockChecksum`.

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('FC senza CALL compilato: decodeBlock dà lo stesso AWL (forma canonica) e la stessa interfaccia', () => { /* … */ });
  it('FB con multi-istanza e CALL di FC: equivalente ai blocchi reali dello stesso schema', () => { /* … */ });
  it('DB globale e DB di istanza: dati = layout dei valori iniziali', () => { /* … */ });
  it('codice con errori: nessun file, errori con segmento e riga', () => { /* … */ });
  it('readBlockFile di @baaportal/mc7 e parseBlockFile di @baaportal/s7comm accettano ogni file compilato', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(mc7): compilazione dei blocchi AWL del progetto`

---

### Task 8: Progetto: compilazione, importazione ed esportazione dei blocchi

**Files:**
- Create: `packages/project/src/mc7Bridge.ts`
- Modify: `packages/project/src/{model.ts,index.ts}` (campo facoltativo `mc7?: BlockMeta` su blocchi di codice e DB), `packages/project/package.json` (dipendenza `@baaportal/mc7`)
- Test: `packages/project/test/mc7Bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function compileDevice(device: PlcDevice, cpu: CpuType | undefined, only?: string[], now?: Date): { results: { blockId: string; file?: Uint8Array; diagnostics: Mc7Diagnostic[] }[] };
  export function blockFromMc7(device: PlcDevice, file: Uint8Array, newId: NewId): { block: Block; warnings: string[] };   // nomi dei membri generati come TIA: IN0, OUT0, STAT0… (mc7 §4)
  export function planImport(device: PlcDevice, files: Uint8Array[]): { create: Block[]; replace: { existing: Block; incoming: Block }[]; skipped: { reason: string }[] };
  export function applyImport(device: PlcDevice, plan: ReturnType<typeof planImport>): void;   // dentro un solo edit
  export function blockToMc7File(block: Block, device: PlcDevice, cpu: CpuType | undefined, now?: Date): { file?: Uint8Array; diagnostics: Mc7Diagnostic[] };  // con meta: identico al blocco importato se non modificato
  ```

Regole:
- **Importazione** da file `.blk` o dallo zip del kit (`readKitZip` di `@baaportal/s7comm`, cartella `blocchi/`):
  - OB, FB e FC diventano blocchi **AWL**, con le reti decodificate;
  - i DB diventano DB globali, con membri e valori iniziali e attuali dal layout. I nomi dei membri non sono nel blocco: si generano;
  - i DB di istanza diventano IDB dell'FB con quel numero, se c'è;
  - gli SDB si saltano, con un motivo.
- **Blocco già esistente** con lo stesso tipo e numero: va in `replace`. La conferma la chiede l'interfaccia.
- **Metadati di andata e ritorno:** si salvano nel campo `mc7` del blocco. `blockToMc7File` di un blocco importato e non modificato restituisce i byte originali.
- **`compileDevice`:**
  - compila tutti i blocchi AWL, o solo quelli in `only`;
  - gli UDT si espandono in STRUCT (mc7 §1.10);
  - i blocchi KOP, FUP e SCL danno l'errore "linguaggio non ancora compilabile".

- [x] **Step 1: Scrivi i test che falliscono**
  ```ts
  it('importa lo zip del kit prodotto dal finto PLC: blocchi AWL e DB nel dispositivo', () => { /* s7-server FakeCpu + collect */ });
  it('blocco importato e non modificato: blockToMc7File identico al file originale', () => { /* blocchi reali */ });
  it('importare un OB1 che esiste: replace, nessuna modifica prima di applyImport', () => { /* … */ });
  it('compileDevice: un blocco con errori non impedisce agli altri di compilare', () => { /* … */ });
  it('salva e riapri il progetto: il campo mc7 sopravvive', () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui test, typecheck e lint**
- [x] **Step 5: Commit** — `feat(project): compilazione, importazione ed esportazione dei blocchi MC7`

---

### Task 9: Interfaccia: *Compila*, *Informazioni → Compila* e importazione dei blocchi

**Files:**
- Create: `packages/ui/src/project/compile/{compileActions.ts,CompileMessages.tsx}`
- Modify:
  - `packages/ui/src/project/menuModel.ts`;
  - la barra degli strumenti;
  - il menu contestuale di PLC, "Blocchi di programma" e blocchi;
  - `packages/ui/src/project/inspector/InfoMessages.tsx` (scheda *Compila*);
  - `packages/ui/src/i18n/{it,en}.json`.
- Test: `packages/ui/test/{compileActions,importBlocks}.test.tsx`

Regole:
- ***Compila → Software (solo modifiche)*** compila i blocchi cambiati dall'ultima compilazione della sessione. Il confronto usa un'impronta del contenuto, tenuta in memoria.
- ***Compila → Software (compilazione completa)*** compila tutto.
- Entrambe sono disponibili sul PLC e sulla cartella "Blocchi di programma". Su un blocco solo c'è *Compila*.
- **Scheda *Compila* di *Informazioni*:**
  - una riga per blocco, con esito ✓ / avvisi / errori;
  - sotto, i messaggi con segmento e riga. Un clic apre l'editor del blocco nel punto, come i "Problemi" del piano 1C.
  - In fondo il riepilogo, per esempio "Compilazione terminata: 5 blocchi, 0 errori, 2 avvisi".
- **Importa blocchi** (*Blocchi di programma*: "Importa blocchi (.blk o raccolta del kit)…"):
  - dialogo file con filtri `.blk` e `.zip`, più file insieme;
  - `planImport`;
  - conferma con l'elenco dei blocchi da sostituire;
  - `applyImport` in un solo `edit`;
  - riepilogo in *Informazioni → Generale*.
- **Esporta blocco compilato (.blk)…** sul blocco: compila e salva il file con il dialogo, per ispezione e confronto.
- **Know-how:** un blocco protetto si compila con il flag. L'editor lo mostra in sola lettura solo se era stato importato protetto (comportamento esistente del piano 1B).

- [x] **Step 1: Scrivi i test che falliscono** (jsdom e FakeBridge)
  ```ts
  it('Compila solo modifiche: ricompila solo il blocco cambiato', async () => { /* … */ });
  it('errori in Informazioni → Compila con clic che apre il punto', async () => { /* … */ });
  it('Importa blocchi: due .blk, uno sostituisce dopo conferma, un passo di annulla', async () => { /* … */ });
  it('Esporta blocco compilato: file scritto con writeFileAtomic', async () => { /* … */ });
  ```
- [x] **Step 2: Esegui e verifica che falliscano**
- [x] **Step 3: Implementa**
- [x] **Step 4: Esegui** `npm test && npm run e2e && npm run typecheck && npm run lint`
- [x] **Step 5: Commit** — `feat(ui): Compila, Informazioni → Compila e importazione dei blocchi MC7`

---

### Task 10: Prove end-to-end, piano generale e versione

**Files:**
- Create: `apps/desktop/e2e/mc7.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, `apps/desktop/package.json` (versione `0.3.0`), questo piano (caselle)

Prove:
1. Lo zip di un kit prodotto dal finto PLC si importa. I blocchi compaiono in AWL e l'esportazione dei blocchi non modificati dà i byte originali.
2. Un FC scritto in BaaPortal si compila senza errori. Un errore apposta appare in *Informazioni → Compila* e il clic porta al punto.
3. *Compila solo modifiche* dopo una modifica ricompila un blocco solo.

Regole:
- **Piano generale:**
  - riga 1E: "Fatto quando" diventa "andata e ritorno MC7 → AWL → MC7 identica al byte sui blocchi reali disponibili; compilazione dei blocchi AWL del progetto; importazione dei blocchi del kit";
  - le prove di conformità diventano un piano della tappa 2 sul simulatore, finché il 1D-bis resta aperto;
  - aggiungere il piano 1E all'elenco come chiuso.
- **Collaudo:** `node scripts/fetch-s7-captures.mjs && npm test && for i in 1 2 3; do npm run e2e || break; done && npm run typecheck && npm run lint && npm run format:check` verde 3 volte su 3.

- [x] **Step 1: Scrivi le prove e correggi quello che trovano** (ogni correzione di logica con il suo test)
- [x] **Step 2: Aggiorna piano generale e versione**
- [x] **Step 3: Esegui il collaudo tre volte**
- [x] **Step 4: Commit** — `test(e2e): blocchi MC7, compilazione e importazione; piano 1E chiuso; versione 0.3.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Il criterio al byte è MC7 → AWL → MC7.** Compilare dal sorgente in modo identico a STEP 7 non è verificabile: nessuna fonte documenta CALL e dati locali (mc7 §6.3). Se fosse sbagliato, si aggiunge il criterio quando arrivano blocchi e sorgenti abbinati.
- **R2. I metadati di andata e ritorno stanno nel blocco** (campo `mc7`), non nel testo AWL. Il testo resta leggibile. Se fosse sbagliato, un blocco importato e poi riscritto a mano perde l'identità al byte, cosa attesa.
- **R3. Le prove di conformità vanno alla tappa 2 (simulatore)** finché il 1D-bis è aperto. Se fosse sbagliato, si anticipano quando c'è un altro modo di eseguirle.
- **R4. I blocchi di terzi** (LGPL) **si scaricano** al momento dei test e non entrano mai nel repository. Se fosse sbagliato, nessun costo.
- **R5. I nomi dei membri dei blocchi importati sono generati**, perché l'MC7 non contiene simboli (mc7 §4). Se fosse sbagliato, si recuperano importando sorgenti o tabelle (piani 1C e 7C).
