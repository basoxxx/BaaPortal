# Simulatore: strumenti di test

Guida breve all'uso del simulatore integrato (piano 2C). La semantica della CPU simulata è in `docs/protocollo/sim.md`; per le istruzioni AWL si veda il manuale AWL S7-300/400.

1. **Simulazione.** Il pulsante _Simulazione_ della barra degli strumenti accende o spegne la CPU simulata; la barra di stato mostra «Simulazione: STOP» o «Simulazione: RUN». Chiudere il progetto spegne la simulazione.
2. **Carica nel dispositivo.** Compila e carica i blocchi nella CPU simulata; se la CPU è in STOP chiede se avviarla. _Avvia CPU_ e _Arresta CPU_ cambiano modo.
3. **Pannello CPU** (task card _Test_): LED RUN, STOP e SF, avvio, arresto e cancellazione totale, tempi di ciclo, avvisi per SFC e SFB non simulati, buffer di diagnostica e pila dei richiami.
4. **Pannello I/O** (task card _Test_): un clic su un bit di ingresso lo commuta; le uscite sono in sola lettura. Il campo PIW scrive un valore analogico. «Simula guasto» genera OB82 o OB86 con l'indirizzo del modulo. Non c'è FORCE.
5. **Osserva programma.** Con un blocco AWL aperto e già caricato, mostra a fine riga RLO, STA, ACCU1, ACCU2 e parola di stato della prima esecuzione nell'ultimo ciclo. Il tasto esadecimale/decimale cambia il formato degli accumulatori.
6. **Tabelle di controllo.** Nell'albero, cartella _Tabelle di controllo_: _Aggiungi nuova tabella di controllo_. Ogni riga ha operando (simbolico o assoluto), formato, valore di stato e valore di comando. _Osserva tutto_ legge i valori; _Comanda_ scrive una volta i valori di comando.

I limiti noti sono in `docs/limiti-noti.md`, sezione «Strumenti di test (piano 2C)».
