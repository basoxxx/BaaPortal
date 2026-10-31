# Piano 1C — Linguaggio AWL: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nei segmenti dei blocchi OB/FB/FC si scrive codice AWL con evidenziazione, completamento e errori precisi. Tutte le istruzioni AWL dell'S7-300 sono riconosciute e controllate, insieme ai simboli, alle variabili locali, ai richiami di FB/FC/SFC/SFB e ai salti. Le sorgenti esterne AWL si importano, si generano dai blocchi e si riesportano identiche.

**Architecture:**

- Nuovo pacchetto `@baaportal/awl`, TypeScript puro: tabella delle istruzioni, lexer, parser, formattatore, conversione dei mnemonici, controllo semantico e completamento. Lavora su un contesto neutro, `AwlContext`, così non dipende dal modello di progetto.
- `@baaportal/project` costruisce quel contesto dal modello, aggiorna i riferimenti nel codice quando si rinomina qualcosa e passa al formato `.baap` 3 con le sorgenti esterne.
- Nuovo pacchetto `@baaportal/importers` (modulo della spec §7): sorgente AWL ↔ oggetti del modello.
- Le interfacce delle SFC/SFB stanno nel catalogo.
- L'editor è CodeMirror 6: l'evidenziazione, gli errori e il completamento vengono da `@baaportal/awl`. Nel modello il codice è salvato sempre con i mnemonici internazionali; l'editor lo mostra in tedesco se l'utente lo preferisce.

**Tech Stack:** quello dei piani 1A–1B, più CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/autocomplete`, `@codemirror/lint`, `@codemirror/language`) in `@baaportal/ui`.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §6 (compatibilità con gli strumenti Siemens);
- §7 (moduli `awl`, `importers`);
- §8.2 (Sorgenti esterne, Blocchi di sistema);
- §8.3 (editor AWL);
- §9 tappa 1: "Editor AWL completo, con tutte le istruzioni AWL dell'S7-300", "Definizioni (interfaccia) di tutte le SFC/SFB dell'S7-300 elencate nel manuale pubblico, richiamabili dai blocchi", "Sorgenti esterne AWL: genera blocchi da sorgente / genera sorgente dai blocchi, nel formato di testo standard Siemens che anche TIA Portal e STEP 7 esportano".

Piano generale: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, riga 1C. Codice di partenza: `main` dopo il piano 1B (`71a4e2b`).

## Global Constraints

- Valgono i Global Constraints dei piani 1A e 1B:
  - testi solo in `it.json`/`en.json`;
  - nomi di TIA in italiano, frasi con parole nostre;
  - niente copiato da prodotti Siemens;
  - `Mod` = Ctrl/⌘;
  - Electron sicuro;
  - ogni modifica al progetto è un solo passo di annulla/ripeti;
  - valori sbagliati salvati e segnalati (R4 del piano 1B).
- Istruzioni, operandi e sintassi delle sorgenti sono fatti tecnici e si prendono dai manuali pubblici Siemens: "Lista istruzioni (AWL) per S7-300 e S7-400", "Programmare con STEP 7", "Software di sistema per S7-300/400, funzioni standard e di sistema". I testi dei manuali non si copiano. I messaggi d'errore sono scritti da noi.
- **Mnemonici:** si supportano sia l'internazionale (`A`, `JU`, `SD`, `I`, `Q`, `C`) sia il tedesco (`U`, `SPA`, `SE`, `E`, `A`, `Z`). Nel modello il codice è **sempre internazionale**. Il default dell'interfaccia è internazionale, coerente con gli indirizzi `%I`/`%Q` del piano 1B.
- **Codice nei segmenti:** in 1C si controlla e basta, non si compila. "Compila", MC7 e _Informazioni → Compila_ arrivano con il piano 1E.
- **Sorgenti esterne:** sono nel formato di testo delle sorgenti AWL di STEP 7/TIA Portal. Le esportiamo in UTF-8 con BOM e righe CRLF. In importazione accettiamo:
  - con o senza BOM;
  - UTF-8 o Windows-1252;
  - righe CRLF o LF.
- **Formato `.baap` 3:** le sorgenti esterne si aggiungono ai dispositivi. Regola di versione invariata: il formato 2 si legge, un formato più nuovo viene rifiutato e le chiavi sconosciute si conservano.

## Review Focus

1. **Simboli con caratteri particolari nel codice**, per esempio `"Velocità nastro"`, `#"Motore 1"` (locale con spazio), `"DB dati".Asse[2].Pos`, nomi con maiuscole diverse da quelle dichiarate.
   - Sono riconosciuti, completati e rinominati correttamente.
   - Rinominare un tag, un blocco, un UDT, un membro o una variabile locale aggiorna il codice di tutti i segmenti in un solo passo di annulla, senza toccare commenti, stringhe e nomi che solo si somigliano.

   Test: Task 2, Task 3, Task 5.

2. **Sorgenti venute da strumenti veri**:
   - BOM, CRLF, accenti in Windows-1252;
   - mnemonici tedeschi;
   - righe di attributi TIA come `{ S7_Optimized_Access := 'FALSE' }`;
   - blocchi indicati con numero (`FB 1`) o con nome;
   - un errore a metà file.

   Ci si aspetta un'importazione senza crash, errori con riga e colonna, e niente importato a metà: o tutto in un passo di annulla, o niente.

   Test: Task 6 e Task 9.

3. **Blocchi grandi**: un segmento di 2000 righe e un blocco di 100 segmenti.
   - Scrivere resta fluido: il controllo è rimandato di 250 ms e richiede meno di 100 ms per 2000 righe.
   - L'evidenziazione non blocca.

   Test: Task 3 e Task 8.

4. **Cambio di mnemonico**:
   - passando da internazionale a tedesco e ritorno, il codice salvato non cambia di un carattere;
   - i token sconosciuti, i commenti e i simboli restano intatti;
   - un errore di battitura non viene "convertito" in un'altra istruzione.

   Test: Task 2 e Task 8.

5. **Salti, parentesi e richiami**:
   - etichette usate in un altro segmento dello stesso blocco: valide;
   - etichette doppie o mancanti: errore preciso;
   - `A(` senza `)`, annidamento oltre 7: errore;
   - `CALL` di un FC con un parametro mancante o di tipo sbagliato: errore sul parametro;
   - `CALL` di un FB senza DB di istanza: errore;
   - richiamo di una SFC/SFB del catalogo: valido.

   Test: Task 3 e Task 4.

---

## Struttura dei file

```
packages/awl/                         NUOVO
  src/index.ts
  src/instructions.ts   tabella delle istruzioni S7-300 (internazionale e tedesco, classi di operando)
  src/lexer.ts          token con posizione (riga, colonna, offset)
  src/parser.ts         istruzioni e operandi, CALL con parametri, etichette, commenti
  src/format.ts         forma canonica di un segmento
  src/mnemonics.ts      conversione internazionale ↔ tedesco basata sui token
  src/context.ts        AwlContext neutro (simboli, blocchi, locali, risolutore dei tipi, limiti)
  src/check.ts          controllo semantico di un blocco → AwlDiagnostic[]
  src/complete.ts       candidati di completamento in una posizione
  src/rename.ts         rinomina di riferimenti nel testo (token)
  test/*.test.ts  test/fixtures/*.awl
packages/catalog/src/systemBlocks.ts  NUOVO  SFC/SFB S7-300 con interfacce
packages/project/
  src/model.ts  src/baapFile.ts       (formato 3: sorgenti esterne)
  src/awlContext.ts                   NUOVO  modello → AwlContext
  src/plc.ts  src/memberRename.ts     (rinomina anche nel codice)
  src/members.ts  src/checks.ts       (SFB come tipo d'istanza)
packages/importers/                   NUOVO
  src/index.ts  src/awlSource/{decode,parse,generate}.ts
  test/*.test.ts  test/fixtures/*.awl
packages/ui/src/
  editors/awl/{AwlEditor.tsx,awlExtensions.ts,mnemonicPreference.ts}   NUOVI
  editors/block/NetworksView.tsx      (editor AWL, elenco dei problemi)
  editors/source/SourceEditor.tsx     NUOVO
  project/navigation/{treeModel.ts,treeIds.ts,objectCommands.ts}       (sorgenti, blocchi di sistema)
  project/navigation/sourceActions.ts NUOVO  importa, esporta, genera
  commands/useShortcuts.ts            (contenteditable come campo di testo)
apps/desktop/src/{main/ipc.ts,preload/index.ts,shared/rawBridge.ts}    (dialoghi di file generici)
apps/desktop/e2e/awl.spec.ts          NUOVO
```

---

### Task 1: `@baaportal/awl`: tabella delle istruzioni S7-300

**Files:**

- Create: `packages/awl/{package.json,tsconfig.json,vitest.config.ts}`, `packages/awl/src/{index,instructions}.ts`
- Test: `packages/awl/test/instructions.test.ts`

**Interfaces:**

- Consumes: niente (dipendenza `@baaportal/s7-types` per i tipi usati nei task seguenti).
- Produces:
  ```ts
  export type Mnemonic = 'international' | 'german';
  export type InstructionCategory =
    | 'bitLogic'
    | 'comparison'
    | 'conversion'
    | 'counter'
    | 'db'
    | 'jump'
    | 'integer'
    | 'float'
    | 'loadTransfer'
    | 'control'
    | 'shift'
    | 'timer'
    | 'wordLogic'
    | 'accumulator';
  export type OperandClass =
    | 'none'
    | 'bit'
    | 'status'
    | 'loadSource'
    | 'transferTarget'
    | 'timer'
    | 'counter'
    | 'label'
    | 'callTarget'
    | 'ucTarget'
    | 'dbOpen'
    | 'intConstant'
    | 'shiftCount'
    | 'byteConstant'
    | 'wordConstant'
    | 'dwordConstant'
    | 'pointerOrDword'
    | 'dwordLocation'
    | 'nopValue';
  export interface InstructionDef {
    id: string; // = mnemonico internazionale, es. 'A', 'A(', 'JU', 'SD', '==I', 'L', 'LAR1'
    german: string; // es. 'U', 'U(', 'SPA', 'SE', '==I'
    category: InstructionCategory;
    operands: OperandClass[]; // alternative ammesse; 'none' = senza operando
    opensBracket?: boolean; // A( AN( O( ON( X( XN(
    closesBracket?: boolean; // )
    endsBlock?: 'always' | 'conditional'; // BE BEU / BEB
  }
  export const INSTRUCTIONS: readonly InstructionDef[];
  export function findInstruction(text: string, mnemonic: Mnemonic): InstructionDef | undefined; // senza distinzione di maiuscole
  export const AREA_MNEMONICS: ReadonlyMap<string, { international: string; german: string }>; // I/E Q/A PI/PE PQ/PA C/Z, con dimensioni (IB/EB, QW/AW, …)
  export const STATUS_CONDITIONS: readonly { international: string; german: string }[]; // ==0 <>0 >0 <0 >=0 <=0 OV OS UO BR/BIE
  ```

Contenuto: tutte le istruzioni dell'S7-300, per categoria (internazionale/tedesco). Va verificato sul manuale pubblico "Lista istruzioni (AWL)", che le elenca nei due mnemonici.

| Categoria                   | Istruzioni                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logica a bit                | `A/U` `AN/UN` `O` `ON` `X` `XN` `O` (solo) `A(/U(` `AN(/UN(` `O(` `ON(` `X(` `XN(` `)` `=` `R` `S` `NOT` `SET` `CLR` `SAVE` `FN` `FP`                                              |
| Confronto                   | `==I` `<>I` `>I` `<I` `>=I` `<=I`, e le stesse con `D` e `R`                                                                                                                       |
| Conversione                 | `BTI` `ITB` `BTD` `ITD` `DTB` `DTR` `INVI` `INVD` `NEGI` `NEGD` `NEGR` `CAW/TAW` `CAD/TAD` `RND` `TRUNC` `RND+` `RND-`                                                             |
| Contatori                   | `CU/ZV` `CD/ZR`, più `S` `R` `FR` `L` `LC` con operando contatore                                                                                                                  |
| DB                          | `OPN/AUF` `CDB/TDB`, `L DBLG` `L DBNO` `L DILG` `L DINO`                                                                                                                           |
| Salti                       | `JU/SPA` `JL/SPL` `JC/SPB` `JCN/SPBN` `JCB/SPBB` `JNB/SPBNB` `JBI/SPBI` `JNBI/SPBIN` `JO/SPO` `JOS/SPS` `JZ/SPZ` `JN/SPN` `JP/SPP` `JM/SPM` `JPZ/SPPZ` `JMZ/SPMZ` `JUO/SPU` `LOOP` |
| Interi                      | `+I` `-I` `*I` `/I` `+` (costante) `+D` `-D` `*D` `/D` `MOD`                                                                                                                       |
| Virgola mobile              | `+R` `-R` `*R` `/R` `ABS` `SQR` `SQRT` `EXP` `LN` `SIN` `COS` `TAN` `ASIN` `ACOS` `ATAN`                                                                                           |
| Caricamento e trasferimento | `L` `T` `L STW` `T STW` `LAR1` `LAR2` `TAR1` `TAR2` `CAR/TAR` `+AR1` `+AR2`                                                                                                        |
| Controllo del programma     | `BE` `BEB` `BEU/BEA` `CALL` `CC` `UC` `MCR(` `)MCR` `MCRA` `MCRD`                                                                                                                  |
| Scorrimento e rotazione     | `SSI` `SSD` `SLW` `SRW` `SLD` `SRD` `RLD` `RRD` `RLDA` `RRDA`                                                                                                                      |
| Temporizzatori              | `SP/SI` `SE/SV` `SD/SE` `SS` `SF/SA`, più `R` `FR` `L` `LC` con operando temporizzatore. **Attenzione: `SE` vuol dire cose diverse nei due mnemonici.**                            |
| Logica a parola             | `AW/UW` `OW` `XOW` `AD/UD` `OD` `XOD`                                                                                                                                              |
| Accumulatori                | `TAK` `PUSH` `POP` `ENT` `LEAVE` `INC` `DEC` `BLD` `NOP 0` `NOP 1`                                                                                                                 |

Classi di operando, regole minime da codificare:

| Classe                                     | Istruzioni                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `bit` e `status`                           | `A AN O ON X XN`                                                                     |
| `bit`, con `timer` e `counter`             | `S R` (quando l'operando è T/C diventano le istruzioni dei temporizzatori/contatori) |
| `bit`                                      | `= FP FN`                                                                            |
| `loadSource`                               | `L`                                                                                  |
| `transferTarget`                           | `T`                                                                                  |
| `timer`                                    | `SP SE SD SS SF FR LC`                                                               |
| `counter`                                  | `CU CD FR LC`                                                                        |
| `label`                                    | tutti i salti e `LOOP`                                                               |
| `callTarget`                               | `CALL`                                                                               |
| `ucTarget`                                 | `UC CC`                                                                              |
| `dbOpen`                                   | `OPN`                                                                                |
| `intConstant`                              | `+`                                                                                  |
| `shiftCount` facoltativo                   | `SSI…RRD` (0–15 per parola, 0–32 per doppia parola)                                  |
| `byteConstant`                             | `INC DEC BLD`                                                                        |
| `wordConstant`/`dwordConstant` facoltative | logica a parola                                                                      |
| `pointerOrDword` facoltativo               | `LAR1 LAR2 +AR1 +AR2`                                                                |
| `dwordLocation` facoltativo                | `TAR1 TAR2`                                                                          |
| `nopValue` (0/1)                           | `NOP`                                                                                |
| `none`                                     | tutte le altre                                                                       |

- [ ] **Step 1: Crea il pacchetto**

  Stessa forma di `@baaportal/s7-types`. Dipendenza: `"@baaportal/s7-types": "*"`.

- [ ] **Step 2: Scrivi i test che falliscono**

  ```ts
  it('ogni istruzione ha id unico, mnemonico tedesco e almeno una classe di operando', () => {
    expect(new Set(INSTRUCTIONS.map((i) => i.id)).size).toBe(INSTRUCTIONS.length);
    for (const i of INSTRUCTIONS) {
      expect(i.german).not.toBe('');
      expect(i.operands.length).toBeGreaterThan(0);
    }
  });
  it('coppie note internazionale/tedesco', () => {
    const g = (id: string) => INSTRUCTIONS.find((i) => i.id === id)!.german;
    expect(
      [
        'A',
        'AN',
        'A(',
        'JU',
        'JC',
        'JCN',
        'SP',
        'SE',
        'SD',
        'SF',
        'CU',
        'CD',
        'OPN',
        'CDB',
        'BEU',
        'CAW',
        'CAR',
        'AW',
        'AD',
      ].map(g),
    ).toEqual([
      'U',
      'UN',
      'U(',
      'SPA',
      'SPB',
      'SPBN',
      'SI',
      'SV',
      'SE',
      'SA',
      'ZV',
      'ZR',
      'AUF',
      'TDB',
      'BEA',
      'TAW',
      'TAR',
      'UW',
      'UD',
    ]);
  });
  it('findInstruction non distingue maiuscole e rispetta il mnemonico', () => {
    expect(findInstruction('a', 'international')?.id).toBe('A');
    expect(findInstruction('u', 'german')?.id).toBe('A');
    expect(findInstruction('U', 'international')).toBeUndefined();
    expect(findInstruction('SE', 'international')?.id).toBe('SE');
    expect(findInstruction('SE', 'german')?.id).toBe('SD');
  });
  it('copre tutte le categorie della tabella del piano con almeno 160 voci', () => {
    /* conta per categoria; nessuna categoria vuota */
  });
  ```

- [ ] **Step 3: Esegui e verifica che falliscano**

  Run: `npx vitest run --project awl`
  Expected: FAIL.

- [ ] **Step 4: Scrivi la tabella**

  Verifica ogni coppia sul manuale pubblico. Nel rapporto metti l'elenco delle istruzioni per categoria e le fonti; segnala se un'istruzione della tabella del piano non risulta per l'S7-300.

- [ ] **Step 5: Esegui test, typecheck e lint**

  Run: `npx vitest run --project awl && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/awl package-lock.json
  git commit -m "feat(awl): tabella delle istruzioni AWL S7-300 con mnemonici internazionali e tedeschi"
  ```

---

### Task 2: `@baaportal/awl`: lexer, parser, forma canonica, conversione dei mnemonici

**Files:**

- Create: `packages/awl/src/{lexer,parser,format,mnemonics}.ts`
- Test: `packages/awl/test/{lexer,parser,format,mnemonics}.test.ts`

**Interfaces:**

- Consumes: `INSTRUCTIONS`, `findInstruction`, `AREA_MNEMONICS`, `STATUS_CONDITIONS` (Task 1); `parseLiteral`, `parseType` (s7-types).
- Produces:
  ```ts
  export interface Pos {
    line: number;
    col: number;
    offset: number;
  } // line e col da 0
  export interface Range {
    from: Pos;
    to: Pos;
  }
  export type TokenKind =
    | 'word'
    | 'number'
    | 'literal'
    | 'symbol'
    | 'local'
    | 'string'
    | 'comment'
    | 'punct'
    | 'label'
    | 'newline'
    | 'unknown';
  export interface Token {
    kind: TokenKind;
    text: string;
    range: Range;
  }
  export function lex(source: string): Token[];
  export type AreaId = 'I' | 'Q' | 'M' | 'PI' | 'PQ' | 'L' | 'DB' | 'DI' | 'T' | 'C';
  export type Operand =
    | {
        kind: 'address';
        area: AreaId;
        size: 'X' | 'B' | 'W' | 'D' | null;
        byte: number;
        bit?: number;
        db?: number;
        range: Range;
      } // DB10.DBX 2.0 → area 'DB', db 10
    | { kind: 'timerCounter'; area: 'T' | 'C'; number: number; range: Range }
    | { kind: 'symbol'; path: PathSegment[]; range: Range } // "Tag", "DB".a.b[1]
    | { kind: 'local'; path: PathSegment[]; range: Range } // #a.b, #"nome con spazi"
    | { kind: 'constant'; text: string; range: Range } // 5, L#5, W#16#FF, S5T#1S, 'AB', P#M 0.0, B#(1,2), C#123, 1.5e+002
    | {
        kind: 'indirect';
        area: AreaId;
        size: 'X' | 'B' | 'W' | 'D' | null;
        via:
          { kind: 'memory'; location: Operand } | { kind: 'register'; ar: 1 | 2; offset: string };
        range: Range;
      }
    | {
        kind: 'block';
        blockKind: 'FB' | 'FC' | 'SFB' | 'SFC' | 'DB' | 'DI';
        number: number;
        range: Range;
      }
    | { kind: 'labelRef'; name: string; range: Range }
    | { kind: 'status'; condition: string; range: Range } // ==0, OV, BR…
    | { kind: 'special'; name: 'STW' | 'DBLG' | 'DBNO' | 'DILG' | 'DINO'; range: Range };
  export interface PathSegment {
    name: string;
    quoted: boolean;
    index?: number[];
    range: Range;
  }
  export interface CallParam {
    name: string;
    nameRange: Range;
    arrow: ':=' | '=>';
    value: Operand | null;
    range: Range;
  }
  export interface Statement {
    label?: { name: string; range: Range };
    instruction: { text: string; def: InstructionDef | null; range: Range };
    operand?: Operand; // per CALL: blocco e, dopo ',', il DB di istanza in instanceDb
    instanceDb?: Operand;
    params?: CallParam[];
    comment?: string;
    range: Range;
  }
  export interface ParseError {
    code: 'SYNTAX' | 'UNKNOWN_INSTRUCTION' | 'BAD_OPERAND' | 'UNCLOSED_STRING' | 'UNCLOSED_PARAMS';
    range: Range;
    params?: Record<string, string>;
  }
  export function parseNetwork(
    source: string,
    mnemonic: Mnemonic,
  ): { statements: Statement[]; errors: ParseError[] };
  export function formatNetwork(source: string, mnemonic: Mnemonic): string; // forma canonica; testo non analizzabile lasciato com'è riga per riga
  export function convertMnemonics(source: string, from: Mnemonic, to: Mnemonic): string;
  ```

Grammatica (manuale pubblico "Lista istruzioni (AWL)", sorgenti STEP 7 e AWL di TIA):

- Una istruzione per riga. Il `;` finale è facoltativo, il `:` di etichetta è obbligatorio. Le etichette hanno al massimo 4 caratteri alfanumerici e iniziano con una lettera (`M001:`). Commenti: da `//` a fine riga. Righe vuote ammesse.
- **Operandi assoluti:**
  - spazio facoltativo tra area e numero, `%` facoltativo (`A %I0.0`, `A I 0.0`);
  - bit `I 0.0`, `DBX 2.1`, `DIX 0.0`, `L 0.1`;
  - byte, parola, doppia parola `IB/IW/ID`, `QB…`, `MB…`, `PIB/PIW/PID`, `PQ…`, `LB/LW/LD`, `DBB/DBW/DBD`, `DIB/DIW/DID`;
  - DB qualificato `DB10.DBX 2.0`;
  - `T 5`, `C 3`, `DB 10`, `FC 1`, `FB 1`, `SFC 20`, `SFB 4`.
- **Simbolici:** `"Tag"`, `"DB".membro.sotto[3]`, `"DB".arr[1,2]`. Locali: `#membro.campo`, `#"nome con spazi"`.
- **Indiretti:**
  - in memoria: `I [MD 2]`, `DBX [DID 4]`, `T [MW 0]`, `OPN DB [MW 2]`;
  - registro, interno all'area: `M [AR1, P#2.0]`;
  - registro, tra aree: `B [AR1, P#0.0]`, `W [AR2, P#0.0]`, `D [AR1, P#0.0]`, `[AR1, P#0.0]` (bit).
- **Costanti:** tutte quelle di `parseLiteral`, più quelle della sola AWL:
  - `B#16#`, `W#16#`, `DW#16#`, `2#…`, `L#`;
  - `C#` (contatore BCD), `B#(a,b)`, `B#(a,b,c,d)`;
  - caratteri `'A'` fino a 4;
  - puntatori `P#0.0`, `P#M 0.0`, `P#DB10.DBX 0.0 BYTE 10`;
  - reali con esponente.
- **CALL:**
  - `CALL "Blocco"` oppure `CALL FC 1`;
  - con istanza: `CALL "FB", "FB_DB"` o `CALL FB 1, DB 1`;
  - multi-istanza: `CALL #Istanza`;
  - parametri tra parentesi su una o più righe, separati da `,`, con `:=` per Input e InOut e `=>` per Output (forma TIA). `:=` è ammesso per tutti (forma STEP 7).
- **Forma canonica di `formatNetwork`:**
  - etichetta e `:` seguiti da un tab, altrimenti un tab iniziale;
  - mnemonico in maiuscolo nel mnemonico scelto, uno spazio, operando;
  - indirizzi senza spazi interni, nel formato TIA `%I0.0` e `%DB10.DBX2.0`;
  - simboli come scritti;
  - `;` finale;
  - commento separato da `//`;
  - parametri di CALL uno per riga, con 3 spazi di rientro e `:=`/`=>` allineati al nome più lungo.
- **`convertMnemonics`:** cambia solo i token riconosciuti come istruzione, area o condizione di stato nel mnemonico di partenza. Commenti, stringhe, simboli, locali e token sconosciuti non si toccano. `convertMnemonics(convertMnemonics(s, a, b), b, a) === s` per ogni testo senza token ambigui, con test su tutte le fixture.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('analizza istruzioni, etichette, commenti e operandi', () => {
    const { statements, errors } = parseNetwork(
      'M001: A %I0.0 // avvio\n      AN "Stop"\n      = #Uscita.bit;\n      JC M001',
      'international',
    );
    expect(errors).toEqual([]);
    expect(
      statements.map((s) => [s.label?.name ?? '', s.instruction.def?.id, s.operand?.kind]),
    ).toEqual([
      ['M001', 'A', 'address'],
      ['', 'AN', 'symbol'],
      ['', '=', 'local'],
      ['', 'JC', 'labelRef'],
    ]);
  });
  it('indirizzi indiretti e qualificati', () => {
    /* 'L DB10.DBW 4', 'A I [MD 2]', 'T W [AR1, P#2.0]', 'OPN DB [MW 2]' → kind e campi attesi */
  });
  it('CALL con istanza e parametri su più righe, := e =>', () => {
    const { statements } = parseNetwork(
      'CALL "Nastro", "Nastro_DB"\n(  Avvio := %I0.0,\n   Errore => %M10.0\n);',
      'international',
    );
    expect(statements[0]!.params!.map((p) => [p.name, p.arrow])).toEqual([
      ['Avvio', ':='],
      ['Errore', '=>'],
    ]);
  });
  it('mnemonico tedesco', () => {
    /* 'U E 0.0\nSPB M1\nSE T 1' con 'german' → A, JC, SD */
  });
  it('istruzione sconosciuta: errore con posizione esatta', () => {
    expect(parseNetwork('A I0.0\nXYZ M0.0', 'international').errors).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_INSTRUCTION',
        range: expect.objectContaining({ from: expect.objectContaining({ line: 1, col: 0 }) }),
      }),
    ]);
  });
  it('formatNetwork produce la forma canonica e si rilegge identica', () => {
    /* fixture → format(format(x)) === format(x) */
  });
  it('convertMnemonics andata e ritorno su tutte le fixture; commenti e simboli intatti', () => {
    /* … '"U" // U' resta */
  });
  it('2000 righe si analizzano in meno di 100 ms', () => {
    /* soglia di prova 1000 ms per la CI */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project awl`
  Expected: FAIL.

- [ ] **Step 3: Implementa `lex`, `parseNetwork`, `formatNetwork` e `convertMnemonics`**

  Con le fixture in `test/fixtures/` (scritte da noi): ogni istruzione della tabella almeno una volta, con le forme di operando ammesse.

- [ ] **Step 4: Esegui test, typecheck e lint**

  Run: `npx vitest run --project awl && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/awl
  git commit -m "feat(awl): lexer, parser, forma canonica e conversione dei mnemonici"
  ```

---

### Task 3: `@baaportal/awl`: contesto, controllo semantico, completamento, rinomina nel testo

**Files:**

- Create: `packages/awl/src/{context,check,complete,rename}.ts`
- Test: `packages/awl/test/{check,complete,rename}.test.ts`

**Interfaces:**

- Consumes: Task 1–2; `DataType`, `TypedMember`, `TypeResolver`, `parseType`, `parseLiteral`, `sameName`, `addressFitsType` (s7-types).
- Produces:
  ```ts
  export interface AwlInterface {
    input: TypedMember[];
    output: TypedMember[];
    inOut: TypedMember[];
    static: TypedMember[];
    temp: TypedMember[];
    returnType: DataType | null;
  }
  export interface AwlBlockInfo {
    name: string;
    kind: 'OB' | 'FB' | 'FC' | 'DB' | 'IDB' | 'SFC' | 'SFB';
    number: number;
    iface?: AwlInterface;
    dbMembers?: TypedMember[];
    instanceOf?: string;
  }
  export interface AwlContext {
    owner: { kind: 'OB' | 'FB' | 'FC'; iface: AwlInterface };
    symbol(name: string): { kind: 'tag' | 'constant'; type: DataType | null } | undefined; // sameName
    block(
      ref: { name: string } | { kind: AwlBlockInfo['kind']; number: number },
    ): AwlBlockInfo | undefined;
    resolve: TypeResolver;
    limits?: {
      timers: number;
      counters: number;
      mBytes: number;
      inputBytes: number;
      outputBytes: number;
    };
  }
  export type AwlCode =
    | 'SYNTAX'
    | 'UNKNOWN_INSTRUCTION'
    | 'BAD_OPERAND'
    | 'OPERAND_MISSING'
    | 'OPERAND_NOT_ALLOWED'
    | 'TYPE_MISMATCH'
    | 'UNKNOWN_SYMBOL'
    | 'UNKNOWN_LOCAL'
    | 'UNKNOWN_MEMBER'
    | 'UNKNOWN_BLOCK'
    | 'UNKNOWN_LABEL'
    | 'DUPLICATE_LABEL'
    | 'LABEL_TOO_LONG'
    | 'BRACKET_UNCLOSED'
    | 'BRACKET_UNEXPECTED'
    | 'BRACKET_DEPTH'
    | 'MCR_DEPTH'
    | 'ADDRESS_OUT_OF_RANGE'
    | 'CALL_PARAM_MISSING'
    | 'CALL_PARAM_UNKNOWN'
    | 'CALL_PARAM_TYPE'
    | 'CALL_PARAM_DIRECTION'
    | 'CALL_INSTANCE_MISSING'
    | 'CALL_INSTANCE_WRONG'
    | 'LOCAL_NOT_ACCESSIBLE'
    | 'CONSTANT_OUT_OF_RANGE';
  export interface AwlDiagnostic {
    severity: 'error' | 'warning';
    code: AwlCode;
    network: number;
    range: Range;
    params?: Record<string, string>;
  }
  export function checkBlockCode(
    networks: string[],
    ctx: AwlContext,
    mnemonic: Mnemonic,
  ): AwlDiagnostic[];
  export interface Completion {
    label: string;
    kind: 'instruction' | 'tag' | 'constant' | 'local' | 'member' | 'block' | 'label' | 'param';
    detail?: string;
    apply: string;
  }
  export function completeAt(
    networks: string[],
    network: number,
    offset: number,
    ctx: AwlContext,
    mnemonic: Mnemonic,
  ): { from: number; options: Completion[] };
  export type RenameTarget =
    | { kind: 'symbol'; oldName: string } // tag, costante, blocco, DB, UDT? (gli UDT non compaiono nel codice)
    | {
        kind: 'member';
        root: 'symbol' | 'local';
        rootName: string | null;
        path: string[];
        oldName: string;
      } // "DB".a.old / #a.old; rootName null = qualsiasi
    | { kind: 'local'; oldName: string }
    | { kind: 'callParam'; block: string; oldName: string }; // nomi dei parametri nei CALL di quel blocco
  export function renameInSource(
    source: string,
    target: RenameTarget,
    newName: string,
    mnemonic: Mnemonic,
  ): string; // invariato se non c'è nulla
  ```

Regole del controllo (`checkBlockCode`):

- **Etichette:** valide in tutto il blocco, anche tra segmenti. Errori: doppie (`DUPLICATE_LABEL` su ogni copia), usate e non definite (`UNKNOWN_LABEL`), oltre 4 caratteri (`LABEL_TOO_LONG`).
- **Parentesi:** `A( … )` al massimo 7 livelli per segmento (`BRACKET_DEPTH`); una `)` senza apertura dà `BRACKET_UNEXPECTED`, un'apertura mai chiusa a fine segmento dà `BRACKET_UNCLOSED`. `MCR(` `)MCR` al massimo 8 livelli (`MCR_DEPTH`).
- **Classe dell'operando**, dopo la risoluzione del suo tipo:
  - `bit` = indirizzo `X`, simbolo o locale `Bool`, indiretto bit, `T`/`C` (per `A`…);
  - `loadSource` = B/W/D, simbolo o locale di 8/16/32 bit (`Byte`, `Char`, `Word`, `Int`, `S5Time`, `Date`, `DWord`, `DInt`, `Real`, `Time`, `Time_Of_Day`), costante, `T`, `C`, `STW`, `DBLG`…, puntatore `P#`;
  - `transferTarget` = come `loadSource` ma senza costanti e puntatori.

  Un tipo complesso (Struct, Array, UDT, String, Date_And_Time) usato come `L`/`T` dà `TYPE_MISMATCH`. Un operando in una classe non ammessa dà `OPERAND_NOT_ALLOWED`; operando assente dove serve, `OPERAND_MISSING`.

- **Simboli:**
  - `"X"` cerca tag o costante, oppure un blocco o DB per nome; non trovato → `UNKNOWN_SYMBOL`;
  - `"DB".a.b` risolve i membri del DB globale o dell'interfaccia dell'FB del DB di istanza; membro sbagliato → `UNKNOWN_MEMBER` sul segmento;
  - `#x` cerca nell'interfaccia del blocco; non trovato → `UNKNOWN_LOCAL`;
  - in un FC, `#x` di Static non esiste.
- **Limiti:** `T`/`C` oltre i limiti della CPU danno `ADDRESS_OUT_OF_RANGE`, se ci sono limiti.
- **CALL:**
  - il bersaglio deve esistere (FB, FC, SFC, SFB);
  - FB e SFB richiedono un DB di istanza: un `IDB` il cui `instanceOf` è quel blocco, oppure `#multi` di tipo `"FB"` in Static, altrimenti `CALL_INSTANCE_MISSING`/`CALL_INSTANCE_WRONG`;
  - FC e SFC non vogliono istanza;
  - parametri: nome sconosciuto → `CALL_PARAM_UNKNOWN`; FC e SFC: tutti obbligatori (Input, Output, InOut, più `RET_VAL` se non `Void`), altrimenti `CALL_PARAM_MISSING` sul `CALL`; FB: facoltativi;
  - `=>` su un Input → `CALL_PARAM_DIRECTION`;
  - tipo: elementari uguali (`sameName` sul nome canonico); costanti accettate se `parseLiteral` le accetta per quel tipo; `Any` accetta qualunque indirizzo, simbolo o puntatore; `Pointer` accetta indirizzo e `P#`; `Timer`←`T n`, `Counter`←`C n`, `Block_FC/FB/DB`←`FC/FB/DB n` o un simbolo di quel tipo; complessi solo da un simbolo o locale dello stesso tipo. Altrimenti `CALL_PARAM_TYPE`.
- **Costanti** fuori intervallo per l'istruzione (`INC 300`, `SLW 20`) → `CONSTANT_OUT_OF_RANGE`.
- **Gli errori del parser** diventano diagnostica con lo stesso codice.

Completamento (`completeAt`):

- inizio riga o dopo un'etichetta: istruzioni nel mnemonico scelto;
- dopo `"` o in posizione di operando: tag, costanti, blocchi, DB;
- dopo `#`: locali;
- dopo `"DB".` o `#x.`: i membri di quel livello;
- dopo un salto: le etichette del blocco;
- dentro i parametri di un `CALL`: i nomi dei parametri non ancora assegnati.

Ordine dei candidati: per tipo, poi per nome. `apply` mette le virgolette dove servono.

Rinomina (`renameInSource`): lavora sui token e sostituisce solo:

- i simboli il cui nome è uguale (`sameName`);
- il segmento di percorso giusto;
- i locali e i nomi dei parametri dei CALL a quel blocco.

Il nuovo nome si scrive tra virgolette se contiene caratteri non identificatori (`#"a b"`). Il resto del testo resta identico byte per byte.

- [ ] **Step 1: Scrivi i test che falliscono**

  Un contesto di prova costruito a mano: tag `Avvio` Bool, `Velocità nastro` Int, FC `Calcola` con Input `A: Int`, Output `R: Int`, `RET_VAL: Void`, FB `Nastro` con IDB `Nastro_DB`, DB `Dati` con `Asse: Struct{Pos: Real}`. Poi:

  ```ts
  it('salti tra segmenti, etichette doppie e mancanti', () => {
    expect(
      codes(checkBlockCode(['JU M1', 'M1: NOP 0', 'JC M2\nM1: NOP 0'], ctx, 'international')),
    ).toEqual(['UNKNOWN_LABEL', 'DUPLICATE_LABEL', 'DUPLICATE_LABEL']);
  });
  it('parentesi: non chiusa, inattesa, oltre 7 livelli', () => {
    /* … */
  });
  it('classi di operando: L di un Bool, T di una costante, A di una parola', () => {
    /* TYPE_MISMATCH, OPERAND_NOT_ALLOWED, OPERAND_NOT_ALLOWED */
  });
  it('simboli con spazi e accenti, maiuscole diverse, membri di DB', () => {
    // L di un Int e T su un Real sono ammessi (AWL non controlla la larghezza tra L e T): resta solo il membro sbagliato
    expect(
      checkBlockCode(
        ['L "VELOCITÀ NASTRO"\nT "Dati".Asse.Pos\nL "Dati".Asse.Manca'],
        ctx,
        'international',
      ).map((d) => d.code),
    ).toEqual(['UNKNOWN_MEMBER']);
  });
  it('CALL: FC con parametro mancante, tipo sbagliato, direzione sbagliata; FB senza istanza', () => {
    /* … */
  });
  it('SFC dal contesto: CALL "READ_CLK" valido con tutti i parametri', () => {
    /* … */
  });
  it('completamento dopo #, dopo "Dati".Asse., dopo JU, dentro CALL', () => {
    /* … */
  });
  it('renameInSource tocca solo i riferimenti giusti', () => {
    const src = 'A "Avvio" // "Avvio" nel commento\nA "Avvio1"\nL "Dati".Asse.Pos';
    expect(
      renameInSource(src, { kind: 'symbol', oldName: 'avvio' }, 'Start', 'international'),
    ).toBe('A "Start" // "Avvio" nel commento\nA "Avvio1"\nL "Dati".Asse.Pos');
    expect(
      renameInSource(
        src,
        { kind: 'member', root: 'symbol', rootName: 'Dati', path: ['Asse'], oldName: 'Pos' },
        'Posizione',
        'international',
      ),
    ).toContain('"Dati".Asse.Posizione');
  });
  it('controllo di un blocco di 100 segmenti × 20 righe in meno di 100 ms', () => {
    /* soglia di prova 2000 ms per la CI */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project awl`
  Expected: FAIL.

- [ ] **Step 3: Implementa contesto, controllo, completamento e rinomina**

- [ ] **Step 4: Esegui test, typecheck e lint**

  Run: `npx vitest run --project awl && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/awl
  git commit -m "feat(awl): controllo semantico, completamento e rinomina dei riferimenti nel codice"
  ```

---

### Task 4: Catalogo SFC/SFB e SFB come tipo d'istanza

**Files:**

- Create: `packages/catalog/src/systemBlocks.ts`
- Modify: `packages/catalog/src/index.ts`, `packages/project/src/{members,checks}.ts`
- Test: `packages/catalog/test/systemBlocks.test.ts`, `packages/project/test/checks.test.ts`

**Interfaces:**

- Consumes: `TypedMember`, `parseType` (s7-types); `typeResolver`, `checkDevice` (piano 1B).
- Produces:
  ```ts
  export interface SystemBlock {
    kind: 'SFC' | 'SFB';
    number: number;
    name: string;
    input: TypedMember[];
    output: TypedMember[];
    inOut: TypedMember[];
    static?: TypedMember[];
    returnType?: string;
    source: string;
  }
  export const SYSTEM_BLOCKS: readonly SystemBlock[];
  export function findSystemBlock(
    ref: { name: string } | { kind: 'SFC' | 'SFB'; number: number },
  ): SystemBlock | undefined;
  ```

Regole:

- Tutte le SFC/SFB dell'S7-300 del manuale pubblico "Software di sistema per S7-300/400, funzioni standard e di sistema", con numero, nome, parametri (nome, sezione, tipo) e tipo di `RET_VAL`. Esempi: SFC 0 `SET_CLK`, SFC 1 `READ_CLK`, SFC 20 `BLKMOV`, SFC 21 `FILL`; SFB 0–5 `CTU`/`CTD`/`CTUD`/`TP`/`TON`/`TOF`.
- Una per voce, con `source`.
- Niente commenti copiati.
- Una SFC/SFB che non si trova per l'S7-300 resta fuori ed è segnalata nel rapporto.
- `typeResolver(device)` risolve anche i nomi delle SFB come `{ kind: 'fb', sections }`, così `"TON"` vale come tipo di multi-istanza.
- `checkDevice` accetta un DB di istanza con `instanceOf` = nome di una SFB. `INSTANCE_FB_MISSING` scatta solo se il nome non è né un FB né una SFB.
- I nomi delle SFC/SFB **non** entrano nello spazio dei simboli del progetto: un tag può chiamarsi `TON`. Nel codice `"TON"` cerca prima i simboli del progetto e poi il catalogo.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('SFB 4 TON e SFC 1 READ_CLK con le interfacce attese', () => {
    expect(findSystemBlock({ kind: 'SFB', number: 4 })!.name).toBe('TON');
    expect(sig(findSystemBlock({ name: 'TON' })!)).toEqual({
      input: ['IN:Bool', 'PT:Time'],
      output: ['Q:Bool', 'ET:Time'],
    });
    expect(findSystemBlock({ name: 'READ_CLK' })!.returnType).toBe('Int');
  });
  it('numeri e nomi unici per tipo, tipi validi, fonte presente', () => {
    /* … */
  });
  it('DB di istanza di SFB e multi-istanza "TON" senza errori', () => {
    /* checkDevice */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project catalog --project project`
  Expected: FAIL.

- [ ] **Step 3: Raccogli i dati e implementa**

  Usa WebSearch/WebFetch su documentazione pubblica Siemens. Niente software Siemens.

- [ ] **Step 4: Esegui test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/catalog packages/project
  git commit -m "feat(catalog): interfacce SFC/SFB S7-300 da fonti pubbliche; SFB come tipo d'istanza"
  ```

---

### Task 5: `@baaportal/project`: contesto AWL, rinomina nel codice, formato 3 con sorgenti esterne

**Files:**

- Create: `packages/project/src/awlContext.ts`
- Modify: `packages/project/src/{model,baapFile,plc,memberRename,index}.ts`, `packages/project/package.json` (dipendenza `@baaportal/awl`)
- Test: `packages/project/test/{awlContext,codeRename,baapFileV3}.test.ts`

**Interfaces:**

- Consumes: Task 3 (`AwlContext`, `renameInSource`), Task 4 (`findSystemBlock`, `SYSTEM_BLOCKS`).
- Produces:
  ```ts
  export const FORMAT_VERSION = 3;
  export interface ExternalSource {
    id: string;
    name: string;
    text: string;
  } // name: nome di file, es. 'Motori.awl'
  // PlcDevice: + sources: ExternalSource[];  ObjectRef: + { kind: 'source'; deviceId: string; id: string }
  export function createAwlContext(
    device: PlcDevice,
    blockId: string,
    cpu: CpuType | undefined,
  ): AwlContext;
  export function createSource(name: string, text: string, newId?: NewId): ExternalSource;
  ```

Regole:

- **Formato 3:**
  - `device.json` aggiunge `sources: [{ id, name }]` in ordine;
  - il testo sta in `plc/<dev>/sources/<id>.awl`, in UTF-8 senza BOM, come scritto;
  - formato 2 → `sources: []`;
  - un file elencato ma mancante → `INVALID_SCHEMA`.
- **Codice salvato:** `Network.source` è testo AWL **internazionale**. Il formato 2 aveva testo libero, quindi in lettura non si converte nulla.
- **Rinomina** (dentro la stessa ricetta di `renameWithReferences` / `renameMemberWithOverrides`): si aggiornano i `source` di tutti i segmenti di tutti i blocchi del dispositivo con `renameInSource`:
  - tag o costante → `symbol`;
  - blocco o DB → `symbol`;
  - per un FB, anche i parametri dei `CALL` → `callParam`;
  - membro di un FB → `callParam` nei CALL a quell'FB, `member` sui suoi DB di istanza e `local` dentro l'FB stesso;
  - membro di un DB globale → `member` con `rootName` del DB;
  - membro di un UDT → `member` con `rootName: null` e il nome come ultimo segmento, ma solo dove il tipo risolto è quell'UDT. Se la risoluzione non è possibile si lascia com'è: meglio non toccare che toccare sbagliato;
  - membro di un FC o OB → `local` dentro quel blocco.
- **`createAwlContext`:**
  - simboli = tag e costanti del dispositivo;
  - blocchi = blocchi del dispositivo, più SFC/SFB del catalogo (prima il progetto);
  - `iface` e `dbMembers` con `toTypedMembers`;
  - `resolve` = `typeResolver(device)`;
  - `limits` dalla CPU.
- Le sorgenti si possono aggiungere, rinominare ed eliminare. Copia e incolla delle sorgenti non c'è in 1C.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('formato 2 si apre con sources [], formato 3 andata e ritorno con il testo identico', () => {
    /* testo con accenti e CRLF */
  });
  it('rinominare un tag aggiorna il codice di tutti i segmenti in un passo', () => {
    /* device con 2 FB che usano "Avvio" */
  });
  it("rinominare un parametro di FB aggiorna i CALL dei chiamanti e #param dentro l'FB", () => {
    /* … */
  });
  it('rinominare un membro di UDT tocca solo i percorsi di quel tipo', () => {
    /* "Dati".Asse.Pos (Asse: "Asse") sì, "Altro".Pos no */
  });
  it("createAwlContext: simboli, blocchi, SFC/SFB, locali dell'OB1", () => {
    /* … */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project project`
  Expected: FAIL.

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/project package-lock.json
  git commit -m "feat(project): formato .baap 3 con sorgenti esterne, contesto AWL e rinomina nel codice"
  ```

---

### Task 6: `@baaportal/importers`: sorgenti esterne AWL ↔ oggetti del modello

**Files:**

- Create: `packages/importers/{package.json,tsconfig.json,vitest.config.ts}`, `packages/importers/src/{index.ts,awlSource/decode.ts,awlSource/parse.ts,awlSource/generate.ts}`
- Test: `packages/importers/test/{decode,awlSourceParse,awlSourceGenerate,roundTrip}.test.ts`, `packages/importers/test/fixtures/*.awl`

**Interfaces:**

- Consumes: `@baaportal/awl` (lexer, `parseNetwork`, `formatNetwork`, `convertMnemonics`, `Mnemonic`); modello e creatori del piano 1B (`createCodeBlock`, `createGlobalDb`, `createInstanceDb`, `createUdt`, `Member`, `nextFreeNumber`).
- Produces:
  ```ts
  export function decodeSourceBytes(bytes: Uint8Array): {
    text: string;
    encoding: 'utf-8' | 'utf-8-bom' | 'windows-1252';
  };
  export function encodeSourceText(text: string): Uint8Array; // UTF-8 con BOM, CRLF
  export interface SourceError {
    line: number;
    col: number;
    code: string;
    params?: Record<string, string>;
  } // line/col da 1, per i messaggi
  export interface ParsedSource {
    mnemonic: Mnemonic;
    units: SourceUnit[];
  }
  export type SourceUnit =
    | {
        kind: 'UDT';
        name: string;
        number?: number;
        udt: Omit<Udt, 'id' | 'number' | 'group'> & { number?: number };
      }
    | {
        kind: 'OB' | 'FB' | 'FC';
        name: string;
        number?: number;
        block: Omit<CodeBlock, 'id' | 'group' | 'number'> & { number?: number };
      }
    | {
        kind: 'DB';
        name: string;
        number?: number;
        db: Omit<GlobalDb, 'id' | 'group' | 'number'> & { number?: number };
      }
    | {
        kind: 'IDB';
        name: string;
        number?: number;
        instanceOf: string;
        overrides: Record<string, string>;
      };
  export function parseAwlSource(
    text: string,
  ): { ok: true; source: ParsedSource } | { ok: false; errors: SourceError[] };
  export function applySource(
    device: PlcDevice,
    parsed: ParsedSource,
    newId: NewId,
  ): { created: ObjectRef[]; replaced: ObjectRef[] }; // modifica sul posto (ricetta immer)
  export function generateAwlSource(
    device: PlcDevice,
    refs: ObjectRef[],
    mnemonic: Mnemonic,
  ): string; // in ordine di dipendenza: UDT, FB/FC richiamati, poi chiamanti, DB
  ```

Formato della sorgente: manuale pubblico "Programmare con STEP 7", capitolo sulle sorgenti AWL, ed esportazioni AWL di TIA Portal.

- **Unità:**
  - `TYPE "Nome"` … `STRUCT` … `END_STRUCT;` … `END_TYPE`;
  - `ORGANIZATION_BLOCK "Main"` / `OB 1`;
  - `FUNCTION_BLOCK "Nome"` / `FB 1`;
  - `FUNCTION "Nome" : VOID` (o un tipo) / `FC 1`;
  - `DATA_BLOCK "Nome"` / `DB 1`, con `STRUCT … END_STRUCT;` oppure `"FB"` / `FB 1` per l'istanza, poi `BEGIN` con valori attuali `membro := valore;` e `END_DATA_BLOCK`.
- **Attributi:** `TITLE =`, `AUTHOR :`, `FAMILY :`, `NAME :`, `VERSION : x.y`, `KNOW_HOW_PROTECT`, `UNLINKED`, `READ_ONLY`, `NON_RETAIN`. Le righe tra graffe `{ … }` di TIA si ignorano, senza errore.
- **Dichiarazioni:** `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR`, `VAR_TEMP`, chiuse da `END_VAR`. Ogni riga è `nome : tipo := iniziale; // commento`, con `STRUCT`/`ARRAY[..] OF` annidati. `nome` può essere tra virgolette.
- **Codice:** `BEGIN`, poi per ogni segmento `NETWORK`, `TITLE = …`, eventuali righe di commento `//`, istruzioni.
- **Mnemonico:** si rileva per file. Si analizza il codice con entrambi e si sceglie quello con meno `UNKNOWN_INSTRUCTION`; a parità vince l'internazionale. Il codice si salva convertito in internazionale e formattato con `formatNetwork`.
- **Numeri:**
  - un'unità indicata con numero tiene quel numero;
  - con un nome che esiste già, tiene il numero dell'oggetto esistente e l'oggetto viene sostituito (`replaced`);
  - altrimenti `nextFreeNumber`.
- **Tutto o niente:** con errori `parseAwlSource` restituisce solo errori e nulla viene applicato. `applySource` va chiamata dentro un solo `edit`.
- **`generateAwlSource`:**
  - forma canonica, blocchi per nome tra virgolette, mnemonico richiesto, un'unità separata da una riga vuota;
  - `VERSION` sempre presente;
  - i valori iniziali solo se impostati;
  - attributi solo se veri.
- **"Si riesportano identiche":** per ogni fixture in forma canonica, `generate(apply(parse(fixture))) === fixture`, dopo la normalizzazione delle righe (CRLF) e del BOM fatta da `encodeSourceText`/`decodeSourceBytes`.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('decodifica: BOM, UTF-8, Windows-1252 con accenti, CRLF', () => {
    /* 'Velocit\xe0' in 1252 → 'Velocità' */
  });
  it('sorgente con UDT, FB, FC, OB1, DB globale e DB di istanza si importa', () => {
    /* fixture tutto.awl → units in ordine con i tipi giusti */
  });
  it('mnemonico tedesco rilevato e convertito in internazionale', () => {
    /* fixture tedesco.awl */
  });
  it("righe { S7_Optimized_Access := 'FALSE' } ignorate; FB 1 assoluto tiene il numero", () => {
    /* … */
  });
  it('errore a metà file: elenco con riga e colonna, niente applicato', () => {
    const r = parseAwlSource(fixture('errore_riga_12.awl'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatchObject({ line: 12, col: 5 });
  });
  it('andata e ritorno identica su tutte le fixture canoniche', () => {
    /* … */
  });
  it('generate mette gli UDT e gli FB richiamati prima dei chiamanti', () => {
    /* … */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project importers`
  Expected: FAIL.

- [ ] **Step 3: Implementa**

  Le fixture sono scritte da noi in forma canonica: nessun file di progetto o sorgente della ditta va nel repository.

- [ ] **Step 4: Esegui tutti i test, typecheck e lint**

  Run: `npm test && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/importers package-lock.json
  git commit -m "feat(importers): sorgenti esterne AWL, da sorgente a blocchi e da blocchi a sorgente"
  ```

---

### Task 7: Bridge: dialoghi di file generici

**Files:**

- Modify: `packages/ui/src/bridge.ts`, `packages/ui/test/fakeBridge.ts`, `apps/desktop/src/{main/ipc.ts,preload/index.ts,shared/rawBridge.ts}`
- Test: `apps/desktop/e2e/bridge.spec.ts` (esteso)

**Interfaces:**

- Produces:
  ```ts
  export interface FileFilter { name: string; extensions: string[] }  // name già tradotto dal chiamante
  showOpenFileDialog(opts: { filters: FileFilter[]; multi?: boolean }): Promise<string[]>;   // [] se annullato
  showSaveFileDialog(opts: { defaultName: string; filters: FileFilter[] }): Promise<string | null>;
  ```

Regole:

- Canali `dialog:open-file` e `dialog:save-file`, controllati sul frame mittente, aperti sulla finestra principale.
- I file si leggono e si scrivono con `readFile` e `writeFileAtomic`, che esistono già.
- `FakeBridge`: `openFileResults: string[][]` e `saveFileResults: (string | null)[]`.

- [ ] **Step 1: Scrivi i test**

  e2e: stub di `dialog.showOpenDialog`/`showSaveDialog` nel main che restituisce percorsi; `window.baa.showOpenFileDialog(...)` li restituisce.

- [ ] **Step 2: Implementa main, preload, `rawBridge`, `BaaBridge` e `FakeBridge`**

- [ ] **Step 3: Esegui unit ed e2e, typecheck e lint**

  Run: `npm test && npm run e2e && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/desktop packages/ui
  git commit -m "feat(desktop): dialoghi generici di apertura e salvataggio file"
  ```

---

### Task 8: Editor AWL nei segmenti

**Files:**

- Create: `packages/ui/src/editors/awl/{AwlEditor.tsx,awlExtensions.ts,mnemonicPreference.ts,awl.css}`
- Modify: `packages/ui/src/editors/block/NetworksView.tsx`, `packages/ui/src/commands/useShortcuts.ts`, `packages/ui/src/i18n/{it,en}.json`, `packages/ui/package.json` (CodeMirror)
- Test: `packages/ui/test/{awlExtensions.test.ts,awlEditor.test.tsx,networksView.test.tsx}`

**Interfaces:**

- Consumes: Task 2–3 (`lex`, `checkBlockCode`, `completeAt`, `convertMnemonics`), Task 5 (`createAwlContext`), `edit` e `flushPendingEdits` (piano 1B).
- Produces:
  ```ts
  export function useMnemonic(): [Mnemonic, (m: Mnemonic) => void]; // localStorage 'baa.mnemonic', predefinito 'international'
  export function AwlEditor(p: {
    value: string;
    mnemonic: Mnemonic;
    diagnostics: AwlDiagnostic[];
    complete: (offset: number) => { from: number; options: Completion[] };
    onCommit(text: string): void;
    onChange?(text: string): void;
    'aria-label': string;
  }): JSX.Element;
  export function awlHighlight(): Extension; // decorazioni dai token di lex: istruzione, indirizzo, simbolo, locale, costante, etichetta, commento
  ```

Regole:

- **Un editor CodeMirror per segmento** al posto dell'area di testo del piano 1B.
  - Mostra `convertMnemonics(source, 'international', mnemonic)`.
  - Alla conferma salva `convertMnemonics(testo, mnemonic, 'international')`.
- **Conferma:**
  - all'uscita dal focus, con un solo `edit` (`history.editNetworkCode`) solo se il testo è cambiato;
  - annulla e ripeti dentro l'editor sono quelli di CodeMirror;
  - `flushPendingEdits` toglie il focus all'editor, che è un `contenteditable`, e quindi conferma.
- **Scorciatoie:** `handleShortcutKeydown` tratta come campo di testo anche gli elementi `isContentEditable`, così dentro l'editor resta globale solo `Mod+S`.
- **Controllo:**
  - `checkBlockCode` su tutti i segmenti del blocco, rimandato di 250 ms dopo l'ultima modifica, con il testo non ancora confermato del segmento attivo;
  - gli errori del segmento sono sottolineati (`@codemirror/lint`), con il messaggio i18n `awl.diag.<CODE>`.
  - Sotto i segmenti c'è un elenco "Problemi": segmento, riga e messaggio. Un clic mette il focus sull'editor nel punto giusto.
- **Completamento:** `@codemirror/autocomplete` con `completeAt`; si apre con Ctrl+Spazio e da solo dopo `"`, `#` e `.`.
- **Evidenziazione:** decorazioni dal lexer, con classi `baa-awl-<kind>` e colori dal tema.
- **Mnemonico:** un `<select>` "Mnemonica: Internazionale / Tedesco" nell'intestazione dell'editor di blocco. Si sposterà in _Opzioni → Impostazioni_ con il piano 1F (Ruling R2 di questo piano).
- **Finestra separata:** CodeMirror riceve come radice il documento del suo contenitore (`root: element.ownerDocument`), così funziona anche nella finestra separata del piano 1B.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // awlExtensions.test.ts (puro)
  it('decorazioni per tipo di token', () => {
    /* 'A "Avvio" // x' → classi istruzione, simbolo, commento */
  });
  // awlEditor.test.tsx / networksView.test.tsx (jsdom, view.dispatch)
  it("conferma all'uscita dal focus: un solo passo di annulla, testo salvato in internazionale", async () => {
    /* mnemonico tedesco: 'U E 0.0' → salvato 'A I 0.0' (forma come scritta, solo mnemonici convertiti) */
  });
  it("Mod+S dentro l'editor salva il testo appena scritto", async () => {
    /* … */
  });
  it("Mod+Z dentro l'editor non annulla il progetto", async () => {
    /* history.past invariata */
  });
  it('errori sottolineati ed elenco Problemi con clic che porta al punto', async () => {
    /* … */
  });
  it('cambio di mnemonico: il codice salvato non cambia', async () => {
    /* … */
  });
  it('completamento dopo #', async () => {
    /* … */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa l'editor, le estensioni, la preferenza e l'integrazione**

- [ ] **Step 4: Esegui tutti i test, e2e, typecheck e lint**

  Run: `npm test && npm run e2e && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui package-lock.json
  git commit -m "feat(ui): editor AWL con evidenziazione, completamento ed errori nei segmenti"
  ```

---

### Task 9: Sorgenti esterne e blocchi di sistema nell'interfaccia

**Files:**

- Create: `packages/ui/src/editors/source/SourceEditor.tsx`, `packages/ui/src/project/navigation/sourceActions.ts`
- Modify: `packages/ui/src/project/navigation/{treeModel,treeIds,objectCommands,ProjectTree,DetailsView}.tsx|ts`, `packages/ui/src/editors/registry.tsx`, `packages/ui/src/state/workArea.ts` (EditorKind `source`), `packages/ui/src/i18n/{it,en}.json`
- Test: `packages/ui/test/{sourceActions.test.ts,sources.test.tsx}`

**Interfaces:**

- Consumes: Task 5 (`ExternalSource`, `createSource`, ObjectRef `source`), Task 6 (`decodeSourceBytes`, `encodeSourceText`, `parseAwlSource`, `applySource`, `generateAwlSource`), Task 7 (dialoghi).
- Produces: azioni senza nuove interfacce pubbliche oltre a quelle elencate nei file.

Regole:

- **Albero, "Sorgenti esterne"** (ora attivo):
  - "Aggiungi nuovo file esterno": `showOpenFileDialog` con filtro "Sorgente AWL (*.awl)", più file insieme. Ogni file diventa una sorgente: nome = nome del file (unico con `uniqueName`), testo = `decodeSourceBytes`. Un solo `edit`;
  - i nodi delle sorgenti si rinominano ed eliminano con le operazioni del piano 1B;
  - copia e incolla disattivati.
- **Doppio clic su una sorgente** apre `SourceEditor`: CodeMirror con evidenziazione delle parole chiave della sorgente e del codice AWL, conferma all'uscita dal focus, un `edit`.
- **Menu contestuale della sorgente:**
  - "Genera blocchi dalla sorgente": `parseAwlSource`.
    - Con errori: niente cambia, gli errori vanno in _Informazioni → Generale_, uno per riga, come "Sorgente <nome>, riga R, colonna C: <messaggio>". Un clic apre la sorgente nel punto.
    - Se ci sono oggetti da sostituire: `askQuestion` con il loro elenco. Poi `applySource` in un solo `edit` e un messaggio di riepilogo.
  - "Esporta…": `showSaveFileDialog`, poi `writeFileAtomic(encodeSourceText(text))`.
- **Menu contestuale di blocchi, UDT, cartella "Blocchi di programma" e "Tipi di dati PLC":** "Genera sorgente dai blocchi" (gli oggetti selezionati, o tutti quelli della cartella). Crea una sorgente nuova `<primo nome>.awl` (unica) con `generateAwlSource` nel mnemonico scelto, la seleziona e la apre. Un `edit`.
- **"Blocchi di sistema":** elenca le SFC/SFB richiamate nel codice dei blocchi del dispositivo. Si ricava con `parseNetwork` (cache per testo del segmento). Nodi in sola lettura, in vista dettagli Nome, Numero, Tipo.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('Aggiungi nuovo file esterno: due file, Windows-1252 decodificato, un passo di annulla', async () => {
    /* … */
  });
  it('Genera blocchi dalla sorgente: crea FB/DB/UDT, sostituisce con conferma, un passo', async () => {
    /* … */
  });
  it('sorgente con errore: niente cambia, errori in Informazioni con riga e colonna', async () => {
    /* … */
  });
  it('Genera sorgente dai blocchi ed Esporta: file con BOM e CRLF', async () => {
    /* bridge.files */
  });
  it('Blocchi di sistema elenca TON e READ_CLK richiamati', async () => {
    /* … */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run --project ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Esegui tutti i test, e2e, typecheck e lint**

  Run: `npm test && npm run e2e && npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): sorgenti esterne AWL (importa, genera, esporta) e blocchi di sistema"
  ```

---

### Task 10: Prove end-to-end del piano 1C e lista di controllo

**Files:**

- Create: `apps/desktop/e2e/awl.spec.ts`
- Modify: `apps/desktop/e2e/helpers.ts` (se servono aiuti)

Prove ("Fatto quando" del piano 1C):

1. **Sorgente di prova** (`packages/importers/test/fixtures/collaudo.awl`, con UDT, FB con multi-istanza `"TON"`, FC, OB1, DB, DB di istanza):
   1. si aggiunge da file (stub del dialogo);
   2. si generano i blocchi;
   3. nell'OB1 si modifica una riga;
   4. un errore scritto apposta (`JU MANCA`) appare sottolineato e nei Problemi con il segmento e la riga giusti;
   5. si corregge;
   6. si rigenera la sorgente dai blocchi e si esporta;
   7. il file esportato è **identico byte per byte** alla fixture modificata come atteso (riga cambiata compresa).
2. **Rinomina:** rinominare il tag usato in tre segmenti aggiorna il codice, e Mod+Z lo ripristina.
3. **Mnemonico tedesco:** si scrive in tedesco, si salva, si riapre il progetto. Il codice è salvato in internazionale e mostrato in tedesco.
4. **Finestra separata:** l'editor AWL di un blocco aperto nella finestra separata conferma all'uscita dal focus e con Mod+S.

- [x] **Step 1: Scrivi le prove e verifica che falliscano dove manca la funzione**

  Run: `npm run e2e`

- [x] **Step 2: Correggi quello che le prove trovano**

  Ogni correzione di logica ha il suo test unitario.

- [x] **Step 3: Esegui tutto tre volte di fila**

  Run: `npm test && for i in 1 2 3; do npm run e2e || break; done && npm run typecheck && npm run lint && npm run format:check`
  Expected: verde 3 volte su 3.

- [ ] **Step 4: Lista di controllo manuale (Windows e macOS)**

  - [ ] Importa una sorgente esportata da TIA Portal o STEP 7, se disponibile in ditta o dall'amico, in sola lettura e senza metterla nel repository: si importa o dà errori precisi.
  - [ ] Esporta una sorgente da BaaPortal e aprila con TIA Portal o STEP 7, se c'è una licenza regolare (spec §6): si importa.
  - [ ] Scrittura veloce in un segmento di 500 righe: niente scatti.
  - [ ] Completamento con Ctrl+Spazio su Windows e ⌃Spazio su macOS. Su macOS Ctrl+Spazio può essere preso dal sistema per le sorgenti di input: verificare.

- [x] **Step 5: Commit**

  ```bash
  git add apps/desktop docs/superpowers/plans/2026-10-19-tappa1c-linguaggio-awl.md
  git commit -m "test(e2e): linguaggio AWL, sorgenti esterne, rinomina e mnemonico tedesco"
  ```

---

## Decisioni prese in questo piano (Rulings)

- **R1. Codice salvato sempre con i mnemonici internazionali.** Il tedesco è solo visualizzazione e scrittura. Il file resta unico e confrontabile, e cambiare preferenza non tocca il progetto. Se fosse sbagliato: servirebbe un campo "mnemonico" per blocco.
- **R2. La preferenza del mnemonico sta nell'intestazione dell'editor di blocco** finché non arriva _Opzioni → Impostazioni_ (piano 1F). Se fosse sbagliato: si sposta.
- **R3. In 1C si controlla, non si compila.** "Compila" e _Informazioni → Compila_ arrivano con il piano 1E.
- **R4. Le sorgenti esterne stanno nel progetto**, come in TIA. Si importano da file e si esportano su file a richiesta.
- **R5. La rinomina nel codice cambia solo quello che si risolve con certezza.** Un percorso che non si sa risolvere resta com'è, e la diagnostica lo segnala.
- **R6. Copia e incolla delle sorgenti non c'è in 1C.** Si possono duplicare esportando e reimportando.
- **R7. Il controllo AWL non entra in `checkDevice`.** Per ora vive nell'editor; la compilazione del piano 1E lo riunirà in _Informazioni → Compila_ e nello stato dei nodi dell'albero.
