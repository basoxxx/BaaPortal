# Limiti noti

Qui si elencano i limiti conosciuti di BaaPortal: cose che oggi mancano, sono incomplete o restano da verificare. La lista si aggiorna alla fine di ogni piano. **Alla fine di tutte le tappe si riguarda punto per punto insieme all'utente**, per decidere che cosa sistemare.

Per ogni voce si indica che cosa succede oggi. "Errore chiaro" vuol dire che BaaPortal si ferma e lo dice: non produce mai codice sbagliato senza avvisare.

## Mancanze aperte

- **Stato della tappa 1.** Tutti i punti della spec §9 sono fatti (piani 1A–1F) tranne uno: la conformità su CPU reale, che resta **in sospeso**. La spec §6 dice che la tappa 1 non si chiude senza i test di conformità su CPU reale: la tappa 1 resta quindi **formalmente aperta** e si chiude solo quando quelle prove saranno fatte.
- **Prove di conformità su una CPU reale.** Ora esistono i mezzi (carica nel dispositivo ed esecuzione, piano 1D-bis), ma le prove restano **in sospeso**: non c'è una S7-300 non in produzione. Le farà l'amico dell'utente a prodotto finito. I blocchi compilati da BaaPortal non sono mai stati caricati né eseguiti su una CPU. Il simulatore della tappa 2 controllerà la coerenza interna, ma non sostituisce questa verifica (spec §10). Il punto di decisione della spec §11 resta aperto.
- **Provenienza 1D-bis.** Scrittura di variabili, carica nel dispositivo e STOP/avvio esistono e sono verificati contro il finto PLC e contro i byte delle catture pubbliche (`cisa/snap7.pcap` per scrittura, stop e avvio a freddo; la cattura del download di un blocco). Il giro completo «la CPU accetta ed esegue un blocco compilato da BaaPortal» non è mai stato provato su una CPU reale (spec §10). Il riavvio a caldo è verificato solo in parte. Dopo i piani 3B e 3C sono fatti nell'app, ma **mai provati su una CPU reale**: `_DELE` (cancella blocchi), `_GARB` (comprimi), `_MODU` (copia RAM→ROM), STOP e avvio (RUN, con avviamento a caldo), impostazione dell'orologio e l'interfaccia online. **Non sono fatti**: MRES da remoto (pulsante disabilitato, vedi «Caricamento e confronto (piano 3B)»), l'avviamento a freddo dall'interfaccia e la forzatura (vedi «Osservazione online, stack e ripristino (piano 3D)»).

## Online (piano 3A)

- **Sola lettura.** Il solo collegamento (sorveglianza, LED) è in sola lettura. Le scritture sono del piano 3B, sotto.
- **Mai provato su una CPU reale.** Il collegamento è provato solo contro il PLC di prova (server S7 locale con CPU simulata). Non è stato provato né su una CPU reale, né su un CP 343-1, né su un gateway RFC 1006.
- **Ricerca limitata.** La ricerca trova solo dispositivi con un indirizzo IPv4 nella stessa sottorete dell'interfaccia scelta. Non c'è DCP, quindi una CPU senza indirizzo IP non compare; il DCP arriva nella tappa 6.
- **MPI/DP.** Solo attraverso un gateway RFC 1006.
- **Sonda provata solo in locale.** La sonda di rete è stata provata solo su loopback (127.0.0.1), mai su una rete vera.
- **Eventi di ricerca.** Gli eventi della ricerca non hanno una protezione contro un renderer sostituito: se la pagina viene ricaricata durante una ricerca, gli eventi restano indirizzati alla finestra.
- **Campi di rack e slot.** Rack da 0 a 7 e slot da 0 a 31.
- **Impostazioni di accesso salvate nel progetto.** Indirizzo, porta, rack e slot restano nel file del progetto, nelle proprietà della CPU; non sono impostazioni dell'utente.

## Caricamento e confronto (piano 3B)

- **Mai provato su una CPU reale.** Ogni scrittura (carica nel dispositivo, cancellazione, RUN/STOP, copia RAM in ROM, comprimi) è provata solo contro il PLC di prova e il simulatore. Prima di usarla su una macchina, provarla su una CPU che non è in produzione.
- **MRES non disponibile da remoto.** Non c'è un servizio documentato nelle fonti pubbliche per una S7-300: si usa il selettore di modo della CPU. Il pulsante è disabilitato.
- **Il confronto usa checksum e lunghezze (lunghezza MC7), non il contenuto byte per byte.** Che il checksum letto dalla CPU coincida con quello del file compilato è un'ipotesi non verificata su una CPU reale.
- **Blocchi di sistema (SDB).** Il backup online li copia (3C, solo esportazione); non si caricano né si confrontano.
- **Carica dal dispositivo senza simboli né commenti.** Il progetto nuovo ha solo i blocchi in AWL.
- **Blocchi non caricati.** I blocchi che la CPU rifiuta o che non si decodificano non vengono caricati: sono elencati nel commento del progetto nuovo. I loro byte originali non si conservano.
- **Cancellazione dei blocchi.** `_DELE` usa il filesystem 'A', come TIA nella cattura reale (§10.5). È verificato per gli SDB; per OB, FB, FC e DB è un'ipotesi.
- **Controllo dell'identità prima di scrivere.** Confronta il numero d'ordine, e il numero di serie solo se ce l'hanno entrambi i lati.
- **Il confronto non si aggiorna a ogni modifica.** Parte al collegamento, dopo ogni caricamento e col comando _Confronta con la CPU_. Dopo una modifica di un blocco il suo distintivo passa a «Da compilare» e resta tale finché non si rilancia il confronto; una modifica fatta sulla CPU da altri non si vede finché non lo si rilancia.
- **Editor di confronto.**
  - Le reti si allineano per posizione.
  - I titoli e i commenti delle reti non si confrontano.
  - I DB si confrontano come elenco di membri.
  - Con un compilato assente o non aggiornato il confronto è sul testo sorgente e gli operandi simbolici possono risultare diversi.
  - I blocchi molto grandi ricadono su un confronto per posizione, con una nota.
- **Caricamento interrotto senza ripristino.** Se un caricamento si interrompe (finestra chiusa dopo la conferma, uscita dall'app, cavo staccato, un blocco rifiutato) non c'è nessun ripristino: la CPU tiene un programma parziale e può essere ancora in RUN. Uno STOP fatto da BaaPortal non viene annullato dopo un errore o un annullamento. Chiudendo la finestra o uscendo durante la scrittura, l'app chiede prima se interromperla.
- **Un secondo collegamento PG per ogni scrittura.** Ogni scrittura apre un collegamento PG in più accanto a quello della sorveglianza. Se la CPU non ha collegamenti liberi (per esempio sono tutti usati da pannelli HMI), la scrittura fallisce alla connessione.
- **L'avviso RUN è un'euristica.** Non vede un cambio di interfaccia di un FC; tratta «diverso» come «interfaccia cambiata».
- **Nessuna gestione di password o livelli di protezione.** Una CPU protetta in scrittura rifiuta le scritture e BaaPortal non può inserire la password.
- **Conferme native solo in italiano.** Le finestre di conferma del processo principale non sono tradotte.
- **Cerca/Sostituisci nella scheda di confronto.** Agisce sul blocco sorgente del progetto, non sul testo mostrato (il compilato decodificato).
- **Firmware del progetto nuovo.** Un progetto creato dalla CPU usa il firmware letto dalla CPU solo se è nel catalogo; altrimenti usa il più recente e mostra un avviso.
- **DB creati con SFC 22 (CREAT_DB).** Vengono cancellati da un nuovo caricamento (vedi «Simulatore (piano 2A)», «Blocchi cancellati»). Su una CPU reale non è provato.

## Diagnostica online (piano 3C)

- **Mai provato su una CPU reale.** La diagnostica, l'impostazione dell'ora, il comando delle variabili e il backup sono provati solo contro il PLC di prova. Impostare l'ora e comandare le variabili non sono mai stati provati su una CPU reale.
- **Testi degli eventi da documentazione.** Solo 4 ID evento sono stati visti in una cattura; gli altri hanno il testo preso dalla documentazione, oppure quello generico.
- **«Ritentiva = indice 5» di `0x0013` è un'ipotesi.** La memoria è verificata su una sola cattura.
- **Il tempo di sorveglianza (OB80) viene dalla documentazione.**
- **Ora locale del PC.** L'ora si imposta in ora locale del PC, senza fuso né ora legale.
- **Impostazione dell'ora con protezione di livello 2.** Il PLC di prova risponde `0xD241`, ma è un'ipotesi (§12.0).
- **Il PLC di prova registra ogni STOP come `0x4304` «STOP da PG».** Una CPU reale distingue altre cause.
- **L'osservazione usa read var, non lo stato delle variabili TIS.** I valori non sono presi a un punto preciso del ciclo.
- **Niente PQ online, niente comando di PI, T, C, niente forzamento.** Al massimo 200 righe osservate online.
- **Scritture da tabella in più richieste.** Se una fallisce, le precedenti restano scritte. L'«esito sconosciuto» riguarda tutta la richiesta in corso (fino a 20 righe); le righe successive dicono «Non scritto», e un rifiuto della CPU dice «Rifiutato dalla CPU».
- **Numero di richieste nella conferma.** È un massimo calcolato per PDU 240, non il numero esatto.
- **Backup: il ripristino è del 3D (sperimentale).** Non si sa se i DB caricati hanno i valori attuali o quelli iniziali (§19.4).
- **Il backup registra il modo visto per ultimo dalla sorveglianza,** non quello riletto all'inizio.
- **Lettura di un `.baapbak`: risolto nel 3D.** La lettura non si fida più delle dimensioni dichiarate nello zip (vedi «Osservazione online, stack e ripristino (piano 3D)»).
- **Niente messaggi push.** Il buffer si aggiorna ogni secondo, solo con l'editor aperto.
- **`_DELE` usa 'A'.** Vedi «Caricamento e confronto (piano 3B)».
- **Impostazione dell'ora con protezione di livello 3.** Anche la risposta `0xD0A1` è un'ipotesi (§12.0).
- **Il numero di richieste nella conferma è un massimo solo se la CPU concorda una PDU di almeno 240 byte.** Con una PDU più piccola le richieste possono essere di più.
- **Più tabelle con «Osserva tutto» interrogano ognuna per conto suo.** Il limite di 200 righe vale per tabella, e le tabelle aperte ma non in primo piano continuano a interrogare.
- **Il backup continua sul suo collegamento** anche se il collegamento online cade o si va offline: lo ferma solo _Interrompi_.
- **I file `.baapbak` non compaiono nell'albero.** Restano così anche dopo il 3D: si aprono con la finestra dei file (vedi 3D).
- **I record di diagnostica più corti di 20 byte si scartano.**
- **Il pulsante si chiama «Osserva tutto»,** il nome del 2C, e non «Controlla tutto» come in TIA.

## Osservazione online, stack e ripristino (piano 3D)

### Prove

- **Mai provato su una CPU reale.** Lo stato del blocco, gli stack, la lettura di FRCE e il ripristino sono provati solo contro il PLC di prova e contro i byte di una cattura. Stack e ripristino sono **sperimentali**: spenti per default, dietro «Funzioni sperimentali (non provate su una CPU reale)» nelle impostazioni.
- **Funzioni sperimentali solo dall'interfaccia.** L'impostazione sta nel renderer, con le altre impostazioni; il processo principale non la ricontrolla. La difesa nel main sono le conferme native, che dicono «sperimentale». Gli stack sono in sola lettura e solo con la CPU in STOP o HOLD, verificato dal main.

### Osservazione del blocco

- **Lo stato del blocco è verificato su una sola cattura** (OB1, 6 righe, §18.4.1). Sono ipotesi:
  - la SAZ come fine esclusiva della finestra;
  - una riga mancante dal risultato vuol dire «non elaborata» (riga grigia);
  - nessun risultato in 2 s vuol dire «blocco non elaborato» (un FC non chiamato è un caso normale).
    Se fossero sbagliate, una cattura su una CPU vera corregge solo `decodeBlockStatusResult`.
- **DB1 e DB2 non si osservano:** la loro dimensione nel risultato è sconosciuta. Nemmeno AR2.
- **Finestra limitata dalla PDU:** con PDU 240, 24 righe con STW e ACCU1, 16 con ACCU2, 11 con ACCU2 e AR1. Le altre righe visibili restano senza valori. Con una PDU più grande la prima finestra si taglia comunque a 24 righe e poi si allarga (un delete e un create in più). `SAZ` di una finestra tagliata dal main è l'inizio della prima riga scartata, non quello dell'istruzione successiva del testo.
- **Ritmo:** un risultato ogni 250 ms al massimo, non a ogni ciclo come STEP 7: i valori sono quelli di un ciclo ogni tanto.
- **Un'osservazione per CPU,** su un collegamento PG in più. Durante un ripristino sulla stessa CPU l'osservazione si rifiuta.
- **Il blocco deve essere uguale a quello del progetto** (checksum e lunghezza MC7, con la stessa ipotesi del confronto del 3B).
- **Installazione o uscita durante un'osservazione:** l'osservazione si ferma in modo pulito. Se la cancellazione del job è lenta (limite di 1 s alla chiusura) il job può restare sulla CPU; si cancella alla connessione successiva.
- **Il tempo di ciclo aumenta** mentre si osserva (da documentazione). Una CPU in modo processo può limitare lo stato (`0xD0AB`/`0xD0AC`/`0xD0CC`, una sola fonte).
- **In STOP nessun valore.** Cosa risponde la CPU a un block status in STOP è sconosciuto, e il client non lo chiede.
- **Job orfani:** si suppone che la CPU cancelli i job quando il collegamento cade (ipotesi). BaaPortal cancella alla connessione solo quelli che ha registrato in `tis-jobs.json`; un job di un'altra connessione (`0xD0AE`) resta. Il registro scrive subito alla creazione; le cancellazioni si raggruppano e si scrivono dopo 500 ms o all'uscita.

### Forzamento

- **Forzamento non implementato.** Il protocollo di forzamento della S7-300 non è stabilito (§18.5.1: nessuna cattura; la CPU dichiara force selection `0x07` e non force `0x09`), e un forzamento resta attivo anche dopo la disconnessione. BaaPortal mostra solo «Forzamento attivo sulla CPU» dal LED FRCE (SZL `0x0174`/`0x0006`, riletta ogni 5 giri della sorveglianza). Per forzare o terminare un forzamento si usa TIA Portal o STEP 7. Mancano le tabelle di forzamento e la colonna «Forza»: restano nelle mancanze aperte.

### Stack di chiamata (sperimentali)

- Layout da una sola fonte, mai visti in cattura.
- La forma della richiesta è ipotizzata come la lista dei job.
- La risposta in RUN non si conosce, e BaaPortal non chiede.
- Il tipo del registro DB è sconosciuto.
- USTACK è lo stack delle interruzioni (ISTACK `0x03` del documento).

### Ripristino di un backup (sperimentale)

- **Mai provato su una CPU reale.** Solo contro il PLC di prova (in STOP, SDB come blob opachi). Il comportamento reale di una CPU a un download di SDB in RUN, l'ordine degli SDB diversi da 0 e il risultato su moduli e DP/PN sono sconosciuti (proto §19.3).
- **Verificato sul formato solo per gli SDB** (una cattura TIA). L'ordine dei blocchi utente dopo gli SDB è una scelta, come i ritentativi (200 ms × 10 su `0xD2A9`/`0xD2AA`).
- **Non cancella i blocchi utente presenti solo sulla CPU** (`_DELE` dei blocchi utente è un'ipotesi, §10.5): restano e sono elencati («Resta nella CPU»). Si cancellano solo gli SDB assenti nel backup, negli intervalli 0, 1, 3–7, 1000–2999; SDB 2 non si tocca mai. Un SDB del backup fuori dagli intervalli fa rifiutare tutto.
- **Non si sa se i DB del backup hanno i valori attuali** o quelli iniziali (§19.4). Merker, temporizzatori e contatori non tornano.
- **Un ripristino interrotto lascia la CPU in STOP** con una configurazione parziale. Nessuna ripetizione né annullamento: dopo un errore i passi seguenti sono «Non caricato», e il passo in corso quando cade il collegamento è «Esito sconosciuto».
- **Il ripristino si rifiuta per intero** (nessuna conferma di forzatura) se: il backup ha blocchi non letti (`failed`, SDB o no); la CPU ha SDB 0 e il backup no; il numero d'ordine della CPU è diverso; la protezione della CPU è di livello 2 o 3 (BaaPortal non gestisce le password) o illeggibile; il forzamento è attivo o illeggibile (riletto anche sul collegamento del ripristino); la CPU è in HOLD; c'è un job di test (riletto anche subito dopo lo STOP: in quel caso la CPU resta in STOP e nulla è scritto).
- **STOP non confermato in 5 s:** l'esito dice «STOP inviato ma non confermato»: `cpuStopped` è falso ma la CPU potrebbe fermarsi più tardi.
- **`cpuStopped` è falso se la CPU era già in STOP all'avvio** (non l'abbiamo fermata noi).
- **Il filtro `online-restore` ammette** solo i frame canonici del ripristino (lettura, lista dei job, download e `_INSE` con `P`, `_DELE` degli SDB con `A`, STOP e avviamento a caldo). `online-write` rifiuta anche download e `_INSE` di SDB.
- **Lettura del `.baapbak`:** i byte si contano mentre si decomprimono (manifest 64 KB, blocchi la `length` del manifest, al massimo 1 MB ciascuno, 256 MB in tutto); la dimensione dichiarata nell'archivio non conta più.
- **I backup non compaiono nell'albero:** si aprono con la finestra dei file. Tenerne l'elenco vorrebbe dire salvare percorsi nel progetto.

## Editor KOP (piano 4A)

- **Mai provato su una CPU reale.** Il codice generato è provato solo con il simulatore e contro il compilatore MC7 di BaaPortal (spec §5). Nessun blocco KOP è mai stato caricato su una CPU.
- **Nessun marcatore BLD (H5).** Il generatore non scrive i `BLD` che STEP 7 mette nei blocchi KOP. STEP 7 potrebbe quindi riaprire i blocchi generati in AWL invece che in KOP (H20 è aperta: non sappiamo come decida STEP 7 la lingua). Il byte di linguaggio dell'intestazione è `02` (KOP).
- **Schemi AWL: sono ipotesi, non verificate con STEP 7.** Ogni forma viene dalla documentazione pubblica e dalle ipotesi di `docs/linguaggi/kop-awl.md` §8; i test ne verificano il comportamento, non l'identità con STEP 7.
  - **H1, H2:** parallelo sulla barra con `O x`; in un parallelo misto i rami di un solo contatto usano `O x` e tutti gli altri `O(`…`)`, anche se fatti di soli contatti in serie.
  - **H3:** `(#)` genera `= b` seguito da `A b`.
  - **H4:** i bit L dei nodi condivisi partono dal primo byte dopo l'area TEMP, ricominciano in ogni segmento e sono assegnati in pre-ordine.
  - **H6, H9:** flip-flop, temporizzatori e contatori a box: uscita Q con `A istanza` solo se collegata; con Q libero niente `A` e niente `NOP 0`.
  - **H7:** bobina collegata alla barra: `SET` davanti alle uscite che usano l'RLO; lo stesso per il primo pin di un box sulla barra.
  - **H8, H10:** confronto e fronti POS/NEG senza parentesi quando non c'è un RLO davanti (sulla barra, primo in una parentesi, inizio di un ramo a T dalla barra).
  - **H11:** etichette automatiche `_001`…`_999` numerate per blocco; oltre, errore `TOO_MANY_LABELS` e il segmento non genera AWL.
  - **H12:** box che non possono sbagliare (MOVE, logica a parola, ABS…) con ENO collegato: `_00n: A BR` diretto con logica davanti, `SET; SAVE; CLR; A BR` con EN sulla barra.
  - **H13:** box che possono sbagliare: `AN OV; SAVE; CLR` prima di `A BR`. Per ABS non c'è il controllo di OV (non lo scrive).
  - **H14:** scorrimenti: `L N; L IN; <istruzione>; T OUT`.
  - **H15:** box in cascata (ENO verso EN): `A BR` e `JNB _00n`.
  - **H16:** bobina JMP come `JU`, bobina CALL come `UC`.
  - **H17:** box CALL: `A BR` subito dopo la CALL, senza `CLR` (se il blocco chiamato esce con /FC = 1 l'`A BR` si combina con quello); con ENO libero `NOP 0`.
  - **H18:** i pin BOOL con logica di una CALL si calcolano in bit L prima di tutta la serie che porta al box. Una logica di pin che legge un bit scritto più a sinistra nello stesso segmento vede il valore del ciclo precedente.
  - **H19:** `X` e `XN` non si usano in KOP.
  - **SAVE:** generato come `SAVE; CLR` (scostamento dal manuale §2.14). Il comparatore del simulatore combina come `A`, mentre §3.5 dice che «scrive» l'RLO: la traduzione resta corretta perché un confronto con logica davanti è sempre fra parentesi.
- **Ordine delle uscite cambiato.** Le uscite che distruggono l'RLO vanno in fondo al nodo, i salti e i RET per ultimi, con `MCR(` dopo gli altri rami a T. Con più salti o RET in rami a T diversi, il primo eseguito salta le uscite che seguono. Un ramo a T con un salto o un RET si esegue comunque dopo `MCR(`.
- **Rifiutati con un errore chiaro:** NOT, `(#)` o un fronte in un ramo parallelo che ha già logica davanti; NOT senza logica davanti; `(#)` o fronte all'inizio di un ramo dalla barra. OPN, `)MCR`, MCRA e MCRD solo da soli sulla barra.
- **Box.** Ammessi solo in serie sulla linea principale, o come primo elemento di un ramo a T; mai in un ramo parallelo né nella logica di un pin (errori `BOX_IN_PARALLEL`, `BOX_IN_TBRANCH`, `BOX_IN_PIN`).
- **Controlli solo di forma.** L'istanza di un box (`T n`, `C n`, `FC n`, `FB n, DB m`, simbolo, `#locale`, con `%` facoltativo) è controllata solo nella forma; l'esistenza e il tipo li controlla il controllo AWL sul codice generato. Gli operandi devono stare su una riga.
- **Parametri di CALL.** Sempre `nome := valore`, anche per le uscite; i pin vuoti si omettono e il controllo AWL segnala poi i parametri mancanti sulla riga della CALL. Un FB trascinato dall'albero senza DB di istanza diventa `"Nome", ` con il DB vuoto: il box dà l'errore `BAD_INSTANCE` finché non si sceglie il DB a mano.
- **Fuori dal test di equivalenza** KOP/AWL: temporizzatori, contatori, `MCR(`, CALL e box in virgola mobile (ABS è provato sui valori interi).
- **Cerca/Sostituisci e rinomina nei KOP e FUP.** La rinomina di un tag, di una costante, di un blocco o di un membro riscrive anche gli operandi del grafico (contatti, bobine, confronti, pin dei box, parametri e istanze dei box CALL, temporizzatori e contatori) con le stesse regole dell'AWL, in un solo passo annullabile; le etichette dei salti non cambiano. Trova cerca nel codice AWL generato: un risultato che sta per intero dentro un solo operando del grafico si sostituisce nell'operando e la sorgente generata si aggiorna. Un risultato che tocca testo solo generato (mnemonici, `:=`, etichette automatiche), che copre più operandi o righe, o che il generatore scrive in altra forma (`M 10.0` appare come `%M10.0`; con i mnemonici tedeschi gli indirizzi assoluti, `I` → `E`) resta non modificabile (motivo «Segmento KOP») e Sostituisci lo salta. Un testo sostitutivo con a capo non si applica a un operando.
- **Osservazione nel grafico (KOP e FUP), ricavata dall'AWL generato.** Lo stato di ogni elemento viene dagli stati per riga dell'AWL generato, gli stessi dell'osservazione AWL (simulatore o CPU): un contatto dal suo STA (stato dell'operando), con il flusso che entra; NOT, confronti, fronti, `(#)` e box dall'RLO dopo la loro ultima riga, quella che ne dà l'uscita (mai da una riga intermedia); bobine, uscite e nodi dal flusso della serie davanti. In un ramo di un parallelo l'RLO dell'AWL non contiene il flusso davanti al parallelo: il grafico lo combina (un ramo senza flusso davanti resta a 0 anche con il contatto chiuso). ENO o Q non collegati non hanno colore (l'AWL non li calcola). I valori accanto ai pin sono ACCU1 sulla riga `L` o `T` del pin: ingressi e uscite di MOVE, aritmetica, conversioni, logica a parola e scorrimenti, ingressi dei confronti, TV/PV e BI/BCD/CV di temporizzatori e contatori (solo se il pin ha un operando). Niente valori per i parametri dei box CALL, né per i pin BOOL con logica oltre al loro colore. Online la finestra della PDU vale anche qui: un elemento la cui ultima riga è fuori dalla finestra (o non ha ancora risposta: finestra appena cambiata, nessun risultato, risposta parziale della CPU) resta senza colore, con «fuori dalla finestra di osservazione o in attesa» nel testo; il grigio e «non elaborato» restano per le righe che la CPU o il simulatore danno come non eseguite. Con MCR spento (dentro `MCR(` … `)MCR` con RLO 0) bobine e box mostrano il flusso e ACCU1 delle loro righe, anche se l'operazione scrive 0. Una modifica del grafico durante l'osservazione la sospende finché non si ricompila e ricarica, come una modifica confermata in AWL.
- **Il test e2e si ferma alla compilazione.** L'esecuzione nel simulatore è coperta da `packages/project/test/kopCompile.test.ts`.
- **Errori senza elemento.** Un messaggio, un risultato di Trova o una voce di _Problemi_ di un blocco KOP/FUP selezionano l'elemento che ha prodotto l'errore (o la riga AWL generata); un errore senza elemento apre solo il segmento.
- **Esportazione con KOP in errore.** «Genera sorgente AWL» salta i blocchi KOP con errori e lo segnala. Un blocco KOP il cui `source` non è aggiornato non si legge direttamente: contano il grafico e il codice generato da esso.
- **Blocchi caricati con lingua `02`/`03`.** Un blocco letto dalla CPU con il byte di linguaggio KOP o FUP si importa con il grafico solo se ogni segmento si converte (vedi sotto); altrimenti resta AWL, con la nota «resta in AWL perché i segmenti … non hanno una rete KOP». Un blocco scritto da STEP 7 contiene quasi sempre i `BLD`, che il generatore non scrive: resta AWL. Un blocco di sola lettura (non ricodificabile) resta AWL.
- **Conversione AWL → KOP/FUP solo con lo stesso AWL.** _Modifica → Converti in KOP/FUP_ (tutto il blocco AWL, che diventa KOP, o i segmenti AWL di un blocco KOP/FUP) e la voce del menu del segmento convertono un segmento solo se la rete trovata, ritradotta, dà le stesse istruzioni con gli stessi operandi (commenti, spazi e maiuscole a parte). Si riconoscono solo le forme che la traduzione KOP → AWL genera: `A x; O y` senza parentesi, `X`, `BLD`, `L`/`T` sciolti, salti verso etichette interne del segmento e ogni altra forma restano AWL, con un messaggio per segmento. Un blocco AWL cambia linguaggio solo se si convertono tutti i suoi segmenti (i segmenti vuoti restano vuoti). Le etichette dei box (`JNB M001 … M001:`) diventano quelle automatiche (`_001`) solo se nessun altro segmento le scrive. Un bit L usato come operando resta un operando: la rete può avere un `(#)` o un ramo a T dalla barra dove l'originale aveva un bit intermedio, con lo stesso AWL. Un bit L diventa il bit nascosto di un ramo a T o di un pin di una CALL solo se nessun altro segmento del blocco usa il suo byte (`L 0.0`, `LB 0`, `LW 0`, `LD 0`…, scritti nel testo AWL o negli operandi del grafico): altrimenti resta un operando, perché il compilatore sceglie quel bit dopo i TEMP e l'altro segmento no. Gli accessi indiretti all'area L non si vedono. Un segmento con più di 300 istruzioni, o con troppe combinazioni da provare, resta AWL senza provarci («troppo complesso»). Convertendo un segmento di un blocco KOP/FUP le etichette automatiche dei grafici si rinumerano; la conversione si annulla se dopo un salto del blocco porterebbe a un'istruzione diversa o un'etichetta sarebbe doppia. I commenti delle righe AWL si perdono (titolo e commento del segmento restano). Il contrario (KOP → AWL modificabile) non c'è.

## FUP in prova (1.0.0, esteso in 1.1)

Si crea solo con _Funzioni sperimentali_ attive; un blocco FUP già esistente si apre sempre.

- **Stesso modello del KOP.** Un blocco FUP salva le stesse reti di un blocco KOP e genera lo stesso AWL; cambia solo il linguaggio dichiarato. _Cambia linguaggio KOP/FUP_ (menu _Modifica_ o pulsante sopra i segmenti) passa dall'uno all'altro senza perdere nulla. Vale tutto ciò che è scritto per l'_Editor KOP_.
- **Mai provato su una CPU reale.** Il byte di linguaggio dell'intestazione è `03`, preso come documentazione dalle costanti pubbliche di snap7 e mai verificato con STEP 7; come per il KOP non ci sono marcatori BLD.
- **Inserimento con i gesti del KOP.** Tavolozza (clic e trascinamento), albero del progetto (FC/FB → box CALL), barra e tasti della vista FUP fanno le stesse modifiche dell'editor KOP: gli stessi gesti danno la stessa rete e lo stesso AWL. Un'entrata nuova va dopo quella selezionata, nello stesso riquadro `&`; un `>=1` si apre sull'entrata selezionata (F8) e si chiude come un ramo KOP (F9). Il rilascio va dopo l'elemento sotto il puntatore, o in fondo alla serie principale; non ci sono punti d'inserimento da scegliere.
- **Negazione (N) limitata.** Si nega un contatto (NA ↔ NC) o la prima entrata di una serie che parte da capo (riceve un `NOT` subito dopo); in un ramo a T che eredita logica dal nodo sopra si nega solo un contatto. Un'entrata non contatto più avanti nella serie non si nega da sola: un `NOT` lì negherebbe tutta la logica che lo precede, come in AWL.
- **Resa semplificata.** Un `NOT` è il cerchietto sull'uscita della logica che lo precede nella serie, sul pin con cui entra nel riquadro `&` successivo. Allo stesso modo un fronte (P)/(N), un `#` o un box dopo la prima voce prendono come entrata (il box sul primo pin, EN o S/CU…) tutta la logica che li precede; un box POS/NEG legge il suo bit ed è un'entrata del `&` come un contatto. Un ramo a T, o più uscite sullo stesso nodo, ripete la logica comune invece di dividere un solo riquadro: gli elementi ripetuti compaiono più volte e le frecce li visitano una volta per copia. Le frecce seguono l'ordine del disegno (sinistra/su = precedente, destra/giù = successivo), non la posizione sullo schermo. Niente griglia, niente selezione multipla.
- **Osservazione della vista FUP** con gli stessi dati del KOP: il bordo inferiore di ogni elemento è verde (1), blu tratteggiato (0) o grigio punteggiato (non elaborato), senza bordo se fuori dalla finestra o in attesa; un'entrata mostra il segnale del suo operando, gli altri elementi la loro uscita. I riquadri `&` comuni e i fili non hanno colore; un elemento ripetuto (ramo a T) ha lo stesso stato in ogni copia.
- **Aspetto chiaro/scuro** non controllato a mano.

## SCL in prova (1.0.0, esteso in 1.1, 1.3 e 1.4)

Si crea solo con _Funzioni sperimentali_ attive. Il testo SCL si traduce in AWL (pacchetto `scl`), che si compila come gli altri blocchi.

- **Mai provato su una CPU reale né confrontato con il compilatore SCL di STEP 7.** L'AWL generato è provato con il controllo AWL e nel simulatore. Il byte di linguaggio è `04`, non verificato con STEP 7.
- **Solo istruzioni.** Il testo non ha intestazione `FUNCTION`/`VAR`: l'interfaccia è quella del blocco. Un solo testo per blocco.
- **Sottoinsieme.** Tipi BOOL, BYTE, WORD, DWORD, INT, DINT, REAL. Operandi: variabili dell'interfaccia (con o senza `#`), simboli `"nome"`, indirizzi I/Q/M (bit, `B`, `W`, `D`), elementi di ARRAY e membri di STRUCT con indici costanti (`#v[3]`, `#s.x`, `"DB".m[2].n`), anche nei DB globali e di istanza e nelle multi-istanze (`#inst.out`). Operatori `+ - * /`, `MOD` (solo DINT), meno unario, confronti, AND/`&`, OR, XOR, NOT (anche a parola su BYTE/WORD/DWORD). Costanti decimali, in base (`16#FF`, `2#1010`, `8#17`) e tipizzate (`INT#5`, `DINT#5`, `L#5`, `B#16#FF`, `W#16#FF`, `DW#16#FF`). Istruzioni `:=`, IF/ELSIF/ELSE, CASE (valori, elenchi e intervalli `1..5`), FOR (BY costante), WHILE, REPEAT, EXIT, CONTINUE, RETURN. Conversioni INT_TO_DINT, INT_TO_REAL, DINT_TO_REAL, ROUND, TRUNC, DINT_TO_INT, INT_TO_WORD, WORD_TO_INT, DINT_TO_DWORD, DWORD_TO_DINT, DWORD_TO_WORD, WORD_TO_DWORD, BYTE_TO_WORD, WORD_TO_BYTE, BYTE_TO_DWORD, DWORD_TO_REAL e REAL_TO_DWORD (reinterpretano i bit, senza istruzioni); da REAL a INT si passa da ROUND o TRUNC: `DINT_TO_INT(ROUND(r))`. `MD` è sempre DWORD o DINT: `r := MD0` è un errore (usa `DINT_TO_REAL` o `DWORD_TO_REAL`), solo `MD0 := r` scrive un REAL.
- **Chiamate.** FC e SFC per nome (`"Fc"(a := 1, b => #x)` o `Fc(…)`), FB col DB di istanza (`"Inst_DB"(…)`) e multi-istanze (`#inst(…)`), con i parametri per nome: `:=` per ingressi e ingressi/uscite, `=>` per le uscite. Una FC vuole tutti i parametri. Un ingresso può essere un'espressione (si calcola prima in una TEMP); uscite e ingressi/uscite vogliono una variabile dello stesso tipo. Il valore di una FC si usa in un'espressione (`x := "Fc"(…) + 1`): le chiamate dentro un'espressione si fanno prima del resto, da sinistra a destra. In una FC con tipo di ritorno, `RET_VAL` o il nome della FC sono il valore da restituire. Si genera `CALL` con l'indirizzo assoluto del blocco (`CALL FC 31`), come il box CALL del KOP. Parametri solo dei tipi elementari qui sopra (niente ANY, POINTER, TIMER, STRUCT…).
- **Conversioni verso un tipo più stretto** (DINT_TO_INT, DWORD_TO_WORD, INT_TO_WORD…) tengono i bit bassi senza segnalare l'errore: `DINT_TO_INT(70000)` dà 4464, `DINT_TO_INT(32768)` dà -32768. STEP 7 in quel caso mette a 0 il bit OK; qui OK non si tocca.
- **Indirizzi.** `MW` e `MD` sono INT e DINT, ma prendono il tipo dell'altro lato se ci sta: `MW10 := #w AND 16#FF` è una WORD, `MD4 := #r` un REAL. In STEP 7 sono WORD e DWORD.
- **Indici variabili (1.3).** `#a[#i]`, `#a[#i + 1]`, `#m[#i, #j]`, `"DB".v[#i]`, `#s.v[#i]`, `#multi.v[#i]`, in lettura e scrittura, per ARRAY di BOOL, BYTE, WORD, DWORD, INT, DINT, REAL nei TEMP, negli IN/OUT/STAT di un FB (anche in multi-istanza), nei DB globali e di istanza e nei tag con un tipo ARRAY. Come STEP 7 SCL: AR1 = (indice − limite basso) · passo, riga per riga, più AR2 nei dati d'istanza; poi l'accesso `[AR1,P#inizio]` interno all'area (`L`, `DI`, `DB` dopo `OPN DB n`, `M`, `I`, `Q`). Inizio e passo vengono dal layout del compilatore (BOOL a bit, gli altri a byte o a parola). Un indice INT si allarga a DINT. Gli elementi con indici variabili si leggono in una TEMP prima del resto dell'espressione, da sinistra a destra, gli indici interni prima (`#a[#b[#i]]`). Un indice costante fuori dai limiti è un errore già in traduzione.
- **Indice fuori dai limiti a run-time.** STEP 7 senza «controllo dei limiti» scrive fuori dall'ARRAY; qui l'indice si controlla sempre: la scrittura si salta, la lettura dà 0 (FALSE), BR va a 0 (`CLR`, `SAVE`), quindi l'ENO del blocco è 0 se nessuna istruzione dopo cambia BR (una CALL lo riscrive). Non c'è la variabile OK. Il controllo costa circa 10 istruzioni per dimensione.
- **Indici variabili, limiti.** Solo nell'ultimo ARRAY dell'operando (`#a[#i].x` no, `#s.a[#i]` sì); non come uscita o ingresso/uscita di una chiamata (`p => #a[#i]`) né come variabile del FOR; l'ARRAY deve cominciare entro il byte 8191 dell'area (`P#8191.7`).
- **Fuori:** membri o elementi di un parametro di FC o di un IN_OUT di FB (sono puntatori, anche con indici variabili), ARRAY o STRUCT interi come operando o parametro, STRING, TIME, CHAR, `**`, chiamata di un FB senza DB di istanza, parametri per posizione, PI/PQ, mnemonici tedeschi negli indirizzi. Nessun confronto fra BOOL (si usa XOR/NOT); con BYTE/WORD/DWORD solo `=` e `<>`.
- **FOR.** Il valore finale si calcola una volta sola. Al limite del tipo il ciclo esce e la variabile resta all'ultimo valore eseguito. Modificare la variabile dentro il ciclo non è controllato. EXIT esce dal ciclo più interno; CONTINUE passa all'incremento (FOR), alla condizione (WHILE, REPEAT).
- **Parentesi più del minimo.** Un AND dentro un OR va sempre fra parentesi, quindi il limite di 7 parentesi aperte di AWL («Espressione troppo annidata») può arrivare prima che in STEP 7.
- **Errori (1.4).** Si riportano fino a 50 errori: dopo un errore il parser riparte dal `;` dell'istruzione o dalla fine del costrutto (`END_…`), e un errore nell'intestazione di IF, CASE, FOR, WHILE o UNTIL salta il resto di quella riga e legge comunque il corpo. Un `;` mancante alla fine della riga si segnala sulla riga dove manca. Dopo un errore di sintassi qualche errore successivo può esserne la conseguenza (per esempio un nome nel corpo di un FOR con l'intestazione sbagliata). Sulla riga di un errore del lexer (carattere non valido, costante sbagliata, simbolo senza la virgoletta di chiusura) non si riportano altri errori di sintassi. Gli errori del controllo AWL sul codice generato compaiono nell'editor alla riga SCL (colonna 1) solo se il traduttore non ne ha trovati; quelli della compilazione MC7 restano nei messaggi di compilazione.
- **Editor (1.4).** Evidenziazione, completamento (variabili, tag, DB e loro membri, chiamate con i parametri, parole chiave) ed errori sottolineati mentre si scrive. Niente osservazione. Il completamento non propone i parametri dentro le parentesi di una chiamata già scritta, né i membri dopo un indice variabile. La scrittura negli ingressi di una FC non è controllata.
- **Rinomina (1.4).** Tag, costanti, blocchi, DB, membri di DB e UDT, variabili e parametri dell'interfaccia si aggiornano anche nel testo SCL, sui token: commenti e stringhe restano come sono. Un parametro si rinomina solo nelle chiamate di quel blocco (`"Fc"(…)`, `Fc(…)`, `"Inst_DB"(…)`, `#multi(…)`). Nel codice di una FC il suo nome usato come valore di ritorno (`Fc := …`) non si rinomina col blocco.

## Adattatore MPI (piano 3M)

- **Mai provato su un adattatore reale.** Il protocollo del PC Adapter (varianti v1 e v2) è scritto dalla documentazione e dai commenti pubblici di libnodave, senza catture né prove. I test girano contro un adattatore finto (`packages/s7-server/src/mpiAdapter.ts`) scritto dalle stesse fonti, quindi non trovano un errore di lettura delle fonti.
- **Punti non confermati dalle fonti:** tempi e ripetizioni del framing, chi vince se PC e adattatore trasmettono insieme, reazione a un BCC sbagliato, significato di vari byte del blocco di configurazione (velocità del bus e HSA sono le posizioni più probabili), risposta esatta all'inizializzazione v2, contenuto delle risposte alla chiusura.
- **HSA nella variante v2.** Si scrive il valore scelto (31 di serie); libnodave usa sempre 15. Se un adattatore v2 non si inizializza, provare HSA 15.
- **Variante v3** (quella di STEP 7, frame `7E` con CRC16): non fatta. Un adattatore che parla solo v3 non risponde.
- **Cloni USB-COM** non verificati: funzionano solo se parlano lo stesso protocollo del PC Adapter seriale.
- **Una connessione alla volta** per adattatore (e per porta, in tutta l'app). Un'operazione con collegamento proprio (scrittura, download, ripristino, osservazione, stack, caricamento, backup) ferma la sorveglianza, che si riapre alla fine; intanto le letture della finestra (tabelle di controllo, elenco blocchi, diagnostica) danno «Porta MPI occupata» e una seconda operazione aspetta la porta fino al suo timeout, poi «già usata da un altro collegamento di BaaPortal». Due finestre online sulla stessa porta: la seconda non si collega. La PDU proposta è di 240 byte.
- **Ritrasmissioni.** Un byte di rumore fuori da un frame si scarta, un frame con BCC sbagliato si scarta senza DLE (l'adattatore lo rimanda), un NAK fa rimandare il telegramma (fino a 3 volte). Un telegramma dati (una PDU) già trasmesso senza DLE di risposta non si rimanda mai, perché la CPU potrebbe eseguire due volte una scrittura: il collegamento cade.
- **Non supportati:** PC Adapter USB Siemens, CP 5611/5711, PPI (S7-200).

## Simulatore (piano 2A)

Le scelte sono descritte in `docs/protocollo/sim.md` (§4.1 per la semantica). Tutte restano **non confermate** da una CPU reale.

### Mancanze

- **Nessuna CPU reale per confermare la semantica** (spec §10). Il simulatore controlla la coerenza interna con i manuali pubblici, ma nessun risultato è stato confrontato con una S7-300 vera.
- **Temporizzatori, contatori, SFC/SFB e OB di errore: risolti dal piano 2B** (vedi la sezione «Simulatore (piano 2B)» qui sotto).
- **Interfaccia: piano 2C.** Il pacchetto non ha pannelli; li offre il piano 2C (vedi «Strumenti di test (piano 2C)» sotto).
- **Il tempo di ciclo non è quello di una CPU vera.** Dipende dal computer e dall'orologio iniettato.
- **ENT e LEAVE rifiutati** (`ISTRUZIONE_NON_S7300`): sono delle CPU a 4 accumulatori.

### Scelte non coperte dal manuale (⚠️)

- **Parola di stato dopo `S`/`R`, `FP`/`FN`, `MCR(`/`)MCR`:** STA = RLO dopo `S`/`R`; `MCR(` e `)MCR` danno OR 0, STA 1, RLO 1, /FC 0. Le tabelle del manuale lasciano STA indeterminato.
- **UC, CC, BE, BEU, BEC:** effetti sulla parola di stato da tabelle ricordate, non verificati. Nell'OB di primo livello la parola di stato finale non viene ripulita da `BE`.
- **JBI/JNBI** lasciano RLO invariato; gli altri salti condizionati danno OR 0, STA 1, RLO 1, /FC 0.
- **Divisione per 0:** ACCU1 = 0 (il manuale non lo dice).
- **REAL:** NaN memorizzato come 0x7FC00000; denormali conservati; CC per ±infinito e precisione delle funzioni trascendenti (float32) non verificati al ulp.
- **`+AR1`/`+AR2` senza operando** e `L STW`/`T STW` (solo bit 0–8) seguono la lettura del manuale, non provata.
- **Stack dei blocchi a 16** per ogni CPU e per ogni classe di priorità (nel manuale varia con la CPU); stack L con finestra per blocco (dal piano 2B uno per classe di priorità), **non azzerato** all'ingresso del blocco.
- **Tempo:** orologio iniettato; controllo del tempo di ciclo ogni 1024 istruzioni e a fine ciclo (più il limite fisso di istruzioni); byte del merker di clock aggiornato all'inizio del ciclo e ogni 1024 istruzioni, non a ogni lettura. Dal piano 2B il superamento del tempo di ciclo richiama OB80 (un solo superamento per ciclo), prima di arrivare in STOP.
- **Chiamate:** lo stack MCR del chiamato parte vuoto; i puntatori `0x84`/`0x85` legano DB/DI al momento della chiamata; `0x86` è trattato come V; DB = DB di istanza dopo `CALL FB`.
- **Salto alla fine esatta del codice** rifiutato (`MC7_NON_ESEGUIBILE`).
- **Buffer di diagnostica** limitato a 100 voci; gli id degli eventi nelle SZL sono sintetici (da 0x9000) salvo quelli che il manuale dà (piano 2B). I cambi di modo del simulatore usano ora gli ID 0x43xx reali (piano 3C).
- **Errore non previsto del simulatore** (non `SimError`): voce `MC7_NON_ESEGUIBILE` con dettaglio «errore interno», STOP e l'eccezione viene rilanciata.
- **Cancellazione totale** azzera anche le statistiche del ciclo e `physOut`; i DB tornano ai valori della sezione MC7 del file caricato (i valori iniziali separati non sono letti); i blocchi restano.
- **Blocchi non caricati dal backend** (messi direttamente nel programma) non hanno upload né informazioni di blocco.
- **Sezioni ADD corrotte** non fanno rifiutare il download.
- **`*I`:** il prodotto a 32 bit va in ACCU1 intero; OV fuori dai 16 bit.
- **Confronti:** forzano OR = 0. Conseguenza: in `A a; A b; O; L; L; ==I; A c` l'`O` pendente è perso dal confronto e `A c` si combina in AND con il risultato.
- **`T STW`** non segue MCR (scrive anche con MCR spento).
- **`BTI`/`BTD`:** si controlla solo il bit di segno e le cifre > 9 (`BCD_NON_VALIDO`).
- **Immagine di processo** = tutto l'intervallo di I/O del catalogo della CPU (nessuna configurazione dell'area dell'immagine).
- **Watchdog di OB100:** il simulatore applica `maxCycleMs` (e il limite di 10 000 000 istruzioni) anche a OB100; su una CPU vera OB100 non ha il limite del tempo di ciclo.
- **Limite di istruzioni:** 10 000 000 per ciclo, indipendente dall'orologio; scelta del simulatore.
- **PQ → Q:** una scrittura diretta nella periferia (PQ o `P` da puntatore) scrive anche in Q se l'indirizzo vi cade; non verificato su una CPU.
- **Download di SDB rifiutato:** le configurazioni di sistema non sono simulate.

## Simulatore (piano 2B)

Le scelte sono descritte in `docs/protocollo/sim.md` (§10–§13). Come per il piano 2A, tutte restano **non confermate** da una CPU reale.

- **Nessuna CPU reale per confermare** temporizzatori, contatori, OB e SFC (spec §10). Tutti i valori di questa sezione vengono dai manuali pubblici e dalla coerenza interna.
- **Temporizzatori a corsa libera in STOP:** l'orologio non si ferma con la CPU, quindi un T in conteggio prosegue (e un T ritentivo scade) anche in STOP. Non verificato.
- **Temporizzatori S5:** MCR non li influenza; SS con riavvio a Q = 1 resta a 1 fino a `R`; SF con RLO = 1 subito dopo `R` dà Q = 1; il valore residuo da fermo resta quello dello stop; parola di stato di avvio/`R`/`FR` /FC 0, OR 0, STA = RLO, RLO invariato. Tutto non verificato.
- **Parametro formale TIMER/COUNTER:** il numero si legge dalla voce grezza della lista dei puntatori (`[n >> 8, n & 255, 0, 0]`); il formato è stato verificato su una sola sorgente.
- **Lettura di T e C dal server S7:** T come parola `LC` (BCD con base), C come parola BCD, 2 byte big-endian; formato sul filo non verificato. Le scritture sulle aree T e C sono rifiutate.
- **OB82 e OB86 solo da `raiseInterrupt`:** non c'è una configurazione hardware (tappa 6); il pannello del piano 2C li offre come «simula guasto».
- **OB82/OB86 mancanti → OB85:** il manuale è ambiguo; se manca anche OB85 la CPU va in STOP (`OB_NON_CARICATO`).
- **OB80 annidato in OB82/OB86:** se il tempo di ciclo si supera dentro un OB della classe 26, OB80 si annida nella stessa classe; una CPU vera lo metterebbe in coda.
- **OB35, latenza:** si controlla all'inizio del ciclo e ogni 1024 istruzioni (tick), non a ogni istruzione: la latenza arriva fino a 1024 istruzioni.
- **OB35, griglia fissa:** le scadenze sono multipli dell'intervallo dall'ingresso in RUN; le scadenze perse si saltano **senza evento**; nessun OB85 se OB35 non è caricato; nessuna voce `OB_RICHIAMATO` per OB35, OB1 e OB100.
- **Superamento in STARTUP:** il superamento del tempo di ciclo (o del limite di istruzioni) in OB100 porta in STOP; OB80 non è richiamato.
- **Dati di avvio degli OB** (STRT_INF 16#36 di OB35, IO_FLAG 16#54 e MDL_DEFECT di OB82, FLT_ID 16#C4 e RACKS_FLTD 0 di OB86, MEM_AREA/MEM_ADDR di OB122, ERR_EV di OB80): valori ricordati dai manuali, non confrontati con una CPU.
- **`DB_NON_APERTO`** (accesso a DB/DI con registro a 0) è mappato su SW_FLT 16#22/16#23 (errore di area): la lista del manuale non ha un codice dedicato.
- **OB121/OB122 non annidati** solo se l'OB più interno in esecuzione è già OB121/OB122; un OB di altra classe che li interrompe e sbaglia può richiamarli.
- **Id diagnostici sintetici** dove il manuale non ne dà uno: `AVVIO`, `STOP_RICHIESTO`, `CANCELLAZIONE_TOTALE`, stack pieni, `MC7_NON_ESEGUIBILE`, `ISTRUZIONE_NON_S7300`, `OB_RICHIAMATO` generico, `SFC_NON_SIMULATA`, `SFB_NON_SIMULATA` (da 16#9000, in ordine stabile).
- **Codici RET_VAL delle SFC non verificati:** 16#8091 per aree sovrapposte di BLKMOV/FILL potrebbe essere inventato; 16#8080 (SET_CLK), 16#80A1/16#80B1/16#80B2 (SFC 22–24), 16#0081/16#8082/16#8083 (RDSYSST) e i 16#8xyy generali (22 lettura, 23 scrittura, 24 ANY non valido, 28/29 allineamento, 3A DB) sono dedotti. Per i 16#8xyy il numero del parametro `x` conta IN, OUT, IN_OUT **escludendo RET_VAL**: potrebbe non corrispondere alla CPU vera.
- **DEL_DB** di un DB aperto o richiamato: il DB sparisce subito, senza controlli.
- **Compilatore e SFC:** il compilatore MC7 non sa passare DATE_AND_TIME e SSL_HEADER a SFC 0, 1 e 51 da AWL; si provano con liste di puntatori scritte a mano.
- **SFC 64 TIME_TCK** conta dal primo RUN della CPU simulata, non dall'accensione; SFC 47 WAIT non attende davvero ma somma il tempo all'orologio; RDSYSST è sempre sincrona (BUSY 0).
- **Stato degli SFB 0–5 fuori dal DB di istanza** (memorie dei fronti, istanti di avvio): la CPU non lo azzera con il download di un DB ma solo con STOP→RUN e MRES; le uscite cambiano solo alla chiamata.
- **SFB 3 TP:** un fronte di IN esattamente alla fine dell'impulso si perde (dipende da quando si chiama l'SFB).
- **SFB di temporizzazione:** se PT cambia durante il conteggio vale il nuovo PT; PT < 0 vale 0; in CTUD R prevale su LOAD e due fronti insieme si annullano.
- **OB121 e memoria:** l'OB121 ripristina i registri, ma gli effetti sulla memoria di una chiamata SFC/SFB fallita (se ne restano, per esempio le uscite già scritte quando è RET_VAL a non poter essere scritta, o un DB già creato o cancellato) restano.
- **CREAT_DB, codici 16#80A1/16#80B1/16#80B2 non verificati:** un'altra lettura del manuale dà 16#80A2 per la lunghezza errata e 16#80B1 per nessun numero libero.
- **Senza OB1:** OB35 gira comunque all'inizio del ciclo, ma non c'è un controllo di fine ciclo (watchdog, evento di ciclo).
- **OB121, profondità dei blocchi:** la profondità dei blocchi dentro l'OB121 riparte da 0 invece di sommarsi a quella del blocco interrotto.
- **SFC e SFB non simulati:** sono un avviso («non simulata», BR = 0, uscite intatte, una volta per numero e per RUN), non un errore. Sono non simulate **tutte** le SFC e gli SFB tranne SFC 0, 1, 20, 21, 22, 23, 24, 46, 47, 51, 64 e SFB 0–5.

## Strumenti di test (piano 2C)

Le scelte sono descritte in `docs/protocollo/sim.md` (§14) e in `docs/uso/simulatore.md`. Come per i piani 2A e 2B, nessuna è confermata da una CPU reale.

- **Nessun PLC vero fino alla tappa 3.** Pannello CPU, pannello I/O, osservazione e tabelle di controllo funzionano solo sul simulatore; il collegamento a un PLC reale usa lo stesso `watch`/`write` nella tappa 3 (le tabelle online arrivano con il 3C).
- **Il tempo di ciclo del Worker non è quello di una CPU vera.** Dipende dal computer.
- **Osservazione del programma.**
  - Rileva solo la prima esecuzione di ogni riga nel ciclo; non c'è l'opzione «ultima esecuzione».
  - I blocchi importati e non ricompilati non si possono osservare (mancano le righe del compilatore).
  - Gli editor nelle finestre staccate non vengono osservati.
  - Il tasto esadecimale/decimale non viene salvato e torna esadecimale a ogni simulazione.
- **Nessun FORCE.** Il pannello I/O simula gli ingressi fisici e non forza valori; il forzamento è della tappa 7.
- **Blocchi cancellati.** «Carica nel dispositivo» cancella dalla CPU simulata i blocchi (compresi i DB) non più nel progetto; un blocco cancellato che era in osservazione smette di essere osservato. Anche i DB creati dal programma con SFC 22 (CREAT_DB) vengono cancellati da un nuovo caricamento.
- **Byte aggiunti a mano nel pannello I/O** («+ byte») durano solo la sessione di simulazione e non sono salvati nel progetto.
- **Tabelle di controllo.**
  - La scrittura di T e C non è supportata (lo stato si legge).
  - Non si osservano L, DI, accessi indiretti, puntatori, variabili locali (`#x`) né tipi composti (ARRAY, STRUCT, STRING interi).
  - Si osserva una sola tabella alla volta: quella su cui si è attivato «Osserva tutto», finché è visibile in un riquadro qualsiasi; una tabella in una finestra staccata smette di essere osservata.
  - Gli operandi si risolvono sul **progetto offline**, non sul programma caricato: se si modifica il layout di un DB senza caricarlo, letture e scritture usano i nuovi offset della modifica e non c'è confronto online/offline.
  - Le modifiche alle proprietà della CPU (tempo di ciclo, merker di clock, intervallo di OB35) valgono solo dopo aver riavviato la simulazione.
  - La rinomina di un tag, di una costante o di un blocco/DB aggiorna le righe che usano `"Nome"` o `"Nome".membro`; anche la rinomina di un **membro** di un DB, di un UDT o di un FB (DB di istanza) aggiorna le righe, nello stesso passo annullabile.
  - Non c'è un forzamento permanente né un «trigger»: c'è solo «Comanda», una scrittura una tantum.
  - Le tabelle non si copiano, tagliano, incollano né trascinano nell'albero; non ci sono gruppi né importazione o esportazione.
  - Al più 1000 righe osservate per richiesta; le righe oltre il limite danno un errore di riga.
  - Un file `.baap` del formato 4 non si apre con un'app più vecchia (`NEWER_FORMAT`).

## Funzioni 1F (piano 1F)

### Importa/esporta variabili (csv e xlsx)

- **Costanti in csv.** Il csv ha un solo foglio, quindi le costanti non si esportano: per averle si usa xlsx.
- **xlsx scritto in forma minima.** Nessuna formattazione (larghezze, colori, stili); il file si apre ma è spartano.
- **csv, virgolette non chiuse.** Una virgoletta aperta e mai chiusa inghiotte il resto del file in un solo errore `RIGA_ILLEGGIBILE`.
- **csv, formule.** In esportazione una cella che inizia con `=`, `+`, `-`, `@`, tab o a capo (dopo eventuali apici) riceve un apice davanti (`'=1+1`), così Excel non la legge come formula. In importazione, a una cella che inizia con uno o più apici seguiti da uno di quei caratteri se ne toglie uno; `'ciao` resta com'è. Un file di altra origine con una cella `'=x` volutamente con l'apice la perde.
- **xlsx, limite di dimensione.** Il file compresso può arrivare a 50 MB. Si gonfiano solo le voci che servono (cartella di lavoro, relazioni, stringhe condivise, tipi di contenuto e i fogli referenziati); ogni voce e il totale non possono superare 200 MB, altrimenti errore chiaro «troppo grande». Il limite per voce si fida della dimensione dichiarata nell'intestazione dello zip, e la misura reale viene ricontrollata dopo l'estrazione.
- **Valori delle costanti importate.** Non vengono controllati rispetto al loro tipo, come nell'editor a griglia.
- **xlsx, DOCTYPE.** Un DOCTYPE con sottoinsieme interno non si legge (errore chiaro).
- **xlsx, ritorni a capo.** Un `\r` dentro un testo non torna identico dopo l'esportazione e la rilettura.
- **Nomi unici per CPU.** L'importazione scarta un nome già presente in un'altra tabella (`NOME_IN_ALTRA_TABELLA`); un doppione creato a mano fra tabelle (variabili, costanti, blocchi, UDT) è segnalato dal controllo del progetto come `NAME_DUPLICATE` su ogni occorrenza.
- **Nome file.** In esportazione un'estensione digitata che non è `csv` né `xlsx` (fino a 4 caratteri con almeno una lettera, come `x.txt`) è sostituita: `x.xlsx`. Un punto nel nome (`v1.2`) resta e si aggiunge l'estensione.

### Archivio (.baapz)

- **Dimensione decompressa.** Il limite si fida della dimensione dichiarata nell'intestazione (ricontrollata dopo).

### Progetti di riferimento

- **Solo copia.** Il riferimento non si apre negli editor. Il doppio clic mostra «solo copia».
- **Niente trascinamento.** Si copia e si usa «Copia nel progetto».
- **Dipendenze.** La copia non porta con sé le dipendenze (UDT, DB d'istanza), come la copia dentro il progetto.
- **Gruppi.** «Copia nel progetto» appiattisce i gruppi nella cartella radice.
- **Chiusura del progetto principale.** I progetti di riferimento restano aperti quando il progetto principale si chiude o si cambia, e non vengono salvati con il progetto.
- **Percorsi.** Si confrontano come stringhe.

### Trova e sostituisci

- **Rinominare una variabile** con Sostituisci non aggiorna i suoi riferimenti nel codice.
- **Blocchi protetti.** L'interfaccia dei blocchi protetti non viene cercata.
- **Sorgenti.** Si cercano nel testo salvato, senza conversione della mnemonica.
- **Reti con ritorni a capo misti** possono non tornare identiche byte per byte.
- **Titoli e commenti.** Un clic su un risultato in un titolo o commento apre il blocco senza selezionare il testo.
- **Espressioni regolari** con corrispondenza di lunghezza zero: ignorate.

### Impostazioni e compilazione

- **Scala nelle finestre staccate** non verificata nell'app vera.
- **«Interrompi» della compilazione** è coperto solo da test di unità, non da un e2e.

## Compilatore MC7 (piano 1E)

### Forme e regole non verificate su blocchi reali

- **Istruzioni senza esempio reale.** 94 `id` di istruzioni su 155 non compaiono in nessun blocco reale non protetto del corpus (elenco in `docs/protocollo/mc7.md` §6.1). La loro codifica viene dalle fonti, non da un confronto byte per byte.
- **Forme viste solo in blocchi protetti.** 12 `id` e alcune forme di CALL sono stati osservati solo in FB41 e FB80, due blocchi protetti know-how che ora sono esclusi dai test. In `callExpand.ts` quelle forme di CALL risultano ancora "verificate".
- **Base del tempo S5TIME.** Si usa la base minima; la regola non è verificata.
- **Ordine dei parametri delle FC con RET_VAL.** L'ordine IN, RET_VAL, OUT, IN_OUT si basa su un solo esempio reale. Viene dato l'avviso `FC_ORDINE_PARAMETRI_NON_VERIFICATO`.
- **Calcolo dei dati locali.** La regola è segnata come incerta (⚠️) nel riferimento del formato.
- **Attributi dei DB.** _non collegato_, _sola lettura_ e _non ritentivo_ non si compilano.

### Funzioni non ancora fatte

- **Parametri complessi delle FC** (STRUCT, ARRAY, STRING, DT, UDT): la compilazione non li supporta.
- **Due forme di istruzione non implementate:** `P##parametro` (`fb ca` / `fb cb`) e `fb d9`.
- **Valori attuali dei DB:** non si modificano. Si conservano all'importazione e si esportano identici finché il DB non viene ricompilato.
- **Valori di istanza dei DB d'istanza importati:** l'elenco dei valori propri del singolo DB (che sostituiscono i valori iniziali dell'FB) è vuoto.

### Timer e contatori IEC (SFB)

- **Statici interni non documentati.** I manuali pubblici non riportano i dati statici interni di TON, TOF, TP e degli altri SFB. Il layout di un'istanza si ricava solo da un blocco reale importato che usa quell'SFB, per esempio dal kit del PLC.
- **Senza un blocco reale, errore chiaro** (`LAYOUT_SFB_SCONOSCIUTO`). Valgono per esempio per un FB scritto a mano con un TON in multi-istanza, un DB d'istanza di un SFB, o un blocco che li richiama.
- **Valori iniziali presi dal campione.** Un nuovo DB d'istanza di un SFB prende i valori iniziali degli statici dal blocco reale usato come campione, con una nota che lo dice.
- **Numeri di timer e contatori** oltre i limiti della CPU del catalogo (`T 256` su una CPU da 256) sono un errore `ADDRESS_OUT_OF_RANGE` nel controllo AWL e nella compilazione, come le aree I/Q/M; nelle tabelle delle variabili lo stesso codice segnala l'indirizzo.

### Blocchi importati

- **Reti che restano in MC7 grezzo.** Alcune reti reali non si ricostruiscono in AWL e restano come `// MC7 grezzo`. Esportate senza modifiche sono identiche; modificate, danno un errore chiaro. Riguarda:
  - richiami UC/CC con lista di puntatori quando il blocco chiamato non è noto;
  - richiami indiretti (`UC FC [LW 16]`);
  - le CALL di un blocco in cui un'altra rete non ricostruita usa la base dei temporanei dei richiami;
  - `CALL #istanza (IN := #t.Q)`;
  - una CALL di SFB rimasta espansa (`OPN DI … UC SFB`): in quel caso il DB non viene riconosciuto come istanza.
- **Importazione parziale in un progetto esistente.** Se un blocco importato dipende da un blocco del progetto che non arriva nella stessa importazione, la dipendenza è "estranea":
  - le reti che la usano si ricompilano dal testo, oppure danno un errore chiaro;
  - un DB d'istanza di un FB estraneo resta bloccato finché non lo si ricrea o lo si reimporta insieme al suo FB.
- **Ricaricamento dallo stesso PLC.** I blocchi identici restano con i nomi e i commenti dati dall'utente. Se un controllo li segna come incoerenti, cambiano solo i metadati, e il riepilogo li mostra come "aggiornati i metadati". Due casi danno solo un errore chiaro, senza una soluzione automatica:
  - Se cambia soltanto la larghezza di un operando passato a un parametro (per esempio `A0 := MW 10` verso un DInt), il blocco resta quello di prima. Modificando quella rete si ottiene l'errore `CALL_PARAM_TYPE`.
  - I valori iniziali di un DB d'istanza diversi da quelli del suo FB (succede solo con un PLC incoerente) non vengono controllati. Una rigenerazione usa quelli dell'FB e dà l'avviso `VALORI_ATTUALI_PERSI`.
- **Testi dei messaggi.**
  - Alcuni dettagli (`{{detail}}`) restano in italiano anche nell'interfaccia inglese.
  - Le diagnosi senza causa nota mostrano il testo generico.
  - L'avviso `ACCESSO_ASSOLUTO_ISTANZA` può comparire anche per accessi `[AR2,P#…]` che non riguardano l'istanza.

### Prestazioni e struttura

- **Ricompilazione grossolana.** Qualsiasi modifica a variabili, costanti, UDT o interfacce ricompila tutti i blocchi, anche in modalità _solo modifiche_.
- **Impronte senza cache.** Le impronte delle dipendenze si ricalcolano a ogni compilazione; su progetti molto grandi il costo cresce.
- **Pacchetto `s7comm` intero nel renderer.** L'interfaccia include tutto il pacchetto solo per leggere lo zip del kit. Non è un percorso di scrittura; basterebbe un'esportazione separata per il kit.

### Altro

- **Chiusura dell'app con progetto non salvato:** compare la domanda di salvataggio, come previsto. Le prove automatiche dell'app impacchettata devono salvare o scartare prima di chiudere.

## Aggiornamenti (piano 3U)

- **Le versioni fino alla 0.11.0 non si aggiornano da sole:** le loro release non hanno `latest.yml` né `latest-mac.yml`. Va installata la 0.12.0 a mano una volta. Lo dicono anche le note di rilascio della 0.12.0.
- **Niente firma dell'editore.** Su Windows l'integrità è lo sha512 di `latest.yml`, preso dalla stessa release via HTTPS: chi può modificare la release può anche modificare l'aggiornamento.
- **macOS: niente aggiornamento automatico vero** (niente Squirrel.Mac senza firma Developer ID). L'app scarica e verifica il DMG, ma l'utente sostituisce l'app a mano. Al primo avvio dopo la sostituzione, Gatekeeper può chiedere conferma come alla prima installazione. Il DMG lo scrive l'app, quindi macOS non lo marca come scaricato da Internet: l'integrità resta lo sha512.
- **Versioni di prova: «più recente», non «più alta».** Con le versioni di prova attive electron-updater prende la release più recente del feed di GitHub. Il controllo semver evita sempre i ritorni indietro, ma se si pubblicasse una versione più bassa dopo una più alta, chi ha la più alta non la vede (giusto) e chi ha una più vecchia riceve quella più recente. Regola di rilascio: pubblicare le versioni in ordine crescente.
- **Windows, installazione «per tutti gli utenti»:** l'aggiornamento chiede i permessi di amministratore (UAC).
- **Limiti di GitHub.** GitHub limita le richieste senza account: dietro un indirizzo condiviso (rete aziendale) un controllo può fallire; quello automatico tace e riprova dopo 6 ore.
- **Proxy con autenticazione** non gestito.
- **Mai provato su una release vera** fino alla prima release dopo la 0.12.0 (0.12.1 o 0.13.0): la prova va fatta su Windows e su un Mac per architettura.
- **Niente e2e contro GitHub:** le regole sono provate con un updater finto.
- **Controllo a mano durante uno scaricamento:** non mostra nulla (nessun «aggiornato» né altro avviso); lo scaricamento prosegue e il suo avanzamento resta visibile.
- **Release non ancora completa:** fra la pubblicazione di una release e il caricamento di `latest*.yml` da parte della CI, o se il lavoro di una piattaforma fallisce, i controlli su quella release falliscono. Quello automatico tace; quello a mano mostra «La release non ha il file di aggiornamento».
- **Da prova a stabile su GitHub:** cambiare una release da pre-release a stabile non cambia il canale delle build già fatte; serve rifarle con workflow_dispatch.
- **macOS, DMG pronto:** finché l'app non viene riavviata, i controlli automatici non ripartono.
- **Installazione fallita dopo «Non salvare»:** la copia di recupero era già stata cancellata (`beforeWindowClose`).
- **Installazione fallita:** se l'installatore non parte, l'app riabilita le operazioni online e mostra l'errore; la finestra di salvataggio e l'offline erano già stati eseguiti.

## Informazioni sul programma (piano 7A)

- **Indirizzamento indiretto non risolto.** `L MW [MD 20]` registra la lettura del puntatore `MD20`, non l'indirizzo puntato; gli accessi tramite registro (`[AR1, P#…]`) e i puntatori `P#…` non compaiono.
- **DB aperto.** `L DBW 4` dopo un `OPN` è la voce `%DBW4` senza numero di DB: non si segue quale DB è aperto. Gli accessi `DI…` restano a sé, senza il DB di istanza.
- **Fuori dai riferimenti incrociati:** variabili locali (`#x`, area L, anche i bit di appoggio del KOP), costanti scritte, salti ed etichette, `STW` e i registri, le sorgenti AWL esterne, i valori iniziali dei DB, i blocchi know-how. Le tabelle di controllo non contano come uso.
- **Dati complessi interi** (STRUCT, ARRAY, UDT passati a una CALL) non hanno un indirizzo elementare: restano col testo scritto e non si confrontano per sovrapposizione.
- **Simboli sconosciuti** restano col testo scritto, senza indirizzo.
- **Parametro sconosciuto** di una CALL (blocco mancante o parametro non dichiarato): l'accesso è «lettura e scrittura».
- **KOP e FUP:** il punto d'uso è l'elemento che ha prodotto la riga dell'AWL generato; il primo operando dell'elemento per Maiusc+F11. **SCL:** la parola sotto il cursore, senza il parser SCL; la riga è quella del testo SCL da cui viene l'istruzione AWL.
- **Struttura di richiamo:** solo le chiamate scritte (CALL, UC, CC, multi-istanze); un `UC` con puntatore o un richiamo calcolato non compare. Gli OB non chiamati non sono «non usati»: sono le radici. Un albero con molte chiamate ripetute si apre un livello alla volta.
- **Ricalcolo:** tutto si ricalcola a ogni modifica del progetto mentre la scheda è aperta; su programmi molto grandi può essere lento.

## Fuori dal codice, in sospeso per l'utente

- Controlli a mano dei piani 1B (Windows e Mac), 1C e 1F. Le liste sono nei piani; per la 1F: xlsx in Excel e LibreOffice, xlsx di TIA Portal, Archivia/Ritira con percorsi accentati e con spazi, scala a 125%.
- Facoltativo: l'amico lancia il kit di raccolta e manda lo zip, che va in `fixtures-private/kit/` e mai nel repository.
- Una CPU S7-300 non in produzione per le prove di conformità (le farà l'amico dell'utente a prodotto finito).
