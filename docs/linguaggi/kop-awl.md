# KOP ↔ AWL: modello delle reti e schemi di traduzione (STEP 7 V5.x, S7-300)

Riferimento per il piano 4A (editor KOP). Descrive con parole nostre:

1. il modello di una rete KOP (§1);
2. per ogni elemento KOP, la sequenza AWL che genera STEP 7 V5.x (§2–§4), così che STEP 7
   riapra in KOP i blocchi scritti da BaaPortal;
3. la direzione inversa: quando una rete AWL è rappresentabile in KOP e come ricostruirla (§6);
4. le domande ancora aperte, da chiudere con catture reali (§8).

Regole clean-room: solo manuali Siemens pubblici, forum pubblici e conoscenza generale; nessun
software Siemens decompilato, nessun programma privato. I fatti sono riscritti, non copiati. Il
programma Siemens si usa solo, se c'è una licenza regolare, per riaprire i blocchi di BaaPortal
e guardare se si vedono in KOP (spec §6).

## 0. Convenzioni

**Livello di affidabilità** (in fondo a ogni schema):

| sigla       | significato                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **[M]**     | scritto in un manuale Siemens pubblico (sezione indicata)                                                                         |
| **[F]**     | riportato da più discussioni pubbliche di forum, concordi fra loro                                                                |
| **[B]**     | visto nei byte dei blocchi reali già analizzati (`docs/protocollo/mc7.md`)                                                        |
| **[D]**     | dedotto dalla semantica delle istruzioni AWL (il codice è certamente corretto per la CPU, ma non è detto che sia la forma STEP 7) |
| **ipotesi** | forma che riteniamo probabile; va confermata con una cattura (§8)                                                                 |

Manuali citati: **[KOP]** _Ladder Logic (LAD) for S7-300 and S7-400 Programming_, 05/2010,
A5E02790079-01; **[AWL]** _Statement List (STL) for S7-300 and S7-400 Programming_, 03/2006,
A5E00706960-01.

**Mnemonici**: internazionali nel testo; la tabella di §7.2 dà i tedeschi (U, UN, SPBNB, BIE…).

**Disegni**: `|` a sinistra è la barra di alimentazione; `-| |-` contatto NA, `-|/|-` contatto NC,
`-( )` bobina, `+` nodo di un ramo; i box sono rettangoli con i pin.

```
|   I0.0     I0.1             Q4.0
|---| |------|/|---------------( )
```

**Stato dei bit AWL usati qui** ([AWL] cap. 1 e 14): RLO (risultato logico), /FC (primo
controllo: con /FC = 0 la prossima istruzione logica _carica_ il bit invece di combinarlo), OR,
STA, BR (risultato binario, usato per EN/ENO), OV (overflow).

---

## 1. Il modello della rete KOP

### 1.1 Elementi

Una rete (segmento) KOP è un **unico grafo connesso** che parte dalla barra di sinistra. Gli
elementi sono di quattro tipi:

| tipo                | esempi                                                                                                                       | ingresso          | uscita                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------- |
| contatto (in linea) | NA, NC, NOT, contatti di stato (OV, BR, ==0…), confronti CMP, P/N, `(#)`                                                     | flusso a sinistra | flusso a destra                  |
| bobina (terminale)  | `( )`, `(S)`, `(R)`, `(SAVE)`, `(JMP)`, `(JMPN)`, `(RET)`, temporizzatori e contatori a bobina, `(CALL)`, `(OPN)`, `(MCR<)`… | flusso a sinistra | nessuna: chiude un ramo a destra |
| box con EN/ENO      | MOVE, matematica, conversioni, logica a parola, scorrimenti, CALL FC/FB                                                      | pin EN + pin dati | pin ENO + pin dati               |
| box senza EN/ENO    | SR, RS, POS, NEG, temporizzatori S_xxx, contatori S_Cxx                                                                      | primo pin BOOL    | pin Q (continua il flusso)       |

Il flusso di corrente va solo da sinistra a destra. Ogni contatto ha un operando BOOL; ogni box
ha pin con operandi (variabili, costanti) oppure, per i pin BOOL d'ingresso, una piccola logica
di contatti propria.

### 1.2 Struttura: serie-parallelo

La logica davanti a una bobina o a un pin è sempre una **rete serie-parallelo**:

- **serie**: elementi uno dopo l'altro (AND);
- **parallelo**: un ramo si apre in un nodo e si richiude in un nodo più a destra (OR); i rami
  paralleli possono annidarsi.

Non esistono "ponti" (collegamenti verticali che creino un grafo non riducibile a serie e
parallelo), né flusso da destra a sinistra. [KOP] cap. 1, conoscenza generale.

Un **ramo a T** (T-branch) è un nodo dal quale partono più rami che **non** si richiudono: ogni
ramo finisce in una bobina o in un box. Così una rete ha più uscite:

```
|   I0.0          Q4.0
|---| |----+------( )            uscite multiple sullo stesso nodo
|          |      Q4.1
|          +------( )
|          |  I0.1    Q4.2
|          +--| |-----( )        ramo a T con logica propria dopo il nodo
```

### 1.3 Regole di posizione (STEP 7 le fa rispettare nell'editor)

| elemento                              | sulla barra?                | regola                                                                           | fonte         |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- | ------------- |
| bobina `( )`                          | ipotesi (vedi §8, H7)       | solo all'estremità destra di un ramo                                             | [KOP] 1.6     |
| uscita intermedia `(#)`               | **no**                      | mai sulla barra, mai subito dopo l'apertura di un ramo, mai alla fine di un ramo | [KOP] 1.7     |
| `(P)`, `(N)`                          | no (servono un RLO davanti) | in linea come un contatto                                                        | [KOP] 1.12–13 |
| `(JMP)`                               | sì                          | sulla barra = salto incondizionato; con logica davanti = condizionato            | [KOP] 6.2–6.3 |
| `(RET)`                               | **no**                      | "serve una logica davanti"                                                       | [KOP] 10.14   |
| `(OPN)`, `(MCRA)`, `(MCRD)`, `(MCR>)` | sì                          | incondizionati                                                                   | [KOP] 5.1, 10 |
| `(CALL)` (FC/SFC senza parametri)     | sì                          | sulla barra = chiamata incondizionata; con logica = condizionata                 | [KOP] 10.2    |
| etichetta di salto                    | —                           | solo all'inizio della rete; 1–4 caratteri, il primo è una lettera                | [KOP] 6.1     |
| box con EN                            | sì                          | EN sulla barra = box sempre eseguito                                             | [KOP] app. C  |
| confronto CMP                         | sì                          | "dove potrebbe stare un contatto normale"                                        | [KOP] 2.2     |

### 1.4 Cosa non è rappresentabile in una rete KOP

- Due grafi non collegati nella stessa rete (STEP 7 vuole una sola "via di corrente" per rete).
- XOR come elemento: in KOP si disegna con due rami di contatti NA/NC ([KOP] 1.4); l'istruzione
  AWL `X` esiste solo in FUP (box XOR). ipotesi: STEP 7 non mostra `X`/`XN` in KOP.
- Indirizzamento indiretto (`A I [MD 10]`, `[AR1, P#…]`), registri d'indirizzo (`LAR1`, `+AR1`),
  operazioni sugli accumulatori senza box (`TAK`, `PUSH`, `POP`, `INC`, `DEC`), salti di stato
  (`JZ`, `JO`, `JM`…), `JL`, `LOOP`, `UC`/`CC` con parametri a mano, `L`/`T` liberi fuori da un box.
- Qualsiasi sequenza AWL corretta per la CPU ma diversa dagli schemi di STEP 7 (§6.1): STEP 7
  converte riconoscendo **forme**, non equivalenze logiche ([F]: "solo pochi stili di AWL si
  convertono", "senza i NOP 0 e i BLD giusti non torna in KOP").

### 1.5 Modello dati proposto per `ladfbd`

Una rete è un albero serie-parallelo con uscite. Bozza (da rifinire nel piano 4A):

```ts
type Elem =
  | { k: 'contact'; neg: boolean; op: string }        // A / AN
  | { k: 'not' }
  | { k: 'cmp'; fn: '==I' | '>R' | …; in1: string; in2: string }
  | { k: 'edge'; dir: 'P' | 'N'; mem: string }        // (P)/(N) in linea
  | { k: 'midline'; op: string }                      // (#)
  | { k: 'series'; items: Elem[] }
  | { k: 'parallel'; branches: Elem[] }               // ogni ramo è una serie
  | { k: 'box'; kind: string; pins: Record<string, Pin>; en: Elem | 'rail' };
type Out = { k: 'coil' | 'set' | 'reset' | 'jmp' | … ; op?: string };
type Node = { before: Elem; outs: (Out | Node)[] };    // nodo a T: più uscite
type Network = { label?: string; root: Node };
```

---

## 2. Schemi di base: contatti, rami, bobine

### 2.1 Contatti in serie

```
|   I0.0     I0.1             Q4.0
|---| |------|/|---------------( )
```

```
      A     I      0.0
      AN    I      0.1
      =     Q      4.0
```

Il primo `A` trova /FC = 0 e carica il bit; i successivi fanno AND. Un contatto NC dà `AN`.
Contatti su temporizzatori e contatori: `A T 1`, `A C 1`. [M] [AWL] cap. 1; [D].

### 2.2 Parallelo sulla barra

```
|   I0.0          Q4.0
|---| |----+------( )
|   I0.1   |
|---| |----+
```

```
      O     I      0.0
      O     I      0.1
      =     Q      4.0
```

Con un contatto NC in un ramo: `ON`. [F] (forma comune nelle stampe STEP 7). Il primo `O`
con /FC = 0 carica il bit come farebbe `A`; la forma `A I 0.0 / O I 0.1` è equivalente per la
CPU ma, per STEP 7, **ipotesi H1**: si usa `O` anche sul primo ramo.

### 2.3 Parallelo di rami in serie: `O` senza operando

```
|   I0.0    I0.1            Q4.0
|---| |-----| |----+--------( )
|   I0.2    I0.3   |
|---| |-----| |----+
```

```
      A     I      0.0
      A     I      0.1
      O
      A     I      0.2
      A     I      0.3
      =     Q      4.0
```

`O` senza operando fa l'OR fra gruppi AND ("AND prima di OR", [AWL] cap. 1, "O"). [D];
**ipotesi H2**: STEP 7 sceglie `O` (e non `O(`…`)`) quando i rami sono serie semplici.

### 2.4 Parallelo seguito da serie: `A(` … `)`

```
|   I0.0          I0.2      Q4.0
|---| |----+------| |--------( )
|   I0.1   |
|---| |----+
```

```
      A(
      O     I      0.0
      O     I      0.1
      )
      A     I      0.2
      =     Q      4.0
```

Serve la parentesi perché dopo il parallelo c'è altra logica in serie. [F] [D].

### 2.5 Parallelo in mezzo alla serie

```
|   I0.0       I0.1          Q4.0
|---| |----+---| |----+-------( )
|          |   I0.2   |
|          +---| |----+
```

```
      A     I      0.0
      A(
      O     I      0.1
      O     I      0.2
      )
      =     Q      4.0
```

[F] [D].

### 2.6 Rami annidati: `O(` … `)`

Un ramo che contiene a sua volta un parallelo:

```
|   I0.0                         Q4.0
|---| |-----------------+--------( )
|   I0.1      I0.2      |
|---| |---+---| |---+---+
|         |   I0.3  |
|         +---| |---+
```

Forma A (**ipotesi H2**, la riteniamo quella di STEP 7):

```
      O     I      0.0
      O(
      A     I      0.1
      A(
      O     I      0.2
      O     I      0.3
      )
      )
      =     Q      4.0
```

Forma B (equivalente per la CPU):

```
      A     I      0.0
      O
      A     I      0.1
      A(
      O     I      0.2
      O     I      0.3
      )
      =     Q      4.0
```

Regola che adottiamo per generare, finché una cattura non dice altro:

1. un parallelo i cui rami sono **tutti contatti singoli** → `O x` per ramo;
2. un parallelo i cui rami sono **serie semplici** (solo contatti) → `A…` / `O` / `A…`;
3. un ramo che contiene un **parallelo annidato**, un confronto o un box → quel ramo va in `O(` … `)`;
4. un parallelo seguito da altra logica in serie, o preceduto da logica, → tutto il parallelo
   dentro `A(` … `)`.

Il lettore (§6) deve accettare **entrambe** le forme e scegliere, per la riscrittura, quella
canonica di STEP 7 appena confermata.

### 2.7 NOT (inverti il flusso)

```
|   I0.0     I0.1             Q4.0
|---| |------| |-----|NOT|-----( )
```

```
      A     I      0.0
      A     I      0.1
      NOT
      =     Q      4.0
```

Dopo un parallelo: `A( … ) NOT`. [M] [KOP] 1.5; [D].

### 2.8 Bobina e uscite multiple sullo stesso nodo

```
|   I0.0          Q4.0
|---| |----+------( )
|          |      Q4.1
|          +------( )
```

```
      A     I      0.0
      =     Q      4.0
      =     Q      4.1
```

`=` non cambia l'RLO, quindi le bobine sullo stesso nodo diventano `=` consecutivi. Vale anche
per `S`/`R` mescolate: `= Q 4.0; S M 1.0; R M 1.1`. [F] [D].

### 2.9 Uscita intermedia `(#)`

```
|   I0.0     M0.0     I0.1      Q4.0
|---| |------(#)------| |--------( )
```

```
      A     I      0.0
      =     M      0.0
      A     M      0.0
      A     I      0.1
      =     Q      4.0
```

`=` azzera /FC: la prossima `A` ricomincerebbe da capo. Per proseguire, STEP 7 rilegge il bit
appena scritto. Lo conferma la tabella dei bit di stato di `(#)` in [KOP] 1.7 (dopo `(#)`
/FC = 1, non 0 come dopo `=`), che quindi non è un `=` solo. **ipotesi H3** sulla forma esatta
(`A M 0.0` subito dopo `=`).

Negata: `NOT` prima di `(#)` ([KOP] 1.7).

### 2.10 Ramo a T con logica dopo il nodo: bit temporanei

```
|   I0.0     I0.1         Q4.0
|---| |------| |---+------( )
|                  |  I0.2    Q4.1
|                  +--| |-----( )
```

Il valore del nodo serve due volte, ma dopo il primo `=` l'RLO non si può riprendere. STEP 7
lo salva in un **bit L temporaneo creato dal compilatore**:

```
      A     I      0.0
      A     I      0.1
      =     L     20.0
      A     L     20.0
      BLD   102
      =     Q      4.0
      A     L     20.0
      A     I      0.2
      =     Q      4.1
```

Cosa è certo e cosa no:

- [M] [KOP] 10.9: "il compilatore scrive anche in dati locali **dopo** le variabili TEMP
  dichiarate", e "i rami a T e le uscite intermedie in KOP/FUP" dipendono dall'MCR (perché
  scrivono con `=`). Quindi i rami a T usano bit L oltre la fine dei TEMP.
- [F] `= L 20.0` è frequentissimo negli OB1 riconvertiti: l'OB1 ha 20 byte di TEMP di avvio,
  quindi il primo bit libero è L 20.0. Concorda col punto sopra.
- [B] Il nostro `mc7.md` §2.5: TIA calcola la base dei temporanei **per rete**, il compilatore
  AWL **per blocco**. ipotesi H4: STEP 7 V5 KOP riparte, in ogni rete, dal primo byte dopo i TEMP
  dichiarati (come TIA), e prende bit successivi (L 20.1, L 20.2…) se nella stessa rete servono
  più nodi.
- ipotesi H5: la presenza, il numero (`102`) e la posizione del `BLD` dopo `A L 20.0`. Alcuni
  forum mostrano `BLD 102` fra istruzioni di logica; nessuna fonte dice dove esattamente.

### 2.11 Set, reset

```
|   I0.0          M0.0
|---| |------------(S)
```

```
      A     I      0.0
      S     M      0.0
```

`(R)` → `R`. Su temporizzatori e contatori: `R T 1`, `R C 1`. [M] [KOP] 1.8–1.9; [D].

### 2.12 Flip-flop SR e RS

```
|   I0.0     +------+     Q4.0
|---| |------|S  SR |Q----( )         M0.0 sopra il box
|   I0.1     |      |
|---| |------|R     |
|            +------+
```

```
      A     I      0.0
      S     M      0.0
      A     I      0.1
      R     M      0.0
      A     M      0.0
      =     Q      4.0
```

RS: stessa forma ma prima `R`, poi `S` ([KOP] 1.10: "prima il reset poi il set"). `S`/`R`
azzerano /FC, quindi la logica del secondo pin parte da capo senza parentesi. [M] per l'ordine;
**ipotesi H6** per la forma (in particolare `A M 0.0` per l'uscita Q e cosa succede se Q non è
collegato: niente oppure `NOP 0`).

### 2.13 Fronti: `(P)`/`(N)` in linea e box POS/NEG

Fronte del RLO ([KOP] 1.12–1.13), bit di memoria del fronte sopra l'elemento:

```
|   I0.0     I0.1     M0.0     Q4.0
|---| |------| |------(P)-------( )
```

```
      A     I      0.0
      A     I      0.1
      FP    M      0.0
      =     Q      4.0
```

`(N)` → `FN`. [M] semantica [AWL] cap. 1 FP/FN; [D] forma.

Box POS/NEG (fronte di un **indirizzo**, non del RLO, [KOP] 1.15–1.16): il bit da guardare è sopra
il box, il bit di memoria sul pin M_BIT, e il box sta in serie nella rete.

```
|   I0.0          I0.3                   Q4.0
|---| |---------+-------+----| I0.4 |-----( )
|               |  POS  |Q
|         M0.0 -|M_BIT  |
|               +-------+
```

**ipotesi H8**:

```
      A     I      0.0
      A(
      A     I      0.3
      FP    M      0.0
      )
      A     I      0.4
      =     Q      4.0
```

La parentesi serve perché il fronte va calcolato sul bit I0.3, non sul RLO della rete. Forma
non trovata nelle fonti pubbliche: da catturare.

### 2.14 SAVE

```
|   I0.0
|---| |----------(SAVE)
```

```
      A     I      0.0
      SAVE
```

[M] [KOP] 1.14.

### 2.15 Contatti di stato

`OV`, `OS`, `UO`, `BR`, `==0`, `<>0`, `>0`, `<0`, `>=0`, `<=0` come contatti NA/NC ([KOP] cap. 12) → `A OV`, `AN OV`, `A BR`, `A ==0`, `O >0`, … [D].

---

## 3. Temporizzatori, contatori, confronti

### 3.1 Temporizzatori a bobina

```
|   I0.0          T1
|---| |-----------(SD)
|               S5T#5S
```

```
      A     I      0.0
      L     S5T#5S
      SD    T      1
```

Bobine: `(SP)` → `SP`, `(SE)` → `SE`, `(SD)` → `SD`, `(SS)` → `SS`, `(SF)` → `SF` (nomi
internazionali; attenzione ai tedeschi, §7.2). Il valore sotto la bobina diventa `L`. [M] [KOP]
13.8–13.12 per elementi e valore; [D] per l'ordine `L` poi avvio.

### 3.2 Temporizzatori a box: S_PULSE, S_PEXT, S_ODT, S_ODTS, S_OFFDT

```
|   I0.0     +---------+     Q4.0
|---| |------|S  S_ODT |Q----( )            T1 sopra il box
|  S5T#5S  --|TV     BI|-- MW10
|   I0.1     |      BCD|-- MW12
|---| |------|R        |
|            +---------+
```

```
      A     I      0.0
      L     S5T#5S
      SD    T      1
      A     I      0.1
      R     T      1
      L     T      1
      T     MW    10
      LC    T      1
      T     MW    12
      A     T      1
      =     Q      4.0
```

Corrispondenze: S_PULSE → `SP`, S_PEXT → `SE`, S_ODT → `SD`, S_ODTS → `SS`, S_OFFDT → `SF`.
Pin non collegati: si omette la parte relativa (`R`, `L T / T`, `LC T / T`). Il box non ha EN/ENO:
il meccanismo EN/ENO non vale per i temporizzatori ([M] [KOP] app. C.1). Il box KOP non ha il
pin FR (abilitazione), che esiste solo in AWL.

[M] l'ordine `A/L/avvio; A/R; L T; LC T; A T` è quello dell'esempio di [AWL] cap. 12 (che in più
ha `FR`). **ipotesi H9**: l'ordine esatto delle uscite (BI, BCD, poi Q) e la forma con Q non
collegato (`NOP 0` finale?).

### 3.3 Contatori a bobina

```
|   I0.0          C10          |   I0.1        C10        |   I0.2        C10
|---| |-----------(SC)         |---| |----------(CU)      |---| |---------(CD)
|                C#100
```

```
      A     I      0.0           A     I      0.1          A     I      0.2
      L     C#100                CU    C     10            CD    C     10
      S     C     10
```

[M] [KOP] 4.5–4.7; [D] forma.

### 3.4 Contatori a box: S_CU, S_CD, S_CUD

```
|   I0.0     +---------+     Q4.0
|---| |------|CU  S_CUD|Q----( )            C10 sopra il box
|   I0.1     |         |
|---| |------|CD     CV|-- MW10
|   I0.2     |   CV_BCD|-- MW12
|---| |------|S        |
|   C#5    --|PV       |
|   I0.3     |         |
|---| |------|R        |
|            +---------+
```

```
      A     I      0.0
      CU    C     10
      A     I      0.1
      CD    C     10
      A     I      0.2
      L     C#5
      S     C     10
      A     I      0.3
      R     C     10
      L     C     10
      T     MW    10
      LC    C     10
      T     MW    12
      A     C     10
      =     Q      4.0
```

S_CU non ha CD; S_CD non ha CU (e il suo primo pin è CD). Ogni pin BOOL non collegato toglie le
due righe relative. **ipotesi H9** come per i temporizzatori.

### 3.5 Confronti CMP

```
|   I0.0     +-------+        Q4.0
|---| |------| CMP>I |---------( )
|   MW10   --|IN1    |
|   MW12   --|IN2    |
|            +-------+
```

```
      A     I      0.0
      A(
      L     MW    10
      L     MW    12
      >I
      )
      =     Q      4.0
```

Le istruzioni di confronto **scrivono** l'RLO senza combinarlo con quello precedente ([AWL] cap. 2,
bit di stato: /FC = 1, RLO = risultato). Perciò, con logica davanti, il confronto va chiuso in
`A(` … `)`; in un ramo parallelo in `O(` … `)`. Se il confronto è il primo elemento sulla barra:

```
      L     MW    10
      L     MW    12
      >I
      A     I      0.1
      =     Q      4.0
```

Tipi: `CMP ?I` → `==I <>I >I <I >=I <=I`, `CMP ?D` → `…D`, `CMP ?R` → `…R`. [M] [KOP] 2.2, [AWL]
2.2; **ipotesi H10** per la parentesi anche quando il confronto è il primo elemento.

---

## 4. Box con EN/ENO

### 4.1 Il meccanismo (dal manuale)

[M] [KOP] appendice C.1, con l'esempio di un sommatore ADD_I (riscritto con nostre parole):

- ENO = EN AND NOT (errore del box); senza errore ENO = EN.
- EN/ENO si appoggia al bit **BR**.
- Vale per matematica, trasferimento, conversioni, scorrimenti/rotazioni, chiamate di blocco.
  **Non** vale per confronti, contatori, temporizzatori.
- Le istruzioni aggiunte dipendono da cosa c'è collegato prima (EN) e dopo (ENO). Quattro casi:

| caso | EN                    | ENO           | AWL generato                                                                   |
| ---- | --------------------- | ------------- | ------------------------------------------------------------------------------ |
| 1    | logica davanti        | collegato     | logica EN; `JNB _001`; corpo; `AN OV`; `SAVE`; `CLR`; `_001: A BR`; uso di ENO |
| 2    | logica davanti        | non collegato | logica EN; `JNB _001`; corpo; `_001: NOP 0`                                    |
| 3    | sulla barra (nessuna) | collegato     | corpo; `AN OV`; `SAVE`; `CLR`; `A BR`; uso di ENO                              |
| 4    | sulla barra (nessuna) | non collegato | corpo; `NOP 0`                                                                 |

Esempio del caso 1:

```
|   I0.0     +--------+          Q4.0
|---| |------|EN ADD_I|ENO--------( )
|   MW10   --|IN1  OUT|-- MW14
|   MW12   --|IN2     |
|            +--------+
```

```
      A     I      0.0
      JNB   _001
      L     MW    10
      L     MW    12
      +I
      T     MW    14
      AN    OV
      SAVE
      CLR
_001: A     BR
      =     Q      4.0
```

Come funziona: `JNB` copia l'RLO (cioè EN) in BR e salta se è 0. Se salta, a `_001` l'`A BR`
(primo controllo, perché `JNB` azzera /FC) dà 0: ENO = 0. Se non salta, `AN OV` / `SAVE` mettono
in BR "nessun errore", `CLR` azzera /FC così `A BR` carica BR invece di combinarlo. [M].

Caso 2 (ENO libero): dopo `_001` c'è `NOP 0`; RLO e BR valgono EN (se non c'è stato salto, il box
non ha controllato errori). Caso 4: `NOP 0` dopo il corpo, RLO e BR invariati. [M].

### 4.2 Etichette automatiche `_001`, `_002`…

- Le etichette scritte dall'utente devono iniziare con una lettera ([M] [KOP] 6.1). Le etichette
  generate iniziano con `_`, quindi non possono scontrarsi con quelle dell'utente. [M]+[D].
- Le etichette non sono nel blocco MC7 (i salti sono spostamenti, [B] `mc7.md` §2.4): il nome
  serve solo nel progetto offline e nell'editor. Per la CPU e per la ricostruzione del KOP conta
  la **forma**, non il nome.
- **ipotesi H11**: numerazione per rete (`_001` in ogni rete) o per blocco (`_001`, `_002`…
  crescenti). In AWL le etichette sono uniche nel blocco, quindi propendiamo per una numerazione
  per blocco; alcune stampe ricordate mostrano `_001` in più reti. Da catturare.
- Il nostro lexer AWL **non accetta** etichette che iniziano con `_` (§7.1).

### 4.3 Box senza errore possibile (MOVE, logica a parola, ecc.)

[M] Per MOVE, logica a parola, scorrimenti, `BCD_I`, `I_DINT`, `INV_I`… il manuale dice "ENO ha
sempre lo stesso stato di EN" ([KOP] 9.1, 14.x, 11.x, 3.x). Quindi non c'è un errore da
controllare.

**ipotesi H12** (la forma più semplice che dà ENO = EN):

```
      A     I      0.0           // EN
      JNB   _001
      L     MW    10
      T     MW    12
_001: A     BR                   // BR = EN, messo da JNB
      =     Q      4.0           // ENO
```

Alternativa possibile: STEP 7 inserisce comunque `SET`/`SAVE`/`CLR` al posto di `AN OV`/`SAVE`/`CLR`.
Con EN sulla barra ed ENO collegato BR non è definito dal box, quindi lì serve qualcosa come
`SET; SAVE; CLR; A BR` (ipotesi).

### 4.4 MOVE

```
|   I0.0     +--------+
|---| |------|EN  MOVE|ENO
|   MW10   --|IN   OUT|-- MW12
|            +--------+
```

```
      A     I      0.0
      JNB   _001
      L     MW    10
      T     MW    12
_001: NOP   0
```

[M] caso 2 di app. C applicato a MOVE (corpo `L IN; T OUT`). MOVE accetta solo BYTE/WORD/DWORD
(8/16/32 bit, [KOP] 9.1).

### 4.5 Matematica

| box                                                      | corpo AWL                          | errore → ENO = 0                                      |
| -------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| ADD_I / SUB_I / MUL_I / DIV_I                            | `L IN1; L IN2; +I/-I/*I//I; T OUT` | `AN OV`                                               |
| ADD_DI / SUB_DI / MUL_DI / DIV_DI / MOD_DI               | `… +D/-D/*D//D/MOD …`              | `AN OV`                                               |
| ADD_R / SUB_R / MUL_R / DIV_R                            | `… +R/-R/*R//R …`                  | `AN OV` (ipotesi H13)                                 |
| ABS, SQR, SQRT, EXP, LN, SIN, COS, TAN, ASIN, ACOS, ATAN | `L IN; ABS/SQR/…; T OUT`           | `AN OV` (ipotesi H13; per ABS forse nessun controllo) |

[M] corrispondenza box ↔ istruzione e "ENO = 0 se overflow/risultato non valido" ([KOP] cap. 7–8);
[M] forma `AN OV; SAVE; CLR` per ADD_I (app. C). Per i REAL, un risultato non valido mette anche
OV = 1 ([AWL] cap. 8), quindi `AN OV` basta; che STEP 7 usi proprio `AN OV` anche lì è H13.

### 4.6 Conversioni

| box    | AWL     | errore?       | box     | AWL    | errore?                   |
| ------ | ------- | ------------- | ------- | ------ | ------------------------- |
| BCD_I  | `BTI`   | no (ENO = EN) | DI_REAL | `DTR`  | no                        |
| I_BCD  | `ITB`   | sì (overflow) | INV_I   | `INVI` | no                        |
| I_DINT | `ITD`   | no            | INV_DI  | `INVD` | no                        |
| BCD_DI | `BTD`   | no            | NEG_I   | `NEGI` | sì                        |
| DI_BCD | `DTB`   | sì            | NEG_DI  | `NEGD` | sì                        |
| ROUND  | `RND`   | sì            | NEG_R   | `NEGR` | no ([KOP] 3.12: ENO = EN) |
| TRUNC  | `TRUNC` | sì            | CEIL    | `RND+` | sì                        |
| FLOOR  | `RND-`  | sì            |         |        |                           |

Corpo: `L IN; <istr>; T OUT`. Errore "sì" → `AN OV; SAVE; CLR` come §4.1; "no" → §4.3. [M]
[KOP] cap. 3 per box ed ENO; [D] per l'istruzione AWL di ciascun box.

### 4.7 Logica a parola

WAND_W → `AW`, WOR_W → `OW`, WXOR_W → `XOW`, WAND_DW → `AD`, WOR_DW → `OD`, WXOR_DW → `XOD`.
Corpo `L IN1; L IN2; AW; T OUT`. ENO = EN ([M] [KOP] cap. 14) → §4.3.

### 4.8 Scorrimento e rotazione

SHR_I → `SSI`, SHR_DI → `SSD`, SHL_W → `SLW`, SHR_W → `SRW`, SHL_DW → `SLD`, SHR_DW → `SRD`,
ROL_DW → `RLD`, ROR_DW → `RRD`. ENO = EN ([M] [KOP] cap. 11).

Le forme AWL senza operando prendono il numero di posizioni da ACCU2-L-L ([AWL] cap. 11), quindi
con N variabile il corpo è:

```
      L     MW    20          // N  → finisce in ACCU2
      L     MW    10          // IN → ACCU1
      SLW
      T     MW    12          // OUT
```

**ipotesi H14**: ordine dei caricamenti, e se con N costante STEP 7 usa la forma con operando
(`SLW 3`) o sempre la forma con ACCU2.

### 4.9 Box in cascata (ENO → EN)

```
|   I0.0   +-------+     +------+
|---| |----|EN ADD_I|ENO--|EN MOVE|ENO
|          |  ...   |     |  ...  |
```

```
      A     I      0.0
      JNB   _001
      L     MW    10
      L     MW    12
      +I
      T     MW    14
      AN    OV
      SAVE
      CLR
_001: A     BR
      JNB   _002
      L     MW    14
      T     MW    16
_002: NOP   0
```

[D] composizione dei casi 1 e 2 di app. C; **ipotesi H15** come forma STEP 7.

### 4.10 Box in rami paralleli, o box seguito da un ramo a T

Quando lo stesso nodo alimenta più box (o un box e una bobina), il nodo va salvato in un bit L
come in §2.10, e ogni box comincia con `A L x.y; JNB _00n`. **ipotesi H5** (stessa dei rami a T).

### 4.11 Chiamate di blocco

Bobina `(CALL)` (FC/SFC senza parametri, [KOP] 10.2):

```
|   I0.1          FC11
|---| |----------(CALL)          →      A  I 0.1
                                         CC FC 11
```

Con logica davanti: `CC FC n` (chiamata condizionata) [D].
Sulla barra: chiamata incondizionata. **ipotesi H16**: `UC FC 11` (oppure `CALL FC 11`).

Box CALL_FC / CALL_FB / CALL_SFC / CALL_SFB ([KOP] 10.3–10.7):

```
|   I0.0     +-----------+          Q4.0
|---| |------|EN  FC1  ENO|----------( )
|   MW10   --|IN1    OUT1|-- MW12
|            +-----------+
```

```
      A     I      0.0
      JNB   _001
      CALL  FC     1
       IN1 :=MW10
       OUT1:=MW12
_001: A     BR
      =     Q      4.0
```

- [M] La chiamata usa EN/ENO (app. C.1). ENO è il BR lasciato dal blocco chiamato: chi scrive il
  blocco deve impostare BR con `SAVE` prima di uscire ([KOP] 10.3, app. C "Nota").
- Quindi per una chiamata non serve `AN OV; SAVE; CLR`: tra `CALL` e `_001` non c'è niente.
  [D]; **ipotesi H17** (manca anche un eventuale `CLR` prima di `_001`, che servirebbe se il
  blocco chiamato lascia /FC = 1).
- FB: `CALL FB 1 , DB 1`; multi-istanza: `CALL #istanza`. ENO non collegato: `_001: NOP 0`.
- `CALL` nell'AWL è una **macro**: il compilatore la espande in MC7 fra marcatori `BLD 1`/`BLD 2`
  (FC), `BLD 3`/`BLD 4` (FB), `BLD 7`/`BLD 8` (SFC), `BLD 9`/`BLD 10` (SFB). [B] `mc7.md` §2.5.
  Il generatore KOP→AWL emette quindi `CALL …` e lascia l'espansione al pacchetto `mc7`.

**Pin BOOL d'ingresso con logica di contatti.** In KOP a un pin IN di tipo BOOL si può collegare
una logica. [F] STEP 7 la calcola prima della chiamata in un bit L e passa quel bit:

```
      A     I      0.1          // logica del pin START
      =     L     20.0
      BLD   103
      A     I      0.0          // EN
      JNB   _001
      CALL  FC     1
       START:=L20.0
       …
```

ipotesi H18: ordine fra logica di EN e logica dei pin, posizione del `BLD 103`, e se EN viene
salvato in un bit L anch'esso. Un forum tedesco descrive gruppi "`U` / `=` / `BLD 103`" uno per
ingresso davanti a una `CALL`; [B] in OB1 (FUP TIA) un `BLD 103` precede una CALL SFB.

### 4.12 Salti ed etichette

| elemento                         | AWL                                              | fonte              |
| -------------------------------- | ------------------------------------------------ | ------------------ |
| `(JMP)` sulla barra              | `JU LBL`                                         | [M] [KOP] 6.2      |
| logica + `(JMP)`                 | logica; `JC LBL`                                 | [M] [KOP] 6.3; [D] |
| logica + `(JMPN)`                | logica; `JCN LBL`                                | [M] [KOP] 6.4; [D] |
| etichetta LBL all'inizio di rete | `LBL: ` davanti alla prima istruzione della rete | [M] [KOP] 6.1; [D] |

### 4.13 RET

```
|   I0.0
|---| |----------(RET)
```

```
      A     I      0.0
      SAVE
      BEC
```

[M] [KOP] 10.14: "RET è rappresentato internamente come SAVE; BEC". Serve sempre una logica
davanti.

### 4.14 OPN, MCR

| elemento          | AWL                          | fonte                |
| ----------------- | ---------------------------- | -------------------- |
| `(OPN)` DB10      | `OPN DB 10` (incondizionato) | [M] [KOP] 5.1        |
| `(OPN)` DI5       | `OPN DI 5`                   | [M] [KOP] 5.1        |
| logica + `(MCR<)` | logica; `MCR(`               | [M] [KOP] 10.10; [D] |
| `(MCR>)`          | `)MCR`                       | [M] [KOP] 10.11; [D] |
| `(MCRA)`          | `MCRA`                       | [M] [KOP] 10.12      |
| `(MCRD)`          | `MCRD`                       | [M] [KOP] 10.13      |

Gli elementi KOP dipendenti dall'MCR (`( )`, `(#)`, `(S)`, `(R)`, MOVE, passaggio parametri…) non
generano niente di speciale: la dipendenza è nella CPU. [M] [KOP] 10.9.

---

## 5. Marcatori BLD e NOP

### 5.1 Cosa dicono i manuali

- `BLD n` (n = 0…255): istruzione nulla "di costruzione immagine". Non fa niente e non tocca i bit
  di stato; il PG la crea **automaticamente** quando un programma KOP o FUP viene mostrato in AWL; il
  numero lo sceglie il PG. [M] [AWL] 14.13.
- `NOP 0` / `NOP 1`: istruzioni nulle (16 bit a 0 / a 1), "interessano solo il PG quando mostra il
  programma". [M] [AWL] 14.14–14.15.
- `NOP 0` chiude i box EN/ENO con ENO non collegato (casi 2 e 4). [M] [KOP] app. C.

### 5.2 Numeri BLD noti

| BLD          | dove                                                   | fonte / stato                                                 |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| 1 / 2        | apertura / chiusura della macro CALL FC                | [B] FC1, FC100, FB101, FB80                                   |
| 3 / 4        | CALL FB con DI                                         | [B] OB1                                                       |
| 7 / 8        | CALL SFC                                               | [B] FC100                                                     |
| 9 / 10       | CALL SFB                                               | [B] OB1                                                       |
| 11, 14–17    | multi-istanza                                          | solo fonte terza (DotNetSiemensPLCToolBoxLibrary)             |
| 102          | fra istruzioni logiche, rami a T                       | [F], posizione ignota (H5)                                    |
| 103          | dopo `= L x.y` che prepara un pin BOOL/un nodo         | [F], [B] (FUP TIA)                                            |
| 0, 7, 8      | citati in un forum come necessari per riconvertire     | [F], vago                                                     |
| 130–133, 255 | "riga vuota", "passa ad AWL/FUP/KOP", "nuovo segmento" | [F] elenco di un utente, probabilmente **STEP 5**: non usarli |

Il significato dei numeri **non è documentato**. Regola per BaaPortal: emettere solo i BLD
confermati da una cattura STEP 7 per lo schema in questione; fino ad allora, non inventarne
(una rete con BLD sbagliati potrebbe aprirsi in AWL invece che in KOP, che è un difetto visivo, non
di funzionamento).

---

## 6. Direzione inversa: AWL → KOP

### 6.1 Principio: conversione per forme, con prova di andata e ritorno

STEP 7 converte in KOP solo le reti che **riconosce come prodotte da sé**. Ci comportiamo allo
stesso modo, con un criterio verificabile:

> una rete AWL è rappresentabile in KOP se esiste un grafo G tale che `genera(G)` è uguale, istruzione
> per istruzione (operandi compresi, commenti e spazi esclusi), all'AWL della rete.

Quindi: (1) si prova a costruire G leggendo l'AWL (§6.3); (2) si rigenera AWL da G; (3) se coincide,
la rete si mostra in KOP; altrimenti resta in AWL. Questo evita di mostrare in KOP reti che, una
volta salvate, cambierebbero codice. Il lettore può accettare varianti equivalenti (es. §2.6 forme
A e B) solo se il generatore le riproduce; altrimenti la rete resta AWL (come STEP 7).

### 6.2 Suddivisione di una rete in "sezioni"

Una rete KOP genera una sequenza di sezioni, ognuna terminata da qualcosa che consuma l'RLO:

| fine della sezione                     | elemento KOP                              |
| -------------------------------------- | ----------------------------------------- |
| uno o più `=`, `S`, `R` consecutivi    | bobine sullo stesso nodo                  |
| `= L x.y` (bit oltre i TEMP) + `BLD …` | nodo a T / nodo condiviso                 |
| `= b` seguito da `A b`                 | uscita intermedia `(#)`                   |
| `FP`/`FN`                              | `(P)`/`(N)` (in linea, non termina)       |
| `JU`/`JC`/`JCN`                        | `(JMP)`/`(JMPN)`                          |
| `SAVE` + `BEC`                         | `(RET)`                                   |
| `SAVE` da solo                         | `(SAVE)`                                  |
| `CC`/`UC` senza parametri              | `(CALL)`                                  |
| `JNB _n` … `_n: A BR` / `_n: NOP 0`    | box con EN                                |
| `L S5T#…` + `SP/SE/SD/SS/SF T`         | temporizzatore a bobina o pin S di un box |
| `MCR(`, `)MCR`, `MCRA`, `MCRD`, `OPN`  | bobine di controllo                       |

### 6.3 Grammatica delle reti KOP (forma accettata)

Notazione: `{x}` ripetizione, `[x]` opzionale, `|` alternativa. `bit` è un operando BOOL diretto
(I, Q, M, L, DBX, DIX, T, C, `#par`, simbolo); `L*` è un bit L oltre i TEMP dichiarati.

```
rete      ::= [ ETICHETTA ":" ] { nodoT } coda
nodoT     ::= logica "=" L* [ "BLD" n ]                  ; salva un nodo condiviso

coda      ::= incond | logica uscite | boxEN | boxSenzaEN | temporiz | contatore
incond    ::= "JU" etich | "OPN" db | "MCRA" | "MCRD" | ")MCR" | "UC" blocco
           | corpoBox ( "NOP 0" | errore "A BR" uscite )   ; box con EN sulla barra
uscite    ::= uscita { uscita } | coda                    ; dopo "A BR" si può proseguire
uscita    ::= ( "=" | "S" | "R" ) bit | "JC" etich | "JCN" etich
           | "SAVE" [ "BEC" ] | "CC" blocco | "MCR("
           | "L" s5t ( "SP"|"SE"|"SD"|"SS"|"SF" ) T | "L" c# "S" C | ("CU"|"CD") C

logica    ::= somma
somma     ::= prodotto { "O" prodotto }                  ; "O" senza operando
           | ramoO { ramoO }                              ; solo O x / ON x / O( )
prodotto  ::= primo { fattore }
primo     ::= ( "A" | "AN" | "O" | "ON" ) bit | "A(" somma ")" | confronto | logicaBox
fattore   ::= ( "A" | "AN" ) bit | "A(" somma ")" | "A(" confronto ")"
           | "NOT" | ( "FP" | "FN" ) bit | "=" bit "A" bit          ; (#)
ramoO     ::= ( "O" | "ON" ) bit | "O(" somma ")" | "O(" confronto ")"
confronto ::= "L" val "L" val CMP                         ; CMP ∈ ==I <>I … <=R
logicaBox ::= "A" L*                                      ; riprende un nodo salvato

boxEN     ::= logica "JNB" _n corpoBox [ errore ] _n ":" ( "NOP 0" | "A BR" uscite )
corpoBox  ::= "L" val { "L" val } OPBOX "T" val | "L" val "T" val | chiamata
errore    ::= "AN OV" "SAVE" "CLR"
chiamata  ::= "CALL" blocco [ "," db ] [ "(" parametri ")" ]
```

La grammatica descrive l'**insieme** delle forme accettate; i vincoli fini (quale forma di
parallelo, dove vanno i BLD, numerazione delle etichette) li controlla la prova di andata e
ritorno di §6.1.

### 6.4 Algoritmo di ricostruzione (valutazione simbolica)

Si "esegue" la rete su simboli invece che su bit, imitando la CPU ([AWL] cap. 1):

1. Stato: espressione corrente E (RLO simbolico), flag `primo` (/FC = 0), pila delle parentesi
   (ogni voce salva E, il tipo `A(`/`O(`/…, e il gruppo OR aperto), gruppo OR per `O` senza operando.
2. `A x` con `primo` → E = x; altrimenti E = serie(E, x). `AN` uguale con NOT x come contatto NC.
   `O x` → E = parallelo(E, x) (con `primo`, E = x). `O` senza operando chiude il prodotto corrente
   in un ramo e ne apre uno nuovo.
3. `A(`/`O(` → spinge lo stato e riparte con `primo`; `)` → chiude e combina in serie/parallelo.
4. `L`, `L`, `CMP` → E = confronto (contatto CMP); se preceduto da logica senza `A(` → **non
   rappresentabile** (la CPU butterebbe via la logica precedente).
5. `NOT` → E = serie(E, NOT). `FP m` → serie(E, (P) m). `= b` seguito subito da `A b` → serie(E,
   (#) b).
6. `= L*` (bit oltre i TEMP) → registra il nodo condiviso N = E; un successivo `A L*` (primo) →
   E riparte da N, cioè **stesso nodo** nel grafo (ramo a T).
7. Uscite (`=`, `S`, `R`, `JC`, …) → aggiungono un'uscita al nodo E; `=`/`S`/`R` non cambiano E,
   quindi uscite consecutive stanno sullo stesso nodo.
8. `JNB _n` → apre un box: il suo EN è E; si legge il corpo fino a `_n:` e lo si confronta con le
   sagome di §4 (MOVE, ADD_I, CALL…); `A BR` dopo `_n:` rende E = ENO del box.
9. A fine rete: tutti i nodi devono essere raggiungibili dalla barra (grafo connesso), nessuna
   istruzione fuori sagoma. Poi si genera AWL dal grafo e si confronta (§6.1).

Uso di `L*`: serve l'interfaccia del blocco per sapere dove finiscono i TEMP dichiarati. Un bit L
dentro i TEMP dichiarati è una variabile dell'utente: `= #tmp` + `A #tmp` diventa `(#)`, non un
nodo condiviso.

### 6.5 Blocchi caricati dalla CPU

Nella CPU mancano nomi delle etichette, simboli e commenti, ma restano confini di rete, `BLD` e
`NOP` ([B] `mc7.md` §4). Il decodificatore genera etichette (`M000`…); la ricostruzione KOP non
dipende dai nomi, quindi funziona anche lì, a patto che l'interfaccia del blocco (lunghezza dei
TEMP) sia nota per riconoscere i bit `L*`.

---

## 7. Copertura del pacchetto `awl` di BaaPortal

### 7.1 Istruzioni che KOP richiede

Controllo fatto su `packages/awl/src/instructions.ts` e `lexer.ts`:

| istruzione/forma richiesta da KOP                                     | in `awl`? | nota                                                                                                                                                                                             |
| --------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `A AN O ON`, `O` senza operando, `A( O( )`, `NOT`, `= S R`            | sì        |                                                                                                                                                                                                  |
| `FP FN SAVE SET CLR`                                                  | sì        |                                                                                                                                                                                                  |
| `A BR`, `AN OV`, contatti di stato                                    | sì        | classe `status`                                                                                                                                                                                  |
| `JNB JU JC JCN`                                                       | sì        |                                                                                                                                                                                                  |
| `NOP 0`, `BLD n`                                                      | sì        | anche nel simulatore (non fanno niente)                                                                                                                                                          |
| `MCR( )MCR MCRA MCRD`, `OPN`, `CC`, `UC`, `CALL` con parametri, `BEC` | sì        |                                                                                                                                                                                                  |
| `SP SE SD SS SF`, `CU CD`, `LC`, `L S5T#…`, `L C#…`                   | sì        |                                                                                                                                                                                                  |
| tutte le operazioni dei box (§4.5–4.8)                                | sì        |                                                                                                                                                                                                  |
| **etichette `_001`** (prima lettera `_`)                              | **no**    | `LABEL` e `LABEL_REF` in `lexer.ts`/`parser.ts` vogliono una lettera iniziale; serve una regola per le etichette generate (accettarle in lettura; il controllo può rifiutarle se scritte a mano) |

Nessuna istruzione nuova: l'unico buco è la sintassi delle etichette generate.

### 7.2 Mnemonici tedeschi delle istruzioni usate

| int. | ted. | int. | ted.  | int. | ted. |
| ---- | ---- | ---- | ----- | ---- | ---- |
| A    | U    | JNB  | SPBNB | SP   | SI   |
| AN   | UN   | JU   | SPA   | SE   | SV   |
| A(   | U(   | JC   | SPB   | SD   | SE   |
| BR   | BIE  | JCN  | SPBN  | SF   | SA   |
| OPN  | AUF  | BEC  | BEB   | CU   | ZV   |
| C    | Z    | Q    | A     | CD   | ZR   |

Gli altri (`O`, `ON`, `NOT`, `SAVE`, `FP`, `FN`, `CLR`, `SET`, `NOP`, `BLD`, `CC`, `UC`, `MCR(`, `SS`,
`LC`) sono uguali. Attenzione: `SE` internazionale (impulso prolungato) è `SV` in tedesco, mentre `SE`
tedesco è `SD` internazionale (ritardo all'inserzione).

---

## 8. Ipotesi aperte (da confermare con catture STEP 7)

Ogni ipotesi si chiude creando la rete in STEP 7 V5.5 in KOP (con licenza regolare, solo uso
normale), passando la vista ad AWL, e caricando il blocco in un PLC o nel nostro server di prova per
avere anche i byte MC7. Una rete per ipotesi; blocco FC con TEMP noti (es. 4 byte) e OB1.

| id  | ipotesi                                                                                                                                           | rete di prova                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| H1  | il primo ramo di un parallelo sulla barra è `O x` (non `A x`)                                                                                     | 2 contatti in parallelo → bobina                        |
| H2  | scelta fra `O` senza operando e `O(`…`)`; parallelo seguito da serie dentro `A(`…`)`                                                              | §2.3, §2.4, §2.6                                        |
| H3  | `(#)` genera `= b` + `A b`                                                                                                                        | §2.9                                                    |
| H4  | i bit L dei nodi condivisi partono dal primo byte dopo i TEMP, in ogni rete; ordine di assegnazione dei bit                                       | ramo a T in FC con 4 byte TEMP e in OB1                 |
| H5  | presenza, numero e posizione dei `BLD` (102, 103…) nei rami a T e nei box su nodi condivisi                                                       | §2.10, §4.10                                            |
| H6  | forma di SR/RS: uscita Q come `A M` + `=`; Q non collegato                                                                                        | §2.12 con e senza Q                                     |
| H7  | bobina collegata direttamente alla barra: ammessa? genera `SET` + `=`?                                                                            | bobina sulla barra                                      |
| H8  | box POS/NEG: `A( A x FP m )` in serie                                                                                                             | §2.13                                                   |
| H9  | temporizzatori/contatori a box: ordine delle uscite (BI, BCD, Q), `NOP 0` se Q libero                                                             | §3.2, §3.4 con pin vuoti                                |
| H10 | confronto come primo elemento: senza parentesi                                                                                                    | §3.5 entrambe le varianti                               |
| H11 | etichette automatiche numerate per rete o per blocco                                                                                              | due reti con un MOVE condizionato ciascuna              |
| H12 | box senza errore (MOVE, WAND_W, BCD_I…) con ENO collegato: `_001: A BR` diretto, oppure `SET/SAVE/CLR`; EN sulla barra + ENO collegato            | MOVE con ENO → bobina, con EN da contatto e sulla barra |
| H13 | box REAL e funzioni (SQRT, ABS…): controllo d'errore `AN OV`                                                                                      | ADD_R, SQRT, ABS con ENO                                |
| H14 | scorrimenti: ordine dei `L`, forma con N costante                                                                                                 | SHL_W con N = 3 e con N = MW                            |
| H15 | box in cascata ENO → EN: `_001: A BR` + `JNB _002`                                                                                                | ADD_I → MOVE                                            |
| H16 | bobina `(CALL)` sulla barra: `UC FC n` o `CALL FC n`                                                                                              | `(CALL)` con e senza contatto                           |
| H17 | CALL box: niente fra la CALL e `_001:`; ENO libero → `NOP 0`                                                                                      | CALL FC con/ senza ENO                                  |
| H18 | pin BOOL di FC/FB con logica: bit L + `BLD 103`, ordine rispetto a EN                                                                             | FC con 2 ingressi BOOL cablati a contatti               |
| H19 | `X`/`XN` non mostrati in KOP (solo FUP)                                                                                                           | rete AWL `X I0.0 / X I0.1 / = Q4.0` → vista KOP         |
| H20 | lingua del blocco (byte `02` KOP dell'header) e reti non convertibili: STEP 7 apre il blocco in KOP e lascia in AWL solo le reti non riconosciute | FC con una rete KOP e una AWL libera                    |

Finché un'ipotesi è aperta, il generatore usa la forma indicata qui, e i test di BaaPortal la
verificano **solo** sul comportamento (simulatore e CPU di prova), non sull'identità con STEP 7.

---

## 9. Fonti

- Siemens, _Ladder Logic (LAD) for S7-300 and S7-400 Programming_, Reference Manual 05/2010,
  A5E02790079-01 — capitoli 1–14 (elementi), appendice C.1 "EN/ENO Mechanism" (i quattro casi del
  sommatore), 10.9 (dati locali usati dal compilatore, rami a T), 10.14 (RET = SAVE; BEC), 6.1
  (etichette). <https://cache.industry.siemens.com/dl/files/822/45523822/att_82001/v1/s7kop__b.pdf>
- Siemens, _Statement List (STL) for S7-300 and S7-400 Programming_, Reference Manual 03/2006,
  A5E00706960-01 — 14.13 BLD, 14.14–14.15 NOP 0/1, cap. 1 (logica a bit, /FC), cap. 2 (confronti),
  cap. 12 (temporizzatori, esempio con `LC`).
  <https://cache.industry.siemens.com/dl/files/496/18653496/att_97188/v1/AWL_e.pdf>
- Edizione precedente del manuale KOP (A5E00706949-01):
  <https://support.automation.siemens.com/WW/llisapi.dll/csfetch/18654395/KOP_e.pdf>
- PLCtalk, "Step 7 LAD > STL ???" (JNB/NOP 0 come confini dei box grafici; non tutto l'AWL torna in
  KOP): <https://www.plctalk.net/threads/step-7-lad-stl.7793/>
- PLCtalk, "step 7 stl to lad" (senza i NOP 0 e i BLD giusti l'AWL non torna in KOP):
  <https://www.plctalk.net/threads/step-7-stl-to-lad.36335/>
- PLCtalk, "Step 7 closing a parallel branch in Ladder":
  <https://www.plctalk.net/forums/threads/step-7-closing-a-parallel-branch-in-ladder.61137/page-2>
- SPS-Forum, "CALL BLD im OB1 ???" (gruppi `U`/`=`/`BLD 103` davanti a una CALL; ipotesi BLD 1/2,
  14/15): <https://www.sps-forum.de/threads/call-bld-im-ob1.28715/>
- SPS-Forum, "= L ???" (bit L generati per KOP/FUP): <https://www.sps-forum.de/threads/l.16229/>
- SPS-Forum, "BLD und NOP": <https://www.sps-forum.de/threads/bld-und-nop.34255/>; "Bildaufbau-Operationen
  Liste" (elenco BLD 130–133, 255, probabilmente STEP 5):
  <https://www.sps-forum.de/threads/bildaufbau-operationen-liste.45346/>
- BaaPortal, `docs/protocollo/mc7.md` §2.4–2.5, §3.2, §4 (osservazioni sui blocchi reali: BLD delle
  CALL, etichette assenti nel blocco, base dei temporanei).

Nota: le pagine dei forum sono state consultate tramite i riassunti dei motori di ricerca (l'accesso
diretto era bloccato); i fatti presi solo da lì sono marcati [F] o "ipotesi".
