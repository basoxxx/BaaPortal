# Formato dei blocchi S7-300 e codifica MC7 — riferimento BaaPortal (piano 1E)

Questo documento descrive il **file di blocco** S7-300 (OB, FC, FB, DB; gli SDB solo come
contenitore opaco) e la **codifica MC7** delle istruzioni AWL, come base per il compilatore
offline del piano 1E (AWL → MC7, MC7 → AWL, viaggio di andata e ritorno identico al byte).
Non tratta il download nella CPU né qualsiasi scrittura verso una CPU.

Estende `docs/protocollo/s7comm.md` §13 (che resta valido per il trasporto) e ne corregge
alcune ipotesi con i dati dei blocchi reali (§1).

## 0. Fonti, metodo e convenzioni

### 0.1 Regole clean-room

Tutti i fatti sono riscritti con parole proprie, in tabelle, a partire dalle fonti sotto.
Nessun codice di terzi è copiato. I file di prova di terzi (blocchi `.bin`) sono stati solo
letti, in una cartella temporanea fuori dal repository, e **non vanno mai committati**: se il
1E li vuole nei test, li scarica a tempo di test come le catture (§5.5). Nessuna analisi di
software Siemens.

### 0.2 Fonti (chiavi usate nel testo)

| chiave   | fonte                                                                                                                                                                                                                            | uso                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [CAP]    | catture pubbliche già usate dal 1D (`.cache/s7-captures/`, `packages/s7comm/test/captures/cisagov/`), blocchi estratti con `@baaportal/s7comm` (`readPcap`, `decodeS7`, `parseBlockFile`)                                        | blocchi reali: OB1 (TIA, FUP), 3 DB, 8 SDB                      |
| [DN]     | DotNetSiemensPLCToolBoxLibrary (LGPL-2.1), commit `bbe5bec` (18/10/2026): `PLCs/S7_xxx/MC7/MC7toAWL.cs`, `MC7Converter.cs`, `Parameter.cs`, `CallConverter.cs`, `Helper.cs`, `NetWork.cs`, `AWLtoMC7.cs`; `General/CrcHelper.cs` | tabella opcode (decodificatore), interfaccia, CRC               |
| [DN-doc] | stessa libreria, `LibNoDaveConnectionLibrary/Documentation/MC7 Block Format.txt` (S. Hasensperling)                                                                                                                              | layout header, interfaccia, valori iniziali, footer             |
| [DN-V]   | stessa libreria, `ToolBoxLibUnitTests/S7Blocks/{MC7Converter,Parameter}/*.bin`: 20 blocchi **caricati da CPU reali** (commento del test: "plain dumps obtained via PLCGetBlockInMC7")                                            | verifica su blocchi reali (7 FB, 3 FC, 10 DB)                   |
| [RZ]     | rz-libmc7 (LGPL-3.0), commit `111b189`: `src/simatic.c`, `unit/test_simatic.c` (2522 vettori byte→testo), `example/cm7.bin` (un OB1 reale)                                                                                       | seconda fonte indipendente sugli opcode; un blocco reale        |
| [ST7]    | Stp7Toolbox (MIT), `PlcParser/NDbf Item.cs`: costruisce il blocco online dal progetto STEP 7 offline, "binary identical to files uploaded from the PLC"                                                                          | origine dei campi header/footer, SSB e ADD copiati dal progetto |
| [SNAP7]  | snap7 `s7_types.h` (`TResFunUploadDataHeaderFirst`, `TS7CompactBlockInfo`, `TS7BlockFooter`)                                                                                                                                     | nomi dei campi header/footer                                    |
| [WS]     | dissector Wireshark S7comm (Thomas Wiens), tramite `s7comm.md` §8.4–8.5                                                                                                                                                          | codici tipo, linguaggio, sicurezza                              |
| [MAN]    | manuale Siemens _Statement List (STL) for S7-300 and S7-400 Programming_                                                                                                                                                         | solo semantica e intervalli degli operandi, mai la codifica     |
| [S7C]    | `docs/protocollo/s7comm.md`                                                                                                                                                                                                      | §8.3, §13                                                       |

### 0.3 Metodo di verifica

1. Estrazione di tutti i blocchi reali disponibili (§5): 12 dalle catture, 20 da [DN-V], 1 da [RZ].
2. Un decodificatore prototipo usa e getta (scritto da zero a partire dalle tabelle di §2) è
   stato fatto girare su tutti i 12 blocchi di codice reali: **2011 istruzioni, 0 opcode
   ignoti, 100% dei byte MC7 consumati**; tutti i confini di rete della tabella ADD cadono su
   un inizio di istruzione; tutte le destinazioni di salto cadono su un inizio di istruzione;
   la lista dei salti in ADD coincide con i salti trovati nel codice.
3. Unicità: 901 testi distinti di istruzione mappano ciascuno a **una sola** sequenza di byte;
   nessuna forma lunga è usata dove esiste la forma corta (§3.4).
4. Interfacce: 25 interfacce analizzate fino all'ultimo byte; per 12 DB globali e 1 DB
   d'istanza la dimensione calcolata con le regole di §1.4.8 coincide con la lunghezza dei dati.
5. Checksum: l'algoritmo di §1.7 riproduce il checksum del footer su 23 blocchi reali.
6. I 2522 vettori di [RZ] sono stati confrontati con il prototipo: 2322 uguali, i 200 diversi
   sono analizzati in §2 e §6 (quasi tutti differenze di formato del testo, alcuni veri disaccordi ⚠️).

### 0.4 Etichette di stato

- **reale: X** = verificato su blocco reale X (nome come in §5).
- **solo: F** = solo dalla fonte F, nessun blocco reale lo contiene.
- ⚠️ = fonti in disaccordo, ipotesi, o nulla di verificato.

### 0.5 Convenzioni di notazione

- Nel file di blocco gli interi dell'**header**, del **footer** e del **codice MC7** sono
  **big-endian**. Gli interi della sezione **SSB** (interfaccia, valori iniziali) e della
  sezione **ADD** (tabella reti) sono **little-endian**. ⚠️ È la trappola principale del formato.
- Byte in esadecimale minuscolo. Nei layout: `nn` = 1 byte senza segno; `aaaa` = 2 byte BE
  (indirizzo di byte o numero); `iiii` = 2 byte BE con segno; `dddddddd` = 4 byte BE;
  `oooo` = puntatore corto (16 bit, §2.2.3); `pppppppp` = puntatore d'area (32 bit, §2.2.4);
  `jjjj` = spostamento di salto (16 bit con segno, in parole, §2.4).
- Nelle formule dei byte composti i coefficienti sono **esadecimali**: `z·10` = z × 0x10,
  `N·80` = N × 0x80, `c0 + n` = 0xc0 + n; le cifre `0`…`f` da sole sono nibble.
- `id` = mnemonico internazionale come in `packages/awl/src/instructions.ts`; tra parentesi il
  tedesco quando diverso.

---

## 1. Il file di blocco

### 1.1 Struttura e lunghezze

```
offset 0        36            36+M            36+M+S          36+M+S+A      L
       | header | sezione MC7  | SSB           | ADD           | footer     |
       | 36 B   | M byte       | S byte        | A byte        | 36 B       |
```

- `M` = header[34..35] (lunghezza MC7), `S` = header[28..29] (lunghezza SSB), `A` = header[30..31]
  (lunghezza ADD), `L` = header[8..11] = lunghezza dell'intero file = 36 + M + S + A + 36.
  **reale: tutti i 33 blocchi** (§5). La "lunghezza dati locali" header[32..33] non occupa spazio.
- Il "+6" citato in `s7comm.md` §8.3 non esiste nel file: viene dal progetto offline, dove il
  campo `BLKTOTLEN` vale L + 6 ([ST7]: la lunghezza online è `BLKTOTLEN − 6`).
- Le sezioni SSB e ADD sono copiate così come sono dal progetto offline (record `SSBPART` e
  `ADDINFO`, [ST7]); la CPU non le interpreta per l'esecuzione, ma le restituisce all'upload.

Fonti: [CAP], [DN-V], [DN] `MC7Converter.cs`, [ST7], [SNAP7].

### 1.2 Header (36 byte, big-endian)

| off | dim | campo                               | valori osservati / significato                                                                                                                                                                                                                                                                                                                                           | stato                                     |
| --- | --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 0   | 2   | firma                               | `70 70` ("pp")                                                                                                                                                                                                                                                                                                                                                           | reale: tutti                              |
| 2   | 1   | versione del formato di blocco      | `01` OB/FC/FB/DB; `03` SDB; `00` in FB101 (blocco vecchio). [DN] lo chiama "Block Version"; [ST7] scrive sempre `01` (`03` per SDB)                                                                                                                                                                                                                                      | reale: tutti; significato ⚠️              |
| 3   | 1   | attributi                           | bit0 = collegato (_linked_; acceso in tutti gli OB/FC/FB/DB del corpus, spento negli SDB che hanno `02`); bit1 = blocco standard (`02` negli SDB); bit2 = ⚠️ ignoto (`05` in FB80 e FB3004, due FB con multi-istanze: forse "capacità multi-istanza"); bit3 = know-how-protect secondo [DN] (mai visto acceso); bit5 = DB _non-retain_ (`21` in DB1806); bit6 = blocco F | bit0/bit1/bit5 reale; bit2, bit3, bit6 ⚠️ |
| 4   | 1   | linguaggio                          | `01` AWL, `02` KOP, `03` FUP, `04` SCL, `05` DB, `06` GRAPH, `07` SDB (vedi `s7comm.md` §8.5). Nota: DB121 e DB13 hanno `01`                                                                                                                                                                                                                                             | reale (01, 03, 04, 05, 07)                |
| 5   | 1   | tipo                                | `08` OB, `0a` DB, `0b` SDB, `0c` FC, `0d` SFC, `0e` FB, `0f` SFB                                                                                                                                                                                                                                                                                                         | reale (08, 0a, 0b, 0c, 0e)                |
| 6   | 2   | numero                              | 0…65535                                                                                                                                                                                                                                                                                                                                                                  | reale                                     |
| 8   | 4   | lunghezza in memoria di caricamento | = lunghezza del file (§1.1)                                                                                                                                                                                                                                                                                                                                              | reale                                     |
| 12  | 4   | sicurezza                           | byte 15 = livello di protezione: `00` nessuna, `03` know-how-protect (FB41, FB80). Byte 12 = `80` negli SDB ([ST7] lo scrive fisso). Byte 13–14 = 0                                                                                                                                                                                                                      | reale                                     |
| 16  | 6   | timestamp codice                    | 4 byte ms dalla mezzanotte + 2 byte giorni dal 1984-01-01 (`s7comm.md` §13)                                                                                                                                                                                                                                                                                              | reale                                     |
| 22  | 6   | timestamp interfaccia               | stesso formato; nei DB uguale al timestamp codice                                                                                                                                                                                                                                                                                                                        | reale                                     |
| 28  | 2   | lunghezza SSB (S)                   | interfaccia + valori iniziali + riempimento (§1.4)                                                                                                                                                                                                                                                                                                                       | reale                                     |
| 30  | 2   | lunghezza ADD (A)                   | tabella reti e salti (§1.5); 0 nei DB                                                                                                                                                                                                                                                                                                                                    | reale                                     |
| 32  | 2   | dati locali                         | byte di stack L richiesti dal blocco: TEMP dichiarati **più** i temporanei del compilatore (FC1: 0 TEMP, 6 byte; OB1: 20 TEMP, 26 byte; FC100: 46 TEMP, 58 byte); 0 nei DB                                                                                                                                                                                               | reale; regola di calcolo ⚠️ (§6)          |
| 34  | 2   | lunghezza MC7 (M)                   | codice (OB/FC/FB), dati attuali (DB), contenuto (SDB)                                                                                                                                                                                                                                                                                                                    | reale                                     |

Fonti: [CAP], [DN-V], [DN] `MC7Converter.cs` (commento con il layout), [ST7] `getMC7Header`,
[SNAP7] `TResFunUploadDataHeaderFirst`, [WS].

### 1.3 Sezione MC7

- **OB/FC/FB**: codice MC7 (§2). Termina **sempre** con `65 00` (BE). Nei blocchi AWL/KOP/FUP
  questo BE finale è aggiunto dal compilatore **fuori** dalle reti (la somma delle lunghezze di
  rete è M − 2); nel blocco SCL (FB41) il BE fa parte dell'ultima rete (somma = M). Un blocco
  vuoto ha `M = 2` (solo `65 00`). **reale: tutti i 12 blocchi di codice.**
- **DB**: i **valori attuali**, nel layout di memoria S7 (big-endian, §1.4.8). All'upload sono
  i valori correnti della CPU, non i valori iniziali. **reale: 13 DB.**
- **SDB**: contenuto proprietario, da trattare come opaco (fuori ambito).

### 1.4 Sezione SSB = interfaccia del blocco

Si trova subito dopo il codice: offset 36 + M, lunghezza S. Contiene l'interfaccia (righe di
dichiarazione) e i valori iniziali. È presente in OB, FC, FB e DB; assente (S = 0) negli SDB.

#### 1.4.1 Intestazione (7 byte, little-endian)

| off | dim  | campo                     | valori                                                                                                                                                                                                                                                                     | stato                |
| --- | ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 0   | 1    | genere                    | `01` blocco di codice (OB/FC/FB); `05` DB globale; `0a` DB d'istanza di un FB. [DN-doc] cita anche `10` = "DI" ⚠️ mai visto                                                                                                                                                | reale (01, 05, 0a)   |
| 1   | 2 LE | numero                    | DB globale: numero del DB (DB3001 → `b9 0b`). DB d'istanza: numero dell'FB secondo [DN] ⚠️ (nell'unico campione, DB1806, vale 1806 sia come DB sia come FB). Blocco di codice: il numero del blocco **oppure 0** (0 in OB1, FC21, FB41, FB80) ⚠️ regola ignota: conservare | reale                |
| 3   | 2 LE | lunghezza righe           | byte di righe d'interfaccia che seguono l'intestazione (I)                                                                                                                                                                                                                 | reale: 25 interfacce |
| 5   | 2 LE | lunghezza valori iniziali | byte di valori iniziali dopo le righe (V)                                                                                                                                                                                                                                  | reale                |

Poi: I byte di righe (§1.4.4), V byte di valori iniziali (§1.4.6) e, se 7 + I + V è dispari,
**un byte di riempimento** per rendere S pari (§1.4.7). **reale: S = 7 + I + V + (0 o 1) su tutti.**

#### 1.4.2 Byte di tipo

| codice | tipo        | dimensione in memoria | codice      | tipo                       | dimensione         |
| ------ | ----------- | --------------------- | ----------- | -------------------------- | ------------------ |
| `01`   | BOOL        | 1 bit                 | `0e`        | DATE_AND_TIME              | 8 B                |
| `02`   | BYTE        | 1 B                   | `10`        | ARRAY                      | §1.4.4             |
| `03`   | CHAR        | 1 B                   | `11`        | STRUCT (anche UDT espansi) | §1.4.4             |
| `04`   | WORD        | 2 B                   | `13`        | STRING[n]                  | n + 2 B            |
| `05`   | INT         | 2 B                   | `14`        | POINTER                    | 6 B                |
| `06`   | DWORD       | 4 B                   | `15`        | multi-istanza di FB        | struttura dell'FB  |
| `07`   | DINT        | 4 B                   | `16`        | ANY                        | 10 B               |
| `08`   | REAL        | 4 B                   | `17`        | BLOCK_FB                   | 2 B                |
| `09`   | DATE        | 2 B                   | `18`        | BLOCK_FC                   | 2 B                |
| `0a`   | TIME_OF_DAY | 4 B                   | `19`        | BLOCK_DB                   | 2 B                |
| `0b`   | TIME        | 4 B                   | `1a`        | BLOCK_SDB                  | 2 B                |
| `0c`   | S5TIME      | 2 B                   | `1b`        | multi-istanza di SFB       | struttura dell'SFB |
|        |             |                       | `1c` / `1d` | COUNTER / TIMER            | 2 B                |

Stato: reale per `01 02 04`–`0c 0e 10 11 13 15 16 17`–`1b`; `03` CHAR, `14` POINTER, `1c`, `1d` solo: [DN].
Fonti: [DN] `S7DataRowType`, [DN-doc], [DN-V].

#### 1.4.3 Byte di parametro (`pt`)

| bit      | significato                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–2      | sezione: `1` IN, `2` OUT, `3` IN_OUT, `4` STAT (anche le variabili di un DB), `5` TEMP, `6` RET_VAL                                                                                                           |
| 3 (`08`) | la riga ha un **valore iniziale** in V                                                                                                                                                                        |
| 4 (`10`) | riga **estesa**: dopo `pt` segue 1 byte in più, di significato ignoto ⚠️ (valori come `20`, `43`, `6e`, `02` in FB41 = CONT_C della libreria standard; forse legato agli attributi di sistema). Da conservare |

Valori visti: `01 02 03 04 05 09 0a 0b 0c 11 12 14 15 19` (reale). `06`/`16` (RET_VAL) solo: [DN].

#### 1.4.4 Formati delle righe

| tipo                                              | layout della riga                                                                                                                                                                          | lunghezza                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| elementare, POINTER, ANY, BLOCK_x, TIMER, COUNTER | `tt pt`                                                                                                                                                                                    | 2 (+1 se estesa)         |
| STRING                                            | `13 pt [x] nn` con nn = lunghezza massima                                                                                                                                                  | 3 (+1)                   |
| ARRAY                                             | `10 pt [x] dd` + dd × (`lo` 2 B LE con segno, `hi` 2 B LE con segno), poi **una** riga per il tipo dell'elemento (ricorsiva: elementare, STRING, STRUCT)                                   | 3 + 4·dd (+1) + elemento |
| STRUCT                                            | `11 pt [x] nn` + nn righe figlie; se i figli sono più di 254: `11 pt ff` + conteggio 2 B LE                                                                                                | 3 o 5 (+1) + figli       |
| multi-istanza                                     | `15 nnnn` (FB) o `1b nnnn` (SFB), numero 2 B **LE**, **senza** `pt`; segue una riga `11 04 nn` con l'interfaccia dell'FB chiamato (IN/OUT/IN_OUT/STAT, i `pt` interni indicano la sezione) | 3 + struttura            |

`[x]` è il byte esteso (solo se `pt` ha il bit 4). Esempi reali:

- `10 0c 01 00 00 c7 00 05 04` = ARRAY[0..199] OF INT, con flag valore iniziale sulla riga ARRAY (DB1, `s7comm_downloading_block_db1.pcap`).
- `13 0c fe` = STRING[254] con valore iniziale (DB3003).
- `15 0d 07 11 04 61 …` = multi-istanza di FB1805, seguita dalla sua struttura di 97 righe (DB1806).
- `11 04 03 05 04 05 04 05 04` = STRUCT di 3 INT (FB1001).

Stato: **reale** (25 interfacce lette fino all'ultimo byte senza resti). Fonti: [DN] `Parameter.cs` e [DN-doc], [DN-V], [CAP].

#### 1.4.5 Ordine delle righe per tipo di blocco

| blocco       | contenuto delle righe                                                                                 | esempio reale                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| OB           | le variabili TEMP (`pt 05`)                                                                           | OB1 TIA: 6 BYTE, 3 INT, 1 DT                        |
| FC           | IN, OUT, IN_OUT, TEMP, nell'ordine di dichiarazione; RET_VAL `pt 06` ⚠️ non visto                     | FC21: `18 01 05 01 17 01` (BLOCK_FC, INT, BLOCK_FB) |
| FB           | IN, OUT, IN_OUT, STAT (con multi-istanze), TEMP                                                       | FB1001, FB41, FB80, FB3003, FB3004                  |
| DB globale   | **una sola** riga STRUCT `11 04 nn` (la struttura del DB) con dentro le variabili                     | DB1 ×3, DB3001…DB3005, DB121, DB13, DB4, DB310      |
| DB d'istanza | le righe dell'FB (IN/OUT/IN_OUT/STAT **e anche TEMP**, che non occupano spazio), senza STRUCT esterna | DB1806 (63 righe di primo livello)                  |

Fonti: [DN-V], [CAP], [DN] `Parameter.GetInterface`.

#### 1.4.6 Valori iniziali (V byte dopo le righe)

- Compaiono **solo** per le righe con il bit `08` in `pt`, nell'ordine delle righe, **impacchettati
  senza allineamento** e in **little-endian**:

  | tipo                                 | byte nei valori iniziali                                            |
  | ------------------------------------ | ------------------------------------------------------------------- |
  | BOOL, BYTE, CHAR                     | 1 (BOOL: `01` = TRUE)                                               |
  | WORD, INT, DATE, S5TIME              | 2 LE                                                                |
  | DWORD, DINT, REAL, TIME, TIME_OF_DAY | 4 LE                                                                |
  | DATE_AND_TIME                        | 8 byte BCD **nell'ordine naturale** (non invertiti)                 |
  | STRING                               | lunghezza massima (1), lunghezza attuale k (1), k caratteri (non n) |

  Esempio reale DB3002: `00 00 80 3f` = 1.0, `02 00` = 2. Esempio reale DB3003: `72 33` S5TIME,
  `d3 0f` DATE, `7c 3c 28 05` TIME, `88 d0 38 00` TOD, `99 02 03 01 02 03 40 04` DT,
  `fe 07 31 61 61 66 66 64 64` STRING[254] = '1aaffdd'.

- ⚠️ S5TIME: base più piccola che tiene il valore in tre cifre (stessa funzione di `L S5T#…`, §2.3); verificata solo sui 2 valori di FC1.
- **ARRAY con elementi inizializzati** (flag sull'elemento, non sull'ARRAY): il valore iniziale
  è scritto **una volta sola** per tutto l'array (DB3003: due ARRAY OF STRUCT, 29 byte ciascuno).
- **ARRAY con il flag sulla riga ARRAY** (`10 0c …`): formato non decodificato ⚠️. Osservato
  6 volte: 6 byte fissi `01 00 00 01 01 00` seguiti da un valore dell'elemento in LE
  (ARRAY OF BYTE: 1 byte, `00` o `09`; ARRAY OF INT: `00 00`). Significato dei 6 byte ignoto
  (DB1 di `s7comm_downloading_block_db1.pcap`, 5 array in DB1806). Da conservare grezzo.
- Nei FB i valori iniziali riguardano IN/OUT/IN_OUT/STAT; nel DB d'istanza l'interfaccia porta
  gli stessi valori iniziali dell'FB (DB1806) ⚠️ uguaglianza byte a byte con l'FB non verificata.

Stato: reale (consumo esatto di V su 23 interfacce; eccezioni: le righe ARRAY con flag).
Fonti: [DN] `Parameter.GetVarInitialValue`, [DN-doc] (avvertenza sul little-endian), [DN-V].

#### 1.4.7 Byte di riempimento

Se 7 + I + V è dispari, segue **un** byte che rende S pari. Il suo valore **non è sempre zero** e
non ha regola: osservati `20`, `52`, `0d`, `50`, `00`, `03`, `61`, `6c`, `54` (memoria non
inizializzata del programma che ha scritto il blocco). **reale.** Per l'identità al byte va
conservato; per un blocco nuovo usare `00`.

#### 1.4.8 Regole di layout in memoria (dimensioni e allineamenti)

Verificate calcolando la dimensione dei dati dall'interfaccia e confrontandola con M:
**12 DB globali su 12 e il DB d'istanza DB1806** (10882 byte, con multi-istanze e IN_OUT).

1. BOOL occupa 1 bit; più BOOL consecutivi si impacchettano nello stesso byte.
2. BYTE e CHAR iniziano al prossimo byte intero.
3. Tutti gli altri tipi (WORD, INT, …, DT, STRING, POINTER, ANY, BLOCK_x, TIMER, COUNTER)
   iniziano al prossimo indirizzo **pari**.
4. STRUCT e ARRAY iniziano a indirizzo pari e la loro dimensione è arrotondata a un numero
   pari di byte.
5. ARRAY: elementi BOOL impacchettati a bit, BYTE/CHAR a byte, gli altri ciascuno con la sua
   dimensione arrotondata a pari.
6. STRING[n] occupa n + 2 byte (lunghezza massima, lunghezza attuale, n caratteri).
7. Istanza di FB: sezioni nell'ordine IN, OUT, IN_OUT, STAT; i TEMP non occupano spazio;
   un IN_OUT di tipo complesso (STRUCT, ARRAY, STRING, DT) occupa un puntatore di 6 byte; le
   multi-istanze sono strutture annidate; la dimensione totale si arrotonda a pari.

Fonti: [MAN] (regole di allineamento S7), verificate su [DN-V] e [CAP].

### 1.5 Sezione ADD = tabella delle reti e dei salti (little-endian)

Si trova a offset 36 + M + S, lunghezza A. Solo nei blocchi di codice (A = 0 nei DB).

| campo     | dimensione        | significato                                                                                                       |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| N         | 2 LE              | numero di reti (segmenti, _Netzwerke_)                                                                            |
| lunghezze | N × 2 LE          | lunghezza in byte di ogni rete, nell'ordine; la rete k inizia alla somma delle precedenti                         |
| J         | 2 LE              | numero di istruzioni di salto                                                                                     |
| salti     | J × 2 LE          | offset **in parole** (offset in byte / 2) dell'istruzione di salto nel codice                                     |
| resto     | A − (4 + 2N + 2J) | di norma 0; ⚠️ 12 byte ignoti in FB101 (`00 00 00 00 16 00 00 00 00 00 00 00`), unico blocco con header[2] = `00` |

Fatti verificati (**reale: tutti i 12 blocchi di codice**):

- Le reti coprono il codice escluso il BE finale aggiunto dal compilatore (somma = M − 2), salvo
  il blocco SCL FB41 (somma = M). Le reti vuote sono ammesse (FB101: `0, 0, 22`; OB1 TIA ha una
  quinta rete di lunghezza 0, la rete vuota finale dell'editor TIA).
- La lista dei salti contiene **tutte e sole** le istruzioni di salto (JU, JC, JCN, JNB …) del
  codice. **Non** contiene i JU interni a UC/CC/CALL (§2.5): FC1 ha 14 chiamate e J = 0.
- L'ordine della lista è crescente in OB1, FC21, FB41, FB80, ma **non** in FC100 (73 salti,
  stesso insieme, ordine diverso). L'ordine viene dal progetto offline ([ST7]: `ADDINFO` copiato
  com'è), forse legato all'ordine di creazione delle etichette ⚠️. Per l'identità al byte va
  conservato; per un blocco nuovo scrivere l'ordine crescente.
- Blocco senza reti: ADD assente (A = 0, FB751) oppure `01 00 00 00 00 00` (una rete vuota, FB3003, FB3004).

Esempio reale (OB1 TIA): `05 00 | 86 00 42 00 04 00 06 00 00 00 | 03 00 | 03 00 0d 00 17 00`
= 5 reti di 134, 66, 4, 6, 0 byte; 3 salti alle parole 3, 13, 23 (byte 6, 26, 46).

Fonti: [DN] `NetWork.cs` (solo la prima tabella), [DN-doc] ("Segment table … length of networks"),
[ST7]; la tabella dei salti e le regole sopra sono dedotte da [CAP] e [DN-V] in questo lavoro.

Negli SDB la ADD (quando c'è) ha altro contenuto (SDB1 TIA: 14 byte fissi e poi dati compressi
zlib `78 5e …`): opaco, fuori ambito.

### 1.6 Footer (ultimi 36 byte)

| off | dim  | campo                | note                                                                    | stato |
| --- | ---- | -------------------- | ----------------------------------------------------------------------- | ----- |
| 0   | 8    | autore               | ASCII; riempito con `00` (STEP 7/TIA) o spazi (SDB: `STEP 7 #`)         | reale |
| 8   | 8    | famiglia             | come sopra                                                              | reale |
| 16  | 8    | nome (_header name_) | come sopra                                                              | reale |
| 24  | 1    | versione             | nibble alto . nibble basso (`01` = 0.1, `10` = 1.0, `54` = 5.4)         | reale |
| 25  | 1    | riservato            | sempre `00`                                                             | reale |
| 26  | 2 BE | checksum             | §1.7                                                                    | reale |
| 28  | 8    | riservato            | `00…00` nei blocchi di codice e DB; `31 52 48 14 00 00 00 00` negli SDB | reale |

snap7 descrive un footer di 56 byte (20 byte "sconosciuti" prima dell'autore): sono la coda di
SSB/ADD, non parte del footer ([SNAP7], [CAP]). Fonti: [DN], [ST7] `getMC7Footer`, [SNAP7].

### 1.7 Checksum del blocco (CRC-16)

**Algoritmo** (documentato da [DN] `CrcHelper.GetCrc16` e dal suo test `TestCRC`, e verificato qui):

- CRC-16 con polinomio **`0x9003`**, valore iniziale **`0x0000`**, bit più significativo per
  primo (nessuna riflessione in ingresso né in uscita), nessuno XOR finale.
- Dati coperti, in quest'ordine: **byte di tipo** (header[5]), **lunghezza MC7** (header[34..35],
  2 byte BE), poi gli **M byte della sezione MC7**. Non coprono header, interfaccia, ADD, footer,
  autore, nome, versione, timestamp.
- Il risultato va nel footer a offset 26, big-endian.

Procedura bit a bit (in parole): per ogni byte e per ognuno dei suoi 8 bit dal più alto, se il
bit 15 del CRC è diverso dal bit dei dati, il CRC diventa (CRC << 1) XOR `0x9003`, altrimenti
CRC << 1 (a 16 bit).

**Verifica (reale: 23 blocchi su 23 dove ci si può aspettare corrispondenza)**: OB1 TIA (`5935`),
i 3 DB scaricati delle catture (`76e6`, `196a`, `c0df`), gli 8 SDB (es. SDB0 `d1cc`), FC1 (`3863`),
FC21 (`e758`), FC100 (`f967`), FB1001 (`9c45`), FB101 (`0e49`), FB41 (`42f4`), FB80 (`5e85`),
FB751/FB3003/FB3004 (`d513`: stesso MC7 `65 00`, stesso valore malgrado interfacce diverse),
OB1 di [RZ] (`4de5`). Vettori in §5.4.

Eccezioni, tutte nei DB caricati da una CPU in funzione:

- DB121, DB13, DB4: il checksum **non** corrisponde ai dati attuali. Ipotesi coerente con tutto il
  resto: il checksum si calcola sui dati al momento del download e la CPU non lo aggiorna quando i
  valori attuali cambiano ⚠️ (non verificabile senza il blocco originale).
- DB1806, DB3001…DB3005, DB310: checksum `0000` (blocchi creati da qualche strumento senza checksum ⚠️).

Regola per il 1E: in andata e ritorno di un blocco letto, **conservare il checksum originale**
(sempre, anche per i DB); per un blocco nuovo calcolarlo con l'algoritmo sopra, sui dati del DB
così come vengono scritti nel file.

### 1.8 Protezione know-how

- È il byte header[15] = `03` (campo "sicurezza", `s7comm.md` §8.3). Visto in FB41 (CONT_C della
  libreria standard, notoriamente protetto) e FB80. **reale.**
- Il codice MC7 e l'interfaccia di un blocco protetto **non sono cifrati**: FB41 e FB80 si
  decodificano completamente come gli altri. La protezione è solo un'indicazione per l'editor.
- **BaaPortal rispetta la protezione** (spec, 2026-10-18): di un blocco protetto si legge solo
  l'interfaccia (SSB); il codice MC7 non si decodifica né si mostra, non entra nel progetto (restano
  solo i byte originali del blocco, per riesportarlo identico) e il blocco è di sola lettura. I
  blocchi protetti sono esclusi dai test: FB41 e FB80 non fanno più parte del corpus di prova
  (§5.1). Un blocco nostro con il contrassegno si scrive e si rilegge normalmente (header[15] = `03`); anche di quello, ricaricato da file, si legge solo l'interfaccia.
- Il bit3 dell'attributo (header[3]) è indicato da [DN] come "know-how protected" ma non è acceso
  in FB41/FB80 ⚠️. Il linguaggio `0x29` (S7-Block-Privacy, cifratura) non riguarda l'S7-300.

### 1.9 Specifiche dei DB

| aspetto                             | regola                                                                                                     | stato              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| dati attuali                        | sezione MC7 (M byte), layout di §1.4.8, big-endian                                                         | reale              |
| valori iniziali                     | in SSB, solo per le variabili con valore iniziale, little-endian (§1.4.6)                                  | reale              |
| valori iniziali senza dichiarazione | zero (stringhe: lunghezza massima scritta, lunghezza attuale 0 ⚠️ dedotto dal layout)                      | ⚠️                 |
| DB d'istanza                        | SSB[0] = `0a`; SSB[1..2] = numero dell'FB (LE) secondo [DN] ⚠️; righe = interfaccia dell'FB, TEMP compresi | reale (1 campione) |
| DB di SFB                           | ⚠️ genere SSB ignoto (nessun campione)                                                                     | —                  |
| DB da UDT                           | interfaccia = STRUCT espansa, nessun riferimento all'UDT                                                   | reale (DB3005)     |
| non-retain                          | bit5 dell'attributo                                                                                        | reale (DB1806)     |
| checksum                            | §1.7                                                                                                       | reale / ⚠️         |
| linguaggio                          | `05`; `01` visto in DB121 e DB13                                                                           | reale              |

### 1.10 UDT

Sull'S7-300 l'UDT **non esiste come blocco** nella CPU: la lista dei tipi di blocco
(`s7comm.md` §8.4) non ha un codice UDT e i blocchi che usano un UDT ne contengono la
struttura espansa come STRUCT (DB3005: "two UDTs", solo righe `11`; FB3003/FB3004). Il nome
dell'UDT si perde (§4). **reale.** Il compilatore 1E deve espandere gli UDT nelle interfacce.

### 1.11 SDB

Contenitore opaco: header con attributo `02`, sicurezza `80000000`, linguaggio `07`, autore
`STEP 7 #`, footer riservato `3152481400000000`. Il checksum segue la regola generale (8/8 SDB).
Fuori ambito per il compilatore.

### 1.12 Riepilogo per chi scrive un blocco

1. Header: `70 70`, `01`, attributi, linguaggio, tipo, numero, L, sicurezza, 2 timestamp,
   S, A, dati locali, M.
2. MC7: codice terminato da `65 00` (o dati del DB).
3. SSB: intestazione 7 byte LE, righe, valori iniziali LE, un byte di riempimento se serve.
4. ADD: N, lunghezze, J, offset dei salti in parole (LE).
5. Footer: autore, famiglia, nome, versione, `00`, CRC-16 BE, 8 byte zero.
6. Per un blocco letto: tutto ciò che non si sa ricalcolare (byte di riempimento, byte estesi,
   ordine dei salti, resto della ADD, numero in SSB, checksum dei DB, header[2], bit ignoti) si
   conserva dai byte originali.

---

## 2. Codifica delle istruzioni MC7

### 2.1 Principi

- Ogni istruzione è lunga **2, 4 o 6 byte**; le chiamate con lista di parametri sono più
  lunghe (8 + 4·n). Il primo byte (`b0`) e spesso il secondo (`b1`) determinano la lunghezza.
- Famiglie a due byte di opcode: `60`, `68`, `70`, `fb`, `fe`, `ff` (il secondo byte sceglie
  l'istruzione). Gli opcode `00 01 05 09 41 49 51 58 59 79 ba bb bf` hanno `b1 = 00` per
  un'istruzione senza operando e `b1 ≠ 00` per una forma con operando.
- Esistono **forme corte** (2 byte) per gli indirizzi piccoli e **forme lunghe** (4 byte):
  STEP 7 usa sempre la corta quando è possibile (§3.4).

### 2.2 Operandi

#### 2.2.1 Codici d'area

| codice `z` | area bit | area byte/parola/doppia                   |     | codice `p` | dove sta il puntatore (indiretto da memoria) |
| ---------- | -------- | ----------------------------------------- | --- | ---------- | -------------------------------------------- |
| 0          | —        | periferia: PI in lettura, PQ in scrittura |     | 3          | MD / MW                                      |
| 1          | I (E)    | IB IW ID                                  |     | 4          | DBD / DBW                                    |
| 2          | Q (A)    | QB QW QD                                  |     | 5          | DID / DIW                                    |
| 3          | M        | MB MW MD                                  |     | 6          | LD / LW                                      |
| 4          | DBX      | DBB DBW DBD                               |     |            |                                              |
| 5          | DIX      | DIB DIW DID                               |     |            |                                              |
| 6          | L        | LB LW LD                                  |     |            |                                              |

Dimensione `s`: `1` byte, `2` parola, `3` doppia; per il **trasferimento** (T) si aggiunge 4
(`5 6 7`).

#### 2.2.2 Campo bit a 4 byte

Le istruzioni bit in forma lunga sono `op x aaaa` con `x = N·80 + z·10 + bit` (bit 0–7) e
`aaaa` = indirizzo di byte. N sceglie il secondo mnemonico della coppia (A/AN, O/ON, X/XN,
S/R, FP/FN). Esempio reale FC1: `09 c3 00 07` = R DBX 7.3 (`c3` = N + area 4 + bit 3).

#### 2.2.3 Puntatore corto (`oooo`)

16 bit = byte·8 + bit, cioè P#byte.bit. Usato negli offset `[AR1,P#…]`/`[AR2,P#…]`.
Esempio reale FB1001: `be 5e 00 70` = T DIW [AR2,P#14.0] (`0x70` = 112 = 14·8).
⚠️ Per `+AR1 P#` / `+AR2 P#` [RZ] legge invece byte = bit 0–11 e bit = bit 12–14; [DN] usa
byte·8 + bit come sopra; nessun blocco reale lo contiene (§6).

#### 2.2.4 Puntatore d'area (`pppppppp`, 32 bit)

Byte 0 = area: `00` nessuna (puntatore interno all'area), `80` P, `81` I, `82` Q, `83` M,
`84` DBX, `85` DIX, `86` L, `87` V (dati locali del blocco chiamante). Byte 1–3 = byte·8 + bit
(19 bit utili). Esempi reali: `85 00 00 80` = P#DIX 16.0 (FB1001), `86 00 01 20` = P#L 36.0 (FC100),
`84 00 00 00` = P#DBX 0.0 (OB1). ⚠️ [RZ] legge byte 1 come bit e byte 2–3 come byte: smentito da FB1001.

#### 2.2.5 Indirizzamento indiretto

| forma                                             | esempio AWL                      | codifica                                                                                                        | stato                             |
| ------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| da memoria, bit                                   | `A I [MD 10]`                    | `51/58/59 x aaaa`, `x = N·80 + p·10 + z (+8 per il secondo mnemonico)` (§2.6.1)                                 | reale: FC100 (`=`)                |
| da memoria, byte/parola/doppia                    | `L MW [DBD 4]`                   | `ba` (byte) / `bb` (parola; doppia con +8): `x = T·80 + p·10 + z (+8 doppia)`, `aaaa` = indirizzo del puntatore | solo: DN, RZ                      |
| da memoria, temporizzatori/contatori              | `SP T [MW 2]`                    | `bf x aaaa`, `x = C·80 + p·10 + operazione` (§2.6.12)                                                           | solo: DN, RZ                      |
| da memoria, blocchi                               | `OPN DB [MW 2]`, `UC FC [LW 16]` | `fb x aaaa` (§2.5, §2.6.4)                                                                                      | reale: FC21, FC100, FB80          |
| da registro, interno all'area, bit                | `A M [AR1,P#0.0]`                | `79 x oooo`, `x = G·80 + z·10 + AR2·8 + op`                                                                     | reale: FB41, FB80                 |
| da registro, interno all'area, byte/parola/doppia | `L DIW [AR2,P#2.0]`              | `be x oooo`, `x = z·10 + AR2·8 + s` (+4 per T)                                                                  | reale: FB1001, FB41, FB80, FC100  |
| da registro, incrociato, bit                      | `A [AR1,P#0.0]`                  | `fb x oooo`, `x = 10 + AR2·8 + op` o `20 + AR2·8 + op2`                                                         | solo: DN, RZ                      |
| da registro, incrociato, byte/parola/doppia       | `T B [AR1,P#0.0]`                | `fb x oooo`, `x = AR2·8 + s` (+4 per T)                                                                         | reale: FC100 (T, AR1); L e AR2 ⚠️ |

`op` (gruppo 1) = `0` A, `1` AN, `2` O, `3` ON, `4` X, `5` XN; `op2` (gruppo 2, G = 1) =
`0` S, `1` R, `2` =, `4` FP, `5` FN. ⚠️ Per `fb 09…0f` (incrociato con AR2) [DN] dà `09` L B,
`0a` L W, `0b` L D (stesso schema di AR1 più 8); [RZ] dà `0b` L W e `0c` L D. Lo schema
regolare e la riga AR1 verificata fanno preferire [DN].

#### 2.2.6 Parametri formali di FC

In una FC, `#par` si accede tramite il puntatore che il chiamante ha messo nella sua lista
parametri (§2.5): istruzione `fb x wwww` con `wwww` = 2·(indice + 1), dove indice è la posizione
del parametro nell'ordine IN, OUT, IN_OUT (l'offset in parole dal JU che segue l'UC).
Reale FC21: `fb c2 00 04` = L #IN1 (secondo parametro), `fb d2 00 06` = UC #IN2 (BLOCK_FB),
`fb d0 00 02 70 0b 00 02` = UC #IN0 (BLOCK_FC, con il JU). Il byte `x` segue lo schema di §2.6.

In un FB i parametri e le statiche sono dati d'istanza: STEP 7 li accede come `DIX/DIB/DIW/DID
[AR2,P#offset]` (FB multi-istanza, reale FB1001/FB41/FB80) o come `DIx` diretto.

### 2.3 Costanti

`L` con costante usa `28 nn` (B#16#) o i formati con byte di tipo `tt`:

| forma AWL                              | codifica                                                                                         | lungh. | stato                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------- |
| `L B#16#nn`                            | `28 nn`                                                                                          | 2      | reale: FC100                                 |
| `L 2#…` (16 bit)                       | `30 02 vvvv`                                                                                     | 4      | solo: DN, RZ                                 |
| `L i` (INT −32768…32767)               | `30 03 iiii`                                                                                     | 4      | reale: FC1, FC21, OB1                        |
| `L 'c'`, `L 'cc'`                      | `30 05 c c` (un solo carattere: ⚠️ `00 c` secondo RZ)                                            | 4      | solo: DN, RZ                                 |
| `L B#(a,b)`                            | `30 06 a b`                                                                                      | 4      | solo: DN, RZ                                 |
| `L W#16#hhhh`                          | `30 07 hhhh`                                                                                     | 4      | reale: FC21, FB41                            |
| `L W#16#hhhh` generato dal compilatore | `30 00 hhhh` (tipo 00: costante interna, es. la parola `10 02` di un ANY costruito per una CALL) | 4      | reale: FC100 ⚠️ distinta dalla `30 07`       |
| `L C#nnn`                              | `30 08 vvvv` (BCD)                                                                               | 4      | solo: DN, RZ                                 |
| `L D#aaaa-mm-gg`                       | `30 0a vvvv` (giorni dal 1990-01-01)                                                             | 4      | solo: DN, RZ                                 |
| `L S5T#…`                              | `30 0c vvvv` (bit 12–13 base 10 ms/100 ms/1 s/10 s, bit 0–11 tre cifre BCD)                      | 4      | reale: FC1 (`01 00` = 1 s, `26 00` = 10 min) |

⚠️ Base di tempo di `S5T#…`: il compilatore (e i valori iniziali SSB, §1.4.6) usano la **base più piccola in cui il valore sta in tre cifre BCD**, troncando il resto: una sola funzione (`s5TimeWord`). Osservato: le uniche 2 costanti S5T dei blocchi reali (FC1) sono `01 00` (1 s in base 10 ms, non base 1 s) e `26 00` (10 min in base 1 s): coerenti con la regola, ma 2 campioni non escludono altre regole per i valori intermedi (es. 12,34 s). Una parola con base non minima (es. `20 01`) si decodifica come `W#16#2001` + byte di tipo `0c`.
| `L r` (REAL) | `38 01 dddddddd` (IEEE 754) | 6 | reale: FB41, FC100 |
| `L 2#…` (32 bit) | `38 02 dddddddd` | 6 | solo: DN, RZ |
| `L L#d` (DINT) | `38 03 dddddddd` | 6 | reale: FC1, FC100, OB1 ⚠️ vedi sotto |
| `L P#…` | `38 04 pppppppp` (§2.2.4) | 6 | reale: FB1001, FC100 |
| `L 'cccc'` | `38 05 c c c c` | 6 | solo: DN, RZ |
| `L B#(a,b,c,d)` | `38 06 a b c d` | 6 | solo: DN, RZ |
| `L DW#16#h` | `38 07 dddddddd` | 6 | reale: FB80 |
| `L T#…` | `38 09 dddddddd` (ms con segno) | 6 | solo: DN, RZ |
| `L TOD#…` | `38 0b dddddddd` (ms dalla mezzanotte) | 6 | solo: DN, RZ |

⚠️ Il byte di tipo è informazione per l'editor, la CPU carica solo il valore: il compilatore TIA
dell'OB1 FUP carica la costante REAL 80.0 come `38 03 42 a0 00 00` (tipo DINT). Un
decodificatore che vuole l'identità al byte deve scegliere la sintassi dal **byte di tipo**, non
dal valore (qui `L L#1117782016`).

Costanti negli altri operandi: `+ i` = `58 00 iiii` (reale FB80, FC100), `+ L#d` = `60 05 dddddddd`
(solo DN, RZ); `AW/OW/XOW W#16#` = `68 34/44/54 hhhh`, `AD/OD/XOD DW#16#` = `68 36/46/56 dddddddd`
(solo DN, RZ); i conteggi di scorrimento, `INC`, `DEC`, `BLD` sono 1 byte nel secondo byte.

### 2.4 Salti

- Istruzione di 4 byte: opcode (2 byte) + `jjjj` con segno.
- **Destinazione = indirizzo dell'istruzione di salto + 2·jjjj** (spostamento in **parole**, contato
  dall'inizio del salto stesso; all'indietro con jjjj negativo). **reale: tutti i 128 salti dei
  blocchi reali** cadono su un inizio di istruzione e con significato corretto (FC21: `ff f8 00 1b`
  a byte 46 → byte 100 = etichetta M000). ⚠️ [RZ] somma jjjj in byte: smentito.
- `JL` (`70 09 nnnn`): `nnnn` = numero di voci della lista che segue; ogni voce è un `JU`
  (`70 0b jjjj`); l'etichetta di JL (uscita della lista) è all'indirizzo JL + 4 + 4·nnnn. Solo: DN ⚠️.
- `LOOP` (`70 08 jjjj`) come gli altri salti. Solo: DN, RZ.
- Ogni istruzione di salto vista (JU, JC, JCN, JNB) ha una voce nella tabella dei salti di ADD
  (§1.5); i JU interni alle chiamate no. Per JL (e le voci JU della sua lista) e LOOP ⚠️ non visto.
- Le etichette non esistono nel blocco (§4): il decodificatore le genera.

### 2.5 Chiamate: UC, CC, CALL

**Forme base**

| forma                           | codifica                                                         | lungh. | stato                                          |
| ------------------------------- | ---------------------------------------------------------------- | ------ | ---------------------------------------------- |
| `UC FC n` (n < 256)             | `3d nn 70 0b jjjj` + k puntatori                                 | 6 + 4k | reale: FC1, FC100, FC21                        |
| `UC FC n` (n ≥ 256)             | `fb 70 nnnn 70 0b jjjj` + k puntatori                            | 8 + 4k | reale: FC1 (FC502, FC503)                      |
| `CC FC n` (n < 256)             | `1d nn 70 0b 00 02`                                              | 6      | reale: FC100                                   |
| `CC FC n` (n ≥ 256)             | `fb 71 nnnn 70 0b 00 02`                                         | 8      | solo: DN, RZ                                   |
| `UC FB n` / `CC FB n` (n < 256) | `75 nn` / `55 nn`                                                | 2      | UC reale: OB1; CC solo: DN, RZ                 |
| `UC FB n` / `CC FB n` (n ≥ 256) | `fb 72 nnnn` / `fb 73 nnnn`                                      | 4      | solo: DN (⚠️ RZ decodifica `fb 72` come UC FC) |
| `UC SFC n`                      | `fb 74 nnnn 70 0b jjjj` + k puntatori                            | 8 + 4k | reale: FC100 (SFC20, k = 3)                    |
| `CC SFC n`                      | ⚠️ `fb 75 nnnn …` per simmetria, nessuna fonte                   | —      | ⚠️                                             |
| `UC SFB n`                      | `fb 76 nnnn`                                                     | 4      | reale: OB1 (SFB0), FB80 (SFB14)                |
| `CC SFB n`                      | ⚠️ `fb 77 nnnn` per simmetria, nessuna fonte                     | —      | ⚠️                                             |
| `UC/CC FC [MW/DBW/DIW/LW a]`    | `fb 30/40/50/60` (UC) o `fb 31/41/51/61` (CC) `aaaa 70 0b 00 02` | 8      | reale: FC100 (`fb 60`)                         |
| `UC/CC FB [ … ]`                | `fb 32/42/52/62` / `fb 33/43/53/63` `aaaa`                       | 4      | solo: DN, RZ                                   |
| `UC #par` (BLOCK_FC / BLOCK_FB) | `fb d0 wwww 70 0b 00 02` / `fb d2 wwww`                          | 8 / 4  | reale: FC21                                    |
| `CC #par` (BLOCK_FC / BLOCK_FB) | `fb d1 wwww 70 0b 00 02` / `fb d3 wwww` ⚠️ per simmetria         | —      | ⚠️                                             |

**Lista dei parametri delle FC/SFC.** Dopo l'opcode di chiamata c'è sempre un `JU` (`70 0b jjjj`)
con `jjjj = 2 + 2k`, che salta k puntatori d'area di 4 byte (§2.2.4), uno per parametro in
ordine IN, OUT, IN_OUT. Il JU fa parte dell'istruzione UC/CC (non è nella tabella dei salti).
Nei blocchi reali tutti i 23 parametri visti puntano all'area **V** (`87`), cioè a una copia nei
dati locali del chiamante: costanti (`L 1; T LW 1` → `P#V 1.0`), BOOL (`CLR; = L 0.1` →
`P#V 0.1`), ANY costruiti dal compilatore (`P#V 47.0`), RET_VAL (`P#V 34.0`). Puntatori diretti
a I/Q/M (es. `83 00 00 50` = P#M 10.0) e il formato per TIMER/COUNTER/BLOCK (secondo [DN] il
numero nei primi 2 byte) sono ⚠️ solo: DN.

**Macro CALL (sequenze osservate).** `CALL` non è un'istruzione MC7: il compilatore la espande
in una sequenza racchiusa da due istruzioni `BLD` (marcatori senza effetto in esecuzione, usati
dall'editor per ricostruire CALL, KOP e FUP):

| chiamata      | apertura                                      | corpo                                                                                                                                                     | chiusura | stato                                                      |
| ------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| CALL FC       | `BLD 1`                                       | `= L x.y` (salva il RLO), copie dei parametri attuali nei dati locali, `UC FC n` + lista, copie delle uscite                                              | `BLD 2`  | reale: FC1, FC100, FB101, FB80                             |
| CALL SFC      | `BLD 7`                                       | come FC; gli ANY costanti costruiti in V con `L W#16#1002` (tipo `00`), `L 400`, `L 100`, `L P#DBX 0.0`                                                   | `BLD 8`  | reale: FC100                                               |
| CALL FB, DI   | `BLD 3`                                       | `= L x.y`; `CDB`; `OPN DI m`; `TAR2 LD t` (salva AR2); copie degli IN in `DIx`; `LAR2 P#DBX 0.0`; `UC FB n`; `LAR2 LD t`; copie delle OUT da `DIx`; `CDB` | `BLD 4`  | reale: OB1 (FB1, DI2)                                      |
| CALL SFB, DI  | `BLD 9`                                       | come FB, con `UC SFB n`                                                                                                                                   | `BLD 10` | reale: OB1 (SFB0, DI1; preceduto da `BLD 103` del FUP TIA) |
| multi-istanza | `BLD 14`/`15` o `16`/`17`, `BLD 11` dentro ⚠️ | `TAR2`, `+AR2 P#offset`, `UC FB/SFB`, `LAR2`                                                                                                              |          | solo: DN                                                   |

Esempio reale (FC1): `10 01 | 41 60 00 00 | 30 03 00 01 | 7e 66 00 01 | 3d 60 70 0b 00 04 87 00 00 08 | 10 02`
= `BLD 1; = L 0.0; L 1; T LW 1; UC FC 96 (P#V 1.0); BLD 2` cioè `CALL FC 96 (IN := 1)`.

⚠️ Le regole complete di espansione (quali temporanei, in che ordine, quando il compilatore passa
un puntatore diretto, come copia gli OUT, valore di `= L x.y`) **non sono documentate** dalle
fonti: le sequenze sopra sono osservazioni. I byte di dati locali usati dalla macro entrano nella
"lunghezza dati locali" dell'header (§1.2).

**Ricostruzione nella decodifica (BaaPortal, `callRebuild.ts`).** Con l'interfaccia del chiamato
nota, una sequenza `BLD n` … `BLD n+1` si rilegge come `CALL … (par := attuale, …)` solo se
l'espansione del compilatore di quella CALL ridà gli stessi byte (stessa base dei temporanei, stessi
AR2 e registri DB/DI) e il controllo AWL la accetta; altrimenti resta espansa, col grezzo. Sui 12
blocchi reali, con le interfacce degli altri blocchi reali e del catalogo: 3 dei 17 grezzi diventano
CALL (FB101 → FC 100; FC100 → SFC 20 ×2) più la CALL SFB 0 di OB1; con le interfacce dedotte dai
punti di chiamata 15 su 17 (restano i due `UC FC [LW 16]`). La CALL FB 1 di OB1 (TIA) resta espansa:
TIA calcola la base dei temporanei per rete (`LD20`), il compilatore per blocco (`LD21`).

⚠️ Base dei temporanei e CALL già espanse: dentro `BLD n` … `BLD n+1` gli accessi a L da
`= L r`/`TAR2 LD a` in su sono temporanei di quella CALL e non spostano la base (FC100: base 46 =
fine dei TEMP, come STEP 7); la lunghezza dei dati locali li conta. Regola dedotta, non documentata.

### 2.6 Tabella delle istruzioni per `id`

Una riga per forma d'operando. Le 155 voci di `instructions.ts` sono tutte presenti. Fonti di ogni
riga senza annotazione diversa: [DN] `MC7toAWL.cs` e [RZ] concordi.

#### 2.6.1 Logica a bit

| id (DE)   | forma                                    | byte                                                                                                                                                                                                                                   | L   | stato                                                           |
| --------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------- |
| A (U)     | M b.i, b < 256                           | `80+i nn`                                                                                                                                                                                                                              | 2   | reale: OB1, FB80                                                |
| A (U)     | I/Q b.i, b < 128                         | `c0+i nn` (Q: nn = 80 + b)                                                                                                                                                                                                             | 2   | reale: [RZ] cm7 (I)                                             |
| A (U)     | I/Q/M/DBX/DIX/L, forma lunga             | `00 x aaaa` (§2.2.2, N = 0)                                                                                                                                                                                                            | 4   | reale: FC1 (DBX), FC100 (M), OB1 (L)                            |
| A (U)     | T n (n < 256) / C n                      | `f8 nn` / `b8 nn`                                                                                                                                                                                                                      | 2   | solo                                                            |
| A (U)     | T n / C n (n ≥ 256)                      | `fb e0 aaaa` / `fb f0 aaaa`                                                                                                                                                                                                            | 4   | T reale: FC1 (T257); C solo                                     |
| A (U)     | stato: ==0 <>0 >0 <0 >=0 <=0 OV OS UO BR | `ff x`, x = c·10 + 0, con c: `8` ==0, `6` <>0, `2` >0, `4` <0, `a` >=0, `c` <=0, `1` OV, `0` OS, `5` UO, `e` BR (`ff e0` = A BR)                                                                                                       | 2   | BR reale: OB1; altre solo                                       |
| A (U)     | [MD/DBD/DID/LD a]                        | `51 x aaaa`, x = p·10 + z                                                                                                                                                                                                              | 4   | solo                                                            |
| A (U)     | z [AR1/AR2,P#] interno                   | `79 x oooo`, x = z·10 + AR2·8 + 0                                                                                                                                                                                                      | 4   | reale: FB41, FB80                                               |
| A (U)     | [AR1/AR2,P#] incrociato                  | `fb 10/18 oooo`                                                                                                                                                                                                                        | 4   | solo                                                            |
| A (U)     | T/C [MW…]                                | `bf (p·10 + 0)` (T) / `bf (80 + p·10 + 0)` (C) (§2.6.12)                                                                                                                                                                               | 4   | solo                                                            |
| A (U)     | #par BOOL / TIMER / COUNTER (FC)         | `fb 80 / a0 / b0 wwww`                                                                                                                                                                                                                 | 4   | solo                                                            |
| AN (UN)   | come A                                   | M corto `a0+i nn`; I/Q corto `e0+i nn`; lungo `00 x` con N = 1; T `fc nn`, `fb e1`; C `bc nn` (solo RZ ⚠️), `fb f1`; stato `ff (c·10 + 1)`; [mem] `51 x`, x = 80 + p·10 + z; [AR] `79` op 1; incrociato `fb 11/19`; #par `fb 81/a1/b1` | 2/4 | M corto reale: FC21; lungo reale: FB80, FC100; [AR] reale: FB80 |
| O         | come A                                   | M corto `88+i nn`; I/Q `c8+i nn`; lungo `01 x` N = 0; T `f9 nn`, `fb e2`; C `b9 nn`, `fb f2`; stato `ff (c·10 + 2)`; [mem] `51 x`, x = p·10 + 8 + z; [AR] op 2; incrociato `fb 12/1a`; #par `fb 82/a2/b2`                              | 2/4 | M corto reale: FB80; lungo reale: FC1, FB41; [AR] reale: FB41   |
| O         | senza operando (OR di AND)               | `fb 00`                                                                                                                                                                                                                                | 2   | solo                                                            |
| ON        | come A                                   | M corto `a8+i nn`; I/Q `e8+i nn`; lungo `01 x` N = 1; T `fd nn`, `fb e3`; C `bd nn` (solo RZ ⚠️), `fb f3`; stato `ff (c·10 + 3)`; [mem] `51 x`, x = 80 + p·10 + 8 + z; [AR] op 3; incrociato `fb 13/1b`; #par `fb 83/a3/b3`            | 2/4 | M corto reale: FB80; lungo reale: FC100                         |
| X         | bit                                      | solo forma lunga `05 x aaaa` N = 0; T `fb e4`; C `fb f4`; stato `ff (c·10 + 4)`; [mem] `58 x`, x = p·10 + z; [AR] op 4; incrociato `fb 14/1c`; #par `fb 84/a4/b4`                                                                      | 4/2 | solo                                                            |
| XN        | bit                                      | `05 x aaaa` N = 1; T `fb e5`; C `fb f5`; stato `ff (c·10 + 5)`; [mem] `58 x`, x = 80 + p·10 + z; [AR] op 5; incrociato `fb 15/1d`; #par `fb 85/a5/b5`                                                                                  | 4/2 | solo                                                            |
| A( (U()   | —                                        | `ba 00`                                                                                                                                                                                                                                | 2   | reale: OB1                                                      |
| AN( (UN() | —                                        | `ff f1`                                                                                                                                                                                                                                | 2   | solo                                                            |
| O(        | —                                        | `bb 00`                                                                                                                                                                                                                                | 2   | solo                                                            |
| ON(       | —                                        | `ff f3`                                                                                                                                                                                                                                | 2   | solo                                                            |
| X(        | —                                        | `ff f4`                                                                                                                                                                                                                                | 2   | solo                                                            |
| XN(       | —                                        | `ff f5`                                                                                                                                                                                                                                | 2   | solo                                                            |
| )         | —                                        | `bf 00`                                                                                                                                                                                                                                | 2   | reale: OB1                                                      |
| =         | M b.i corto / I/Q corto                  | `98+i nn` / `d8+i nn`                                                                                                                                                                                                                  | 2   | M reale: FC100                                                  |
| =         | lungo                                    | `41 x aaaa` (x = z·10 + bit)                                                                                                                                                                                                           | 4   | reale: FC1 (DBX), OB1 (DIX, L), FC100 (M)                       |
| =         | [mem]                                    | `59 x aaaa`, x = p·10 + z                                                                                                                                                                                                              | 4   | reale: FC100                                                    |
| =         | [AR] interno / incrociato                | `79 x oooo` (G = 1, op2 2) / `fb 22/2a oooo`                                                                                                                                                                                           | 4   | interno reale: FB41, FB80                                       |
| =         | #par BOOL                                | `fb 92 wwww`                                                                                                                                                                                                                           | 4   | solo                                                            |
| R         | M / I/Q corto                            | `b0+i nn` / `f0+i nn`                                                                                                                                                                                                                  | 2   | reale: OB1 (M), [RZ] (Q)                                        |
| R         | lungo                                    | `09 x aaaa` N = 1                                                                                                                                                                                                                      | 4   | reale: FC1 (DBX), FB80 (L)                                      |
| R         | T n / C n                                | `3c nn` / `7c nn`; ≥ 256: `fb ef` / `fb ff aaaa`                                                                                                                                                                                       | 2/4 | solo                                                            |
| R         | [mem] / [AR] / incrociato / #par         | `58 x` (x = 80 + p·10 + 8 + z) / `79` (G = 1, op2 1) / `fb 21/29` / `fb 91` (BOOL), `fb af` (TIMER), `fb bf` (COUNTER)                                                                                                                 | 4   | solo                                                            |
| R         | T/C [MW…]                                | `bf (p·10 + f)` (T) / `bf (80 + p·10 + f)` (C)                                                                                                                                                                                         | 4   | solo                                                            |
| S         | M / I/Q corto                            | `90+i nn` / `d0+i nn`                                                                                                                                                                                                                  | 2   | reale: OB1 (M), [RZ] (Q)                                        |
| S         | lungo                                    | `09 x aaaa` N = 0                                                                                                                                                                                                                      | 4   | reale: FC1 (DBX, M), FB80 (L)                                   |
| S         | C n                                      | `5c nn`; ≥ 256: `fb fb aaaa`                                                                                                                                                                                                           | 2/4 | solo                                                            |
| S         | [mem] / [AR] / incrociato / #par         | `58 x` (x = p·10 + 8 + z) / `79` (G = 1, op2 0) / `fb 20/28` / `fb 90` (BOOL), `fb bb` (COUNTER)                                                                                                                                       | 4   | solo                                                            |
| NOT       | —                                        | `68 2d`                                                                                                                                                                                                                                | 2   | reale: FB41                                                     |
| SET       | —                                        | `68 1d`                                                                                                                                                                                                                                | 2   | reale: OB1, FC1                                                 |
| CLR       | —                                        | `68 1c`                                                                                                                                                                                                                                | 2   | reale: OB1, FC1                                                 |
| SAVE      | —                                        | `68 2c`                                                                                                                                                                                                                                | 2   | reale: OB1, FB41                                                |
| FP        | bit lungo                                | `49 x aaaa` N = 0 (nessuna forma corta)                                                                                                                                                                                                | 4   | reale: [RZ] cm7 (`49 30 00 00` = FP M 0.0)                      |
| FP        | [mem] / [AR] / incrociato / #par         | `59 x` (x = p·10 + 8 + z) / `79` (G = 1, op2 4) / `fb 24/2c` / `fb 94`                                                                                                                                                                 | 4   | solo                                                            |
| FN        | bit lungo                                | `49 x aaaa` N = 1                                                                                                                                                                                                                      | 4   | reale: [RZ] cm7 (`49 b1 00 00` = FN M 0.1)                      |
| FN        | [mem] / [AR] / incrociato / #par         | `59 x` (x = 80 + p·10 + 8 + z) / `79` (G = 1, op2 5) / `fb 25/2d` / `fb 95`                                                                                                                                                            | 4   | solo                                                            |

Nota: le forme corte M esistono solo per A, O, S, =, AN, ON, R (righe `80`–`b7`) e per I/Q
(`c0`–`f7`); X, XN, FP, FN usano sempre la forma lunga.

#### 2.6.2 Confronto (2 byte, senza operando)

Il secondo byte è un insieme di bit: `20` maggiore, `40` minore, `80` uguale.

| id  | I                          | D                          | R                          |
| --- | -------------------------- | -------------------------- | -------------------------- |
| ==x | `21 80` reale: FB80, FC100 | `39 80` reale: FB80, FC100 | `31 80` solo               |
| <>x | `21 60` solo               | `39 60` reale: FB80, FC100 | `31 60` solo               |
| >x  | `21 20` reale: FB80, FC100 | `39 20` reale: FC100       | `31 20` reale: FB41, FC100 |
| <x  | `21 40` reale: FB80, FC100 | `39 40` reale: FB80, FC100 | `31 40` reale: FB41, FC100 |
| >=x | `21 a0` reale: FC100       | `39 a0` reale: FC100       | `31 a0` reale: FB41        |
| <=x | `21 c0` reale: FB80        | `39 c0` reale: FB80, FC100 | `31 c0` reale: FB41        |

#### 2.6.3 Conversione (2 byte, senza operando)

| id (DE) | byte    | stato                                                                                      | id (DE)   | byte    | stato        |
| ------- | ------- | ------------------------------------------------------------------------------------------ | --------- | ------- | ------------ |
| BTI     | `68 0c` | solo                                                                                       | NEGI      | `09 00` | solo         |
| ITB     | `68 08` | reale: FB80                                                                                | NEGD      | `68 07` | reale: FC100 |
| BTD     | `68 0e` | solo ⚠️ ([DN] `AWLtoMC7.cs` scrive `68 08`, in contrasto con il suo decodificatore e [RZ]) | NEGR      | `60 06` | reale: FB41  |
| ITD     | `68 1e` | reale: OB1, FB41                                                                           | CAW (TAW) | `68 1a` | solo         |
| DTB     | `68 0a` | solo                                                                                       | CAD (TAD) | `68 1b` | solo         |
| DTR     | `68 06` | reale: OB1, FB41                                                                           | RND       | `68 5c` | reale: FB41  |
| INVI    | `01 00` | solo                                                                                       | TRUNC     | `68 5f` | solo         |
| INVD    | `68 0d` | solo                                                                                       | RND+      | `68 5e` | solo         |
|         |         |                                                                                            | RND-      | `68 5d` | solo         |

#### 2.6.4 Contatori e blocchi dati

| id (DE)   | forma                              | byte                                                 | L   | stato                                                  |
| --------- | ---------------------------------- | ---------------------------------------------------- | --- | ------------------------------------------------------ |
| CU (ZV)   | C n (n < 256)                      | `6c nn`                                              | 2   | reale: [RZ] cm7                                        |
| CU (ZV)   | C n ≥ 256 / C [MW…] / #par COUNTER | `fb fd aaaa` / `bf x` (op `d`) / `fb bd wwww`        | 4   | solo                                                   |
| CD (ZR)   | C n (n < 256)                      | `54 nn` (⚠️ [DN] accetta solo n < 128)               | 2   | reale: [RZ] cm7                                        |
| CD (ZR)   | C n ≥ 256 / C [MW…] / #par         | `fb fa aaaa` / `bf x` (op `a`) / `fb ba wwww`        | 4   | solo                                                   |
| OPN (AUF) | DB n (n < 256)                     | `20 nn`                                              | 2   | reale: FC1, FC100, FB80                                |
| OPN (AUF) | DB n (n ≥ 256)                     | `fb 78 nnnn`                                         | 4   | solo                                                   |
| OPN (AUF) | DI n (qualsiasi n)                 | `fb 79 nnnn` (nessuna forma corta)                   | 4   | reale: OB1 (DI 1, DI 2), FC100                         |
| OPN (AUF) | DB/DI [MW/DBW/DIW/LW a]            | `fb 38/48/58/68` (DB) / `fb 39/49/59/69` (DI) `aaaa` | 4   | reale: FC21 (`fb 38`), FB80 e FC100 (`fb 68`, `fb 69`) |
| OPN (AUF) | #par BLOCK_DB                      | `fb d8 wwww` (`fb d9` ⚠️)                            | 4   | solo                                                   |
| CDB (TDB) | —                                  | `fb 7c`                                              | 2   | reale: OB1                                             |

`L DBLG` `fb 3c` (reale: FB80), `L DILG` `fb 3d`, `L DBNO` `fb 4c`, `L DINO` `fb 4d` (solo) sono
forme di `L` (§2.6.8).

#### 2.6.5 Salti (4 byte: opcode + `jjjj`, §2.4)

| id (DE)      | byte                                | stato                    | id (DE)    | byte    | stato |
| ------------ | ----------------------------------- | ------------------------ | ---------- | ------- | ----- |
| JU (SPA)     | `70 0b`                             | reale: FB41, FB80, FC100 | JZ (SPZ)   | `ff 88` | solo  |
| JL (SPL)     | `70 09` (operando = numero di voci) | solo ⚠️                  | JN (SPN)   | `ff 68` | solo  |
| JC (SPB)     | `ff f8`                             | reale: FC21, FB80, FC100 | JP (SPP)   | `ff 28` | solo  |
| JCN (SPBN)   | `ff b8`                             | reale: FB41, FC100       | JM (SPM)   | `ff 48` | solo  |
| JCB (SPBB)   | `ff d8`                             | solo                     | JPZ (SPPZ) | `ff a8` | solo  |
| JNB (SPBNB)  | `ff 98`                             | reale: OB1               | JMZ (SPMZ) | `ff c8` | solo  |
| JBI (SPBI)   | `ff e8`                             | solo                     | JUO (SPU)  | `ff 58` | solo  |
| JNBI (SPBIN) | `ff 78`                             | solo                     | LOOP       | `70 08` | solo  |
| JO (SPO)     | `ff 18`                             | solo                     | JOS (SPS)  | `ff 08` | solo  |

Schema: i salti condizionati sono `ff (c·10 + 8)` con c = condizione: `0` OS, `1` OV, `2` >0, `4` <0,
`5` UO, `6` <>0, `7` BR = 0, `8` ==0, `9` RLO = 0 con RLO salvato in BR (JNB), `a` >=0,
`b` RLO = 0 (JCN), `c` <=0, `d` RLO = 1 con RLO salvato in BR (JCB), `e` BR = 1, `f` RLO = 1 (JC).
Gli stessi codici `0`…`e` (senza `7 9 b d f`) sono quelli delle istruzioni bit su stato (§2.6.1).

#### 2.6.6 Aritmetica intera (2 byte salvo dove indicato)

| id  | byte    | stato                                                              | id  | byte                                       | stato                           |
| --- | ------- | ------------------------------------------------------------------ | --- | ------------------------------------------ | ------------------------------- |
| +I  | `79 00` | reale: FC21, FB80 (⚠️ [DN] `AWLtoMC7.cs` scrive `79 05`, smentito) | +D  | `60 0d`                                    | reale: FB80, FC100              |
| -I  | `59 00` | solo (⚠️ [DN] `AWLtoMC7.cs` scrive `59 05`)                        | -D  | `60 09`                                    | reale: FC100                    |
| *I  | `60 04` | reale: FB80, FC100                                                 | *D  | `60 0a`                                    | reale: FC100                    |
| /I  | `60 00` | solo                                                               | /D  | `60 0e`                                    | reale: FC100                    |
| MOD | `60 01` | reale: FC100                                                       | +   | `58 00 iiii` (int) / `60 05 dddddddd` (L#) | int reale: FB80, FC100; L# solo |

#### 2.6.7 Virgola mobile (2 byte)

| id   | byte    | stato              | id   | byte    | stato |
| ---- | ------- | ------------------ | ---- | ------- | ----- |
| +R   | `60 0f` | reale: FB41, FC100 | LN   | `60 13` | solo  |
| -R   | `60 0b` | reale: FB41        | SIN  | `60 10` | solo  |
| *R   | `60 07` | reale: FB41        | COS  | `60 11` | solo  |
| /R   | `60 03` | reale: FB41        | TAN  | `60 12` | solo  |
| ABS  | `60 02` | solo               | ASIN | `60 18` | solo  |
| SQR  | `60 1c` | solo               | ACOS | `60 19` | solo  |
| SQRT | `60 14` | solo               | ATAN | `60 1a` | solo  |
| EXP  | `60 1b` | solo               |      |         |       |

#### 2.6.8 Caricamento: `L`

| forma                              | byte                                                                                          | L     | stato                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------- |
| MB / MW / MD n (n < 256)           | `0a nn` / `12 nn` / `1a nn`                                                                   | 2     | reale: FC100, FC21, OB1                                  |
| IB / IW / ID n (n < 128)           | `4a nn` / `52 nn` / `5a nn`                                                                   | 2     | solo                                                     |
| QB / QW / QD n (n < 128)           | `4a 80+n` / `52 80+n` / `5a 80+n`                                                             | 2     | solo                                                     |
| area z, dimensione s (forma lunga) | `7e (z·10 + s) aaaa`; z = 0 → PIB/PIW/PID                                                     | 4     | reale: FC100 (M), DBx (FC21, FB80), DIx (OB1), Lx (FB41) |
| z [AR1/AR2,P#] interno             | `be (z·10 + AR2·8 + s) oooo`                                                                  | 4     | reale: FB41, FB80, FC100                                 |
| B/W/D [AR1/AR2,P#] incrociato      | `fb (AR2·8 + s) oooo`                                                                         | 4     | solo ⚠️ (AR2: §2.2.5)                                    |
| z [MD/DBD/DID/LD a]                | `ba (p·10 + z) aaaa` (byte), `bb (p·10 + z)` (parola), `bb (p·10 + 8 + z)` (doppia)           | 4     | solo                                                     |
| costanti                           | §2.3                                                                                          | 2/4/6 | §2.3                                                     |
| T n (valore del temporizzatore)    | `02 nn`; ≥ 256 `fb e6 aaaa`; [MW…] `bf (p·10 + 6)`; #par `fb a6 wwww`                         | 2/4   | solo                                                     |
| C n (valore del contatore)         | `42 nn`; ≥ 256 ⚠️ `fb f6 aaaa` (per simmetria); [MW…] `bf (80 + p·10 + 6)`; #par `fb b6 wwww` | 2/4   | solo                                                     |
| STW                                | `70 06`                                                                                       | 2     | solo                                                     |
| DBLG / DBNO / DILG / DINO          | `fb 3c` / `fb 4c` / `fb 3d` / `fb 4d`                                                         | 2     | DBLG reale: FB80; altri solo                             |
| #par B/W/D (FC)                    | `fb c1/c2/c3 wwww`                                                                            | 4     | W reale: FC21, FC100                                     |
| P##par (FC)                        | `fb ca`/`fb cb wwww` ⚠️ solo DN                                                               | 4     | ⚠️                                                       |

#### 2.6.9 Trasferimento e registri d'indirizzo

| id        | forma                        | byte                                                           | L   | stato                                     |
| --------- | ---------------------------- | -------------------------------------------------------------- | --- | ----------------------------------------- |
| T         | MB / MW / MD n (n < 256)     | `0b nn` / `13 nn` / `1b nn`                                    | 2   | reale: FC100, FC21, OB1                   |
| T         | IB/IW/ID, QB/QW/QD (n < 128) | `4b` / `53` / `5b` (+80 per Q)                                 | 2   | QB, QW reale: [RZ] cm7                    |
| T         | area z, forma lunga          | `7e (z·10 + 4 + s) aaaa`; z = 0 → PQB/PQW/PQD                  | 4   | reale: FC100, FB80, OB1 (DIx), FB101 (Lx) |
| T         | [AR] interno                 | `be (z·10 + AR2·8 + 4 + s) oooo`                               | 4   | reale: FB1001, FB41, FB80, FC100          |
| T         | [AR] incrociato              | `fb (AR2·8 + 4 + s) oooo`                                      | 4   | reale: FC100 (`fb 05/06/07`, AR1)         |
| T         | [mem]                        | `ba/bb` con il bit `80` acceso; z = 0 → PQ ⚠️ ([RZ] scrive PI) | 4   | solo                                      |
| T         | STW                          | `70 07`                                                        | 2   | solo                                      |
| T         | #par B/W/D (FC)              | `fb c5/c6/c7 wwww`                                             | 4   | solo                                      |
| LAR1      | (da ACCU 1)                  | `fe 04`                                                        | 2   | reale: FB1001, FB80, FC100                |
| LAR1      | P#…                          | `fe 03 pppppppp`                                               | 6   | reale: FC100 (P#L 36.0)                   |
| LAR1      | MD/DBD/DID/LD a              | `fe 33/43/53/63 aaaa`                                          | 4   | solo                                      |
| LAR1      | AR2                          | `fe 01`                                                        | 2   | solo                                      |
| LAR2      | (da ACCU 1)                  | `fe 0c`                                                        | 2   | reale: FB80                               |
| LAR2      | P#…                          | `fe 0b pppppppp`                                               | 6   | reale: OB1 (P#DBX 0.0)                    |
| LAR2      | MD/DBD/DID/LD a              | `fe 3b/4b/5b/6b aaaa`                                          | 4   | LD reale: OB1, FB80                       |
| TAR1      | (in ACCU 1) / AR2            | `fe 05` / `fe 09`                                              | 2   | solo                                      |
| TAR1      | MD/DBD/DID/LD a              | `fe 37/47/57/67 aaaa`                                          | 4   | solo                                      |
| TAR2      | (in ACCU 1)                  | `fe 0d`                                                        | 2   | solo                                      |
| TAR2      | MD/DBD/DID/LD a              | `fe 3f/4f/5f/6f aaaa`                                          | 4   | LD reale: OB1, FB80                       |
| CAR (TAR) | —                            | `fe 08`                                                        | 2   | solo                                      |

#### 2.6.10 Controllo del programma

| id (DE)   | forma                                  | byte                                                        | L         | stato                                      |
| --------- | -------------------------------------- | ----------------------------------------------------------- | --------- | ------------------------------------------ |
| BE        | —                                      | `65 00`                                                     | 2         | reale: tutti                               |
| BEU (BEA) | —                                      | `65 01`                                                     | 2         | reale: FB80                                |
| BEC (BEB) | —                                      | `05 00`                                                     | 2         | reale: FB80, FC100                         |
| CALL      | FC/SFC/FB/SFB                          | macro, §2.5                                                 | variabile | sequenze reali: FC1, FC100, OB1; regole ⚠️ |
| UC        | FC/FB/SFC/SFB diretti, indiretti, #par | §2.5 (`3d`, `75`, `fb 70/72/74/76`, `fb x0/x2`, `fb d0/d2`) | 2–8+4k    | reale: FC1, FC21, FC100, OB1, FB80         |
| CC        | FC/FB diretti, indiretti               | §2.5 (`1d`, `55`, `fb 71/73`, `fb x1/x3`)                   | 2–8       | `1d` reale: FC100; altre solo              |
| MCR(      | —                                      | `68 3c`                                                     | 2         | solo                                       |
| )MCR      | —                                      | `68 3d`                                                     | 2         | solo                                       |
| MCRA      | —                                      | `68 3a`                                                     | 2         | solo                                       |
| MCRD      | —                                      | `68 3b`                                                     | 2         | solo                                       |

#### 2.6.11 Scorrimento e rotazione

| id   | senza operando (conteggio in ACCU 2) | con conteggio n                           | stato                |
| ---- | ------------------------------------ | ----------------------------------------- | -------------------- |
| SSI  | `68 24`                              | `68 (n·10 + 1)`, n = 0…15                 | solo                 |
| SSD  | `68 25`                              | `71 nn`, n = 0…32                         | solo                 |
| SLW  | `68 12`                              | `61 nn`, n = 0…15                         | n reale: FC100       |
| SRW  | `68 22`                              | `69 nn`                                   | solo                 |
| SLD  | `68 13`                              | `29 nn`, n = 0…32                         | n reale: FB80, FC100 |
| SRD  | `68 23`                              | `fe (c0 + n)`, n = 0…32 (`fe c0`…`fe e0`) | solo                 |
| RLD  | `68 17`                              | `64 nn`                                   | solo                 |
| RRD  | `68 27`                              | `74 nn`                                   | solo                 |
| RLDA | `68 18`                              | —                                         | solo                 |
| RRDA | `68 28`                              | —                                         | solo                 |

Intervalli dei conteggi: [MAN].

#### 2.6.12 Temporizzatori

Codici dell'operazione per le forme indirette, lunghe e su parametro (nibble basso):
`0` A, `1` AN, `2` O, `3` ON, `4` X, `5` XN, `6` L, `8` FR, `9` LC, `a` SF (T) / CD (C),
`b` SE (T) / S (C), `c` SD, `d` SS (T) / CU (C), `e` SP, `f` R.

| id (DE) | T n, n < 256             | T n, n ≥ 256                               | T [MW/DBW/DIW/LW a]                     | #par TIMER (FC)          | stato                                      |
| ------- | ------------------------ | ------------------------------------------ | --------------------------------------- | ------------------------ | ------------------------------------------ |
| SP (SI) | `34 nn`                  | `fb ee aaaa`                               | `bf (p·10 + e) aaaa`                    | `fb ae wwww`             | solo                                       |
| SE (SV) | `1c nn`                  | `fb eb aaaa`                               | `bf (p·10 + b)`                         | `fb ab`                  | solo                                       |
| SD (SE) | `24 nn`                  | `fb ec aaaa`                               | `bf (p·10 + c)`                         | `fb ac`                  | lungo reale: FC1 (`fb ec 01 01` = SD T257) |
| SS      | `2c nn`                  | `fb ed aaaa`                               | `bf (p·10 + d)`                         | `fb ad`                  | solo                                       |
| SF (SA) | `14 nn`                  | `fb ea aaaa`                               | `bf (p·10 + a)`                         | `fb aa`                  | solo                                       |
| FR      | `04 nn` (T), `44 nn` (C) | `fb e8` (T), `fb f8` (C)                   | `bf (p·10 + 8)`, C `bf (80 + p·10 + 8)` | `fb a8` (T), `fb b8` (C) | solo                                       |
| LC      | `0c nn` (T), `4c nn` (C) | `fb e9` (T), ⚠️ `fb f9` (C, per simmetria) | `bf (p·10 + 9)`, C `bf (80 + p·10 + 9)` | `fb a9` (T), `fb b9` (C) | C corto reale: [RZ] cm7                    |

Le forme bit sui temporizzatori (A, AN, O, ON, X, XN T) e `L T`, `R T` sono in §2.6.1 e §2.6.8.
Per i contatori `bf` usa il bit `80` (C) e il codice `p` del puntatore (parola).

#### 2.6.13 Logica a parola

| id (DE) | senza operando | con costante     | stato |
| ------- | -------------- | ---------------- | ----- |
| AW (UW) | `41 00`        | `68 34 hhhh`     | solo  |
| OW      | `49 00`        | `68 44 hhhh`     | solo  |
| XOW     | `51 00`        | `68 54 hhhh`     | solo  |
| AD (UD) | `68 37`        | `68 36 dddddddd` | solo  |
| OD      | `68 47`        | `68 46 dddddddd` | solo  |
| XOD     | `68 57`        | `68 56 dddddddd` | solo  |

#### 2.6.14 Accumulatori e varie

| id    | forma              | byte                   | L   | stato                                      |
| ----- | ------------------ | ---------------------- | --- | ------------------------------------------ |
| TAK   | —                  | `70 02`                | 2   | reale: FB41                                |
| PUSH  | —                  | `68 2e`                | 2   | solo                                       |
| POP   | —                  | `68 3e`                | 2   | solo                                       |
| ENT   | —                  | `60 08`                | 2   | solo (solo CPU a 4 accumulatori)           |
| LEAVE | —                  | `68 4e`                | 2   | solo (idem)                                |
| INC   | n (0…255)          | `11 nn`                | 2   | solo                                       |
| DEC   | n (0…255)          | `19 nn`                | 2   | solo                                       |
| BLD   | n (0…255)          | `10 nn`                | 2   | reale: 1, 2, 3, 4, 7, 8, 9, 10, 103 (§2.5) |
| NOP   | 0 / 1              | `00 00` / `ff ff`      | 2   | 0 reale: OB1; 1 solo                       |
| +AR1  | (ACCU 1-L) / P#b.i | `fe 06` / `fe 02 oooo` | 2/4 | solo ⚠️ formato di `oooo` (§2.2.3)         |
| +AR2  | (ACCU 1-L) / P#b.i | `fe 0e` / `fe 0a oooo` | 2/4 | solo ⚠️ idem                               |

### 2.7 Lunghezza delle istruzioni (per calcolare i salti)

| lunghezza | istruzioni                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2         | tutte le forme senza operando; forme corte con operando a 1 byte (`02 04 0a 0b 0c 10 11 12 13 14 19 1a 1b 1c 20 24 28 29 2c 34 3c 42 44 4a 4b 4c 52 53 54 55 5a 5b 5c 61 64 69 6c 71 74 75 7c`, `80`–`f7`, `b8 b9 bc bd f8 f9 fc fd`); `60 xx` salvo `60 05`; `68 xx` salvo `68 34/36/44/46/54/56`; `70 02/06/07`; `fb 00/3c/3d/4c/4d/7c`; `fe 01/04/05/06/08/09/0c/0d/0e`, `fe c0`–`fe e0`; `ff` senza salto |
| 4         | forme lunghe e indirette (`00 01 05 09 41 49 51 58 59 79 7e ba bb be bf` con b1 ≠ 0; `30`; `68 34/44/54`; `fb` salvo i casi sopra e sotto; `fe 02/0a/33…6f`); salti (`70 08/09/0b`, `ff x8`)                                                                                                                                                                                                                  |
| 6         | `38`, `60 05`, `68 36/46/56`, `fe 03/0b`; `3d nn`/`1d nn` + JU                                                                                                                                                                                                                                                                                                                                                |
| 8 + 4k    | `fb 70/71/74` e `fb 30/31/40/41/50/51/60/61` e `fb d0/d1` + JU + k puntatori (k dal JU)                                                                                                                                                                                                                                                                                                                       |
| 6 + 4k    | `3d nn` + JU + k puntatori                                                                                                                                                                                                                                                                                                                                                                                    |

Nota: mettere `JL` e le voci `JU` della sua lista nella tabella dei salti dell'ADD è una scelta nostra, non verificata su blocchi reali (⚠️, vedi §2.4).

---

## 3. Regole di decodifica

### 3.1 Trovare i confini

1. Si decodifica in sequenza dall'offset 0 della sezione MC7; l'istruzione è determinata da
   `b0` e, per le famiglie e per i codici con forma doppia, da `b1` (§2.1, §2.7).
2. Dopo un opcode di chiamata FC/SFC (`3d`, `1d`, `fb 70/71/74`, `fb x0/x1` con x = 3…6,
   `fb d0/d1`) segue **obbligatoriamente** un `70 0b jjjj`: k = (jjjj − 2) / 2 puntatori da 4 byte
   appartengono alla stessa istruzione. ⚠️ [RZ] tratta `3d`/`1d` come istruzioni da 2 byte e il JU
   come salto separato: il risultato è diverso solo come raggruppamento, ma la tabella dei salti
   di ADD (§1.5) conferma che il JU non è un salto per il compilatore.
3. I confini di rete vengono dalla ADD; il BE finale è fuori dalle reti se la somma è M − 2.
4. Se un opcode non è nella tabella, il decodificatore deve fermarsi e conservare i byte
   restanti grezzi (nessuno dei blocchi reali lo richiede).
5. Le destinazioni dei salti devono cadere su un inizio di istruzione; altrimenti il blocco va
   trattato come non decodificabile (conservare grezzo).

### 3.2 Cosa emettere per avere identità al byte

| informazione nei byte                           | cosa deve emettere il decodificatore                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| byte di tipo delle costanti (`30 tt`, `38 tt`)  | la sintassi del tipo (W#16#, L#, real, …), anche se il valore "sembra" un altro tipo (§2.3); per `30 00` una forma distinta (es. una notazione BaaPortal per "costante interna")                 |
| JU interno alle chiamate e lista di puntatori   | o una CALL ricostruita (solo se la ri-codifica dà gli stessi byte), o una forma estesa BaaPortal `UC FC n` + lista di puntatori (come la mostra [DN]): AWL standard non permette parametri su UC |
| `OPN DB n` seguito da accesso `DBx`             | si può fondere in `DBn.DBx …` solo se il codificatore rimette l'`OPN` identico (STEP 7 ripete l'OPN prima di ogni accesso qualificato: FC1 rete 4)                                               |
| `BLD n`                                         | sempre (sono istruzioni AWL valide) se la CALL non viene ricostruita                                                                                                                             |
| `NOP 0`                                         | sempre (il FUP TIA li mette a fine rete)                                                                                                                                                         |
| reti, reti vuote, BE finale                     | dalla ADD                                                                                                                                                                                        |
| etichette                                       | generate (M000, M001 …) sugli indirizzi di destinazione                                                                                                                                          |
| ordine della tabella dei salti, resto della ADD | metadati da conservare fuori dal testo AWL                                                                                                                                                       |
| nomi dei parametri `#par`                       | dalla posizione nell'interfaccia (§2.2.6); senza nomi: nomi generati                                                                                                                             |

### 3.3 Codifiche non uniche

| caso                                                       | forme equivalenti per la CPU              | scelta di STEP 7 (canonica)                                                                        | stato                                 |
| ---------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| bit/byte/parola/doppia in M con indirizzo < 256, I/Q < 128 | forma corta (2 B) o lunga (4 B)           | sempre la corta                                                                                    | reale: 0 eccezioni su 2011 istruzioni |
| `OPN DB n` con n < 256                                     | `20 nn` o `fb 78 00 nn`                   | `20 nn`                                                                                            | reale                                 |
| `UC/CC FC n`, `UC FB n` con n < 256                        | corta o `fb 70/71/72`                     | la corta, anche con parametri ([DN] `AWLtoMC7.cs` sceglie la lunga con parametri: smentito da FC1) | reale                                 |
| T/C con n < 256                                            | corta o `fb ex`/`fb fx`                   | la corta                                                                                           | reale (T256/T257 usano la lunga)      |
| costante intera                                            | `30 03` o `38 03` o `28`                  | dalla sintassi: `L 5` → `30 03`, `L L#5` → `38 03`, `L B#16#5` → `28 05`                           | reale                                 |
| `A(`, `O(`                                                 | `ba 00`/`bb 00`; forse `ff f0`/`ff f2` ⚠️ | `ba 00`/`bb 00`                                                                                    | reale (A()                            |
| bit 3 di `x` nelle forme bit lunghe, bit AR in `7e`        | ⚠️ valori non generati da STEP 7          | —                                                                                                  | —                                     |
| `W#16#`                                                    | `30 07` (utente) o `30 00` (compilatore)  | dipende dall'origine                                                                               | reale                                 |
| `+ i`                                                      | `58 00 iiii` (16 bit) o `60 05` (32 bit)  | dalla sintassi (`+ L#…` → `60 05`)                                                                 | reale (`58 00`)                       |

Un decodificatore che incontra una forma non canonica deve marcarla (o conservare i byte), perché
il codificatore la riscriverebbe in forma canonica.

### 3.4 Prova di unicità fatta

Sulle 2011 istruzioni reali: nessuna forma lunga dove esiste la corta; nessun testo che corrisponda
a due sequenze diverse. Quindi, con la tabella di §2 e le scelte di §3.3, **decode → encode**
riproduce tutti i 12 blocchi di codice reali, a meno di: ordine della tabella dei salti (FC100),
resto della ADD (FB101), parti dell'interfaccia non ricalcolabili (§1.12 punto 6).

---

## 4. Simboli e commenti

Il blocco nella CPU **non contiene**: nomi simbolici (tabella dei simboli), commenti di blocco,
di rete e di riga, titoli di rete, nomi delle variabili dell'interfaccia (solo tipi e struttura),
nomi delle etichette, nomi degli UDT (espansi), sorgenti AWL/SCL/GRAPH, il nome della famiglia
oltre gli 8 caratteri del footer, la disposizione grafica KOP/FUP oltre ai marcatori `BLD`.

Sopravvive invece: tipo, numero, linguaggio, attributi, protezione, timestamp di codice e
d'interfaccia, autore/famiglia/nome/versione (8 caratteri ciascuno), lunghezza dei dati locali,
struttura e tipi dell'interfaccia (con le sezioni e l'ordine), valori iniziali, valori attuali dei
DB, numero e confini delle reti, posizione dei salti, marcatori `BLD` (che permettono di
riconoscere CALL e i box KOP/FUP), i byte estesi d'interfaccia (significato ignoto).

Per il 1E: il decodificatore genera nomi (`IN0`, `OUT0`, `STAT0`, `TEMP0`, `M000`, `Rete 1`…) e
il progetto BaaPortal conserva a parte simboli e commenti, legandoli al blocco per numero e
posizione (rete, offset d'istruzione), come fa STEP 7 nel progetto offline ([ST7], [DN]).

---

## 5. Verifica sui blocchi reali

### 5.1 Inventario e copertura

Colonne: lingua = header[4]; L = lunghezza del file; M, S, A = lunghezze di §1.1; decodifica =
istruzioni, ignote, percentuale di byte MC7 decodificati; reti = controllo della ADD; salti =
voci nella tabella / salti nel codice; CRC = checksum di §1.7.

| blocco                                      | lingua   | L                    | M                    | S                | A     | decodifica                             | reti                     | salti                | CRC                | sorgente                                                                                                           |
| ------------------------------------------- | -------- | -------------------- | -------------------- | ---------------- | ----- | -------------------------------------- | ------------------------ | -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| OB1                                         | FUP (03) | 332                  | 212                  | 28               | 20    | 73 istr., 0 ignote, 100%               | 5 reti, M − 2, allineate | 3/3 uguali           | ok                 | `gymgit/tia_s300_downloadOb1.pcapng` (download TIA)                                                                |
| OB1 (cm7)                                   | AWL      | 142                  | 36                   | 28               | 6     | 15 istr., 0, 100%                      | 1, M − 2                 | 0/0                  | ok                 | [RZ] `example/cm7.bin`                                                                                             |
| FC1                                         | AWL      | 434                  | 342                  | 8                | 12    | 84 istr., 0, 100%                      | 4, M − 2                 | 0/0                  | ok                 | [DN-V]                                                                                                             |
| FC21                                        | AWL      | 260                  | 166                  | 14               | 8     | 48 istr., 0, 100%                      | 1, M − 2                 | 1/1                  | ok                 | [DN-V]                                                                                                             |
| FC100                                       | AWL      | 4182                 | 3882                 | 60               | 168   | 1187 istr., 0, 100%                    | 9, M − 2                 | 73/73 ordine diverso | ok                 | [DN-V]                                                                                                             |
| FB1001                                      | AWL      | 126                  | 22                   | 26               | 6     | 6 istr., 0, 100%                       | 1, M − 2                 | 0/0                  | ok                 | [DN-V]                                                                                                             |
| FB101                                       | AWL      | 128                  | 24                   | 10               | 22    | 6 istr., 0, 100%                       | 3, M − 2                 | 0/0 + 12 B ignoti    | ok                 | [DN-V]                                                                                                             |
| FB751 (vuoto)                               | AWL      | 82                   | 2                    | 8                | 0     | 1 istr. (BE)                           | ADD assente              | —                    | ok                 | [DN-V]                                                                                                             |
| FB3003 / FB3004 (vuoti)                     | AWL      | 656 / 644            | 2                    | 576 / 564        | 6     | 1 istr. (BE)                           | 1 rete vuota             | 0/0                  | ok                 | [DN-V]                                                                                                             |
| DB1                                         | DB       | 216                  | 88                   | 56               | 0     | dati: interfaccia → 88 B ✓             | —                        | —                    | ok                 | `gymgit/step7_s300_download.pcapng`                                                                                |
| DB1                                         | DB       | 86                   | 2                    | 12               | 0     | 2 B ✓                                  | —                        | —                    | ok                 | `icspcap/4-S7comm-Download-DB1-with-password-request.pcap`                                                         |
| DB1                                         | DB       | 500                  | 400                  | 28               | 0     | 400 B ✓ (ARRAY con valore iniziale ⚠️) | —                        | —                    | ok                 | `s7comm_downloading_block_db1.pcap`                                                                                |
| DB4, DB13, DB121                            | DB/AWL   | 8094 / 64214 / 21418 | 6000 / 64040 / 20824 | 2022 / 102 / 522 | 0     | dimensione ✓                           | —                        | —                    | no (dati cambiati) | [DN-V]                                                                                                             |
| DB3001…DB3005, DB310                        | DB       | 128…4920             | 2…4692               | 52…1002          | 0     | dimensione ✓, valori iniziali ✓        | —                        | —                    | `0000`             | [DN-V]                                                                                                             |
| DB1806 (istanza)                            | DB       | 11842                | 10882                | 888              | 0     | dimensione d'istanza ✓                 | —                        | —                    | `0000`             | [DN-V]                                                                                                             |
| SDB0 (upload), SDB0, 1, 3, 4, 7, 1000, 2000 | SDB      | 94…680               | 22…382               | 0                | 0…572 | opaco                                  | —                        | —                    | ok (8/8)           | `cisagov/snap7.pcap` (×4 uguali), `gymgit/snap7_s300_everything.pcapng`, `gymgit/tia_s300_downloadHwConfig.pcapng` |

Totale: 31 blocchi diversi (12 dalle catture, 18 da [DN-V], 1 da [RZ]): 10 di codice, tutti
decodificati al 100%, 13 DB e 8 SDB. Copertura delle istruzioni: **61 dei 155 `id` compaiono in almeno un
blocco reale del corpus di prova**, più la macro CALL (sequenze reali, regole ⚠️); **94 solo dalle fonti**.

I blocchi protetti know-how FB41 (CONT_C, SCL, 1530 byte) e FB80 (AWL, 1808 byte) erano nel corpus
della prima verifica (12 blocchi di codice, 33 in tutto, 73 `id`). La spec impone di non decodificare
il codice protetto e di tenere questi blocchi fuori dai test (§1.8): sono stati tolti dal corpus e i
numeri sopra sono ricontati sui 10 blocchi di codice rimasti (un conteggio degli `id` distinti
decodificati: 73 con i due blocchi, 61 senza). Ciò che si è visto **solo** in quei due blocchi resta
documentato in §2 ma, per i test, è ⚠️ **visto solo in blocchi protetti, esclusi dai test**:

- 12 `id` di istruzione: `NOT`, `ITB`, `NEGR`, `RND`, `-R`, `*R`, `/R`, `>=R`, `<=R`, `<=I`, `BEU`,
  `TAK` (tolti dai 73: 61 restano);
- 21 forme di codifica (§2.6) che comprendono quelle di sopra e inoltre `LAR2 fe 0c`,
  `A 79 50`, `AN 79 51`, `O 79 52`, `= 79 d2`, `L 7e 41`, `L be 40`, `T be 44`, `L fb 3c`
  (accessi con AR2 e sulle aree d'istanza);
- le sequenze della macro CALL con dati d'istanza (`TAR2`/`LAR2` da un FB) e la CALL di una FC con 5
  `DINT`, viste solo in FB80; la compilazione di queste CALL è coperta da blocchi compilati da noi,
  non da un esempio reale nei test.

### 5.2 Appendice A — OB1 d'esempio, annotato offset per offset

Esempio prodotto dal compilatore di BaaPortal; i blocchi reali delle catture non si riproducono qui
(licenza non dichiarata). Il blocco sotto è scritto da noi in AWL e compilato con `compileBlock`
(114 byte, ora di compilazione 2026-10-20 10:30:15.250). Mostra le stesse parti che hanno i blocchi
reali (reti, un salto con la sua etichetta, tabella ADD, dati locali, footer) in forma ridotta.
**Non è una nuova prova**: ciò che la nostra uscita contiene è "reale" solo dove il significato è già
confermato su blocchi reali (per esempio l'OB1 di TIA, 332 byte, 5 reti, 3 salti: §5.1), e porta gli
stessi marchi ⚠️ dove la regola è ignota.

Sorgente AWL (due reti; `fine` è un'etichetta, TEMP: `T0` INT, `T1` BOOL):

```
Rete 1:   A  M 0.0;      Rete 2:   A  I 0.0;
          JC fine;                 AN I 0.1;
          L  MW 2;                 S  M 1.0;
          T  MW 4;
   fine:  NOP 0;
```

Offset in decimale dall'inizio della sezione MC7 (le etichette non esistono nel blocco, §4: il
decodificatore le chiama `M001`).

| off | byte          | AWL        | nota                                                            |
| --- | ------------- | ---------- | --------------------------------------------------------------- |
|     |               | **Rete 1** | 12 byte                                                         |
| 0   | `80 00`       | A M 0.0    | forma corta (`80+bit`, §2.6)                                    |
| 2   | `ff f8 00 04` | JC fine    | destinazione = 2 + 2·4 = 10 (§2.4); voce n. 1 nella tabella ADD |
| 6   | `12 02`       | L MW 2     |                                                                 |
| 8   | `13 04`       | T MW 4     |                                                                 |
| 10  | `00 00`       | NOP 0      | l'etichetta `fine` (= `M001` nel decodificato); fine rete       |
|     |               | **Rete 2** | 6 byte                                                          |
| 12  | `c0 00`       | A I 0.0    | forma corta I (`c0+bit`)                                        |
| 14  | `e1 00`       | AN I 0.1   | forma corta, N acceso (`e0+bit`)                                |
| 16  | `90 01`       | S M 1.0    | `90+bit`, byte 1                                                |
| 18  | `65 00`       | BE         | fuori dalle reti (§1.3): M = 20 = 12 + 6 + 2                    |

Header (36 byte):
`70 70 01 01 01 08 00 01 00 00 00 72 00 00 00 00 02 41 03 d2 3d 11 02 41 03 d2 3d 11 00 0c 00 0a 00 04 00 14`
= firma, formato 01, attributi 01 (collegato), linguaggio AWL (01), tipo OB (08), numero 1;
L = 114 = 36 + 20 + 12 + 10 + 36; nessuna protezione (byte 15 = 00); timestamp codice
`02 41 03 d2` ms (= 37 815 250, 10:30:15.250) e `3d 11` giorni (15 633 dal 1984-01-01);
timestamp interfaccia uguale (la nostra regola: un solo `now`); S = 12, A = 10, dati locali 4,
M = 20. Dati locali = 4: i due TEMP (INT 2 B, BOOL 1 bit) arrotondati; la regola di calcolo
resta ⚠️ (§6).

SSB (12 byte): `01 00 00 04 00 00 00` (genere 01 blocco di codice, numero 0 come in ogni OB
compilato da noi, I = 4, V = 0) + `05 05` (INT TEMP) + `01 05` (BOOL TEMP) + riempimento `00`
(7 + 4 = 11 dispari, §1.4.7).

ADD (10 byte): `02 00 | 0c 00 06 00 | 01 00 | 01 00` = N = 2 reti di 12 e 6 byte; J = 1 salto,
all'istruzione alla parola 1 (byte 2). Somma delle reti 18 = M − 2.

Footer (36 byte): `42 61 61 50 00 00 00 00` ("BaaP") `45 73 65 6d 70 69 00 00` ("Esempi")
`50 72 6f 76 61 00 00 00` ("Prova") `01` (versione 0.1) `00` `f6 04` (checksum) + 8 × `00`.
Checksum `f6 04` = CRC-16 di `08 00 14` + i 20 byte di MC7 (§1.7).

### 5.3 Appendice B — DB1 d'esempio, byte per byte

Esempio prodotto dal compilatore di BaaPortal; i blocchi reali delle catture non si riproducono qui
(licenza non dichiarata). Il DB sotto è scritto da noi e compilato con `compileBlock` (132 byte, stessa
ora dell'esempio di §5.2). Come sopra, non è una nuova prova: i layout (§1.4.8) e il formato dei
valori iniziali (§1.4.6) sono "reale" per i DB reali (per esempio il DB1 di STEP 7, 216 byte, 13 DB in
tutto: §5.1); i valori iniziali di un ARRAY restano ⚠️ e qui l'ARRAY non ne ha.

Dichiarazione (tutte variabili STAT del DB1):

| nome     | tipo                            | valore iniziale |
| -------- | ------------------------------- | --------------- |
| `Attivo` | BOOL                            | TRUE            |
| `Conta`  | INT                             | 1000            |
| `Temp`   | REAL                            | 1.5             |
| `Vet`    | ARRAY[0..2] OF INT              | —               |
| `Asse`   | STRUCT { `Pos` INT, `On` BOOL } | `Pos` = 7       |

Layout (regole di §1.4.8) = 18 byte: `Attivo` bit 0.0; `Conta` 2; `Temp` 4; `Vet` 8…13; `Asse`
14 (`Pos` 14, `On` 16.0), dimensione arrotondata a pari.

| off | byte                                                                              | significato                                                                          |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0   | `70 70 01 01 05 0a 00 01`                                                         | firma, formato 01, attributi 01 (collegato), linguaggio DB, tipo DB, numero 1        |
| 8   | `00 00 00 84`                                                                     | L = 132 = 36 + 18 + 42 + 0 + 36                                                      |
| 12  | `00 00 00 00`                                                                     | nessuna protezione                                                                   |
| 16  | `02 41 03 d2 3d 11` ×2                                                            | timestamp codice = timestamp interfaccia                                             |
| 28  | `00 2a 00 00 00 00 00 12`                                                         | S = 42, A = 0, dati locali 0, M = 18                                                 |
| 36  | `01 00`                                                                           | `Attivo` = TRUE (bit 0 del byte 0) + 1 byte di allineamento                          |
| 38  | `03 e8`                                                                           | `Conta` = 1000 (big-endian nei dati)                                                 |
| 40  | `3f c0 00 00`                                                                     | `Temp` = 1.5                                                                         |
| 44  | 6 × `00`                                                                          | `Vet[0..2]`                                                                          |
| 50  | `00 07`                                                                           | `Asse.Pos` = 7                                                                       |
| 52  | `00 00`                                                                           | `Asse.On` = FALSE + riempimento a pari                                               |
| 54  | `05 01 00 19 00 09 00`                                                            | SSB: genere 05 (DB globale), numero 1, I = 25, V = 9                                 |
| 61  | `11 04 05`                                                                        | STRUCT del DB (STAT, 5 figli)                                                        |
| 64  | `01 0c` `05 0c` `08 0c`                                                           | BOOL, INT, REAL (STAT con valore iniziale, bit `08` di `pt`)                         |
| 70  | `10 04 01 00 00 02 00 05 04`                                                      | ARRAY, 1 dimensione, [0..2] (LE), elemento INT STAT senza valore iniziale            |
| 79  | `11 04 02` `05 0c` `01 04`                                                        | STRUCT `Asse` (2 figli): `Pos` INT con valore iniziale, `On` BOOL senza              |
| 86  | `01` `e8 03` `00 00 c0 3f` `07 00`                                                | valori iniziali, **little-endian**, impacchettati (§1.4.6): TRUE, 1000, 1.5, 7       |
| 95  | `00`                                                                              | riempimento (7 + 25 + 9 = 41 dispari, §1.4.7)                                        |
| 96  | `42 61 61 50 00 00 00 00` + `45 73 65 6d 70 69 00 00` + `50 72 6f 76 61 00 00 00` | footer: autore "BaaP", famiglia "Esempi", nome "Prova"                               |
| 120 | `01 00 72 b2`                                                                     | versione 0.1, riservato, checksum `72 b2` = CRC-16 di `0a 00 12` + i 18 byte di dati |
| 124 | 8 × `00`                                                                          | riservato                                                                            |

Gli offset sono dall'inizio del file (header 36 byte, dati 36…53, SSB 54…95, footer 96…131).
Controllo di coerenza: 36 + 18 + 42 + 36 = 132 = L.

### 5.4 Vettori di checksum

| dati CRC (tipo, lunghezza, MC7)                      | risultato | origine                                        |
| ---------------------------------------------------- | --------- | ---------------------------------------------- |
| `0e 00 02 65 00`                                     | `d513`    | FB751, FB3003, FB3004 [DN-V]                   |
| `0c 00 0e c0 00 c1 00 c3 00 c4 00 c5 00 d8 80 65 00` | `7822`    | test `TestCRC` di [DN] (FC con 14 byte di MC7) |
| `0a 00 02 00 00`                                     | `196a`    | DB1 di `icspcap/4-…` [CAP]                     |
| `08 00 24` + MC7 dell'OB1 cm7                        | `4de5`    | [RZ] `example/cm7.bin`                         |

### 5.5 Come rifare la verifica nel 1E

I blocchi [DN-V] e [RZ] non si committano. SHA-256 per scaricarli a tempo di test (come
`scripts/fetch-s7-captures.mjs`) da `raw.githubusercontent.com/dotnetprojects/DotNetSiemensPLCToolBoxLibrary/<commit>/ToolBoxLibUnitTests/S7Blocks/…`
e `raw.githubusercontent.com/rizinorg/rz-libmc7/<commit>/example/cm7.bin`:

| file                      | byte  | SHA-256                                                            |
| ------------------------- | ----- | ------------------------------------------------------------------ |
| `MC7Converter/FC1.bin`    | 434   | `1dad29e5599092b7eb958662cbcf35ee88af95c7d47ecacd5c7e2b004df04e58` |
| `MC7Converter/FC21.bin`   | 260   | `ca263c5bc99dbd5005202cf3fddd0bf50fa70fff13b231149734a6ed8124a8b0` |
| `MC7Converter/FC100.bin`  | 4182  | `61639e64418a47b0b7fe5aaeadaeadf642bab2319bf32f22e473e967264dcdd2` |
| `MC7Converter/FB101.bin`  | 128   | `2d18dedcdaa1e5de230160f46d9cee1f86d795d7a56feb74764aa9b09b5916ad` |
| `MC7Converter/FB1001.bin` | 126   | `cf44c4b4aed570344ad0499323ed3552dc3b6cf94935b613728c439fbdb1a676` |
| `MC7Converter/FB751.bin`  | 82    | `a1ca7cf5e2f682bc496b62c40a71148e8679ac0c9b0e11f75fba3b9bddaef21a` |
| `MC7Converter/DB4.bin`    | 8094  | `7b89827d873a9bbe84817a5e89d46e7802927d0fef2611e131f8a4b48f5f6694` |
| `MC7Converter/DB13.bin`   | 64214 | `841f35aa7581d283597db04eb18436979bc041df5d6b6da8e55058a822dfc570` |
| `MC7Converter/DB121.bin`  | 21418 | `b6f597c86f62e3e07f2b7c505238e8ddad592b1e95a18fb580995b9f93f87b7e` |
| `MC7Converter/DB1806.bin` | 11842 | `54a0f73033a819a975830a53ec87995379c99c8af5d46237ba9e90784ee75bfe` |
| `Parameter/DB3001.bin`    | 128   | `3aa1af2651fbcdc279d7daeac03abd84c7e019833be791cd30ae9f9037dce12e` |
| `Parameter/DB3002.bin`    | 158   | `5cb883777aba8d7c37607493bf8049fbabfd0d4028b7359f2cc103ec5c75e6a8` |
| `Parameter/DB3003.bin`    | 4920  | `83b74e9b9df214ee607edd2b90e57fc0fab1e42b1960f624847bf1d0a271febd` |
| `Parameter/DB3004.bin`    | 796   | `75e3f8c86228a00b82649aecba6b8f854f774486e94826164409d4266a788004` |
| `Parameter/DB3005.bin`    | 296   | `5f2f963f57527a6380531d74256ad9bb223463e03cc9746dda2b49643943ee29` |
| `Parameter/DB310.bin`     | 1864  | `1a8ec01c3ecfc37a6dc908f18d6d486e9f7e9494ae3b0f77b2357a6a732bd99a` |
| `Parameter/FB3003.bin`    | 656   | `a80d53b48d2914476c9aba46927d857322c2fc1c2cd8b73136e6d56ee17a01de` |
| `Parameter/FB3004.bin`    | 644   | `3dd058ea08e7b94501a02590f77402fc76214b04ab2c57ccedd9122dfe12f84b` |
| [RZ] `example/cm7.bin`    | 142   | `089f010eb69a6795690d40596eacd094c67f3f46e29b8e91f3e9532a93767c29` |

FB41 e FB80 (protetti know-how) sono esclusi dal corpus di test per la regola della specifica
(§1.8): non si scaricano e non si decodificano. Il corpus conta quindi 18 blocchi [DN-V] e 1 [RZ].

Licenze: [DN-V] LGPL-2.1, [RZ] LGPL-3.0: da usare solo come dati di prova scaricati, non
ridistribuiti nel repository.

---

## 6. Lacune e rischi

### 6.1 Istruzioni senza verifica su blocco reale (94 `id`)

X, XN, AN(, O(, ON(, X(, XN(, <>I, ==R, <>R, BTI, BTD, DTB, INVI, INVD, NEGI, CAW, CAD, TRUNC,
RND+, RND-, JL, JCB, JBI, JNBI, JO, JOS, JZ, JN, JP, JM, JPZ, JMZ, JUO, LOOP, -I, /I, ABS, SQR,
SQRT, EXP, LN, SIN, COS, TAN, ASIN, ACOS, ATAN, TAR1, CAR, CALL (solo sequenze), MCR(, )MCR,
MCRA, MCRD, SSI, SSD, SRW, SRD, RLD, RRD, RLDA, RRDA, SP, SE, SS, SF, FR, AW, OW, XOW, AD, OD,
XOD, PUSH, POP, ENT, LEAVE, INC, DEC, +AR1, +AR2.

Quasi tutte sono istruzioni a 2 byte senza operando in famiglie (`60`, `68`, `ff`) dove [DN] e [RZ]
concordano e dove i vicini sono verificati: rischio basso. Restano anche non verificate molte
**forme** di `id` verificati: forme corte I/Q di L/T, periferia, indiretto da memoria (salvo `=`
bit e OPN/UC), registro incrociato in lettura e con AR2, temporizzatori e contatori in forma
corta (salvo LC, CU, CD su C), accessi `#par` diversi da `L` parola e `UC`, forme lunghe ≥ 256
per contatori, OPN DB ≥ 256.

⚠️ **Visto solo in blocchi protetti, esclusi dai test** (12 `id`, dai 73 della prima verifica
con FB41 e FB80): `NOT`, `ITB`, `NEGR`, `RND`, `-R`, `*R`, `/R`, `>=R`, `<=R`, `<=I`, `BEU`, `TAK`.
Le forme di codifica corrispondenti sono elencate in §5.1.

### 6.2 Disaccordi tra fonti

| punto                                        | [DN]                                                                       | [RZ]                              | evidenza                               | proposta                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| spostamento dei salti                        | parole                                                                     | byte                              | reale: parole (128 salti)              | parole                                                                            |
| puntatore d'area 32 bit                      | byte·8 + bit su 24 bit                                                     | bit nel byte 1, byte nei byte 2–3 | reale: [DN] (FB1001)                   | [DN]                                                                              |
| `+AR1/+AR2 P#` (16 bit)                      | byte·8 + bit                                                               | byte in 12 bit, bit in 4 bit alti | nessun blocco                          | [DN] (coerente con [AR1,P#] verificato e con l'intervallo 0.0…4095.7 di [MAN]) ⚠️ |
| `fb 0a/0b/0c` (L incrociato AR2)             | W, D, —                                                                    | —, W, D                           | nessun blocco                          | [DN] (schema AR1 + 8) ⚠️                                                          |
| `T` in periferia indiretto (`ba/bb` bit 80)  | PQ                                                                         | PI                                | nessun blocco                          | PQ (in AWL non esiste T PI) ⚠️                                                    |
| `fb 72`                                      | UC FB                                                                      | UC FC                             | nessun blocco                          | UC FB (schema 0 UC FC, 1 CC FC, 2 UC FB, 3 CC FB) ⚠️                              |
| `bc`/`bd` (AN C / ON C corti)                | non decodificati                                                           | AN C / ON C                       | nessun blocco                          | [RZ] per simmetria con `fc`/`fd` ⚠️                                               |
| `UC FC`/`CC FC`                              | 6 byte con JU                                                              | 2 byte + JU separato              | reale: il JU non è nella tabella salti | 6 byte                                                                            |
| [DN] `AWLtoMC7.cs` (codificatore incompleto) | `+I` = `79 05`, `-I` = `59 05`, `BTD` = `68 08`, UC FC con parametri lungo | —                                 | reale: `79 00`; UC corto               | ignorare il codificatore di [DN], usare il decodificatore                         |

### 6.3 Rischi principali per il piano 1E

1. **Espansione di CALL e dati locali.** Le regole con cui STEP 7 espande CALL (temporanei usati,
   ordine delle copie, puntatori diretti o copie in V, `= L x.y`, `BLD`) e calcola la lunghezza dei
   dati locali non sono documentate. Un compilatore da sorgente difficilmente sarà identico al byte
   a STEP 7 su blocchi con CALL. Proposta: l'identità al byte del 1E vale per **MC7 → AWL → MC7**
   (il decodificatore emette istruzioni grezze o CALL solo quando la ricodifica coincide); la
   compilazione da sorgente scritto a mano è "funzionalmente equivalente".
2. **Metadati non ricalcolabili.** Byte di riempimento SSB, byte estesi, ordine della tabella dei
   salti, resto della ADD (FB101), numero in SSB (0 o numero), header[2], bit 2 dell'attributo,
   checksum dei DB caricati, formato dei valori iniziali degli ARRAY con flag. Vanno portati come
   metadati accanto all'AWL.
3. **Byte di tipo delle costanti.** La CPU non lo usa, l'editor sì; TIA e STEP 7 lo scelgono in modo
   diverso (REAL caricato come DINT). Il testo AWL deve conservarlo (§3.2), compreso il tipo `00`.
4. **82 istruzioni e molte forme senza blocco reale**, con 6 disaccordi tra fonti (§6.2) proprio
   nell'indirizzamento indiretto e nei registri d'indirizzo.
5. **Blocchi di TIA e SCL diversi da STEP 7 AWL**: rete vuota finale, `NOP 0` a fine rete, `BLD 103`,
   BE dentro la rete per SCL. Il decodificatore deve basarsi sulla ADD, mai su supposizioni.

### 6.4 Cosa confermerebbe il kit dell'amico (upload in sola lettura)

Il kit (`docs/kit-raccolta.md`) carica i blocchi della sua S7-300 con l'upload; ogni blocco di codice
reale aggiunto al corpus aumenta la copertura. In particolare, conviene cercare nei suoi blocchi:

- FC con parametri passati direttamente (`CALL FC n (IN := M 10.0)`), con TIMER/COUNTER/BLOCK, con
  RET_VAL non VOID → formato dei puntatori nella lista e posizione di RET_VAL (§2.5).
- FB con multi-istanze chiamate con CALL → `BLD 14…17`, `+AR2 P#` (formato di §2.2.3).
- Codice con JL, LOOP, MCR, temporizzatori S5 (SP/SE/SD/SS/SF/FR), contatori ≥ 256, L/T su
  periferia e su I/Q in forma corta, indirizzamento indiretto da memoria e incrociato con AR2.
- DB d'istanza di SFB (genere SSB) e DB con ARRAY inizializzati (formato dei 6 byte di §1.4.6).
- Blocchi STEP 7 V5 KOP/FUP (marcatori BLD), blocchi con attributo bit2/bit3, FB con `pt` estesi.
- Il checksum dei DB: confrontare il checksum di un DB caricato con quello del progetto offline
  dell'amico (se disponibile) per confermare che è calcolato al download (§1.7).

Ogni nuovo blocco va fatto passare dal decodificatore del 1E con gli stessi controlli di §0.3:
0 opcode ignoti, reti e salti allineati, tabella dei salti uguale, CRC uguale, interfaccia consumata
fino all'ultimo byte.
