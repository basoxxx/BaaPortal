# Limiti noti

Qui si elencano i limiti conosciuti di BaaPortal: cose che oggi mancano, sono incomplete o restano da verificare. La lista si aggiorna alla fine di ogni piano. **Alla fine di tutte le tappe si riguarda punto per punto insieme all'utente**, per decidere che cosa sistemare.

Per ogni voce si indica che cosa succede oggi. "Errore chiaro" vuol dire che BaaPortal si ferma e lo dice: non produce mai codice sbagliato senza avvisare.

## Mancanze aperte

- **Stato della tappa 1.** Tutti i punti della spec §9 sono fatti (piani 1A–1F) tranne uno: la conformità su CPU reale, che resta **in sospeso**. La spec §6 dice che la tappa 1 non si chiude senza i test di conformità su CPU reale: la tappa 1 resta quindi **formalmente aperta** e si chiude solo quando quelle prove saranno fatte.
- **Prove di conformità su una CPU reale.** Ora esistono i mezzi (carica nel dispositivo ed esecuzione, piano 1D-bis), ma le prove restano **in sospeso**: non c'è una S7-300 non in produzione. Le farà l'amico dell'utente a prodotto finito. I blocchi compilati da BaaPortal non sono mai stati caricati né eseguiti su una CPU. Il simulatore della tappa 2 controllerà la coerenza interna, ma non sostituisce questa verifica (spec §10). Il punto di decisione della spec §11 resta aperto.
- **Provenienza 1D-bis.** Scrittura di variabili, carica nel dispositivo e STOP/avvio esistono e sono verificati contro il finto PLC e contro i byte delle catture pubbliche (`cisa/snap7.pcap` per scrittura, stop e avvio a freddo; la cattura del download di un blocco). Il giro completo «la CPU accetta ed esegue un blocco compilato da BaaPortal» non è mai stato provato su una CPU reale (spec §10). Il riavvio a caldo è verificato solo in parte. Restano per la tappa 3 (R1, R3): `_DELE`, `_GARB`, `_MODU` (copia RAM→ROM), MRES, forzatura, impostazione dell'orologio, riavvio a freddo e a caldo, e l'interfaccia online dell'app.

## Funzioni 1F (piano 1F)

### Importa/esporta variabili (csv e xlsx)

- **Costanti in csv.** Il csv ha un solo foglio, quindi le costanti non si esportano: per averle si usa xlsx.
- **xlsx scritto in forma minima.** Nessuna formattazione (larghezze, colori, stili); il file si apre ma è spartano.
- **csv, virgolette non chiuse.** Una virgoletta aperta e mai chiusa inghiotte il resto del file in un solo errore `RIGA_ILLEGGIBILE`.
- **csv, formule.** In esportazione le celle che iniziano con `=`, `+`, `-` o `@` non sono protette: Excel può leggerle come formule.
- **xlsx, limite di dimensione.** I 50 MB valgono solo per il file compresso. Il limite di decompressione si fida della dimensione dichiarata nell'intestazione dello zip, e la dimensione viene ricontrollata dopo l'estrazione.
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
- **Percorsi.** Si confrontano come stringhe.
- **Scorciatoie della tappa 3** non collegate.

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
