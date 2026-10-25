# Limiti noti

Qui si elencano i limiti conosciuti di BaaPortal: cose che oggi mancano, sono incomplete o restano da verificare. La lista si aggiorna alla fine di ogni piano. **Alla fine di tutte le tappe si riguarda punto per punto insieme all'utente**, per decidere che cosa sistemare.

Per ogni voce si indica che cosa succede oggi. "Errore chiaro" vuol dire che BaaPortal si ferma e lo dice: non produce mai codice sbagliato senza avvisare.

## Mancanze aperte

- **Stato della tappa 1.** Tutti i punti della spec §9 sono fatti (piani 1A–1F) tranne uno: la conformità su CPU reale, che resta **in sospeso**. La spec §6 dice che la tappa 1 non si chiude senza i test di conformità su CPU reale: la tappa 1 resta quindi **formalmente aperta** e si chiude solo quando quelle prove saranno fatte.
- **Prove di conformità su una CPU reale.** Ora esistono i mezzi (carica nel dispositivo ed esecuzione, piano 1D-bis), ma le prove restano **in sospeso**: non c'è una S7-300 non in produzione. Le farà l'amico dell'utente a prodotto finito. I blocchi compilati da BaaPortal non sono mai stati caricati né eseguiti su una CPU. Il simulatore della tappa 2 controllerà la coerenza interna, ma non sostituisce questa verifica (spec §10). Il punto di decisione della spec §11 resta aperto.
- **Provenienza 1D-bis.** Scrittura di variabili, carica nel dispositivo e STOP/avvio esistono e sono verificati contro il finto PLC e contro i byte delle catture pubbliche (`cisa/snap7.pcap` per scrittura, stop e avvio a freddo; la cattura del download di un blocco). Il giro completo «la CPU accetta ed esegue un blocco compilato da BaaPortal» non è mai stato provato su una CPU reale (spec §10). Il riavvio a caldo è verificato solo in parte. Restano per la tappa 3 (R1, R3): `_DELE`, `_GARB`, `_MODU` (copia RAM→ROM), MRES, forzatura, impostazione dell'orologio, riavvio a freddo e a caldo, e l'interfaccia online dell'app.
- **Scorciatoie della tappa 3 non collegate.** Ctrl+L (carica nel dispositivo), Ctrl+K (collegamento online) e Ctrl+M (interrompi collegamento online) non fanno ancora nulla: le funzioni online dell'interfaccia sono della tappa 3.

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
- **«Avviare la CPU?» anche se era già in STOP.** Dopo un caricamento BaaPortal fa la domanda anche quando la CPU era già in STOP prima.
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
- **Backup in sola esportazione.** Il ripristino arriva nel 3D. Non si sa se i DB caricati hanno i valori attuali o quelli iniziali (§19.4).
- **Il backup registra il modo visto per ultimo dalla sorveglianza,** non quello riletto all'inizio.
- **Lettura di un `.baapbak`.** Per il ripristino del 3D, la lettura si fida delle dimensioni dichiarate nello zip.
- **Niente messaggi push.** Il buffer si aggiorna ogni secondo, solo con l'editor aperto.
- **`_DELE` usa 'A'.** Vedi «Caricamento e confronto (piano 3B)».
- **Impostazione dell'ora con protezione di livello 3.** Anche la risposta `0xD0A1` è un'ipotesi (§12.0).
- **Il numero di richieste nella conferma è un massimo solo se la CPU concorda una PDU di almeno 240 byte.** Con una PDU più piccola le richieste possono essere di più.
- **Più tabelle con «Osserva tutto» interrogano ognuna per conto suo.** Il limite di 200 righe vale per tabella, e le tabelle aperte ma non in primo piano continuano a interrogare.
- **Il backup continua sul suo collegamento** anche se il collegamento online cade o si va offline: lo ferma solo _Interrompi_.
- **I file `.baapbak` non compaiono nell'albero** fino al 3D.
- **I record di diagnostica più corti di 20 byte si scartano.**
- **Il pulsante si chiama «Osserva tutto»,** il nome del 2C, e non «Controlla tutto» come in TIA.

## Osservazione e ripristino online (piano 3D)

- **Ripristino di un backup: sperimentale, mai provato su una CPU reale.** Solo contro il PLC di prova (in STOP, SDB come blob opachi). Il comportamento reale di una CPU a un download di SDB in RUN, l'ordine degli SDB diversi da 0 e il risultato su moduli e DP/PN sono sconosciuti (proto §19.3).
- **Il ripristino non cancella i blocchi utente presenti solo sulla CPU:** restano e sono elencati («Restano nella CPU»). Si cancellano solo gli SDB assenti nel backup e ripristinabili (0, 1, 3-7, 1000-1999, 2000-2999); SDB 2 non si tocca mai.
- **Nessuna ripetizione né annullamento.** Dopo un errore i passi seguenti sono «Non caricato» e la CPU resta in STOP; il passo in corso quando cade il collegamento è «Esito sconosciuto».
- **Il filtro `online-restore` ammette** solo i frame canonici del ripristino (lettura, lista dei job, download e `_INSE` con `P`, `_DELE` degli SDB con `A`, STOP e avviamento a caldo). `online-write` rifiuta ora anche download e `_INSE` di SDB.
- **Lettura del `.baapbak`:** i byte si contano mentre si decomprimono (manifest 64 KB, blocchi la `length` del manifest, al massimo 1 MB ciascuno); la dimensione dichiarata nell'archivio non conta più.
- **Osservazione del blocco:** nel pannello, la prima finestra si taglia per una PDU di 240 byte; con una PDU più grande la CPU concede più righe, e il renderer ne chiede di più con una seconda finestra (un delete e un create in più). `SAZ` di una finestra tagliata dal main è l'inizio della prima riga scartata, non quello dell'istruzione successiva del testo (ipotesi di §18).
- **Il registro dei job** (`tis-jobs.json`) scrive subito alla creazione di un job; le cancellazioni si raggruppano e si scrivono dopo 500 ms o all'uscita.

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
  - La rinomina di un tag, di una costante o di un blocco/DB aggiorna le righe che usano `"Nome"` o `"Nome".membro`; la rinomina di un **membro** di un DB o di un UDT non aggiorna le tabelle di controllo (la riga mostra un errore di risoluzione finché non si corregge).
  - Non c'è un forzamento permanente né un «trigger»: c'è solo «Comanda», una scrittura una tantum.
  - Le tabelle non si copiano, tagliano, incollano né trascinano nell'albero; non ci sono gruppi né importazione o esportazione.
  - Al più 1000 righe osservate per richiesta; le righe oltre il limite danno un errore di riga.
  - Un file `.baap` del formato 4 non si apre con un'app più vecchia (`NEWER_FORMAT`).

## Funzioni 1F (piano 1F)

### Importa/esporta variabili (csv e xlsx)

- **Costanti in csv.** Il csv ha un solo foglio, quindi le costanti non si esportano: per averle si usa xlsx.
- **xlsx scritto in forma minima.** Nessuna formattazione (larghezze, colori, stili); il file si apre ma è spartano.
- **csv, virgolette non chiuse.** Una virgoletta aperta e mai chiusa inghiotte il resto del file in un solo errore `RIGA_ILLEGGIBILE`.
- **csv, formule.** In esportazione le celle che iniziano con `=`, `+`, `-` o `@` non sono protette: Excel può leggerle come formule.
- **xlsx, limite di dimensione.** Il file compresso può arrivare a 50 MB. Si gonfiano solo le voci che servono (cartella di lavoro, relazioni, stringhe condivise, tipi di contenuto e i fogli referenziati); ogni voce e il totale non possono superare 200 MB, altrimenti errore chiaro «troppo grande». Il limite per voce si fida della dimensione dichiarata nell'intestazione dello zip, e la misura reale viene ricontrollata dopo l'estrazione.
- **Valori delle costanti importate.** Non vengono controllati rispetto al loro tipo, come nell'editor a griglia.
- **xlsx, DOCTYPE.** Un DOCTYPE con sottoinsieme interno non si legge (errore chiaro).
- **xlsx, ritorni a capo.** Un `\r` dentro un testo non torna identico dopo l'esportazione e la rilettura.
- **Nomi unici per CPU solo nell'importazione** (`NOME_IN_ALTRA_TABELLA`). Nomi doppi creati a mano in tabelle diverse non vengono segnalati.
- **Nome file.** Un nome digitato come `x.txt` in esportazione diventa `x.txt.xlsx`.

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
- **Numeri di timer e contatori** non vengono confrontati con i limiti della CPU.

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

## Fuori dal codice, in sospeso per l'utente

- Controlli a mano dei piani 1B (Windows e Mac), 1C e 1F. Le liste sono nei piani; per la 1F: xlsx in Excel e LibreOffice, xlsx di TIA Portal, Archivia/Ritira con percorsi accentati e con spazi, scala a 125%.
- Facoltativo: l'amico lancia il kit di raccolta e manda lo zip, che va in `fixtures-private/kit/` e mai nel repository.
- Una CPU S7-300 non in produzione per le prove di conformità (le farà l'amico dell'utente a prodotto finito).
