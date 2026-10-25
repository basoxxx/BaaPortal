# Piano 4A — Editor KOP — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** l'utente crea un blocco OB/FC/FB in KOP e disegna i segmenti con l'editor grafico: contatti, rami paralleli, rami a T, bobine, set/reset, fronti, temporizzatori, contatori, confronti, MOVE, matematica, conversioni, logica a parola, scorrimenti, salti, RET, richiami di blocco. Ogni segmento si traduce in AWL secondo gli schemi di STEP 7, e il blocco si compila, si prova nel simulatore e si carica nella CPU come un blocco AWL.

**Architettura:**

- **Nuovo pacchetto `packages/ladfbd`** (`@baaportal/ladfbd`): il modello della rete KOP (tipi + schema zod), le operazioni di modifica pure, la validazione e la traduzione KOP → AWL con la mappa elemento → righe AWL. Dipende solo da `@baaportal/awl` (per i test di andata) e da `zod`.
- **Modello del progetto:** `Network` riceve il campo opzionale `lad?: LadNetwork`. In un blocco KOP la sorgente AWL di ogni segmento si **rigenera** dal KOP: la funzione `kopSources(block, dev)` di `packages/project` è l'unica fonte del codice AWL di un blocco KOP per compilazione, controllo, hash delle modifiche ed esportazione. L'editor scrive anche `network.source` a ogni modifica, così un lettore vecchio vede l'AWL. `FORMAT_VERSION` resta 4 (campo opzionale, gli oggetti sono `looseObject`).
- **Compilatore:** invariato salvo il byte della lingua nell'intestazione MC7 (KOP = `0x02`) e l'apertura del cancello `LINGUAGGIO_NON_COMPILABILE` per KOP.
- **Interfaccia:** `NetworksView` mostra, per un blocco KOP, un `LadNetworkEditor` per segmento: un motore di impaginazione puro (`ladLayout.ts`) mette gli elementi su una griglia; il componente li disegna con HTML posizionato e fili SVG, gestisce selezione, tastiera, modifica degli operandi. La scheda «Istruzioni» delle task card diventa la tavolozza KOP.

**Tecnologie:** TypeScript, zod, React 19, zustand + immer, CodeMirror solo per la vista AWL in sola lettura, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md` §Tappa 4 (righe 277–283), riga 86 (catena unica KOP → AWL → MC7), 88 (KOP in JSON nel `.baap`), 111 (codice secondo gli schemi STEP 7), 131 (pacchetto `ladfbd`), 204 (editor grafici con trascinamento). Ricerca sugli schemi: `docs/linguaggi/kop-awl.md` (è la fonte di ogni forma AWL di questo piano; i paragrafi sono citati come §n.m).

Fuori da questo piano: FUP (4B), conversione AWL → KOP, cambio linguaggio, osservazione grafica (4C). La mappa elemento → righe AWL si prepara già qui per il 4C.

## Global Constraints

- **Clean-room:** le forme AWL vengono solo da `docs/linguaggi/kop-awl.md` (manuali pubblici e deduzioni). Niente software Siemens decompilato.
- **Nessun BLD inventato:** il traduttore non emette mai `BLD` (§5.2: i numeri 102/103 non sono confermati). Le CALL li ricevono dal pacchetto `mc7` come oggi.
- **Regole adottate dove la ricerca dice «ipotesi»** (tutte elencate in `docs/limiti-noti.md`):
  - parallelo: regole 1–4 di §2.6 (`O x` per rami di un solo contatto; `A…/O/A…` per serie semplici; `O(`…`)` per un ramo con parallelo annidato, confronto o fronte; `A(`…`)` attorno al parallelo se c'è logica prima o dopo);
  - confronto: `L; L; cmp` senza parentesi se è il primo elemento sulla barra, altrimenti in `A(`…`)` (in un ramo parallelo `O(`…`)`);
  - uscita intermedia `(#)`: `= op` seguito da `A op` (H3);
  - nodo usato più volte (ramo a T con logica, o con uscite che distruggono l'RLO): bit L dopo i TEMP dichiarati, ripartendo in ogni segmento (H4), `= L b` e poi `A L b` davanti a ogni uscita;
  - etichette automatiche `_001`, `_002`… numerate per blocco (H11);
  - box che non possono sbagliare (MOVE, logica a parola, scorrimenti, conversioni «no» di §4.6) con ENO collegato: `_00n: A BR` subito dopo il corpo (H12); con EN sulla barra ed ENO collegato: `SET; SAVE; CLR; A BR`;
  - CALL in box: niente `AN OV; SAVE; CLR` (H17); bobina CALL sulla barra: `UC FC n` (H16), con logica `CC FC n`;
  - pin BOOL d'ingresso di un CALL con logica: `= L b` prima della logica di EN, e `pin:=L b.c` nella CALL (H18, senza `BLD 103`).
- **Limiti voluti di questo piano** (diagnostica chiara, mai AWL sbagliato): un box (con o senza EN) dentro un ramo parallelo non è ammesso; un ramo a T può contenere box solo come primo elemento della sua serie; i pin BOOL d'ingresso con logica esistono solo per i box SR/RS, temporizzatori, contatori e CALL.
- **Operandi:** un operando KOP è il testo AWL dell'operando (`I 0.0`, `"Avvio"`, `#locale`, `MW10`, `S5T#5S`, `C#5`, `T 1`, `DB10.DBX2.0`). Il traduttore non lo interpreta; lo controlla il controllo AWL sul codice generato e l'errore torna sull'elemento tramite la mappa delle righe.
- **Lingua e testi:** interfaccia in italiano e inglese, chiavi uguali in `it.json` ed `en.json`; nomi TIA dove esistono («Contatto NA», «Contatto NC», «Bobina», «Apri ramo», «Chiudi ramo»). Mnemonici: l'AWL salvato è sempre internazionale; la vista AWL generata segue l'impostazione dei mnemonici come l'editor AWL.
- **Tasti come STEP 7:** F2 contatto NA, F3 contatto NC, F7 bobina, F8 apri ramo, F9 chiudi ramo, Canc elimina, Invio modifica l'operando.
- **Nessun test su CPU reale:** la compilazione e il simulatore si provano; la CPU no. `docs/limiti-noti.md` lo dice per il KOP.

## Review Focus

1. **Segmento incompleto** (nessuna uscita, operando vuoto `??.?`, ramo parallelo vuoto): il blocco non si compila, il segmento mostra l'errore sull'elemento giusto e nel pannello «Problemi»; nessun AWL parziale finisce nel blocco compilato. → test in Task 3 e Task 7.
2. **TEMP dell'interfaccia cambiati dopo il disegno:** i bit L dei rami a T si spostano con la fine dei TEMP dichiarati, e la compilazione dopo l'aggiunta di una variabile TEMP non sovrappone mai un bit automatico a una variabile. → test in Task 5.
3. **Due box con ENO nello stesso blocco, in segmenti diversi:** le etichette automatiche non si ripetono nel blocco e non si scontrano con le etichette dell'utente (che iniziano con una lettera). → test in Task 4.
4. **Undo/redo dopo modifiche grafiche:** ogni modifica è una voce di storia; annullare rimette sia il KOP sia l'AWL del segmento. → test in Task 7.
5. **Progetto con un blocco KOP aperto da un `.baap` salvato prima di questo piano o con `lad` mancante:** un segmento KOP senza `lad` e con sorgente vuota diventa un segmento vuoto; con sorgente non vuota resta in AWL in sola lettura con il messaggio «Segmento in AWL: la conversione arriva con il piano 4C», e la compilazione usa quella sorgente. → test in Task 5 e Task 8.

---

## Task 1: etichette automatiche nell'AWL e documento di ricerca

**Files:**

- Modify: `packages/awl/src/lexer.ts:125` (`LABEL`), `packages/awl/src/parser.ts:41` (`LABEL_REF`)
- Test: `packages/awl/test/lexer.test.ts` (o il file che oggi prova le etichette), `packages/mc7/test/` (un test di compilazione)
- Add: `docs/linguaggi/kop-awl.md` (già scritto, da committare)

- [ ] **Step 1: test che fallisce** — `_001: NOP 0` e `JNB _001` si analizzano senza errori; `_001` è un'etichetta di 4 caratteri; `_ABCD:` (5) dà `LABEL_TOO_LONG`; `1AB:` resta un errore. Una rete `A I 0.0 / JNB _001 / L MW 10 / T MW 12 / _001: NOP 0` compila con `compileBlock`.
- [ ] **Step 2: eseguire** `npx vitest run --project awl` → FAIL.
- [ ] **Step 3: implementare** — `LABEL = /[A-Za-z_][A-Za-z0-9_]{0,3}[ \t]*:(?!=)/y` (il limite di 4 resta controllato dove oggi si controlla `LABEL_TOO_LONG`), `LABEL_REF = /[A-Za-z_][A-Za-z0-9_]*/y`. Il completamento e l'evidenziazione AWL (`packages/ui/src/editors/awl/awlExtensions.ts`) devono riconoscere la stessa forma: controllare e allineare.
- [ ] **Step 4:** `npx vitest run --project awl --project mc7` → PASS.
- [ ] **Step 5: commit** `feat(awl): etichette che iniziano con _ (etichette automatiche del KOP)` insieme a `docs/linguaggi/kop-awl.md`.

## Task 2: pacchetto `ladfbd` — modello, schema e modifiche

**Files:**

- Create: `packages/ladfbd/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/model.ts`, `src/schema.ts`, `src/edit.ts`, `src/catalog.ts`
- Test: `packages/ladfbd/test/edit.test.ts`, `test/schema.test.ts`
- Modify: `apps/desktop/package.json` (devDependency), root `package-lock.json` (`npm install`)

**Interfaces — Produces** (`src/model.ts`, esportati da `index.ts`):

```ts
export type CmpFn = '==I'|'<>I'|'>I'|'<I'|'>=I'|'<=I'|'==D'|'<>D'|'>D'|'<D'|'>=D'|'<=D'|'==R'|'<>R'|'>R'|'<R'|'>=R'|'<=R';
export type LadElem =
  | { id: string; k: 'contact'; neg: boolean; op: string }          // NA / NC
  | { id: string; k: 'not' }
  | { id: string; k: 'cmp'; fn: CmpFn; in1: string; in2: string }
  | { id: string; k: 'edge'; dir: 'P' | 'N'; mem: string }           // (P) / (N) in linea
  | { id: string; k: 'posneg'; dir: 'P' | 'N'; bit: string; mem: string } // box POS / NEG
  | { id: string; k: 'midline'; op: string }                         // (#)
  | { id: string; k: 'parallel'; branches: LadElem[][] }             // ≥ 2 rami
  | LadBox;
export type LadBox = {
  id: string; k: 'box'; box: BoxKind;
  instance: string;                 // T 1, C 10, M 0.0 (SR/RS), FC 1, FB 1 / DB 1 → "FB 1, DB 1", '' se non serve
  pins: Record<string, string>;     // pin di dati: nome → operando ('' = non collegato)
  boolPins: Record<string, LadElem[]>; // pin BOOL d'ingresso con logica propria, esclusi EN e il primo pin
  enoUsed?: boolean;                // calcolato dalla traduzione, non salvato: vedi Task 4
};
export type LadOut =
  | { id: string; k: 'coil' | 'set' | 'reset'; op: string }
  | { id: string; k: 'tcoil'; fn: 'SP'|'SE'|'SD'|'SS'|'SF'; timer: string; value: string }
  | { id: string; k: 'ccoil'; fn: 'SC'|'CU'|'CD'; counter: string; value: string } // value solo per SC
  | { id: string; k: 'jmp' | 'jmpn'; label: string }
  | { id: string; k: 'ret' | 'save' | 'mcrOpen' | 'mcrClose' | 'mcra' | 'mcrd' }
  | { id: string; k: 'callCoil'; block: string }                     // "FC 11" / "SFC 46"
  | { id: string; k: 'opn'; db: string };                            // "DB 10" / "DI 5"
export type LadNode = { id: string; series: LadElem[]; outs: (LadOut | LadNode)[] };
export type LadNetwork = { label?: string; root: LadNode };
```

`BoxKind` e il catalogo (`src/catalog.ts`) elencano ogni box con i pin in ordine: `{ kind, group, en: boolean, firstPin, boolInputs: string[], dataInputs: {name, type}[], outputs: {name, type}[], awl: …, canFail: boolean }` per: SR, RS, S_PULSE, S_PEXT, S_ODT, S_ODTS, S_OFFDT, S_CU, S_CD, S_CUD, MOVE, ADD_I…DIV_I, ADD_DI…MOD_DI, ADD_R…DIV_R, ABS, SQR, SQRT, EXP, LN, SIN, COS, TAN, ASIN, ACOS, ATAN, le conversioni di §4.6, WAND_W…WXOR_DW, SHR_I, SHR_DI, SHL_W, SHR_W, SHL_DW, SHR_DW, ROL_DW, ROR_DW, CALL (pin presi dall'interfaccia del blocco chiamato, Task 5). `canFail` segue la colonna «errore» di §4.5–§4.6.

Operazioni pure in `src/edit.ts` (tutte ritornano una nuova `LadNetwork`; `newId: () => string` iniettato):

- `emptyNetwork(newId): LadNetwork` — un nodo con serie vuota e una bobina con operando `''`.
- `insertElem(net, at: InsertPoint, elem): LadNetwork` con `InsertPoint = { node: string; index: number } | { branchOf: string; branch: number; index: number }` (posizione nella serie di un nodo o di un ramo parallelo).
- `openBranch(net, elemId, newId): LadNetwork` — avvolge l'elemento in un `parallel` con un secondo ramo contenente un contatto NA vuoto; se l'elemento è già dentro un parallelo, aggiunge un ramo a quel parallelo.
- `closeBranchAfter(net, branchElemId, targetElemId)`: estende il ramo parallelo fino a includere gli elementi della serie fino a `targetElemId` (F9).
- `addOutput(net, nodeId, out | node)` — ramo a T: una nuova uscita sul nodo.
- `removeElem(net, id)` — elimina elemento, ramo o uscita; un parallelo rimasto con un ramo solo si scioglie nella serie; l'ultima uscita di un nodo radice diventa una bobina vuota.
- `updateElem(net, id, patch)` — operandi, pin, tipo (NA ↔ NC).
- `findElem(net, id)` e `walk(net)` per gli altri pacchetti.

- [ ] **Step 1: test che falliscono** — `edit.test.ts`: dopo `emptyNetwork` + `insertElem` di due contatti + `openBranch` sul primo, la struttura è `series:[parallel([[c1],[cNuovo]]), c2]`; `removeElem` del ramo nuovo riporta `series:[c1, c2]`; `addOutput` con un `LadNode` crea un ramo a T; ogni id resta unico; nessuna funzione modifica l'argomento (prova con `Object.freeze` profondo). `schema.test.ts`: `ladNetworkSchema.parse` accetta una rete con tutti i tipi di elemento e uscita, rifiuta `k` sconosciuto e un `parallel` con meno di 2 rami, e conserva chiavi in più (oggetti `looseObject`).
- [ ] **Step 2:** `npx vitest run --project ladfbd` → FAIL.
- [ ] **Step 3: implementare** i file sopra (cablaggio del pacchetto come `packages/awl`: `exports {'.':'./src/index.ts'}`, `type: module`, `scripts.typecheck`). Eseguire `npm install` alla radice.
- [ ] **Step 4:** `npx vitest run --project ladfbd && npm run typecheck` → PASS.
- [ ] **Step 5: commit** `feat(ladfbd): modello delle reti KOP, schema e modifiche`.

## Task 3: traduzione KOP → AWL — logica a bit e uscite

**Files:**

- Create: `packages/ladfbd/src/toAwl.ts`, `src/validate.ts`
- Test: `packages/ladfbd/test/toAwl.bits.test.ts`, `test/validate.test.ts`

**Interfaces — Produces:**

```ts
export type LadDiag = { elemId: string; code: LadDiagCode; params?: Record<string, string> };
export type LadDiagCode = 'NO_OUTPUT' | 'EMPTY_OPERAND' | 'EMPTY_BRANCH' | 'MIDLINE_ON_RAIL'
  | 'RET_ON_RAIL' | 'EDGE_ON_RAIL' | 'BOX_IN_PARALLEL' | 'BOX_IN_TBRANCH' | 'BAD_LABEL' | 'BAD_INSTANCE';
export type LineOwner = { line: number; elemId: string };   // riga 0-based della sorgente generata
export type NetworkAwl = { source: string; lines: LineOwner[]; diagnostics: LadDiag[]; nextLabel: number };
export function networkToAwl(net: LadNetwork, opts: { tempEnd: number; firstLabel: number }): NetworkAwl;
export function validateNetwork(net: LadNetwork): LadDiag[];
```

`tempEnd` = primo byte L libero dopo i TEMP dichiarati. `firstLabel` = numero della prossima etichetta automatica del blocco. Con diagnostiche di errore `source` è `''` (mai AWL parziale). Il formato delle righe è quello di `formatNetwork` di `@baaportal/awl` (mnemonici internazionali); il test confronta dopo `formatNetwork` di entrambe le parti.

Forme (ogni test cita il paragrafo di `kop-awl.md`):

- serie §2.1; parallelo §2.2–§2.6 con le regole 1–4 del Global Constraints; NOT §2.7; uscite sullo stesso nodo §2.8 (`=`, `S`, `R`, bobine temporizzatore `L valore; SD T 1` §3.1, contatore `L C#…; S C n` / `CU C n` / `CD C n` §3.3, `SAVE` §2.14, `MCR(`/`)MCR`/`MCRA`/`MCRD`/`OPN` §4.14); `(#)` §2.9; fronti `(P)`/`(N)` §2.13; confronti §3.5; contatti di stato §2.15 (operandi `OV`, `BR`, `==0`…: sono contatti normali); salti §4.12 (`JU` se la serie è vuota, altrimenti `JC`/`JCN`); RET §4.13 (`SAVE; BEC`); bobina CALL (`UC`/`CC`); etichetta del segmento davanti alla prima istruzione.
- **Uscite che distruggono l'RLO** (`jmp`, `jmpn`, `ret`, `callCoil`, `mcrOpen`) devono essere l'ultima uscita del nodo; se non lo sono, o se il nodo ha un'uscita `LadNode` (ramo a T con logica), il nodo si salva in un bit: `= L tempEnd.0` (poi `.1`, … fino a `.7`, poi byte successivo) e ogni uscita comincia con `A L x.y`. Un nodo con sole bobine `=`/`S`/`R`/temporizzatori/contatori/`SAVE` usa la forma consecutiva di §2.8.
- `validateNetwork` dà: `NO_OUTPUT` (nodo senza uscite), `EMPTY_OPERAND` (operando `''`, tranne pin di dati facoltativi dei box), `EMPTY_BRANCH`, `MIDLINE_ON_RAIL` (`(#)` primo nella serie della radice), `RET_ON_RAIL`, `EDGE_ON_RAIL`, `BAD_LABEL` (etichetta del segmento non `^[A-Za-z][A-Za-z0-9]{0,3}$`).

- [ ] **Step 1: test che falliscono** — un test per forma, con l'AWL atteso copiato da `kop-awl.md` (§2.1, 2.2, 2.3, 2.4, 2.5, 2.6 forma A, 2.7, 2.8, 2.9, 2.10 senza `BLD 102`, 2.11, 2.13, 2.14, 3.1, 3.3, 3.5 nei due casi, 4.12, 4.13, 4.14, bobina CALL sulla barra e con logica). In più: ramo a T con `jmp` non ultimo → bit L; due rami a T nello stesso segmento con `tempEnd: 20` → `L 20.0` e `L 20.1`; `lines` copre ogni riga e punta all'elemento che l'ha generata; ogni sorgente generata passa `parseNetwork` senza errori. `validate.test.ts`: un test per codice di diagnostica, e `networkToAwl` con un errore dà `source: ''`.
- [ ] **Step 2:** `npx vitest run --project ladfbd` → FAIL.
- [ ] **Step 3: implementare** `toAwl.ts` come visita ricorsiva che emette `{text, elemId}`; le regole del parallelo decidono la forma guardando i rami (tutti contatti singoli / serie di soli contatti / altro) e se c'è logica prima o dopo nella serie.
- [ ] **Step 4:** `npx vitest run --project ladfbd` → PASS.
- [ ] **Step 5: commit** `feat(ladfbd): traduzione KOP → AWL di contatti, rami e uscite`.

## Task 4: traduzione KOP → AWL — box

**Files:**

- Modify: `packages/ladfbd/src/toAwl.ts`, `src/validate.ts`
- Create: `packages/ladfbd/src/block.ts`
- Test: `packages/ladfbd/test/toAwl.boxes.test.ts`, `test/block.test.ts`

**Interfaces — Produces:**

```ts
export function blockToAwl(nets: (LadNetwork | null)[], tempEnd: number): { networks: NetworkAwl[] };
```

`null` = segmento senza KOP (resta la sua sorgente, Task 5). Le etichette `_001`… crescono nel blocco nell'ordine dei segmenti; il formato è `_` + 3 cifre (`_001`…`_999`; oltre, diagnostica `TOO_MANY_LABELS` sul box).

Forme:

- **EN/ENO** §4.1, quattro casi; ENO «collegato» = il box ha qualcosa a destra nella serie o il nodo ha uscite dopo di lui. `canFail` falso → H12 come nel Global Constraints. Cascata §4.9. MOVE §4.4, matematica §4.5, conversioni §4.6, logica a parola §4.7, scorrimenti §4.8 (forma con ACCU2: `L N; L IN; SLW; T OUT`).
- **CALL** §4.11: `CALL FC n` / `CALL FB n, DB m` / `CALL #istanza` con i parametri `nome:=operando` nell'ordine dell'interfaccia; pin BOOL d'ingresso con logica → `= L b` prima della logica di EN e `nome:=L x.y`.
- **SR/RS** §2.12, **POS/NEG** §2.13 (H8, dentro `A(`…`)` se c'è logica prima), **temporizzatori a box** §3.2 (pin S = flusso entrante, TV, R, BI, BCD, Q), **contatori a box** §3.4 (primo pin = flusso entrante: CU per S_CU/S_CUD, CD per S_CD). Pin non collegati: si toglie la parte relativa.
- `BOX_IN_PARALLEL`, `BOX_IN_TBRANCH` (box non primo nella serie di un `LadNode` di ramo a T), `BAD_INSTANCE` (istanza vuota o non nella forma `T n`/`C n`/bit/`FC n`/`FB n, DB m`).

- [ ] **Step 1: test che falliscono** — un test per forma, AWL atteso da `kop-awl.md` §2.12, §2.13 (POS), §3.2, §3.4, §4.1 (quattro casi), §4.3, §4.4, §4.5 (ADD_I, MUL_R, SQRT), §4.6 (BCD_I e ROUND), §4.7, §4.8, §4.9, §4.11 (FC con ENO collegato, FB con DB, pin BOOL con logica). `block.test.ts`: due segmenti con un box ciascuno → `_001` e `_002`; un segmento `null` in mezzo non consuma etichette; ogni sorgente passa `parseNetwork`, e il blocco intero passa `checkBlockCode` con un contesto di prova (`packages/awl/test/ctx.ts` o equivalente) che dichiara gli operandi usati.
- [ ] **Step 2:** `npx vitest run --project ladfbd` → FAIL.
- [ ] **Step 3: implementare.**
- [ ] **Step 4:** `npx vitest run --project ladfbd` → PASS.
- [ ] **Step 5: commit** `feat(ladfbd): traduzione KOP → AWL dei box`.

## Task 5: progetto — blocchi KOP, sorgenti generate, compilazione

**Files:**

- Modify: `packages/project/package.json` (dipendenza `@baaportal/ladfbd`), `src/model.ts` (`Network.lad?: LadNetwork`), `src/baapFile.ts` (schema del segmento: `lad: ladNetworkSchema.optional()`), `src/plc.ts:82` (`createCodeBlock` con `language: 'KOP'` → segmento con `lad: emptyNetwork(newId)`), `src/mc7Bridge.ts` (cancello a 1736, `codeInput` a 809, hash), `packages/mc7/src/compile.ts:614` (byte della lingua da `CompileInput.language`), `packages/importers/src/awlSource/generate.ts:265` (un blocco KOP si esporta con l'AWL generato, senza l'avviso), `src/checks.ts` se controlla le sorgenti
- Create: `packages/project/src/kopSources.ts`
- Test: `packages/project/test/kopSources.test.ts`, `test/mc7Bridge.test.ts` (aggiornare la riga 305), `packages/importers/test/awlSourceGenerate.test.ts:88`, `packages/sim/test/` (un test che esegue un blocco KOP compilato)

**Interfaces — Produces:**

```ts
// packages/project/src/kopSources.ts
export type KopNetworkResult = { source: string; lines: LineOwner[]; diagnostics: LadDiag[] };
export function kopSources(block: CodeBlock, dev: Device): KopNetworkResult[];   // uno per segmento
export function blockSources(block: CodeBlock, dev: Device): string[];          // AWL di ogni segmento, qualsiasi lingua
export function tempEnd(block: CodeBlock): number;                              // primo byte L dopo i TEMP dichiarati
```

`tempEnd` usa lo stesso calcolo del layout dei TEMP che usa `compileBlock` (cercare in `packages/mc7/src/layout.ts`/`compile.ts` come si ottiene `base`; esportarlo se serve, senza duplicarlo). Un segmento KOP senza `lad` usa la sua `source`. `blockSources` sostituisce ogni lettura di `networks.map(n => n.source)` per il codice da compilare, controllare, confrontare nell'hash ed esportare. Il pin list di un box CALL viene dall'interfaccia del blocco chiamato nel dispositivo (o da `findSystemBlock` per SFC/SFB): `kopSources` riempie l'ordine dei parametri prima di tradurre.

Le diagnostiche KOP diventano diagnostiche di compilazione con il codice `KOP_<CODE>` (aggiungere a `MC7_BRIDGE_DIAG_CODES`, rete 1-based) e bloccano la compilazione del blocco.

- [ ] **Step 1: test che falliscono** — `kopSources.test.ts`: FC KOP con TEMP di 3 byte e un ramo a T → AWL con `L 3.0`; aggiungere un TEMP `INT` (2 byte) → `L 6.0` (allineamento a parola, come il layout del compilatore); segmento senza `lad` con sorgente → sorgente invariata. `mc7Bridge.test.ts`: un FC KOP compila (`file` presente, nessun errore) e il byte della lingua nell'intestazione è `0x02`; un FC KOP con operando vuoto dà `KOP_EMPTY_OPERAND` e nessun `file`; l'hash cambia se cambia il KOP. `baapFile`: andata e ritorno di un progetto con un blocco KOP conserva `lad`. Test del simulatore: FC KOP «`I 0.0` AND `I 0.1` → `Q 4.0`» richiamato da OB1 AWL; con gli ingressi a 1 l'uscita va a 1.
- [ ] **Step 2:** `npx vitest run --project project --project mc7 --project importers --project sim` → FAIL.
- [ ] **Step 3: implementare.**
- [ ] **Step 4:** stessi comandi + `npm run typecheck` → PASS.
- [ ] **Step 5: commit** `feat(project): blocchi KOP compilati dall'AWL generato`.

## Task 6: impaginazione KOP (pura)

**Files:**

- Create: `packages/ui/src/editors/lad/ladLayout.ts`
- Test: `packages/ui/test/editors/ladLayout.test.ts`

**Interfaces — Produces:**

```ts
export type LadCell = { elemId: string; kind: 'contact'|'not'|'cmp'|'edge'|'posneg'|'midline'|'box'|'out'|'empty'; col: number; row: number; w: number; h: number };
export type LadWire = { from: [col: number, row: number]; to: [col: number, row: number] }; // orizzontali e verticali, in coordinate di griglia
export type LadInsertSlot = { at: InsertPoint; col: number; row: number }; // dove si può inserire (per clic e trascinamento)
export type LadLayout = { cells: LadCell[]; wires: LadWire[]; slots: LadInsertSlot[]; cols: number; rows: number };
export function layoutNetwork(net: LadNetwork): LadLayout;
```

Regole: la serie va verso destra (1 colonna per contatto, `w` colonne per un box secondo i pin, `h` righe = numero di pin); un parallelo impila i rami verso il basso, allunga i rami corti con fili fino alla colonna di chiusura; le uscite stanno tutte nell'**ultima colonna** a destra come in STEP 7 e il ramo a T scende dal suo nodo con un filo verticale; i pin BOOL con logica di un box si disegnano a sinistra del pin, sulla riga del pin.

- [ ] **Step 1: test che falliscono** — serie di 2 contatti + bobina: celle a col 0,1 e bobina a `cols-1`; parallelo di 2 rami di lunghezza 1 e 2: righe 0 e 1, filo di chiusura alla stessa colonna; ramo a T: l'uscita del secondo ramo è alla riga sotto, sempre nell'ultima colonna; nessuna cella si sovrappone a un'altra (test generico su una rete con tutti i tipi); ogni `InsertPoint` di `slots` è accettato da `insertElem`.
- [ ] **Step 2:** `npx vitest run --project ui test/editors/ladLayout.test.ts` → FAIL.
- [ ] **Step 3: implementare.**
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: commit** `feat(ui): impaginazione delle reti KOP`.

## Task 7: editor del segmento KOP

**Files:**

- Create: `packages/ui/src/editors/lad/LadNetworkEditor.tsx`, `LadElement.tsx` (disegno di un elemento), `ladKeys.ts` (tasti), `lad.css`
- Modify: `packages/ui/src/i18n/it.json`, `en.json` (chiavi `lad.*`)
- Test: `packages/ui/test/editors/ladNetworkEditor.test.tsx`

**Interfaces:**

- Consumes: `layoutNetwork` (Task 6); `insertElem`, `openBranch`, `closeBranchAfter`, `addOutput`, `removeElem`, `updateElem`, `catalog` (Task 2); `LadDiag` (Task 3).
- Produces: `<LadNetworkEditor net={LadNetwork} index={number} diagnostics={Map<elemId, string[]>} readOnly={boolean} onChange={(next: LadNetwork, labelKey: string) => void} />`.

Comportamento:

- Ogni elemento è un `button` con `aria-label` («Contatto NA I 0.0», «Bobina Q 4.0», «Box ADD_I»); l'operando vuoto si mostra `??.?` in rosso; un elemento con diagnostica ha il bordo rosso e il messaggio come `title`.
- Clic: seleziona un elemento o un punto d'inserimento (gli `slots` si vedono come piccoli segni sul filo al passaggio del mouse e quando la rete ha il fuoco). Doppio clic o Invio sull'operando: campo di testo che conferma con Invio/uscita e annulla con Esc.
- Tasti: F2/F3 inseriscono un contatto NA/NC dopo la selezione; F7 aggiunge una bobina (se il nodo ha già una bobina vuota la seleziona); F8 apre un ramo sull'elemento selezionato; F9 chiude il ramo aperto dopo l'elemento selezionato; Canc elimina; frecce spostano la selezione nella griglia.
- Barra degli strumenti sopra il primo segmento: NA, NC, bobina, apri ramo, chiudi ramo, «Box vuoto ▾» (menu dal catalogo), con i tasti nel `title`.
- Trascinamento: accetta il tipo `application/x-baaportal-lad` (dalla tavolozza, Task 8) e inserisce nello slot più vicino.
- Ogni modifica chiama `onChange` una volta con la chiave di storia (`history.editLad`).

- [ ] **Step 1: test che falliscono** — con Testing Library: F2 su una rete vuota inserisce «Contatto NA ??.?»; scrivere `I 0.0` e Invio aggiorna l'operando; F8 sul contatto crea un ramo parallelo (due bottoni contatto, uno sotto l'altro); Canc sul ramo nuovo lo toglie; un elemento in `diagnostics` ha il messaggio nel `title`; `readOnly` disabilita i tasti; ogni azione chiama `onChange` esattamente una volta.
- [ ] **Step 2:** `npx vitest run --project ui test/editors/ladNetworkEditor.test.tsx` → FAIL.
- [ ] **Step 3: implementare.**
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: commit** `feat(ui): editor grafico del segmento KOP`.

## Task 8: integrazione nell'app

**Files:**

- Modify: `packages/ui/src/editors/block/NetworksView.tsx` (ramo KOP accanto a `isAwl`, riga 50), `packages/ui/src/project/dialogs/AddBlockDialog.tsx:23-28,131` (KOP abilitato, lingua scelta usata), `packages/ui/src/project/taskcards/TaskCards.tsx` (sezioni «Istruzioni di base» con la tavolozza KOP quando l'editor attivo è un blocco KOP), `packages/ui/src/i18n/*.json`, `packages/ui/test/addBlock.test.tsx:44`, `packages/ui/test/networksView.test.tsx:203,308`
- Create: `packages/ui/src/editors/lad/LadPalette.tsx`
- Test: `packages/ui/test/editors/kopBlock.test.tsx`

Comportamento:

- Blocco KOP: per ogni segmento `LadNetworkEditor`; sotto, il comando «Mostra AWL» apre la sorgente generata in sola lettura (CodeMirror con l'evidenziazione AWL, mnemonici dell'impostazione). Segmento senza `lad`: vuoto → rete vuota al primo clic; con sorgente → AWL in sola lettura e il messaggio della Review Focus 5.
- `onChange` → `store.edit('history.editLad', d => { network.lad = next; network.source = kopSources(...)[i].source; })` — tutte le sorgenti dei segmenti del blocco si riscrivono (le etichette sono per blocco).
- Pannello «Problemi»: diagnostiche KOP (`lad.diag.<CODE>`) e diagnostiche AWL del codice generato riportate sull'elemento con `lines` (la riga della diagnostica AWL → `elemId`), con il testo «Segmento n: …».
- «Inserisci segmento» in un blocco KOP crea un segmento con `emptyNetwork`.
- Tavolozza: gruppi «Logica a bit», «Temporizzatori», «Contatori», «Confronto», «Trasferimento», «Matematica», «Conversione», «Logica a parola», «Scorrimento», «Salti», «Controllo del programma»; clic inserisce nella selezione dell'editor attivo; trascinamento con `application/x-baaportal-lad`. Box CALL: trascinando un FC/FB dall'albero del progetto su un segmento KOP si crea il box CALL (riusare `beginDrag` del `ProjectTree`).
- Ricerca/sostituisci e rinomina dei simboli non toccano i KOP: limite noto.

- [ ] **Step 1: test che falliscono** — `kopBlock.test.tsx`: creare un FC in KOP dal dialogo; il segmento 1 mostra la rete vuota; inserire NA `I 0.0` e bobina `Q 4.0`; «Mostra AWL» mostra `A I 0.0` / `= Q 4.0`; Ctrl+Z toglie l'ultima modifica sia dal KOP sia dall'AWL; un operando vuoto compare in «Problemi»; il clic su una voce della tavolozza inserisce l'elemento. Aggiornare `addBlock.test.tsx` (KOP abilitato, FUP e SCL ancora disabilitati) e `networksView.test.tsx`.
- [ ] **Step 2:** `npx vitest run --project ui` → FAIL.
- [ ] **Step 3: implementare.**
- [ ] **Step 4:** `npx vitest run --project ui && npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5: commit** `feat(ui): blocchi KOP nell'editor dei blocchi e tavolozza delle istruzioni`.

## Task 9: e2e, documentazione, versione

**Files:**

- Create: `apps/desktop/e2e/kop.spec.ts`, `docs/uso/kop.md`
- Modify: `docs/limiti-noti.md` (sezione 4A), `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md` (4A fatto), `docs/protocollo/mc7.md` solo se cita la lingua KOP dell'intestazione, versione `0.14.0` in `package.json` della radice e di `apps/desktop` (e il lock)

- [ ] **Step 1:** e2e — nuovo progetto, CPU, FC1 in KOP, contatto `I 0.0` in serie con `I 0.1`, bobina `Q 4.0`, OB1 AWL con `CALL FC 1`; «Compila» senza errori; simulatore avviato, carica, ingressi a 1 dalla tabella di controllo → `Q 4.0` a 1.
- [ ] **Step 2:** `npm run e2e -- kop.spec.ts` → PASS.
- [ ] **Step 3:** `docs/uso/kop.md` (come si disegna, tasti, tavolozza, «Mostra AWL», cosa non si può fare ancora); `docs/limiti-noti.md`: ogni ipotesi adottata del Global Constraints con il numero H di `kop-awl.md`, nessun BLD (STEP 7 potrebbe riaprire i blocchi in AWL invece che in KOP), box nei rami paralleli non ammessi, rinomina e ricerca non toccano i KOP, FUP e conversione AWL → KOP nel 4C, mai provato su una CPU reale.
- [ ] **Step 4:** collaudo completo: `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check` → tutto verde.
- [ ] **Step 5: commit** `docs: KOP, limiti noti del 4A, versione 0.14.0`.
