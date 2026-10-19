# Piano 1B — Modello dati PLC: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In BaaPortal si aggiunge una CPU S7-300 dal catalogo e si creano, modificano e salvano tabelle delle variabili (con costanti), tipi di dati PLC (UDT) e blocchi OB/FB/FC/DB/DB di istanza con la loro interfaccia, con annulla/ripeti, taglia/copia/incolla, trascinamento, recupero automatico ed editor nell'area di lavoro (barra degli editor, divisione, finestra separata).

**Architecture:** Due pacchetti nuovi, TypeScript puro e senza interfaccia:
- `@baaportal/s7-types`: tipi di dati S7, valori, indirizzi assoluti, disposizione in memoria;
- `@baaportal/catalog`: CPU S7-300 e OB, con dati tecnici presi da documentazione pubblica.

`@baaportal/project` passa al formato `.baap` versione 2: un JSON per ogni oggetto, operazioni pure sugli oggetti e controlli che producono una diagnostica.

In `@baaportal/ui` ogni modifica al progetto passa da `store.edit(...)`, che tiene la cronologia di annulla/ripeti con le patch di immer. Gli editor sono React e usano una griglia comune (`DataGrid`). Un editor "staccato" è un portale React dentro una finestra `about:blank` aperta con `window.open`: lo stato resta uno solo, quello della finestra principale.

**Tech Stack:** quello del piano 1A, più `immer` (patch per annulla/ripeti) in `@baaportal/ui`. Nessuna libreria di griglia esterna.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`: §5, §6 (catalogo CPU), §7 (moduli `s7-types`, `catalog`, `project`), §8.2, §8.3, §8.6, §9 tappa 1. Piano generale: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, riga 1B. Codice di partenza: `main` dopo il piano 1A (commit `14ec807`).

## Global Constraints

- Valgono tutti i Global Constraints del piano 1A (`docs/superpowers/plans/2026-10-18-tappa1a-shell-interfaccia.md`):
  - testi solo in `it.json`/`en.json`;
  - nomi di TIA Portal in italiano, frasi con parole nostre;
  - nessun file, icona o testo copiato da prodotti Siemens;
  - `Mod` = Ctrl/⌘;
  - Electron sicuro.
- "Nessun codice, icona, immagine, testo o file copiato da prodotti Siemens."
  - I dati tecnici delle CPU e le dichiarazioni delle informazioni di avvio degli OB sono fatti tecnici. Si prendono dalla documentazione pubblica Siemens (manuali, schede tecniche), e per ogni CPU si scrive la fonte nel campo `source`.
  - I commenti dei manuali non si copiano.
- Tipi di dati con i nomi usati da TIA Portal per S7-300: `Bool`, `Byte`, `Word`, `DWord`, `Int`, `DInt`, `Real`, `S5Time`, `Time`, `Date`, `Time_Of_Day`, `Char`, `String`, `Date_And_Time`, `Array`, `Struct`, `Timer`, `Counter`, `Block_FB`, `Block_FC`, `Block_DB`, `Block_SDB`, `Pointer`, `Any`, `Void`.
- Sezioni dell'interfaccia con i nomi di TIA: `Input`, `Output`, `InOut`, `Static`, `Temp`, `Return`.
- Linguaggi: `KOP`, `FUP`, `AWL`, `SCL`. In 1B si crea solo `AWL`; gli altri compaiono disattivati.
- Indirizzi mostrati come in TIA: `%I0.0`, `%QW4`, `%MD10`, `%PIW256`, `%T5`, `%C3`. In ingresso si accettano anche i mnemonici tedeschi (`E`, `A`, `PE`, `PA`, `Z`) e la forma senza `%`.
- Proprietà della CPU (spec §9): "Fino alla tappa 6 queste proprietà valgono solo per il simulatore, per i controlli offline e per l'indirizzo di collegamento: nel PLC non si caricano, e l'interfaccia lo dice chiaramente."
- Ogni modifica al progetto è **un solo passo** di annulla/ripeti: una cella confermata, un incolla, un riempimento automatico, un'aggiunta da dialogo, una rinomina, un'eliminazione.
- Formato `.baap`: "un file zip con dentro file di testo/JSON leggibili". Regola di versione:
  - ogni modifica del formato alza `FORMAT_VERSION`;
  - un file più nuovo viene rifiutato con `NEWER_FORMAT`;
  - le chiavi sconosciute negli oggetti si conservano e si riscrivono.

## Review Focus

1. **Annulla/ripeti e stato "modificato"**:
   - tornare con Annulla esattamente allo stato salvato toglie l'asterisco "modificato";
   - salvare e poi annullare lo rimette;
   - annullare la creazione di un blocco con l'editor aperto chiude l'editor senza errori;
   - una modifica fatta durante il salvataggio non va persa.

   Test: Task 6 e Task 10.
2. **Nomi con accenti, spazi, virgolette e maiuscole diverse**:
   - "Velocità nastro" è valido;
   - `a"b` viene rifiutato con un messaggio chiaro;
   - "MOTORE" accanto a "Motore" è un duplicato;
   - rinominare un UDT usato in tre posti aggiorna tutti i riferimenti in un solo passo di annulla.

   Test: Task 1, Task 4, Task 5, Task 9.
3. **Incolla da Excel** (righe separate da `\r\n`, riga vuota finale, colonne mancanti, tipi o indirizzi sbagliati, 1000 righe):
   - le righe si creano tutte, quelle sbagliate segnate in rosso;
   - nessun crash;
   - un solo passo di annulla;
   - i nomi già usati diventano `_1`, `_2`.

   Test: Task 11 e Task 12.
4. **File `.baap` vecchi, nuovi o incoerenti**:
   - un progetto del piano 1A (formato 1) si apre e si salva in formato 2;
   - un file formato 2 con chiavi sconosciute le conserva;
   - un file con riferimenti rotti (DB di istanza di un FB che non c'è, UDT mancante) si apre e mostra gli errori nella griglia, non una finestra vuota;
   - id doppi o file mancanti danno `INVALID_SCHEMA`.

   Test: Task 4 e Task 5.
5. **Editor in finestra separata**:
   - chiudere la finestra separata riporta l'editor nell'area di lavoro;
   - chiudere la finestra principale (dopo la conferma) chiude anche quelle separate;
   - una modifica fatta nella finestra separata arriva nella vista dettagli della principale ed è annullabile da lì;
   - le scorciatoie (Mod+S, Mod+Z) funzionano anche nella finestra separata.

   Test: Task 7, Task 10, Task 16.

---

## Struttura dei file

```
packages/s7-types/                     NUOVO
  src/index.ts
  src/types.ts          DataType, TypedMember, ELEMENTARY_TYPES, nomi canonici
  src/typeExpr.ts       parseType, formatType
  src/names.ts          validateS7Name, sameName, incrementName
  src/literals.ts       parseLiteral, defaultLiteral
  src/address.ts        parseAddress, formatAddress, addressFitsType, addressBitRange, rangesOverlap, incrementAddress
  src/layout.ts         layoutStruct, layoutInstance, formatOffset
  test/*.test.ts
packages/catalog/                      NUOVO
  src/index.ts  src/types.ts  src/cpus.ts  src/obs.ts
  test/catalog.test.ts
packages/project/
  src/model.ts          (riscritto) formato 2
  src/baapFile.ts       (riscritto) un JSON per oggetto, migrazione dal formato 1
  src/plc.ts            NUOVO creazione oggetti, numeri e nomi liberi, rinomina con riferimenti, ricerca
  src/members.ts        NUOVO toTypedMembers, typeResolver, percorsi dei membri
  src/checks.ts         NUOVO checkDevice → Diagnostic[]
  test/{model,baapFile,plc,checks}.test.ts
packages/ui/src/
  state/store.ts        (esteso) edit/undo/redo, revisioni, editTarget, workArea
  state/history.ts      NUOVO cronologia con patch immer
  services/projectService.ts (adattato alle revisioni)
  services/recoveryService.ts NUOVO
  services/clipboard.ts NUOVO appunti interni + testo di sistema
  commands/commands.ts  (esteso) annulla/ripeti, modifica, inserisci, finestra
  components/CommitField.tsx  components/Dialog.tsx  components/ContextMenu.tsx  NUOVI
  grid/DataGrid.tsx  grid/grid.css  grid/tsv.ts  NUOVI
  project/navigation/treeIds.ts  treeModel.ts (riscritto)  ProjectTree.tsx  DetailsView.tsx
  project/dialogs/AddDeviceDialog.tsx  AddBlockDialog.tsx  NUOVI
  project/objectActions.ts  NUOVO taglia/copia/incolla/elimina/rinomina/sposta
  project/workarea/WorkArea.tsx  EditorFrame.tsx  DetachedWindow.tsx  editorBarModel.ts  NUOVI
  project/EditorBar.tsx (esteso)
  editors/registry.tsx  NUOVO
  editors/tags/TagTableEditor.tsx  AllTagsEditor.tsx  tagRows.ts  NUOVI
  editors/block/BlockEditor.tsx  InterfaceTable.tsx  interfaceRows.ts  NetworksView.tsx  NUOVI
  editors/db/DbEditor.tsx  editors/udt/UdtEditor.tsx  NUOVI
  project/inspector/properties/{PlcProperties,BlockProperties,UdtProperties,TagTableProperties}.tsx  NUOVI
  icons/objects.tsx  NUOVO icone OB, FB, FC, DB, IDB, UDT, tabella variabili, gruppo, CPU
apps/desktop/src/
  main/recoveryStore.ts  NUOVO
  main/ipc.ts  main/index.ts  preload/index.ts  shared/rawBridge.ts  renderer/createBridge.ts (estesi)
  e2e/plc-model.spec.ts  e2e/detached-editor.spec.ts  e2e/recovery.spec.ts  NUOVI
```

---

### Task 1: `@baaportal/s7-types`: tipi, espressioni di tipo, nomi, valori

**Files:**
- Create: `packages/s7-types/{package.json,tsconfig.json,vitest.config.ts}`, `packages/s7-types/src/{index,types,typeExpr,names,literals}.ts`
- Test: `packages/s7-types/test/{typeExpr,names,literals}.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces:
  ```ts
  export type ElementaryTypeName = 'Bool'|'Byte'|'Word'|'DWord'|'Int'|'DInt'|'Real'|'S5Time'|'Time'|'Date'|'Time_Of_Day'|'Char';
  export type ParameterTypeName = 'Timer'|'Counter'|'Block_FB'|'Block_FC'|'Block_DB'|'Block_SDB'|'Pointer'|'Any';
  export const ELEMENTARY_TYPES: readonly ElementaryTypeName[];   // nell'ordine sopra
  export const PARAMETER_TYPES: readonly ParameterTypeName[];
  export interface TypedMember { name: string; type: DataType }
  export interface ArrayDim { lo: number; hi: number }
  export type DataType =
    | { kind: 'elementary'; name: ElementaryTypeName }
    | { kind: 'string'; length: number }          // 1..254
    | { kind: 'dateAndTime' }
    | { kind: 'parameter'; name: ParameterTypeName }
    | { kind: 'array'; dims: ArrayDim[]; element: DataType }   // 1..6 dimensioni
    | { kind: 'struct'; members: TypedMember[] }
    | { kind: 'named'; name: string }            // UDT o FB (multi-istanza), senza virgolette
    | { kind: 'void' };
  export type TypeError = 'SYNTAX'|'STRING_LENGTH'|'ARRAY_BOUNDS'|'ARRAY_DIMENSIONS'|'NESTED_ARRAY'|'ARRAY_OF_PARAMETER';
  export function parseType(text: string): { ok: true; type: DataType } | { ok: false; error: TypeError };
  export function formatType(type: DataType): string;
  export type NameCheck = { ok: true } | { ok: false; reason: 'EMPTY'|'TOO_LONG'|'INVALID_CHARS'|'LEADING_TRAILING_SPACE' };
  export function validateS7Name(name: string): NameCheck;
  export function sameName(a: string, b: string): boolean;
  export function incrementName(name: string): string;
  export type LiteralError = 'SYNTAX'|'OUT_OF_RANGE'|'TOO_LONG'|'NO_VALUE';
  export function parseLiteral(type: DataType, text: string): { ok: true; canonical: string } | { ok: false; error: LiteralError };
  export function defaultLiteral(type: DataType): string | null;
  ```

Regole:
- `parseType`:
  - non distingue maiuscole e minuscole e ignora gli spazi;
  - alias: `TOD` → `Time_Of_Day`, `DT` → `Date_And_Time`, `S5TIME` → `S5Time`;
  - `String` senza lunghezza = `String[254]`;
  - `"Nome"` = tipo con nome (UDT o FB);
  - `Struct` e `Array[..] of Struct` danno una struct con `members: []`: i membri li porta il modello di progetto;
  - limiti degli array: ciascuno tra -32768 e 32767, con `lo ≤ hi`, da 1 a 6 dimensioni, niente array di array, niente array di tipi parametro.
- `formatType`: forma canonica di TIA, per esempio `Array[1..10] of Int`, `Array[0..3, -2..2] of Bool`, `String[20]`, `"Motore"`, `Struct`, `Date_And_Time`.
- `validateS7Name`:
  - lunghezza da 1 a 128;
  - vietati `"` e i caratteri di controllo U+0000–U+001F e U+007F;
  - niente spazi iniziali o finali.
- `sameName`: confronto su `normalize('NFC').toLowerCase()`.
- `incrementName`:
  - aggiunge `_1`, oppure incrementa il numero finale dopo `_`;
  - conserva gli zeri iniziali (`A_01` → `A_02`).
- `parseLiteral`, forma canonica e intervalli:
  - `Bool`: `true`/`false` (accetta `TRUE`, `FALSE`, `1`, `0`);
  - `Byte`, `Word`, `DWord`: `16#` più cifre esadecimali maiuscole senza zeri iniziali, con limiti 0–FF, 0–FFFF, 0–FFFFFFFF. In ingresso si accettano anche il decimale, `2#…`, `B#16#`, `W#16#`, `DW#16#` e `B#(a,b[,c,d])`;
  - `Int` e `DInt`: decimale, con limiti -32768–32767 e -2147483648–2147483647. `DInt` accetta anche `L#`;
  - `Real`: numero in virgola mobile con `|x| ≤ 3.402823e38`. La forma canonica aggiunge `.0` agli interi (`1` → `1.0`). La virgola decimale è errore di sintassi;
  - `S5Time`:
    - `S5T#` seguito dai componenti `H`, `M`, `S`, `MS`;
    - totale al massimo 2H46M30S e multiplo di 10 ms;
    - forma canonica senza componenti nulli (`S5T#0MS` se zero);
    - si accetta anche `S5TIME#`;
  - `Time`:
    - `T#[-]` seguito dai componenti `D`, `H`, `M`, `S`, `MS`, con `_` facoltativo tra i componenti;
    - intervallo da -24D20H31M23S648MS a 24D20H31M23S647MS;
    - si accetta anche `TIME#`;
  - `Date`: `D#AAAA-MM-GG`, dal 1990-01-01 al 2168-12-31. Una data che non esiste dà `OUT_OF_RANGE`. Si accetta anche `DATE#`;
  - `Time_Of_Day`: `TOD#hh:mm:ss.mmm`, sempre con 3 cifre di millisecondi. Si accetta anche `TIME_OF_DAY#`;
  - `Date_And_Time`: `DT#AAAA-MM-GG-hh:mm:ss.mmm`, con anni dal 1990 al 2089. Si accetta anche `DATE_AND_TIME#`;
  - `Char`: un carattere tra apici con codice ≤ 0xFF;
  - `String[n]`: testo tra apici di al massimo n caratteri, con escape `$'`, `$$`, `$L`, `$N`, `$P`, `$R`, `$T`, `$hh`;
  - tipi parametro, `Void`, `Struct`, `Array` e tipi con nome: `NO_VALUE`.
- `defaultLiteral`: `false`, `16#0`, `0`, `0.0`, `S5T#0MS`, `T#0MS`, `D#1990-01-01`, `TOD#00:00:00.000`, `DT#1990-01-01-00:00:00.000`, `' '` per `Char`, `''` per `String`. Per i tipi senza valore restituisce `null`.

- [ ] **Step 1: Crea il pacchetto**

  Usa la stessa forma di `@baaportal/project`:
  - `"exports": { ".": "./src/index.ts" }`;
  - `vitest.config.ts` con `name: 's7-types'` e `environment: 'node'`;
  - `tsconfig.json` che estende la base.

  Nessuna dipendenza.

- [ ] **Step 2: Scrivi i test che falliscono**

  ```ts
  // typeExpr.test.ts
  it.each([
    ['Bool', 'Bool'], ['INT', 'Int'], ['dword', 'DWord'], ['TOD', 'Time_Of_Day'], ['DT', 'Date_And_Time'],
    ['S5TIME', 'S5Time'], ['String', 'String[254]'], ['STRING[20]', 'String[20]'], ['string [ 8 ]', 'String[8]'],
    ['ARRAY[1..10] OF INT', 'Array[1..10] of Int'], ['Array [0..3, -2..2] of Bool', 'Array[0..3, -2..2] of Bool'],
    ['"Motore"', '"Motore"'], ['Array[1..2] of "Asse"', 'Array[1..2] of "Asse"'], ['Struct', 'Struct'],
    ['Array[1..4] of Struct', 'Array[1..4] of Struct'], ['Timer', 'Timer'], ['block_fb', 'Block_FB'], ['ANY', 'Any'], ['Void', 'Void'],
  ])('parseType(%s) → %s', (input, out) => {
    const r = parseType(input);
    expect(r.ok && formatType(r.type)).toBe(out);
  });
  it.each([
    ['Bol', 'SYNTAX'], ['String[0]', 'STRING_LENGTH'], ['String[255]', 'STRING_LENGTH'], ['Array[5..1] of Int', 'ARRAY_BOUNDS'],
    ['Array[1..40000] of Int', 'ARRAY_BOUNDS'], ['Array[1..2,1..2,1..2,1..2,1..2,1..2,1..2] of Int', 'ARRAY_DIMENSIONS'],
    ['Array[1..2] of Array[1..2] of Int', 'NESTED_ARRAY'], ['Array[1..2] of Timer', 'ARRAY_OF_PARAMETER'], ['"senza fine', 'SYNTAX'],
  ])('parseType(%s) rifiuta con %s', (input, error) => {
    expect(parseType(input)).toEqual({ ok: false, error });
  });

  // names.test.ts
  it.each([['', 'EMPTY'], [' a', 'LEADING_TRAILING_SPACE'], ['a ', 'LEADING_TRAILING_SPACE'], ['a"b', 'INVALID_CHARS'],
    ['a\tb', 'INVALID_CHARS'], ['x'.repeat(129), 'TOO_LONG']])('validateS7Name(%j) → %s', (n, reason) => {
    expect(validateS7Name(n)).toEqual({ ok: false, reason });
  });
  it('accetta spazi interni, accenti e simboli', () => {
    for (const n of ['Motore 1', 'Velocità nastro', 'Nastro#2', 'Valvola-A', 'x'.repeat(128)]) expect(validateS7Name(n)).toEqual({ ok: true });
  });
  it.each([['Motore', 'Motore_1'], ['Motore_1', 'Motore_2'], ['Tag_9', 'Tag_10'], ['A_01', 'A_02']])('incrementName(%s) → %s', (a, b) => {
    expect(incrementName(a)).toBe(b);
  });
  it('sameName non distingue maiuscole, anche accentate', () => {
    expect(sameName('Motore', 'MOTORE')).toBe(true);
    expect(sameName('Velocità', 'VELOCITÀ')).toBe(true);
    expect(sameName('Motore', 'Motore1')).toBe(false);
  });

  // literals.test.ts: t(text) = parseType(text).type
  it.each([
    ['Bool', 'TRUE', 'true'], ['Bool', '0', 'false'], ['Byte', '255', '16#FF'], ['Byte', 'B#16#0a', '16#A'], ['Byte', '2#1010', '16#A'],
    ['Word', 'W#16#1', '16#1'], ['Word', 'B#(1,2)', '16#102'], ['DWord', 'DW#16#FFFFFFFF', '16#FFFFFFFF'],
    ['Int', '-32768', '-32768'], ['DInt', 'L#5', '5'], ['Real', '1', '1.0'], ['Real', '-1.5e3', '-1500.0'],
    ['S5Time', 's5time#100ms', 'S5T#100MS'], ['S5Time', 'S5T#2H46M30S', 'S5T#2H46M30S'], ['Time', 'T#1d_2h_3m_4s_5ms', 'T#1D2H3M4S5MS'],
    ['Time', 'TIME#-1s', 'T#-1S'], ['Date', 'DATE#2026-10-18', 'D#2026-10-18'], ['Time_Of_Day', 'TIME_OF_DAY#1:2:3.4', 'TOD#01:02:03.400'],
    ['Date_And_Time', 'DT#2026-10-18-12:30:00', 'DT#2026-10-18-12:30:00.000'], ['Char', "'$''", "'$''"], ['String[5]', "'a$Lb'", "'a$Lb'"],
  ])('parseLiteral(%s, %s) → %s', (type, text, canonical) => {
    expect(parseLiteral(t(type), text)).toEqual({ ok: true, canonical });
  });
  it.each([
    ['Byte', '256', 'OUT_OF_RANGE'], ['Int', '32768', 'OUT_OF_RANGE'], ['Real', '3.5E+38', 'OUT_OF_RANGE'], ['Real', '1,5', 'SYNTAX'],
    ['S5Time', 'S5T#2H46M31S', 'OUT_OF_RANGE'], ['S5Time', 'S5T#5MS', 'OUT_OF_RANGE'], ['Time', 'T#25D', 'OUT_OF_RANGE'],
    ['Date', 'D#1989-12-31', 'OUT_OF_RANGE'], ['Date', 'D#2026-02-30', 'OUT_OF_RANGE'], ['Time_Of_Day', 'TOD#24:00:00', 'OUT_OF_RANGE'],
    ['Char', "'AB'", 'TOO_LONG'], ['String[5]', "'abcdef'", 'TOO_LONG'], ['String[5]', "'$Q'", 'SYNTAX'], ['Timer', '1', 'NO_VALUE'],
  ])('parseLiteral(%s, %s) rifiuta con %s', (type, text, error) => {
    expect(parseLiteral(t(type), text)).toEqual({ ok: false, error });
  });
  it('defaultLiteral', () => {
    expect(['Bool', 'Byte', 'Int', 'Real', 'S5Time', 'Time', 'Date', 'Time_Of_Day', 'Date_And_Time', 'Char', 'String[4]', 'Timer'].map((x) => defaultLiteral(t(x))))
      .toEqual(['false', '16#0', '0', '0.0', 'S5T#0MS', 'T#0MS', 'D#1990-01-01', 'TOD#00:00:00.000', 'DT#1990-01-01-00:00:00.000', "' '", "''", null]);
  });
  it('ogni valore canonico si rilegge identico', () => { /* per ogni caso valido sopra: parseLiteral(type, canonical).canonical === canonical */ });
  ```

- [ ] **Step 3: Esegui e verifica che falliscano**

  Run: `npx vitest run --project s7-types`
  Expected: FAIL (moduli mancanti).

- [ ] **Step 4: Implementa `types.ts`, `typeExpr.ts`, `names.ts`, `literals.ts` ed esporta tutto da `index.ts`**

  - `parseType`: piccolo analizzatore a discesa ricorsiva su token (identificatori, numeri con segno, `..`, `,`, `[`, `]`, stringhe tra `"`). Niente espressioni regolari uniche per tutto.
  - `parseLiteral`: una funzione per ogni tipo. Le date si controllano ricostruendo `Date.UTC` e confrontando giorno, mese e anno.

- [ ] **Step 5: Esegui i test, typecheck e lint**

  Run: `npx vitest run --project s7-types && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/s7-types package-lock.json
  git commit -m "feat(s7-types): tipi di dati S7, espressioni di tipo, nomi e valori"
  ```

---

### Task 2: `@baaportal/s7-types`: indirizzi assoluti e disposizione in memoria

**Files:**
- Create: `packages/s7-types/src/{address,layout}.ts`
- Modify: `packages/s7-types/src/index.ts`
- Test: `packages/s7-types/test/{address,layout}.test.ts`

**Interfaces:**
- Consumes: `DataType`, `TypedMember`, `parseType` (Task 1).
- Produces:
  ```ts
  export type IoArea = 'I'|'Q'|'M'|'PI'|'PQ';
  export type AbsoluteAddress =
    | { area: IoArea; size: 'X'; byte: number; bit: number }
    | { area: IoArea; size: 'B'|'W'|'D'; byte: number }
    | { area: 'T'|'C'; number: number };
  export type AddressError = 'SYNTAX'|'BIT_RANGE'|'NUMBER_RANGE';
  export function parseAddress(text: string): { ok: true; address: AbsoluteAddress } | { ok: false; error: AddressError };
  export function formatAddress(a: AbsoluteAddress): string;                 // '%MW10'
  export function addressFitsType(a: AbsoluteAddress, type: DataType): boolean;
  export function addressBitRange(a: AbsoluteAddress): { area: IoArea | 'T' | 'C'; from: number; to: number }; // bit inclusi; T/C: numero
  export function rangesOverlap(a: AbsoluteAddress, b: AbsoluteAddress): boolean;
  export function incrementAddress(a: AbsoluteAddress): AbsoluteAddress;   // passo = dimensione dell'accesso
  export interface FbSections { input: TypedMember[]; output: TypedMember[]; inOut: TypedMember[]; static: TypedMember[] }
  export type TypeResolver = (name: string) => { kind: 'udt'; members: TypedMember[] } | { kind: 'fb'; sections: FbSections } | null;
  export interface LayoutEntry { path: string; byte: number; bit: number; sizeBits: number; strideBits?: number } // strideBits solo per gli Array
  export type LayoutResult = { ok: true; sizeBytes: number; entries: LayoutEntry[] } | { ok: false; error: 'UNKNOWN_TYPE'|'CYCLE'|'NOT_LAYOUTABLE'; name: string };
  export function layoutStruct(members: TypedMember[], resolve: TypeResolver): LayoutResult; // DB, UDT, Temp
  export function layoutInstance(sections: FbSections, resolve: TypeResolver): LayoutResult;  // dati di istanza di un FB
  export function formatOffset(e: { byte: number; bit: number }): string;    // '2.0'
  ```

Regole:
- `parseAddress`:
  - aree I, Q, M (bit `X`, `B`, `W`, `D`), periferia `PI`/`PQ` (solo `B`, `W`, `D`, nessun bit), `T` e `C`;
  - mnemonici tedeschi: `E` = I, `A` = Q, `PE` = PI, `PA` = PQ, `Z` = C;
  - `%` facoltativo, spazio facoltativo tra area e numero, maiuscole indifferenti;
  - byte tra 0 e 65535, bit tra 0 e 7, numero di T/C tra 0 e 65535;
  - indirizzi DB e L non sono ammessi qui: danno `SYNTAX` (arrivano con l'AWL, piano 1C).
- `addressFitsType`:
  - `X` ↔ `Bool`;
  - `B` ↔ `Byte`, `Char`;
  - `W` ↔ `Word`, `Int`, `S5Time`, `Date`;
  - `D` ↔ `DWord`, `DInt`, `Real`, `Time`, `Time_Of_Day`;
  - `T` ↔ `Timer`, `C` ↔ `Counter`;
  - tutto il resto è falso.
- Disposizione in memoria (S7-300):
  - i `Bool` consecutivi riempiono i bit dello stesso byte;
  - `Byte` e `Char` iniziano al byte successivo;
  - ogni tipo di 16 bit o più (`Word`, `Int`, `S5Time`, `Date`, `DWord`, `DInt`, `Real`, `Time`, `Time_Of_Day`, `Date_And_Time` (8 byte), `String[n]` (n+2 byte), `Pointer` (6), `Any` (10)) inizia a un byte pari;
  - `Struct`, UDT, `Array` e multi-istanza iniziano a un byte pari e occupano un numero pari di byte;
  - negli `Array` di `Bool` gli elementi si susseguono bit per bit; negli array degli altri tipi ogni elemento segue le regole del suo tipo;
  - il totale di `layoutStruct` si arrotonda a un numero pari di byte;
  - `layoutInstance`: le sezioni Input, Output, InOut e Static si susseguono e ciascuna inizia a un byte pari;
  - in Input e Output i tipi complessi (`Date_And_Time`, `String`, `Array`, `Struct`, UDT) sono per valore. In InOut i complessi sono un puntatore di 6 byte, gli elementari per valore;
  - `Timer`, `Counter` e `Block_*` occupano 2 byte, `Pointer` 6 e `Any` 10;
  - un tipo con nome si risolve con `resolve`: un UDT si dispone come struct, un FB come `layoutInstance` delle sue sezioni. Nome sconosciuto → `UNKNOWN_TYPE`, ricorsione → `CYCLE`;
  - `Void` dà `NOT_LAYOUTABLE`.
- `entries` contiene ogni membro, compresi quelli dentro struct, UDT e multi-istanza. I percorsi sono come `s.p` e `inst.x`, senza prefisso di sezione perché i nomi sono unici in tutta l'interfaccia. Gli elementi degli array non hanno voci proprie: si calcolano con `strideBits`.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // address.test.ts
  it.each([
    ['M0.0', '%M0.0'], ['%mw10', '%MW10'], ['E 1.7', '%I1.7'], ['A4.0', '%Q4.0'], ['EB0', '%IB0'], ['AW2', '%QW2'], ['MD4', '%MD4'],
    ['PEW256', '%PIW256'], ['PIW256', '%PIW256'], ['PAW256', '%PQW256'], ['T5', '%T5'], ['Z3', '%C3'], ['c3', '%C3'],
  ])('parseAddress(%s) → %s', (a, b) => { const r = parseAddress(a); expect(r.ok && formatAddress(r.address)).toBe(b); });
  it.each([['M0.8', 'BIT_RANGE'], ['MW', 'SYNTAX'], ['PI0.0', 'SYNTAX'], ['M70000.0', 'NUMBER_RANGE'], ['DB1.DBX0.0', 'SYNTAX'], ['T70000', 'NUMBER_RANGE']])(
    'parseAddress(%s) rifiuta con %s', (a, error) => expect(parseAddress(a)).toEqual({ ok: false, error }));
  it('compatibilità indirizzo/tipo', () => {
    const fits = (a: string, ty: string) => addressFitsType(addr(a), type(ty));
    expect([fits('M0.0','Bool'), fits('MW0','Int'), fits('MW0','Bool'), fits('MD0','Real'), fits('T1','Timer'), fits('T1','Int'), fits('MB0','Char'), fits('PIW256','Word'), fits('MW0','String[2]')])
      .toEqual([true, true, false, true, true, false, true, true, false]);
  });
  it('sovrapposizioni', () => {
    const ov = (a: string, b: string) => rangesOverlap(addr(a), addr(b));
    expect([ov('MW0','M1.3'), ov('MW0','MW2'), ov('MD0','MW2'), ov('IW0','PIW0'), ov('T1','T1'), ov('C1','T1')]).toEqual([true, false, true, false, true, false]);
  });
  it.each([['M0.7','%M1.0'], ['MW10','%MW12'], ['MD4','%MD8'], ['IB3','%IB4'], ['T9','%T10']])('incrementAddress(%s) → %s', (a, b) =>
    expect(formatAddress(incrementAddress(addr(a)))).toBe(b));

  // layout.test.ts: m(name, typeText); offsets(r) = Object.fromEntries(r.entries.map(e => [e.path, formatOffset(e)]))
  it('Bool nello stesso byte, Byte al byte, Int e Real al byte pari', () => {
    const r = layoutStruct([m('a','Bool'), m('b','Bool'), m('c','Byte'), m('d','Int'), m('e','Bool'), m('f','Real')], none);
    expect(offsets(r)).toEqual({ a: '0.0', b: '0.1', c: '1.0', d: '2.0', e: '4.0', f: '6.0' });
    expect(r.ok && r.sizeBytes).toBe(10);
  });
  it('Struct e Array a byte pari con lunghezza pari', () => {
    const s = { name: 's', type: { kind: 'struct', members: [m('p','Bool'), m('q','Byte')] } } as const;
    const r = layoutStruct([m('x','Bool'), s, m('y','Byte'), m('arr','Array[1..3] of Bool'), m('z','Byte')], none);
    expect(offsets(r)).toEqual({ x: '0.0', s: '2.0', 's.p': '2.0', 's.q': '3.0', y: '4.0', arr: '6.0', z: '8.0' });
    expect(r.ok && r.sizeBytes).toBe(10);
    expect(r.ok && r.entries.find((e) => e.path === 'arr')!.strideBits).toBe(1);
  });
  it('String[n] occupa n+2 byte da un byte pari', () => {
    expect(offsets(layoutStruct([m('c','Char'), m('s','String[3]'), m('b','Byte')], none))).toEqual({ c: '0.0', s: '2.0', b: '7.0' });
  });
  it('dati di istanza: sezioni a byte pari, InOut complesso come puntatore, multi-istanza', () => {
    const resolve: TypeResolver = (n) => n === 'Sub' ? { kind: 'fb', sections: { input: [m('x','Int')], output: [], inOut: [], static: [] } } : null;
    const r = layoutInstance({ input: [m('a','Bool'), m('t','Timer')], output: [m('b','Bool')], inOut: [m('c','Int'), m('d','Array[1..10] of Byte')], static: [m('e','Bool'), m('inst','"Sub"')] }, resolve);
    expect(offsets(r)).toEqual({ a: '0.0', t: '2.0', b: '4.0', c: '6.0', d: '8.0', e: '14.0', inst: '16.0', 'inst.x': '16.0' });
    expect(r.ok && r.sizeBytes).toBe(18);
  });
  it('UDT sconosciuto e UDT ricorsivo', () => {
    expect(layoutStruct([m('u','"Manca"')], none)).toEqual({ ok: false, error: 'UNKNOWN_TYPE', name: 'Manca' });
    const loop: TypeResolver = (n) => n === 'A' ? { kind: 'udt', members: [m('b','"B"')] } : n === 'B' ? { kind: 'udt', members: [m('a','"A"')] } : null;
    expect(layoutStruct([m('x','"A"')], loop)).toMatchObject({ ok: false, error: 'CYCLE' });
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project s7-types`
  Expected: FAIL nei nuovi file.

- [ ] **Step 3: Implementa `address.ts` e `layout.ts`**

  Il layout lavora in bit, con un cursore e un insieme dei nomi in corso di risoluzione per scoprire i cicli.

- [ ] **Step 4: Esegui i test, typecheck e lint**

  Run: `npx vitest run --project s7-types && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/s7-types
  git commit -m "feat(s7-types): indirizzi assoluti e disposizione in memoria S7-300"
  ```

---

### Task 3: `@baaportal/catalog`: CPU S7-300 e OB

**Files:**
- Create: `packages/catalog/{package.json,tsconfig.json,vitest.config.ts}`, `packages/catalog/src/{index,types,cpus,obs}.ts`
- Test: `packages/catalog/test/catalog.test.ts`

**Interfaces:**
- Consumes: `TypedMember`, `parseType`, `layoutStruct` (Task 1–2).
- Produces:
  ```ts
  export interface CpuVersion { orderNumber: string; firmware: string[] }   // firmware dal più recente, es. ['V3.2', 'V3.1']
  export interface CpuType {
    id: string;                                     // 'cpu-315-2-pn-dp'
    name: string;                                   // 'CPU 315-2 PN/DP'
    group: 'standard' | 'compact' | 'failsafe';
    versions: CpuVersion[];                         // dalla più recente
    interfaces: { mpi: boolean; dp: boolean; pn: boolean };
    workMemoryKB: number;
    limits: { mBytes: number; timers: number; counters: number; inputBytes: number; outputBytes: number;
              maxFb: number; maxFc: number; maxDb: number; localDataBytesPerClass: number };
    retentiveMax: { mBytes: number; timers: number; counters: number };
    obs: number[];                                  // OB ammessi dalla CPU
    source: string;                                 // titolo ed eventuale URL del documento pubblico usato
  }
  export interface ObDefinition { number: number; eventKey: string; defaultName: string; startInfo: TypedMember[] }
  export const CPU_CATALOG: readonly CpuType[];
  export const OB_DEFINITIONS: readonly ObDefinition[];
  export function findCpu(id: string): CpuType | undefined;
  export function findCpuByOrderNumber(orderNumber: string): { cpu: CpuType; version: CpuVersion } | undefined;
  export function findOb(number: number): ObDefinition | undefined;
  ```

Contenuto:
- **CPU** (spec §6: "tutte le CPU S7-300 31x presenti nei manuali pubblici"):
  - standard: 312, 314, 315-2 DP, 315-2 PN/DP, 317-2 DP, 317-2 PN/DP, 319-3 PN/DP, più 316-2 DP e 318-2 DP se le loro schede tecniche pubbliche si trovano;
  - compatte: 312C, 313C, 313C-2 PtP, 313C-2 DP, 314C-2 PtP, 314C-2 DP, 314C-2 PN/DP;
  - F: 315F-2 DP, 315F-2 PN/DP, 317F-2 DP, 317F-2 PN/DP, 319F-3 PN/DP. In 1B si programma solo la parte standard, senza funzioni di sicurezza;
  - le CPU tecnologiche (T) sono escluse.
- Per ogni CPU si mettono il numero di articolo attuale e quelli precedenti trovati, con le versioni firmware.
  - Il valore di partenza, da verificare, per la CPU 315-2 PN/DP è `6ES7 315-2EH14-0AB0` con V3.2.
  - I valori si prendono dalle schede tecniche Siemens pubbliche: il manuale "S7-300 CPU 31xC e CPU 31x: Dati tecnici" e le schede prodotto.
  - Ogni CPU ha il suo `source`.
  - Un valore che non si trova nelle fonti non si inventa: la CPU, o la versione, resta fuori e lo si scrive nel rapporto.
- **OB**: 1, 10, 20, 35, 40, 80, 82, 85, 86, 100, 121, 122.
  - `eventKey` è una chiave i18n `ob.event.<n>`. Testi italiani: Ciclo del programma, Allarme dall'orologio, Allarme di ritardo, Schedulazione orologio, Allarme di processo, Errore di tempo, Allarme di diagnostica, Errore di esecuzione del programma, Guasto del telaio di montaggio, Nuovo avviamento, Errore di programmazione, Errore di accesso alla periferia.
  - `defaultName`: `Main` per OB1. Per gli altri, il testo italiano dell'evento.
  - `startInfo` sono i 20 byte delle informazioni di avvio, con i nomi e i tipi del manuale pubblico "Software di sistema per S7-300/400, funzioni standard e di sistema". OB1, per esempio: `OB1_EV_CLASS` Byte, `OB1_SCAN_1` Byte, `OB1_PRIORITY` Byte, `OB1_OB_NUMBR` Byte, `OB1_RESERVED_1` Byte, `OB1_RESERVED_2` Byte, `OB1_PREV_CYCLE` Int, `OB1_MIN_CYCLE` Int, `OB1_MAX_CYCLE` Int, `OB1_DATE_TIME` Date_And_Time.
  - Nessun commento copiato.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('ogni CPU: id unico, nome CPU 31x, numeri d\'articolo validi, OB1, fonte', () => {
    expect(new Set(CPU_CATALOG.map((c) => c.id)).size).toBe(CPU_CATALOG.length);
    for (const c of CPU_CATALOG) {
      expect(c.name).toMatch(/^CPU 31\d/);
      expect(c.versions.length).toBeGreaterThan(0);
      for (const v of c.versions) { expect(v.orderNumber).toMatch(/^6ES7 31\d-[0-9A-Z]{5}-0AB0$/); expect(v.firmware.length).toBeGreaterThan(0); }
      expect(c.obs).toContain(1);
      for (const ob of c.obs) expect(findOb(ob)).toBeDefined();
      expect(c.source.trim()).not.toBe('');
      expect(c.retentiveMax.mBytes).toBeLessThanOrEqual(c.limits.mBytes);
    }
  });
  it('CPU 315-2 PN/DP', () => {
    const { cpu } = findCpuByOrderNumber('6ES7 315-2EH14-0AB0')!;
    expect(cpu).toMatchObject({ name: 'CPU 315-2 PN/DP', group: 'standard', interfaces: { mpi: true, dp: true, pn: true } });
    expect(cpu.limits).toMatchObject({ mBytes: 2048, timers: 256, counters: 256 });
  });
  it('le informazioni di avvio di ogni OB occupano 20 byte', () => {
    for (const ob of OB_DEFINITIONS) { const r = layoutStruct(ob.startInfo, () => null); expect(r.ok && r.sizeBytes).toBe(20); }
  });
  it('OB1: nomi e tipi delle informazioni di avvio', () => {
    expect(findOb(1)!.startInfo.map((m) => `${m.name}:${formatType(m.type)}`)).toEqual([
      'OB1_EV_CLASS:Byte','OB1_SCAN_1:Byte','OB1_PRIORITY:Byte','OB1_OB_NUMBR:Byte','OB1_RESERVED_1:Byte','OB1_RESERVED_2:Byte',
      'OB1_PREV_CYCLE:Int','OB1_MIN_CYCLE:Int','OB1_MAX_CYCLE:Int','OB1_DATE_TIME:Date_And_Time']);
    expect(findOb(1)!.defaultName).toBe('Main');
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project catalog`
  Expected: FAIL.

- [ ] **Step 3: Raccogli i dati dalle fonti pubbliche e scrivi `cpus.ts` e `obs.ts`**

  - Usa WebSearch/WebFetch su documentazione Siemens pubblica: manuali e schede tecniche in PDF, pagine prodotto.
  - Non usare software Siemens, né file di progetto o librerie estratte.
  - Nel rapporto metti l'elenco delle CPU con i link usati e i valori non trovati.

- [ ] **Step 4: Esegui i test, typecheck e lint**

  Run: `npx vitest run --project catalog && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/catalog package-lock.json
  git commit -m "feat(catalog): CPU S7-300 31x e OB con informazioni di avvio, da fonti pubbliche"
  ```

---

### Task 4: `@baaportal/project`: modello formato 2, file `.baap`, creazione e rinomina

**Files:**
- Modify: `packages/project/src/{model,baapFile,index}.ts`, `packages/project/package.json` (dipendenze `@baaportal/s7-types`, `@baaportal/catalog`)
- Create: `packages/project/src/{plc,members}.ts`
- Test: `packages/project/test/{model,baapFile,plc}.test.ts` (aggiorna quelli del piano 1A)

**Interfaces:**
- Consumes: `@baaportal/s7-types` (Task 1–2), `CpuType`, `findOb` (Task 3).
- Produces:
  ```ts
  export const FORMAT_VERSION = 2;
  export type Language = 'AWL'|'KOP'|'FUP'|'SCL';
  export interface Project { formatVersion: 2; meta: ProjectMeta; devices: PlcDevice[] }
  export interface PlcDevice {
    id: string; name: string;
    cpu: { typeId: string; orderNumber: string; firmware: string };
    properties: CpuProperties;
    tagTables: TagTable[]; udts: Udt[]; blocks: Block[];
    groups: { blocks: string[]; tags: string[]; types: string[] };  // percorsi 'A' e 'A/B'
  }
  export interface CpuProperties {
    comment: string;
    pn?: { ipAddress: string; subnetMask: string; useRouter: boolean; routerAddress: string };
    mpiAddress: number; dpAddress?: number;
    cycle: { maxCycleMs: number; minCycleMs: number; commLoadPercent: number };
    clockMemory: { enabled: boolean; byte: number };
    retentivity: { mBytes: number; timers: number; counters: number };
    cyclicInterrupts: { ob35Ms: number };
  }
  export interface TagTable { id: string; name: string; group: string; tags: Tag[]; constants: UserConstant[] }
  export interface Tag { id: string; name: string; type: string; address: string; hmi: boolean; comment: string }
  export interface UserConstant { id: string; name: string; type: string; value: string; comment: string }
  export interface Member { id: string; name: string; type: string; initial?: string; comment: string;
    members?: Member[]; overrides?: Record<string, string>; readOnly?: boolean }
  export interface Udt { id: string; name: string; number: number; group: string; comment: string; author: string; family: string; version: string; members: Member[] }
  export interface BlockHeader { title: string; comment: string; author: string; family: string; headerName: string; version: string }
  export interface Network { id: string; title: string; comment: string; source: string }
  export interface BlockInterface { input: Member[]; output: Member[]; inOut: Member[]; static: Member[]; temp: Member[]; returnType: string }
  export interface DbAttributes { unlinked: boolean; readOnly: boolean; nonRetain: boolean }
  interface BlockBase { id: string; number: number; name: string; group: string; header: BlockHeader; knowHowProtected: boolean }
  export interface CodeBlock extends BlockBase { kind: 'OB'|'FB'|'FC'; language: Language; interface: BlockInterface; networks: Network[] }
  export interface GlobalDb extends BlockBase { kind: 'DB'; members: Member[]; attributes: DbAttributes }
  export interface InstanceDb extends BlockBase { kind: 'IDB'; instanceOf: string; overrides: Record<string, string>; attributes: DbAttributes }
  export type Block = CodeBlock | GlobalDb | InstanceDb;
  export type ObjectRef =
    | { kind: 'device'; deviceId: string }
    | { kind: 'block' | 'udt' | 'tagTable'; deviceId: string; id: string }
    | { kind: 'tag' | 'constant'; deviceId: string; tableId: string; id: string }
    | { kind: 'member'; deviceId: string; ownerKind: 'block' | 'udt'; ownerId: string; memberId: string };

  // plc.ts
  export type NewId = () => string;   // predefinito: () => crypto.randomUUID()
  export function createPlcDevice(a: { cpu: CpuType; orderNumber: string; firmware: string; name: string;
    texts: { defaultTagTable: string }; newId?: NewId }): PlcDevice;
  export function createCodeBlock(a: { kind: 'OB'|'FB'|'FC'; number: number; name: string; language: Language; newId?: NewId }): CodeBlock;
  export function createGlobalDb(a: { number: number; name: string; newId?: NewId }): GlobalDb;
  export function createInstanceDb(a: { number: number; name: string; instanceOf: string; newId?: NewId }): InstanceDb;
  export function createTagTable(name: string, newId?: NewId): TagTable;
  export function createUdt(a: { name: string; number: number; newId?: NewId }): Udt;
  export function symbolNames(device: PlcDevice): string[];          // tag, costanti, blocchi, UDT
  export function uniqueName(base: string, taken: Iterable<string>): string;
  export function nextFreeNumber(device: PlcDevice, kind: 'OB'|'FB'|'FC'|'DB'|'UDT', max: number): number | null; // DB e IDB condividono i numeri
  export function findDevice(p: Project, id: string): PlcDevice | undefined;
  export function findBlock(d: PlcDevice, id: string): Block | undefined;   // findUdt, findTagTable allo stesso modo
  export function renameWithReferences(device: PlcDevice, ref: ObjectRef, newName: string): void; // modifica sul posto (ricetta immer)
  // members.ts
  export function toTypedMembers(members: Member[]): TypedMember[];  // salta i membri con tipo non valido
  export function typeResolver(device: PlcDevice): TypeResolver;     // UDT per nome; FB per nome (sezioni Input/Output/InOut/Static)
  export function memberPath(parent: string, child: string | number[]): string; // 'a' + 'b' → 'a.b'; 'a' + [1,2] → 'a[1,2]'
  ```

Regole:
- **File zip, formato 2**. Tutti i JSON hanno 2 spazi di indentazione e sono UTF-8, con i nomi dei file basati sull'id e non sul nome:
  - `baaportal.json` (manifesto, come nel piano 1A, con `formatVersion: 2`);
  - `project.json` = `{ formatVersion, meta, devices: [{ id, name }] }`;
  - `plc/<deviceId>/device.json` = `{ id, name, cpu, properties, groups }`;
  - `plc/<deviceId>/tags/<tableId>.json`;
  - `plc/<deviceId>/types/<udtId>.json`;
  - `plc/<deviceId>/blocks/<blockId>.json`.
- **Lettura**:
  - formato 1 → `devices: []`;
  - formato > 2 → `NEWER_FORMAT`;
  - schemi zod con oggetti `z.looseObject`, così le chiavi sconosciute restano negli oggetti letti e vengono riscritte;
  - danno `INVALID_SCHEMA`: id doppi nello stesso dispositivo, file di un dispositivo elencato ma mancante, `kind` sconosciuto;
  - i riferimenti rotti, come un `instanceOf` mancante o un UDT inesistente, **non** impediscono l'apertura: li segnala Task 5.
- `createPlcDevice` con valori predefiniti:
  - `comment: ''`;
  - `pn` solo se `cpu.interfaces.pn`, con IP `192.168.0.1`, maschera `255.255.255.0`, `useRouter: false`, `routerAddress: ''`;
  - `mpiAddress: 2`, `dpAddress: 2` solo se `cpu.interfaces.dp`;
  - ciclo `{ 150, 0, 20 }`, merker di clock `{ false, 0 }`, ritenzione `{ 16, 0, 8 }`, `ob35Ms: 100`;
  - una tabella `texts.defaultTagTable` vuota;
  - OB1 `Main` in AWL, con `temp` = informazioni di avvio dell'OB1 (`readOnly: true`, commento vuoto) e un segmento vuoto;
  - gruppi vuoti.
- `createCodeBlock` con kind OB prende le informazioni di avvio da `findOb(number)`. Le intestazioni hanno `version: '0.1'` e gli altri campi vuoti. `returnType` vale `Void` per gli FC e `''` per gli altri.
- `uniqueName` restituisce `base` se libero, altrimenti applica `incrementName` finché trova un nome libero. Il confronto è con `sameName`.
- `nextFreeNumber` cerca il più piccolo numero libero da 1 a `max`. Restituisce `null` se sono tutti occupati.
- `renameWithReferences`:
  - per un UDT sostituisce `"Vecchio"` con `"Nuovo"` nei tipi di tutti i membri (interfacce, UDT, DB, anche dentro `Array[..] of "…"`);
  - per un FB aggiorna `instanceOf` dei DB di istanza e i tipi dei membri multi-istanza;
  - tutti gli altri oggetti cambiano solo il nome.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // baapFile.test.ts
  it('un file del formato 1 si apre come formato 2 senza dispositivi', () => { /* zip formato 1 come nel piano 1A */ expect(readBaap(v1).devices).toEqual([]); });
  it('andata e ritorno di un progetto completo', () => { /* device 315-2 PN/DP + tabella con 2 tag e 1 costante + UDT con Struct + FB con multi-istanza + DB + IDB */
    expect(readBaap(writeBaap(p, { appVersion: '0.2.0' }))).toEqual(p); });
  it('un JSON per oggetto con percorsi basati sugli id', () => {
    expect(Object.keys(unzipSync(writeBaap(p, { appVersion: 'x' }))).sort()).toEqual([
      'baaportal.json', `plc/${dev.id}/blocks/${ob1.id}.json`, /* … */ `plc/${dev.id}/device.json`, `plc/${dev.id}/tags/${table.id}.json`, `plc/${dev.id}/types/${udt.id}.json`, 'project.json'].sort());
  });
  it('le chiavi sconosciute si conservano', () => { /* aggiunge meta.extra e tags[0].extra nel JSON → read → write → read: ancora presenti */ });
  it('id doppi, file mancante, kind sconosciuto → INVALID_SCHEMA; formato 3 → NEWER_FORMAT', () => { /* … */ });
  // plc.test.ts
  it('createPlcDevice con i valori predefiniti', () => {
    const d = createPlcDevice({ cpu: cpu315pn, orderNumber: '6ES7 315-2EH14-0AB0', firmware: 'V3.2', name: 'PLC_1', texts: { defaultTagTable: 'Tabella delle variabili standard' }, newId: seq() });
    expect(d.properties).toEqual({ comment: '', pn: { ipAddress: '192.168.0.1', subnetMask: '255.255.255.0', useRouter: false, routerAddress: '' }, mpiAddress: 2, dpAddress: 2,
      cycle: { maxCycleMs: 150, minCycleMs: 0, commLoadPercent: 20 }, clockMemory: { enabled: false, byte: 0 }, retentivity: { mBytes: 16, timers: 0, counters: 8 }, cyclicInterrupts: { ob35Ms: 100 } });
    expect(d.tagTables.map((t) => t.name)).toEqual(['Tabella delle variabili standard']);
    const ob1 = d.blocks[0] as CodeBlock;
    expect([ob1.kind, ob1.number, ob1.name, ob1.language, ob1.interface.temp.length, ob1.interface.temp.every((m) => m.readOnly), ob1.networks.length]).toEqual(['OB', 1, 'Main', 'AWL', 10, true, 1]);
  });
  it('nextFreeNumber: buchi, DB e IDB condivisi, pieno → null', () => { /* FB1,FB2,FB4 → 3; DB1 + IDB2 → DB 3; max 2 con FB1,FB2 → null */ });
  it('uniqueName', () => { expect(uniqueName('Motore', ['motore', 'Motore_1'])).toBe('Motore_2'); expect(uniqueName('Nastro', ['Motore'])).toBe('Nastro'); });
  it('rinomina di un UDT aggiorna tutti i riferimenti', () => {
    /* "Asse" usato in FB.static (tipo "Asse"), in un altro UDT (Array[1..2] of "Asse"), in un DB globale */
    renameWithReferences(d, { kind: 'udt', deviceId: d.id, id: asse.id }, 'Asse2');
    expect(types(d)).toEqual(['"Asse2"', 'Array[1..2] of "Asse2"', '"Asse2"']);
  });
  it('rinomina di un FB aggiorna DB di istanza e multi-istanze', () => { /* … instanceOf === 'Nastro2', membro static tipo '"Nastro2"' */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project project`
  Expected: FAIL.

- [ ] **Step 3: Implementa `model.ts`, `baapFile.ts`, `plc.ts` e `members.ts`**

  Aggiorna i test del piano 1A che si aspettavano `formatVersion: 1`. `createProject` crea un progetto formato 2 con `devices: []`.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS. Anche `ui` e `desktop` compilano. Dove usano `formatVersion: 1` va aggiornato.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/project packages/ui apps/desktop package-lock.json
  git commit -m "feat(project): formato .baap 2 con dispositivi PLC, tabelle, UDT e blocchi; migrazione dal formato 1"
  ```

---

### Task 5: `@baaportal/project`: controlli e diagnostica

**Files:**
- Create: `packages/project/src/checks.ts`
- Modify: `packages/project/src/index.ts`
- Test: `packages/project/test/checks.test.ts`

**Interfaces:**
- Consumes: modello e `members.ts` (Task 4), `@baaportal/s7-types`, `CpuType` (Task 3).
- Produces:
  ```ts
  export type DiagnosticCode =
    | 'NAME_INVALID' | 'NAME_DUPLICATE' | 'TYPE_INVALID' | 'TYPE_NOT_ALLOWED' | 'TYPE_UNKNOWN' | 'TYPE_CYCLE'
    | 'ADDRESS_INVALID' | 'ADDRESS_TYPE_MISMATCH' | 'ADDRESS_OUT_OF_RANGE' | 'ADDRESS_OVERLAP'
    | 'VALUE_INVALID' | 'NUMBER_DUPLICATE' | 'NUMBER_OUT_OF_RANGE' | 'OB_NOT_SUPPORTED'
    | 'INSTANCE_FB_MISSING' | 'HEADER_INVALID' | 'PROPERTY_INVALID' | 'CPU_UNKNOWN';
  export interface Diagnostic { severity: 'error' | 'warning'; code: DiagnosticCode; ref: ObjectRef;
    field?: 'name' | 'type' | 'address' | 'value' | 'number' | 'header' | 'property'; property?: string; params?: Record<string, string> }
  export function checkDevice(device: PlcDevice, cpu: CpuType | undefined): Diagnostic[];
  export function memberAllowed(owner: 'FB'|'FC'|'OB'|'DB'|'UDT', section: 'input'|'output'|'inOut'|'static'|'temp'|'return'|'members', type: DataType, isFb: (name: string) => boolean): boolean;
  ```

Regole:
- **Spazio dei simboli** della CPU: tag, costanti, blocchi (anche DB di istanza) e UDT hanno nomi unici fra tutti, senza distinguere maiuscole (`sameName`). Ogni copia di un nome doppio dà `NAME_DUPLICATE` (`error`, campo `name`).
- **Nomi locali**: unici nell'intera interfaccia di un blocco, in tutte le sezioni, e dentro ogni struct. Per le tabelle delle variabili: unici fra le tabelle. Gruppi: unici fra gruppi fratelli.
- **Tipi ammessi per sezione** (`TYPE_NOT_ALLOWED`):

  | Proprietario / sezione | Ammessi |
  |---|---|
  | FB/FC Input | elementari, `String`, `Date_And_Time`, `Array`, `Struct`, UDT, `Timer`, `Counter`, `Block_*`; FC anche `Pointer`, `Any` |
  | FB/FC Output | elementari, complessi (come sopra), FC anche `Pointer`, `Any` |
  | FB/FC InOut | elementari, complessi, `Pointer`, `Any` |
  | FB Static | elementari, complessi, multi-istanza (`"FB"`) |
  | Temp (OB/FB/FC) | elementari, complessi, `Any` |
  | FC Return | `Void` o elementari |
  | DB / UDT | elementari, complessi |

  Il tag della tabella può avere solo un tipo elementare, `Timer` o `Counter`. La costante utente ha un tipo elementare.
- **Indirizzi dei tag**:
  - sintassi errata → `ADDRESS_INVALID`;
  - tipo incompatibile → `ADDRESS_TYPE_MISMATCH`;
  - fuori dai limiti della CPU (`mBytes`, `timers`, `counters`, `inputBytes` per I/PI, `outputBytes` per Q/PQ) → `ADDRESS_OUT_OF_RANGE`;
  - due tag che si sovrappongono, in qualunque tabella → `ADDRESS_OVERLAP` (`warning`) su entrambi, con `params.other` = nome dell'altro.
- **Valori**: `initial`, `overrides` e valore delle costanti con `parseLiteral` → `VALUE_INVALID`.
- **Numeri**:
  - doppi per tipo di blocco → `NUMBER_DUPLICATE` (DB e IDB insieme, UDT a parte);
  - FB, FC e DB oltre `limits.maxFb/maxFc/maxDb`, o sotto 1 → `NUMBER_OUT_OF_RANGE`;
  - OB non in `cpu.obs` → `OB_NOT_SUPPORTED`.
- **Riferimenti**:
  - DB di istanza con `instanceOf` che non è un FB → `INSTANCE_FB_MISSING`;
  - UDT o FB sconosciuto in un tipo → `TYPE_UNKNOWN`;
  - ricorsione (UDT che contiene se stesso, FB che si contiene come multi-istanza) → `TYPE_CYCLE`.
- **Intestazione dei blocchi**: `headerName`, `family` e `author` devono rispettare `^[A-Za-z0-9_]{0,8}$`, `version` deve rispettare `^(\d|1[0-5])\.(\d|1[0-5])$`. Errore: `HEADER_INVALID` con `property`.
- **Proprietà della CPU** (`PROPERTY_INVALID` con `property` = percorso, per esempio `pn.ipAddress`):
  - IP valido, con primo ottetto tra 1 e 223 escluso 127, e parte host né tutta a zero né tutta a uno;
  - maschera contigua tra `128.0.0.0` e `255.255.255.252`;
  - router nella stessa sottorete se `useRouter`;
  - MPI tra 0 e 126, DP tra 1 e 125;
  - tempo di ciclo massimo tra 1 e 6000 ms, minimo tra 0 e il massimo;
  - carico di comunicazione tra 5 e 50 %;
  - byte del merker di clock tra 0 e `mBytes - 1`;
  - ritenzione entro `retentiveMax`;
  - OB35 tra 1 e 60000 ms.
- `cpu` undefined, cioè tipo di CPU non nel catalogo → un solo `CPU_UNKNOWN`; i controlli che dipendono dai limiti si saltano.

- [ ] **Step 1: Scrivi i test che falliscono**

  Uno scenario per codice, più questi casi:

  ```ts
  it('nomi doppi fra tag, costante, blocco e UDT senza distinguere maiuscole', () => {
    /* tag 'Motore', costante 'MOTORE', FB 'motore' */
    expect(codes(checkDevice(d, cpu))).toEqual(['NAME_DUPLICATE', 'NAME_DUPLICATE', 'NAME_DUPLICATE']);
  });
  it('sovrapposizione: avviso su entrambi con il nome dell\'altro', () => {
    /* A %MW0 Int, B %M1.3 Bool */
    expect(checkDevice(d, cpu).map((x) => [x.code, x.severity, x.params?.other])).toEqual([['ADDRESS_OVERLAP', 'warning', 'B'], ['ADDRESS_OVERLAP', 'warning', 'A']]);
  });
  it('limiti della CPU: %M2048.0 fuori dalla 315-2 PN/DP', () => { /* ADDRESS_OUT_OF_RANGE */ });
  it('tipi per sezione', () => {
    expect(memberAllowed('FB', 'input', type('Pointer'), no)).toBe(false);
    expect(memberAllowed('FC', 'input', type('Pointer'), no)).toBe(true);
    expect(memberAllowed('FB', 'static', type('"Nastro"'), (n) => n === 'Nastro')).toBe(true);
    expect(memberAllowed('FC', 'static', type('Int'), no)).toBe(false);
    expect(memberAllowed('FC', 'return', type('Struct'), no)).toBe(false);
    expect(memberAllowed('DB', 'members', type('Timer'), no)).toBe(false);
  });
  it('file con riferimenti rotti: diagnostica, nessuna eccezione', () => {
    /* IDB con instanceOf 'Manca', membro di tipo '"NonCè"', UDT A↔B ricorsivi */
    expect(codes(checkDevice(d, cpu))).toEqual(expect.arrayContaining(['INSTANCE_FB_MISSING', 'TYPE_UNKNOWN', 'TYPE_CYCLE']));
  });
  it('proprietà CPU non valide', () => { /* ip '192.168.0.0' maschera '255.0.255.0' clock byte 2048 → tre PROPERTY_INVALID con property 'pn.ipAddress','pn.subnetMask','clockMemory.byte' */ });
  it('un dispositivo nuovo è senza errori', () => expect(checkDevice(createPlcDevice(/* 315 PN */), cpu)).toEqual([]));
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project project`
  Expected: FAIL.

- [ ] **Step 3: Implementa `checks.ts`**

  Una funzione per ogni gruppo di regole, unite in `checkDevice`. Le sovrapposizioni si cercano con un ordinamento per area e bit iniziale, non con un doppio ciclo su tutte le coppie.

- [ ] **Step 4: Esegui test, typecheck e lint**

  Run: `npx vitest run --project project && npm run typecheck && npm run lint`
  Expected: PASS. Una tabella di 5000 tag va controllata in meno di 200 ms: aggiungi un test con un tempo misurato e una soglia larga, 1 s.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/project
  git commit -m "feat(project): controlli di nomi, tipi, indirizzi, numeri, riferimenti e proprietà CPU"
  ```

---

### Task 6: Annulla/ripeti, revisioni del documento, campi a conferma

**Files:**
- Create: `packages/ui/src/state/history.ts`, `packages/ui/src/components/CommitField.tsx`
- Modify: `packages/ui/src/state/store.ts`, `packages/ui/src/services/projectService.ts`, `packages/ui/src/commands/{commands,useShortcuts}.ts`, `packages/ui/src/project/inspector/ProjectProperties.tsx`, `packages/ui/src/project/Toolbar.tsx`, `packages/ui/package.json` (aggiungi `immer`)
- Test: `packages/ui/test/{history,store,projectService,commands}.test.ts`, `packages/ui/test/commitField.test.tsx`

**Interfaces:**
- Consumes: `Project` (Task 4).
- Produces:
  ```ts
  // store.ts
  export interface OpenDoc { project: Project; filePath: string; dirty: boolean; revision: number; savedRevision: number }
  export interface HistoryEntry { labelKey: string; patches: Patch[]; inverse: Patch[]; before: number; after: number }
  // in AppState:
  history: { past: HistoryEntry[]; future: HistoryEntry[] };          // azzerata da setDoc
  edit(labelKey: string, recipe: (draft: Project) => void): boolean;  // false se la ricetta non cambia nulla (nessuna voce)
  undo(): void; redo(): void;
  markSaved(a: { filePath: string; revision: number; modifiedAt: string }): void; // non crea voci di cronologia
  // rimossi: replaceDoc, updateMeta
  export const HISTORY_LIMIT = 100;
  // commands.ts
  export interface Command { /* … */ shortcut?: string; altShortcuts?: string[] }
  // CommitField.tsx
  export function CommitInput(p: { id?: string; value: string; onCommit(v: string): void; validate?(v: string): string | null; 'aria-label'?: string; readOnly?: boolean }): JSX.Element;
  export function CommitTextarea(p: { id?: string; value: string; onCommit(v: string): void; rows?: number }): JSX.Element;
  ```

Regole:
- **Revisioni**:
  - ogni `edit` riuscito prende un nuovo numero da un contatore che cresce sempre, e lo assegna a `revision`;
  - `undo` riporta `revision` a `entry.before`, `redo` a `entry.after`;
  - `dirty = revision !== savedRevision`, aggiornato a ogni cambiamento;
  - `setDoc` prende l'`OpenDoc` così com'è, ricalcola `dirty` e svuota la cronologia; il contatore riparte da `revision + 1`;
  - chi apre o crea un documento passa `revision: 0, savedRevision: 0`. Un documento recuperato (Task 15) passa `revision: 1, savedRevision: 0`.
- **Cronologia**:
  - `produceWithPatches` di immer (`enablePatches()` una volta);
  - un nuovo `edit` svuota `future`;
  - oltre `HISTORY_LIMIT` voci si scarta la più vecchia.
- **`markSaved`** imposta `filePath`, `savedRevision = revision` (quello catturato) e `project.meta.modifiedAt`, senza creare voci.
- **Salvataggio** (`saveTo`):
  - prima di scrivere cattura `revision` e il progetto da scrivere;
  - dopo, se `docLoadId` non è cambiato, chiama `markSaved` con quella revisione;
  - così una modifica fatta durante la scrittura lascia il documento "modificato";
  - i test della corsa di salvataggio del piano 1A (C2) restano e passano.
- **`edit` nei campi esistenti**: autore e commento del progetto passano da `CommitInput`/`CommitTextarea` e confermano su uscita dal campo o Invio (Invio solo per l'input). Esc annulla. `validate` mostra il messaggio sotto il campo e blocca la conferma.
- **Comandi**:
  - `edit.undo`: `Mod+Z`;
  - `edit.redo`: `Mod+Y` e `altShortcuts: ['Mod+Shift+Z']`;
  - attivi se c'è qualcosa da annullare o ripetere;
  - il titolo del pulsante della barra degli strumenti è `"<Annulla>: <t(labelKey)>"`;
  - `useShortcuts` considera anche `altShortcuts`. Nei campi di testo resta valida solo `Mod+S`, così annulla e ripeti dentro un campo restano quelli del campo.
- Esporta `handleShortcutKeydown(e: KeyboardEvent, ctx: CommandContext): boolean` da `useShortcuts.ts`. La userà la finestra separata (Task 10).

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('edit, undo, redo e dirty seguono la revisione salvata', () => {
    s.setDoc({ project, filePath: '/p.baap', dirty: false, revision: 0, savedRevision: 0 });
    s.edit('history.author', (p) => { p.meta.author = 'A'; });
    expect(get().doc!.dirty).toBe(true);
    s.undo(); expect(get().doc!.dirty).toBe(false); expect(get().doc!.project.meta.author).toBe(project.meta.author);
    s.redo(); expect(get().doc!.project.meta.author).toBe('A');
  });
  it('salvare e poi annullare rimette "modificato"', () => { /* edit → markSaved(revision) → dirty false → undo → dirty true */ });
  it('una ricetta che non cambia nulla non crea voci', () => { expect(s.edit('x', () => {})).toBe(false); expect(get().history.past).toHaveLength(0); });
  it('nuovo edit svuota future; limite di 100 voci', () => { /* 101 edit → past.length 100 */ });
  it('modifica durante il salvataggio: resta modificata e non va persa', async () => { /* scrittura differita nel FakeBridge, edit durante l'attesa → dirty true e valore presente */ });
  it('Mod+Z e Mod+Y, Mod+Shift+Z su macOS', async () => { /* renderApp con progetto, edit, tasti → valori */ });
  it('dentro un campo Mod+Z non annulla il progetto', async () => { /* focus su input → Mod+Z → history.past invariata */ });
  it('CommitInput conferma su blur e Invio, Esc annulla, validate blocca', async () => { /* … onCommit chiamato 2 volte con i valori giusti */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL nei nuovi test.

- [ ] **Step 3: Implementa store, cronologia, servizio, comandi e campi**

  Sostituisci ogni uso di `replaceDoc` e `updateMeta` con `markSaved` ed `edit`.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui package-lock.json
  git commit -m "feat(ui): annulla/ripeti con patch immer, revisioni del documento e campi a conferma"
  ```

---

### Task 7: Bridge: appunti, domanda sì/no, file di recupero, finestre degli editor

**Files:**
- Create: `apps/desktop/src/main/recoveryStore.ts`
- Modify: `packages/ui/src/bridge.ts`, `packages/ui/test/fakeBridge.ts`, `apps/desktop/src/{main/ipc.ts,main/index.ts,preload/index.ts,shared/rawBridge.ts,renderer/createBridge.ts}`
- Test: `apps/desktop/test/recoveryStore.test.ts`, `apps/desktop/e2e/bridge.spec.ts` (esteso), `apps/desktop/e2e/window-guards.spec.ts` (esteso), `apps/desktop/e2e/helpers.ts` (`launchApp({ env })` per variabili d'ambiente in più; `userData` riutilizzabile con `launchApp({ userData })` per il Task 16)

**Interfaces:**
- Consumes: bridge e IPC del piano 1A (`registerIpc`, `toIpcResult`, `writeFileAtomic`, `isTrustedFrame`).
- Produces (aggiunte a `BaaBridge`):
  ```ts
  export interface QuestionTexts { title: string; message: string; yes: string; no: string }
  export interface RecoveryInfo { originalPath: string; projectName: string; savedAt: string }
  export interface RecoveryEntry { key: string; info: RecoveryInfo }
  clipboardWriteText(text: string): void;
  clipboardReadText(): Promise<string>;
  askQuestion(texts: QuestionTexts): Promise<boolean>;          // finestra nativa, true = sì
  recoveryWrite(key: string, data: Uint8Array, info: RecoveryInfo): Promise<void>;
  recoveryList(): Promise<RecoveryEntry[]>;
  recoveryRead(key: string): Promise<Uint8Array>;
  recoveryDelete(key: string): Promise<void>;
  testOverrides(): Promise<{ recoveryIntervalMs?: number }>;   // sempre {} nelle build pacchettizzate
  // recoveryStore.ts (main, testabile con una cartella temporanea)
  export const RECOVERY_KEY = /^[a-z0-9-]{1,64}$/;
  export function writeRecovery(dir: string, key: string, data: Uint8Array, info: RecoveryInfo): Promise<void>;
  export function listRecovery(dir: string): Promise<RecoveryEntry[]>;   // ignora file incompleti o con JSON rotto
  export function readRecovery(dir: string, key: string): Promise<Uint8Array>;
  export function deleteRecovery(dir: string, key: string): Promise<void>;  // nessun errore se non esiste
  ```

Regole:
- **Canali IPC**, tutti sotto il controllo del frame mittente:
  - `clipboard:write-text` (send);
  - `clipboard:read-text`;
  - `dialog:question`: `showMessageBox` con `buttons: [yes, no]`, `defaultId: 0`, `cancelId: 1`;
  - `recovery:write` e `recovery:read`, con `IpcResult` come `fs:*`, quindi `createBridge` ricostruisce gli errori;
  - `recovery:list`;
  - `recovery:delete`.
- **Recupero**:
  - file in `join(app.getPath('userData'), 'recovery')`, cioè `<key>.baap` e `<key>.json`;
  - scrittura atomica con `writeFileAtomic`, prima il `.baap`, poi il `.json`;
  - una `key` che non rispetta `RECOVERY_KEY` lancia un `Error` con `code: 'INVALID_KEY'`, così non si esce mai dalla cartella.
- **`app:test-overrides`** restituisce `{ recoveryIntervalMs: Number(process.env.BAA_RECOVERY_MS) }` solo se `!app.isPackaged` e c'è `BAA_USER_DATA`, come l'hook di test del piano 1A. Altrimenti `{}`.
- **Finestre degli editor**:
  - `setWindowOpenHandler` permette solo `url === 'about:blank'` con `frameName` che rispetta `/^baa-editor-[A-Za-z0-9-]+$/`, con `overrideBrowserWindowOptions`: `{ width: 1000, height: 700, minWidth: 480, minHeight: 320, title: 'BaaPortal', autoHideMenuBar: true }`;
  - tutto il resto resta `deny`;
  - su `did-create-window` la finestra figlia ha `setMenu(null)`, `will-navigate` sempre bloccato e `setWindowOpenHandler` → `deny`;
  - quando la finestra principale arriva a `closed`, tutte le finestre degli editor rimaste vengono distrutte;
  - la finestra figlia non usa IPC: il codice che la anima è quello della finestra principale.
- `FakeBridge`: appunti in memoria (`clipboard: string`), `questionAnswers: boolean[]` e `questions: QuestionTexts[]`, e una mappa `recovery`.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // recoveryStore.test.ts (cartella temporanea)
  it('scrive, elenca, legge ed elimina', async () => { /* write k1 → list = [{ key:'k1', info }] → read = data → delete → list [] */ });
  it('chiave non valida rifiutata', async () => { await expect(writeRecovery(dir, '../x', d, info)).rejects.toMatchObject({ code: 'INVALID_KEY' }); });
  it('un .json rotto o senza .baap non compare', async () => { /* … */ });
  // e2e bridge.spec.ts
  test('appunti e recupero attraverso il bridge', async () => { /* clipboardWriteText('a\tb') → clipboardReadText() === 'a\tb'; recoveryWrite/list/read/delete */ });
  test('testOverrides restituisce l\'intervallo di BAA_RECOVERY_MS', async () => { /* launchApp con env BAA_RECOVERY_MS=500 → { recoveryIntervalMs: 500 }; senza → {} */ });
  // e2e window-guards.spec.ts
  test('window.open about:blank baa-editor-* apre una finestra; altri URL o nomi negati', async () => {
    /* page.evaluate(() => { (window as any).__w = window.open('', 'baa-editor-x'); }) → 2 finestre;
       window.open('', 'altro') e window.open('https://example.com', 'baa-editor-y') → sempre 2;
       chiudendo la principale (stub "Non salvare") si chiudono tutte */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project desktop && npm run e2e`
  Expected: FAIL nei nuovi test.

- [ ] **Step 3: Implementa main, preload, `rawBridge`, `createBridge`, `BaaBridge` e `FakeBridge`**

- [ ] **Step 4: Esegui unit ed e2e, typecheck e lint**

  Run: `npm test && npm run e2e && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop packages/ui
  git commit -m "feat(desktop): appunti, domanda sì/no, file di recupero e finestre per gli editor staccati"
  ```

---

### Task 8: Albero del PLC, vista dettagli, dialoghi "Aggiungi"

**Files:**
- Create: `packages/ui/src/project/navigation/treeIds.ts`, `packages/ui/src/project/dialogs/{AddDeviceDialog,AddBlockDialog}.tsx`, `packages/ui/src/components/Dialog.tsx`, `packages/ui/src/icons/objects.tsx`
- Modify: `packages/ui/src/project/navigation/{treeModel.ts,ProjectTree.tsx,DetailsView.tsx}`, `packages/ui/src/state/store.ts` (`selection: string | null`), `packages/ui/src/commands/commands.ts` (`insert.device`, `insert.block`), `packages/ui/src/i18n/{it,en}.json`, `packages/ui/src/portal/PortalView.tsx` (le operazioni "Aggiungi nuovo dispositivo" e "Aggiungi nuovo blocco" ora sono attive con un progetto aperto), `packages/ui/package.json` (aggiungi `@baaportal/s7-types` e `@baaportal/catalog`)
- Test: `packages/ui/test/{treeModel.test.tsx,projectTree.test.tsx,detailsView.test.tsx,addDevice.test.tsx,addBlock.test.tsx}`

**Interfaces:**
- Consumes: store con `edit` (Task 6); `createPlcDevice`, `createCodeBlock`, `createGlobalDb`, `createInstanceDb`, `createTagTable`, `createUdt`, `nextFreeNumber`, `uniqueName`, `symbolNames` (Task 4); `CPU_CATALOG`, `OB_DEFINITIONS` (Task 3).
- Produces:
  ```ts
  // treeIds.ts: costruttori e lettura degli id dei nodi
  export const ids: {
    plc(dev: string): string;                     // 'plc:<dev>'
    folder(dev: string, f: PlcFolder): string;     // 'plc:<dev>:<f>'
    group(dev: string, area: 'blocks'|'tags'|'types', path: string): string;  // 'plc:<dev>:<area>:group:<path>'
    block(dev: string, id: string): string;        // 'plc:<dev>:block:<id>'
    tagTable(dev: string, id: string): string; udt(dev: string, id: string): string;
  };
  export type PlcFolder = 'device-config'|'online-diag'|'blocks'|'blocks-add'|'system-blocks'|'sources'|'tags'|'tags-all'|'tags-add'|'types'|'types-add'|'watch'|'backup'|'prog-info';
  export type ParsedNodeId = { kind: 'static'; id: string } | { kind: 'plc'; dev: string } | { kind: 'folder'; dev: string; folder: PlcFolder }
    | { kind: 'group'; dev: string; area: 'blocks'|'tags'|'types'; path: string } | { kind: 'block'|'tagTable'|'udt'; dev: string; id: string };
  export function parseNodeId(id: string): ParsedNodeId;
  export function nodeIdForRef(ref: ObjectRef): string | null;
  // treeModel.ts
  export interface TreeNode { id: string; labelKey: string; label?: string; icon: IconName; enabled: boolean; children: TreeNode[]; ref?: ObjectRef; dropArea?: 'blocks'|'tags'|'types' }
  export function buildTree(doc: OpenDoc | null): { project: TreeNode | null; onlineAccess: TreeNode };
  // dialoghi
  export function AddDeviceDialog(p: { onClose(): void }): JSX.Element;
  export function AddBlockDialog(p: { deviceId: string; onClose(): void }): JSX.Element;
  ```

Regole:
- **Albero** (spec §8.2): sotto ogni dispositivo, in quest'ordine:
  - Configurazione dispositivi (disattivato);
  - Online e diagnostica (disattivato);
  - Blocchi di programma, con dentro: Aggiungi nuovo blocco, gruppi, blocchi, Blocchi di sistema (vuoto);
  - Sorgenti esterne (disattivato);
  - Variabili PLC, con dentro: Mostra tutte le variabili, Aggiungi nuova tabella delle variabili, gruppi, tabelle;
  - Tipi di dati PLC, con dentro: Aggiungi nuovo tipo di dati, gruppi, UDT;
  - Tabelle di controllo e forzamento (disattivato);
  - Backup online (disattivato);
  - Informazioni sul programma (disattivato).
- **Etichette**:
  - dispositivo `PLC_1 [CPU 315-2 PN/DP]`;
  - blocchi `Main [OB1]`, `Nastro [FB1]`, `Dati [DB1]`, e anche i DB di istanza come `Nastro_DB [DB2]`;
  - tabelle `Tabella delle variabili standard [3]`, dove 3 è il numero di tag;
  - UDT col solo nome.
- Ordinamento: prima i gruppi, poi gli oggetti, per nome con `localeCompare` e `sensitivity: 'base'`.
- I gruppi annidati vengono dai percorsi `A/B`.
- "Aggiungi nuovo dispositivo" diventa attivo e apre `AddDeviceDialog`.
- **Icone degli oggetti**: SVG nostri, con un colore per tipo:
  - OB `#7b4fbf`;
  - FB `#2f6fd0`;
  - FC `#2e9a4f`;
  - DB `#b07a2a`, IDB uguale con un punto;
  - UDT `#1e8c8c`;
  - tabella variabili `#d9822b`;
  - gruppo cartella grigia;
  - CPU.
- **Doppio clic o Invio su un nodo "Aggiungi…"** esegue l'aggiunta:
  - tabella: `uniqueName('Tabella delle variabili_1', …)`. Il nome base viene da i18n, in inglese `Tag table_1`;
  - UDT: `uniqueName('Tipo di dati utente_1', …)`, con numero `nextFreeNumber(…,'UDT', 65535)`;
  - blocco: apre `AddBlockDialog`.

  Ogni aggiunta è un solo `edit` e seleziona il nodo nuovo. L'apertura dell'editor la aggiunge il Task 10.
- **AddDeviceDialog**:
  - a sinistra un albero del catalogo: Controllori > SIMATIC S7-300 > CPU > {CPU standard | CPU compatte | CPU F} > CPU > numero di articolo;
  - a destra la descrizione (memoria di lavoro, interfacce), la scelta della versione firmware e il nome, predefinito `uniqueName('PLC_1', nomi dei dispositivi)`;
  - pulsanti OK e Annulla;
  - OK aggiunge `createPlcDevice` (un `edit`) e seleziona ed espande il nuovo PLC.
- **AddBlockDialog**:
  - tipo a sinistra (OB, FB, FC, DB);
  - nome predefinito: `Blocco_1` per FB e FC, `Blocco_dati_1` per DB, `defaultName` dell'evento per gli OB, sempre con `uniqueName` sullo spazio dei simboli;
  - linguaggio: AWL; KOP, FUP e SCL visibili ma disattivati;
  - numero "Automatico", con casella; togliendola si inserisce il numero, controllato contro doppi e limiti;
  - per OB: elenco degli eventi ammessi dalla CPU e non ancora usati;
  - per DB: "DB globale" oppure "DB di istanza di" + elenco degli FB. Il DB di istanza ha nome predefinito `<FB>_DB`;
  - casella "Aggiungi e apri", attiva per default;
  - OK crea il blocco (un `edit`) e lo seleziona.
- **Vista dettagli**, secondo il nodo selezionato:
  - cartella o gruppo dei blocchi: colonne Nome, Numero, Tipo, Linguaggio;
  - Variabili PLC: Nome, Variabili;
  - tabella delle variabili: Nome, Tipo di dati, Indirizzo, Commento dei tag;
  - Tipi di dati PLC: Nome, Numero;
  - altro: come nel piano 1A.

  Le righe con un `ref` sono trascinabili; il comportamento lo definisce il Task 9.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('albero di un PLC nuovo', () => {
    /* doc con un 315-2 PN/DP creato da createPlcDevice */
    expect(labels(buildTree(doc).project!)).toEqual(expect.arrayContaining(['PLC_1 [CPU 315-2 PN/DP]', 'Blocchi di programma', 'Aggiungi nuovo blocco', 'Main [OB1]', 'Blocchi di sistema',
      'Variabili PLC', 'Mostra tutte le variabili', 'Aggiungi nuova tabella delle variabili', 'Tabella delle variabili standard [0]', 'Tipi di dati PLC', 'Aggiungi nuovo tipo di dati']));
    expect(disabled(buildTree(doc).project!)).toEqual(['Configurazione dispositivi', 'Online e diagnostica', 'Sorgenti esterne', 'Tabelle di controllo e forzamento', 'Backup online', 'Informazioni sul programma']);
  });
  it('parseNodeId(ids.block(d, b)) → { kind: "block", dev: d, id: b }; ids con ":" nei percorsi dei gruppi restano reversibili', () => { /* … */ });
  it('Aggiungi nuovo dispositivo: scelta CPU, firmware e nome, un solo passo di annulla', async () => { /* … poi undo → devices [] */ });
  it('Aggiungi nuovo blocco FB: numero automatico 1, nome Blocco_1; con FB1 esistente → FB2, Blocco_2', async () => { /* … */ });
  it('OB: elenco senza OB1 già presente e solo OB della CPU', async () => { /* … */ });
  it('numero manuale doppio: messaggio e OK disattivato', async () => { /* … */ });
  it('DB di istanza: nome <FB>_DB e instanceOf', async () => { /* … */ });
  it('Aggiungi nuova tabella delle variabili due volte → _1 e _2', async () => { /* … */ });
  it('vista dettagli di una tabella mostra i tag', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL nei nuovi test.

- [ ] **Step 3: Implementa id, modello dell'albero, dialoghi, dettagli, icone e testi**

  `Dialog.tsx` è una finestra modale nell'app: `role="dialog"`, `aria-modal`, focus intrappolato, Esc chiude, OK predefinito con Invio.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): albero del PLC, vista dettagli, aggiunta di dispositivo, blocchi, tabelle e UDT"
  ```

---

### Task 9: Operazioni sugli oggetti: taglia, copia, incolla, elimina, rinomina, trascina

**Files:**
- Create: `packages/ui/src/project/objectActions.ts`, `packages/ui/src/services/clipboard.ts`, `packages/ui/src/components/ContextMenu.tsx`
- Modify: `packages/ui/src/state/store.ts` (`editTarget`), `packages/ui/src/commands/commands.ts`, `packages/ui/src/project/navigation/{ProjectTree,DetailsView}.tsx`, `packages/ui/src/i18n/{it,en}.json`, `apps/desktop/src/renderer/main.tsx`
- Test: `packages/ui/test/{objectActions.test.ts,treeEditing.test.tsx}`, `apps/desktop/e2e/window-guards.spec.ts`

**Interfaces:**
- Consumes: Task 4 (`renameWithReferences`, `uniqueName`, `nextFreeNumber`, `symbolNames`), Task 6 (`edit`), Task 7 (`clipboardWriteText`, `clipboardReadText`, `askQuestion`), Task 8 (id e albero).
- Produces:
  ```ts
  // store.ts
  export type EditAction = 'cut'|'copy'|'paste'|'delete'|'rename'|'selectAll';
  export interface EditTarget { id: string; can: Partial<Record<EditAction, boolean>>; run(action: EditAction): void | Promise<void> }
  editTarget: EditTarget | null; setEditTarget(t: EditTarget | null): void;
  // clipboard.ts
  export type ClipboardPayload =
    | { kind: 'objects'; deviceId: string; items: Array<{ type: 'block'; block: Block } | { type: 'udt'; udt: Udt } | { type: 'tagTable'; table: TagTable }> }
    | { kind: 'rows'; rowKind: 'tag'|'constant'|'member'; rows: unknown[] };
  export function copyToClipboard(bridge: BaaBridge, text: string, payload: ClipboardPayload): void;
  export async function readClipboard(bridge: BaaBridge): Promise<{ text: string; payload: ClipboardPayload | null }>; // payload solo se il testo coincide con l'ultimo copiato
  // objectActions.ts (funzioni pure sul device, usate dentro edit)
  export function pasteObjects(target: PlcDevice, payload: Extract<ClipboardPayload, { kind: 'objects' }>, group: string, cpu: CpuType | undefined, newId: NewId): ObjectRef[];
  export function deleteObjects(device: PlcDevice, refs: ObjectRef[]): void;
  export function moveToGroup(device: PlcDevice, refs: ObjectRef[], group: string): void;
  export function moveTags(device: PlcDevice, tagRefs: ObjectRef[], toTableId: string): void;
  export function canRename(device: PlcDevice, ref: ObjectRef, name: string): 'INVALID' | 'DUPLICATE' | null;
  ```

Regole:
- **Comandi**:
  - `edit.cut` `Mod+X`, `edit.copy` `Mod+C`, `edit.paste` `Mod+V`, `edit.delete` `Delete`, `edit.rename` `F2`, `edit.selectAll` `Mod+A`;
  - sono attivi se `editTarget?.can[action]` e chiamano `editTarget.run(action)`;
  - l'albero (e più avanti la griglia, Task 11) imposta `editTarget` quando prende il focus e lo toglie quando lo perde.
- **Selezione multipla** nell'albero: Ctrl/⌘+clic, oppure Maiusc+clic per un intervallo fra nodi visibili. Il nodo attivo resta `selection`; la selezione multipla è locale all'albero.
- **Copia**:
  - si possono copiare blocchi, UDT e tabelle (anche più insieme);
  - il testo per gli appunti di sistema sono i nomi, uno per riga.
- **Incolla** su una cartella o un gruppo dell'area giusta, anche in un altro PLC:
  - gli oggetti vengono clonati con id nuovi, compresi tag e membri;
  - il nome usa `uniqueName` sullo spazio dei simboli del PLC di arrivo;
  - il numero resta quello originale se libero, altrimenti `nextFreeNumber`;
  - il gruppo di arrivo è il gruppo selezionato.
- **Taglia + incolla**: nello stesso PLC equivale a spostare; in un altro PLC a copiare ed eliminare l'origine. Un solo `edit`.
- **Elimina**:
  - prima `askQuestion` con "Eliminare gli oggetti selezionati?" e l'elenco dei nomi (al massimo 10, poi "e altri N");
  - la Tabella delle variabili standard, cioè la prima tabella del dispositivo, non si può eliminare: compare un messaggio e le altre selezionate si eliminano;
  - si possono eliminare anche i gruppi, con il loro contenuto;
  - un solo `edit`.
- **Rinomina** (F2 o menu):
  - modifica in linea nell'albero; Invio conferma, Esc annulla;
  - con `INVALID` o `DUPLICATE` compare il messaggio vicino al campo e il nome resta;
  - per blocchi e UDT usa `renameWithReferences`;
  - nei blocchi si rinomina solo il nome; il numero si cambia nelle proprietà (Task 14).
- **Menu contestuale** (clic destro, Maiusc+F10, tasto Menu): Apri, Taglia, Copia, Incolla, Elimina, Rinomina, Aggiungi nuovo gruppo (su cartelle e gruppi), Proprietà (porta alla scheda Proprietà della finestra di ispezione). Le voci non applicabili sono disattivate. Si naviga con le frecce, Invio esegue, Esc chiude.
- **Aggiungi nuovo gruppo**: `uniqueName('Gruppo_1')` fra i fratelli, poi rinomina in linea subito.
- **Trascina** (HTML5 drag and drop):
  - dati: `application/x-baaportal` = `JSON.stringify({ deviceId, refs })` e `text/plain` = nomi;
  - un nodo oggetto su una cartella o un gruppo della stessa area: nello stesso PLC sposta di gruppo (`moveToGroup`), in un altro copia (`pasteObjects`);
  - una riga tag dalla vista dettagli su un nodo tabella: sposta i tag (`moveTags`);
  - durante il passaggio il bersaglio valido è evidenziato e quello non valido mostra il cursore "vietato" (`dropEffect = 'none'`);
  - ogni rilascio è un solo `edit`.
- **Protezione del renderer** (piano 1A, `main.tsx`): `dragover` e `drop` sul documento si bloccano solo se `dataTransfer.types` contiene `Files`. Così il testo e i dati `application/x-baaportal` si trascinano normalmente, mentre un file rilasciato non apre mai la pagina. La e2e "il rilascio di un file…" usa un `DataTransfer` con un file.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('copia e incolla di un FB: nome _1, numero libero, id nuovi', () => { /* FB1 'Nastro' → incolla stesso PLC → 'Nastro_1' FB2, id ≠ */ });
  it('incolla in un altro PLC conserva il numero se libero', () => { /* … */ });
  it('elimina chiede conferma; la tabella standard resta', async () => { /* questionAnswers [true] → standard ancora presente, messaggio */ });
  it('rinomina F2: nome doppio mostra l\'errore e non cambia; Esc annulla; nome valido aggiorna i riferimenti', async () => { /* … */ });
  it('Mod+C / Mod+V nell\'albero passano dagli appunti del bridge', async () => { /* bridge.clipboard === 'Nastro' */ });
  it('trascinare un blocco su un gruppo lo sposta (un passo di annulla)', async () => { /* fireEvent.dragStart/dragOver/drop con DataTransfer finto */ });
  it('trascinare un tag dai dettagli su un\'altra tabella lo sposta', async () => { /* … */ });
  it('menu contestuale da tastiera: Maiusc+F10, frecce, Invio', async () => { /* … */ });
  it('Modifica > Taglia è disattivato senza destinazione', () => { /* editTarget null → isEnabled false */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa le operazioni, gli appunti, il menu contestuale e l'integrazione nell'albero e nei dettagli**

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): taglia, copia, incolla, elimina, rinomina, gruppi, menu contestuale e trascinamento nell'albero"
  ```

---

### Task 10: Area di lavoro: editor, barra degli editor, divisione, finestra separata

**Files:**
- Create: `packages/ui/src/project/workarea/{WorkArea,EditorFrame,DetachedWindow}.tsx`, `packages/ui/src/project/workarea/editorBarModel.ts`, `packages/ui/src/editors/registry.tsx`
- Modify: `packages/ui/src/state/store.ts` (`workArea`), `packages/ui/src/project/{ProjectView,EditorBar}.tsx`, `packages/ui/src/commands/commands.ts` (`window.*`), `packages/ui/src/project/navigation/ProjectTree.tsx` (doppio clic e Invio aprono), `packages/ui/src/i18n/{it,en}.json`
- Test: `packages/ui/test/{workArea.test.tsx,editorBarModel.test.ts}`

**Interfaces:**
- Consumes: store (Task 6), id dei nodi (Task 8), `handleShortcutKeydown` (Task 6), finestre `baa-editor-*` (Task 7).
- Produces:
  ```ts
  export type EditorKind = 'tagTable' | 'allTags' | 'block' | 'udt';
  export interface EditorRef { key: string; kind: EditorKind; deviceId: string; objectId: string } // key = `${kind}:${deviceId}:${objectId}`
  export interface WorkAreaState { editors: EditorRef[]; split: 'none'|'vertical'|'horizontal'; panes: [string | null, string | null]; focusedPane: 0 | 1; detached: string[] }
  // in AppState:
  workArea: WorkAreaState;
  openEditor(ref: Omit<EditorRef, 'key'>): void;  // se già aperto lo attiva (o mette a fuoco la sua finestra separata)
  closeEditor(key: string): void; closeAllEditors(): void;
  activateEditor(key: string): void;               // nel riquadro con il focus
  setSplit(mode: WorkAreaState['split']): void; focusPane(i: 0 | 1): void;
  detachEditor(key: string): void; attachEditor(key: string): void;
  // registry.tsx
  export interface EditorDef { kind: EditorKind; icon(ref: EditorRef, doc: OpenDoc): IconName; title(ref: EditorRef, doc: OpenDoc, t: TFunction): string; exists(ref: EditorRef, doc: OpenDoc): boolean; Component: FC<{ editor: EditorRef }> }
  export const EDITORS: Record<EditorKind, EditorDef>;
  export function registerEditor(def: EditorDef): void;   // Task 12–13 registrano i propri
  // editorBarModel.ts
  export type EditorBarItem = { type: 'single'; key: string } | { type: 'group'; kind: EditorKind; keys: string[] };
  export function editorBarItems(editors: EditorRef[], maxButtons: number): EditorBarItem[];
  ```

Regole:
- **Apertura**:
  - doppio clic o Invio su un blocco, un UDT, una tabella o "Mostra tutte le variabili" apre l'editor;
  - "Aggiungi e apri" (Task 8) e "Aggiungi nuova tabella" o "Aggiungi nuovo tipo di dati" aprono l'oggetto creato;
  - un editor attivato seleziona il suo nodo nell'albero.
- **Coerenza**: dopo ogni cambiamento del documento si chiudono gli editor il cui oggetto non esiste più, per esempio dopo Annulla di una creazione o dopo un'eliminazione. Con `setDoc` si chiudono tutti.
- **Riquadri**:
  - `split: 'none'` mostra un riquadro;
  - `vertical` mostra due riquadri affiancati, `horizontal` uno sopra l'altro, divisi da un `Separator` di react-resizable-panels;
  - accendendo la divisione, il secondo riquadro mostra l'editor attivo precedente se c'è;
  - `window.splitVertical` e `window.splitHorizontal` accendono e spengono la loro modalità, e sono spuntati quando attivi;
  - il pulsante della barra degli strumenti "Dividi area di lavoro" resta `window.splitVertical`, come nel piano 1A (R7);
  - `window.closeAllEditors` chiude tutti gli editor.
- **Cornice dell'editor** (`EditorFrame`): intestazione con icona, titolo, pulsante "Apri in una finestra separata" e pulsante "Chiudi".
- **Barra degli editor**:
  - dopo il link "Vista portale", un pulsante per editor (icona e titolo), con `aria-pressed` per quello attivo;
  - `editorBarItems` raggruppa per tipo quando i pulsanti sono più di `maxButtons`, cominciando dal tipo con più editor, finché ci stanno;
  - un gruppo mostra icona, nome del tipo e numero, e al clic apre un menu con gli editor;
  - `maxButtons = floor(larghezza / 160)`, misurata con `ResizeObserver`; con larghezza 0, come in jsdom, vale `Infinity`.
- **Finestra separata** (`DetachedWindow`):
  - `window.open('', 'baa-editor-<hash della key>', 'width=1000,height=700')`;
  - copia nella testa della figlia i nodi `<style>` e `<link rel="stylesheet">` con `href` assoluto, e le classi del tema;
  - rende l'editor con `createPortal` nel `body` della figlia, dentro lo stesso `AppProvider`;
  - aggancia `keydown` della figlia a `handleShortcutKeydown`;
  - imposta `document.title` della figlia al titolo dell'editor;
  - `pagehide` o `beforeunload` della figlia → `attachEditor(key)`;
  - un editor staccato non compare nei riquadri, ma resta nella barra degli editor con un'icona "finestra"; il clic porta in primo piano la sua finestra (`focus()`);
  - se `window.open` restituisce `null`, l'editor resta nell'area di lavoro e compare un messaggio.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('editorBarItems: nessun gruppo se c\'è spazio; poi raggruppa il tipo più numeroso', () => {
    const e = [blk('a'), blk('b'), blk('c'), tbl('x'), udt('u')];
    expect(editorBarItems(e, 10).map((i) => i.type)).toEqual(['single','single','single','single','single']);
    expect(editorBarItems(e, 3)).toEqual([{ type: 'group', kind: 'block', keys: [k('a'), k('b'), k('c')] }, { type: 'single', key: k('x') }, { type: 'single', key: k('u') }]);
  });
  it('doppio clic su Main [OB1] apre l\'editor e mostra il pulsante nella barra', async () => { /* … */ });
  it('annullare la creazione di un blocco aperto chiude l\'editor', async () => { /* … */ });
  it('divisione verticale: due riquadri, il secondo con l\'editor precedente', async () => { /* … */ });
  it('finestra separata: portale nella figlia, chiusura della figlia → torna nell\'area di lavoro', async () => {
    /* vi.spyOn(window, 'open') restituisce un oggetto con document = document.implementation.createHTMLDocument(),
       addEventListener/focus/close finti; dispatch 'pagehide' → editor di nuovo in un riquadro */
  });
  it('window.open null: l\'editor resta e compare un messaggio', async () => { /* … */ });
  it('Mod+S nella finestra separata salva', async () => { /* keydown sul document della figlia → service.save chiamato */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa store, area di lavoro, registro, barra e finestra separata**

  Finché i Task 12 e 13 non registrano i loro editor, il registro contiene editor minimi con il solo titolo.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): area di lavoro con editor, barra degli editor raggruppata, divisione e finestra separata"
  ```

---

### Task 11: Griglia `DataGrid`

**Files:**
- Create: `packages/ui/src/grid/{DataGrid.tsx,grid.css,tsv.ts}`
- Test: `packages/ui/test/{dataGrid.test.tsx,tsv.test.ts}`

**Interfaces:**
- Consumes: `EditTarget` e `setEditTarget` (Task 9); `copyToClipboard`, `readClipboard` (Task 9).
- Produces:
  ```ts
  export interface GridColumn<R> {
    id: string; headerKey: string; width: number;
    editor: 'text' | 'checkbox' | 'type' | 'none';
    get(row: R): string | boolean;
    readOnly?(row: R): boolean;
    suggestions?(row: R): string[];      // per 'type': elenco filtrato mentre si scrive
  }
  export interface GridDiagnostic { severity: 'error' | 'warning'; text: string }
  export interface DataGridProps<R> {
    label: string; rows: R[]; rowKey(row: R): string; columns: GridColumn<R>[];
    depth?(row: R): number; expandable?(row: R): boolean; expanded?: ReadonlySet<string>; onToggleExpand?(key: string): void;
    rowSelectable?(row: R): boolean;                              // righe di sezione: no
    onCommit(rowKey: string, columnId: string, value: string | boolean): void;
    addRow?: { afterKey: string | null; labelKey: string; onAdd(columnId: string, value: string): void }[]; // righe "<Aggiungi>"
    onDeleteRows?(keys: string[]): void;
    copyRows?(keys: string[]): { text: string; payload: ClipboardPayload };
    onPaste?(text: string, payload: ClipboardPayload | null, atKey: string | null): void;
    onFill?(sourceKey: string, count: number): void;
    diagnostic?(rowKey: string, columnId: string): GridDiagnostic | undefined;
    onRowDragStart?(keys: string[], e: DragEvent): void;
    onDropOnRow?(e: DragEvent, rowKey: string | null): void;
  }
  export function DataGrid<R>(props: DataGridProps<R>): JSX.Element;
  export function toTsv(rows: string[][]): string;      // \t e \r\n, campi con tab, a capo o " tra virgolette
  export function parseTsv(text: string): string[][];   // accetta \n e \r\n, ignora l'ultima riga vuota, virgolette alla Excel
  ```

Regole:
- **Struttura accessibile**:
  - `role="grid"` con `aria-label`, righe `role="row"`, celle `role="gridcell"`, intestazioni `role="columnheader"`;
  - una colonna iniziale stretta con il numero di riga, che serve per selezionare le righe;
  - righe con figli (`expandable`) con freccia e `aria-expanded`;
  - rientro `depth * 16 px` nella prima colonna dati.
- **Tastiera** con la cella attiva e senza modifica in corso:
  - frecce, Home/Fine, Pag su/giù per spostarsi;
  - Invio o F2 iniziano la modifica;
  - un carattere stampabile inizia la modifica sostituendo il testo;
  - Spazio commuta le caselle;
  - Canc elimina le righe selezionate (`onDeleteRows`);
  - Mod+A seleziona tutte le righe selezionabili.
- **Tastiera durante la modifica**:
  - Invio conferma e scende;
  - Tab conferma e va a destra, Maiusc+Tab a sinistra;
  - Esc annulla.
- **Mouse**: clic sul numero di riga seleziona la riga; con Maiusc+clic l'intervallo; con Ctrl/⌘+clic la aggiunge.
- **Righe "<Aggiungi>"**: scrivere in una cella chiama `onAdd(columnId, valore)`. La griglia non crea righe da sola.
- **Appunti**: la griglia è un `EditTarget` quando ha il focus.
  - Copia: `copyRows(righe selezionate, o la riga della cella attiva)`;
  - Taglia: copia + `onDeleteRows`;
  - Incolla: `readClipboard` + `onPaste(text, payload, riga attiva)`.
- **Riempimento automatico**:
  - quadratino in basso a destra della cella attiva, se `onFill`;
  - si trascina con `pointerdown`, `pointerenter` sulle righe sotto e `pointerup`;
  - chiama `onFill(sorgente, numero di righe attraversate)`;
  - durante il trascinamento le righe coperte sono evidenziate.
- **Diagnostica**: cella con bordo rosso per gli errori o giallo per gli avvisi, più un'icona. Il testo va in `title` e in un `aria-describedby` nascosto.
- **Prestazioni**: 2000 righe × 6 colonne si disegnano in meno di 1 s in jsdom (test con soglia larga). Nessuna virtualizzazione in 1B.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // tsv.test.ts
  it('parseTsv: \\r\\n, riga vuota finale, virgolette e tab', () => {
    expect(parseTsv('a\tb\r\n"c\td"\te\r\n')).toEqual([['a','b'], ['c\td','e']]);
    expect(parseTsv(toTsv([['x"y', 'z\nw']]))).toEqual([['x"y', 'z\nw']]);
  });
  // dataGrid.test.tsx (griglia di prova con colonne Nome/Tipo/Spunta)
  it('frecce, F2, Invio conferma e scende, Esc annulla', async () => { /* onCommit chiamato una volta con ('r1','name','Nuovo') */ });
  it('scrivere un carattere inizia la modifica sostituendo il testo', async () => { /* … */ });
  it('Tab conferma e va a destra', async () => { /* … */ });
  it('Spazio commuta la casella', async () => { /* onCommit('r1','flag',true) */ });
  it('riga <Aggiungi>: scrivere un nome chiama onAdd', async () => { /* onAdd('name','Motore') */ });
  it('selezione righe con Maiusc+clic, Canc elimina', async () => { /* onDeleteRows(['r1','r2','r3']) */ });
  it('Mod+C copia le righe come TSV negli appunti del bridge; Mod+V chiama onPaste', async () => { /* … */ });
  it('riempimento automatico su 3 righe chiama onFill(r1, 3)', async () => { /* pointer events */ });
  it('la diagnostica è leggibile (title e aria-describedby)', () => { /* … */ });
  it('suggerimenti di tipo filtrati mentre si scrive', async () => { /* 'Di' → DInt, DWord… */ });
  it('2000 righe in meno di 1 s', () => { /* performance.now */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa `DataGrid`, `tsv.ts` e gli stili**

  Stili con densità alta come nel piano 1A: righe da 22 px e i token del tema.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): griglia comune con modifica da tastiera, selezione, appunti TSV, riempimento automatico e diagnostica"
  ```

---

### Task 12: Editor delle tabelle delle variabili, costanti utente, "Mostra tutte le variabili"

**Files:**
- Create: `packages/ui/src/editors/tags/{TagTableEditor,AllTagsEditor}.tsx`, `packages/ui/src/editors/tags/tagRows.ts`, `packages/ui/src/state/diagnostics.ts`
- Modify: `packages/ui/src/editors/registry.tsx`, `packages/ui/src/i18n/{it,en}.json`
- Test: `packages/ui/test/{tagRows.test.ts,tagTableEditor.test.tsx}`

**Interfaces:**
- Consumes: `DataGrid`, `toTsv`, `parseTsv` (Task 11); `checkDevice` (Task 5); `edit` (Task 6); s7-types (Task 1–2); `findCpu` (Task 3).
- Produces:
  ```ts
  // diagnostics.ts: diagnostica per dispositivo, ricalcolata solo quando il dispositivo cambia (memo per riferimento)
  export function useDeviceDiagnostics(deviceId: string): Diagnostic[];
  export function diagnosticText(d: Diagnostic, t: TFunction): string;          // chiavi diag.<CODE>
  // tagRows.ts (puro)
  export function newTagAfter(prev: Tag | undefined, name: string, newId: NewId): Tag;   // tipo e indirizzo dal precedente
  export function fillTags(source: Tag, count: number, taken: string[], newId: NewId): Tag[];
  export function tagsFromTsv(rows: string[][], taken: string[], newId: NewId): Tag[];
  export function tagsToTsv(tags: Tag[], retain: (t: Tag) => boolean): string;
  export function isRetentive(tag: Tag, props: CpuProperties): boolean;
  export function constantsFromTsv(rows: string[][], taken: string[], newId: NewId): UserConstant[];
  ```

Regole:
- **Editor della tabella**: due schede, "Variabili" e "Costanti utente".
  - Colonne delle variabili: Nome, Tipo di dati, Indirizzo, Ritenzione, Accessibile da HMI, Commento.
  - Colonne delle costanti: Nome, Tipo di dati, Valore, Commento.
- **Ritenzione** è di sola lettura: vera se il tag è in M, T o C dentro l'intervallo ritentivo della CPU (`retentivity`). Accanto, il titolo della colonna spiega che si imposta nelle proprietà della CPU.
- Ogni cella confermata è un `edit`:
  - il nome viene salvato come scritto, anche se non valido, e la diagnostica lo segna in rosso;
  - il tipo viene normalizzato con `formatType` se valido, altrimenti salvato così com'è;
  - l'indirizzo viene normalizzato con `formatAddress` se valido.
- **Nuova riga** (`<Aggiungi>`), con `newTagAfter`:
  - nome scritto, oppure `uniqueName('Variabile_1')` se si inizia da un'altra colonna;
  - tipo uguale alla riga precedente, `Bool` se non c'è;
  - indirizzo `incrementAddress` di quello precedente se compatibile, altrimenti `%M0.0` per `Bool`, `%MW0` per i tipi a 16 bit e così via;
  - `hmi: true`.
- **Riempimento automatico** (`fillTags`): crea `count` tag subito dopo la sorgente, con nome e indirizzo incrementati (`incrementName`, `incrementAddress`), stesso tipo, stesso commento e stesso `hmi`. I nomi sono unici. Un solo `edit`.
- **Incolla**:
  - con payload `rows` di tag, si clonano le righe con id nuovi;
  - altrimenti `tagsFromTsv` legge le colonne nell'ordine visibile (Nome, Tipo di dati, Indirizzo, Ritenzione ignorata, Accessibile da HMI `TRUE`/`FALSE`/`1`/`0`, Commento). Le colonne mancanti prendono i valori predefiniti; un nome già usato diventa `_1`, `_2`;
  - si inserisce dopo la riga attiva, oppure in fondo;
  - un solo `edit`, anche con 1000 righe;
  - le righe con errori restano e la diagnostica le segna.
- **Copia**: `tagsToTsv` con le stesse colonne. Ritenzione è `TRUE` o `FALSE`.
- **Costanti**: stesse operazioni. La nuova costante si chiama `Costante_1`, con tipo come la precedente (`Int` se non c'è) e valore `defaultLiteral`. Nel riempimento si incrementa solo il nome.
- **Mostra tutte le variabili** (`AllTagsEditor`):
  - la stessa griglia con una colonna in più, "Tabella delle variabili" (sola lettura, prima di Commento), con i tag di tutte le tabelle;
  - le modifiche vanno alla tabella di appartenenza;
  - `<Aggiungi>` aggiunge alla tabella standard;
  - incolla e riempimento come nella tabella, sulla tabella della riga sorgente.
- **Diagnostica**: la colonna giusta in base a `field`. Il testo localizzato è in `diag.<CODE>` (per esempio `diag.ADDRESS_OVERLAP` = "L'indirizzo si sovrappone a {{other}}").
- Le righe dei tag sono trascinabili verso un nodo tabella dell'albero (Task 9, `moveTags`).

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // tagRows.test.ts
  it('newTagAfter continua tipo e indirizzo', () => {
    expect(pick(newTagAfter(tag('A', 'Bool', '%M0.7'), 'B', seq()))).toEqual({ name: 'B', type: 'Bool', address: '%M1.0', hmi: true });
    expect(pick(newTagAfter(undefined, 'X', seq()))).toEqual({ name: 'X', type: 'Bool', address: '%M0.0', hmi: true });
  });
  it('fillTags: nomi e indirizzi incrementati, nomi già presi saltati', () => {
    expect(fillTags(tag('Motore_1', 'Int', '%MW10'), 3, ['Motore_3'], seq()).map((t) => [t.name, t.address])).toEqual([['Motore_2','%MW12'], ['Motore_4','%MW14'], ['Motore_5','%MW16']]);
  });
  it('tagsFromTsv: \\r\\n, colonne mancanti, nomi doppi, righe sbagliate conservate', () => {
    expect(tagsFromTsv(parseTsv('A\tInt\t%MW0\r\nA\r\nB\tBol\tXYZ\r\n'), ['a'], seq()).map((t) => [t.name, t.type, t.address]))
      .toEqual([['A_1','Int','%MW0'], ['A_2','Bool','%M0.0'], ['B','Bol','XYZ']]);
  });
  it('1000 righe incollate in un solo passo di annulla', async () => { /* … history.past.length aumenta di 1 */ });
  it('isRetentive con ritenzione MB0..15, T0..-, C0..7', () => { /* %MW14 sì, %MW16 no, %C7 sì, %T0 no */ });
  // tagTableEditor.test.tsx
  it('scrivere nella riga <Aggiungi> crea un tag con valori proposti', async () => { /* … */ });
  it('nome doppio e indirizzo sovrapposto sono evidenziati con il testo giusto', async () => { /* … */ });
  it('scheda Costanti utente: aggiunta e valore non valido segnato', async () => { /* … */ });
  it('Mostra tutte le variabili: colonna tabella e modifica che arriva alla tabella giusta', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa gli editor, `tagRows.ts`, la diagnostica e i testi, poi registra gli editor `tagTable` e `allTags`**

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): editor delle tabelle delle variabili, costanti utente e vista di tutte le variabili"
  ```

---

### Task 13: Editor di blocco (interfaccia e segmenti), DB e UDT

**Files:**
- Create: `packages/ui/src/editors/block/{BlockEditor,InterfaceTable,NetworksView}.tsx`, `packages/ui/src/editors/block/interfaceRows.ts`, `packages/ui/src/editors/db/DbEditor.tsx`, `packages/ui/src/editors/udt/UdtEditor.tsx`
- Modify: `packages/ui/src/editors/registry.tsx`, `packages/ui/src/i18n/{it,en}.json`
- Test: `packages/ui/test/{interfaceRows.test.ts,blockEditor.test.tsx,dbEditor.test.tsx,udtEditor.test.tsx}`

**Interfaces:**
- Consumes: `DataGrid` (Task 11); `memberAllowed`, `checkDevice` (Task 5); `layoutStruct`, `layoutInstance`, `formatOffset`, `parseType`, `defaultLiteral` (Task 1–2); `typeResolver`, `toTypedMembers`, `memberPath` (Task 4); `useDeviceDiagnostics` (Task 12).
- Produces:
  ```ts
  export type SectionId = 'input'|'output'|'inOut'|'static'|'temp'|'return'|'members';
  export interface InterfaceRow {
    key: string;                       // 'section:<id>' | id del membro | '<id membro>[i,j]' | '<id membro>/<percorso>'
    kind: 'section' | 'member' | 'element' | 'derived';   // derived = membro di UDT o FB mostrato in sola lettura
    section: SectionId; depth: number;
    name: string; type: string; offset: string; initial: string; comment: string;
    editable: { name: boolean; type: boolean; initial: boolean; comment: boolean };
    expandable: boolean; memberId?: string; overridePath?: string;   // dove si salva un valore iniziale sostituito
  }
  export function interfaceRows(owner: { kind: 'OB'|'FB'|'FC'; block: CodeBlock } | { kind: 'DB'; db: GlobalDb } | { kind: 'IDB'; db: InstanceDb } | { kind: 'UDT'; udt: Udt },
    device: PlcDevice, expanded: ReadonlySet<string>): InterfaceRow[];
  ```

Regole:
- **Sezioni per tipo** di proprietario:
  - OB: Temp;
  - FB: Input, Output, InOut, Static, Temp;
  - FC: Input, Output, InOut, Temp, Return (una riga `Ret_Val` con il solo tipo modificabile);
  - DB globale: Static;
  - UDT: senza sezioni, i membri sono al primo livello.
- **Colonne**:
  - blocchi: Nome, Tipo di dati, Offset, Valore predefinito, Commento;
  - DB: Nome, Tipo di dati, Offset, Valore iniziale, Commento;
  - UDT: come i blocchi;
  - FC e OB: l'Offset c'è solo in Temp;
  - FB: l'Offset c'è in tutte le sezioni (dati di istanza, `layoutInstance`) e in Temp (`layoutStruct`).
- **Righe espandibili**:
  - `Struct` con i suoi membri modificabili (si aggiungono con una riga `<Aggiungi>` dentro la struct);
  - `Array` con le righe degli elementi `[i]` o `[i,j]`: tipo dell'elemento, offset con `strideBits`, solo il valore iniziale modificabile → `overrides['[i]']`. Si mostrano al massimo i primi 1000 elementi;
  - UDT e multi-istanza FB con i loro membri `derived` in sola lettura, tranne il valore iniziale, che va in `overrides['.membro']` del membro.
- **Righe in sola lettura**: le informazioni di avvio degli OB (`readOnly: true`) sono grigie, senza modifica né eliminazione.
- **Valore predefinito**:
  - vuoto significa `defaultLiteral` del tipo, mostrato in grigio;
  - assente per i tipi senza valore;
  - non c'è in Temp, InOut (S7-300) e Return.
- **Nuovo membro** da `<Aggiungi>`:
  - nome scritto, oppure `uniqueName('Variabile_1')` sui nomi dell'interfaccia;
  - tipo `Bool`;
  - un `edit`.
- **Tipo `Struct` scritto nella cella**: il membro riceve `members: []` e si espande.
- **Suggerimenti di tipo**:
  - elementari, `String`, `Date_And_Time`, `Array[0..1] of Bool`, `Struct`;
  - gli UDT del PLC tra virgolette;
  - in Static degli FB anche gli FB come multi-istanza;
  - i tipi parametro ammessi dalla sezione (`memberAllowed`).
- **Trascinamento** (Task 9, dati `application/x-baaportal`): un UDT o un FB trascinato dall'albero su una riga di sezione aggiunge un membro con tipo `"<nome>"`. Il nome è `<nome>_Instance` per gli FB e `<nome>_1` per gli UDT, entrambi con `uniqueName`. Un FB su una sezione non Static viene rifiutato con `dropEffect: 'none'`.
- **Copia/incolla di righe membro**: payload `rows` con `rowKind: 'member'`; il testo TSV ha Nome, Tipo di dati, Valore predefinito, Commento. L'incolla va nella sezione della riga attiva, con i nomi resi unici.
- **Editor di blocco** (OB/FB/FC):
  - in alto l'interfaccia, con la tabella comprimibile;
  - sotto, "Titolo del blocco" e "Commento" (campi a conferma, `header.title` e `header.comment`), poi i segmenti;
  - ogni segmento ha "Segmento N", titolo, commento e un'area di testo monospazio per `source`. Questo è solo testo: evidenziazione e controllo arrivano con il piano 1C, e lo dice un suggerimento sull'area;
  - pulsante "Inserisci segmento" e menu del segmento con Elimina;
  - ogni conferma è un `edit`.
- **Editor DB**:
  - DB globale: tabella Static;
  - DB di istanza: righe `derived` dalle sezioni Input, Output, InOut e Static dell'FB, con il solo valore iniziale modificabile (`overrides` del DB);
  - se l'FB manca, un riquadro d'errore "Il DB di istanza si riferisce all'FB <nome>, che non esiste" e nessuna tabella.
- **Editor UDT**: la tabella dei membri.
- Ogni editor si registra nel `registry` (Task 10), con titolo e icona.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // interfaceRows.test.ts
  it('FB: sezioni in ordine, offset di istanza e di Temp', () => {
    /* FB con Input a:Bool, Output b:Int, Static s:Struct{p:Bool}, Temp t:Int */
    expect(rows.filter((r) => r.kind !== 'section').map((r) => [r.name, r.offset])).toEqual([['a','0.0'], ['b','2.0'], ['s','4.0'], ['t','0.0']]);
    expect(rows.filter((r) => r.kind === 'section').map((r) => r.name)).toEqual(['Input','Output','InOut','Static','Temp']);
  });
  it('FC: niente Static, Return con Ret_Val, offset solo in Temp', () => { /* … */ });
  it('array espanso: righe [i] con offset e valore iniziale sostituito', () => {
    /* DB con arr: Array[1..3] of Int, overrides { '[2]': '5' } → righe '[1]' 2.0? … initial '5' sulla seconda */
  });
  it('UDT espanso in un DB: righe derived con override .membro', () => { /* … */ });
  it('OB1: dieci righe di sola lettura', () => { /* editable tutti false */ });
  // blockEditor.test.tsx
  it('scrivere Struct crea una struct espandibile con <Aggiungi> interno', async () => { /* … */ });
  it('trascinare un FB dall\'albero in Static crea Nastro_Instance', async () => { /* … */ });
  it('Pointer in Input di un FB è segnato come non ammesso', async () => { /* … */ });
  it('segmenti: inserisci, titolo, elimina, ognuno un passo di annulla', async () => { /* … */ });
  // dbEditor.test.tsx
  it('DB di istanza: valori iniziali modificabili, nomi in sola lettura; FB mancante → riquadro d\'errore', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa `interfaceRows`, gli editor e i testi, poi registra gli editor `block` e `udt`**

  Il DB è un `block`: l'editor sceglie la vista DB in base al `kind`.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): editor di blocco con interfaccia e segmenti, editor DB e UDT"
  ```

---

### Task 14: Finestra di ispezione: proprietà di CPU, blocchi, UDT e tabelle

**Files:**
- Create: `packages/ui/src/project/inspector/properties/{PlcProperties,BlockProperties,UdtProperties,TagTableProperties,PropertySection}.tsx`
- Modify: `packages/ui/src/project/inspector/{Inspector,ProjectProperties}.tsx`, `packages/ui/src/i18n/{it,en}.json`
- Test: `packages/ui/test/properties.test.tsx`

**Interfaces:**
- Consumes: `CommitInput` (Task 6), `edit` (Task 6), `parseNodeId` (Task 8), `useDeviceDiagnostics` e `diagnosticText` (Task 12), `findCpu` e `findCpuByOrderNumber` (Task 3), `nextFreeNumber` (Task 4).
- Produces: componenti senza nuove interfacce pubbliche. `Inspector` sceglie il pannello delle proprietà in base a `parseNodeId(selection)`.

Regole:
- **PLC**:
  - in testa, un riquadro informativo fisso: "Queste proprietà servono al simulatore e ai controlli offline. Fino alla tappa 6 non vengono caricate nel PLC.";
  - sezioni comprimibili:
    - **Generale**: Nome (nome del dispositivo, unico fra i dispositivi), Commento, Numero di articolo (sola lettura), Versione firmware (elenco dalle versioni del numero di articolo);
    - **Interfaccia PROFINET** (solo CPU PN): Indirizzo IP, Maschera di sottorete, Utilizza router, Indirizzo router (attivo solo con la casella);
    - **Interfaccia MPI**: Indirizzo;
    - **Interfaccia DP** (solo CPU DP): Indirizzo;
    - **Ciclo**: Tempo di ciclo massimo (ms), Tempo di ciclo minimo (ms), Carico del ciclo dovuto alla comunicazione (%);
    - **Merker di clock**: Attiva, Byte di memoria;
    - **Ritenzione**: Numero di byte di merker a partire da MB0, Numero di temporizzatori S7 a partire da T0, Numero di contatori S7 a partire da C0;
    - **Schedulazione orologio**: Periodo OB35 (ms).
  - i campi numerici accettano solo interi;
  - l'errore `PROPERTY_INVALID` della `property` corrispondente compare sotto il campo;
  - il valore resta salvato anche se non valido, come nelle griglie.
- Il merker di sistema della spec §9 **non c'è**: non esiste sulle CPU S7-300 (vedi la Ruling R1).
- **Blocco** (OB/FB/FC/DB/IDB):
  - **Generale**: Nome (come la rinomina, con aggiornamento dei riferimenti), Tipo (sola lettura), Numero (`CommitInput` che controlla doppi e limiti, più il pulsante "Automatico" che assegna `nextFreeNumber`), Linguaggio (sola lettura in 1B), "DB di istanza di" (IDB, sola lettura);
  - **Informazioni**: Titolo, Commento, Versione, Autore, Famiglia, Nome nell'intestazione, con errori `HEADER_INVALID` sotto i campi;
  - **Attributi**: Protezione know-how (casella, con una frase che dice che il flag viene scritto nel blocco caricato e che chi lo apre con altri strumenti vede solo l'interfaccia). Per DB e IDB anche Solo nella memoria di caricamento, Protetto da scrittura nel dispositivo, Non ritentivo.
- **UDT**: Nome, Numero, Commento, Autore, Famiglia, Versione.
- **Tabella delle variabili**: Nome (non modificabile per la tabella standard), Gruppo (sola lettura), Numero di variabili, Numero di costanti.
- **Progetto**: come nel piano 1A, ma con `CommitInput`.
- **Altri nodi**: "Nessuna proprietà", come oggi.
- Ogni modifica è un `edit`.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('PLC: riquadro "non caricate nel PLC" e valori predefiniti', async () => { /* testi e valori 192.168.0.1, 255.255.255.0, 150, 20, 16, 0, 8, 100 */ });
  it('IP non valido: errore sotto il campo, valore conservato', async () => { /* '192.168.0.0' */ });
  it('Indirizzo router attivo solo con Utilizza router', async () => { /* … */ });
  it('CPU senza PN: niente sezione PROFINET', async () => { /* 315-2 DP */ });
  it('Numero di blocco doppio segnalato; Automatico assegna il primo libero', async () => { /* … */ });
  it('Famiglia di 9 caratteri: HEADER_INVALID', async () => { /* … */ });
  it('rinomina di un UDT dalle proprietà aggiorna i riferimenti, un passo di annulla', async () => { /* … */ });
  it('tabella standard: nome non modificabile', async () => { /* … */ });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa i pannelli delle proprietà**

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): proprietà di CPU, blocchi, UDT e tabelle nella finestra di ispezione"
  ```

---

### Task 15: Recupero automatico

**Files:**
- Create: `packages/ui/src/services/recoveryService.ts`
- Modify: `packages/ui/src/App.tsx` (avvio del servizio e domanda di recupero all'avvio), `packages/ui/src/services/projectService.ts` (`openRecovered`, `beforeWindowClose`), `packages/ui/src/i18n/{it,en}.json`
- Test: `packages/ui/test/recoveryService.test.ts`

**Interfaces:**
- Consumes: `recoveryWrite/List/Read/Delete`, `askQuestion` e `testOverrides` (Task 7); `writeBaap` e `readBaap` (Task 4); store (Task 6).
- Produces:
  ```ts
  // projectService.ts (aggiunte)
  openRecovered(project: Project, filePath: string): Promise<boolean>;  // chiede di salvare il documento aperto, poi setDoc con revision 1 / savedRevision 0
  // ProjectServiceDeps: beforeWindowClose?: () => Promise<void>       // chiamata in handleCloseRequest prima di closeWindowConfirmed
  // recoveryService.ts
  export const RECOVERY_INTERVAL_MS = 60_000;
  export function recoveryKey(filePath: string): string;     // 'p-' + FNV-1a 32 bit esadecimale di filePath.toLowerCase()
  export interface RecoveryService { flush(): Promise<void>; offerRecovery(): Promise<void>; clear(filePath: string): Promise<void>; dispose(): void }
  export function createRecoveryService(deps: { store: StoreApi<AppState>; bridge: BaaBridge; t: TFunction; appVersion: string;
    service: ProjectService; intervalMs?: number; now?: () => Date }): RecoveryService;
  ```

Regole:
- **Scrittura periodica**: ogni `intervalMs`, se il documento è "modificato" e `revision` è cambiato dall'ultima copia, `recoveryWrite(recoveryKey(filePath), writeBaap(project), { originalPath, projectName, savedAt })`. Un errore va in Informazioni come avviso e non interrompe nulla.
- **Intervallo**: `intervalMs` se passato, altrimenti `testOverrides().recoveryIntervalMs`, altrimenti `RECOVERY_INTERVAL_MS`.
- **Pulizia** con `recoveryDelete` della chiave del documento:
  - il servizio osserva lo store: si cancella quando `revision === savedRevision` dopo un salvataggio, quando il documento passa a `null`, e quando cambia `filePath` (la chiave del vecchio percorso, dopo "Salva con nome");
  - App collega `beforeWindowClose` alla cancellazione della chiave del documento aperto, così uscire con "Non salvare" non lascia copie.
- **All'avvio** (`offerRecovery`), per ogni voce di `recoveryList()`:
  - si chiede con `askQuestion`: "BaaPortal non è stato chiuso correttamente. Recuperare le modifiche di «<nome>» salvate il <data e ora>?" con le risposte Recupera e Elimina;
  - Recupera: `service.openRecovered(readBaap(dati), originalPath)`; se riesce, si scrive in Informazioni "Modifiche recuperate" e si elimina la voce;
  - Elimina: si cancella la voce;
  - un recupero illeggibile (`BaapFormatError`) dà un messaggio d'errore e la voce viene eliminata.
- L'intervallo si ferma con `dispose`. Nei test si usano i timer finti di Vitest.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('scrive una copia solo se modificato e cambiato', async () => { /* vi.advanceTimersByTime(60_000) ×2 senza edit → 1 sola scrittura */ });
  it('salvataggio riuscito cancella la copia', async () => { /* … */ });
  it('uscita con "Non salvare" cancella la copia prima di chiudere la finestra', async () => { /* confirmAnswers ['discard'] → recovery vuota, closeConfirmed */ });
  it('Salva con nome cancella la copia del vecchio percorso', async () => { /* … */ });
  it('all\'avvio: Recupera apre il documento modificato con il percorso originale e cancella la voce', async () => { /* … */ });
  it('Elimina cancella la voce senza aprire', async () => { /* … */ });
  it('recupero illeggibile: messaggio ed eliminazione', async () => { /* … */ });
  it('recoveryKey stabile e senza caratteri vietati', () => { expect(recoveryKey('C:\\P\\A.baap')).toMatch(/^p-[0-9a-f]{8}$/); expect(recoveryKey('c:\\p\\a.baap')).toBe(recoveryKey('C:\\P\\A.baap')); });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa il servizio e collegalo ad App e al servizio progetto**

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): recupero automatico delle modifiche dopo una chiusura anomala"
  ```

---

### Task 16: Prove end-to-end del piano 1B e lista di controllo

**Files:**
- Create: `apps/desktop/e2e/{plc-model,detached-editor,recovery}.spec.ts`
- Modify: `apps/desktop/e2e/helpers.ts` (aiuti per aggiungere CPU e blocchi), questo piano (lista di controllo manuale qui sotto)

**Interfaces:**
- Consumes: tutto quanto sopra, e `launchApp`, `stubMessageBox`, `shownDialogs`, `createProject` di `helpers.ts`.
- Produces: niente di nuovo per altri task.

Prove ("Fatto quando" del piano 1B):
1. `plc-model.spec.ts`, in una cartella con spazi e accenti:
   1. crea il progetto e aggiungi la CPU 315-2 PN/DP;
   2. nella tabella standard aggiungi 3 tag scrivendo, poi riempi fino a 6;
   3. aggiungi una costante;
   4. crea l'UDT "Asse" con una struct;
   5. crea l'FB "Nastro" con Input, Static di tipo `"Asse"` e una multi-istanza di un altro FB;
   6. crea un DB globale e il DB di istanza `Nastro_DB`;
   7. Mod+Z annulla l'ultima modifica e Mod+Y la ripete;
   8. salva, chiudi e riapri: tutto è presente e uguale, e l'albero mostra gli stessi nodi;
   9. il titolo della finestra non ha più la modifica in sospeso.
2. `plc-model.spec.ts`:
   1. copia due righe di tag con Mod+C e incollale in una tabella nuova con Mod+V: i nomi diventano `_1`;
   2. trascina un blocco in un gruppo;
   3. elimina con conferma, con risposta Sì attraverso lo stub.
3. `detached-editor.spec.ts`:
   1. apri la tabella in una finestra separata (2 `BrowserWindow`);
   2. cambia un nome lì: la vista dettagli della principale lo mostra;
   3. Mod+Z nella principale lo annulla;
   4. chiudi la finestra separata: l'editor torna nell'area di lavoro;
   5. apri un'altra finestra separata e chiudi la principale con lo stub "Non salvare": non resta nessuna finestra.
4. `recovery.spec.ts`:
   1. modifica un progetto e aspetta la copia: avvia con `BAA_RECOVERY_MS=500`, che arriva al renderer tramite `testOverrides` (Task 7);
   2. termina il processo con `app.process().kill()`;
   3. riavvia con lo stesso userData: compare la domanda (stub Recupera);
   4. il documento è aperto, "modificato" e con la modifica.

- [ ] **Step 1: Scrivi le prove e verifica che falliscano dove la funzione manca**

  Run: `npm run e2e`

- [ ] **Step 2: Correggi quello che le prove trovano**

  Ogni correzione ha il suo test unitario, se il difetto è nella logica.

- [ ] **Step 3: Esegui tutto tre volte di fila**

  Run: `npm test && for i in 1 2 3; do npm run e2e || break; done && npm run typecheck && npm run lint && npm run format:check`
  Expected: tutto verde, 3 volte su 3.

- [ ] **Step 4: Lista di controllo manuale (Windows e macOS)**

  - [ ] Aggiungi CPU 315-2 PN/DP e CPU 314C-2 DP: albero, proprietà e riquadro "non caricate nel PLC".
  - [ ] Tabella di 200 tag: scorrimento, riempimento automatico trascinando, sovrapposizioni segnate.
  - [ ] Copia di righe da Excel o LibreOffice, incolla in BaaPortal e ritorno.
  - [ ] FB con multi-istanza, DB di istanza, offset coerenti con quelli che ci si aspetta da STEP 7.
  - [ ] Divisione orizzontale e verticale, finestra separata su un secondo monitor, scorciatoie nella finestra separata.
  - [ ] Recupero dopo aver chiuso il processo dal Task Manager o da Monitoraggio Attività.
  - [ ] Annulla e ripeti dopo 50 modifiche miste.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop docs/superpowers/plans/2026-10-18-tappa1b-modello-dati-plc.md
  git commit -m "test(e2e): modello dati PLC, editor in finestra separata e recupero automatico"
  ```

---

## Decisioni prese in questo piano (Rulings)

- **R1. Merker di sistema escluso.** La spec §9 lo elenca fra le proprietà, ma sulle CPU S7-300 non esiste: c'è solo sulle S7-1200/1500. Se fosse sbagliato, si aggiunge un campo.
- **R2. Ritenzione dei tag in sola lettura**, calcolata dalle proprietà della CPU. Su S7-300 la ritenzione è un intervallo da MB0, T0 e C0, non un attributo del singolo tag. Se fosse sbagliato, si rende modificabile aggiornando l'intervallo.
- **R3. Nomi senza distinzione di maiuscole, in un unico spazio** per tag, costanti, blocchi e UDT, come la tabella dei simboli S7-300. Se fosse sbagliato, si rifiuta un nome che STEP 7 accetterebbe.
- **R4. Valori sbagliati salvati e segnalati**, non rifiutati. Così una cella non si perde mai, ed è il comportamento visivo di TIA, con la cella rossa. Se fosse sbagliato, si aggiunge un rifiuto per le colonne scelte.
- **R5. Editor separato = portale React in una finestra `about:blank`.** Lo stato resta uno solo e non serve sincronizzare. Se Electron cambiasse il comportamento di `window.open`, si passa a una seconda finestra con sincronizzazione via IPC.
- **R6. Nessuna libreria di griglia.** In jsdom una griglia esterna virtualizzata non disegna righe, e i test lo richiedono. Se fosse sbagliato, servirà la virtualizzazione oltre le 5000 righe.
- **R7. Il codice dei segmenti è un'area di testo semplice in 1B.** Editor AWL, evidenziazione e controllo arrivano con il piano 1C. Se fosse sbagliato, nulla: il testo resta e il piano 1C lo prende così.
- **R8. Recupero ogni 60 secondi, una copia per percorso.** L'intervallo diventerà un'opzione in *Opzioni → Impostazioni* (piano 1F).
- **R9. Default dei nomi in italiano**, salvati come dati: Tabella delle variabili standard, Variabile_1, Blocco_1, Gruppo_1. Un progetto creato con l'interfaccia in inglese li ha in inglese.
- **R10. Formato 2 senza file sconosciuti.** File in più nello zip si ignorano. La regola della versione rende inutile conservarli, perché un file più nuovo viene rifiutato.

## Residui del piano 1A che restano aperti

Sono punti minori, ripresi quando si tocca il codice vicino:
- l'intercettazione di `drop` sul documento impedisce di trascinare testo nei campi. Il Task 9 la limita ai file (`dataTransfer.types` contiene `Files`) e lo prova;
- `isAbsolutePath` non distingue la piattaforma;
- `addRecentBestEffort` non registra gli errori;
- la lettura-modifica-scrittura dei recenti non ha un lock.
