# Testi di progetto

Guida breve ai testi multilingua (tappa 7D): titoli e commenti in più lingue, nella stessa soluzione, con esportazione per i traduttori.

## Che cosa si traduce

Titoli e commenti di blocchi, segmenti, membri dell'interfaccia e dei DB, tipi di dati (UDT), variabili e costanti, e le etichette di testo delle schermate HMI. Nomi, indirizzi e codice non si traducono.

## Le lingue

_Opzioni → Testi di progetto…_

- **Lingua di modifica:** quella in cui si scrive nei campi di sempre (per esempio `it-IT`). Il testo scritto lì è il testo del progetto: i file senza lingue si aprono come prima.
- **Altre lingue:** elenco separato da virgole (`en-US, de-DE`). Codici come `it-IT`, `en-US`, `fr`, senza ripetizioni.
- **Lingua mostrata:** quale lingua usano per i commenti gli editor, la stampa e il PDF. Dove manca la traduzione si vede il testo della lingua di modifica.

Togliere una lingua dall'elenco cancella le sue traduzioni.

## Guardare una traduzione

Con una lingua mostrata diversa da quella di modifica, titoli e commenti dell'editor dei blocchi (segmenti e intestazione), delle interfacce e dei DB, delle tabelle delle variabili e delle costanti sono **di sola lettura** e un avviso lo ricorda. Per scrivere si torna alla lingua di modifica oppure si usa la tabella dei testi. La stampa e il PDF usano la lingua mostrata. Il runtime HMI mostra le etichette tradotte.

## La tabella

Una riga per ogni testo non vuoto: oggetto, campo, testo nella lingua di modifica e una colonna per lingua. Si scrive la traduzione nella cella; il filtro cerca nell'oggetto e nei testi. Oltre 300 righe se ne mostrano le prime 300: si restringe col filtro.

## Esportare e importare

- **Esporta xlsx / csv:** un file con le colonne `Key`, `Object`, `Field`, la lingua di modifica e le altre lingue, comprese le traduzioni già scritte. Si manda al traduttore.
- **Importa…:** legge lo stesso formato (xlsx o csv). Vale la colonna `Key`, che non va modificata; le celle vuote non cambiano nulla; le righe con una chiave che non c'è più e le lingue non dichiarate si scartano e il messaggio dice quante. Un'importazione è un solo passo di annullamento.

Le celle che iniziano con `=`, `+`, `-`, `@` si esportano con un apice in più, così Excel non le esegue come formule; l'importazione lo toglie.

Le traduzioni di oggetti cancellati non vengono salvate nel file.
