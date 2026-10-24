# Piano 2B — Temporizzatori, contatori, OB e SFC — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** completare la CPU simulata di `@baaportal/sim` (piano 2A) con:

- i temporizzatori S5 e i contatori;
- gli OB di schedulazione (OB35) e di errore (OB80, OB82, OB85, OB86, OB121, OB122);
- le SFC più usate e gli SFB 0–5 IEC.

Le SFC e gli SFB non simulati danno un avviso chiaro, "non simulata", senza fermare la CPU.

**Architettura:**

- **Tempo:** i temporizzatori calcolano il loro stato al momento dell'accesso, a partire dall'orologio iniettato `now()`. Non c'è un thread che li decrementa, così il comportamento è deterministico nei test.
- **Gli OB come eventi:** un errore di programmazione, un errore di accesso alla periferia, un ciclo troppo lungo o un allarme schedulato diventano un **evento**:
  - se l'OB dell'evento è caricato, la CPU lo richiama in una sua classe di priorità, con il suo stack L e i suoi dati di avvio, e poi prosegue;
  - se l'OB non c'è, la CPU fa come quella vera: va in STOP, oppure richiama OB85, secondo la tabella del Task 3.
- **SFC e SFB come funzioni native:** `UC SFC n` e `UC SFB n` cercano un gestore TypeScript in un registro. Il gestore legge e scrive i parametri attraverso la lista dei puntatori (SFC) o il DB di istanza in DI/AR2 (SFB). Lo stato interno degli SFB IEC sta nella CPU, fuori dal DB di istanza (R4).

**Tecnologie:** TypeScript, Vitest (node).

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §9 Tappa 2: temporizzatori S5, contatori, SFB 0–5, merker di clock, OB35 e OB di errore principali, SFC 0, 1, 20, 21, 46, 51 e le altre più usate, avviso "non simulata";
- §10 sui test.

Piano generale: riga 2B. Piano precedente: `docs/superpowers/plans/2026-10-24-tappa2a-nucleo-cpu-simulata.md`. Semantica attuale: `docs/protocollo/sim.md`. Codifica MC7: `docs/protocollo/mc7.md` §2.5 (UC SFC/SFB) e §2.6.12 (temporizzatori).

## Global Constraints

- **Clean-room** (spec §5): la semantica viene **solo** dai manuali Siemens pubblici:
  - manuale AWL S7-300/400, operazioni di temporizzazione e di conteggio;
  - «System Software for S7-300/400 System and Standard Functions» per le SFC, gli SFB e i dati di avvio e i codici d'errore degli OB;
  - i manuali delle CPU 31x.

  I riferimenti si citano in modo generico (manuale e argomento), mai con titoli di capitolo inventati. Non si analizza PLCSIM né altro software Siemens e non si copia codice da simulatori open source.

- **Tempo deterministico:** solo `now()` iniettato; nessun `setTimeout` nel pacchetto; i test non usano il tempo reale.
- **Numero di temporizzatori e contatori** da `findCpu(cpuTypeId).limits.timers` / `.counters` del catalogo, al posto delle costanti 2048 del piano 2A. Un numero fuori campo è un errore di programmazione.
- **Codici di errore di programmazione (OB121, `OB121_SW_FLT`)**, dal manuale delle funzioni di sistema; ogni `SimErrorCode` di programmazione ne ha uno:
  - `BCD_NON_VALIDO` 16#21;
  - area/lunghezza in lettura 16#22, in scrittura 16#23;
  - numero di temporizzatore 16#26 (nuovo codice `NUMERO_TEMPORIZZATORE`), numero di contatore 16#27 (`NUMERO_CONTATORE`);
  - DB non caricato 16#3A, FC non caricata 16#3C, SFC non caricata 16#3D, FB non caricato 16#3E, SFB non caricato 16#3F.

  L'identificativo dell'evento nel buffer di diagnostica è 16#2500 + codice (per esempio 16#2522). `AREA_LUNGHEZZA` si divide in lettura e scrittura secondo l'accesso. I codici senza riscontro nel manuale restano sintetici, da 16#9000, e sono marcati ⚠️.

- **Avviso "non simulata"** (spec §9): una SFC o un SFB non simulati:
  - non scrivono le uscite e mettono BR = 0;
  - aggiungono una voce di diagnostica `SFC_NON_SIMULATA` o `SFB_NON_SIMULATA` (non un errore) una volta per numero e per periodo di RUN, ed emettono `SimEvent { type: 'warning' }`;
  - lasciano proseguire la CPU.

  `NON_SIMULATA_2B` sparisce.

- **Nessuna dipendenza nuova.** `layoutInstance` di `@baaportal/s7-types` per la disposizione dei parametri degli SFB. Il lettore di SZL del server S7 si riusa per SFC51 se è esportabile, altrimenti lo si sposta in un modulo condiviso senza cambiarne il comportamento.
- **Nessuna funzione parla con un PLC vero.** Versione **0.7.0**.

## Review Focus

1. **Temporizzatori vicino ai bordi.** Un avvio con RLO già a 1 (nessun fronte), FR senza fronte, R durante il conteggio, base dei tempi 10 s con il valore 999, S5TIME non BCD, `L T` e `LC T` a metà conteggio, temporizzatore ritentivo dopo STOP→RUN. Atteso: bit di stato e valore residuo come nelle tabelle e nei diagrammi del manuale AWL. → Task 1.
2. **Errore dentro un OB d'errore.** OB121 che a sua volta fa un errore di programmazione, OB80 che sfora, OB35 che dura più del suo intervallo. Atteso: nessuna ricorsione infinita. Un errore nella stessa classe di priorità di OB121 porta in STOP. → Task 3.
3. **OB121 caricato: si prosegue davvero.** Dopo l'OB, l'esecuzione riprende dall'istruzione successiva con i registri del blocco interrotto ripristinati. ACCU1 resta invariato per una lettura fallita; una scrittura fallita non scrive niente. → Task 3.
4. **Parametri ANY e puntatori alle SFC.** BLKMOV fra DB e M, con una sorgente più lunga della destinazione o un DB inesistente. Atteso: RET_VAL con il codice d'errore del manuale, nessuna scrittura parziale fuori area. → Task 4.
5. **SFB IEC in multi-istanza e con lo stesso DB.** Due TON in multi-istanza nello stesso FB e un TON richiamato due volte nello stesso ciclo. Atteso: stati indipendenti per istanza (DB e offset AR2); ET non supera PT. → Task 5.

---

### Task 1: Temporizzatori S5

**Files:**

- Create: `packages/sim/src/timers.ts`, `packages/sim/src/ops/timer.ts`
- Modify: `packages/sim/src/cpu.ts` (dimensione dal catalogo, ritentività), `src/ops/index.ts`, `src/ops/bitLogic.ts` e `src/ops/loadTransfer.ts` per A/O/X/L/LC/R su T, `src/errors.ts` (`NUMERO_TEMPORIZZATORE`)
- Test: `packages/sim/test/timers.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface S5Timer {
    running: boolean;
    q: boolean;
    startedAt: number;
    preset: number /* in ms */;
    base: 10 | 100 | 1000 | 10000;
    edge: boolean;
    enabled: boolean;
  }
  export class TimerBank {
    constructor(count: number, now: () => number);
    get(n: number): S5Timer;
    value(n: number): { units: number; base: number };
    reset(from: number): void;
  }
  ```
  `ExecContext` riceve `timers: TimerBank`.

Regole (manuale AWL S7-300/400, operazioni di temporizzazione):

- **S5TIME in ACCU1-L:** bit 12–13 sono la base dei tempi (00 = 10 ms, 01 = 100 ms, 10 = 1 s, 11 = 10 s); bit 0–11 sono il valore BCD 0–999. Un BCD non valido dà `BCD_NON_VALIDO`.
- **SP, SE, SD, SS, SF:** si avviano sul **fronte di salita** dell'RLO (SF sul fronte di discesa); il fronte è memorizzato per temporizzatore. Lo stato e il residuo seguono i diagrammi del manuale per SI/SV/SE/SS/SA:
  - **SP:** impulso, si ferma se l'RLO va a 0;
  - **SE:** impulso prolungato, si riavvia su un nuovo fronte;
  - **SD:** ritardo all'inserzione, Q = 1 a tempo scaduto e RLO = 1;
  - **SS:** ritardo all'inserzione con memoria; Q resta 1 fino a R;
  - **SF:** ritardo alla disinserzione.
- **FR:** sul fronte di salita dell'RLO riabilita il riavvio senza fronte di avvio.
- **R:** con RLO 1 azzera il temporizzatore e Q.
- **Valore residuo:** `units = preset − floor((now − startedAt) / base)`, saturato a 0.
  - `L T n` dà il residuo binario 0–999, senza base;
  - `LC T n` dà il residuo in BCD con la base nei bit 12–13;
  - `A`/`O`/`X T n` (e le negazioni) leggono Q con le regole di `checkBit`.
- **Parola di stato:** le istruzioni di avvio, R e FR seguono le tabelle del manuale. Come per S e R: /FC = 0, OR = 0, STA = …, RLO invariato.
- **Numero oltre `limits.timers`:** `NUMERO_TEMPORIZZATORE`.
- **Ritentività:** all'avvio a caldo si azzerano i temporizzatori `≥ retentivity.timers`; la cancellazione totale li azzera tutti.

- [x] **Step 1: Test che falliscono.** Ogni test usa un orologio iniettato che avanza a mano:
  - `SD con 2 s: Q=0 a 1999 ms, Q=1 a 2000 ms, Q=0 appena RLO=0`
  - `SP: impulso che si interrompe con RLO=0`
  - `SE: riavvio su nuovo fronte durante l'impulso`
  - `SS: Q resta 1 dopo RLO=0 fino a R`
  - `SF: Q=1 con RLO=1, scade 3 s dopo il fronte di discesa`
  - `nessun avvio senza fronte; FR riabilita`
  - `L T e LC T a metà conteggio (base 100 ms, 50 → 23 dopo 2,7 s)`
  - `S5TIME non BCD → BCD_NON_VALIDO`
  - `T oltre il limite della CPU → NUMERO_TEMPORIZZATORE`
  - `ritentivi conservati e non ritentivi azzerati a STOP→RUN`
- [x] **Step 2: Verifica che falliscano.**
- [x] **Step 3: Implementa.**
- [x] **Step 4:** `npx vitest run --project sim && npm run typecheck && npm run lint && npm run format:check`
- [x] **Step 5: Commit** — `feat(sim): temporizzatori S5`

### Task 2: Contatori

**Files:**

- Create: `packages/sim/src/counters.ts`, `packages/sim/src/ops/counter.ts`
- Modify: come nel Task 1, per C (`NUMERO_CONTATORE`)
- Test: `packages/sim/test/counters.test.ts`

**Interfaces:** `CounterBank` con `{ value: number /* 0..999 */; q: boolean; edgeCu: boolean; edgeCd: boolean; edgeS: boolean; enabled: boolean }`; `ExecContext.counters`.

Regole (manuale AWL S7-300/400, operazioni di conteggio):

- **CU e CD** contano sul fronte di salita dell'RLO (fronti distinti per CU, CD e S). Il valore si ferma a 999 e a 0, senza riporto.
- **S C n** sul fronte di salita carica ACCU1-L in BCD (0–999; BCD non valido → `BCD_NON_VALIDO`).
- **R** con RLO 1 azzera.
- **FR** sul fronte riabilita.
- **Lettura:** Q (per A/O/X) = valore ≠ 0. `L C n` dà il valore binario, `LC C n` in BCD.
- **Numero oltre il limite:** `NUMERO_CONTATORE`.
- **Ritentività** come per i temporizzatori.

- [x] **Step 1: Test:**
  - `CU 3 volte sui fronti → 3, Q=1`
  - `CU a 999 resta 999`
  - `CD a 0 resta 0, Q=0`
  - `S con C#5 poi CD → 4`
  - `S con BCD non valido`
  - `LC C → BCD`
  - `R azzera`
  - `nessun conteggio senza fronte`
  - `ritentività`
- [x] **Step 2–4:** come nel Task 1.
- [x] **Step 5: Commit** — `feat(sim): contatori`

### Task 3: Eventi e OB di schedulazione e di errore

**Files:**

- Create: `packages/sim/src/events.ts`
- Modify: `packages/sim/src/cpu.ts`, `src/executor.ts` (punto di interruzione al tick e ripresa dopo l'OB d'errore), `src/memory.ts` (uno stack L per classe di priorità), `src/obStartInfo.ts` (dati di avvio di OB35/80/82/85/86/121/122 da `OB_DEFINITIONS`), `src/backend.ts` (id diagnostici del manuale), `src/errors.ts`
- Test: `packages/sim/test/events.test.ts`

**Interfaces:**

- Produces:
  ```ts
  // SimCpuProps: + cyclicInterruptMs: number (OB35, da cyclicInterrupts.ob35Ms)
  // SimCpu: + raiseInterrupt(ob: 82 | 86, info?: { address?: number; coming?: boolean }): void   // per il pannello del piano 2C
  // DiagEntry.code: + 'OB_RICHIAMATO' | 'SFC_NON_SIMULATA' | 'SFB_NON_SIMULATA'; DiagEntry: + eventId: number
  ```

Regole (manuale delle funzioni di sistema S7-300/400, OB e dati di avvio; manuale CPU 31x per le classi di priorità):

| Evento                                                                                    | OB                              | Se l'OB manca                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------- |
| errore di programmazione (`SimError` delle aree, BCD, numeri T/C, blocco/DB non caricato) | OB121 (prio dell'interrotto)    | STOP                                          |
| accesso alla periferia (P/PI/PQ) fuori dal campo di I/O della CPU                         | OB122 (prio dell'interrotto)    | STOP                                          |
| tempo di ciclo superato (orologio o limite di istruzioni)                                 | OB80 (prio 26), evento 16#3501  | STOP                                          |
| OB35 ancora in corso quando scade l'intervallo successivo                                 | OB80, evento 16#3502            | STOP                                          |
| `raiseInterrupt(82)` / `raiseInterrupt(86)`                                               | OB82 (prio 26) / OB86 (prio 26) | OB85, evento 16#35A1, se c'è; altrimenti STOP |
| intervallo `cyclicInterruptMs` scaduto                                                    | OB35 (prio 12)                  | nessun evento                                 |

- **OB121 e OB122:** si eseguono **al posto** dell'istruzione che ha sbagliato. Al ritorno si ripristinano tutti i registri del blocco interrotto e si prosegue con l'istruzione successiva:
  - una lettura fallita lascia gli accumulatori invariati;
  - una scrittura fallita non scrive niente.
- **OB121 e OB122 non si annidano:** un errore dentro OB121 o OB122 porta in STOP con le due voci.
- **OB80:** dopo il primo superamento si richiama OB80 e il ciclo continua. Un secondo superamento **nello stesso ciclo** porta in STOP, come il raddoppio del tempo di ciclo del manuale.
- **OB35:** è controllato all'inizio di ogni ciclo e a ogni tick (1024 istruzioni). Se è scaduto, interrompe il blocco in corso al confine di istruzione, gira con il suo stack L e la sua parola di stato, e poi il blocco riprende con i registri salvati.
- **Interruzioni e avvio:** OB35, OB82 e OB86 non girano in AVVIO.
- **Dati di avvio:** 20 byte negli L 0..19 dell'OB, con il formato di `OB_DEFINITIONS`:
  - per OB121/122: `SW_FLT`, `BLK_TYPE`, `FLT_REG`, `BLK_NUM`, `PRG_ADDR` (offset MC7) e data e ora in BCD;
  - per OB80: l'id dell'evento e il tempo di ciclo.
- **Diagnostica:**
  - ogni OB richiamato aggiunge una voce `OB_RICHIAMATO` con l'id dell'evento;
  - `backend.ts` usa `DiagEntry.eventId` invece del sintetico 16#9000+indice;
  - i codici senza id del manuale (AVVIO, STOP_RICHIESTO, CANCELLAZIONE_TOTALE, MC7_NON_ESEGUIBILE) restano da 16#9000, ⚠️.
- **Stack L:** ogni classe di priorità ha il suo, di `localDataBytesPerClass` byte.

- [x] **Step 1: Test:**
  - `OB121 caricato: area fuori campo → OB121 con SW_FLT 16#22 e PRG_ADDR, poi l'OB1 continua e scrive M dopo`
  - `OB121 assente → STOP con id 16#2522`
  - `errore dentro OB121 → STOP`
  - `OB122 per PIW oltre il campo`
  - `OB80 al primo sforamento, STOP al secondo nello stesso ciclo`
  - `OB35 ogni 100 ms con orologio a mano (3 esecuzioni in 300 ms), registri dell'OB1 intatti dopo l'interruzione`
  - `OB35 lento → OB80 16#3502`
  - `raiseInterrupt(82) con OB82 / senza OB82 ma con OB85 / senza entrambi → STOP`
  - `id diagnostici del manuale nell'SZL 0x00A0`
- [x] **Step 2–4:** come nel Task 1.
- [x] **Step 5: Commit** — `feat(sim): OB di schedulazione e di errore`

### Task 4: SFC simulate e avviso "non simulata"

**Files:**

- Create: `packages/sim/src/system/registry.ts`, `src/system/params.ts` (accesso ai parametri dalla lista dei puntatori, ANY compreso), `src/system/sfc.ts`
- Modify: `src/ops/control.ts` (UC/CC SFC e SFB tramite il registro), `src/cpu.ts` (orologio della CPU con scarto impostabile)
- Test: `packages/sim/test/sfc.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface SystemCall {
    ctx: ExecState;
    param(name: string): ParamRef; /* in base all'interfaccia del catalogo */
  }
  export interface ParamRef {
    read(size: Size): number;
    write(size: Size, v: number): void;
    any(): AnyRef; /* area, db, byte, length in byte */
  }
  export type SystemHandler = (call: SystemCall) => void;
  export const SFC_HANDLERS: Record<number, SystemHandler>;
  ```

SFC da simulare (manuale delle funzioni di sistema; i codici di RET_VAL come nel manuale):

- SFC0 `SET_CLK` e SFC1 `READ_CLK`: orologio della CPU = `now()` + scarto; `SET_CLK` cambia lo scarto; formato DATE_AND_TIME in BCD.
- SFC20 `BLKMOV` e SFC21 `FILL`, con i parametri ANY: aree M, I, Q, DB, DI, L del chiamante; lunghezza in byte secondo il tipo dell'ANY; area o DB inesistente → RET_VAL d'errore del manuale, nessuna scrittura.
- SFC22 `CREAT_DB`, SFC23 `DEL_DB`, SFC24 `TEST_DB`.
- SFC46 `STP`: STOP con la voce `STOP_RICHIESTO`.
- SFC47 `WAIT`: fa avanzare il tempo del ciclo; nei test con l'orologio iniettato non attende.
- SFC51 `RDSYSST`: SZL 0x0011, 0x0111, 0x0424 (modo), 0x00A0 (buffer di diagnostica), con gli stessi byte del server S7.
- SFC64 `TIME_TCK`: ms dall'avvio, modulo 2^31.

Regole:

- **Interfacce:** tipi e ordine dei parametri vengono dal catalogo (`findSystemBlock`). Il gestore non ripete l'interfaccia.
- **SFC o SFB senza gestore:** l'avviso "non simulata" delle Global Constraints.
- **`UC SFC n` con n inesistente nel catalogo:** errore di programmazione 16#3D (SFC non caricata).
- **BR = 1** se RET_VAL ≥ 0, altrimenti 0, come nel manuale (ENO).

- [x] **Step 1: Test:**
  - `READ_CLK dopo SET_CLK`
  - `BLKMOV DB1→M e M→DB con ANY costanti (P#DB1.DBX0.0 BYTE 10)`
  - `BLKMOV con DB inesistente → RET_VAL d'errore, nessuna scrittura`
  - `FILL`
  - `CREAT_DB/TEST_DB/DEL_DB`
  - `STP → STOP`
  - `RDSYSST 0x0424 → modo RUN`
  - `TIME_TCK avanza con l'orologio`
  - `SFC non simulata (es. SFC 14) → avviso una volta, BR=0, la CPU resta in RUN`
- [x] **Step 2–4:** come nel Task 1.
- [x] **Step 5: Commit** — `feat(sim): SFC simulate e avviso "non simulata"`

### Task 5: SFB 0–5 (temporizzatori e contatori IEC)

**Files:**

- Create: `packages/sim/src/system/sfb.ts`
- Modify: `src/system/registry.ts`
- Test: `packages/sim/test/sfb.test.ts`

Regole (manuale delle funzioni di sistema, SFB 0–5):

- **Parametri:** stanno nel DB di istanza aperto in DI, all'offset AR2 (multi-istanza). La disposizione viene da `layoutInstance` sulle sezioni del catalogo: IN, OUT, nell'ordine. Lo stato interno è in una mappa della CPU indicizzata da (numero di DI, offset AR2), azzerata all'avvio a caldo e dalla cancellazione totale (R4).
- **TP:** impulso di durata PT sul fronte di IN, non riavviabile durante l'impulso. ET cresce fino a PT e torna a 0 quando IN = 0 e l'impulso è finito.
- **TON:** Q = 1 dopo PT con IN = 1. ET si ferma a PT e torna a 0 con IN = 0.
- **TOF:** Q = 1 con IN = 1; Q = 0 dopo PT dal fronte di discesa. ET come nel manuale.
- **CTU, CTD, CTUD:**
  - conteggio sul fronte di CU e di CD; R azzera, LOAD carica PV;
  - Q, QU e QD come nel manuale: CTU Q = CV ≥ PV; CTD Q = CV ≤ 0; CTUD QU = CV ≥ PV, QD = CV ≤ 0;
  - CV saturato ai limiti di INT.
- **TIME:** in ms, con segno, 32 bit; PT negativo → ⚠️ trattato come 0.

- [x] **Step 1: Test:**
  - `TON in un DB di istanza (CALL SFB 4, DB 5) con orologio a mano`
  - `TP non riavviabile`
  - `TOF`
  - `CTU/CTD/CTUD con R e LOAD`
  - `due TON in multi-istanza nello stesso FB, stati indipendenti`
  - `stato azzerato a STOP→RUN`
- [x] **Step 2–4:** come nel Task 1.
- [x] **Step 5: Commit** — `feat(sim): SFB 0–5 IEC`

### Task 6: Batteria e copertura

**Files:**

- Create: nuovi programmi in `packages/sim/test/battery/` (almeno: temporizzatori S5, contatori, OB121 con ripresa, OB35, BLKMOV/FILL, TON/CTU)
- Modify: `packages/sim/test/coverage.test.ts`, `test/batteryRunner.ts` (orologio avanzabile fra i cicli e più cicli per file)

Regole:

- **`DEFERRED_2B` sparisce:** ogni id di `INSTRUCTIONS` deve essere eseguito, salvo `CALL`, che nell'MC7 non è un'istruzione.
- **Intestazione dei programmi:** un programma con il tempo dichiara in testa `// cicli: N, passo: M ms`.
- **Valori attesi:** si ricavano dai diagrammi del manuale, non dall'output del simulatore. Ogni differenza va giudicata come nel piano 2A.

- [x] **Step 1–4:** programmi → `npx vitest run --project sim` → correzioni → controlli.
- [x] **Step 5: Commit** — `test(sim): batteria del piano 2B`

### Task 7: Documentazione, limiti noti, versione, collaudo

**Files:** `docs/protocollo/sim.md`, `docs/limiti-noti.md` (sezione "Simulatore (piano 2B)"), il piano generale (riga 2B → fatto), `apps/desktop/package.json` 0.7.0 e `package-lock.json`, le caselle di questo piano.

Regole:

- **`sim.md`:** nuove sezioni su temporizzatori, contatori, eventi e OB, SFC e SFB. Le scelte ⚠️ sono raccolte dal registro di esecuzione e dai rapporti dei task.
- **Limiti noti:**
  - nessuna CPU vera per confermare;
  - OB82 e OB86 solo da `raiseInterrupt`;
  - granularità di OB35 al tick;
  - stato degli SFB fuori dal DB;
  - SFC e SFB non simulati elencati per numero.
- **Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.
- [x] **Step 1–3:** documenti, collaudo, commit `docs: piano 2B — temporizzatori, contatori, OB e SFC, versione 0.7.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. I temporizzatori si calcolano al momento della lettura** da `now()` e dall'istante di avvio, invece di essere decrementati da un orologio interno. Il risultato è lo stesso a ogni lettura e il tempo è deterministico. _Se fosse sbagliato:_ si aggiunge un aggiornamento per base dei tempi in `cycle()`.
- **R2. OB35 interrompe solo ai tick (ogni 1024 istruzioni) e all'inizio del ciclo**, non a ogni istruzione. La latenza è di al più 1024 istruzioni, ⚠️. _Se fosse sbagliato:_ si abbassa il passo del tick.
- **R3. OB82 e OB86 si generano solo da `raiseInterrupt`.** Non c'è ancora una configurazione hardware (tappa 6); il pannello I/O del piano 2C li offre come "simula guasto". _Se fosse sbagliato:_ si collegano alla configurazione hardware nella tappa 6.
- **R4. Lo stato interno degli SFB IEC sta nella CPU, non nel DB di istanza.** Il manuale non documenta gli statici di SFB 0–5, e il catalogo e il compilatore generano DB di istanza con i soli parametri. _Se fosse sbagliato:_ se una CPU vera rivela la disposizione, si sposta lo stato nel DB.
- **R5. Una SFC o un SFB non simulati sono un avviso, non un errore**: la spec chiede un «avviso chiaro "non simulata"». La CPU prosegue con BR = 0. _Se fosse sbagliato:_ un'opzione del pannello del piano 2C può farne uno STOP.
- **R6. Gli id del buffer di diagnostica vengono dal manuale quando ci sono** (16#25xx per gli errori di programmazione, 16#35xx per OB80 e OB85). Gli altri restano sintetici. _Se fosse sbagliato:_ si correggono con la conformità su CPU reale.
