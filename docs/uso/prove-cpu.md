# Prove su una CPU S7-300 reale

Questa è la lista di prove per la versione 1.5.0. BaaPortal non è mai stato provato su una CPU reale: i test automatici girano contro un PLC finto e contro catture di rete pubbliche. Queste prove servono a sapere che cosa funziona davvero.

**Regola fissa:** le prove della parte B scrivono nella CPU. Si fanno **solo su una CPU non in produzione**: una CPU di scorta o una comprata allo scopo, mai su quella di una macchina che lavora. La parte A legge soltanto.

Per ogni prova, annota l'esito:

- **ok**;
- **ko**, con che cosa è successo, il messaggio esatto e uno screenshot;
- **non provata**.

In caso di problemi, salva anche il progetto (`.baap`) e, se è possibile, il file del kit di raccolta (`docs/kit-raccolta.md`).

## Prima di iniziare

- [ ] Annota il modello della CPU (numero d'ordine e firmware) e come è collegata: Ethernet integrata, CP 343-1, gateway RFC 1006 o adattatore MPI seriale/USB-COM (con marca e modello dell'adattatore).
- [ ] Fai un backup del programma della CPU con lo strumento che usi di solito, prima di qualsiasi prova della parte B.
- [ ] Installa BaaPortal 1.5.0 da _Releases_ su GitHub. Al primo avvio vanno autorizzati Windows («Esegui comunque») e macOS (vedi le note di rilascio).

## M. Adattatore MPI (solo se colleghi la CPU con l'adattatore seriale o USB-COM)

Prima della parte A, con la CPU ferma o non critica:

1. [ ] **Porta.** In _Dispositivi accessibili_, tipo _Adattatore MPI_: la porta dell'adattatore compare nell'elenco. Annota il nome (COMx o /dev/…).
2. [ ] **Adattatore.** _Cerca_ con i valori predefiniti (38400, dispari, bus 187,5 kbit/s, variante automatica): compare l'elenco degli indirizzi del bus, con quello della CPU. Se l'adattatore non risponde, riprova con la variante v1 e poi v2, e annota quale funziona.
3. [ ] **Collegamento.** _Collega_ all'indirizzo della CPU: la barra di stato mostra modulo e modo.
4. [ ] **Stacco.** Durante il collegamento stacca il cavo dalla CPU: compare un messaggio chiaro e l'app torna offline, senza bloccarsi.
5. [ ] Poi fai le parti A e B con questo collegamento.

Se qualcosa non va, annota il messaggio esatto, la variante e le impostazioni usate: il protocollo dell'adattatore è scritto dalla documentazione pubblica e non è mai stato provato su un adattatore vero.

## A. Sola lettura (va bene anche su una CPU in produzione, a macchina ferma o non critica)

1. [ ] **Ricerca.** _Online → Dispositivi accessibili_: la CPU compare nella ricerca, oppure si aggiunge con l'indirizzo IP manuale. Annota rack e slot usati.
2. [ ] **Collegamento.** _Collega_ (oppure Ctrl+K): l'interfaccia diventa arancione, la barra di stato mostra modulo e modo, e i LED RUN/STOP nel pannello CPU corrispondono a quelli veri.
3. [ ] **Diagnostica.** _Online e diagnostica_: dati generali, LED, selettore dei modi, buffer di diagnostica con i testi, tempo di ciclo, memoria e ora. Confrontali con quello che sai della CPU.
4. [ ] **Carica dal dispositivo** in un progetto nuovo: arrivano tutti i blocchi, e i blocchi AWL si aprono e si leggono bene.
5. [ ] **Confronto.** Dopo il caricamento, i blocchi risultano _Uguale alla CPU_.
6. [ ] **Osservazione.** Apri un blocco AWL in esecuzione e accendi _Osserva_: i valori cambiano e sono plausibili.
7. [ ] **Tabella di controllo** in sola osservazione: i valori di ingressi, uscite e merker corrispondono a quelli veri.
8. [ ] **Backup online** (`.baapbak`): il file si crea e si riapre.
9. [ ] **Interrompi collegamento** (Ctrl+M), poi stacca il cavo durante un collegamento: compare «Collegamento interrotto» e l'app torna offline.

## B. Scrittura: solo su una CPU non in produzione

10. [ ] **OB1 AWL di prova.** Scrivi un OB1 piccolo, per esempio `A I 0.0`, `= Q 4.0`, e caricalo con _Carica nel dispositivo_ (Ctrl+L). Controlla che compaiano l'anteprima e le conferme e che non parta niente senza conferma. La CPU accetta il blocco, va in RUN e l'uscita segue l'ingresso.
11. [ ] **RUN / STOP** dal pannello CPU, con le conferme. Prova anche la copia RAM→ROM e la compressione.
12. [ ] **Comando di variabili** da una tabella di controllo, con conferma: il merker o l'uscita cambia davvero.
13. [ ] **Imposta ora:** l'ora della CPU cambia.
14. [ ] **Blocco KOP:** la stessa logica dell'OB1 in KOP, caricata ed eseguita.
15. [ ] **Blocco FUP (in prova):** attiva _Impostazioni → Funzioni sperimentali_, crea un FC in FUP oppure converti il blocco KOP con _Cambia linguaggio KOP/FUP_, richiamalo da OB1 e caricalo.
16. [ ] **Blocco SCL (in prova):** crea un FC in SCL con, per esempio, `#out := #a + #b;`, un IF e un FOR, richiamalo da OB1 e caricalo. Controlla i valori con una tabella di controllo.
17. [ ] **Temporizzatori e contatori** (S_ODT, S_CU) in AWL o KOP: tempi e conteggi corretti.
18. [ ] **Ripristino di un backup (sperimentale):** ripristina il backup del punto 8 e confronta.
19. [ ] **Stack di chiamata (sperimentale),** con la CPU in STOP dopo un errore provocato: gli stack si leggono.

## Che cosa rimandare

Manda le annotazioni, i progetti e gli screenshot dei **ko** a chi sviluppa BaaPortal. Le prove ok diventano «provate su CPU reale» in `docs/limiti-noti.md`.
