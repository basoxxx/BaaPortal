# Riferimenti incrociati e struttura di richiamo

Guida breve alle informazioni sul programma (tappa 7A): dove si usa ogni operando, chi chiama chi, quali indirizzi usa il programma e quanta memoria occupa. Valgono per tutto il programma di un PLC, in AWL, KOP, FUP e SCL. Nell'albero del progetto, la cartella _Informazioni sul programma_ di ogni PLC ha una voce per ciascuna vista (doppio clic per aprirla); la scheda aperta riporta la selezione sulla sua voce.

## Riferimenti incrociati

1. **Aprirli.** _Strumenti → Riferimenti incrociati_, oppure Maiusc+F11. Dal menu dell'albero (tasto destro su un blocco o sul PLC) c'è la stessa voce; la voce _Riferimenti incrociati_ della cartella _Informazioni sul programma_ li apre su tutto il programma, senza filtro.
   - Da un blocco aperto, Maiusc+F11 filtra sull'operando sotto il cursore (AWL e SCL) o sul primo operando dell'elemento selezionato (KOP e FUP).
   - Dall'albero, su un blocco, filtra sul blocco: chi lo chiama e che cosa usa.
2. **La tabella.** Una riga per ogni punto d'uso, con:
   - **Operando:** l'indirizzo assoluto (`%I0.0`, `%MW10`, `%DB1.DBW2`, `%T5`, `FC1`). Simbolo e indirizzo dello stesso dato sono la stessa voce: `A "Start"` e `A I 0.0` stanno insieme.
   - **Simbolo:** il tag della tabella delle variabili, il membro del DB come scritto (`"Dati".Vel`) o il nome del blocco.
   - **Tipo:** il tipo del tag o del membro, altrimenti quello della dimensione dell'accesso (`Bool`, `Byte`, `Word`, `DWord`).
   - **Punto d'uso:** blocco, segmento e riga (in SCL la riga del testo SCL; in KOP e FUP il segmento). In una CALL di FB, fra parentesi, il DB di istanza o la multi-istanza.
   - **Accesso:** lettura, scrittura, lettura e scrittura, richiamo, apertura, con l'istruzione AWL accanto.
3. **Tipi di accesso.**

   | Istruzione                                                      | Accesso                                                                               |
   | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
   | `A`, `AN`, `O`, `ON`, `X`, `XN`, `L`, `LC`, `LAR1`, `LAR2`      | Lettura                                                                               |
   | `=`, `S`, `R`, `T`, `TAR1`, `TAR2`                              | Scrittura                                                                             |
   | `SP`, `SE`, `SD`, `SS`, `SF`, `FR` (temporizzatori), `CU`, `CD` | Scrittura (avvio, abilitazione, conteggio)                                            |
   | `FP`, `FN`                                                      | Lettura e scrittura (il merker del fronte)                                            |
   | `CALL`, `UC`, `CC`                                              | Richiamo del blocco e del DB di istanza                                               |
   | Parametri attuali di una CALL                                   | Secondo il parametro: IN lettura, OUT e RET_VAL scrittura, IN_OUT lettura e scrittura |
   | `OPN`                                                           | Apertura del DB                                                                       |

   KOP, FUP e SCL valgono come il loro AWL generato: una bobina è `=`, un contatto è `A`, un'assegnazione SCL è `T` o `=`.

4. **Il filtro.** Cerca nell'operando, nel simbolo e nel blocco del punto d'uso, senza maiuscole, spazi, `%` e virgolette (`M 10.3` trova `%M10.3`). Un nome intero (`FC1`, `Dati`) trova solo sé stesso e i suoi membri, non `FC10` o `Dati2`.
5. **Accessi sovrapposti.** Sotto un operando, `↔` elenca quelli che toccano almeno un bit in comune (`%MW10` con `%M10.3` e `%MB11`). Con _Mostra gli accessi sovrapposti_ il filtro aggiunge anche loro, segnati «sovrapposto».
6. **Andare al punto d'uso.** Un clic sul punto d'uso apre il blocco sulla riga (AWL e SCL) o seleziona l'elemento (KOP e FUP).

## Struttura di richiamo

1. **Aprirla.** _Strumenti → Struttura di richiamo_, la sua voce nella cartella _Informazioni sul programma_ dell'albero o il menu dell'albero.
2. **Struttura di richiamo.** Un albero per ogni OB: sotto ogni blocco i blocchi che chiama (CALL, UC, CC, multi-istanze, SFC e SFB), nell'ordine del codice, col DB di istanza e il punto della chiamata. Un blocco che richiama un blocco già sopra di lui è segnato «ricorsione» e non si apre oltre.
3. **Blocchi non usati.** In fondo, i blocchi (FC, FB, DB) che nessun blocco chiama, apre o usa.
4. **Dipendenze.** La seconda vista mostra ogni blocco con, sotto, chi lo chiama.
5. **Clic.** Sul nome apre il blocco; sul punto della chiamata apre il blocco che chiama, alla chiamata.

## Elenco di assegnazione

1. **Aprirlo.** _Strumenti → Elenco di assegnazione_, la sua voce nella cartella _Informazioni sul programma_ o il menu dell'albero (su un PLC o un blocco).
2. **Area.** Scegli Ingressi, Uscite, Merker, Temporizzatori o Contatori. In alto: quanti byte (o elementi per T e C) il programma usa su quelli della CPU.
3. **La griglia.** Una riga per ogni byte usato o con un tag, otto celle per i bit. Una cella dice se il bit è letto (R), scritto (W) o entrambe (RW); il punto `•` indica un tag della tabella dei simboli; il contorno rosso, operandi che si sovrappongono (`%MW10` con `%M10.3`). A destra, le colonne B, W e D mostrano l'accesso con operandi a byte, parola e doppia parola che coprono il byte. Un byte oltre il limite della CPU è segnato «oltre la CPU».
4. **Clic su una cella.** Apre i riferimenti incrociati filtrati su quell'indirizzo.

## Risorse

1. **Aprirle.** _Strumenti → Risorse_, la sua voce nella cartella _Informazioni sul programma_ o il menu dell'albero (su un PLC o un blocco).
2. **Blocchi.** Per ogni blocco la memoria di caricamento, quella di lavoro e i dati locali (TEMP), con il totale e il limite di memoria di lavoro della CPU. Un blocco che non si compila è «da compilare». I valori sono stime dai blocchi compilati.
3. **Dati locali per percorso.** Per ogni OB, il percorso di chiamata che somma più dati locali, col limite della CPU; se lo supera compare l'avviso «oltre il limite della CPU».
4. **Aree usate.** I, Q, M, T e C usati contro i limiti della CPU.

I limiti sono in [limiti noti](../limiti-noti.md#informazioni-sul-programma-piano-7a).
