# BaaPortal — documento di passaggio dopo il piano 3D

Data: 25 ottobre 2026. Versione: 0.13.0 (pre-release).

BaaPortal è un clone di TIA Portal per le CPU S7-300, scritto da zero (clean-room) con Electron, React e TypeScript. Il repository è pubblico: <https://github.com/basoxxx/BaaPortal>. La specifica è in `docs/superpowers/specs/2026-10-18-baaportal-design.md`. Il piano generale, con lo stato di ogni piano, è in `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`.

## 1. Dove siamo

Sono fatti 15 piani su 28 (le tappe 1, 2 e 3, più il piano 3U). Restano le tappe 4–7: KOP/FUP, SCL, configurazione hardware e rete, strumenti e documentazione.

| Tappa | Piani | Contenuto                                                                                                  | Versione    |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| 1     | 1A–1F | Interfaccia, progetto `.baap`, modello dati, AWL, compilatore MC7, lettura e scrittura base sul PLC        | 0.1.0–0.5.0 |
| 2     | 2A–2C | CPU simulata: esecuzione MC7, temporizzatori, contatori, OB, SFC, strumenti di test                        | 0.6.0–0.8.0 |
| 3     | 3A    | Online in sola lettura: scansione, collegamento, CPU PN, CP 343-1, gateway                                 | 0.9.0       |
| 3     | 3B    | Carica nel dispositivo, carica dal dispositivo, confronto, RUN/STOP/MRES, copia RAM→ROM                    | 0.10.0      |
| 3     | 3C    | Diagnostica online, buffer di diagnostica, ora, tabelle online, backup in un file `.baapbak`               | 0.11.0      |
| 3     | 3U    | Aggiornamenti automatici in app (Windows; su macOS il DMG scaricato e verificato)                          | 0.12.0      |
| 3     | 3D    | Osservazione online AWL, LED FRCE, stack di chiamata e ripristino del backup (gli ultimi due sperimentali) | 0.13.0      |

Tutte le release sono pre-release, con installatori per Windows (.exe) e per Mac (.dmg arm64 e x64): <https://github.com/basoxxx/BaaPortal/releases>. Si toglierà «pre-release» quando l'app sarà provata su una CPU reale.

## 2. Cosa serve per andare avanti

1. **Una CPU S7-300 di prova, non in produzione.** È la cosa più importante. Nessuna funzione che scrive sul PLC è mai stata provata su una CPU reale: carica nel dispositivo, comandi di modo, scrittura di variabili, ora, osservazione, ripristino. La specifica (§5) chiede di provare ogni scrittura prima su una CPU di prova. Consigliata: 315-2 PN/DP o 314C-2 PN/DP, con alimentatore, Micro Memory Card e cavo Ethernet.
2. **Le catture con la CPU vera,** per chiudere le ipotesi del protocollo elencate in `docs/limiti-noti.md` e in `docs/protocollo/s7comm.md` §18–§19:
   - la fine della finestra (SAZ) nello stato del blocco;
   - come la CPU segna una riga non eseguita;
   - la forma della richiesta degli stack;
   - l'ordine fra SDB e blocchi utente nel ripristino;
   - il forzamento, se lo si vuole.
3. **La prova degli aggiornamenti automatici:** con la 0.12.0 installata su Windows e su un Mac per architettura, verificare che arrivi la 0.13.0.
4. **La revisione dei limiti noti con l'utente** (`docs/limiti-noti.md`), prevista alla fine del progetto.

## 3. Cosa non c'è e perché

- **Forzamento e tabelle di forzamento:** non implementati. Il protocollo non è documentato abbastanza da scriverlo in sicurezza: il dissector di Wireshark descrive la funzione 0x09, ma la S7-300 sembra usare la 0x07, di cui non esiste una descrizione. L'app mostra solo «Forzamento attivo sulla CPU» (LED FRCE). Per forzare va usato TIA Portal o STEP 7.
- **Stack di chiamata e ripristino del backup:** sperimentali, dietro _Opzioni → Impostazioni → Funzioni sperimentali (non provate su una CPU reale)_, spenta per default. Il ripristino rifiuta un backup incompleto, una CPU di modello diverso, il forzamento attivo, un job di test attivo e un livello di protezione che non lo consente. Il riavvio a fine ripristino parte solo se l'utente lo chiede.
- **Firma degli installatori:** assente. Windows e macOS chiedono conferma alla prima installazione. Su macOS l'aggiornamento non può essere automatico (manca la firma Developer ID): l'app scarica e verifica il DMG, e l'utente sostituisce l'app a mano.
- **Chi ha la 0.11.0 o una versione precedente** deve installare a mano la 0.12.0 una volta.

L'elenco completo è in `docs/limiti-noti.md`.

## 4. Come è organizzato il lavoro

- **Metodo:** ogni piano è un file in `docs/superpowers/plans/`, scritto a partire dalle decisioni prese. Lo realizzano agenti implementatori, un task alla volta con test prima del codice. Ogni task ha una revisione, e quelli che scrivono sul PLC hanno una revisione più approfondita. Alla fine c'è una revisione di tutto il ramo e un giro di correzioni.
- **Rilascio:** PR, poi CI verde su Windows e macOS, poi squash merge, poi release su GitHub. Il workflow `release.yml` costruisce gli installatori e i file di aggiornamento e li allega. Controlla anche che il tag corrisponda alla versione.
- **Collaudo completo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`.
- **Regole fisse:**
  - clean-room: il protocollo si scrive solo da `docs/protocollo/s7comm.md`;
  - nei test solo indirizzi IP di documentazione;
  - nessun dato privato;
  - ogni scrittura sul PLC passa da una conferma nativa con «Annulla» come predefinito, e il main controlla ogni frame in uscita.
- **Due incidenti da non ripetere:**
  - durante il 3C un agente ha fatto push dei suoi commit direttamente su main, perché il ramo seguiva origin/main. Ora i rami si creano con `--no-track` e gli agenti non fanno mai push;
  - la PR #16 (3U) è stata unita con la CI rossa. È stata corretta subito dalla PR #17. Ora si controlla l'esito della CI prima di ogni unione.

## 5. Prossimi piani

1. **Tappa 4 — KOP e FUP:** editor grafici, traduzione in AWL secondo gli schemi STEP 7, cambio di linguaggio e osservazione grafica.
2. **Tappa 5 — SCL:** parser, controllo dei tipi, compilatore SCL → AWL, editor e osservazione.
3. **Tappa 6 — Hardware e rete:** rack S7-300, moduli, vista di rete, studio degli SDB, DCP.
4. **Tappa 7 — Strumenti:** riferimenti incrociati, librerie, importazione da STEP 7 V5.5, stampa e documentazione.

Le tappe 4 e 5 sono le più pesanti. Ogni piano parte dalla ricerca sul formato (gli schemi STEP 7 per KOP/FUP, la grammatica SCL), poi la scrittura del piano, poi lo sviluppo.
