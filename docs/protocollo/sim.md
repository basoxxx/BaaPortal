# CPU S7-300 simulata — riferimento BaaPortal (piano 2A)

Questo documento descrive la CPU simulata del pacchetto `@baaportal/sim` (piano 2A): modello di memoria, registri, parola di stato, regole di richiamo dei blocchi, ciclo, avvio, cancellazione totale e codici d'errore. Le scelte che il manuale pubblico non copre sono marcate **⚠️**; le raccoglie anche `docs/limiti-noti.md` (sezione «Simulatore (piano 2A)»).

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
| T      | temporizzatori S5 (numero da `limits.timers` del catalogo): SP, SE, SD, SS, SF, FR, R, L, LC, A/O/X             |
| C      | riservata (2048 elementi a 16 bit); le istruzioni arrivano con il piano 2B                                      |

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
- **Parametri**: la lista dei puntatori che segue la chiamata viene risolta nel blocco **chiamante**; `L` e `V` nella lista indicano i dati locali del blocco che contiene la chiamata. Il parametro formale `#PAR` si risolve nel chiamato. La dimensione viene dal tipo (Bool, Byte, Word, DWord); Timer, Counter e Block_* danno `NON_SIMULATA_2B`.
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

Istruzioni rimandate al piano 2B (errore `NON_SIMULATA_2B`, mai ignorate): `SP SE SD SS SF FR LC CU CD`, i parametri formali Timer/Counter/Block_*, le chiamate di SFC e SFB e gli operandi T e C.

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
4. controlla il tempo di ciclo; se è superato, `TEMPO_CICLO_SUPERATO` e STOP;
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
- **Qualsiasi errore** durante OB100 o un ciclo: voce di diagnostica e STOP (R4; OB121/OB122/OB80/OB85 arrivano con il 2B). Un errore che non è un `SimError` (un difetto del simulatore) dà la voce `MC7_NON_ESEGUIBILE` con dettaglio «errore interno» e viene anche rilanciato.
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
| `NON_SIMULATA_2B`         | temporizzatori, contatori, SFC/SFB e T/C come operando: piano 2B              |

Altre voci del buffer: `AVVIO`, `STOP_RICHIESTO`, `CANCELLAZIONE_TOTALE`.

## 8. Collegamento al server S7

`connectToSim` collega un `S7WriteClient` alla CPU simulata attraverso `CpuBackend` (stesso protocollo del PLC). Scrittura, lettura di aree, carica nel dispositivo, STOP/RUN e SZL funzionano come sul finto PLC.

- ⚠️ Il download di un **SDB** è rifiutato (le configurazioni di sistema non sono simulate).
- ⚠️ I blocchi caricati **non** tramite il backend (messi direttamente in `cpu.program`) compaiono nell'elenco ma non hanno upload né informazioni di blocco.
- ⚠️ Gli identificatori degli eventi del buffer di diagnostica nelle SZL sono sintetici (da `0x9000`), non quelli Siemens.
- ⚠️ Una sezione ADD corrotta non fa rifiutare il download (il lettore MC7 è tollerante); un tipo che il simulatore non sa caricare (per esempio SFC) viene rifiutato dalla CPU.
- Area `P`: lettura da `physIn`, scrittura in `physOut`; una scrittura in I è sovrascritta all'inizio del ciclo successivo.

## 9. Verifica

La batteria `packages/sim/test/battery/` contiene 17 programmi AWL scritti a mano, con i valori attesi ricavati dagli esempi del manuale pubblico; il test di copertura richiede che ogni istruzione non rimandata al 2B sia eseguita da almeno un programma.
