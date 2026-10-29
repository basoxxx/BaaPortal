# Editor KOP

Guida breve all'editor a contatti (KOP, piano 4A). Un blocco KOP si disegna; BaaPortal ne ricava il codice AWL e compila quello.

1. **Creare un blocco KOP.** _Inserisci → Nuovo blocco…_, scegli OB, FB o FC e come linguaggio _KOP_. Il blocco si apre con un segmento vuoto: c'è già una bobina senza operando. I DB non hanno KOP.
2. **Disegnare.** Ogni segmento ha la sua barra degli strumenti: _NA_, _NC_, _Bobina_, _Nuovo ramo a T_, _Apri ramo_, _Chiudi ramo_ e _Box vuoto_ (menu con tutti i box). Gli elementi si inseriscono dopo quello selezionato.
3. **Tasti.** Con il segmento in primo piano:
   - **F2** contatto normalmente aperto, **F3** contatto normalmente chiuso, **F7** bobina, **Maiusc+F7** nuovo ramo a T;
   - **F8** apre un ramo parallelo, **F9** lo chiude;
   - **Invio** modifica l'operando dell'elemento selezionato, **Tab** passa al campo successivo, **Esc** annulla;
   - **Canc** elimina l'elemento; le **frecce** spostano la selezione.
4. **Operandi.** Si scrivono come in AWL (`I 0.0`, `M 1.2`, un simbolo tra virgolette) e si controllano a ogni modifica. Un operando mancante o una forma non ammessa appare in _Problemi_ come «Segmento n: …» e sull'elemento. Un clic sulla voce di _Problemi_, su un messaggio di compilazione o su un risultato di _Trova_ seleziona l'elemento nel grafico (KOP e FUP) e lo porta in vista.
5. **Tavolozza.** Con un blocco KOP in primo piano, la task card _Istruzioni → Istruzioni di base_ mostra gruppi (logica a bit, temporizzatori, contatori, confronto, trasferimento, matematica, conversione, logica a parola, scorrimento, salti, controllo del programma). Un clic inserisce nel segmento attivo, oppure si trascina sul segmento.
6. **Chiamare un blocco.** Si trascina un FC o un FB dall'albero sul segmento: nasce un box _CALL_ con i parametri del blocco chiamato. Per un FB senza DB di istanza, il DB va scritto a mano.
7. **Mostra AWL.** Il pulsante sotto ogni segmento apre il codice AWL generato, di sola lettura. Gli operandi sono scritti in forma assoluta con il `%` (`A %I0.0`, `= %Q4.0`). Serve a vedere che cosa verrà compilato.
8. **Annulla e salva.** Ogni modifica è un passo di _Annulla/Ripristina_. Il progetto salva il grafico e il codice AWL generato.
9. **Convertire da AWL.** _Modifica → Converti in KOP/FUP_ trasforma un blocco AWL in KOP se ogni segmento ha una rete KOP che dà le stesse istruzioni; altrimenti il blocco non cambia e la finestra _Informazioni_ dice quali segmenti restano AWL e perché. In un blocco KOP o FUP lo stesso comando converte i segmenti AWL che si possono; un solo segmento si converte dal suo menu (⋯). Ogni conversione è un passo di _Annulla_. Si riconoscono le forme che BaaPortal stesso genera (`docs/limiti-noti.md`); un segmento scritto a mano con altre forme resta AWL, in sola lettura.
10. **Compilare e provare.** Il blocco KOP si compila come gli altri (_Compila → Software_): gli errori del disegno bloccano la compilazione. Si carica nel simulatore e si prova con una tabella di controllo.

## Che cosa non si può ancora fare

- Nessun box dentro un ramo parallelo né nella logica di un pin: un box va in serie sulla linea principale, o all'inizio di un ramo a T.
- La rinomina dei simboli aggiorna anche gli operandi del grafico (KOP e FUP). _Trova_ cerca nel codice generato: un risultato dentro un solo operando si può sostituire (cambia l'operando nel grafico); quello che tocca testo solo generato (come `L`, `==I`, `:=`) resta non modificabile.
- Un segmento KOP non torna AWL modificabile. Il passaggio KOP ↔ FUP c'è, in prova (`docs/uso/fup-scl.md`).
- Un blocco KOP con errori non entra nella sorgente AWL esportata.

L'elenco completo delle scelte e dei limiti è in `docs/limiti-noti.md`, sezione _Editor KOP (piano 4A)_.
