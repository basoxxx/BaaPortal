# CPU S7-300 simulata — riferimento BaaPortal (piani 2A, 2B e 2C)

Questo documento descrive la CPU simulata del pacchetto `@baaportal/sim` (piani 2A e 2B): modello di memoria, registri, parola di stato, regole di richiamo dei blocchi, ciclo, avvio, cancellazione totale e codici d'errore (piano 2A); temporizzatori e contatori S5, eventi e OB, SFC, SFB 0–5 e avviso «non simulata» (piano 2B, §10–§13). Le scelte che il manuale pubblico non copre sono marcate **⚠️**; le raccoglie anche `docs/limiti-noti.md` (sezioni «Simulatore (piano 2A)» e «Simulatore (piano 2B)»).

## 0. Fonti e regole

- **Clean-room** (spec §5): la semantica viene solo dai manuali Siemens pubblici: _Statement List (STL) for S7-300 and S7-400 Programming_ (in seguito [AWL], «manuale AWL S7-300/400»; i riferimenti sono ad argomenti generici, non ai titoli dei capitoli) e i manuali delle CPU 31x (in seguito [CPU]). Non si analizza PLCSIM né altro software Siemens e non si copia codice di simulatori.
- **Si eseguono i byte MC7**, non il testo AWL: l'esecutore chiama `decodeInstruction` (`@baaportal/mc7`) istruzione per istruzione, con una cache per blocco e per offset. Si prova così esattamente ciò che si carica nel PLC (spec §6). Formato dei byte: `docs/protocollo/mc7.md`.
- **Carica**: la CPU simulata implementa `CpuBackend` del server S7 in memoria, quindi si carica con lo stesso `S7WriteClient.downloadBlock` del PLC vero.
- **Nessuna CPU reale ha confermato queste semantiche** (spec §10): il simulatore verifica la coerenza interna, non sostituisce le prove su una CPU vera.

## 1. Modello di memoria

Tutte le aree sono **big-endian**. Le dimensioni vengono dal catalogo della CPU (`inputBytes`, `outputBytes`, `mBytes`, `localDataBytesPerClass`); una CPU sconosciuta usa i valori di una 315-2 PN/DP.

| area   | contenuto                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| I, Q   | immagini di processo                                                                                            |
| M      | merker                                                                                                          |
| PI, PQ | periferia: PI legge `physIn`, PQ scrive `physOut`; l'area `P` da puntatore legge `physIn` e scrive `physOut`    |
| L      | stack dei dati locali, un solo array condiviso fra i blocchi (finestra per blocco, §3)                          |
| V      | dati locali del chiamante: stesso array di L, offset calcolato dalla finestra del chiamante                     |
| DB, DI | blocchi dati; si leggono con il registro DB o DI aperto (`OPN`), oppure con il numero esplicito (`DB5.DBX 0.0`) |
| T      | temporizzatori S5 (numero da `limits.timers` del catalogo): SP, SE, SD, SS, SF, FR, R, L, LC, A/O/X (§10)       |
| C      | contatori S5 (numero da `limits.counters` del catalogo): CU, CD, S, R, FR, L, LC, A/O/X (§11)                   |

**⚠️ PQ → Q**: una scrittura diretta in PQ (o in `P` da puntatore) scrive gli stessi byte anche in Q, se l'indirizzo vi cade, così l'uscita non si perde alla copia di Q in `physOut` a fine ciclo (la S7-300 aggiorna la PIQ negli accessi diretti alle uscite; non verificato su una CPU).

Un accesso fuori area dà `AREA_LUNGHEZZA`, un DB assente `DB_NON_CARICATO`, DB/DI con registro 0 `DB_NON_APERTO`. Un puntatore a 32 bit senza il bit 31 (nessuna area) dà `AREA_LUNGHEZZA`; con il bit 31 e area 0 indica la periferia (`P`). L'offset di AR1/AR2 è di 24 bit (bit 0–23, [AWL], indirizzamento indiretto); per gli operandi la parte byte occupa i bit 3–18.

Sorgente: manuale AWL S7-300/400, aree di memoria e indirizzamento indiretto (da memoria e da registro).

## 2. Registri e parola di stato

La S7-300 ha **2 accumulatori**. ACCU1, ACCU2, AR1, AR2 sono a 32 bit; i registri DB e DI contengono il numero del blocco aperto.

- `PUSH` copia ACCU1 in ACCU2, `POP` copia ACCU2 in ACCU1.
- `ENT` e `LEAVE` esistono solo con 4 accumulatori: danno `ISTRUZIONE_NON_S7300`. ⚠️ Sono registrati così perché l'MC7 li decodifica ma la S7-300 non li ha.
- Le operazioni intere a 16 bit lasciano invariate la parola alta di ACCU1 e ACCU2.

**Parola di stato** ([AWL], parola di stato): bit 0 /FC, 1 RLO, 2 STA, 3 OR, 4 OS, 5 OV, 6 CC0, 7 CC1, 8 BR. `L STW` e `T STW` usano questa disposizione e portano solo i bit 0–8 (⚠️ i bit 9–15 si leggono 0).

### 2.1 Nuova catena logica e stack di annidamento

Il modello è quello delle tabelle del manuale: la funzione `A`/`O`/`X` con la sua negazione, e `OR` per la forma `O` senza operando (`A`/`O`/`A` vale `(a o b) e c`). L'apertura di parentesi (`A(`, `O(`, `X(` e le forme negate) salva RLO, OR, /FC e la funzione nello **stack di annidamento**; la chiusura `)` le ripristina. Una `)` non bilanciata dà `MC7_NON_ESEGUIBILE`; un annidamento oltre la profondità dà `STACK_ANNIDAMENTO_PIENO`.

Sorgente: manuale AWL S7-300/400, operazioni logiche a bit e parola di stato.

## 3. Richiamo dei blocchi

- **Stack dei blocchi**: profondità massima **16** (il 17° blocco annidato dà `STACK_BLOCCHI_PIENO`; l'OB è il livello 0). ⚠️ Il manuale [CPU] dà valori che cambiano con la CPU e con la classe di priorità; qui la costante è unica (`MAX_BLOCK_STACK`).
- **Stack L**: un array solo, di `localDataBytesPerClass` byte. Ogni blocco riceve una finestra subito dopo quella del chiamante; se non c'è spazio, `STACK_L_PIENO`. Fuori dalla propria finestra si ha `AREA_LUNGHEZZA`. ⚠️ La finestra **non viene azzerata** all'ingresso (contenuto indefinito, come sulla CPU), salvo i 20 byte iniziali dell'OB.
- **UC / CC** (e la CALL espansa dal compilatore con la lista dei puntatori): `UC` chiama sempre; `CC` solo con RLO = 1, e mette RLO = 1 anche senza chiamare.
- **Parametri**: la lista dei puntatori che segue la chiamata viene risolta nel blocco **chiamante**; `L` e `V` nella lista indicano i dati locali del blocco che contiene la chiamata. Il parametro formale `#PAR` si risolve nel chiamato. La dimensione viene dal tipo (Bool, Byte, Word, DWord); Un parametro formale di tipo Timer o Counter porta il numero del T o del C del chiamante e si usa come l'operando diretto (§10, §11); i parametri Block_* danno `MC7_NON_ESEGUIBILE`.
- **Registri DB/DI**: salvati e ripristinati attorno alla chiamata. ⚠️ Dopo `CALL FB` il compilatore chiude con `CDB`, quindi DB = DB di istanza: il simulatore non lo corregge (coerente con il comportamento reale di STEP 7).
- **Stato MCR e annidamento**: il chiamato parte con stack di annidamento e stack MCR **vuoti**; ⚠️ lo stack MCR non è visibile dal chiamato.
- **Puntatori ai dati**: ⚠️ i puntatori a DB (`0x84` DB, `0x85` DI) legano il numero del DB al **momento della chiamata**; `0x86` (V) è trattato come V.
- **Salti**: la destinazione deve essere l'inizio di un'istruzione del blocco, altrimenti `MC7_NON_ESEGUIBILE`. ⚠️ Un salto alla fine esatta del codice è rifiutato (il compilatore termina sempre con `BE`).

Sorgente: manuale AWL S7-300/400, controllo del programma (`UC`, `CC`, `BE`, `BEU`, `BEC`); manuale delle CPU 31x, stack dei blocchi e dati locali.

## 4. Gruppi di istruzioni e argomenti del manuale

| gruppo                                                              | argomento del manuale AWL S7-300/400               |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| `A O X AN ON XN`, parentesi, `= S R`, `NOT SET CLR SAVE`, `FP FN`   | operazioni logiche a bit                           |
| `MCR(`, `)MCR`, `MCRA`, `MCRD`                                      | controllo del programma (relè master)              |
| `L T LAR TAR +AR` e relative                                        | caricamento e trasferimento, registri di indirizzo |
| `AW OW XW AD OD XD`                                                 | operazioni logiche a parola                        |
| `SLW SRW SLD SRD SSI SSD RLD RRD RLDA RRDA`                         | operazioni di scorrimento e rotazione              |
| `+I -I *I /I +D -D *D /D MOD +`                                     | operazioni aritmetiche sugli interi                |
| `+R -R *R /R ABS NEGR SQR SQRT` e funzioni trascendenti             | operazioni in virgola mobile                       |
| `==I … <=R`                                                         | operazioni di confronto                            |
| `BTI ITB BTD ITD DTB DTR RND TRUNC CAI CAD INVI INVD NEGI NEGD`     | operazioni di conversione                          |
| `JU JL JC JCN JCB JNB JBI JNBI JO JOS JZ JN JP JM JPZ JMZ JUO LOOP` | operazioni di salto                                |
| `UC CC BE BEU BEC BLD NOP OPN CDB`                                  | controllo del programma, blocchi dati              |
| `TAK PUSH POP ENT LEAVE INC DEC`                                    | operazioni sugli accumulatori                      |

Dal piano 2B sono simulati anche `SP SE SD SS SF FR LC CU CD`, gli operandi T e C e i parametri formali Timer/Counter (§10, §11); le chiamate di SFC e SFB seguono §12 e §13. I parametri formali `Block_*` restano un errore chiaro.

### 4.1 ⚠️ Scelte non coperte dal manuale

Parola di stato e logica a bit:

- **STA dopo `S` e `R`**: STA = RLO. Le tabelle del manuale segnano STA con «x».
- **`FP` e `FN`**: il bit ausiliario di fronte si legge e si aggiorna come da tabelle; i valori di STA/OR dopo il fronte non sono verificati su una CPU.
- **`MCR(` e `)MCR`**: OR = 0, STA = 1, RLO = 1, /FC = 0.
- **Salti `JC JCN JCB JNB JBI JNBI`**: OR = 0, STA = 1, RLO = 1, /FC = 0. `JBI` e `JNBI` lasciano **RLO invariato**. `JOS` azzera OS sempre, anche senza salto.
- **`UC` e `CC`**: OS = 0, OR = 0, STA = 1, /FC = 0 (CC anche RLO = 1).
- **`BE`, `BEU`, `BEC` e la fine del codice**: OS = OR = 0, STA = 1, /FC = 0; RLO e BR invariati. `BEC` non scrive BR. Fa eccezione l'**OB di primo livello**: la parola di stato finale resta ispezionabile.
- **Confronti**: OR = 0 dopo il confronto; OS resta invariato salvo REAL non valido.
- **`T STW` non applica MCR**; solo le scritture in memoria sono soggette a MCR.

Aritmetica:

- **Divisione per 0** (`/I /D MOD`): ACCU1 = 0 (il manuale non lo dice), CC = 11, OV = OS = 1; per `/I` anche il resto è 0.
- **`*I`**: il prodotto a 32 bit è memorizzato in ACCU1 intero («stored as a 32-bit integer in ACCU 1»); OV fuori dall'intervallo a 16 bit. CC dal segno vero del risultato.
- **`NEGR`** inverte solo il bit 31, la parola di stato non cambia.
- **REAL**: NaN memorizzato come **0x7FC00000** (forma canonica); i **denormali sono conservati** (nessuno svuotamento a zero), con CC 00 e OV = OS = 1. I risultati ±infinito danno CC secondo la tabella del manuale, ma **non verificati su una CPU**. Le funzioni trascendenti (`SQRT`, `EXP`, `LN`, `SIN`, `COS`, `TAN`, `ASIN`, `ACOS`, `ATAN`) usano `Math.*` arrotondato a float32: precisione **non verificata al ulp**.
- **Conversioni**: `ITB`/`DTB`/`RND`/`TRUNC` portano OV = 0 se riescono (OS invariato); `BTI` legge il segno dal bit 15 e `BTD` dal bit 31; solo cifre > 9 danno `BCD_NON_VALIDO`.
- **`+ costante`**: costante a 16 bit somma ad ACCU1-L senza riporto (parola alta invariata), a 32 bit somma a tutto ACCU1; parola di stato invariata.
- **`+AR1` / `+AR2` senza operando**: sommano ACCU1-L (con segno) a AR; l'offset è di 24 bit, area e bit 31 invariati.
- **Scorrimenti con conteggio 0**: nessuna operazione, parola di stato inclusa.
- **`TAR1`/`TAR2` in ACCU1** salva il vecchio ACCU1 in ACCU2.

Programma:

- **`LOOP`** conserva ACCU1-H; **`JL`** non tocca la parola di stato.
- **Merker di clock**: vedi §5.
- **Costanti**: la lettura dei letterali usa il valore dei byte MC7 (`W#16#`, `S5T#`, `D#`, `TOD#`, `T#`, `C#`, caratteri) con zero esteso.

## 5. Ciclo OB1, tempo e clock

`cycle()` esegue un ciclo OB1 in RUN (in STOP non fa nulla e `CycleResult.ran` è `false`):

1. aggiorna il byte del merker di clock (se abilitato);
2. copia `physIn` in I;
3. esegue OB1 con 20 byte di informazioni di avvio in L (OB1: byte 6–7 durata del ciclo precedente, 8–9 minima, 10–11 massima, 12–19 data e ora in BCD; layout del catalogo OB, [CPU]); il primo ciclo dopo l'avvio ha SCAN_1 = 1, i successivi 3;
4. controlla il tempo di ciclo; se è superato, interviene OB80 (§10.3) o, se non può, `TEMPO_CICLO_SUPERATO` e STOP;
5. copia Q in `physOut` e aggiorna le statistiche (ultimo, minimo, massimo, numero di cicli).

Senza OB1 il ciclo gira a vuoto: gli ingressi e le uscite si aggiornano lo stesso.

**⚠️ Modello del tempo**:

- l'orologio è **iniettato** (`now(): number` in ms) e nei test è deterministico;
- il tempo di ciclo si controlla **ogni 1024 istruzioni** e alla fine del ciclo, contro `maxCycleMs` delle proprietà della CPU. Indipendente dall'orologio c'è un **limite fisso di 10 000 000 istruzioni per ciclo** (e per OB100): oltre, `TEMPO_CICLO_SUPERATO`. Un salto su se stesso termina quindi sempre, anche con un orologio fermo (⚠️ il limite è una scelta del simulatore);
- il **byte del merker di clock** si aggiorna all'inizio del ciclo e ogni 1024 istruzioni, non a ogni lettura: può restare indietro fino a 1024 istruzioni. Periodi dei bit 0–7: 100, 200, 400, 500, 800, 1000, 1600, 2000 ms ([CPU], merker di clock);
- il tempo di ciclo del simulatore non è quello di una CPU vera.

## 6. Avvio, STOP, RUN e cancellazione totale

- **`run()`** (solo da STOP; azzera anche le statistiche del ciclo, così le informazioni di avvio del primo OB1 non portano i tempi del RUN precedente): STARTUP, voce `AVVIO`, **avvio a caldo** (azzera I, Q, i merker e i T/C non ritentivi; la ritentività conta da 0 gli MB, i T e i C; i DB restano), poi OB100 se presente (informazioni di avvio con evento 0x13, priorità 27, data e ora BCD), infine RUN. Un errore in OB100 lascia la CPU in STOP. **⚠️ Watchdog di OB100**: su una CPU vera il tempo di OB100 non è limitato dal tempo di ciclo massimo; il simulatore applica comunque `maxCycleMs` (e il limite di istruzioni) anche a OB100.
- **`stop()`**: voce `STOP_RICHIESTO` (con il motivo) e STOP. In STOP le uscite della periferia (`physOut`) sono azzerate.
- **Errore** durante OB100 o un ciclo: se ha un OB (OB121, OB122, OB80, OB85, §11) e quell'OB è caricato, viene richiamato; altrimenti voce di diagnostica e STOP. Un errore che non è un `SimError` (un difetto del simulatore) dà la voce `MC7_NON_ESEGUIBILE` con dettaglio «errore interno» e viene anche rilanciato.
- **`memoryReset()`** (cancellazione totale, solo in STOP, altrimenti errore): azzera I, Q, M, `physOut`, T e C e torna ai **valori iniziali** dei DB; **⚠️** azzera anche le statistiche del ciclo. I blocchi restano caricati (R5: le CPU con MMC ricaricano il programma dalla scheda). **⚠️** I valori iniziali di un DB sono la sezione MC7 del file caricato, non quella letta dalle sezioni SSB.
- **Buffer di diagnostica**: massimo **100** voci (le più vecchie si perdono, ⚠️ valore tipico). Sono emessi eventi `mode`, `diagnostic` e `cycle`; un ascoltatore che lancia un'eccezione viene ignorato.

## 7. Codici d'errore

Errori di programmazione: portano in STOP con una voce che contiene codice, blocco, offset MC7 e rete (da 1).

| codice                    | significato                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `AREA_LUNGHEZZA`          | accesso fuori area o fuori dalla finestra L del blocco                        |
| `DB_NON_CARICATO`         | DB o DB di istanza assente                                                    |
| `DB_NON_APERTO`           | accesso a DB/DI con il registro a 0                                           |
| `BLOCCO_NON_CARICATO`     | blocco chiamato assente                                                       |
| `STACK_BLOCCHI_PIENO`     | oltre 16 blocchi annidati                                                     |
| `STACK_ANNIDAMENTO_PIENO` | troppe parentesi aperte                                                       |
| `STACK_L_PIENO`           | dati locali richiesti oltre lo stack L                                        |
| `ISTRUZIONE_NON_S7300`    | `ENT`, `LEAVE`                                                                |
| `MC7_NON_ESEGUIBILE`      | byte non decodificabili, salto non valido, `)` non bilanciata, errore interno |
| `BCD_NON_VALIDO`          | cifra BCD maggiore di 9                                                       |
| `TEMPO_CICLO_SUPERATO`    | oltre `maxCycleMs`                                                            |
| `NUMERO_TEMPORIZZATORE`   | numero di T fuori dal campo della CPU                                         |
| `NUMERO_CONTATORE`        | numero di C fuori dal campo della CPU                                         |
| `OB_NON_CARICATO`         | un OB d'evento (OB82, OB86) manca e manca anche OB85                          |

Altre voci del buffer: `AVVIO`, `STOP_RICHIESTO`, `CANCELLAZIONE_TOTALE`, `OB_RICHIAMATO` (§11), `SFC_NON_SIMULATA`, `SFB_NON_SIMULATA` (§13).

## 8. Collegamento al server S7

`connectToSim` collega un `S7WriteClient` alla CPU simulata attraverso `CpuBackend` (stesso protocollo del PLC). Scrittura, lettura di aree, carica nel dispositivo, STOP/RUN e SZL funzionano come sul finto PLC.

- ⚠️ Il download di un **SDB** è rifiutato (le configurazioni di sistema non sono simulate).
- ⚠️ I blocchi caricati **non** tramite il backend (messi direttamente in `cpu.program`) compaiono nell'elenco ma non hanno upload né informazioni di blocco.
- ⚠️ Gli identificatori degli eventi del buffer di diagnostica nelle SZL sono quelli del manuale dove esistono (§11.6); gli altri sono sintetici (da `0x9000`).
- ⚠️ Una sezione ADD corrotta non fa rifiutare il download (il lettore MC7 è tollerante); un tipo che il simulatore non sa caricare (per esempio SFC) viene rifiutato dalla CPU.
- Area `P`: lettura da `physIn`, scrittura in `physOut`; una scrittura in I è sovrascritta all'inizio del ciclo successivo.

## 9. Verifica

La batteria `packages/sim/test/battery/` contiene 25 programmi AWL scritti a mano (dal 18 al 25 sono del piano 2B: temporizzatori, contatori, OB di errore e di schedulazione, SFC, SFB), con i valori attesi ricavati dagli esempi del manuale pubblico; il test di copertura richiede che ogni istruzione (tranne `CALL`, che nell'MC7 non esiste) sia eseguita da almeno un programma. Il runner della batteria sa far girare più cicli con un passo di orologio fissato (`cicli`, `passo`) e impostare o controllare valori in un ciclo preciso.

## 10. Temporizzatori S5

Fonte: manuale AWL S7-300/400, operazioni di temporizzazione. Il numero del T viene da `limits.timers` del catalogo (256 se la CPU è sconosciuta); un numero fuori campo dà `NUMERO_TEMPORIZZATORE` (OB121 con SW_FLT 16#26, §11).

- **Istruzioni**: `SP` (impulso), `SE` (impulso esteso), `SD` (ritardo all'inserzione), `SS` (ritardo all'inserzione con memoria), `SF` (ritardo alla disinserzione), `FR` (riabilitazione), `R`, `L T n` (valore binario), `LC T n` (BCD con la base nei bit 12–13), `A/AN/O/ON/X/XN T n` (bit di stato). Il numero può essere diretto (`T 5`), indiretto (`T [MW 10]`) o un parametro formale di tipo TIMER.
- **Valore**: ACCU1-L in formato S5TIME (base 10 ms, 100 ms, 1 s, 10 s; tre cifre BCD, 0–999). Il tempo si calcola **alla lettura** dall'orologio iniettato e dall'istante di avvio (nessun orologio interno decrementa i T): il valore residuo è lo stesso a ogni lettura ed è deterministico. `S5T#2S` compila con la base minima (regola in `docs/protocollo/mc7.md`).
- **Partenza**: SP, SE, SD, SS e SF partono sul **fronte** dell'RLO (SF sul fronte di discesa), con una memoria del fronte per ogni temporizzatore. `FR` cancella la memoria sul fronte di salita del proprio RLO, così l'avvio successivo con RLO già a 1 vale come un nuovo fronte. `R` con RLO = 1 ferma il T e azzera valore, base e preset (`LC T` dopo `R` dà 0).
- **Uscita Q**: SP, SE e SF a 1 durante il tempo e poi a 0; SD e SS a 0 durante il tempo e poi a 1. SD con RLO = 0 dopo la scadenza riporta Q a 0; SS tiene Q = 1 fino a `R`.
- **Parola di stato** per avvio, `R` e `FR`: /FC = 0, OR = 0, STA = RLO, RLO invariato (come `S` e `R` su un bit, §4.1).
- **Avvio a caldo e MRES**: i T non ritentivi tornano a riposo (`retentivity.timers` del catalogo dà il primo T ritentivo); la cancellazione totale li azzera tutti.

**⚠️ Scelte non coperte dal manuale**

- I T corrono in **STOP** (nessun congelamento): l'orologio è lo stesso che usa il ciclo e un T ritentivo prosegue.
- MCR non influisce sulle operazioni dei T (il manuale non le include fra quelle soggette a MCR).
- SS: un riavvio con Q già a 1 lascia Q a 1 fino a `R`. SF con RLO = 1 subito dopo `R` dà Q = 1.
- Valore residuo da fermo (SP o SD interrotti): resta quello al momento dello stop.
- `FR` non ha effetto con RLO = 0.
- Parametro formale TIMER: il simulatore legge il numero dalla voce grezza della lista dei puntatori (`[n >> 8, n & 255, 0, 0]`); il formato è confermato da un solo esempio.
- Lettura esterna di T dal server S7 (`CpuBackend`): parola `LC` (BCD con base) big-endian, 2 byte per T; il formato sul filo non è verificato. Le scritture sulle aree T restano rifiutate.

## 11. Contatori S5, eventi e OB

### 11.1 Contatori

Fonte: manuale AWL S7-300/400, operazioni di conteggio. Numero da `limits.counters` del catalogo (256 se la CPU è sconosciuta); fuori campo: `NUMERO_CONTATORE` (SW_FLT 16#27).

- `CU` e `CD` contano **sul fronte di salita** dell'RLO, con memorie del fronte distinte per CU, CD e `S`; il valore resta fra 0 e 999.
- `S` carica sul fronte di salita le tre cifre BCD (bit 0–11) di ACCU1-L; una cifra oltre 9 dà `BCD_NON_VALIDO`. `R` con RLO = 1 azzera. `FR` sul fronte di salita dell'RLO cancella le memorie dei fronti.
- `L C n` dà il valore binario, `LC C n` il BCD; `A/O/X C n` leggono il bit di stato (**valore ≠ 0**).
- Parola di stato come per i temporizzatori (§10). Avvio a caldo e MRES: come per i T, con `retentivity.counters`.
- Lettura esterna di C dal server S7: parola BCD big-endian a 2 byte; ⚠️ formato sul filo non verificato.

### 11.2 Eventi e OB

La CPU conosce questi OB (la S7-300 ha un solo OB ciclico, OB35, e nessun allarme di processo simulato). L'OB mancante si comporta come indicato.

| evento                                       | OB    | classe                       | OB mancante                                 |
| -------------------------------------------- | ----- | ---------------------------- | ------------------------------------------- |
| ciclo libero                                 | OB1   | 1                            | il ciclo gira a vuoto                       |
| allarme ciclico (intervallo della CPU)       | OB35  | 12                           | nessun effetto (nessun OB85, ⚠️)            |
| avvio a caldo                                | OB100 | 27                           | nessun effetto                              |
| tempo di ciclo superato, OB35 ancora attivo  | OB80  | 26                           | STOP (`TEMPO_CICLO_SUPERATO`, 16#3501/3502) |
| allarme di diagnostica (da `raiseInterrupt`) | OB82  | 26                           | OB85 (⚠️); se manca anche OB85, STOP        |
| guasto di una stazione (da `raiseInterrupt`) | OB86  | 26                           | OB85 (⚠️); se manca anche OB85, STOP        |
| OB d'evento non caricato                     | OB85  | 26                           | STOP (`OB_NON_CARICATO`, id 16#35A1)        |
| errore di programmazione                     | OB121 | quella del blocco interrotto | STOP (id 16#25xx)                           |
| errore di accesso alla periferia             | OB122 | quella del blocco interrotto | STOP (id 16#29xx)                           |

Fonte: manuale delle funzioni di sistema e standard S7-300/400, descrizione degli OB e dei loro dati di avvio.

### 11.3 Classi di priorità e pile L

- Priorità: OB1 = 1, OB35 = 12, OB80/82/85/86 = 26, OB100 = 27. OB121 e OB122 girano alla priorità del blocco interrotto.
- **Una pila L per classe di priorità** (`localDataBytesPerClass` byte ciascuna, create alla prima necessità): un OB che interrompe un altro non sporca i dati locali dell'interrotto. Ogni OB riceve registri nuovi (accumulatori, AR, DB, DI, RLO, STW): i registri dell'OB interrotto sono intatti al ritorno.
- Un OB interrompe solo se la sua priorità supera quella in esecuzione. Una classe non è rientrante: l'OB35 che dura più dell'intervallo non viene riavviato (vedi OB80, 16#3502). ⚠️ Eccezioni: OB80 può annidarsi in un OB della classe 26 (OB82/OB86) e OB121/OB122 girano alla priorità del blocco interrotto, quindi possono ripresentarsi fra classi diverse.
- Gli allarmi non girano in STARTUP; con la CPU in STOP `raiseInterrupt` non fa niente e svuota la coda.

### 11.4 OB121 e OB122: ripresa

- Un errore di programmazione (`AREA_LUNGHEZZA`, `DB_NON_CARICATO`, `BCD_NON_VALIDO`, numero di T/C, blocco non caricato) richiama OB121, se caricato, **alla priorità del blocco interrotto**, nella stessa pila L, subito sopra la finestra del blocco in errore. Al ritorno dell'OB121 i registri sono ripristinati e il blocco **riprende dall'istruzione successiva** a quella che ha fallito. Una scrittura fallita non scrive niente.
- OB122 si richiama per un accesso a PI o PQ fuori dal campo di I/O della CPU, con la stessa ripresa.
- Se OB121/OB122 non è caricato, oppure l'errore non ha un OB (stack pieni, MC7 non eseguibile, `ISTRUZIONE_NON_S7300`), la CPU va in STOP. Un errore dentro un OB121/OB122 porta in STOP e non lo richiama di nuovo; la profondità dei blocchi dell'OB121 riparte da 0 ⚠️ (non si somma a quella del blocco interrotto).
- Codici SW_FLT dei dati di avvio: 16#21 BCD; 16#22/16#23 lettura/scrittura fuori area; 16#26 T; 16#27 C; 16#3A DB non caricato; 16#3C/3D/3E/3F FC/SFC/FB/SFB non caricati; OB122: 16#42/16#43 lettura/scrittura della periferia. FLT_REG riporta il numero del DB, del T, del C o del blocco; BLK_TYPE (16#88 OB, 16#8A DB, 16#8C FC, 16#8E FB), BLK_NUM e PRG_ADDR (offset MC7) indicano l'istruzione. ⚠️ **DB_NON_APERTO** (DB/DI con registro a 0) è trattato come errore di area (16#22/16#23). ⚠️ Per OB122 la codifica di MEM_AREA (tipo d'accesso nei bit 4–7, area 0 = periferia) e di MEM_ADDR è dedotta dal catalogo dei dati di avvio.

### 11.5 OB80: tempo

- Il tempo di ciclo si controlla ai tick (ogni 1024 istruzioni), al superamento del limite di istruzioni e a fine ciclo. Il **primo** superamento in un ciclo richiama OB80 (FLT_ID 16#01, ERROR_INFO = ms, ERR_EV_CLASS/NUM dell'OB interrotto: 16#1103 per OB1, 16#1136 per OB35), azzera il cane da guardia e il contatore d'istruzioni e il ciclo prosegue.
- Un **secondo** superamento nello stesso ciclo, un superamento con OB80 mancante o già in esecuzione, o in STARTUP, porta in STOP (`TEMPO_CICLO_SUPERATO`, id 16#3501). ⚠️ In STARTUP (OB100) OB80 non è richiamato.
- ⚠️ Se il superamento avviene dentro un OB82 o OB86 (stessa classe 26), OB80 viene annidato nella stessa classe; una CPU vera lo metterebbe in coda.
- **OB35 troppo lento**: se l'allarme ciclico scade mentre OB35 è ancora in esecuzione, viene richiamato OB80 con FLT_ID 16#02 (id 16#3502, ERR_EV 16#1136, priorità 12, OB 35, ERROR_INFO = 0); senza OB80, STOP.

### 11.6 OB35: griglia e granularità

- Intervallo: `cyclicInterruptMs` delle proprietà della CPU; 0 disattiva OB35. Le scadenze stanno su una **griglia fissa** a partire dall'ingresso in RUN (t0 + n · intervallo).
- **Granularità**: OB35 si controlla all'inizio del ciclo e ad **ogni tick** (1024 istruzioni), non a ogni istruzione: la latenza è al più di 1024 istruzioni. ⚠️
- ⚠️ Se per un tratto lungo senza tick la CPU salta intere scadenze, quelle perse sono **saltate in silenzio** (nessun evento, nessun OB80 oltre al caso del 16#3502). ⚠️ OB35 mancante: nessun OB85.
- Non gira in STARTUP; gira anche senza OB1. Può interrompere un OB1 a metà e anche un FC chiamato da OB1 (registri e pila L dell'interrotto restano intatti). OB35 non è registrato come `OB_RICHIAMATO` nel buffer (⚠️: una CPU vera non registra l'avvio degli OB ciclici).

### 11.7 OB82, OB86 e OB85

- ⚠️ Non esiste ancora una configurazione hardware (tappa 6): OB82 e OB86 si generano **solo** da `cpu.raiseInterrupt({ ob, address, coming })` (il pannello I/O del piano 2C li offre come «simula guasto»). L'evento entra in coda e viene servito al primo tick o all'inizio del ciclo in RUN, se la priorità in corso è sotto 26.
- OB82 (allarme di diagnostica): dati di avvio con evento entrante 16#39 / uscente 16#38, FLT_ID 16#42, MDL_ADDR = indirizzo, IO_FLAG 16#54 (ingresso), solo MDL_DEFECT valorizzato.
- OB86 (guasto di stazione DP): evento 16#39C4 / 16#38C4, FLT_ID 16#C4, RACKS_FLTD a 0.
- ⚠️ **OB82 o OB86 mancante**: il manuale è ambiguo; la CPU richiama **OB85** (FLT_ID 16#A1, classe e numero dell'evento richiesto, priorità 26, numero dell'OB mancante) e, se manca anche OB85, va in STOP con `OB_NON_CARICATO` (id 16#35A1).

### 11.8 Dati di avvio e id diagnostici

I dati di avvio hanno 20 byte nella forma dei cataloghi OB: byte 0 classe, 1 codice evento/FLT_ID/SW_FLT, 2 priorità, 3 numero dell'OB, 4–5 BLK_TYPE e flag, 6–11 parametri dell'evento, 12–19 data e ora BCD (orologio della CPU). ⚠️ I valori che il manuale non dà esplicitamente (STRT_INF 16#36 di OB35, IO_FLAG di OB82, FLT_ID 16#C4 di OB86, RACKS_FLTD, MEM_AREA) vengono dalla memoria dei manuali e non sono confrontati con una CPU.

Ogni OB richiamato per OB80/82/85/86/121/122 scrive la voce `OB_RICHIAMATO` nel buffer di diagnostica (per OB121/122 con blocco, offset e rete); OB1, OB35 e OB100 non la scrivono.

Id degli eventi nel buffer e nelle SZL (R6): dal manuale quando esiste — 16#25xx per OB121 (xx = SW_FLT), 16#29xx per OB122, 16#3501 tempo di ciclo, 16#3502 OB ancora in corso, 16#35A1 OB non caricato, 16#3942/16#3842 OB82 entrante/uscente, 16#39C4/16#38C4 OB86. ⚠️ Per gli altri (`AVVIO`, `STOP_RICHIESTO`, `CANCELLAZIONE_TOTALE`, stack pieni, `MC7_NON_ESEGUIBILE`, `ISTRUZIONE_NON_S7300`, `OB_RICHIAMATO` generico, `SFC_NON_SIMULATA`, `SFB_NON_SIMULATA`) gli id restano **sintetici** (da 16#9000, in ordine stabile).

## 12. SFC

Fonte: manuale delle funzioni di sistema e standard S7-300/400, descrizione delle singole SFC. I parametri sono quelli del catalogo; la lista dei puntatori è risolta nel blocco chiamante (§3). Un parametro `ANY` che indica una periferia (`P`) o un'area fuori campo dà un codice 16#8xyy in RET_VAL. Anche un parametro scalare (`WORD`, `BOOL`, DATE_AND_TIME, strutture) fuori area o in un DB non caricato né aperto dà un codice generale (16#8x22 in lettura, 16#8x23 in scrittura, 16#8x3A) con BR = 0, senza errore di programmazione. **Nessuna scrittura parziale**: tutte le uscite (aree ANY, SSL_HEADER, DB_LENGTH, WRITE_PROT, BUSY compresa) vengono risolte prima di scrivere; l'unica scrittura che può fallire dopo le altre è quella di RET_VAL stessa (per ultima), che è un errore di programmazione (OB121 o STOP) e lascia le uscite già scritte. RET_VAL è di tipo INT e imposta **BR = 1 se ≥ 0** (errore: BR = 0), eccetto SFC 64 (TIME), che imposta BR = 1.

Codici generali ⚠️: 16#8x22 area d'origine fuori campo (lettura), 16#8x23 destinazione fuori campo (scrittura), 16#8x24 ANY non valido (sintassi, tipo, area), 16#8x28/16#8x29 allineamento, 16#8x3A DB inesistente o numero 0. Qui `x` è il numero del parametro contato **da 1 in ordine IN, OUT, IN_OUT, escluso RET_VAL**. Tutti questi codici vanno verificati su una CPU vera.

| SFC | nome     | semantica simulata                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | SET_CLK  | Imposta l'orologio di sistema (scarto sull'orologio iniettato) da PDT (DATE_AND_TIME). Anni 90–99 = 19xx, 00–89 = 20xx; ora locale; il giorno della settimana è ignorato. Data non valida: 16#8080 ⚠️. Il byte del merker di clock segue l'orologio di sistema della CPU, non la data e l'ora impostate da SET_CLK.                                                                                                         |
| 1   | READ_CLK | Scrive in CDT l'ora corrente in BCD (8 byte), RET_VAL 0.                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | RD_SINFO | TOP_SI = primi 12 byte dei dati di avvio dell'OB in corso (anche OB121, OB35…), START_UP_SI = quelli dell'ultimo avvio a caldo (OB100), anche senza OB100 caricato. Entrambe le uscite si convalidano prima di scrivere ⚠️.                                                                                                                                                                                                 |
| 13  | DPNRM_DG | Nessuno slave DP: REQ = 0 → RET_VAL 16#7000 (BR = 1), REQ = 1 → 16#8090; BUSY = 0, RECORD intatto ⚠️.                                                                                                                                                                                                                                                                                                                       |
| 14  | DPRD_DAT | Nessuno slave DP: RET_VAL 16#8090 (nessun modulo all'indirizzo LADDR), RECORD intatto ⚠️.                                                                                                                                                                                                                                                                                                                                   |
| 15  | DPWR_DAT | Come SFC 14: RET_VAL 16#8090 ⚠️.                                                                                                                                                                                                                                                                                                                                                                                            |
| 20  | BLKMOV   | Copia SRCBLK in DSTBLK. Lunghezze diverse: si copia la minore. Aree sovrapposte (stesso blocco, stesso DB): RET_VAL 16#8091, nessuna copia ⚠️ (codice possibilmente inventato). BOOL solo in multipli di 8 allineati al byte (altrimenti 16#8x28).                                                                                                                                                                          |
| 21  | FILL     | Ripete BVAL in BLK; l'ultima copia è troncata se la lunghezza non è un multiplo ⚠️. Stessa regola di sovrapposizione (16#8091 ⚠️).                                                                                                                                                                                                                                                                                          |
| 22  | CREAT_DB | Crea un DB di COUNT byte nel primo numero libero fra LOW_LIMIT e UP_LIMIT; scrive DB_NUMBER (prima del DB, nessun DB orfano). Limiti errati 16#80A1; COUNT nullo, dispari o oltre 65534: 16#80B1; nessun numero libero: 16#80B2 ⚠️. Il numero massimo viene da `limits.maxDb`.                                                                                                                                              |
| 23  | DEL_DB   | Cancella il DB. Numero fuori campo 16#80A1; DB inesistente 16#80B1 ⚠️. ⚠️ Nessun controllo sul DB aperto nei registri o richiamato: il DB sparisce subito.                                                                                                                                                                                                                                                                  |
| 24  | TEST_DB  | DB_LENGTH = byte del DB; WRITE_PROT = 0 (la CPU simulata non ha DB protetti). Stessi codici di errore di SFC 23 ⚠️.                                                                                                                                                                                                                                                                                                         |
| 41  | DIS_AIRT | Ritarda gli allarmi (OB35, OB82, OB86) fino a SFC 42 o alla fine dell'OB che l'ha chiamata; gli allarmi scaduti aspettano e girano dopo (al tick o all'inizio del ciclo seguente), non si perdono. RET_VAL = ritardi attivi dopo la chiamata ⚠️. L'OB80 per il tempo di ciclo non viene ritardato ⚠️.                                                                                                                       |
| 42  | EN_AIRT  | Toglie un ritardo di SFC 41 dell'OB in corso; RET_VAL = ritardi rimasti, 16#8080 se non ce n'erano ⚠️.                                                                                                                                                                                                                                                                                                                      |
| 43  | RE_TRIGR | Riavvia il controllo del tempo di ciclo (il tempo massimo riparte da adesso).                                                                                                                                                                                                                                                                                                                                               |
| 46  | STP      | Porta la CPU in STOP (voce `STOP_RICHIESTO` con motivo «SFC 46 STP») interrompendo il ciclo; anche da OB100.                                                                                                                                                                                                                                                                                                                |
| 47  | WAIT     | Attende WT µs **senza attesa reale**: il tempo si somma all'orologio di sistema (quindi anche a T, tempo di ciclo e clock). WT negativo conta 0 ⚠️.                                                                                                                                                                                                                                                                         |
| 51  | RDSYSST  | Sincrona (BUSY = 0 subito; se un'uscita non è scrivibile non si scrive niente, BUSY compresa). REQ = 0: niente, RET_VAL 0 ⚠️. Le liste SZL sono quelle del server S7 della stessa CPU (`buildSzl`): stessi byte di un PG. SSL_HEADER = LENGTHDR + N_DR in 4 byte. DR troppo corto: si copiano solo record interi, N_DR = quelli copiati, RET_VAL 16#0081 (BR = 1); SZL-ID sconosciuto 16#8082; indice sbagliato 16#8083 ⚠️. |
| 64  | TIME_TCK | Restituisce i ms dal **primo RUN** della CPU simulata (non dall'accensione), modulo 2^31 ⚠️.                                                                                                                                                                                                                                                                                                                                |

- Il modo di SZL 0x0424 porta l'ora del cambio di modo del backend creato internamente: può differire di qualche ms da quella di un `simBackend` creato altrove.
- Il compilatore MC7 non sa passare DATE_AND_TIME, SSL_HEADER e le strutture di RD_SINFO a SFC 0, 1, 6 e 51 da AWL (tipi complessi): nei test le liste di puntatori sono scritte a mano.
- Il manuale citato per i codici è indicativo («manuale delle funzioni di sistema e standard S7-300/400, SFC 20»); dove non si è potuto verificare il numero esatto il codice è segnato ⚠️.

## 13. SFB 0–5 IEC e avviso «non simulata»

### 13.1 SFB 0–5

Fonte: manuale delle funzioni di sistema e standard S7-300/400, SFB di conteggio (CTU, CTD, CTUD) e temporizzazione IEC (TP, TON, TOF). I parametri stanno nel DB di istanza aperto in DI all'offset AR2 (multi-istanza); la disposizione è quella che il compilatore genera (ordine IN, OUT, come `layoutInstance`).

| SFB | nome | semantica simulata                                                                                                                                 |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | CTU  | Su fronte di salita di CU, CV +1 (saturazione a 32767); R azzera; Q = CV ≥ PV.                                                                     |
| 1   | CTD  | Su fronte di salita di CD, CV −1 (saturazione a −32768); LOAD carica PV; Q = CV ≤ 0.                                                               |
| 2   | CTUD | CU e CD sui fronti; due fronti nella stessa chiamata si annullano; R prevale su LOAD; QU = CV ≥ PV, QD = CV ≤ 0.                                   |
| 3   | TP   | Impulso Q = 1 di durata PT sul fronte di salita di IN, non riavviabile; ET sale fino a PT e resta a PT finché IN = 1.                              |
| 4   | TON  | Q = 1 dopo PT con IN = 1; ET sale fino a PT; IN = 0 azzera Q ed ET. Tempo modulo 2^31 ms; raggiunto PT, Q e ET restano senza rileggere l'orologio. |
| 5   | TOF  | Q = 1 con IN = 1; sul fronte di discesa Q resta 1 per PT, poi 0; ET resta a PT fino al nuovo IN = 1.                                               |

Il tempo viene dall'orologio della CPU (lo stesso di TIME_TCK).

**⚠️ Scelte non coperte dal manuale**

- **Lo stato interno** (memorie dei fronti, istanti di avvio, fasi) sta **nella CPU, non nel DB di istanza**, indicizzato da (DI, offset AR2): il manuale non documenta gli statici di questi SFB. Si azzera con STOP→RUN e con la cancellazione totale, **non** con il download di un DB.
- **TP**: un fronte di IN esattamente alla fine dell'impulso viene assorbito (dipende da quando l'SFB viene chiamato).
- **Istanza corta** (un parametro fuori dal DB di istanza): errore di programmazione prima di toccare stato e uscite, quindi nessuna uscita scritta e nessun fronte perso.
- **PT cambiato** durante il conteggio: vale il PT corrente. **PT negativo** vale 0.
- Le uscite (Q, ET, CV, QU, QD) cambiano **solo quando l'SFB viene chiamato**: non c'è un tempo di fondo.
- CTUD: CV si rilegge dal DB di istanza a ogni chiamata, non da uno stato interno.

### 13.2 SFC e SFB «non simulati»

Una SFC o un SFB senza gestore (cioè **tutte** quelle diverse da SFC 0, 1, 6, 13, 14, 15, 20, 21, 22, 23, 24, 41, 42, 43, 46, 47, 51, 64 e SFB 0–5) è un **avviso, non un errore** (R5): la chiamata non scrive alcuna uscita, imposta **BR = 0** e la CPU prosegue. L'avviso consiste in una voce nel buffer di diagnostica (`SFC_NON_SIMULATA` o `SFB_NON_SIMULATA`, con numero e nome del blocco) e in un evento `{ type: 'warning' }`; è emesso **una volta per numero e per periodo di RUN**. Una SFC o un SFB che non esiste nemmeno nel catalogo dà invece `BLOCCO_NON_CARICATO` (OB121 con SW_FLT 16#3D o 16#3F).

## 14. Ospite nell'app (piano 2C)

Nell'app la CPU simulata gira in un **Web Worker** del renderer (`packages/ui/src/sim/`), non in un processo separato: il simulatore è TypeScript puro e il Worker non blocca l'interfaccia. `SimHost` (puro, testabile senza Worker) è l'unico che tocca `SimCpu`; `SimController` nel renderer lo pilota per messaggi.

- **Richieste** (renderer → Worker, `SimRequest`): `start`, `download` (blocchi nell'ordine di caricamento; con `keep`, l'elenco dei blocchi del progetto, l'ospite cancella dalla CPU quelli che non vi compaiono, DB compresi), `mode` (RUN/STOP), `mres`, `setInputs` (byte degli ingressi fisici), `interrupt` (OB82/OB86 con indirizzo logico del modulo, 0..65535), `monitor` (blocco da osservare, o nessuno), `watch` (operandi già risolti dal renderer), `write` (comanda), `stop`. Ogni richiesta ha un `id` e una risposta. L'ospite non si fida del renderer: `interrupt` con un OB diverso da 82 e 86, e `watch` o `write` con una voce di dimensione diversa da X, B, W, D, sono rifiutate con un errore (risposta `ok: false`) e non cambiano nulla.
- **Notifiche** (Worker → renderer, `SimNotice`): `status` (modo, tempi di ciclo, buffer di diagnostica, avvisi, ingressi e uscite fisiche) circa ogni 200 ms; `monitor` con i passi registrati; `watch` con i valori grezzi richiesti; `error`.
- **Osservazione.** La tabella delle righe viene dal compilatore (ogni istruzione MC7 ha la riga AWL che l'ha prodotta, anche per le CALL espanse). Per il blocco osservato la CPU registra, per ogni istruzione, RLO, STA, ACCU1, ACCU2 e parola di stato. ⚠️ Si registra solo la **prima esecuzione** di ogni istruzione nel ciclo. Un blocco modificato dopo il caricamento o importato senza tabella non si osserva.
- **Ingressi.** Il pannello I/O scrive negli ingressi fisici (`physIn`), come farebbe il campo; non forza.
- **Tabelle di controllo.** Il renderer risolve simboli e indirizzi (stessa risoluzione del compilatore) in area, DB, byte, bit e dimensione; il Worker restituisce byte grezzi big-endian e il renderer li formatta. T e C si leggono come parola BCD; `write` risponde con un esito per voce, `{ ok: true }` o `{ error }`: per T e C l'errore è «scrittura non supportata» (`TC_WRITE` è la chiave con cui il renderer lo mostra). Per PQ la scrittura si riflette anche in Q, come per l'accesso diretto. Al più 1000 voci per richiesta.
- La CPU del Worker non avanza il tempo come una CPU vera (§5): i tempi di ciclo mostrati dipendono dal computer.
