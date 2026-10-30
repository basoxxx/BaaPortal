# Stampa e PDF

Guida breve alla documentazione del programma (tappa 7D): stampare o salvare in PDF una parte del progetto.

## Come si apre

- _Progetto → Stampa…_ (Ctrl+P, Cmd+P su macOS) o il pulsante della barra degli strumenti.
- _Progetto → Esporta in PDF…_
- Tasto destro nell'albero su un PLC, una cartella, un gruppo o uno o più oggetti: _Stampa…_

Si stampa ciò che è selezionato nell'albero (un blocco, più blocchi, una cartella, un gruppo, tutto il PLC). Senza selezione, tutto il primo PLC.

## La finestra

- **Contenuto:** commenti e titoli, interfaccia e membri, codice (segmenti, testo SCL), riferimenti incrociati (solo gli usi nei blocchi stampati).
- **Mnemonici AWL:** internazionali o tedeschi (parte da quelli delle Impostazioni).
- **Carta:** A4 o Letter, verticale o orizzontale.

## Il documento

1. Copertina: progetto, PLC, CPU, data, versione di BaaPortal.
2. Indice.
3. Una sezione per oggetto, su una pagina nuova: blocchi (intestazione, interfaccia, segmenti con titolo, commento e codice), DB con membri e valori iniziali, DB di istanza, tipi di dati (UDT), tabelle delle variabili con costanti, tabelle di controllo.
4. Riferimenti incrociati, se scelti.

KOP e FUP sono riportati come AWL generato (vedi _Limiti noti_). I numeri di pagina sono nel piè di pagina del PDF.

## Sicurezza

Il testo del progetto è trattato come non fidato: ogni campo è sottoposto a escape e il documento si carica in una finestra nascosta senza JavaScript, in sandbox, senza accesso a Node né alla rete.
