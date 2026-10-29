# Online: dispositivi accessibili e collegamento

Guida breve al collegamento a una CPU S7-300 (piano 3A) e alle operazioni sulla CPU: carica nel dispositivo, confronto, comandi e carica dal dispositivo (piano 3B). Per la rete e i parametri della CPU si vedano i manuali della CPU e del CP usati.

1. **Dispositivi accessibili.** Il comando si apre dalla barra degli strumenti o dal menu _Online_. Scegli l'interfaccia di rete e avvia la ricerca: compaiono i dispositivi con indirizzo IPv4 nella stessa sottorete. Non compaiono le CPU senza indirizzo IP.
2. **Indirizzo manuale.** Scrivi `192.0.2.10` oppure `192.0.2.10:102` e premi _Aggiungi indirizzo_. Sono ammessi solo indirizzi IPv4, non nomi.
3. **Rack e slot.** Rack da 0 a 7 e slot da 0 a 31. Per una CPU S7-300 diretta di solito sono rack 0 e slot 2; si vedano i manuali.
4. **Tipo di collegamento.** _Diretto_ per una CPU con interfaccia PN o per un CP 343-1; _Gateway RFC 1006_ per raggiungere una CPU MPI/DP, con il TSAP remoto in esadecimale.
5. **Collega.** Seleziona una riga e premi _Collega_. L'accesso si salva nelle proprietà della CPU del progetto. Online la barra di stato mostra il modulo e il modo, e l'interfaccia diventa arancione.
6. **Pannello CPU.** Nella task card _Test_ i LED RUN e STOP seguono il modo della CPU, che si aggiorna ogni secondo. Da qui si danno anche i comandi della CPU (vedi sotto).
7. **Collegamento interrotto.** Se la CPU non risponde più, l'app torna offline e mostra il messaggio «Collegamento interrotto». _Interrompi collegamento online_ chiude il collegamento a mano.
8. **Simulazione.** La simulazione e il collegamento a un PLC si escludono: va spenta una prima di accendere l'altro.

## Collegamento MPI (piano 3M)

Per una CPU che ha solo la porta MPI, come la 313C, ci sono due strade.

1. **Gateway MPI→Ethernet (consigliato).** Un gateway che dichiari RFC 1006 o ISO-on-TCP, per esempio IBH Link S7++, Helmholz NETLink PRO o Hilscher NT 50-MPI. Si collega come una CPU in rete, con il tipo _Gateway RFC 1006_ (punto 4 sopra). È la strada più provata: il protocollo è lo stesso del TCP.
2. **PC Adapter seriale o adattatore USB-COM (sperimentale).** Il PC Adapter RS232 e gli adattatori USB che si presentano come porta COM e parlano lo stesso protocollo. In _Dispositivi accessibili_ scegli il tipo _Adattatore MPI (seriale o USB-COM)_, poi:
   - la porta (_Aggiorna_ rilegge l'elenco dopo aver attaccato l'adattatore);
   - velocità di trasmissione e parità della porta: di solito 38400 e dispari;
   - indirizzo MPI della CPU (di solito 2), indirizzo del PC (0), indirizzo più alto (HSA, di solito 31) e velocità del bus (di solito 187,5 kbit/s);
   - la variante del protocollo: _Automatico_ prova v1 e poi v2.

   _Cerca_ elenca gli indirizzi presenti sul bus; un clic su un indirizzo lo usa per la CPU, che deve avere un indirizzo diverso da quello del PC. _Collega_ salva l'accesso nelle proprietà della CPU, come per il TCP. Tutte le funzioni online funzionano allo stesso modo, solo più lente.

   L'adattatore regge una sola sessione alla volta. Durante un'operazione con un collegamento proprio (caricamento nel dispositivo, scrittura delle variabili, ripristino, osservazione di un blocco, stack, caricamento dalla CPU, backup) la sorveglianza della CPU si ferma e riparte da sola alla fine: il collegamento resta online. In quel tempo le letture sul collegamento della finestra (tabelle di controllo, elenco dei blocchi, diagnostica) rispondono «Porta MPI occupata da un'altra operazione» e due operazioni di questo tipo non vanno insieme: la seconda dice «La porta … è già usata da un altro collegamento di BaaPortal».

**Non funzionano:** il PC Adapter USB originale Siemens (6ES7972-0CB20), le schede CP 5611/5711 e gli adattatori PROFIBUS USB Siemens. Usano protocolli chiusi con driver Siemens.

Messaggi tipici:

- «Adattatore MPI non risponde»: porta sbagliata, velocità o parità diverse da quelle dell'adattatore, cavo staccato o adattatore senza alimentazione (prende corrente dalla porta MPI della CPU).
- «Nessuna CPU risponde all'indirizzo MPI …»: l'adattatore funziona ma la CPU ha un altro indirizzo; il messaggio elenca gli indirizzi visti sul bus.
- «La porta … è usata da un altro programma»: chiudi SIMATIC Manager, TIA Portal o l'altro programma che tiene aperta la porta.
- «La porta … è già usata da un altro collegamento di BaaPortal»: un'altra finestra è online sulla stessa porta, o è in corso un'altra operazione (per esempio l'osservazione di un blocco); aspetta che finisca o fermala.

## Carica nel dispositivo (piano 3B)

Con il collegamento attivo, _Carica nel dispositivo_ (barra degli strumenti, menu _Online_, o menu contestuale di uno o più blocchi nell'albero) scrive i blocchi del progetto nella CPU.

1. **Anteprima.** BaaPortal compila ciò che è cambiato e mostra una riga per blocco, con lo stato del confronto e l'azione: _Carica_, _Nessuna azione_ oppure _Cancella_. Un blocco che c'è solo nella CPU non si cancella mai da solo: la riga parte con _Nessuna azione_ e la cancellazione va scelta a mano. Un blocco da compilare (errori o non ancora compilato) non si può caricare.
2. **Avviso RUN.** Se la CPU è in RUN e il caricamento contiene un OB, cancella un blocco (di qualunque tipo) che c'è solo nella CPU, oppure tocca un FB o un DB non uguale a quello della CPU (diverso o non leggibile), compare un avviso: caricare in RUN può portare la CPU in STOP. Si può spuntare _Arresta la CPU_.
3. **Conferme.** Con _Arresta la CPU_ spuntato compaiono due finestre di conferma del sistema: prima quella per lo STOP, poi quella per il caricamento. Senza la spunta, solo quella del caricamento. Il pulsante predefinito è _Annulla_: se si chiude la finestra, non si scrive nulla.
4. **Avvio.** Dopo un caricamento riuscito, se la CPU è stata arrestata da BaaPortal o non era in RUN, BaaPortal chiede «Avviare la CPU?» (predefinito _No_). Con _Sì_ compare la conferma del sistema per il RUN. Se si risponde _No_, la CPU resta com'è e si può riavviare più tardi con _Avvia CPU_ (con una sua conferma).
5. **Controllo prima di scrivere.** Prima di ogni scrittura BaaPortal rilegge il modulo e controlla che sia quello previsto (numero d'ordine, e numero di serie se lo conosce); se non coincide, non scrive.
6. **Esito.** L'esito (caricati, cancellati, fallito) resta nella finestra. Alla fine il confronto riparte da solo.

## Confronto e distintivi

Il confronto parte da solo al collegamento e dopo ogni caricamento; si rilancia con _Confronta con la CPU_ nel menu _Online_. Ogni blocco nell'albero mostra un distintivo:

- **Uguale alla CPU**: stesso checksum e stessa lunghezza MC7.
- **Diverso dalla CPU**.
- **Solo nel progetto**: la CPU non ha il blocco.
- **Solo nella CPU**: il progetto non ha il blocco (nella cartella _Solo online_).
- **Da compilare**: il blocco è cambiato dopo l'ultimo confronto o non ha un compilato valido. Dopo una modifica i distintivi non si aggiornano da soli: va rilanciato il confronto.
- **Illeggibile**: le informazioni del blocco non si sono potute leggere dalla CPU.

I blocchi di sistema (SDB, SFC, SFB) non si confrontano.

## Editor di confronto

Sul menu contestuale di un blocco che risulta _diverso_ c'è _Confronta online/offline_: apre una scheda con checksum, lunghezze e data del codice dei due lati, e sotto le reti con le righe cambiate (a sinistra il progetto, a destra la CPU). Il confronto è sul codice compilato di entrambi i lati. _Ricarica dalla CPU_ rilegge il blocco. Se il blocco non è compilato, il confronto è sul testo sorgente e gli operandi simbolici possono risultare diversi. Se la CPU ha un blocco che non si decodifica, si vedono i suoi byte in esadecimale.

## Comandi della CPU

Nella task card _Test_ e nel menu _Online_:

- **Avvia CPU** (RUN) e **Arresta CPU** (STOP).
- **Copia RAM in ROM**: scrive il programma della RAM nella memoria di caricamento.
- **Comprimi**: compatta la memoria della CPU.

Ogni comando chiede una conferma. **MRES (cancellazione totale) non è disponibile da remoto**: si fa solo con il selettore di modo della CPU. Il pulsante è presente ma disabilitato.

## Carica dal dispositivo

Dal portale (_Carica dal dispositivo_) o dal menu _Online_ si apre la finestra _Dispositivi accessibili_: si sceglie la CPU e si preme _Carica dal dispositivo_. BaaPortal legge dalla CPU i blocchi di programma e crea un **progetto nuovo**, non salvato, con i blocchi in AWL. Non porta simboli né commenti. I blocchi che la CPU rifiuta o che non si decodificano non vengono caricati: sono elencati nel commento del progetto nuovo. Se c'è un progetto con modifiche non salvate, compare prima la solita domanda di salvataggio.

## Online e diagnostica

Con il collegamento attivo, nell'albero del progetto (o con _Apri Online e diagnostica_ nella task card _Test_) si apre la scheda _Online e diagnostica_. A sinistra ci sono le pagine, a destra quella scelta. In alto si vedono sempre il modo della CPU e i suoi LED.

- **Generale**: modulo, numero d'ordine, versione, MMC, ultimo cambio di modo e livello di protezione.
- **Buffer di diagnostica**: gli eventi della CPU, il più recente in cima. Un clic su una riga mostra i dettagli. _Blocca visualizzazione_ ferma l'aggiornamento per leggere con calma. Il buffer si aggiorna circa ogni secondo, solo finché la scheda è aperta.
- **Tempo di ciclo**: ultimo, minimo e massimo, con il tempo di sorveglianza.
- **Memoria**: totale, occupato e libero per ogni area.

Se la CPU non fornisce un'informazione, la pagina dice «non disponibile su questa CPU». Con la simulazione attiva la scheda rimanda al Pannello di comando CPU.

## Imposta ora

La pagina _Imposta ora_ mostra l'ora della CPU, quella del PC e la differenza. Si può impostare l'ora del PC con un solo pulsante, oppure scrivere a mano data (AAAA-MM-GG) e ora (hh:mm:ss) e premere _Applica_. È una scrittura nella CPU: chiede conferma. L'ora è quella locale del PC, senza fuso né ora legale.

## Tabelle di controllo online

Una tabella di controllo funziona anche con la CPU vera. Con il collegamento attivo, _Osserva tutto_ legge i valori di stato ogni mezzo secondo circa. _Comanda_ scrive i valori di comando: prima compare la conferma, con l'elenco degli indirizzi e dei valori. Le righe che online non si possono usare (per esempio le uscite di periferia PQ) dicono «non disponibile online». PI, temporizzatori e contatori si osservano ma non si comandano. Al massimo 200 righe osservate. Se una scrittura si interrompe a metà, le righe già scritte restano scritte. L'«esito sconosciuto» riguarda tutta la richiesta in corso (fino a 20 righe): le righe successive dicono «Non scritto», e se la CPU rifiuta la richiesta le righe dicono «Rifiutato dalla CPU».

## Backup online

_Online_ > _Carica backup dal dispositivo online…_ (o il menu della cartella _Backup online_) chiede dove salvare e copia nel file `.baapbak` i blocchi OB, FB, FC e DB e i blocchi di sistema (SDB) della CPU. Si può fare anche in RUN, e con _Interrompi_ si ferma. Il backup non cambia né la CPU né il progetto. Per rimetterlo nella CPU c'è il ripristino sperimentale (sotto).

## Osservazione del programma online

Con il collegamento attivo e un blocco AWL aperto, _Osserva programma_ (barra degli strumenti o menu _Online_) mostra a destra di ogni riga RLC, STA, ACCU1 e STW; le caselle _ACCU2_ e _AR1_ ne aggiungono altri due e riducono le righe osservate. Le righe che la CPU non elabora sono in grigio. In un blocco KOP o FUP il grafico si colora con gli stessi dati (`docs/uso/kop.md`). Il blocco della CPU deve essere uguale a quello compilato del progetto: se è diverso, la barra lo dice e propone _Confronta con la CPU_.

- Si osservano solo le righe visibili, entro i limiti di una PDU (24 righe con STW e ACCU1, meno con più registri); se sono di più la barra dice «Osservate le prime N righe».
- I valori arrivano al massimo ogni 250 ms: sono quelli di un ciclo ogni tanto. Mentre si osserva il tempo di ciclo della CPU aumenta, e la barra di stato lo ricorda («Osservazione attiva»).
- In STOP non ci sono valori. Spegnendo l'osservazione, interrompendo il collegamento o chiudendo la finestra, il job di test sulla CPU si cancella.
- Una sola osservazione per CPU.

## Forzamento

BaaPortal non forza valori e non ha tabelle di forzamento: il protocollo di forzamento non è stabilito. Se sulla CPU c'è un forzamento attivo (LED FRCE), la diagnostica e la barra di stato dicono «Forzamento attivo sulla CPU». Per forzare o terminare un forzamento si usa TIA Portal o STEP 7. Con un forzamento attivo il ripristino di un backup si rifiuta.

## Funzioni sperimentali

_Opzioni_ > _Impostazioni_ > _Online_ > «Funzioni sperimentali (non provate su una CPU reale)», spenta per default, abilita gli stack di chiamata e il ripristino di un backup. Non sono mai state provate su una CPU reale. L'impostazione vale per l'interfaccia di questo computer; le conferme del ripristino chiedono comunque il consenso e dicono «sperimentale».

## Stack di chiamata (sperimentale)

Nella scheda _Online e diagnostica_, la pagina _Stack di chiamata_ legge BSTACK, USTACK (stack delle interruzioni) e LSTACK solo col pulsante, e solo con la CPU in STOP o HOLD: in RUN non parte nessuna richiesta. Con l'impostazione spenta la pagina rimanda alle impostazioni. Se la CPU risponde in un formato non riconosciuto si vede l'esadecimale.

## Ripristino di un backup (sperimentale)

Con l'impostazione attiva e il collegamento online, _Online_ > _Ripristina backup nel dispositivo… (sperimentale)_ (o il menu della cartella _Backup online_) apre la finestra di ripristino.

1. _Scegli file…_ apre un `.baapbak`. La tabella mostra, per ogni blocco, l'azione: _Carica_, _Cancella_ (SDB assenti nel backup), _Saltato_ (per esempio SDB 2, creato dalla CPU) o _Resta nella CPU_ (blocchi presenti solo nella CPU).
2. In testa gli avvisi: funzione sperimentale mai provata su una CPU reale, la CPU andrà in STOP, e i DB tornano ai valori salvati nel backup mentre merker, temporizzatori e contatori no.
3. La casella _Avvia la CPU al termine (avviamento a caldo)_ è spenta per default.
4. _Ripristina_ chiede le conferme del sistema (sovrascrittura, con l'elenco dei blocchi non toccati, STOP, avvio). Annullare la conferma di sovrascrittura o quella di STOP non cambia nulla; annullare «Avviare la CPU?» lascia il backup caricato e la CPU in STOP.

Prima di toccare la CPU il ripristino si rifiuta se c'è un forzamento attivo, se ci sono job di test sulla CPU, se la CPU è di un tipo diverso da quello del backup, se la protezione della CPU non permette la scrittura, se il backup è incompleto (blocchi non letti) o se contiene SDB fuori dagli intervalli documentati. L'avanzamento sta nella barra di stato con _Interrompi_, che ferma prima del passo successivo. L'esito mostra, per ogni blocco, _Caricato_, _Cancellato_, _Saltato_, _Resta nella CPU_, _Rifiutato dalla CPU_, _Esito sconosciuto_ o _Non caricato_; se la CPU è rimasta in STOP c'è il pulsante _Avvia CPU_. Alla fine il confronto online riparte.

Un ripristino interrotto lascia la CPU in STOP con una configurazione parziale.

I limiti noti sono in `docs/limiti-noti.md`, sezioni «Online (piano 3A)», «Caricamento e confronto (piano 3B)», «Diagnostica online (piano 3C)» e «Osservazione online, stack e ripristino (piano 3D)».
