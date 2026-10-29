# FUP e SCL (in prova)

Guida breve ai due linguaggi in prova della versione 1.0.0. Funzionano nel simulatore, ma non sono mai stati provati su una CPU reale.

## Attivarli

_Impostazioni → Funzioni sperimentali_. Da quel momento, in _Inserisci → Nuovo blocco…_ si possono scegliere anche _FUP_ e _SCL_. I blocchi FUP e SCL già creati si aprono sempre, anche con l'impostazione spenta.

## FUP

1. **Stesso disegno del KOP.** Un blocco FUP ha le stesse reti di un blocco KOP, disegnate a riquadri: `&` per una serie di contatti, `>=1` per un parallelo, un cerchietto per una negazione, le uscite (`=`, `S`, `R`, temporizzatori, contatori, salti) a destra con l'operando sopra.
2. **Cambiare linguaggio.** _Passa a KOP/FUP_ sopra i segmenti (o _Modifica → Cambia linguaggio KOP/FUP_) cambia il linguaggio del blocco senza perdere nulla. Si può annullare.
3. **Modificare.** Un clic seleziona un elemento. Doppio clic o Invio modificano l'operando (Invio conferma, Esc annulla) e Canc elimina l'elemento.
4. **Aggiungere elementi.** In FUP non si inserisce: si passa a KOP, si aggiunge e si torna a FUP.
5. **Compilare.** Come un blocco KOP: stesso AWL generato, stessi errori.

## SCL

1. **Il testo.** Un blocco SCL ha un solo testo, fatto solo di istruzioni. Le variabili si dichiarano nella tabella dell'interfaccia del blocco, come negli altri linguaggi.
2. **Esempio** (FC con ingressi `a`, `b` INT, uscita `max` INT e `alto` BOOL):

   ```
   IF a > b THEN
     max := a;
   ELSE
     max := b;
   END_IF;
   alto := max > 100 AND NOT "Blocco";
   ```

3. **Operandi.** Le variabili dell'interfaccia si scrivono con o senza `#`, i simboli globali tra virgolette (`"Motore"`) e gli indirizzi come `M0.0`, `MW10` o `MD20`.
4. **Errori.** Il primo errore compare sotto il testo come «Riga N: …» e blocca la compilazione.
5. **Compilare e provare.** _Compila_ traduce il testo in AWL e compila quello. Si carica nel simulatore e si prova con una tabella di controllo.

Che cosa c'è e che cosa manca (tipi, istruzioni, conversioni): `docs/limiti-noti.md`, sezioni _FUP in prova_ e _SCL in prova_.
