# Editor AWL

Guida breve all'editor di testo AWL (lista istruzioni). Un blocco AWL è fatto di segmenti; ogni segmento è un testo che BaaPortal controlla a ogni modifica e compila in codice MC7.

1. **Creare un blocco AWL.** _Inserisci → Nuovo blocco…_, scegli OB, FB o FC e come linguaggio _AWL_. Il blocco si apre con un segmento vuoto. Ogni segmento ha titolo e commento, e un menu (⋯) per aggiungerne, spostarlo o eliminarlo.
2. **Scrivere.** Un'istruzione per riga: `A I 0.0`, `= Q 4.0`, `L MW 10`, `CALL "Calcolo"`. I commenti iniziano con `//`. Le etichette dei salti stanno a inizio riga (`M001:`). Il testo si conferma uscendo dal segmento: da quel momento il progetto è modificato e un passo di _Annulla_ lo riporta indietro.
3. **Mnemonica.** In _Impostazioni → Editor_ si sceglie la mnemonica: internazionale (`A`, `I`, `Q`, `T`, `C`) o tedesca (`U`, `E`, `A`, `T`, `Z`). Cambia solo il modo di mostrare e scrivere il testo; il progetto conserva sempre l'internazionale.
4. **Operandi.** Indirizzi assoluti (`I 0.0`, `MW 10`, `DB1.DBW 2`), simboli della tabella delle variabili tra virgolette (`"Start"`), membri dei DB (`"Dati".Velocità`) e variabili locali con il cancelletto (`#Ingresso`).
5. **Completamento.** Dopo `"`, `#` o `.` l'editor propone simboli, variabili locali e membri; si può chiamare anche con Ctrl+Spazio. Si disattiva in _Impostazioni → Editor_.
6. **Errori.** Gli errori del segmento sono sottolineati nel testo e compaiono in _Problemi_ con segmento e riga; un clic sulla voce porta alla riga. La compilazione (_Compila → Software_) controlla il blocco intero (salti, etichette, parametri delle CALL).
7. **Riferimenti incrociati.** Maiusc+F11 sull'operando sotto il cursore apre i riferimenti incrociati filtrati su quell'operando (vedi _Riferimenti incrociati e struttura di richiamo_).
8. **Osservare.** Con il simulatore o una CPU collegata, _Osserva programma_ mostra riga per riga i valori letti dalle istruzioni (in una CALL su più righe, la riga di un parametro di dati copiato mostra il suo valore); una modifica del testo sospende l'osservazione fino a nuova compilazione e caricamento.
9. **Trova e sostituisci.** _Modifica → Trova e sostituisci_ cerca anche nei segmenti AWL, nella mnemonica scelta. La rinomina di un simbolo o di un blocco aggiorna i riferimenti nel codice.
10. **Blocchi in sola lettura.** Un blocco importato da una CPU o da MC7 che non si può ricodificare identico, un blocco con protezione know-how e un segmento convertito da KOP/FUP sono in sola lettura; un segmento con righe `// MC7 grezzo:` mostra un avviso.
11. **Convertire in KOP/FUP.** _Modifica → Converti in KOP/FUP_ trasforma in grafico i segmenti che hanno una rete equivalente (vedi _Editor KOP_).

L'elenco delle istruzioni e delle scelte di compilazione è in `docs/linguaggi/kop-awl.md`; i limiti noti sono in `docs/limiti-noti.md`.
