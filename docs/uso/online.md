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

## Carica nel dispositivo (piano 3B)

Con il collegamento attivo, _Carica nel dispositivo_ (barra degli strumenti, menu _Online_, o menu contestuale di uno o più blocchi nell'albero) scrive i blocchi del progetto nella CPU.

1. **Anteprima.** BaaPortal compila ciò che è cambiato e mostra una riga per blocco, con lo stato del confronto e l'azione: _Carica_, _Nessuna azione_ oppure _Cancella_. Un blocco che c'è solo nella CPU non si cancella mai da solo: la riga parte con _Nessuna azione_ e la cancellazione va scelta a mano. Un blocco da compilare (errori o non ancora compilato) non si può caricare.
2. **Avviso RUN.** Se la CPU è in RUN e il caricamento contiene OB o cambia l'interfaccia di un FB o di un DB, compare un avviso: caricare in RUN può portare la CPU in STOP. Si può spuntare _Arresta la CPU_: la CPU si arresta prima del caricamento e resta in STOP alla fine.
3. **Conferma.** Premendo _Carica_ compare una finestra di conferma del sistema. Il pulsante predefinito è _Annulla_: se si chiude la finestra, non si scrive nulla.
4. **STOP e avvio.** Se si è arrestata la CPU, dopo il caricamento resta in STOP. Per riavviarla si usa _Avvia CPU_ (con una sua conferma).
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

I limiti noti sono in `docs/limiti-noti.md`, sezioni «Online (piano 3A)» e «Caricamento e confronto (piano 3B)».
