# Limiti noti

Qui si elencano i limiti conosciuti di BaaPortal: cose che oggi mancano, sono incomplete o restano da verificare. La lista si aggiorna alla fine di ogni piano. **Alla fine di tutte le tappe si riguarda punto per punto insieme all'utente**, per decidere che cosa sistemare.

Per ogni voce si indica che cosa succede oggi. "Errore chiaro" vuol dire che BaaPortal si ferma e lo dice: non produce mai codice sbagliato senza avvisare.

## Mancanze aperte

- **1D-bis: scrittura e comandi al PLC.** Non ci sono: niente scrittura di variabili, carica nel dispositivo o RUN/STOP. BaaPortal verso la CPU fa solo letture. È segnato nel piano generale e va affrontato a parte.
- **Prove di conformità su una CPU reale.** I blocchi compilati da BaaPortal non sono mai stati caricati né eseguiti su una CPU. Serve una S7-300 non in produzione, che oggi non c'è. Il simulatore della tappa 2 controllerà la coerenza interna, ma non sostituisce questa verifica (spec §10).

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

- Controlli a mano del piano 1B (Windows e Mac) e del piano 1C. Le liste sono nei piani.
- Facoltativo: l'amico lancia il kit di raccolta e manda lo zip, che va in `fixtures-private/kit/` e mai nel repository.
- Una CPU S7-300 non in produzione per le prove di conformità.
