# Piano 1F — Completamento della tappa 1 — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** chiudere le funzioni della tappa 1 ancora mancanti o segnaposto: importazione/esportazione delle tabelle variabili (xlsx/csv), archivia/ritira archivio (`.baapz`), progetti di riferimento, trova e sostituisci, _Opzioni → Impostazioni_, barra di stato con avanzamento, e il collaudo finale della tappa con i criteri "Fatto quando" della spec.

**Architettura:**
- La logica pura sta nei pacchetti, testabile da sola: i codec delle tabelle variabili (csv e xlsx) in `@baaportal/importers`; l'archivio `.baapz` in `@baaportal/project` accanto a `baapFile.ts`; il motore di ricerca/sostituzione in `@baaportal/ui/src/search/` (lavora sul modello di progetto, senza React).
- L'interfaccia collega la logica con gli schemi già in uso: comandi nel registro `commands.ts` e nel menu `menuModel.ts`, dialoghi di file tramite il `BaaBridge` esistente (`showOpenFileDialog`/`showSaveFileDialog`/`readFile`/`writeFileAtomic`), modifiche al progetto **sempre** con `store.edit(labelKey, recipe)` così annulla/ripeti funziona, messaggi con `pushMessage`.
- Nessuna nuova dipendenza di runtime: xlsx e csv si scrivono su `fflate`, già presente.

**Tecnologie:** TypeScript, React, CodeMirror 6, i18next, fflate, Vitest (jsdom per `ui`), Playwright (`apps/desktop/e2e`).

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md` (§8.1–8.2 interfaccia, §8.5 scorciatoie, §9 Tappa 1 e "Fatto quando", §7 moduli). Piano generale: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md` (riga 1F). Limiti: `docs/limiti-noti.md`.

## Global Constraints

- **Lingua:** ogni testo visibile è in italiano e in inglese: chiavi in `packages/ui/src/i18n/it.json` **e** `en.json`, mai stringhe nel codice. Nomi delle funzioni come in spec §8 ("Archivia", "Ritira archivio", "Progetti di riferimento", "Trova e sostituisci", "Impostazioni").
- **Clean-room** (spec §5): i formati compatibili con TIA Portal si ricavano solo dalla documentazione pubblica; nessuna analisi di software Siemens.
- **Nessuna nuova dipendenza di runtime.** xlsx = zip OOXML scritto/letto con `fflate`; csv a mano.
- **Annulla/ripeti:** ogni modifica al progetto (importazione, incolla da progetto di riferimento, sostituzione) passa da **un solo** `store.edit(...)` per operazione utente, così un Ctrl+Z la annulla per intero.
- **File system solo nel processo principale** (spec §7), tramite il bridge esistente. Nuovo IPC solo se indispensabile, con la stessa guardia di frame fidato di `ipc.ts`.
- **Windows e macOS** (lezioni 1A–1E): niente `fs.cpSync`; percorsi normalizzati con `replaceAll('\\','/')`; timeout espliciti di 30 s e soglie larghe nei test di tempo; `.gitattributes` impone LF.
- **Nessun dato reale nel repository** (repo pubblico): i file di prova xlsx/csv si costruiscono nei test o sono scritti da noi.
- **Nessuna funzione di questo piano parla con un PLC.** La conformità su CPU reale resta in sospeso (`docs/limiti-noti.md`, spec §11).
- **Versione:** 0.5.0.

## Review Focus

1. **File da Excel e da TIA Portal, non solo i nostri.** Un csv salvato da Excel italiano usa `;`, ha il BOM UTF-8, righe CRLF, campi tra virgolette con `;` o a capo, righe vuote in fondo; un xlsx può avere stringhe condivise, stringhe in linea, celle numeriche (un indirizzo `10`), testo ricco. Atteso: si legge giusto, oppure errore chiaro **per riga**. Mai dati storpiati in silenzio. → Task 1, Task 2.
2. **Importazione in una tabella che ha già dei nomi.** Nomi già presenti, nomi doppi nel file, tipi o indirizzi non validi. Atteso: un riepilogo chiaro (creati / aggiornati / scartati con motivo) e un solo Ctrl+Z che ripristina la tabella esattamente com'era. → Task 3.
3. **Ritira archivio su un file che esiste già, o da un archivio rotto o più nuovo.** Atteso: conferma prima di sovrascrivere, errore chiaro con codice, nessun file mezzo scritto. → Task 4.
4. **Trova e sostituisci con la mnemonica tedesca.** Il testo delle reti è salvato in mnemonica internazionale, ma l'utente vede e cerca in quella scelta (es. `U` invece di `A`). Contano anche i blocchi protetti e le reti "MC7 grezzo", i caratteri speciali in una ricerca letterale, e un "sostituisci tutto" su molti blocchi. Atteso: si cerca nel testo come lo vede l'utente; i blocchi protetti e le reti grezze si saltano; tutto si annulla con un solo Ctrl+Z. → Task 6, Task 7.
5. **Incolla da un progetto di riferimento in conflitto.** Il riferimento è lo stesso file del progetto aperto, oppure il blocco incollato ha lo stesso numero o nome di uno già presente. Atteso: si apre comunque in sola lettura, il conflitto si risolve come nell'incolla esistente (`pasteObjects`), il riferimento non cambia mai. → Task 5.

---

### Task 1: `@baaportal/importers`: codec csv delle tabelle variabili

**Files:**
- Create: `packages/importers/src/tags/columns.ts`, `packages/importers/src/tags/csv.ts`, `packages/importers/src/tags/rows.ts`
- Modify: `packages/importers/src/index.ts` (riesporta)
- Test: `packages/importers/test/tagsCsv.test.ts`

**Interfaces:**
- Consumes: `Tag`, `UserConstant`, `TagTable` di `@baaportal/project`; il controllo di tipo e indirizzo già usato dall'editor delle tabelle (cercarlo in `@baaportal/s7-types` / `packages/ui/src/editors/tags/`; se vive solo in `ui`, spostare in un pacchetto la parte pura che serve, senza duplicarla).
- Produces:
  ```ts
  // colonne compatibili con l'esportazione delle variabili PLC di TIA Portal (documentazione pubblica)
  export const TAG_COLUMNS: readonly ['Name','Path','Data Type','Logical Address','Comment','Hmi Visible','Hmi Accessible','Hmi Writeable'];
  export const CONSTANT_COLUMNS: readonly ['Name','Path','Data Type','Value','Comment'];
  export interface TagRow { line: number; name: string; path: string; type: string; address: string; comment: string; hmi: boolean }
  export interface ConstantRow { line: number; name: string; path: string; type: string; value: string; comment: string }
  export interface RowError { line: number; code: string; detail?: string }   // codici: COLONNA_MANCANTE, TIPO_NON_VALIDO, INDIRIZZO_NON_VALIDO, NOME_VUOTO, NOME_DOPPIO, RIGA_ILLEGGIBILE
  export interface ParsedTags { tags: TagRow[]; constants: ConstantRow[]; errors: RowError[] }
  export function parseTagsCsv(text: string): ParsedTags;            // solo variabili (il csv ha un solo foglio)
  export function tagsToCsv(table: TagTable): string;               // BOM UTF-8 + separatore ';' + CRLF
  export function toLogicalAddress(address: string): string;       // formato progetto → '%I0.0', '%MW10'
  export function fromLogicalAddress(text: string): string;        // inverso; accetta con e senza '%'
  ```

Regole:
- Esportazione: intestazione = `TAG_COLUMNS`, separatore `;` (Excel italiano), BOM UTF-8, CRLF, virgolette RFC 4180 dove servono. `Path` = nome della tabella. I tre `Hmi …` = `tag.hmi` (`True`/`False`).
- Importazione: rileva da sola il separatore (`;`, `,`, tabulazione) dalla riga d'intestazione; accetta BOM e CRLF/LF; campi tra virgolette con separatori e a capo; ignora righe vuote; colonne riconosciute per **nome** (ordine libero, maiuscole/minuscole indifferenti); colonne in più (es. `Typeobject ID`, `Version ID`) ignorate. `hmi` = `Hmi Accessible`. Una riga non valida finisce in `errors` con il suo numero di riga e **non** blocca le altre.
- `line` = numero di riga nel file (1 = intestazione), per i messaggi.

- [x] **Step 1: Scrivi i test che falliscono** (`tagsCsv.test.ts`)
  - `it('tagsToCsv: BOM, intestazione TAG_COLUMNS, separatore ";", CRLF, indirizzo %MW10')`
  - `it('roundtrip tagsToCsv → parseTagsCsv su BOOL/INT/REAL/WORD con commenti contenenti ";" e virgolette')`
  - `it('csv di Excel con "," e LF, colonne in ordine diverso e "Typeobject ID" in più → letto giusto')`
  - `it('campo tra virgolette con a capo dentro → un solo tag, commento con a capo')`
  - `it('riga con tipo "PIPPO" → errors [{line:3, code:"TIPO_NON_VALIDO"}], le altre righe importate')`
  - `it('intestazione senza "Logical Address" → errors [{line:1, code:"COLONNA_MANCANTE"}], nessun tag')`
  - `it('nomi doppi nel file → secondo in errors con NOME_DOPPIO')`
  - `it('fromLogicalAddress accetta "%M0.1" e "M0.1"; toLogicalAddress(fromLogicalAddress(x)) === x')`
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project importers`, atteso FAIL.
- [x] **Step 3: Implementa** `columns.ts`, `csv.ts`, `rows.ts`; riesporta.
- [x] **Step 4: Test, typecheck, lint, formato** — `npx vitest run --project importers && npm run typecheck && npm run lint && npm run format:check`, atteso PASS.
- [x] **Step 5: Commit** — `feat(importers): tabelle variabili in csv`

---

### Task 2: `@baaportal/importers`: codec xlsx delle tabelle variabili

**Files:**
- Create: `packages/importers/src/tags/xlsx.ts`, `packages/importers/src/xlsx/ooxml.ts` (lettura/scrittura minima di un foglio)
- Modify: `packages/importers/package.json` (dipendenza `fflate` se manca, stessa versione `^0.8.3`), `packages/importers/src/index.ts`
- Test: `packages/importers/test/tagsXlsx.test.ts`, `packages/importers/test/ooxml.test.ts`

**Interfaces:**
- Consumes: `TAG_COLUMNS`, `CONSTANT_COLUMNS`, `TagRow`, `ConstantRow`, `RowError`, `ParsedTags`, `toLogicalAddress`, `fromLogicalAddress` (Task 1).
- Produces:
  ```ts
  export interface Sheet { name: string; rows: string[][] }               // celle già come testo
  export function writeXlsx(sheets: Sheet[]): Uint8Array;                 // ooxml.ts
  export function readXlsx(bytes: Uint8Array): Sheet[];                   // ooxml.ts; XlsxFormatError con code
  export class XlsxFormatError extends Error { code: 'NON_ZIP' | 'NON_XLSX' | 'FOGLIO_ILLEGGIBILE' }
  export function tagsToXlsx(table: TagTable): Uint8Array;               // fogli "PLC Tags" e "User Constants"
  export function parseTagsXlsx(bytes: Uint8Array): ParsedTags;         // accetta anche il foglio "Constants"
  ```

Regole:
- Scrittura: workbook minimo valido (`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheetN.xml`, `xl/styles.xml` minimo), celle come **stringhe in linea** (`t="inlineStr"`), testo con escape XML. Deve aprirsi in Excel e LibreOffice senza avvisi di riparazione (verifica manuale nella lista di controllo del Task 10).
- Lettura: stringhe condivise (`xl/sharedStrings.xml`, compreso testo ricco `<r><t>`), stringhe in linea, numeri (resi come testo senza `.0` finale per gli interi), booleani (`t="b"` → `True`/`False`), celle saltate (riferimento `r="C5"` → colonne vuote in mezzo), fogli trovati tramite `workbook.xml` + relazioni, non per nome di file. Un parser XML minimo dentro `ooxml.ts` (niente DOMParser: il pacchetto gira in node); entità `&amp; &lt; &gt; &quot; &apos;` e `&#…;`.
- `parseTagsXlsx` riusa le stesse regole di riga del Task 1 (nessuna logica copiata): `ooxml` dà righe di testo, `rows.ts` le valida.

- [x] **Step 1: Scrivi i test che falliscono**
  - `ooxml.test.ts`: `it('writeXlsx → readXlsx roundtrip con <, &, accenti, a capo')`; `it('legge sharedStrings con testo ricco e celle numeriche 10 / 2.5 / booleane')`; `it('celle saltate (A1, C1) → riga ["x","","z"]')`; `it('byte non zip → XlsxFormatError NON_ZIP; zip senza workbook → NON_XLSX')`. Il caso con stringhe condivise si costruisce nel test con `fflate.zipSync` e XML scritto a mano.
  - `tagsXlsx.test.ts`: `it('tagsToXlsx → parseTagsXlsx roundtrip variabili e costanti')`; `it('foglio "Constants" accettato come "User Constants"')`; `it('riga con indirizzo non valido → errore per riga, altre importate')`.
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project importers`.
- [x] **Step 3: Implementa** `ooxml.ts` e `xlsx.ts`.
- [x] **Step 4: Test, typecheck, lint, formato** — come Task 1.
- [x] **Step 5: Commit** — `feat(importers): tabelle variabili in xlsx (OOXML minimo su fflate)`

---

### Task 3: Interfaccia: importa/esporta tabelle variabili

**Files:**
- Create: `packages/ui/src/project/navigation/tagTableIo.ts`, `packages/ui/src/dialogs/ImportTagsReport.tsx`
- Modify: `packages/ui/src/commands.ts`, `packages/ui/src/menuModel.ts` (e il menu contestuale dell'albero dove stanno le azioni delle tabelle variabili), `packages/ui/src/App.tsx` (render del dialogo), `packages/ui/src/i18n/it.json`, `en.json`
- Test: `packages/ui/test/tagTableIo.test.tsx`

**Interfaces:**
- Consumes: `parseTagsCsv`, `tagsToCsv`, `parseTagsXlsx`, `tagsToXlsx`, `ParsedTags` (Task 1–2); schema di `sourceActions.ts` per dialoghi e scrittura; `store.edit`; `DialogState` come `KitDialog`.
- Produces:
  ```ts
  export function exportTagTable(ref: { deviceId: string; id: string }, format: 'xlsx' | 'csv'): Promise<void>;
  export function importTagTable(target: { deviceId: string; tableId?: string }): Promise<void>;  // tableId assente → nuova tabella col nome del file
  export interface ImportSummary { created: number; updated: number; skipped: RowError[] }
  export function applyTagImport(table: TagTable, parsed: ParsedTags): { table: TagTable; summary: ImportSummary };  // pura
  ```

Regole:
- Comandi: "Esporta…" ed "Importa…" nel menu contestuale di una tabella delle variabili e di "Variabili PLC"; il formato si sceglie dal filtro del dialogo (`.xlsx`, `.csv`), dedotto dall'estensione.
- `applyTagImport`: un nome già presente nella tabella → aggiornato (tipo, indirizzo, commento, hmi), l'`id` resta; nome nuovo → creato con `id` nuovo; righe con errori → saltate e riportate. Dopo l'importazione si esegue il controllo esistente di indirizzi sovrapposti, i cui avvisi compaiono come al solito.
- L'importazione è **un solo** `store.edit('edit.importTags', …)`. Alla fine si apre `ImportTagsReport` con creati / aggiornati / scartati (riga + motivo tradotto) e un messaggio in *Informazioni*.
- Errore di formato (`XlsxFormatError`, testo illeggibile) → messaggio chiaro, progetto invariato.

- [x] **Step 1: Scrivi i test che falliscono** (`tagTableIo.test.tsx`, con `renderApp()` e `FakeBridge`)
  - `it('applyTagImport: nome esistente aggiornato con stesso id, nome nuovo creato, riga errata in skipped')`
  - `it('importa csv da menu contestuale → tag nella tabella; un Ctrl+Z ripristina la tabella identica')`
  - `it('esporta xlsx → i byte scritti su FakeBridge si rileggono con parseTagsXlsx uguali alla tabella')`
  - `it('importa un file non xlsx con estensione .xlsx → messaggio d\'errore, progetto invariato')`
  - `it('il riepilogo mostra 2 creati, 1 aggiornato, 1 scartato con motivo')`
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project ui -t "tagTableIo|applyTagImport"`.
- [x] **Step 3: Implementa** comandi, azioni, dialogo, testi.
- [x] **Step 4: Test, typecheck, lint, formato** — `npx vitest run --project ui && npm run typecheck && npm run lint && npm run format:check`.
- [x] **Step 5: Commit** — `feat(ui): importa ed esporta tabelle variabili in xlsx e csv`

---

### Task 4: Archivia / Ritira archivio (`.baapz`)

**Files:**
- Create: `packages/project/src/baapzFile.ts`
- Modify: `packages/project/src/index.ts`, `packages/ui/src/services/projectService.ts`, `packages/ui/src/commands.ts` (attiva `project.archive` e `project.retrieve`), `packages/ui/src/i18n/it.json`, `en.json`; nel processo principale, solo se i filtri dei dialoghi lo richiedono, `apps/desktop/src/…` (dialogo cartella già esistente)
- Test: `packages/project/test/baapzFile.test.ts`, `packages/ui/test/archive.test.tsx`

**Interfaces:**
- Consumes: `writeBaap`, `readBaap`, `BaapFormatError` di `baapFile.ts`; `saveAs` di `projectService.ts` come modello.
- Produces:
  ```ts
  export const BAAPZ_FORMAT_VERSION = 1;
  export interface BaapzManifest { formatVersion: 1; appVersion: string; createdAt: string; projectFileName: string }
  export function writeBaapz(project: Project, o: { appVersion: string; projectFileName: string; now?: Date }): Uint8Array;
  export function readBaapz(bytes: Uint8Array): { manifest: BaapzManifest; baap: Uint8Array };   // BaapzFormatError
  export class BaapzFormatError extends Error { code: 'NON_ZIP' | 'MANIFESTO_MANCANTE' | 'VERSIONE_FUTURA' | 'PROGETTO_MANCANTE' | 'PROGETTO_ILLEGGIBILE' }
  ```

Regole:
- `.baapz` = zip (fflate, compressione massima) con `manifest.json` e il file `<projectFileName>` (un `.baap` completo scritto da `writeBaap`). `readBaapz` controlla il manifesto, rifiuta `formatVersion` più grande di `BAAPZ_FORMAT_VERSION` (`VERSIONE_FUTURA`) e verifica con `readBaap` che il progetto interno si legga (`PROGETTO_ILLEGGIBILE`, con il codice originale nel `detail`).
- **Archivia** (Progetto → Archivia…): richiede un progetto aperto. Se ci sono modifiche non salvate, chiede di salvare prima (stessa domanda della chiusura). Propone `<nome progetto>_<AAAAMMGG_hhmm>.baapz`. Il file si scrive in modo atomico.
- **Ritira archivio** (Progetto → Ritira archivio…): sceglie un `.baapz`, poi la cartella di destinazione. Se `<cartella>/<projectFileName>` esiste già, chiede conferma prima di sovrascrivere; senza conferma non scrive niente. Scrive il `.baap` in modo atomico e lo apre come "Apri progetto" (progetti recenti compresi). Un errore lascia la cartella invariata.

- [x] **Step 1: Scrivi i test che falliscono**
  - `baapzFile.test.ts`: `it('writeBaapz → readBaapz: manifesto e progetto identico a readBaap(writeBaap(p))')`; `it('formatVersion 2 → VERSIONE_FUTURA')`; `it('zip senza manifest.json → MANIFESTO_MANCANTE')`; `it('baap interno rotto → PROGETTO_ILLEGGIBILE con detail = codice originale')`.
  - `archive.test.tsx`: `it('Archivia scrive un .baapz col nome proposto <nome>_<data>.baapz')`; `it('Ritira su file esistente: annulla la conferma → nessuna scrittura')`; `it('Ritira apre il progetto e lo aggiunge ai recenti')`; `it('archivio rotto → messaggio con codice, nessun file scritto')`.
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project project --project ui -t "baapz|Archivia|Ritira"`.
- [x] **Step 3: Implementa** `baapzFile.ts` e i due comandi.
- [x] **Step 4: Test, typecheck, lint, formato**
- [x] **Step 5: Commit** — `feat(project,ui): archivia e ritira archivio (.baapz)`

---

### Task 5: Progetti di riferimento

**Files:**
- Create: `packages/ui/src/project/reference/referenceStore.ts`, `packages/ui/src/project/reference/ReferenceTree.tsx`
- Modify: `packages/ui/src/project/ReferenceProjects.tsx` (oggi segnaposto), `packages/ui/src/commands.ts` + `menuModel.ts` (Progetto → Apri progetto di riferimento…, chiudi dal pannello), `packages/ui/src/services/clipboard.ts` / `objectCommands.ts` (copia da un documento diverso da quello aperto), `i18n/it.json`, `en.json`
- Test: `packages/ui/test/referenceProjects.test.tsx`

**Interfaces:**
- Consumes: `readBaap`; `buildTree` dell'albero di navigazione; `copyNodes`/`pasteAt`/`pasteObjects` e `ClipboardPayload` esistenti.
- Produces:
  ```ts
  export interface ReferenceProject { key: string; path: string; doc: Project }      // key unico, sola lettura
  export function openReference(path: string): Promise<void>;                         // aggiunge alla lista; stesso path già aperto → lo porta in vista
  export function closeReference(key: string): void;
  export function useReferences(): ReferenceProject[];
  export function copyFromReference(key: string, nodeIds: string[]): void;            // riempie ClipboardPayload {kind:'objects',…}
  ```

Regole:
- Il pannello "Progetti di riferimento" (§8.2 punto 5) mostra un albero per ogni riferimento aperto (più di uno ammesso), con nome e percorso e un pulsante di chiusura. L'albero è in **sola lettura**: niente rinomina, elimina, incolla, trascina dentro, né comandi che lo modificano (devono risultare disattivati, non solo ignorati).
- Si può **copiare** (Ctrl+C, menu contestuale) e **trascinare** blocchi, UDT e tabelle variabili dal riferimento nel progetto aperto. L'incolla usa il percorso esistente `pasteObjects`, con la sua gestione dei conflitti di nome e numero, ed è un solo `store.edit`.
- Il riferimento si legge una volta da disco. Il documento in memoria non si modifica mai e non si salva mai. Aprire come riferimento lo stesso file del progetto aperto è permesso: è una copia separata.
- Doppio clic su un oggetto del riferimento: per ora nessun editor. Si mostra un messaggio "solo copia" e il fatto va nei limiti noti (Task 10).
- Gli id dei nodi del riferimento sono qualificati con `key`, così non collidono con quelli del progetto aperto.

- [x] **Step 1: Scrivi i test che falliscono** (`referenceProjects.test.tsx`)
  - `it('apri riferimento → albero nel pannello con nome e percorso; chiudi → sparisce')`
  - `it('rinomina/elimina/incolla disattivati sui nodi del riferimento')`
  - `it('copia FC1 dal riferimento e incolla nel progetto → FC compare; un Ctrl+Z lo toglie; riferimento invariato')`
  - `it('incolla FC1 in un progetto che ha già FC1 → stesso esito di pasteObjects (rinumera/rinomina)')`
  - `it('riferimento = stesso file del progetto aperto → si apre, modifiche al progetto non toccano il riferimento')`
  - `it('file non .baap valido → messaggio con codice BaapFormatError, nessun riferimento aggiunto')`
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project ui -t "riferimento|reference"`.
- [x] **Step 3: Implementa** store, albero, comandi e copia tra documenti.
- [x] **Step 4: Test, typecheck, lint, formato**
- [x] **Step 5: Commit** — `feat(ui): progetti di riferimento in sola lettura, con copia nel progetto`

---

### Task 6: Motore di ricerca e sostituzione

**Files:**
- Create: `packages/ui/src/search/findInProject.ts`, `packages/ui/src/search/replaceInProject.ts`, `packages/ui/src/search/types.ts`
- Test: `packages/ui/test/search/findInProject.test.ts`, `packages/ui/test/search/replaceInProject.test.ts`

**Interfaces:**
- Consumes: il modello `Project`; la conversione di mnemonica di `packages/awl/src/mnemonics.ts` (internazionale ↔ tedesca); il marcatore delle reti "MC7 grezzo" e il flag di protezione know-how dei blocchi (cercarli nel modello e in `mc7`/`project`).
- Produces:
  ```ts
  export interface FindOptions { query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; mnemonic: 'de' | 'int'; scope: { kind: 'project' } | { kind: 'object'; ref: ObjectRef } }
  export type HitLocation =
    | { kind: 'network'; deviceId: string; blockId: string; networkIndex: number; from: number; to: number }
    | { kind: 'source'; deviceId: string; sourceId: string; from: number; to: number }
    | { kind: 'blockTitle' | 'blockComment' | 'networkTitle' | 'networkComment'; deviceId: string; blockId: string; networkIndex?: number; from: number; to: number }
    | { kind: 'tag'; field: 'name' | 'comment'; deviceId: string; tableId: string; tagId: string; from: number; to: number };
  export interface Hit { loc: HitLocation; preview: string; editable: boolean; reason?: 'PROTETTO' | 'MC7_GREZZO' }
  export function findInProject(p: Project, o: FindOptions): Hit[] | { error: 'REGEX_NON_VALIDA'; detail: string };
  export function replaceInProject(p: Project, o: FindOptions, replacement: string, only?: Hit[]): { project: Project; replaced: number; skipped: number };  // pura
  ```

Regole:
- Il testo delle reti si cerca **come lo vede l'utente**: si converte nella mnemonica `o.mnemonic`, si cerca lì, e le sostituzioni si riconvertono in internazionale prima di salvare. Gli offset `from`/`to` si riferiscono al testo mostrato.
- Ricerca letterale: i caratteri speciali valgono come tali. `wholeWord` usa i confini di identificatore AWL (lettere, cifre, `_`, `#`, `"` restano dentro la parola). `regex` usa le regex JS con flag `g` (più `i` se `!matchCase`); una regex non valida dà un errore, non un'eccezione.
- Blocchi protetti know-how e reti "MC7 grezzo": i risultati compaiono con `editable:false` e `reason`. `replaceInProject` non li tocca mai e li conta in `skipped`. Dei blocchi protetti si cerca solo nell'interfaccia e nel titolo, mai nel codice (spec §6).
- `replaceInProject` è pura e restituisce un progetto nuovo. Il chiamante (Task 7) la avvolge in un solo `store.edit`.

- [x] **Step 1: Scrivi i test che falliscono**
  - `findInProject.test.ts`: `it('trova "MW10" in due reti di due blocchi e in un commento di variabile')`; `it('mnemonica de: cerca "U M0.0" trova la riga salvata come "A M0.0"')`; `it('letterale "(.*)" non è regex')`; `it('wholeWord: "M1" non trova "M10"')`; `it('regex non valida → {error:"REGEX_NON_VALIDA"}')`; `it('rete MC7 grezzo → hit editable:false reason MC7_GREZZO')`; `it('blocco protetto → nessun hit nel codice, hit nel titolo editable:false')`; `it('scope object limita ai soli risultati di quel blocco')`.
  - `replaceInProject.test.ts`: `it('sostituisci tutto "MW10"→"MW12" in 3 blocchi: replaced 3, testo salvato in internazionale')`; `it('mnemonica de: sostituisci "U"→"UN" come parola intera produce "AN" salvato')`; `it('hit protetti/grezzi contati in skipped, blocchi invariati')`; `it('only=[un hit] sostituisce solo quello')`; `it('il progetto di partenza non è mutato')`.
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project ui test/search`.
- [x] **Step 3: Implementa** i tre file.
- [x] **Step 4: Test, typecheck, lint, formato**
- [x] **Step 5: Commit** — `feat(ui): motore di ricerca e sostituzione nel progetto`

---

### Task 7: Interfaccia "Trova e sostituisci" (task card, barra degli strumenti, scorciatoie)

**Files:**
- Create: `packages/ui/src/taskcards/FindReplace.tsx`
- Modify: `packages/ui/src/taskcards/TaskCards.tsx` (sezione `tasks/findReplace` al posto del segnaposto), la casella *Ricerca* della barra degli strumenti (oggi disattivata), `packages/ui/src/commands.ts` (attiva `edit.findReplace`; scorciatoie Ctrl+F apri/trova, Ctrl+H sostituisci; su macOS ⌘), `i18n/it.json`, `en.json`
- Test: `packages/ui/test/findReplace.test.tsx`

**Interfaces:**
- Consumes: `findInProject`, `replaceInProject`, `FindOptions`, `Hit` (Task 6); `openBlockAt`/`openSourceAt` per portare il cursore sul risultato; la preferenza di mnemonica attuale (Task 8 la sposta, ma il valore si legge dalla stessa sorgente); `store.edit`.

Regole:
- La task card *Task → Trova e sostituisci* (§8.2 punto 13) contiene: campo "Trova", campo "Sostituisci con", caselle *Maiuscole/minuscole*, *Parola intera*, *Espressione regolare*, ambito *Editor attivo* / *Tutto il progetto*, pulsanti *Trova*, *Sostituisci*, *Sostituisci tutto*. Sotto c'è l'elenco dei risultati raggruppati per oggetto. I risultati non modificabili sono in grigio, con il motivo in un suggerimento.
- Clic su un risultato: apre l'editor dell'oggetto e seleziona il testo trovato. Le variabili si aprono nella tabella con la riga selezionata.
- *Sostituisci tutto* e *Sostituisci* sono ciascuno **un solo** `store.edit('edit.replace', …)`. Il messaggio in *Informazioni* dice quanti testi sono stati sostituiti e quanti saltati.
- La casella *Ricerca* della barra degli strumenti: Invio apre la task card con quel testo e cerca in tutto il progetto. Ctrl+F apre la task card e mette il fuoco su "Trova", con dentro il testo selezionato nell'editor attivo se c'è.
- Dopo una modifica al progetto i risultati diventano vecchi: si mostra "Risultati non aggiornati, ripeti la ricerca" e si disattiva *Sostituisci*, così nessuna sostituzione parte da offset vecchi.

- [x] **Step 1: Scrivi i test che falliscono** (`findReplace.test.tsx`, `renderApp()`)
  - `it('Ctrl+F apre la task card col fuoco su Trova')`
  - `it('cerca "MW10" in tutto il progetto → 3 risultati raggruppati per blocco')`
  - `it('clic su un risultato apre il blocco con la selezione sul testo')`
  - `it('Sostituisci tutto → testo cambiato in 3 blocchi; un Ctrl+Z ripristina tutti e 3')`
  - `it('casella Ricerca della barra + Invio apre la task card e cerca')`
  - `it('dopo una modifica i risultati sono segnati non aggiornati e Sostituisci è disattivato')`
  - `it('regex non valida → messaggio sotto il campo, nessuna eccezione')`
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project ui -t "Trova|findReplace"`.
- [x] **Step 3: Implementa** pannello, collegamenti e scorciatoie.
- [x] **Step 4: Test, typecheck, lint, formato**
- [x] **Step 5: Commit** — `feat(ui): trova e sostituisci nella task card e nella barra degli strumenti`

---

### Task 8: Opzioni → Impostazioni

**Files:**
- Create: `packages/ui/src/settings/settings.ts`, `packages/ui/src/dialogs/SettingsDialog.tsx`
- Modify: `packages/ui/src/commands.ts` (attiva `options.settings`), `packages/ui/src/App.tsx` (render del dialogo), `packages/ui/src/i18n/index.ts` (lingua dalle impostazioni), `packages/ui/src/editors/awl/mnemonicPreference.ts` (legge/scrive dalle impostazioni; il selettore esce dall'intestazione dell'editor di blocco, 1C R2), `packages/ui/src/services/recoveryService.ts` (intervallo dalle impostazioni, 1B R8), gli editor CodeMirror (`AwlEditor.tsx`, `CommittedEditor.tsx`, `SourceEditor.tsx`) per le opzioni dell'editor, `theme/tokens.css` per lo zoom, `i18n/it.json`, `en.json`
- Test: `packages/ui/test/settings.test.ts`, `packages/ui/test/settingsDialog.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface Settings {
    general: { language: 'it' | 'en'; author: string; recoveryMinutes: 1 | 2 | 5 | 10 | 0 };   // 0 = disattivato
    appearance: { uiScale: 90 | 100 | 110 | 125 };
    editor: { mnemonic: 'de' | 'int'; fontSize: 11 | 12 | 13 | 14 | 16; tabSize: 2 | 4 | 8; autocomplete: boolean; lineNumbers: boolean };
  }
  export const DEFAULT_SETTINGS: Settings;          // it, '', 1, 100, mnemonica attuale di default, 13, 4, true, true
  export function loadSettings(): Settings;         // localStorage 'baa.settings.v1'; migra 'baa.lang', 'baa.mnemonic' e l'autore se la chiave nuova manca; valori non validi → default campo per campo
  export function saveSettings(s: Settings): void;
  export function useSettings(): [Settings, (patch: DeepPartial<Settings>) => void];
  ```

Regole:
- Dialogo modale *Impostazioni* con tre sezioni: *Generale* (lingua dell'interfaccia, autore predefinito dei nuovi progetti, intervallo del salvataggio di recupero), *Aspetto* (scala dell'interfaccia), *Comportamento editor* (mnemonica SIMATIC tedesca/internazionale, dimensione del carattere, larghezza tabulazione, completamento automatico, numeri di riga). I pulsanti sono *OK*, *Annulla* e *Ripristina predefiniti*.
- Le modifiche valgono **subito** dopo OK, senza riavvio: la lingua con `i18next.changeLanguage`, la scala con una variabile CSS su `:root`, le opzioni dell'editor con la riconfigurazione di CodeMirror tramite `Compartment`, il recupero riavviando il timer. *Annulla* non lascia tracce.
- Le impostazioni non fanno parte del progetto: non entrano in annulla/ripeti e non segnano il progetto come modificato.
- Il selettore della mnemonica nell'intestazione dell'editor di blocco sparisce: la mnemonica si sceglie solo dalle Impostazioni (1C R2). Il selettore di lingua della Vista portale resta e scrive nelle stesse impostazioni.
- Il localStorage è illeggibile o contiene JSON rotto → valgono i valori predefiniti, senza errori a video. Va gestito con try/catch come le altre chiavi.

- [x] **Step 1: Scrivi i test che falliscono**
  - `settings.test.ts`: `it('nessuna chiave → DEFAULT_SETTINGS')`; `it('migra baa.lang=en e baa.mnemonic=int nella chiave nuova')`; `it('JSON rotto → default')`; `it('campo non valido (fontSize 99) → default solo per quel campo')`.
  - `settingsDialog.test.tsx`: `it('Opzioni → Impostazioni apre il dialogo con le tre sezioni')`; `it('lingua en + OK → menu in inglese subito')`; `it('mnemonica int + OK → l\'editor AWL mostra "A" invece di "U"')`; `it('Annulla non cambia niente')`; `it('recupero 0 → nessun salvataggio di recupero dopo 2 intervalli')`; `it('cambiare impostazioni non segna il progetto modificato')`; `it('l\'intestazione dell\'editor di blocco non ha più il selettore di mnemonica')`.
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project ui -t "settings|Impostazioni"`.
- [x] **Step 3: Implementa** impostazioni, dialogo e collegamenti; adegua i test esistenti del selettore di mnemonica e della lingua al nuovo percorso, senza togliere asserzioni.
- [x] **Step 4: Test, typecheck, lint, formato**
- [x] **Step 5: Commit** — `feat(ui): Opzioni → Impostazioni (lingua, aspetto, comportamento editor)`

---

### Task 9: Barra di stato con avanzamento, Ctrl+B e collaudo "Fatto quando" della tappa 1

**Files:**
- Modify: `packages/ui/src/…/StatusBar.tsx` (oggi solo ultimo messaggio), il servizio di compilazione (avanzamento + interruzione), `packages/ui/src/commands.ts` (Ctrl+B = Compila, §8.5), `i18n/it.json`, `en.json`
- Create: `apps/desktop/e2e/tappa1-fatto-quando.spec.ts`, `apps/desktop/e2e/tappa1f.spec.ts`
- Test: `packages/ui/test/statusBar.test.tsx` + i due spec e2e

**Interfaces:**
- Produces:
  ```ts
  export interface Progress { labelKey: string; done: number; total: number; cancel?: () => void }
  export function useProgress(): Progress | null;
  export function runWithProgress<T>(labelKey: string, total: number, work: (step: () => void, signal: AbortSignal) => Promise<T>): Promise<T | 'interrotto'>;
  ```

Regole:
- La barra di stato (§8.2 punto 12) mostra, durante un'operazione lunga, l'etichetta, una barra `done/total` e il pulsante *Interrompi*. Altrimenti mostra l'ultimo messaggio. La compilazione (*solo modifiche* / *tutto*) usa `runWithProgress` con un passo per blocco. *Interrompi* ferma tra un blocco e l'altro, senza lasciare a metà nessun blocco: i blocchi già compilati restano compilati e gli altri restano "da compilare". In *Informazioni → Compila* compare "Compilazione interrotta".
- Ctrl+B (⌘B) = Compila. Le scorciatoie di carica nel dispositivo, online e offline restano non collegate: quelle funzioni arrivano alla tappa 3, ed è già detto nei limiti noti.
- **E2E "Fatto quando" (spec §9 Tappa 1).** Nell'app impacchettata, usando solo l'interfaccia: crea un progetto, aggiunge una CPU S7-300, OB1, un FB con il suo DB di istanza, un FC, un DB globale e una tabella delle variabili con 3 variabili. Poi compila tutto senza errori, salva, chiude, riapre dai recenti, verifica che ci siano tutti gli oggetti e ricompila senza errori. Il test di andata e ritorno dell'MC7 esiste già (piani 1E/1D-bis) e non si ripete.
- **E2E 1F:** esporta e reimporta una tabella in csv e in xlsx, archivia e ritira, apre un progetto di riferimento e ne copia un FC, fa un trova e sostituisci con Ctrl+Z, cambia lingua e mnemonica dalle Impostazioni.

- [x] **Step 1: Scrivi i test che falliscono** — `statusBar.test.tsx`: `it('durante la compilazione di 5 blocchi la barra mostra 0/5 … 5/5 e Interrompi')`; `it('Interrompi dopo 2 blocchi → 2 compilati, 3 da compilare, messaggio "Compilazione interrotta"')`; `it('Ctrl+B avvia la compilazione')`. I due spec e2e coprono i flussi descritti sopra.
- [x] **Step 2: Esegui e verifica che falliscano** — `npx vitest run --project ui -t "statusBar|Ctrl+B"`; `npm run e2e`.
- [x] **Step 3: Implementa** avanzamento, interruzione e scorciatoia; sistema ciò che gli e2e trovano rotto.
- [x] **Step 4: Test completi** — `npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.
- [x] **Step 5: Commit** — `feat(ui): avanzamento e interruzione nella barra di stato, Ctrl+B; e2e "Fatto quando" della tappa 1`

---

### Task 10: Limiti noti, piano generale, versione e collaudo

**Files:**
- Modify: `docs/limiti-noti.md`, `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, `apps/desktop/package.json` (+ riga in `package-lock.json`), questo piano (caselle)

Regole:
- **`docs/limiti-noti.md`:**
  - nuove voci per i limiti di questo piano: il progetto di riferimento non si apre negli editor (solo copia); xlsx scritto in forma minima senza formattazione; le costanti in csv non si esportano, perché il csv ha un solo foglio (usare xlsx); le scorciatoie di tappa 3 non sono collegate;
  - aggiornare la sezione della tappa 1. Tutti i punti della spec §9 sono fatti tranne uno: la conformità su CPU reale, che resta **in sospeso** e chiude la tappa 1 solo quando sarà fatta (spec §6: «la tappa 1 non si chiude senza i test di conformità su CPU reale»). Lo si dice esplicitamente;
  - restano aperti anche i controlli a mano dei piani 1B e 1C.
- **Piano generale:** riga 1F → "fatto: importa/esporta variabili, archivio, riferimenti, trova e sostituisci, impostazioni, barra di stato, e2e Fatto quando; la tappa 1 resta aperta solo per la conformità su CPU reale".
- **Versione:** `apps/desktop` 0.5.0.
- **Collaudo:** `npm test && for i in 1 2 3; do npm run e2e || break; done && npm run typecheck && npm run lint && npm run format:check`, verde 3 volte su 3. Con `S7_CAPTURES_DIR` sulla cache delle catture, così girano anche i test delle catture.
- **Lista di controllo manuale** (Windows e macOS), da aggiungere in fondo a questo piano: l'xlsx esportato si apre in Excel e in LibreOffice senza avvisi di riparazione; un xlsx esportato da TIA Portal, se l'utente ne ha uno, si importa; Archivia e Ritira con un percorso con lettere accentate e spazi; la scala dell'interfaccia a 125% non taglia i pannelli.

- [x] **Step 1: Aggiorna limiti noti, piano generale, versione, caselle e lista di controllo**
- [x] **Step 2: Esegui il collaudo tre volte**
- [x] **Step 3: Commit** — `docs: 1F chiuso; tappa 1 aperta solo per la conformità su CPU reale; versione 0.5.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Un solo piano per la 1F.** Le sei funzioni sono indipendenti, ma escono con una sola versione (0.5.0) e il collaudo finale le tiene insieme. Ogni funzione ha però il suo task e la sua revisione. *Se fosse sbagliato:* si divide il piano, senza lavoro buttato.
- **R2. Niente libreria xlsx: OOXML minimo su `fflate`.** Così niente nuove dipendenze, niente problemi di licenza (la versione libera di SheetJS non è più su npm), e la superficie di codice resta piccola. Il costo è un lettore/scrittore minimo da mantenere. *Se fosse sbagliato:* si sostituisce `ooxml.ts` con una libreria dietro la stessa interfaccia `readXlsx`/`writeXlsx`.
- **R3. Colonne compatibili con l'esportazione delle variabili di TIA Portal**, dalla documentazione pubblica: `Name, Path, Data Type, Logical Address, Comment, Hmi Visible/Accessible/Writeable`, più il foglio delle costanti. Così chi passa da TIA porta le sue tabelle. Il csv usa le stesse intestazioni. *Se fosse sbagliato:* si cambia `columns.ts`.
- **R4. csv con `;` e BOM in esportazione**, perché Excel italiano lo apre senza importazione guidata. In lettura il separatore si rileva da solo. *Se fosse sbagliato:* un'opzione nelle Impostazioni.
- **R5. Importazione: un nome già presente si aggiorna, uno nuovo si crea.** Le righe errate si saltano e compaiono nel riepilogo. È il comportamento di TIA Portal. *Se fosse sbagliato:* si aggiunge la scelta "salta i nomi esistenti".
- **R6. `.baapz` = manifesto + `.baap` intero.** Non si tolgono dati derivati, perché il `.baap` è già compatto. Ritira archivio chiede la cartella e apre il progetto. *Se fosse sbagliato:* si aggiunge la riduzione in `writeBaapz`, compatibile all'indietro grazie al `formatVersion`.
- **R7. Progetti di riferimento: solo copia e trascinamento**, senza aprire gli oggetti negli editor in sola lettura. La spec chiede «da cui copiare». Aprirli in un editor in sola lettura richiede un editor in sola lettura che oggi non esiste. *Se fosse sbagliato:* un task in più alla tappa 7 o prima.
- **R8. Ricerca nel testo come lo vede l'utente**, cioè nella mnemonica scelta, e sostituzione riconvertita in internazionale. *Se fosse sbagliato:* si cerca nel testo salvato e l'utente dovrebbe cercare in internazionale.
- **R9. Impostazioni nel localStorage (`baa.settings.v1`)**, con migrazione delle chiavi esistenti. Non serve un file nel processo principale: nessuna impostazione serve al processo principale. *Se fosse sbagliato:* si sposta in `userData/settings.json` dietro `loadSettings`/`saveSettings`.
- **R10. Le scelte dell'Aspetto sono solo la scala.** Il tema resta quello chiaro di TIA (spec §8.6); un tema scuro non è richiesto. *Se fosse sbagliato:* si aggiunge una voce.
- **R11. La tappa 1 resta formalmente aperta** dopo la 1F, solo per la conformità su CPU reale. Lo dice la spec §6, e lo si dichiara invece di nasconderlo. *Se fosse sbagliato:* niente, è un limite dichiarato.

---

## Lista di controllo manuale (Windows e macOS)

- [ ] L'xlsx esportato si apre in Excel e in LibreOffice senza avvisi di riparazione.
- [ ] Un xlsx esportato da TIA Portal, se l'utente ne ha uno, si importa.
- [ ] Archivia e Ritira archivio funzionano con un percorso con lettere accentate e spazi.
- [ ] La scala dell'interfaccia a 125% non taglia i pannelli (anche nelle finestre staccate).
