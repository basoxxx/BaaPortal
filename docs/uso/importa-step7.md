# Importa da STEP 7

Guida breve all'importazione da STEP 7 V5.5 (tappa 7C): portare in BaaPortal un progetto STEP 7 dalle sue esportazioni standard. Il progetto `.s7p` non si legge: il formato non è documentato e lavoriamo in clean-room.

## Che cosa esportare da STEP 7

- **Sorgenti AWL** (`.awl`): nel SIMATIC Manager, cartella _Sorgenti_, _Inserisci > Software S7 > Sorgente_ o _Genera sorgente_ dai blocchi, poi _Esporta sorgente_. UDT, DB, FB, FC e OB, con titoli e commenti di blocchi e segmenti.
- **Sorgenti SCL** (`.scl`): le sorgenti dell'editor SCL (FUNCTION, FUNCTION_BLOCK, ORGANIZATION_BLOCK, DATA_BLOCK, TYPE).
- **Tabella dei simboli**: editor dei simboli, _Tabella > Esporta_, in uno dei formati `.sdf`, `.seq`, `.dif` o `.asc`.

## Importare

1. Nell'albero del progetto, tasto destro sul PLC: _Importa da STEP 7…_.
2. _Scegli file…_: si possono scegliere più file insieme, anche di tipi diversi (tutti quelli di una cartella con Ctrl+A). _Scegli una cartella…_ legge in un colpo i file STEP 7 del primo livello di una cartella (non le sottocartelle), al massimo 500.
3. L'anteprima elenca i file con gli errori e gli avvisi (riga per riga) e le voci da importare:
   - gli **oggetti** delle sorgenti, con «nuovo» o «sostituisce …» se nel PLC c'è già un oggetto con lo stesso nome o numero;
   - i **nomi dei blocchi** presi dai simboli (`"Motore" FB 10` rinomina l'FB 10 del PLC);
   - la **tabella delle variabili** coi simboli degli operandi.
4. Si spuntano le voci da importare (gli oggetti che sostituiscono qualcosa partono non spuntati). Per un oggetto che sostituirebbe qualcosa si sceglie nel menu accanto allo stato: _Sostituisci_, _Rinomina_ (nome e numero liberi, es. `Axis_1`) o _Rinumera_ (stesso nome, numero libero; solo se l'oggetto esistente ha un nome diverso). Poi si preme _Importa_. Tutto è un solo passo da annullare con Ctrl+Z; il riepilogo va in _Informazioni_.

## Come si legge

- **Ordine:** prima gli UDT, poi OB, FB e FC, poi i DB, qualunque sia l'ordine dei file. Un DB che ha come tipo un UDT di un altro file diventa un DB globale con i membri dell'UDT.
- **Simboli e numeri:** un blocco scritto per nome nella sorgente (`FUNCTION_BLOCK "Motore"`) prende il numero del simbolo omonimo; uno scritto per numero (`FUNCTION_BLOCK FB 10`) prende il nome del simbolo. Senza simbolo, un blocco nuovo prende il primo numero libero.
- **Simboli degli operandi:** mnemonici tedeschi (`E`, `A`, `M`, `PEW`, `T`, `Z`) e internazionali (`I`, `Q`, `M`, `PIW`, `T`, `C`). Se il file non scrive il tipo, si deduce dall'indirizzo (bit Bool, byte Byte, parola Word, doppia parola DWord, T Timer, Z/C Counter). Vanno nella tabella col nome del file (nuova se non c'è; se c'è, le righe con lo stesso nome si aggiornano). Un nome già usato in un'altra tabella del PLC non si importa.
- **Codifica:** UTF-8 (con o senza BOM) se il file è UTF-8 valido, altrimenti Windows-1252 (ANSI), la codifica di STEP 7.
- **SCL:** intestazione e sezioni VAR danno l'interfaccia, il testo fra BEGIN e la fine del blocco diventa il codice del blocco SCL così com'è. I commenti `(* … *)` dell'intestazione e delle dichiarazioni diventano commenti; quelli prima del blocco vanno nel commento del blocco. Le sezioni `CONST` e `LABEL`, che BaaPortal non ha, finiscono come commento in testa al codice, con un avviso. Un costrutto fuori dal sottoinsieme SCL di BaaPortal non si perde: il blocco si importa e l'anteprima ne conta gli errori, da correggere nell'editor.
- **Errori:** una sorgente con un errore (nell'intestazione, nelle dichiarazioni o nel codice AWL) non si importa e l'anteprima mostra riga e messaggio; gli altri file si importano. Una riga sbagliata di una tabella dei simboli si salta, le altre si importano. Un file oltre i 16 MB non si legge.

I limiti sono in `docs/limiti-noti.md`, sezione «Importazione da STEP 7 (piano 7C)».
