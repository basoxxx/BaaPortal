# Riferimenti incrociati e struttura di richiamo

Guida breve alle informazioni sul programma (tappa 7A): dove si usa ogni operando e chi chiama chi. Valgono per tutto il programma di un PLC, in AWL, KOP, FUP e SCL.

## Riferimenti incrociati

1. **Aprirli.** _Strumenti → Riferimenti incrociati_, oppure Maiusc+F11. Dal menu dell'albero (tasto destro su un blocco o sul PLC) c'è la stessa voce.
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

1. **Aprirla.** _Strumenti → Struttura di richiamo_, la voce dell'albero _Informazioni sul programma_ (doppio clic) o il menu dell'albero.
2. **Struttura di richiamo.** Un albero per ogni OB: sotto ogni blocco i blocchi che chiama (CALL, UC, CC, multi-istanze, SFC e SFB), nell'ordine del codice, col DB di istanza e il punto della chiamata. Un blocco che richiama un blocco già sopra di lui è segnato «ricorsione» e non si apre oltre.
3. **Blocchi non usati.** In fondo, i blocchi (FC, FB, DB) che nessun blocco chiama, apre o usa.
4. **Dipendenze.** La seconda vista mostra ogni blocco con, sotto, chi lo chiama.
5. **Clic.** Sul nome apre il blocco; sul punto della chiamata apre il blocco che chiama, alla chiamata.

I limiti sono in [limiti noti](../limiti-noti.md#informazioni-sul-programma-piano-7a).
