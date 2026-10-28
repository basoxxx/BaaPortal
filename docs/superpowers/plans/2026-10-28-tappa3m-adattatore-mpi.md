# Piano 3M: collegamento MPI con l'adattatore seriale

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** collegare BaaPortal a una CPU S7-300 senza Ethernet, per esempio la 313C dell'amico dell'utente. Il collegamento passa dalla porta MPI, con il PC Adapter seriale (RS232) o con un adattatore USB che si presenta come porta COM virtuale e parla lo stesso protocollo. Tutte le funzioni online di oggi devono funzionare anche così.

**Architecture:** oggi `S7Connection` (`packages/s7comm/src/connection.ts`) costruisce da sé TPKT e COTP sopra un `Transport` di byte. Il piano separa le due cose:

- **`PduLink`**: sposta e consegna PDU S7 intere, senza sapere come.
- **Due realizzazioni:**
  - `IsoTcpLink`: il codice TPKT/COTP di oggi, spostato e non riscritto;
  - `MpiAdapterLink`: protocollo del PC Adapter, cioè framing con DLE, inizializzazione dell'adattatore, connessione all'indirizzo MPI, ack per ogni PDU.

Il controllo di sola lettura resta **l'unico punto di passaggio** di ogni PDU in uscita, prima del link. Il collegamento alla porta seriale è un `Transport` nel processo principale, basato su `serialport`.

**Tech Stack:** TypeScript, vitest, Electron. Nuova dipendenza nativa `serialport`, se la licenza è MIT (si controlla nel task 4).

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- §5 clean room;
- §6, collegamenti: «tramite gateway Ethernet-MPI/DP RFC 1006». Questo piano aggiunge l'adattatore seriale, su richiesta dell'utente del 28/10/2026: «integra tutti i modi possibili».

Fonti di protocollo, solo come documentazione (nessun codice copiato):

- libnodave: `doc/MPI.html`, `doc/initAdapter.html`, `doc/gettingStarted.html` e i commenti di `nodave.c`, su https://github.com/netdata-be/libnodave;
- il thread pubblico control.com «S7 MPI RS232 communication protocol».

## Che cosa resta fuori (e perché)

- **PC Adapter USB originale Siemens (6ES7972-0CB20), CP 5611/5711, Siemens PROFIBUS USB.** Usano protocolli USB chiusi con driver Siemens. Supportarli richiederebbe di analizzare software Siemens: anti-obiettivo della spec, §4.
- **Variante «MPI v3»** (stile STEP 7, frame `7E` con CRC16). Le fonti lette sono parziali, quindi si aggiunge solo se la prova reale mostra che l'adattatore del cliente non parla v1 né v2. Diventa una voce dei limiti noti.
- **PPI (S7-200)** e **PROFIBUS DP come master.** Fuori dal perimetro S7-300.
- **Consiglio d'acquisto, che non richiede codice:** il modo più semplice per una 313C resta un gateway MPI→Ethernet che dichiari RFC 1006 o ISO-on-TCP, come IBH Link S7++, Helmholz NETLink PRO o Hilscher NT 50-MPI. BaaPortal lo supporta già con il collegamento _Gateway RFC 1006_. Lo dice anche `docs/uso/online.md`, nel task 6.

## Global Constraints

- Clean room (spec §5): i byte delle fonti si usano come fatti del protocollo, riscritti da noi. Ogni costante ha un commento con la fonte (`// libnodave doc/MPI.html`) e la scritta «da verificare su adattatore reale».
- **Sicurezza sulla macchina** (spec §4 e §5): ogni scrittura passa dalle stesse conferme e dallo stesso `assertOutgoingFrame`, cioè dal controllo di sola lettura, come per il TCP. Il link MPI non riceve mai una PDU che il controllo non ha visto.
- Valori predefiniti, da libnodave `gettingStarted.html`, da verificare:
  - porta seriale a 38400 baud, 8 bit, parità dispari, 1 bit di stop;
  - indirizzo MPI locale 0, indirizzo della CPU 2;
  - bus a 187,5 kbit/s;
  - indirizzo più alto (HSA) 31;
  - attesa di risposta di 1 s per messaggio, PDU proposta di 240 byte.
- Testi in `packages/ui/src/i18n/it.json` e `en.json`, con i termini di TIA Portal italiano (per esempio «Interfaccia PG/PC», «Indirizzo MPI», «Velocità di trasmissione»).
- Nessun file di progetto vecchio si rompe: `PlcAccess` senza `link` vuol dire TCP, come oggi.
- Nessuna modifica ai workflow di GitHub senza dirlo. Se `release.yml` deve cambiare per il modulo nativo, il task 4 lo scrive nelle note per l'utente e non lancia nulla.

## Review Focus

1. **Cavo staccato o adattatore spento durante un carica nel dispositivo:** errore chiaro («Adattatore MPI non risponde»), collegamento chiuso, nessun blocco caricato a metà senza avviso. Lo stato si rilegge come dopo un'interruzione TCP. Test nel task 3.
2. **Porta COM sbagliata, occupata da un'altra applicazione, o adattatore che non risponde all'inizializzazione** (velocità o parità sbagliate): errore che suggerisce che cosa controllare, e nessuna attesa infinita. Test nei task 2 e 4.
3. **Indirizzo MPI della CPU sbagliato:** l'adattatore risponde ma la CPU no. L'errore elenca i nodi visti sul bus. Test nel task 2.
4. **Controllo di sola lettura:** una scrittura in modo `read-only` sul link MPI si rifiuta prima che un byte esca sulla seriale. Test nel task 1 e nel task 3.
5. **Progetto vecchio, senza `link`:** si apre e si collega in TCP come prima. Test nel task 5.

---

### Task 1: `PduLink` e spostamento di ISO-on-TCP

**Files:**

- Create: `packages/s7comm/src/link.ts`, con l'interfaccia `PduLink` e `IsoTcpLink`, che riceve il codice TPKT/COTP di `connection.ts`: handshake CR/CC, DT, DR e frammentazione.
- Modify: `packages/s7comm/src/connection.ts`, che usa un `PduLink` al posto di TPKT/COTP diretti.
- Modify: `packages/s7comm/src/readOnlyGuard.ts`. `assertOutgoingFrame` oggi controlla un frame TPKT; va aggiunto `assertOutgoingPdu(s7: Uint8Array, mode, pduLength)`, che controlla la PDU S7. `assertOutgoingFrame` resta, scomposta su `assertOutgoingPdu`, per i chiamanti di oggi.
- Test: i test esistenti di `packages/s7comm/test`, tutti verdi senza modifiche ai byte attesi.

**Interfaces:**

- Produces:

  ```ts
  export interface PduLink {
    /** PDU S7 intera (dall'intestazione 0x32), già passata dal controllo di sola lettura. */
    sendPdu(s7: Uint8Array): void;
    onPdu(cb: (s7: Uint8Array) => void): void;
    onClose(cb: (err?: Error) => void): void;
    close(): Promise<void>;
  }
  export type PduLinkFactory = (o: { timeoutMs: number; signal?: AbortSignal }) => Promise<PduLink>;
  ```

  `ConnectOptions` riceve `link?: PduLinkFactory`. Senza `link`, `S7Connection.open` costruisce `IsoTcpLink` da `transport`, `host`, `port` e dai TSAP, come oggi.

- [ ] **Step 1:** Test nuovo `assertOutgoingPdu`: una PDU di scrittura (job `0x05`) in `read-only` si rifiuta con lo stesso errore di oggi; una lettura passa.
- [ ] **Step 2:** Lanciare `npx vitest run --project s7comm`: il test nuovo deve fallire e gli altri passare.
- [ ] **Step 3:** Spostare il codice. È un rifattorizzare, non una riscrittura: i byte in uscita restano identici. `S7Connection` chiama `assertOutgoingPdu` e poi `link.sendPdu`. Anche le PDU di risposta del download (`encodeDownloadBlockAck`) passano dal controllo.
- [ ] **Step 4:** `npx vitest run --project s7comm --project s7-server --project desktop`: tutti verdi, comprese le catture pubbliche (`cisa/snap7.pcap`). `npm run typecheck`.
- [ ] **Step 5:** Commit `refactor(s7comm): PduLink e ISO-on-TCP separati dalla connessione`.

### Task 2: protocollo del PC Adapter (`MpiAdapterLink`)

**Files:**

- Create: `packages/s7comm/src/mpi/framing.ts`, `packages/s7comm/src/mpi/adapter.ts`, `packages/s7comm/src/mpi/index.ts`
- Test: `packages/s7comm/test/mpiFraming.test.ts`, `packages/s7comm/test/mpiAdapter.test.ts`

**Interfaces:**

- Consumes: `Transport` (`transport.ts`), `PduLink` (task 1).
- Produces:
  ```ts
  export type MpiOptions = {
    localAddress: number; // 0
    cpuAddress: number; // 2
    highestAddress: number; // 31 (HSA)
    busSpeed: '187.5k' | '19.2k' | '1.5M';
    variant: 'auto' | 'v1' | 'v2';
  };
  export function mpiAdapterLink(
    transport: () => Promise<Transport>,
    o: MpiOptions,
  ): PduLinkFactory;
  export function listMpiNodes(
    transport: () => Promise<Transport>,
    o: Omit<MpiOptions, 'cpuAddress'>,
  ): Promise<number[]>;
  ```

Il protocollo, da riscrivere dalle fonti (in libnodave `MPI.html` e `initAdapter.html`, i byte esatti si ricontrollano a mano sulla fonte prima di scriverli):

- **Framing in stile 3964R.** Il mittente manda STX (`0x02`) e aspetta DLE (`0x10`). Poi manda i dati con ogni `0x10` raddoppiato, quindi `DLE ETX` e il BCC. Il BCC è lo XOR dei byte dati senza raddoppio, partendo da `DLE ^ ETX`. Chi riceve risponde DLE. Collisione (STX da entrambe le parti): vince l'adattatore. Ripetizione: 3 tentativi.
- **Inizializzazione dell'adattatore.** Richiesta di versione (`01 0D 02`, risposta con il testo della versione). Poi il blocco di configurazione `01 03 02 …`, con indirizzo locale, velocità del bus e HSA nelle posizioni date dalla fonte, una per variante v1 e v2. Chiusura con `01 04 02`. Elenco dei nodi con `01 07 02`.
- **Connessione alla CPU.** Telegramma di connessione con l'indirizzo della CPU. Il numero di connessione arriva nella risposta.
- **PDU S7.** Ogni PDU va con l'intestazione MPI della variante (indirizzo e numeri di connessione) e il byte `F1` prima della PDU. Ogni PDU ricevuta si conferma con un ack (`B0 01 nr`). Il numero del messaggio cresce e salta lo 0 quando ricomincia da capo.
- **`variant: 'auto'`:** si prova v1, e se l'inizializzazione non risponde si prova v2. La variante trovata si restituisce, perché l'interfaccia la salvi.

- [ ] **Step 1:** Test di `framing.ts`, con funzioni pure `encodeFrame(data): Uint8Array`, `FrameDecoder.push(chunk): Uint8Array[]` e `bcc(data)`:
  - un payload con `0x10` viene raddoppiato;
  - il BCC corrisponde a quello calcolato a mano su un esempio della fonte;
  - un frame spezzato in pezzi da 1 byte si ricompone;
  - un BCC sbagliato dà `S7Error('MPI_FRAME')`.
- [ ] **Step 2:** Test di `adapter.ts` contro un adattatore finto: uno script di risposte in memoria, con `memoryTransportPair()`.
  - Init v1 riuscito.
  - v1 senza risposta seguito da v2 riuscito con `auto`.
  - Nessuna risposta: errore `MPI_NO_ADAPTER` dopo il timeout, con il messaggio «Adattatore MPI non risponde: controllare porta, velocità e cavo».
  - CPU assente all'indirizzo: errore `MPI_NO_CPU`, con i nodi visti («nodi sul bus: 0, 3»).
  - Una PDU inviata e una ricevuta, con l'ack giusto e i numeri che ricominciano da capo senza lo 0.
  - Chiusura che manda la disconnessione e `01 04 02`.
- [ ] **Step 3:** Lanciare i test: devono fallire.
- [ ] **Step 4:** Implementare. Ogni costante ha il commento con la fonte e la scritta «da verificare su adattatore reale».
- [ ] **Step 5:** Rilanciare i test: devono passare. Commit `feat(s7comm): protocollo del PC Adapter MPI (v1, v2)`.

### Task 3: adattatore finto nel PLC di prova e collaudo dell'intera catena

**Files:**

- Create: `packages/s7-server/src/mpiAdapter.ts`, un adattatore MPI finto che parla il lato adattatore del protocollo del task 2 e passa le PDU S7 al `fakeCpu`/`session` già esistenti.
- Test: `packages/s7-server/test/mpiAdapter.test.ts`, e un test in `packages/s7comm/test` che apre `S7Connection` con `mpiAdapterLink` contro il finto.

- [ ] **Step 1:** Test della catena: `S7Connection.open({ link: mpiAdapterLink(...) })` contro il finto. Lettura SZL (identità), elenco dei blocchi, carica dal dispositivo di un blocco, carica nel dispositivo in `online-write` e STOP/RUN danno gli stessi risultati della stessa prova in TCP (stessa sequenza dei test TCP esistenti).
- [ ] **Step 2:** Review Focus 1: il finto chiude il trasporto a metà di un carica nel dispositivo. `S7Error` chiaro, connessione chiusa, nessuna attesa appesa.
- [ ] **Step 3:** Review Focus 4: in `read-only` una scrittura si rifiuta, e il finto non riceve nessun byte dopo la richiesta (lo si controlla registrando i byte in arrivo).
- [ ] **Step 4:** Lanciare i test: devono fallire. Implementare l'adattatore finto. Rilanciare: devono passare.
- [ ] **Step 5:** Commit `test(s7-server): adattatore MPI finto e collaudo del collegamento MPI`.

### Task 4: porta seriale nel processo principale e pacchetti

**Files:**

- Create: `packages/s7comm/src/node/serialTransport.ts`
- Modify: `packages/s7comm/package.json` (dipendenza `serialport`), `apps/desktop/electron-builder.yml` (binari nativi fuori dall'asar), gli script `apps/desktop/scripts` che controllano il pacchetto (`checkDist`) e che uniscono i Mac (`mergeMac`)
- Modify: `apps/desktop/src/main/plc/interfaces.ts` (o vicino), per l'elenco delle porte seriali via IPC, accanto all'elenco delle interfacce di rete
- Test: `packages/s7comm/test/serialTransport.test.ts`, con `serialport` sostituito da un finto; il test esistente di `checkDist`

**Interfaces:**

- Produces:

  ```ts
  export function openSerial(o: {
    path: string;
    baudRate: number;
    parity: 'odd' | 'even' | 'none';
  }): () => Promise<Transport>;
  export function listSerialPorts(): Promise<
    { path: string; manufacturer?: string; vendorId?: string; productId?: string }[]
  >;
  ```

- [ ] **Step 1:** Controllare `npm view serialport license version` e la pagina del supporto per piattaforma. Se la licenza non è MIT, BSD o Apache, fermarsi e scriverlo all'utente. Lo stesso vale per le dipendenze native di `serialport` (`@serialport/bindings-cpp`).
- [ ] **Step 2:** Test con un finto di `serialport`:
  - apertura a 38400 baud con parità dispari;
  - porta occupata (errore `EBUSY` o `Access denied`) → `S7Error('SERIAL_BUSY')`, con «La porta COMx è usata da un altro programma»;
  - porta che sparisce (adattatore USB staccato) → `onClose` con errore;
  - `close` che libera la porta.
- [ ] **Step 3:** Lanciare i test: devono fallire. Implementare. Rilanciare: devono passare.
- [ ] **Step 4:** Pacchetti:
  - I binari nativi vanno fuori dall'asar (`asarUnpack`).
  - Il controllo del pacchetto deve trovare il binario per Windows x64 e per macOS arm64 e x64. Nel Mac universale l'unione non deve rompersi su un `.node` diverso per architettura.
  - Lanciare `npm run dist` in locale sul Mac.
  - Elencare per l'utente che cosa provare sul pacchetto Windows, che si costruisce solo in CI.
- [ ] **Step 5:** Commit `feat(s7comm): porta seriale per l'adattatore MPI`.

### Task 5: progetto e interfaccia

**Files:**

- Modify: `packages/project/src/plcAccess.ts` e lo schema in `packages/project/src/baapFile.ts`
- Modify: `apps/desktop/src/main/plc/` (dove `PlcAccess` diventa `ConnectOptions`: `plcService.ts`, `scan.ts`), per scegliere `mpiAdapterLink` quando `link.kind === 'mpi'`
- Modify: `packages/ui/src/dialogs/AccessibleDevicesDialog.tsx`, i18n it/en
- Test: i test esistenti di `baapFile`, `plcService` e `AccessibleDevicesDialog` in `packages/*/test` e `apps/desktop/test`

**Interfaces:**

- Produces, in `PlcAccess`:

  ```ts
  link?: { kind: 'tcp' } | { kind: 'mpi'; port: string; baudRate: number; parity: 'odd' | 'even' | 'none';
                            localAddress: number; cpuAddress: number; highestAddress: number;
                            busSpeed: '187.5k' | '19.2k' | '1.5M'; variant: 'auto' | 'v1' | 'v2' };
  ```

  Assente vuol dire `{ kind: 'tcp' }`. Con `mpi`, `host`, `rack` e `slot` restano nel file ma non si usano.

- [ ] **Step 1:** Test:
  - un `.baap` senza `link` si legge e si collega in TCP come prima (Review Focus 5);
  - un `.baap` con `link.kind = 'mpi'` si salva e si rilegge uguale;
  - valori fuori campo (indirizzo oltre 126, velocità sconosciuta) si rifiutano con l'errore dello schema;
  - nel dialogo, il tipo di collegamento _Adattatore MPI (seriale o USB-COM)_ mostra l'elenco delle porte (`listSerialPorts`), la velocità, la parità, l'indirizzo MPI della CPU e la variante;
  - _Cerca_ elenca i nodi del bus (`listMpiNodes`);
  - _Collega_ salva l'accesso nelle proprietà della CPU, come per il TCP.
- [ ] **Step 2:** Lanciare i test: devono fallire. Implementare. Rilanciare: devono passare.
- [ ] **Step 3:** Commit `feat(ui): collegamento con l'adattatore MPI`.

### Task 6: documenti e prova reale

**Files:**

- Modify: `docs/uso/online.md`. Nuova sezione «Collegamento MPI»: gateway RFC 1006 consigliato e consigli d'acquisto, adattatore seriale o USB-COM, che cosa non funziona (PC Adapter USB Siemens, CP 5611).
- Modify: `docs/uso/prove-cpu.md`. Prove MPI per la 313C: init dell'adattatore, elenco dei nodi, collegamento, poi le stesse prove A e B. Se fallisce, si manda la registrazione dei byte (kit di raccolta o registrazione del collegamento).
- Modify: `docs/limiti-noti.md`. Sezione «Adattatore MPI (piano 3M)»: protocollo dalle sole fonti pubbliche, mai provato su un adattatore reale; v3 non fatta; cloni USB non verificati; velocità predefinite da verificare.
- Modify: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`: riga 3M nella tappa 3.

- [ ] **Step 1:** Scrivere i documenti.
- [ ] **Step 2:** `/verifica`: test, typecheck, lint, formato. Tutto verde.
- [ ] **Step 3:** Commit `docs: collegamento MPI con l'adattatore seriale`.

## Dopo il piano (lo fa l'utente)

- **Prova reale dall'amico.** Prima dell'uso vero, un PC con l'adattatore e la 313C ferma: prove MPI di `docs/uso/prove-cpu.md`. Se l'adattatore non parla v1 né v2, si manda la registrazione dei byte, e la variante v3 diventa un piano a sé.
- **Build e release:** solo l'utente lancia i workflow. Se il task 4 ha cambiato `release.yml`, va detto prima del push.
