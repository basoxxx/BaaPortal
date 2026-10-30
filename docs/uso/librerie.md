# Librerie

Guida breve alle librerie (tappa 7B): modelli da riusare tra PLC e progetti, e la libreria standard IEC.

## Dove sono

Task card _Librerie_ (a destra), con due sezioni:

- **Libreria di progetto:** sta dentro il `.baap` e si salva col progetto. Le modifiche si annullano con Ctrl+Z come le altre.
- **Librerie globali:** la _Libreria standard IEC_, sempre presente e in sola lettura, e i file `.baaplib` aperti con _Apri libreria globale…_ o creati con _Nuova libreria globale…_.

## Modelli

Un modello è la copia master di uno o più oggetti: blocchi (OB, FB, FC, DB), UDT, tabelle delle variabili e tabelle di controllo. Quando si aggiunge un oggetto, il modello porta con sé anche le sue dipendenze: gli UDT e gli FB usati come tipo (anche annidati), l'FB di un DB di istanza e i blocchi chiamati (CALL, UC, CC). Un FB entra quindi con i suoi UDT e gli FC che chiama.

- **Aggiungere:** trascinare blocchi, UDT o tabelle dall'albero del progetto su una libreria (o su una sua cartella), oppure selezionare un oggetto nell'albero e premere _Aggiungi la selezione_. Le tabelle di controllo si aggiungono solo con _Aggiungi la selezione_.
- **Cartelle:** _Nuova cartella_; un modello si sposta trascinandolo su una cartella.
- **Ricerca:** il campo _Cerca_ filtra per nome e commento del modello e per nome e numero degli oggetti che contiene.
- **Menu contestuale** (tasto destro o tasto Menu): _Inserisci nel PLC_, _Apri in sola lettura_ (la sorgente AWL di blocchi e UDT, l'elenco delle tabelle), _Copia nella libreria di progetto_ (dalle librerie globali), _Rinomina_ (F2), _Elimina_ (Canc).

## Inserire nel PLC

_Inserisci nel PLC_ copia il modello nel PLC selezionato nell'albero (o nel primo), oppure si trascina il modello su un nodo qualsiasi del PLC. Se un nome o un numero è già usato, una finestra chiede per ogni oggetto:

- **Rinomina:** l'oggetto prende un nome libero (`Nome_1`) e, se serve, un numero libero. Le CALL, i tipi e i DB di istanza dentro il modello seguono il nuovo nome.
- **Rinumera** (solo se è preso il numero ma non il nome): stesso nome, primo numero libero.
- **Sostituisci:** l'oggetto del PLC con lo stesso nome o lo stesso numero viene eliminato e sostituito. Non si offre se il nome è di un tag o di una costante.
- **Salta:** l'oggetto non si copia; gli altri oggetti del modello useranno quello che c'è già nel PLC con lo stesso nome.

Tutto l'inserimento è un solo passo da annullare. Gli oggetti finiscono nella radice delle cartelle del PLC.

## Librerie globali

- Un file `.baaplib` si apre **in sola lettura**; _Modifica_ lo apre per la modifica, _Sola lettura_ torna indietro. Con modifiche non salvate il nome ha un asterisco e compare _Salva_; chiudendo (×) BaaPortal chiede conferma.
- Lo stesso file non si apre due volte. Un file rovinato, troppo grande o di una versione più recente non si apre e un messaggio dice perché.

## Libreria standard IEC

Scritta da zero in AWL dalle definizioni della IEC 61131-3, senza codice Siemens. Ogni blocco ha interfaccia e commento ed è provato nel simulatore.

| Blocchi                                 | Numeri     | Cosa fa                                                                      |
| --------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `LIMIT_INT`, `LIMIT_DINT`, `LIMIT_REAL` | FC 500–502 | `RET_VAL = MIN(MAX(IN, MN), MX)`                                             |
| `MAX_INT`, `MAX_DINT`, `MAX_REAL`       | FC 503–505 | il maggiore tra `IN1` e `IN2`                                                |
| `MIN_INT`, `MIN_DINT`, `MIN_REAL`       | FC 506–508 | il minore tra `IN1` e `IN2`                                                  |
| `SEL_INT`, `SEL_DINT`, `SEL_REAL`       | FC 509–511 | `IN0` con `G = 0`, `IN1` con `G = 1`                                         |
| `MUX_INT`, `MUX_DINT`, `MUX_REAL`       | FC 512–514 | `IN0…IN3` secondo `K` (0…3); `K` fuori campo: `RET_VAL = 0` e ENO = 0        |
| `R_TRIG`, `F_TRIG`                      | FB 500–501 | impulso di un ciclo sul fronte di salita o di discesa di `CLK`               |
| `SR`, `RS`                              | FB 502–503 | bistabile a set dominante (`S1`, `R`) e a reset dominante (`S`, `R1`) → `Q1` |

I numeri sono in un campo libero e si rinumerano all'inserimento se sono presi. Gli FB vanno chiamati con un DB di istanza (`CALL "R_TRIG", "R_TRIG_DB"`). Temporizzatori e contatori IEC (SFB 0–5) sono già blocchi di sistema e non stanno nella libreria.
