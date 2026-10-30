# FUP e SCL (in prova)

Guida breve ai due linguaggi in prova della versione 1.0.0 (SCL esteso nella 1.1, nella 1.4 e nella 1.8). Funzionano nel simulatore, ma non sono mai stati provati su una CPU reale.

## Attivarli

_Impostazioni → Funzioni sperimentali_. Da quel momento, in _Inserisci → Nuovo blocco…_ si possono scegliere anche _FUP_ e _SCL_. I blocchi FUP e SCL già creati si aprono sempre, anche con l'impostazione spenta.

## FUP

1. **Stesso disegno del KOP.** Un blocco FUP ha le stesse reti di un blocco KOP, disegnate a riquadri: `&` per una serie di contatti, `>=1` per un parallelo, un cerchietto per una negazione, le uscite (`=`, `S`, `R`, temporizzatori, contatori, salti) a destra con l'operando sopra.
2. **Cambiare linguaggio.** _Passa a KOP/FUP_ sopra i segmenti (o _Modifica → Cambia linguaggio KOP/FUP_) cambia il linguaggio del blocco senza perdere nulla. Si può annullare.
3. **Modificare.** Un clic (o Tab) seleziona un elemento; le frecce passano al precedente (← ↑) o al successivo (→ ↓). Doppio clic o Invio modificano l'operando (Invio conferma, Esc annulla) e Canc elimina l'elemento. **Selezione multipla** (anche in KOP): Maiusc+clic, Ctrl/Cmd+clic o Maiusc+frecce estendono la selezione agli elementi vicini della stessa serie (non di serie diverse, né dentro e fuori da un ramo); Canc li elimina, Ctrl/Cmd+C li copia, Ctrl/Cmd+X li taglia e Ctrl/Cmd+V li incolla dopo l'elemento selezionato (con id nuovi; gli appunti sono interni all'editor).
4. **Aggiungere elementi.** Come in KOP, senza cambiare linguaggio. Un elemento nuovo va dopo quello selezionato; senza selezione, in fondo alla serie principale.
   - **Tavolozza delle istruzioni:** un clic inserisce nella selezione; trascinando su un elemento si inserisce dopo di lui. Un FC o un FB trascinato dall'albero del progetto diventa un box CALL.
   - **Tasti e barra sopra il segmento:**

     | Tasto    | Azione                                                                                                                                                                                                                                      |
     | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | F2       | Entrata `&`: un contatto dopo l'entrata selezionata, nello stesso riquadro                                                                                                                                                                  |
     | F3       | Entrata `&` negata                                                                                                                                                                                                                          |
     | F8       | Entrata `>=1`: un'entrata in parallelo a quella selezionata                                                                                                                                                                                 |
     | F9       | Chiude il `>=1` dopo l'entrata selezionata (le entrate fra i due ci entrano)                                                                                                                                                                |
     | N        | Nega: un contatto passa NA ↔ NC; la prima entrata di un riquadro riceve il cerchietto; un confronto, un POS/NEG o un `>=1` più avanti nella serie va in un gruppo `A( … NOT )` con il cerchietto solo su di lui; su un cerchietto lo toglie |
     | F7       | Uscita `=` (seleziona quella vuota, se c'è)                                                                                                                                                                                                 |
     | Shift+F7 | Nuova uscita con una sua entrata (ramo a T)                                                                                                                                                                                                 |

     Le uscite `S`, `R`, temporizzatori, contatori e salti si aggiungono dalla tavolozza; i box (MOVE, ADD_I…) dalla tavolozza o da _Box vuoto_ nella barra.
5. **Compilare.** Come un blocco KOP: stesso AWL generato, stessi errori.
6. **Osservare.** _Osserva programma_ funziona come in KOP: il bordo inferiore di ogni entrata, riquadro e uscita è verde (1), blu tratteggiato (0) o grigio (non elaborato), senza colore se fuori dalla finestra di osservazione, con lo stato anche nel testo dell'elemento; accanto agli operandi dei box compare il valore.

## SCL

1. **Il testo.** Un blocco SCL ha un solo testo, fatto solo di istruzioni. Le variabili si dichiarano nella tabella dell'interfaccia del blocco, come negli altri linguaggi.
2. **Esempio** (FC con ingressi `a`, `b` INT, uscita `max` INT e `alto` BOOL):

   ```
   IF a > b THEN
     max := a;
   ELSE
     max := b;
   END_IF;
   alto := max > 100 AND NOT "Blocco";
   ```

3. **Operandi.** Le variabili dell'interfaccia si scrivono con o senza `#`, i simboli globali tra virgolette (`"Motore"`) e gli indirizzi come `M0.0`, `MW10` o `MD20`, anche di periferia (`PIW256` si legge, `PQW256` si scrive) e coi mnemonici tedeschi (`E0.0`, `AW4`, `PEW256`). Elementi e membri: `#valori[3]`, `#asse.pos`, `"Dati".ricetta[2].tempo`. L'indice può essere un'espressione INT o DINT, anche prima di un membro e come uscita di una chiamata: `#valori[#i]`, `#m[#i, #j + 1]`, `"Dati".v[#i]`, `#punti[#i].x`, `"Scala"(ingresso := 1, fuori => #valori[#i]);`. Con un indice fuori dai limiti l'elemento non si scrive, la lettura dà 0 e BR (ENO) va a 0.
4. **Tipi e costanti.** BOOL, BYTE, WORD, DWORD, INT, DINT, REAL, TIME, S5TIME, DATE, TIME_OF_DAY, CHAR e (in parte) DATE_AND_TIME. Le costanti si scrivono anche in esadecimale o binario (`16#FF`, `2#1010`) o col tipo (`INT#5`, `W#16#00FF`, `L#100000`); durate, date e caratteri come `T#1m30s`, `S5T#2s`, `D#2024-01-01`, `TOD#12:30:00`, `'A'`. Due TIME si sommano e si sottraggono (`#t := #t + T#500ms;`). Due BOOL si confrontano con `=` e `<>`; BYTE, WORD e DWORD si confrontano senza segno (`W#16#8000 > W#16#7FFF`). Fra tipi diversi si converte con le funzioni `…_TO_…` (per esempio `DINT_TO_INT`, `INT_TO_WORD`, `TIME_TO_DINT`, `CHAR_TO_INT`, `DATE_TO_DINT`, `S5TIME_TO_TIME`, `TIME_TO_S5TIME`). `x ** y` è la potenza, in REAL. Un DATE_AND_TIME si scrive da una costante (`#inizio := DT#2024-03-15-08:00:00;`) o da un'altra variabile e si confronta. `MD` non è mai REAL da solo: per leggerlo come REAL usa `DWORD_TO_REAL`. Se `DINT_TO_INT`, `ROUND` o `TRUNC` ricevono un valore che non ci sta, BR (l'ENO del blocco) va a 0.
5. **Variabili intere.** Un STRUCT, un ARRAY o un UDT si copia in un'altra variabile dello stesso tipo: `#ricetta := "Dati".ricette[2];`. Una STRING si scrive da una costante o da un'altra STRING (`#nome := 'Pompa 1';`, `#copia := #nome;`, i caratteri in più si perdono), si confronta con `=`, `<>`, `<`, `>`, `<=`, `>=` (per codice dei caratteri) e `LEN(#nome)` ne dà la lunghezza. Le funzioni `CONCAT`, `LEFT`, `RIGHT`, `MID`, `FIND`, `INSERT`, `DELETE` e `REPLACE` si usano come in STEP 7 (`#nome := CONCAT(#prefisso, ' 1');`, `#pos := FIND(#nome, 'mpa');`) senza le FC della libreria; se il risultato non ci sta, o una posizione non è valida, BR (ENO) va a 0.
6. **Chiamate.** Una FC si chiama col suo nome e i parametri per nome, `:=` per gli ingressi e `=>` per le uscite: `"Scala"(ingresso := #grezzo, fuori => #valore);`. Se la FC restituisce un valore si usa in un'espressione: `#v := "Somma"(a := 1, b := 2) * 2;`. Si possono anche dare tutti i parametri per posizione, nell'ordine dell'interfaccia: `#v := "Somma"(1, 2);`. Un FB si chiama col suo DB di istanza, `"Nastro_DB"(avvio := TRUE);`, o come multi-istanza, `#nastro(avvio := TRUE);`; i suoi parametri STRUCT, ARRAY, UDT e STRING (ingressi e uscite) si passano come gli altri. Gli ingressi di una FC non si scrivono.
7. **Cicli.** Dentro FOR, WHILE e REPEAT, `EXIT;` esce dal ciclo e `CONTINUE;` passa al giro dopo. Nel CASE un ramo può avere un intervallo: `1..5:`.
8. **Errori.** Mentre si scrive, gli errori sono sottolineati nel testo, segnati nel margine ed elencati sotto come «Riga N: …» (un clic porta alla riga). Si vedono tutti, non solo il primo: anche quelli del controllo AWL sul codice generato, alla riga SCL che l'ha prodotto. Un errore blocca la compilazione.
9. **Scrivere.** Parole chiave, tipi, costanti, commenti, variabili e simboli hanno colori diversi. Il completamento (Ctrl+Spazio, e da solo dopo `#`, `"` e `.`) propone le variabili dell'interfaccia, i tag e i DB, i membri dopo `"DB".` o `#s.`, le chiamate di FC e DB di istanza con tutti i parametri (`"Scala"(ingresso := , fuori => )`), dentro le parentesi di una chiamata i parametri che mancano, i membri anche dopo un indice (`#punti[#i].`) e le parole chiave.
10. **Rinominare.** Rinominare un tag, un blocco, un membro di DB o una variabile dell'interfaccia aggiorna anche il testo SCL, in un solo passo di _Annulla_; un parametro si rinomina nelle chiamate di quel blocco. Rinominando una FC si aggiorna anche il suo nome usato come valore di ritorno nel suo codice.
11. **Compilare e provare.** _Compila_ traduce il testo in AWL e compila quello. Si carica nel simulatore e si prova con una tabella di controllo.
12. **Osservare.** _Osserva programma_ (simulatore o CPU) mostra a fine riga il valore assegnato (`max := a;` → `42`), il risultato delle condizioni di IF, WHILE e UNTIL (`TRUE`/`FALSE`), il selettore di CASE e la variabile di FOR. Le righe non eseguite nel ciclo sono grigie, con «non elaborato»; `?` vuol dire nessun dato (fuori dalla finestra di osservazione della CPU o in attesa). Nei cicli si vedono i valori dell'ultimo giro. Il tasto esadecimale/decimale cambia il formato di INT e DINT. Mentre si modifica il testo l'osservazione si sospende; dopo la conferma si ricompila e si ricarica.

Che cosa c'è e che cosa manca (tipi, istruzioni, conversioni): `docs/limiti-noti.md`, sezioni _FUP in prova_ e _SCL in prova_.
