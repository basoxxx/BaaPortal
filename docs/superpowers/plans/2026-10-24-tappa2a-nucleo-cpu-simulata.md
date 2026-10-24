# Piano 2A — Nucleo della CPU simulata — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** un nuovo pacchetto `@baaportal/sim` con una CPU S7-300 simulata che esegue lo **stesso MC7** che si carica nel PLC (spec §6). Comprende:
- la parola di stato, gli accumulatori, AR1/AR2, i registri DB/DI, lo stack L e lo stack di annidamento;
- le istruzioni AWL tranne temporizzatori, contatori e SFC/SFB, che arrivano con il piano 2B;
- il richiamo di FC e FB con i parametri;
- il ciclo OB1 con le immagini di processo e l'avvio con OB100;
- i modi STOP/RUN e la cancellazione totale.

La CPU simulata si carica con lo stesso percorso del PLC vero: `S7WriteClient.downloadBlock` verso il server S7 in memoria.

**Architettura:**
- **Pacchetto puro:** `packages/sim` è TypeScript puro, senza `node:`, senza React e senza DOM, così gira in un Worker, nel renderer o in node. Il piano 2C lo ospiterà in un Worker con l'interfaccia.
- **Esecuzione dei byte:** l'esecutore legge i byte MC7 con `decodeInstruction(code, at)` di `@baaportal/mc7`, che dà `DecodedStatement` con `id`, l'operando come AST di `@baaportal/awl` e `jumpTo` in byte. Le istruzioni decodificate si tengono in una cache per blocco e per offset. Non si riparsa il testo AWL: si esegue esattamente ciò che è stato caricato.
- **Server S7:** `@baaportal/s7-server` riceve un'interfaccia `CpuBackend` estratta da `FakeCpu`. `FakeCpu` resta com'è (stessi test); `SimCpu` la implementa a sua volta. Il download in memoria (`memoryTransportPair`) è già provato dai test di 1D-bis.

**Tecnologie:** TypeScript, Vitest (ambiente node).

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:
- §9 Tappa 2 e il suo "Fatto quando";
- §6 «il simulatore esegue lo stesso MC7»;
- §7 il modulo `sim`;
- §10 «Simulatore: test istruzione per istruzione sulla parola di stato e sugli accumulatori, secondo i manuali pubblici».

Piano generale: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, riga 2A. Formato MC7: `docs/protocollo/mc7.md` (§2.2 operandi, §2.4 salti, §2.5 UC/CC/CALL, §2.6 tabelle per istruzione).

## Global Constraints

- **Clean-room** (spec §5): la semantica delle istruzioni viene **solo** dai manuali Siemens pubblici, cioè il manuale AWL/STL per S7-300/400 e i manuali delle CPU 31x. Si citano per capitolo nei commenti dei test e in `docs/protocollo/sim.md`. Non si analizza PLCSIM né altro software Siemens. Non si copia codice da progetti open source di simulatori.
- **S7-300 ha 2 accumulatori.** `ENT` e `LEAVE` (solo CPU a 4 accumulatori) danno l'errore di programmazione `ISTRUZIONE_NON_S7300`. `PUSH` copia ACCU1 in ACCU2, `POP` copia ACCU2 in ACCU1. Le operazioni aritmetiche intere a 16 bit lasciano invariata la parola alta di ACCU1 e lasciano invariato ACCU2.
- **Bit della parola di stato** (manuale AWL, «Parola di stato»): bit 0 /FC (/ER), 1 RLO (VKE), 2 STA, 3 OR, 4 OS, 5 OV, 6 CC0, 7 CC1, 8 BR. `L STW` e `T STW` usano questa disposizione.
- **Byte order:** tutte le aree sono big-endian, come nella CPU. REAL è IEEE 754 a 32 bit.
- **Errori di programmazione:** nel piano 2A portano la CPU in STOP, con una voce nel buffer di diagnostica che contiene codice, blocco, offset MC7 e rete. Gli OB di errore OB121/OB122 si aggiungono nel piano 2B, e allora l'errore li richiamerà se sono caricati. I codici sono costanti esportate da `packages/sim/src/errors.ts`:
  - `AREA_LUNGHEZZA` (accesso fuori area);
  - `DB_NON_CARICATO`;
  - `DB_NON_APERTO`;
  - `BLOCCO_NON_CARICATO`;
  - `STACK_BLOCCHI_PIENO`;
  - `STACK_ANNIDAMENTO_PIENO`;
  - `STACK_L_PIENO`;
  - `ISTRUZIONE_NON_S7300`;
  - `MC7_NON_ESEGUIBILE` (byte grezzi non decodificati);
  - `TEMPO_CICLO_SUPERATO`;
  - `NON_SIMULATA_2B` (temporizzatori, contatori, SFC e SFB, finché il piano 2B non li fa).
- **Nessuna dipendenza di runtime nuova.** `@baaportal/sim` dipende solo da `@baaportal/mc7`, `@baaportal/awl`, `@baaportal/s7-types` e `@baaportal/catalog`. `@baaportal/s7-server` e `@baaportal/s7comm` servono solo come dipendenze di sviluppo, per i test di integrazione.
- **Tempo deterministico:** la CPU riceve un orologio iniettabile (`now(): number`, in ms). I test non dipendono mai dal tempo reale.
- **Ciclo infinito:** il controllo del tempo di ciclo si fa ogni 1024 istruzioni con `now()`, contro `maxCycleMs` delle proprietà della CPU. Così un `JU` su se stesso termina sempre, con `TEMPO_CICLO_SUPERATO` e STOP.
- **Nessun dato reale nel repository:** i programmi di prova si scrivono da noi, ricavati dagli esempi dei manuali pubblici.
- **Windows e macOS:** il pacchetto è puro, LF.
- **Nessuna funzione di questo piano parla con un PLC vero.**
- **Versione:** 0.6.0.

## Review Focus

1. **La parola di stato dopo una sequenza mista, non solo dopo un'istruzione.** Per esempio `A( … ) O …`, una `=` che chiude il primo controllo, `SAVE` e `A BR`, un confronto seguito da `JC`. Atteso: /FC, RLO, STA, OR e BR come nelle tabelle del manuale, con un test che segue la parola di stato dopo ogni riga. → Task 2, Task 8.
2. **Overflow e casi limite aritmetici.** `+I` con 32767 + 1, `/I` per 0, `*D` fuori campo, `-R` con NaN o infinito, `RND` di x.5, `TRUNC` fuori campo, `NEGI` di −32768. Atteso: risultato, OV/OS e CC0/CC1 come nelle tabelle del manuale; OS resta 1 fino a `JOS` o a un cambio di blocco. → Task 4.
3. **Richiami annidati con parametri.** Un FC con parametri IN/OUT/IN_OUT che chiama un altro FC passandogli i propri parametri, un FB con multi-istanza (AR2), un DB aperto prima del richiamo. Atteso: valori giusti, registri DB/DI e AR2 ripristinati al ritorno, stack L liberato. → Task 5.
4. **Accesso indiretto e fuori area.** Puntatore in memoria e in AR1/AR2, area dichiarata nel puntatore, indirizzo oltre la fine di M o del DB, DB non aperto. Atteso: valore giusto, oppure STOP con il codice giusto, il blocco e l'offset. Mai un valore inventato. → Task 1, Task 6.
5. **Programma che non finisce mai, o che si carica a metà.** Un `JU` su se stesso; un OB1 che chiama un FC non caricato; STOP→RUN con DB ritentivi; una cancellazione totale. Atteso: STOP con causa chiara; la ritentività rispetta le proprietà della CPU; dopo la cancellazione totale i valori dei DB tornano ai valori iniziali. → Task 6, Task 7.

---

### Task 1: Pacchetto `@baaportal/sim`: memoria, registri, operandi

**Files:**
- Create: `packages/sim/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/memory.ts`, `src/registers.ts`, `src/operands.ts`, `src/errors.ts`
- Test: `packages/sim/test/memory.test.ts`, `packages/sim/test/operands.test.ts`

**Interfaces:**
- Consumes: `Operand`, `AreaId` di `@baaportal/awl` (`src/ast.ts`); `findCpu` e `CpuType.limits` di `@baaportal/catalog`; `parsePointer` e i codici d'area di `@baaportal/mc7` (`operands.ts`).
- Produces:
  ```ts
  export class SimError extends Error { constructor(public code: SimErrorCode, public detail?: string) }
  export type SimErrorCode = 'AREA_LUNGHEZZA' | 'DB_NON_CARICATO' | 'DB_NON_APERTO' | 'BLOCCO_NON_CARICATO' | 'STACK_BLOCCHI_PIENO'
    | 'STACK_ANNIDAMENTO_PIENO' | 'STACK_L_PIENO' | 'ISTRUZIONE_NON_S7300' | 'MC7_NON_ESEGUIBILE' | 'BCD_NON_VALIDO' | 'TEMPO_CICLO_SUPERATO' | 'NON_SIMULATA_2B';
  export interface MemorySizes { inputs: number; outputs: number; flags: number; localBytes: number }   // dal catalogo: inputBytes, outputBytes, mBytes, localDataBytesPerClass
  export class SimMemory {
    constructor(sizes: MemorySizes);
    readonly I: Uint8Array; readonly Q: Uint8Array; readonly M: Uint8Array; readonly L: Uint8Array;
    readonly physIn: Uint8Array; readonly physOut: Uint8Array;               // periferia: PI legge physIn, PQ scrive physOut
    dbs: Map<number, { data: Uint8Array; initial: Uint8Array; retentive: boolean }>;
    bytes(area: AreaId | 'V', db: number | null, byteOffset: number, length: number): Uint8Array;  // vista; SimError AREA_LUNGHEZZA / DB_NON_CARICATO
  }
  export function memorySizesFor(cpuTypeId: string): MemorySizes;
  export interface StatusWord { fc: boolean; rlo: boolean; sta: boolean; or: boolean; os: boolean; ov: boolean; cc0: boolean; cc1: boolean; br: boolean }
  export function stwToWord(s: StatusWord): number; export function wordToStw(w: number): StatusWord;   // bit 0 /FC … bit 8 BR
  export interface Registers { stw: StatusWord; accu1: number; accu2: number; ar1: number; ar2: number; db: number; di: number }  // accu e AR come uint32
  export interface Location { area: AreaId | 'V'; db: number | null; bit: number /* indirizzo in bit */ }
  export function resolveOperand(op: Operand, regs: Registers, mem: SimMemory, frame: FrameView): Location;  // diretto, indiretto in memoria (16/32 bit), indiretto con AR1/AR2 (interno e trasversale all'area)
  export function readBits(mem: SimMemory, loc: Location, size: 'X' | 'B' | 'W' | 'D'): number;
  export function writeBits(mem: SimMemory, loc: Location, size: 'X' | 'B' | 'W' | 'D', value: number): void;
  export interface FrameView { lBase: number; prevLBase: number }   // V = dati locali del blocco chiamante
  ```

Regole:
- **Dimensioni** da `memorySizesFor`: le danno `inputBytes`, `outputBytes`, `mBytes` e `localDataBytesPerClass` della CPU nel catalogo. Una CPU sconosciuta usa i valori di una 315-2 PN/DP.
- **Puntatori:** si usa il formato a 32 bit del manuale (area nei bit 24–26, byte·8+bit nei bit 3–18 e 0–2), lo stesso di `docs/protocollo/mc7.md` §2.2.4. L'indiretto in memoria a 16 bit vale per T, C e i numeri di blocco; quello a 32 bit vale per i bit e i byte.
- **Area DB/DI:** usa il registro DB o DI aperto. Con il registro a 0 l'errore è `DB_NON_APERTO`.

- [ ] **Step 1: Scrivi i test che falliscono.**
  - `memory.test.ts`:
    - `it('memorySizesFor 315-2 PN/DP → I/Q 2048, M 2048')`
    - `it('M oltre la fine → SimError AREA_LUNGHEZZA')`
    - `it('stwToWord/wordToStw: BR=bit 8, /FC=bit 0, andata e ritorno su tutti i 512 valori')`
  - `operands.test.ts`:
    - `it('MW10 big-endian')`
    - `it('DBX3.1 con DB aperto 5')`
    - `it('DBX senza DB aperto → DB_NON_APERTO')`
    - `it('M [MD20] con MD20 = P#4.3 → M4.3')`
    - `it('M [AR1,P#2.0] con AR1 = P#10.0 → M12.0')`
    - `it('[AR1,P#0.0] trasversale con AR1 = P#DBX 4.0 → DB aperto, byte 4')`
    - `it('PIW legge physIn, PQW scrive physOut, non I/Q')`
- [ ] **Step 2: Esegui e verifica che falliscano:** `npx vitest run --project sim`.
- [ ] **Step 3: Implementa** il pacchetto (con `vitest.config.ts` di nome `sim`, ambiente `node`) e aggiungilo a `npm install`.
- [ ] **Step 4: Test, typecheck, lint, formato:** `npx vitest run --project sim && npm run typecheck && npm run lint && npm run format:check`.
- [ ] **Step 5: Commit** — `feat(sim): pacchetto della CPU simulata — memoria, registri, operandi`

---

### Task 2: Esecutore e logica combinatoria a bit

**Files:**
- Create: `packages/sim/src/executor.ts`, `src/program.ts`, `src/ops/bitLogic.ts`, `src/ops/index.ts`
- Test: `packages/sim/test/bitLogic.test.ts`, `packages/sim/test/helpers.ts`

**Interfaces:**
- Consumes: Task 1; `decodeInstruction` e `readBlockFile` di `@baaportal/mc7`; `encodeCode` e `compileBlock` di `@baaportal/mc7` (solo nei test, per passare da testo AWL a MC7).
- Produces:
  ```ts
  export interface LoadedBlock { kind: 'OB'|'FB'|'FC'|'DB'; number: number; code: Uint8Array; localBytes: number; networkStarts: number[] }  // da readBlockFile + parseAdd
  export class Program { load(file: Uint8Array): LoadedBlock; get(kind, number): LoadedBlock | undefined; delete(kind, number): void; list(): LoadedBlock[] }
  export interface ExecContext { mem: SimMemory; regs: Registers; program: Program; now(): number; maxCycleMs: number; cycleStart: number; trace?: (t: TraceStep) => void }
  export interface TraceStep { block: { kind: string; number: number }; offset: number; id: string; stw: number; accu1: number; accu2: number }
  export function runBlock(ctx: ExecContext, kind: 'OB'|'FB'|'FC', number: number): void;   // lancia SimError
  export type OpHandler = (st: ExecState, stmt: DecodedStatement) => void | { jump: number } | 'return';
  export const OPS: Record<string, OpHandler>;   // chiave = id internazionale di INSTRUCTIONS
  // helpers.ts (test): runAwl(networks: string[], init?: Partial<…>): { regs, mem, trace }
  ```

Regole (manuale AWL, «Operazioni di combinazione logica a bit» e «Parola di stato»):
- **Inizio di una catena:** con /FC = 0, la prima interrogazione `A`, `AN`, `O`, `ON`, `X` o `XN` carica il risultato in RLO e mette /FC = 1. STA vale sempre il bit interrogato.
- **Fine di una catena:** `=`, `S` e `R` mettono /FC = 0 e lasciano invariato RLO. `S` e `R` agiscono solo con RLO = 1.
- **Parentesi:** `A(` … `)` salva in uno stack di annidamento di 7 livelli BR, RLO, OR e la funzione, poi riapre la catena con /FC = 0. Un ottavo livello dà `STACK_ANNIDAMENTO_PIENO`. Anche `O` senza operando (AND prima di OR) segue le tabelle del manuale.
- **Altre istruzioni:** `NOT`, `SET`, `CLR`, `SAVE` (BR := RLO), `FP` e `FN` (fronte sul merker indicato) e le interrogazioni dei bit di stato (`A BR`, `A OV`, `A OS`, `A ==0`, `A >0`, `A <0`, `A <>0`, `A >=0`, `A <=0`, `A UO`) seguono le tabelle del manuale.
- **MCR:** `MCRA`, `MCRD`, `MCR(` e `)MCR` si implementano qui. Con MCR attivo e RLO dell'MCR a 0, `=` scrive 0 e `T` scrive 0, come dice il manuale.
- **Byte grezzi** non decodificati: errore `MC7_NON_ESEGUIBILE`.
- **Esecuzione:** un passo per istruzione, con la cache delle `DecodedStatement` per blocco e offset. `BLD` e `NOP` non fanno niente. `BE` termina il blocco.

- [ ] **Step 1: Scrivi i test che falliscono** (`bitLogic.test.ts`, programmi AWL compilati con `encodeCode` ed eseguiti con `runAwl`; ogni test cita il paragrafo del manuale in un commento)
  - `it('A I0.0 / A I0.1 / = Q4.0: tabella di verità completa')`
  - `it('/FC e STA dopo ogni riga di A M0.0 / ON M0.1 / = M1.0')`
  - `it('A( O … O … ) A …: annidamento come esempio del manuale')`
  - `it('8 parentesi aperte → STACK_ANNIDAMENTO_PIENO')`
  - `it('X / XN')`
  - `it('S e R agiscono solo con RLO 1 e non cambiano RLO')`
  - `it('SAVE poi A BR')`
  - `it('FP: un solo ciclo a 1 sul fronte di salita')`
  - `it('MCR( con RLO 0: = scrive 0')`
  - `it('byte grezzi → MC7_NON_ESEGUIBILE con offset')`
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** esecutore, cache e operazioni a bit
- [ ] **Step 4: Test, typecheck, lint, formato**
- [ ] **Step 5: Commit** — `feat(sim): esecutore MC7 e logica combinatoria a bit`

---

### Task 3: Caricamento, trasferimento, accumulatori, logica a parola, scorrimento, registri

**Files:**
- Create: `packages/sim/src/ops/loadTransfer.ts`, `ops/accumulator.ts`, `ops/wordLogic.ts`, `ops/shift.ts`, `ops/db.ts`
- Test: `packages/sim/test/loadTransfer.test.ts`, `test/wordShift.test.ts`

**Interfaces:**
- Consumes: Task 2 (`OPS`, `runAwl`).
- Produces: le voci di `OPS` per gli id `L`, `T`, `LAR1`, `LAR2`, `TAR1`, `TAR2`, `CAR`, `TAK`, `PUSH`, `POP`, `ENT`, `LEAVE`, `INC`, `DEC`, `+AR1`, `+AR2`, `AW`, `OW`, `XOW`, `AD`, `OD`, `XOD`, `SSI`, `SSD`, `SLW`, `SRW`, `SLD`, `SRD`, `RLD`, `RRD`, `RLDA`, `RRDA`, `OPN`, `CDB`. `L` e `T` per T e C restano a `NON_SIMULATA_2B`.

Regole:
- **`L` e `T`:**
  - `L` sposta ACCU1 in ACCU2 e carica, estendendo con zeri byte e parola;
  - `T` scrive la parte meno significativa;
  - nessuna delle due tocca la parola di stato.
- **Costanti:** `L` di una costante usa `decodeLoadConstant` di `@baaportal/mc7`, quindi vale per ogni forma (`W#16#`, `P#`, `S5T#`, `C#`, `L#`, REAL, `B#(…)` e così via).
- **Registri speciali:**
  - `L STW` e `T STW` usano la disposizione delle Global Constraints;
  - `L DBLG`, `L DBNO`, `L DILG` e `L DINO` danno lunghezza e numero del DB e del DI aperti;
  - `T STW` scrive tutti i bit tranne /FC, come dice il manuale.
- **Logica a parola** (`AW`, `OW` e le altre): con un operando costante agisce su ACCU1; senza operando agisce su ACCU1 e ACCU2. CC1 = (risultato ≠ 0), CC0 = 0 e OV = 0.
- **Scorrimenti:**
  - con un operando, il numero di posizioni è l'operando; senza, è ACCU2-LL;
  - CC1 = ultimo bit uscito, CC0 = 0 e OV = 0;
  - con 0 posizioni non cambia niente;
  - `RLDA` e `RRDA` ruotano attraverso CC1.
- **`OPN`:** `OPN DB n` apre il registro DB e `OPN DI n` il registro DI. Un DB non caricato dà `DB_NON_CARICATO`. `CDB` scambia i due registri.
- **`ENT` e `LEAVE`:** danno `ISTRUZIONE_NON_S7300`.

- [ ] **Step 1: Scrivi i test che falliscono:**
  - `it('L MW10 / L MW12: ACCU2 = vecchio ACCU1')`
  - `it('L B#16#FF estende con zeri')`
  - `it('T MB su ACCU1 = 0x12345678 scrive 0x78')`
  - `it('TAK, PUSH, POP su 2 accumulatori')`
  - `it('ENT → ISTRUZIONE_NON_S7300')`
  - `it('INC/DEC agiscono solo su ACCU1-LL senza riporto')`
  - `it('LAR1 P#M 10.0 / L [AR1,P#2.0]')`
  - `it('+AR1 P#2.0')`
  - `it('L STW / T STW andata e ritorno; /FC non scritto')`
  - `it('OPN DB 5 / L DBLG / L DBNO')`
  - `it('CDB')`
  - `it('AW W#16#0F0F: CC1 e OV')`
  - `it('SLW 3: CC1 = ultimo bit uscito')`
  - `it('SRW 0: niente cambia')`
  - `it('SSI: segno conservato')`
  - `it('RLDA attraverso CC1')`
  - `it('OPN DB non caricato → DB_NON_CARICATO')`
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa**
- [ ] **Step 4: Test, typecheck, lint, formato**
- [ ] **Step 5: Commit** — `feat(sim): caricamento, trasferimento, accumulatori, logica a parola e scorrimenti`

---

### Task 4: Aritmetica intera e reale, confronti, conversioni

**Files:**
- Create: `packages/sim/src/ops/integer.ts`, `ops/float.ts`, `ops/comparison.ts`, `ops/conversion.ts`
- Test: `packages/sim/test/arith.test.ts`, `test/compareConvert.test.ts`

**Interfaces:**
- Consumes: Task 2 e Task 3.
- Produces: le voci di `OPS` per tutti gli id delle categorie `integer`, `float`, `comparison` e `conversion` di `INSTRUCTIONS`: `+I -I *I /I +D -D *D /D MOD +` (`+` con costante), `+R -R *R /R ABS SQR SQRT EXP LN SIN COS TAN ASIN ACOS ATAN`, tutti i `==I…<=R`, `BTI ITB BTD ITD DTB DTR INVI INVD NEGI NEGD NEGR CAW CAD RND TRUNC RND+ RND-`.

Regole (manuale AWL: «Operazioni con numeri interi», «… in virgola mobile», «… di confronto», «… di conversione»):
- **Confronti:** il risultato va in RLO, con CC0 e CC1 come da tabella (uguale 00, minore 01, maggiore 10, non confrontabile per REAL 11). OV e OS sono 0 tranne per un REAL non valido, che mette OV = OS = 1. Un confronto è una interrogazione: segue le regole di /FC del Task 2.
- **Aritmetica intera:**
  - CC0 e CC1 dicono il segno del risultato, oppure il tipo di overflow;
  - un overflow mette OV = 1 e OS = 1; OS non si azzera;
  - `/I` e `/D` per 0 danno OV = 1, risultato 0, CC = 11;
  - `MOD` dà il resto.
  - `+I`, `-I`, `*I` e `/I` lavorano sulle parole basse e lasciano invariata ACCU1-H; `/I` mette il resto in ACCU1-H, come dice il manuale.
- **Reale:**
  - si calcola in `Math.fround` a 32 bit;
  - risultato non valido o infinito: OV e OS secondo la tabella del manuale;
  - funzioni con argomento fuori dominio (`SQRT` di un negativo, `LN` di 0): NaN, con i bit della tabella.
- **Conversioni:**
  - `BTI` e `BTD` su un BCD non valido: errore di BCD, che nel piano 2B sarà l'OB121. Nel piano 2A il codice è `AREA_LUNGHEZZA`? **No**: si aggiunge `BCD_NON_VALIDO` a `SimErrorCode`.
  - `RND` arrotonda al pari più vicino, come il manuale per x.5;
  - `RND+` e `RND-` arrotondano verso l'alto e verso il basso;
  - `TRUNC` tronca;
  - fuori dal campo DINT: OV = OS = 1, ACCU1 invariato.

- [ ] **Step 1: Scrivi i test che falliscono** (con una tabella di casi per istruzione; ogni caso controlla il risultato, CC0, CC1, OV e OS)
  - `it('+I 32767+1 → overflow')`
  - `it('/I 7/2 → quoziente 3, resto in ACCU1-H 1')`
  - `it('/I per 0')`
  - `it('-D sotto il minimo')`
  - `it('*R → infinito')`
  - `it('SQRT -1 → NaN e bit')`
  - `it('==R con NaN → CC 11, RLO 0')`
  - `it('RND 2.5 → 2, 3.5 → 4')`
  - `it('TRUNC 3e10 → OV')`
  - `it('BTI con BCD non valido → BCD_NON_VALIDO')`
  - `it('NEGI -32768 → overflow')`
  - `it('OS resta 1 fino a JOS')` (`JOS` arriva nel Task 5; il test controlla solo che OS resti a 1 su due istruzioni)
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa**
- [ ] **Step 4: Test, typecheck, lint, formato**
- [ ] **Step 5: Commit** — `feat(sim): aritmetica intera e reale, confronti e conversioni`

---

### Task 5: Salti, controllo del programma, richiami di FC e FB

**Files:**
- Create: `packages/sim/src/ops/jump.ts`, `ops/control.ts`, `src/calls.ts`
- Test: `packages/sim/test/jumps.test.ts`, `test/calls.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `docs/protocollo/mc7.md` §2.4 (salti, `JL`, `LOOP`) e §2.5 (UC/CC, lista dei puntatori dei parametri delle FC, `BLD`, area `V`); per i test, `compileBlock` di `@baaportal/mc7` con un `AwlContext` minimo, come in `packages/s7-server/test/downloadRoundtrip.test.ts`.
- Produces: le voci di `OPS` per tutti gli id `jump` e `control` (`JU JL JC JCN JCB JNB JBI JNBI JO JOS JZ JN JP JM JPZ JMZ JUO LOOP BE BEU BEC UC CC`).
  ```ts
  export interface Frame { block: LoadedBlock; pc: number; lBase: number; params?: Uint8Array /* lista dei puntatori FC */; savedDb: number; savedDi: number; savedNest: …; savedMcr: … }
  export const MAX_BLOCK_STACK = 16;   // profondità di annidamento dei blocchi (manuale CPU 31x: 8 per classe di priorità; vedi Rulings R6)
  ```

Regole:
- **Salti:**
  - i salti condizionati seguono la tabella del manuale;
  - `JC` e `JCN` mettono /FC = 0, STA = 1 e RLO = 1;
  - `JCB` e `JNB` copiano RLO in BR;
  - `JOS` azzera OS;
  - `JL` usa ACCU1-LL e salta oltre la lista se il valore è fuori;
  - `LOOP` decrementa ACCU1-L e salta se il risultato non è 0.
- **`UC` e `CC`:**
  - `UC` chiama sempre; `CC` chiama solo con RLO = 1;
  - entrambe mettono /FC = 0;
  - all'ingresso si salva DB e si riapre lo stack di annidamento e MCR come dice il manuale;
  - si alloca lo stack L per `localBytes` del blocco chiamato;
  - all'uscita (`BE`, `BEU`, `BEC` con RLO = 1, fine del codice) si ripristina e si libera.
- **Parametri delle FC:**
  - un accesso formale a `#PAR<n>` passa per la lista dei puntatori che segue la chiamata;
  - un puntatore all'area `V` punta ai dati locali del chiamante;
  - una FC che passa un proprio parametro a un'altra FC è un caso da coprire.
- **FB:**
  - il codice compilato apre il DI e carica AR2 prima di `UC FB`;
  - l'esecutore non fa nient'altro, ma i test controllano la multi-istanza con offset AR2.
- **Chiamate di SFC e SFB:** danno `NON_SIMULATA_2B`. Le istruzioni dei temporizzatori e dei contatori (categorie `timer` e `counter`, e `S`/`R`/`L`/`T` su T e C) danno anch'esse `NON_SIMULATA_2B`.
- **Limiti:** un blocco non caricato dà `BLOCCO_NON_CARICATO`; uno stack dei blocchi oltre `MAX_BLOCK_STACK` dà `STACK_BLOCCHI_PIENO`; uno stack L esaurito dà `STACK_L_PIENO`.

- [ ] **Step 1: Scrivi i test che falliscono**
  - `jumps.test.ts`:
    - `it('JC/JCN: bit di stato dopo il salto')`
    - `it('JL con 3 voci e valore fuori campo')`
    - `it('LOOP 5 volte')`
    - `it('JO/JOS dopo overflow')`
    - `it('JZ/JN/JP/JM/JPZ/JMZ/JUO dopo confronto e aritmetica')`
  - `calls.test.ts` (blocchi compilati con `compileBlock` da AWL scritto da noi):
    - `it('OB1 chiama FC1 con IN/OUT/IN_OUT: valori giusti')`
    - `it('FC1 passa il proprio IN a FC2')`
    - `it('FB1 con DI 1: statici persistono fra due chiamate')`
    - `it('multi-istanza: FB2 dentro FB1 usa AR2 + offset')`
    - `it('DB aperto prima del richiamo è ripristinato al ritorno')`
    - `it('BEC con RLO 0 non termina')`
    - `it('richiamo di FC non caricata → BLOCCO_NON_CARICATO')`
    - `it('ricorsione oltre MAX_BLOCK_STACK → STACK_BLOCCHI_PIENO')`
    - `it('UC SFC 20 → NON_SIMULATA_2B')`
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa**
- [ ] **Step 4: Test, typecheck, lint, formato**
- [ ] **Step 5: Commit** — `feat(sim): salti, controllo del programma e richiami di FC/FB con parametri`

---

### Task 6: La CPU simulata: modi, avvio, ciclo, cancellazione totale, diagnostica

**Files:**
- Create: `packages/sim/src/cpu.ts`, `src/diagnostics.ts`, `src/obStartInfo.ts`
- Test: `packages/sim/test/cpu.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `OB_DEFINITIONS` e `findCpu` di `@baaportal/catalog`; `CpuProperties` di `@baaportal/project` come **tipo** strutturale (se serve, si copia la forma in `sim`, per non far dipendere `sim` da `project`).
- Produces:
  ```ts
  export type SimMode = 'STOP' | 'STARTUP' | 'RUN';
  export interface SimCpuOptions { cpuTypeId: string; props: { maxCycleMs: number; minCycleMs: number; clockMemory: { enabled: boolean; byte: number }; retentivity: { mBytes: number; timers: number; counters: number } }; now?: () => number }
  export interface DiagEntry { time: number; code: SimErrorCode | 'STOP_RICHIESTO' | 'AVVIO' | 'CANCELLAZIONE_TOTALE'; block?: string; offset?: number; network?: number; detail?: string }
  export class SimCpu {
    constructor(o: SimCpuOptions);
    readonly memory: SimMemory; readonly program: Program; get mode(): SimMode; get diagnostics(): readonly DiagEntry[];
    loadBlock(file: Uint8Array): void;            // DB: dati attuali = dati del file; altri blocchi in Program
    deleteBlock(kind: string, number: number): void;
    run(): void;                                  // STOP → avvio a caldo (OB100 se c'è) → RUN
    stop(reason?: string): void;
    memoryReset(): void;                          // cancellazione totale
    cycle(): CycleResult;                         // un ciclo OB1 completo; in STOP non fa nulla
    stats(): { last: number; min: number; max: number; cycles: number };
    onEvent(cb: (e: SimEvent) => void): () => void;   // modo cambiato, voce diagnostica, ciclo finito
  }
  export interface CycleResult { ok: boolean; error?: DiagEntry; elapsedMs: number }
  ```

Regole (manuale CPU 31x: «Modi di funzionamento», «Avvio», «Cancellazione totale», «Ritenzione»):
- **Ciclo:** si copia `physIn` in I, si esegue OB1 con i dati di avvio a 20 byte negli L 0..19 (struttura di `OB_DEFINITIONS[1].startInfo`: tempi del ciclo precedente, minimo e massimo in ms, data e ora in BCD), poi si copia Q in `physOut`.
- **Tempo minimo di ciclo:** `cycle()` restituisce il tempo trascorso. L'attesa del tempo minimo spetta a chi lo ospita, nel piano 2C.
- **Merker di clock:** se è attivo, il byte indicato riflette `now()` con le frequenze del manuale (bit 0 10 Hz, 1 5 Hz, 2 2.5 Hz, 3 2 Hz, 4 1.25 Hz, 5 1 Hz, 6 0.625 Hz, 7 0.5 Hz). Si aggiorna a ogni ciclo e a ogni lettura di quel byte.
- **Avvio a caldo** (`run()` da STOP):
  - azzera i merker, i temporizzatori e i contatori **non** ritentivi (gli intervalli ritentivi vengono da `retentivity`) e le immagini di processo;
  - i DB restano come sono;
  - esegue OB100 se è caricato, poi passa a RUN.
  - Un errore in OB100 lascia la CPU in STOP.
- **Cancellazione totale** (solo in STOP):
  - azzera I, Q, M, T, C e i dati dei DB, rimettendo i loro valori iniziali (quelli del file caricato);
  - **i blocchi restano caricati**: è la memoria di caricamento, come una CPU con MMC.
  - Aggiunge una voce `CANCELLAZIONE_TOTALE` alla diagnostica.
- **Errori:** ogni `SimError` durante il ciclo porta in STOP, con una voce di diagnostica che indica blocco, offset e rete. La rete si ricava da `networkStarts`.
- **Senza OB1:** se manca OB1, `run()` va comunque in RUN e i cicli non eseguono niente, come una CPU vera senza programma.
- **Tempo di ciclo superato:** dà `TEMPO_CICLO_SUPERATO` e STOP (OB80 arriva nel piano 2B). Il controllo segue la regola delle Global Constraints: ogni 1024 istruzioni.

- [ ] **Step 1: Scrivi i test che falliscono** (`cpu.test.ts`, orologio finto)
  - `it('OB1: I0.0 → Q4.0 attraverso le immagini di processo')`
  - `it('PIW legge physIn senza aspettare il ciclo')`
  - `it('OB100 eseguito una volta all\'avvio')`
  - `it('dati di avvio di OB1: tempo del ciclo precedente in L 8..9')`
  - `it('ritentività: MB0..15 restano, MB16 si azzera allo STOP→RUN')`
  - `it('cancellazione totale: DB tornano ai valori iniziali, blocchi restano')`
  - `it('JU su se stesso → TEMPO_CICLO_SUPERATO, STOP, diagnostica con rete')`
  - `it('accesso fuori area in FC2 → STOP con blocco FC2 e offset')`
  - `it('merker di clock bit 5 = 1 Hz')`
  - `it('nessun OB1 → RUN senza fare niente')`
  - `it('stats: min/max/ultimo')`
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa**
- [ ] **Step 4: Test, typecheck, lint, formato**
- [ ] **Step 5: Commit** — `feat(sim): CPU simulata — STOP/RUN, avvio, ciclo, cancellazione totale, diagnostica`

---

### Task 7: Carica nella CPU simulata attraverso il server S7

**Files:**
- Create: `packages/s7-server/src/backend.ts`, `packages/sim/src/backend.ts`
- Modify: `packages/s7-server/src/session.ts` (`serve(cpu: CpuBackend, …)`), `packages/s7-server/src/fakeCpu.ts` (`implements CpuBackend`), `packages/s7-server/src/index.ts`
- Test: `packages/sim/test/download.test.ts`

**Interfaces:**
- Consumes: Task 6; `serve` di `@baaportal/s7-server`; `S7WriteClient` e `memoryTransportPair` di `@baaportal/s7comm`.
- Produces:
  ```ts
  // @baaportal/s7-server
  export interface CpuBackend { /* esattamente i metodi che session.ts usa oggi su FakeCpu, con la stessa firma: readItem, applyWrite, applyStop, applyWarmRestart, applyDownloadedBlock, block, blockList, blockCounts, blockInfo, mode, now, attach, detach, diagnostiche/SZL usate */ }
  // @baaportal/sim
  export function simBackend(cpu: SimCpu, o?: { orderNumber?: string }): CpuBackend;
  export function connectToSim(cpu: SimCpu): Promise<S7WriteClient>;   // memoryTransportPair + serve(simBackend(cpu))
  ```

Regole:
- **Estrazione dell'interfaccia:** `CpuBackend` si estrae da ciò che `session.ts` chiama oggi, senza cambiare il comportamento di `FakeCpu`. Tutti i test esistenti di `s7-server` e `s7comm` devono restare verdi senza modifiche.
- **`simBackend`:**
  - `applyDownloadedBlock` → `cpu.loadBlock`;
  - `applyStop` → `cpu.stop()`;
  - `applyWarmRestart` → `cpu.run()`;
  - `readItem` e `applyWrite` per I, Q, M, DB e periferia leggono e scrivono la memoria della CPU simulata, compresi i dati attuali dei DB;
  - T e C danno, come `FakeCpu` oggi, zero in lettura e rifiuto in scrittura fino al piano 2B;
  - l'SZL del modo riflette `cpu.mode`;
  - le informazioni e l'elenco dei blocchi riflettono `cpu.program`.
- **Download in RUN:** si accetta, come una CPU vera; il blocco vale dal ciclo successivo.

- [ ] **Step 1: Scrivi i test che falliscono** (`download.test.ts`)
  - `it('compila OB1+FC1 da AWL, downloadBlock via S7WriteClient, start, ciclo → Q come atteso')`
  - `it('stop() via client → cpu.mode STOP')`
  - `it('readArea DB1 dopo un ciclo legge il valore scritto dal programma')`
  - `it('writeArea M → visibile al ciclo dopo')`
  - `it('blockList dopo il download elenca OB1 e FC1')`
- [ ] **Step 2: Esegui e verifica che falliscano**
- [ ] **Step 3: Implementa** l'interfaccia, l'adattatore e `connectToSim`.
- [ ] **Step 4: Test completi:** `npx vitest run --project sim --project s7-server --project s7comm && npm run typecheck && npm run lint && npm run format:check`.
- [ ] **Step 5: Commit** — `feat(sim,s7-server): carica nella CPU simulata con lo stesso percorso del PLC`

---

### Task 8: Batteria "Fatto quando" del piano 2A e copertura delle istruzioni

**Files:**
- Create: `packages/sim/test/battery/*.awl` (programmi di prova), `packages/sim/test/battery.test.ts`, `packages/sim/test/coverage.test.ts`
- Test: gli stessi

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: nessuna API nuova.

Regole:
- **Programmi di prova** (`.awl`), scritti da noi a partire dagli esempi dei manuali pubblici, almeno uno per categoria: bit, parentesi e MCR; caricamento e trasferimento; parola e scorrimenti; interi; reali; confronti; conversioni; salti, `JL` e `LOOP`; FC con parametri; FB con multi-istanza.
- **Valori attesi in un commento** in testa a ogni file, nella forma `// atteso: MW10=…, MD20=…, STW=…, ACCU1=…`, riga per riga dove serve.
- **`battery.test.ts`:** legge ogni file, compila con `compileBlock`, carica in `SimCpu` con `connectToSim` e `downloadBlock`, esegue un ciclo e confronta i valori attesi.
- **`coverage.test.ts`:** ogni id di `INSTRUCTIONS` è eseguito da almeno un test della batteria oppure compare in un elenco esplicito `DEFERRED_2B`, che contiene le categorie `timer` e `counter`, le chiamate di SFC e SFB e `CALL`, che nell'MC7 non esiste come istruzione. Un id nuovo senza copertura fa fallire il test.

- [ ] **Step 1: Scrivi programmi e test** (il test di copertura deve fallire finché manca un id)
- [ ] **Step 2: Esegui:** `npx vitest run --project sim`. Ogni differenza fra atteso e ottenuto è un bug di `sim` da correggere con il suo test, oppure un errore del programma di prova, da annotare.
- [ ] **Step 3: Correggi** fino al verde
- [ ] **Step 4: Test, typecheck, lint, formato**
- [ ] **Step 5: Commit** — `test(sim): batteria di programmi di prova e copertura delle istruzioni`

---

### Task 9: Documentazione, limiti noti, piano generale, versione e collaudo

**Files:**
- Create: `docs/protocollo/sim.md`
- Modify: `docs/limiti-noti.md`, `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`, `apps/desktop/package.json` (+ la riga di `package-lock.json`), questo piano (caselle)

Regole:
- **`docs/protocollo/sim.md`:**
  - descrive modello di memoria, registri, parola di stato e regole di /FC, ciclo, avvio, cancellazione totale e codici d'errore;
  - per ogni gruppo di istruzioni indica il capitolo del manuale pubblico da cui viene la semantica;
  - elenca le scelte non coperte dal manuale, marcate ⚠️ (per esempio la profondità dello stack dei blocchi e la scelta sul tempo).
- **`docs/limiti-noti.md`:**
  - nuova sezione "Simulatore (piano 2A)";
  - limiti: nessuna CPU reale per confermare la semantica (spec §10); temporizzatori, contatori, SFC/SFB e OB di errore rimandati al piano 2B; nessuna interfaccia fino al piano 2C; il tempo di ciclo del simulatore non è quello di una CPU vera.
- **Piano generale:** riga 2A → "fatto".
- **Versione:** `apps/desktop` 0.6.0.
- **Collaudo** con `S7_CAPTURES_DIR` sulla cache delle catture:
  ```
  npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check
  ```
  Deve essere verde. Gli e2e si eseguono una volta: il piano non tocca l'interfaccia.

- [ ] **Step 1: Aggiorna documenti, versione e caselle**
- [ ] **Step 2: Esegui il collaudo**
- [ ] **Step 3: Commit** — `docs: piano 2A — semantica del simulatore, limiti noti, versione 0.6.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Si eseguono i byte MC7, non il testo AWL.** `decodeInstruction` passo per passo, con la cache. Così si prova esattamente ciò che si carica (spec §6), compresi i blocchi caricati dalle macchine e le chiamate espanse (`BLD`, `UC` con la lista dei puntatori). *Se fosse sbagliato:* le prestazioni si recuperano con una cache che pre-compila le istruzioni in chiusure, senza cambiare l'interfaccia.
- **R2. Pacchetto puro, nessun Worker in questo piano.** Il Worker e l'interfaccia arrivano nel piano 2C, che ospita `SimCpu` e chiama `cycle()` a tempo. *Se fosse sbagliato:* niente da rifare; il pacchetto gira anche nel renderer.
- **R3. Il server S7 riceve un'interfaccia `CpuBackend`.** È estratta da `FakeCpu` senza cambiarne il comportamento, così "carica nel simulatore" usa lo stesso client e lo stesso protocollo del PLC vero. *Se fosse sbagliato:* `SimCpu` potrebbe ereditare da `FakeCpu`, ma i campi privati lo rendono fragile.
- **R4. Gli errori di programmazione portano in STOP nel piano 2A.** Nel piano 2B, se OB121/OB122/OB80/OB85 sono caricati, si richiamano. È il comportamento della CPU vera quando l'OB d'errore manca. *Se fosse sbagliato:* si cambia un punto solo, in `cpu.ts`.
- **R5. Cancellazione totale = la memoria di lavoro torna allo stato del file caricato, i blocchi restano.** Le CPU S7-300 con MMC ricaricano il programma dalla scheda dopo una cancellazione totale. *Se fosse sbagliato:* si aggiunge "cancella anche i blocchi" come opzione nel pannello del piano 2C.
- **R6. La profondità dello stack dei blocchi è fissa a 16**, con lo stack L condiviso secondo `localDataBytesPerClass`. Il manuale delle CPU 31x indica valori che cambiano con la CPU; la costante unica è marcata ⚠️ in `sim.md`. *Se fosse sbagliato:* si legge dal catalogo, aggiungendo il campo.
- **R7. Il tempo è iniettato e il controllo del ciclo avviene ogni 1024 istruzioni.** Un tempo deterministico nei test, e un ciclo infinito che non blocca mai il simulatore. *Se fosse sbagliato:* si cambia la costante.
- **R8. Temporizzatori, contatori e SFC/SFB danno un errore chiaro (`NON_SIMULATA_2B`) invece di essere ignorati.** È la regola della spec «avviso chiaro "non simulata"» applicata già adesso. *Se fosse sbagliato:* niente, il piano 2B li implementa.
