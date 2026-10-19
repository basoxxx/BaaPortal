# Protocollo S7comm "classic" per S7-300 — riferimento BaaPortal

Protocol id `0x32` (S7comm *classic*), su ISO-on-TCP (RFC 1006), porta TCP **102**.
Questo documento **non** copre S7comm-plus (S7-1200/1500 con accesso ottimizzato).

Regole clean-room: tutti i fatti qui sotto sono riscritti con parole proprie da
documentazione pubblica e sorgenti letti come documentazione (mai copiati). Fonti
principali, citate per sezione:

- **RFC 1006** / RFC 905 / ISO 8073 (COTP classe 0) — <https://www.rfc-editor.org/rfc/rfc1006.txt>, <https://www.rfc-editor.org/rfc/rfc0905.txt>
- **Dissector Wireshark S7comm** di Thomas Wiens (GPL-2.0), `packet-s7comm.c`, `packet-s7comm.h`, `packet-s7comm_szl_ids.c` — <https://gitlab.com/wireshark/wireshark/-/tree/master/epan/dissectors> ; wiki <https://wiki.wireshark.org/S7comm>, <https://wiki.wireshark.org/COTP>
- **snap7** (LGPL-3), file `s7_isotcp.*`, `s7_types.h`, `s7_micro_client.cpp`, `s7_server.cpp`, e "Snap7 reference manual" — <https://sourceforge.net/projects/snap7/>, sorgenti su <https://github.com/SCADACS/snap7>
- **Siemens**, *System Software for S7-300/400 System and Standard Functions*, Reference Manual 05/2010, A5E02790053-01, cap. 34 "System Status Lists (SSL)" — <https://support.industry.siemens.com/cs/ww/en/view/44240604>
- Siemens, "Properties of the S7 protocol" — <https://support.industry.siemens.com/cs/ww/en/view/26483647>
- Gyorgy Miru, "The Siemens S7 Communication" (parte 1 e 2) — <http://gmiru.com/article/s7comm/>, <http://gmiru.com/article/s7comm-part2/>
- plc4x, documentazione protocollo S7 — <https://plc4x.apache.org/protocols/s7/index.html>

Convenzioni: tutti i campi multibyte del livello S7 e di COTP/TPKT sono **big-endian**
(network order), salvo dove indicato. Gli offset sono relativi all'inizio della
struttura descritta. "verificato su cattura X" significa che i byte reali in X
corrispondono al layout; vedi §16 per l'elenco catture e §17 per i vettori di test.

---

## 1. TPKT (RFC 1006)

Header di 4 byte davanti a ogni TPDU ISO:

| off | dim | campo    | valore |
|-----|-----|----------|--------|
| 0   | 1   | version  | `0x03` (sempre, RFC 1006) |
| 1   | 1   | reserved | `0x00` |
| 2   | 2   | length   | big-endian, lunghezza **totale** del pacchetto TPKT, header TPKT incluso |

- `length` copre TPKT + COTP + payload S7. Minimo 7, massimo teorico 65535.
  snap7 usa un buffer payload da 4096 e rifiuta TPDU > buffer (`s7_isotcp.h`).
- In pratica su S7-300 la lunghezza è limitata dalla PDU negoziata (§4): con PDU 240
  i TPKT dati restano ≤ 240+ header ISO ≈ 253 byte. Le CR/CC di connessione stanno
  sempre sotto i 255 byte (snap7 pone `HI_Length=0`).

Fonti: RFC 1006 §6; snap7 `s7_isotcp.h` (`TTPKT`); verificato su `s7comm_reading_plc_status.pcap`
(primo TPKT CR = `03 00 00 16 …`, length 0x16=22). **verificato**.

---

## 2. COTP classe 0 (ISO 8073 / X.224, su RFC 1006)

Dopo il TPKT, header COTP. Primo byte = **lunghezza header COTP meno 1** (LI, length
indicator); secondo byte = tipo PDU (nibble alto codice, nibble basso credito=0).

### 2.1 Tipi PDU

| codice | PDU | uso in S7-300 |
|--------|-----|---------------|
| `0xE0` | CR  Connection Request | aperto dal client |
| `0xD0` | CC  Connection Confirm | risposta della CPU |
| `0xF0` | DT  Data | trasporto di ogni PDU S7 |
| `0x80` | DR  Disconnect Request | opzionale; S7 di norma non lo usa, chiude il TCP |
| `0xC0` | DC  Disconnect Confirm | raro |
| `0x70` | ER  Error / TPDU-Error | in caso di PDU malformata |

### 2.2 CR e CC (Connection Request / Confirm)

Layout (snap7 `TCOTP_CO`, campi come osservati):

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 1 | LI (header length − 1) | CR/CC tipiche: `0x11` (17) |
| 1 | 1 | PDU type | `0xE0` CR, `0xD0` CC |
| 2 | 2 | DST-REF | riferimento destinazione, di norma `0x0000` |
| 4 | 2 | SRC-REF | riferimento sorgente; RFC dice irrilevante, ma alcune CPU vogliono ≠0 (snap7 usa `0x0100`, Step7 `0x0D00`, TIA V12 `0x1D00`, WinCC `0x0300`) |
| 6 | 1 | Class/Option | nibble alto classe (4=0100), nibble basso opzioni. **S7 vuole `0x00`** benché la RFC prescriva `0x40`; entrambi accettati in ingresso |
| 7 | … | parametri | lista di parametri (vedi sotto) |

Parametri in CR/CC (ciascuno: code 1B, len 1B, value):

| code | parametro | len | valore |
|------|-----------|-----|--------|
| `0xC0` | TPDU-size | 1 | esponente: `0x07`=128, `0x08`=256, `0x09`=512, `0x0A`=1024, `0x0B`=2048, `0x0C`=4096, `0x0D`=8192 byte |
| `0xC1` | src TSAP (calling) | 2 | TSAP locale (vedi §2.3) |
| `0xC2` | dst TSAP (called)  | 2 | TSAP remoto (vedi §2.3) |

Ordine tipico nella CR: `C0 01 0A  C1 02 <src>  C2 02 <dst>` (snap7) oppure
`C1 02 <src> C2 02 <dst> C0 01 0A` (tool Siemens). L'ordine dei parametri non è fisso.
Nella CC la CPU ripete i parametri (eventualmente riducendo la TPDU-size) e scambia
le ref.

⚠️ **TPDU-size vs PDU S7**: la TPDU-size COTP (es. `0x0A`=1024) è indipendente dalla
lunghezza PDU S7 negoziata in §4 (es. 240). Non confonderle: la CPU S7-300 annuncia
TPDU-size 1024 nella CC ma poi negozia PDU S7 = 240. (verificato su
`s7comm_reading_plc_status.pcap`: CR con `c0 01 0a`, CC con `c0 01 0a`, poi Setup PDU=240).

### 2.3 Codifica TSAP per S7-300

TSAP = 2 byte. **Primo byte** = tipo di connessione; **secondo byte** = rack/slot.

- Tipo connessione (byte alto del TSAP remoto):
  - `0x01` = PG (programming device)
  - `0x02` = OP (operator panel / HMI)
  - `0x03` = S7-basic (altre comunicazioni; snap7 `CONNTYPE_BASIC`)
- Rack/slot (byte basso): **slot nei bit 0–4, rack nei bit 5–7**. Formula snap7:
  `byte_basso = rack*0x20 + slot`.

**Formula TSAP remoto (called):** `(tipo << 8) | (rack*32 + slot)`.
Per una CPU S7-300 standard la CPU è nel **rack 0, slot 2** → byte basso `0x02`.
Quindi: TSAP remoto PG = `0x0102`, OP = `0x0202`.

- TSAP locale (calling): tipicamente `0x0100` (snap7 e tool Siemens). Il byte basso
  del TSAP locale è un identificatore della connessione lato client, non critico.
- Valori di default consigliati per BaaPortal (vedi §16/§17): **local TSAP `0x0100`,
  remote TSAP `0x0102`** (PG, rack 0, slot 2), TPDU-size `0x0A` (1024), SRC-REF `0x0100`.

Osservati nelle catture:
- `s7comm_*` (Wireshark, S7-300): src `0x0100`, dst `0x0102`. **verificato**.
- `cisa/s7ident.pcap`: src `0x0100`, dst `0x0101` (rack 0 slot 1). **verificato**.
- `icspcap/1-…`: src `0x0100`, dst `0x0302` (tipo 03, rack 0 slot 2). **verificato**.

### 2.4 Cosa aspettano CP 343-1 e CPU PN

- Su **CPU 31x-2 PN/DP** la CPU risponde allo slot 2 (interfaccia PN integrata),
  rack 0. Verificato su `cisa/snap7.pcap` (CPU 315-2EH14, IM151-8 PN/DP in
  `s7comm_reading_plc_status.pcap`): dst `0x0102`/`0x0101`.
- Con un **CP 343-1** inserito in un altro slot, lo slot del TSAP deve puntare allo
  slot del CP (p.es. slot 4). Il CP instrada poi verso la CPU. ⚠️ Lo slot esatto
  dipende dalla configurazione hardware STEP7; va reso configurabile.
- Le CPU PN accettano più connessioni PG/OP contemporanee; le S7-300 classiche MPI
  via CP hanno limiti di risorse più stretti (§14).

### 2.5 Gateway Ethernet↔MPI/DP con RFC 1006 (nota, è tappa 3)

Un gateway (CP 343-1, NetLink, IBH Link) accetta RFC 1006 su Ethernet e inoltra su
MPI/Profibus. Cambia soprattutto la **codifica del TSAP di destinazione**, che deve
includere l'indirizzo di nodo MPI/DP del PLC remoto oltre a rack/slot. Il resto del
protocollo S7 è identico. **Dettaglio rimandato a tappa 3.**

### 2.6 Segmentazione delle PDU S7 su COTP DT

Ogni DT ha header di 3 byte: LI=`0x02`, type=`0xF0`, poi 1 byte `EOT|TPDU-NR`:
bit 7 = **EOT** (End Of Transmission: 1 = ultimo frammento), bit 0–6 = numero TPDU
(di norma 0). Una PDU S7 può essere spezzata su più DT; solo l'ultimo ha EOT=1.
Il ricevitore concatena i payload dei DT con EOT=0 fino al DT con EOT=1, poi
interpreta l'intera PDU S7. snap7 limita a 64 frammenti.

⚠️ In pratica, poiché la lunghezza PDU S7 è già negoziata ≤ TPDU-size, i frammenti
COTP sono rari nel traffico S7-300 normale (ogni PDU S7 sta in un DT con EOT=1). La
frammentazione **logica** dei dati lunghi (SZL, liste blocchi, upload) avviene invece
a livello S7/userdata (§6.7), non a livello COTP. Nelle catture BaaPortal tutti i DT
dati hanno EOT=1. **verificato** (nessun DT con EOT=0 contenente payload parziale in
`s7comm_reading_plc_status.pcap`).

Fonti: RFC 905/1006; snap7 `s7_isotcp.cpp` (`BuildControlPDU`, `isoRecvFragment`,
`isoRecvPDU`); Wireshark COTP; Miru parte 1.

---

## 3. Header S7

Dopo TPKT+COTP-DT, la PDU S7. Header di **10 byte** (job/ack-data senza i 2 byte di
errore sono comunque 10 per job=1 e userdata=7) o **12 byte** quando ROSCTR = 2 o 3
(ack / ack-data: due byte di errore in coda all'header).

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 1 | Protocol Id | sempre `0x32` |
| 1 | 1 | ROSCTR (message type) | vedi sotto |
| 2 | 2 | Redundancy Id (reserved) | sempre `0x0000`, ignorato |
| 4 | 2 | PDU Reference | generato dal client, incrementato per richiesta; la CPU lo ricopia nella risposta. ⚠️ **Endianness**: Siemens lo tratta come 2 byte opachi; WinCC/Step7 di fatto incrementano il byte **alto** (si vede `0x0200,0x0300,…` cioè low-byte=0). snap7 usa un contatore e lo invia senza swap. BaaPortal può usare qualsiasi valore ≠ ripetuto; deve solo verificarne l'eguaglianza nella risposta. |
| 6 | 2 | Parameter length | big-endian |
| 8 | 2 | Data length | big-endian |
| 10 | 1 | Error class | **solo ROSCTR 2/3** |
| 11 | 1 | Error code | **solo ROSCTR 2/3** |

### 3.1 ROSCTR (tipo PDU)

| val | nome | significato |
|-----|------|-------------|
| `0x01` | Job | richiesta dal master (read/write, blocchi, start/stop, setup) |
| `0x02` | Ack | ack semplice senza data (mai visto da S7-300/400; usato per alcune risposte di errore, p.es. upload rifiutato §9) |
| `0x03` | Ack_Data | risposta a un Job, con error class/code e parte dati |
| `0x07` | Userdata | estensione: SZL, funzioni blocco, tempo, cyclic, security, programming |

La PDU totale = 10/12 (header) + parameter length + data length. Verificato: il
controllo `len(tpkt) == hl+plen+dlen` passa su tutte le catture S7-300. **verificato**.

### 3.2 Error class / code nell'header (ROSCTR 2/3)

Error class (byte 10):

| val | significato |
|-----|-------------|
| `0x00` | nessun errore |
| `0x81` | application relationship |
| `0x82` | object definition |
| `0x83` | no resources available |
| `0x84` | error on service processing |
| `0x85` | error on supplies |
| `0x87` | access error |

I due byte errcls+errcode insieme formano uno **error code a 16 bit** uguale ai codici
della parte parametro (§3.3): p.es. header `errcls=0xD2 errcode=0x09` ≡ `0xD209`
"uno dei blocchi non trovato sul modulo". Nelle catture: get-block-info su blocco
inesistente → header `d2 09`; upload di OB inesistente → ack (ROSCTR 2) con `d2 0c`.
**verificato** su `s7comm_program_blocklist_onlineview.pcap` e `cisa/snap7.pcap`.

### 3.3 Tabella completa error code (parte parametro e header)

Dal dissector Wireshark (`param_errcode_names`). Big-endian a 16 bit.

| code | significato |
|------|-------------|
| `0x0000` | nessun errore |
| `0x0110` | numero blocco non valido |
| `0x0111` | lunghezza richiesta non valida |
| `0x0112` | parametro non valido |
| `0x0113` | tipo blocco non valido |
| `0x0114` | blocco non trovato |
| `0x0115` | blocco già esistente |
| `0x0116` | blocco protetto in scrittura |
| `0x0117` | blocco/aggiornamento OS troppo grande |
| `0x0118` | numero blocco non valido |
| `0x0119` | password errata |
| `0x011A` | errore risorse PG |
| `0x011B` | errore risorse PLC |
| `0x011C` | errore di protocollo |
| `0x011D` | troppi blocchi (limite del modulo) |
| `0x011E` | connessione al DB persa o handle S7DOS non valido |
| `0x011F` | buffer risultato troppo piccolo |
| `0x0120` | fine della lista blocchi |
| `0x0140` | memoria insufficiente |
| `0x0141` | job non processabile per mancanza di risorse |
| `0x8001` | servizio non eseguibile nello stato attuale del blocco |
| `0x8003` | errore durante il trasferimento del blocco |
| `0x8100` | errore generale: servizio sconosciuto al modulo remoto |
| `0x8104` | servizio non implementato sul modulo / errore di frame |
| `0x8204` | specifica di tipo dell'oggetto incoerente |
| `0x8205` | blocco copiato già esistente e non linkato |
| `0x8301` | memoria insufficiente sul modulo o supporto non accessibile |
| `0x8302` | troppe poche risorse / risorse processore non disponibili |
| `0x8304` | nessun ulteriore upload parallelo possibile (risorse) |
| `0x8305` | funzione non disponibile |
| `0x8306` | memoria di lavoro insufficiente (copia/link/load) |
| `0x8307` | memoria ritentiva insufficiente |
| `0x8401` | sequenza di servizio non valida (es. load/upload blocco) |
| `0x8402` | servizio non eseguibile per lo stato dell'oggetto |
| `0x8404` | funzione non eseguibile |
| `0x8405` | blocco remoto in stato DISABLE (CFB) |
| `0x8500` | frame errati (wrong frames) |
| `0x8503` | allarme dal modulo: servizio annullato in anticipo |
| `0x8701` | errore di indirizzamento dell'oggetto (es. area length error) |
| `0x8702` | servizio non supportato dal modulo |
| `0x8703` | accesso all'oggetto rifiutato |
| `0x8704` | errore di accesso: oggetto danneggiato |
| `0xD001`–`0xD00B` | errori parametro funzioni di debug (job number/variant/status/trigger…) |
| `0xD011`–`0xD033` | errori parametro programming/debug (path, indirizzo, numero DB, ecc.) |
| `0xD03F` | coding error nella sezione parametri |
| `0xD041`–`0xD0CC` | errori dati / modo / protezione nelle funzioni TIS; `0xD081` "funzione non permessa nel modo attuale", `0xD0A1` "funzione non permessa nel livello di protezione attuale", `0xD0A4` "forcing già attivo" |
| `0xD201` | errore sintassi nel nome del blocco |
| `0xD202` | errore sintassi nei parametri di funzione |
| `0xD205`–`0xD20C` | blocco già linkato in RAM/EPROM, troppi blocchi, blocco non trovato |
| `0xD209` | (almeno) uno dei blocchi indicati non trovato sul modulo |
| `0xD20A` | superato il max di blocchi linkabili in un job |
| `0xD20B` | superato il max di blocchi cancellabili in un job |
| `0xD20E` | nessun (ulteriore) blocco disponibile |
| `0xD20F` | superata la dimensione max blocco specifica del modulo |
| `0xD210` | numero blocco non valido |
| `0xD212`–`0xD241` | attributi/lunghezze/linguaggio del blocco non validi; `0xD241` "funzione non permessa nel livello di protezione attuale" |
| `0xD242` | violazione di protezione su blocchi F |
| `0xD280` | errore di compilazione blocco in CPU S7-300 |
| `0xD2A1`–`0xD2C2` | blocco occupato da altra funzione, parametri CPU in assegnazione, download non possibile |
| `0xD401`–`0xD409` | funzione informativa non disponibile / errore diagnostica |
| `0xD601` | errore sintassi nel parametro di funzione (security) |
| `0xD602` | password errata |
| `0xD603` | connessione già legittimata |
| `0xD604` | connessione già abilitata |
| `0xD605` | legittimazione impossibile: password inesistente |
| `0xD801`–`0xD807` | errori funzioni cicliche (indirizzo tag, job, tempo ciclo, overload) |
| `0xDC01` | data e/o ora non valide |
| `0xE201`–`0xE206` | errori connect&update H-system |
| `0xEF01`,`0xEF02` | errore a ID2 |

I codici `0x00xx`, `0x80xx`, `0x81xx` sono i più comuni nel read/write var; i `0xD2xx`
nelle funzioni blocco; `0xD0xx`/`0xD6xx` in protezione/security.

### 3.4 Codici di errore a livello item (read/write var)

Vedi §5. Sono distinti dagli error code header/parametro: 1 byte per item
(`0xFF`=OK, `0x0A`=non disponibile, …).

Fonti: `packet-s7comm.c` (`errcls_names`, `param_errcode_names`), `packet-s7comm.h`;
snap7 `s7_types.h` (`Code7*`); Miru parte 1/2. Tabelle sopra: non verificabili tutte
in cattura; i valori osservati (`0x0000`, `0xD209`, `0xD20C`, `0xD402`, `0xD0A5`) **verificati**.

---

## 4. Setup communication (funzione `0xF0`)

Primo scambio S7 dopo la connessione COTP. ROSCTR=1 (job) → ROSCTR=3 (ack-data).
Parte **parametro**, 8 byte, nessuna parte dati.

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 1 | function | `0xF0` |
| 1 | 1 | reserved | `0x00` |
| 2 | 2 | Max AmQ (calling) | numero max di job in parallelo che il **chiamante** gestisce |
| 4 | 2 | Max AmQ (called) | numero max di job in parallelo che il **chiamato** gestisce |
| 6 | 2 | PDU length | lunghezza PDU S7 proposta/concordata (byte) |

- Il client propone i suoi valori; la CPU risponde con i **suoi** (tipicamente ≤).
  Si usa il **minimo** dei due per PDU e AmQ.
- **PDU length tipica**: S7-300 → **240**; CP/CPU PN e S7-400 → **480** (a volte 960).
  Nelle catture il client propone 480/960/1920 e la S7-300 riduce a **240**.
  **verificato** (`s7comm_reading_plc_status.pcap`: 480→240; `s7comm_varservice_libnodavedemo.pcap`: 1920→240;
  `icspcap/1-…`: 960→480 su una S7 che accetta 480).
- **Max AmQ**: snap7 propone `0x0001`/`0x0001`; i tool Siemens propongono fino a
  `0x0003`. La CPU risponde con il suo massimo (es. S7-300: 1 oppure 3 chiamanti/chiamati).
  Dopo il setup il client **non deve** avere più di `min(amq_calling, amq_called)`
  job in volo contemporaneamente (per connessione). BaaPortal 1D userà **1 job alla
  volta** (richiesta→risposta sincrona) per sicurezza.

Il client, dopo il setup, deve rispettare: PDU length negoziata (ogni frame S7 ≤
quel valore) e numero massimo di job pendenti.

Fonti: `packet-s7comm.c` (`s7comm_decode_pdu_setup_communication`), snap7
`TReqFunNegotiateParams` e `NegotiatePDULength`. **verificato**.

---

## 5. Read var (`0x04`) e Write var (`0x05`)

ROSCTR=1 richiesta, ROSCTR=3 risposta.

### 5.1 Parte parametro

| off | dim | campo |
|-----|-----|-------|
| 0 | 1 | function (`0x04` read / `0x05` write) |
| 1 | 1 | item count (numero di item; 1 byte, quindi max 255 teorici) |
| 2 | … | item[0..n-1] |

### 5.2 Item request (sintassi S7ANY), 12 byte

| off | dim | campo | valore |
|-----|-----|-------|--------|
| 0 | 1 | spec type | `0x12` (variable specification) |
| 1 | 1 | length of following | `0x0A` (10) |
| 2 | 1 | syntax id | `0x10` = S7ANY |
| 3 | 1 | transport size | tipo di accesso, vedi §5.3 |
| 4 | 2 | length (count) | numero di **elementi** della dimensione sopra |
| 6 | 2 | DB number | numero DB (0 se area ≠ DB) |
| 7→ |   | *(nota: segue a off 6; vedi mappa byte)* | |
| 8 | 1 | area | codice area, §5.4 |
| 9 | 3 | address | indirizzo in **bit** (3 byte): byte*8 + bit; per timer/counter è il **numero** |

Mappa byte completa dell'item: `12 0A 10 TS LL LL DB DB AR A0 A1 A2`. Indirizzo:
`addr = (A0<<16)|(A1<<8)|A2`; byte = addr/8, bit = addr%8. Per Timer/Counter
l'address è il numero di timer/counter (non moltiplicato per 8).

**verificato** su `s7comm_varservice_libnodavedemo.pcap`:
`12 0a 10 02 00 40 00 01 84 00 00 00` = DB1.DBB0, 64 byte (TS=02 byte, count=64,
DB=1, area=0x84 DB, addr=0).

### 5.3 Transport size nella richiesta (byte off 3)

| val | tipo |
|-----|------|
| `0x01` | BIT |
| `0x02` | BYTE |
| `0x03` | CHAR |
| `0x04` | WORD |
| `0x05` | INT |
| `0x06` | DWORD |
| `0x07` | DINT |
| `0x08` | REAL |
| `0x09` | DATE |
| `0x0A` | TIME-OF-DAY |
| `0x0B` | TIME |
| `0x0C` | S5TIME |
| `0x0F` | DATE_AND_TIME |
| `0x1C` (28) | COUNTER |
| `0x1D` (29) | TIMER |

In pratica per leggere `length` byte di un'area si usa quasi sempre **`0x02` (BYTE)**
con count = numero byte. `length` è sempre interpretato come numero di elementi della
dimensione data. Per timer/counter si usa TS=TIMER/COUNTER (vedi §5.8).

### 5.4 Codici area (byte off 8)

| val | area |
|-----|------|
| `0x80` | P (periferia diretta) |
| `0x81` | I / E (ingressi, PII) |
| `0x82` | Q / A (uscite, PIQ) |
| `0x83` | M / Merker (flag) |
| `0x84` | DB (blocco dati) |
| `0x85` | DI (DB di istanza) |
| `0x86` | L (dati locali) — non accessibile in rete |
| `0x87` | V (dati locali precedenti) — non accessibile in rete |
| `0x1C` (28) | C — contatori S7 |
| `0x1D` (29) | T — timer S7 |
| `0x01` | data record (RDREC / firmware su CP) |
| `0x1E`–`0x1F` (30/31) | IEC counter/timer (famiglia 200) |
| `0x03`,`0x05`,`0x06`,`0x07` | sys info/flags/AI/AO famiglia 200 |

### 5.5 Parte dati: read response / write request

Ogni item dati (risposta di read, o richiesta di write):

| off | dim | campo |
|-----|-----|-------|
| 0 | 1 | return code (§5.6) |
| 1 | 1 | transport size (data, §5.7) |
| 2 | 2 | length |
| 4 | … | dati (lunghezza derivata da length+TS) |

Il **write request** mette return code = `0x00` negli item dati; la risposta write è
solo 1 byte di return code per item (vedi §5.9).

### 5.6 Return code dell'item (1 byte)

| val | significato |
|-----|-------------|
| `0x00` | reserved (usato nel write request) |
| `0x01` | errore hardware |
| `0x03` | accesso all'oggetto non consentito |
| `0x05` | indirizzo non valido / fuori range |
| `0x06` | tipo di dato non supportato |
| `0x07` | tipo di dato incoerente (size mismatch) |
| `0x0A` | oggetto non disponibile (es. DB inesistente) |
| `0xFF` | successo |

**verificato**: `0xFF` (read OK) e `0x0A` (DB1 inesistente) su `icspcap/1-…` e letture varie.

### 5.7 Transport size nella parte dati (byte off 1)

| val | significato | lunghezza espressa in |
|-----|-------------|-----------------------|
| `0x00` | NULL | — |
| `0x03` | BIT | **bit** |
| `0x04` | BYTE/WORD/DWORD | **bit** |
| `0x05` | INT | **bit** |
| `0x06` | DINT | byte |
| `0x07` | REAL | byte |
| `0x09` | OCTET STRING | **byte** |

⚠️ **Regola di conversione lunghezza→byte**: se TS ∈ {`0x03`,`0x04`,`0x05`} la
lunghezza è in **bit**: byte = ceil(length/8). Se TS ∈ {`0x06`,`0x07`,`0x09`} è già
in byte. La lettura di aree con BYTE restituisce di norma TS=`0x04` con length in bit
(es. 64 byte → length=512). **verificato**: read di 64 byte → `ff 04 02 00` (len
0x0200=512 bit = 64 byte).

Nei dati userdata (ROSCTR 7) la parte dati usa sempre TS=`0x09` (octet string) con
length in byte (§6).

### 5.8 Timer e counter

Letti con area `0x1D` (timer) / `0x1C` (counter) e transport size TIMER/COUNTER nella
richiesta; count = numero di timer/counter. Nella risposta ogni timer/counter occupa
**2 byte** (TS dati `0x09`, length in byte = count*2). Il valore timer è in formato
S5TIME, il counter in BCD. **verificato** su `cisa/snap7.pcap` (read multi-item con
item T 8×, C 8×: risposta `ff 09 00 10` = 16 byte per 8 timer).

### 5.9 Write response

Parte parametro: `function(1) item_count(1)`. Parte dati: **1 byte di return code per
item** (`0xFF`=OK), nessun padding. **verificato** su `s7comm_varservice_libnodavedemo.pcap`
(`05 01` param, `ff` data) e write multi-item (`05 05` + `ff ff ff 03 03`).

### 5.10 Byte di padding tra item

Nella **parte dati** di read response / write request: dopo ogni item, se il numero
di byte dati dell'item è **dispari** e **non è l'ultimo item**, si inserisce **1 byte
di fill** (valore indefinito) per riallineare a confine pari. L'ultimo item non ha
padding. Nella parte **parametro** vale la stessa regola per gli item request
(raro, perché gli item S7ANY sono 12 byte, pari).

**verificato** indirettamente: nelle catture multi-item con lunghezze pari non appare
padding; la regola è nel dissector (`s7comm_decode_response_read_data`, `len2=len+1`
se `len%2 && i<count-1`) e in snap7 (`if (Slice%2) Slice++`).

### 5.11 Limiti multi-item per PDU; split di letture/scritture grandi

- **Numero massimo di item per PDU**: limitato dalla PDU negoziata e dal numero di
  job. snap7 usa `MaxVars = 20`. Nelle catture reali si vedono fino a **19 item** in
  una read (`icspcap/2-…`). Regola pratica: ≤ 20 item per richiesta.
- **Dimensione richiesta read**: `header(10) + param(2 + 12*n)`. Con PDU 240 e 1 item
  la richiesta è 10+2+12 = 24 byte (ampio margine).
- **Dimensione risposta read**: `header(12) + param(2) + Σ(4 + dati_item + pad)`.
  Il numero massimo di **byte dati** in una risposta con PDU 240 è circa
  `240 − 12 − 2 − 4 = 222` byte per un singolo item (header risposta 12, param 2,
  data-item header 4). **verificato**: con PDU 240 la lettura di 218 byte produce una
  risposta da 222 byte di dati, TPKT 243 (`s7comm_varservice_libnodavedemo_bench.pcap`).
  Con più item sottrarre 4 byte di header per ciascun item.
- **Dimensione richiesta write**: `header(10) + param(2 + 12*n) + data(Σ(4 + dati + pad))`.
  Max byte scrivibili con PDU 240, 1 item ≈ `240 − 10 − 2 − 12 − 4 = 212` byte.
  **verificato** (bench: write di 212 byte, TPKT 247).
- **Il client deve dividere** letture/scritture più grandi del limite in più
  richieste, aggiornando start address. snap7 calcola `MaxElements` e cicla
  (`opReadArea`/`opWriteArea`).

Fonti: `packet-s7comm.c` (`s7comm_decode_req_resp`, `s7comm_decode_param_item`,
`s7comm_decode_response_read_data`); snap7 `s7_micro_client.cpp`
(`opReadArea`,`opWriteArea`,`opReadMultiVars`,`opWriteMultiVars`), `s7_types.h`.

---

## 6. Userdata (ROSCTR `0x07`)

Usato per SZL, funzioni blocco, tempo, cyclic, security, programming/debug.

### 6.1 Parameter head

| off | dim | campo | valore |
|-----|-----|-------|--------|
| 0 | 3 | param head | costante `00 01 12` |
| 3 | 1 | param length | `0x04` (richiesta) o `0x08` (risposta e richieste "next") |
| 4 | 1 | method/unknown | `0x11` = richiesta (push), `0x12` = risposta/follow; (nibble basso) |
| 5 | 1 | type + function group | nibble alto = **type**, nibble basso = **function group** |
| 6 | 1 | subfunction | dipende dal gruppo |
| 7 | 1 | sequence number | eco/contatore della sequenza |
| 8 | 1 | data unit reference | *(solo se param length = 8)* numero di riferimento per frammentazione |
| 9 | 1 | last data unit | *(solo se plen=8)* `0x00` = ultima unità, `0x01` = seguono altri |
| 10 | 2 | error code | *(solo se plen=8)* |

### 6.2 Nibble method / type

- Byte off 4 (`method`): osservato `0x11` nelle richieste iniziali, `0x12` nelle
  risposte e nelle richieste di continuazione. (Nel dissector è trattato come parte
  della "parameter head"; snap7 lo chiama `Uk`.)
- Byte off 5 nibble alto (**type**): `0x0`=indication (push non sollecitato, es.
  cyclic/allarmi), `0x4`=request, `0x8`=response. (Wireshark maschera `0xc0` → valori
  0/1/2; snap7 incorpora il bit alto nel valore combinato `0x4X`.) In pratica:
  richiesta = `0x4g`, risposta = `0x8g`, indicazione = `0x0g`, dove g = function group.

### 6.3 Function group (byte off 5, nibble basso)

| val | gruppo |
|-----|--------|
| `0x1` | programmer commands (TIS: test & installazione, block status, var status, force…) |
| `0x2` | cyclic data |
| `0x3` | block functions |
| `0x4` | CPU functions (read SZL, messaggi, diagnostica) |
| `0x5` | security (password PLC) |
| `0x6` | PBC / BSEND-BRECV |
| `0x7` | time functions |

Esempio: `tg=0x44` = type 4 (request) + group 4 (CPU); `tg=0x84` = response + CPU.
**verificato** su tutte le catture SZL (`44`→`84`).

### 6.4 Subfunction per gruppo

- **Gruppo 4 (CPU)**: `0x01` Read SZL, `0x02` message service, `0x03` diagnostic
  message, `0x05`/`0x06` ALARM_8/NOTIFY indication, `0x0B`–`0x13` alarm ack/query.
- **Gruppo 3 (block)**: `0x01` list blocks, `0x02` list blocks of type, `0x03` get
  block info.
- **Gruppo 7 (time)**: `0x01` read clock, `0x02` set clock, `0x03` read clock
  (following), `0x04` set clock (variante).
- **Gruppo 1 (TIS/programmer)**: `0x01` block status, `0x02` variable status, `0x03`
  output ISTACK, `0x04` BSTACK, `0x05` LSTACK, `0x06` time measurement, `0x07` force
  selection, `0x08` modify variable, `0x09` force, `0x0A` breakpoint, `0x0B` exit hold,
  `0x0C` memory reset, `0x0D` disable job, `0x0E` enable job, `0x0F` delete job,
  `0x10` read job list, `0x11` read job, `0x12` replace job, `0x13` block status v2,
  `0x16` flash LED.
- **Gruppo 2 (cyclic)**: `0x01` cyclic transfer (subscribe), `0x04` unsubscribe,
  `0x05` change-driven transfer, `0x07` change modify, `0x08` RDREC.
- **Gruppo 5 (security)**: `0x01` PLC password (enter/cancel per subfunction nel
  payload). ⚠️ in snap7 `SFun_EnterPwd=0x01`, `SFun_CancelPwd=0x02`.

### 6.5 Parte dati userdata

| off | dim | campo |
|-----|-----|-------|
| 0 | 1 | return code (`0xFF` OK; `0x0A` nelle richieste "next" placeholder) |
| 1 | 1 | transport size (sempre `0x09` octet string) |
| 2 | 2 | length (byte) |
| 4 | … | payload |

**verificato** su tutte le risposte SZL/time/block (`ff 09 <len>`).

### 6.6 Richiesta vs risposta: param length 4 vs 8

- Richiesta iniziale: param length = `0x04` (head `00 01 12`, poi method `0x11`,
  tg, subfunc, seq). Nessun data unit ref / last / errcode.
- Risposta e richieste di continuazione: param length = `0x08`, con data unit ref,
  last-data-unit, error code. **verificato**: richiesta SZL = plen 4; risposta = plen 12
  nell'header (param 8 + ma attenzione: nelle catture la risposta ha header
  parameter-length = 8, e il parser legge 8 byte di parametro).

### 6.7 Frammentazione (SZL / liste blocchi lunghe)

Quando il risultato non entra in una PDU:

1. La prima risposta ha **last-data-unit = `0x01`** (ne seguono altri) e un
   **sequence number** assegnato dalla CPU (es. seq va da `0x00` richiesta → `0x01`/`0x02`
   risposta).
2. Il client invia una **richiesta di continuazione** con lo **stesso subfunction**,
   param length `0x08`, lo **stesso sequence number** della CPU, return code dati
   `0x0A` e payload vuoto (`0a 00 00 00`).
3. La CPU risponde col pezzo successivo. L'ultima risposta ha **last-data-unit = `0x00`**.
4. Il client concatena i payload (saltando l'header dati di 4 byte di ogni pezzo e,
   per SZL, l'header di lista di 8 byte presente solo nella prima risposta — vedi §7).

**verificato** su `s7comm_reading_plc_status.pcap` (SZL `0x001C` e `0x0000` in due
pezzi: prima risposta `dur=06 last=01`, poi richiesta `0a 00 00 00`, poi `last=00`)
e su `s7comm_program_blocklist_onlineview.pcap` (list-blocks-of-type DB in 2 pezzi).

⚠️ Nota campo "dur": il byte a off 8 del parametro risposta (che il dissector chiama
"data unit reference") assume valori come `0x05`/`0x06` nelle catture: è il **data unit
reference** usato per legare i frammenti, non un conteggio. Il flag decisivo è
last-data-unit (off 9): `0x01` = continua, `0x00` = ultimo. ⚠️ Alcune CPU inviano
`0xFFFF` come list count nei frammenti (bug firmware); il client deve ricalcolare il
count dai byte effettivi (Wireshark lo gestisce).

Fonti: `packet-s7comm.c` (`s7comm_decode_ud`, `s7comm_decode_ud_data`,
`userdata_*` tables, `s7comm.h`); snap7 `opReadSZL`, `opListBlocksOfType`,
`TS7Params7`. **verificato**.

---

## 7. SZL (System Status List / System Zustands-Liste), gruppo CPU subfunc `0x01`

### 7.1 Richiesta

Parte dati (dopo i 4 byte return/TS/len): **SZL-ID (2 byte) + Index (2 byte)**.
Es. `ff 09 00 04 01 32 00 04` = read SZL id `0x0132` index `0x0004`.
**verificato** (prima transazione di quasi ogni cattura).

Struttura SZL-ID (1 word): bit 15–12 **classe modulo** (CPU=0000, IM=0100, FM=1000,
CP=1100), bit 11–8 **numero estratto** della lista parziale, bit 7–0 **numero** della
lista parziale. Es. `0x0011` = estratto 0 lista 0x11; `0x0111` = estratto 1 lista 0x11.

### 7.2 Header della risposta

Primi 8 byte della parte dati (dopo i 4 byte return/TS/len):

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 2 | SZL-ID | eco |
| 2 | 2 | Index | eco |
| 4 | 2 | LENTHDR | lunghezza di **un** record in byte |
| 6 | 2 | N_DR | numero di record |

Seguono N_DR record da LENTHDR byte. **Eccezione, liste "solo intestazione"**: se l'estratto
dell'SZL-ID è `0xF` (es. `0x0F1C`, `0x0F74`, `0x0F11`, `0x0F00`, `0x0FA0`) la risposta è la sola
intestazione di 8 byte, con LENTHDR e N_DR valorizzati (es. `0f1c 0000 0022 000a`) ma **nessun
record**. Un parser non deve pretendere N_DR×LENTHDR byte in questo caso.
**verificato** su `s7comm_reading_plc_status.pcap` e `s7comm_program_blocklist_onlineview.pcap`
(`0f11 0000 001c 0004`, `0f1c 0000 0022 000a`, `0f74 0000 0004 0007`). **verificato**: `0132 0004 0028 0001` = id 0x0132,
idx 0x0004, record 0x28=40 byte, 1 record.

### 7.3 Liste che servono a BaaPortal su S7-300

#### `0x0011` / `0x0111` — identificazione modulo (LENTHDR = 28)
Indici: `0x0001` identificazione modulo, `0x0006` hardware base, `0x0007` firmware base.
Record: Index(1 word) + **MlFB** (20 byte ASCII, order number, es.
`"6ES7 315-2EH14-0AB0 "`) + BGTyp(1 word) + Ausbg1(1 word, versione modulo) +
Ausbg2(1 word). Con index 0006/0007 Ausbg1 contiene `'V'` e la prima cifra di versione.
**verificato** su `s7comm_reading_plc_status.pcap` (idx 1: `6ES7 151-8AB01-0AB0`) e
`cisa/s7ident.pcap` / `cisa/snap7.pcap` (`6ES7 315-2EH14-0AB0`, versione da `c0 00 03`).

#### `0x001C` / `0x011C` — identificazione componenti (LENTHDR = 34)
Un record per **index** (valore nei primi 2 byte del record). Index:
`0x0001` nome AS (impianto, 24 char), `0x0002` nome modulo (24 char), `0x0003`
designazione impianto (32 char), `0x0004` copyright ("Original Siemens Equipment",
26 char), `0x0005` numero di serie modulo (24 char), `0x0007` nome tipo modulo
(32 char), `0x0008` numero di serie MC/MMC (32 char), `0x0009` manufacturer/profile,
`0x000A` OEM ID (solo S7-300), `0x000B` location ID.
Record = Index(1 word) + stringa ASCII (il resto fino a 34 byte), gap riempiti con
`0x00`. **verificato** su `s7comm_reading_plc_status.pcap`:
`0001 "IM151-8-CPU"`, `0004 "Original Siemens Equipment"`, `0005 "S C-C6TW74882012"`,
`0008 "MMC 2900FC1A"`; su `cisa/snap7.pcap`: `0001 "S7300/ET200M station_1"`,
`0005 "S C-B1U393142011"` (16 caratteri; una versione precedente di questo documento riportava per errore 17 caratteri, **verificato su cattura cisa/snap7.pcap**).

#### `0x0424` — modo operativo attuale (RUN/STOP) (LENTHDR = 20)
Record: ereig(1 word, event id) + ae(1 byte) + **bzu-id**(1 byte, **offset 3 del record**) + res(4 byte) +
anlinfo1..4(4 byte) + time(8 byte, timestamp S7). Il **bzu-id** codifica il cambio di
modo: nibble basso = modo richiesto, nibble alto = modo precedente. Valori nibble:
`0x1`=STOP(update), `0x2`=STOP(memory reset), `0x3`=STOP(self init), `0x4`=STOP(internal),
`0x5`=startup(complete restart), `0x7`=restart, `0x8`=**RUN**, `0xA`=HOLD, `0xD`=DEFECT.
⚠️ **Posizione del byte di modo**: nel record il byte di modo (bzu-id) è all'**offset 3 del
record**, cioè offset 11 del payload SZL (8 byte di intestazione + 3) o offset 15 della parte
dati con i 4 byte return/TS/len. Ne usiamo il **nibble basso** (`0x08` → RUN). snap7 legge
`0x0424` index 0 con `opData[7]` (`0x08`=RUN, `0x04`=STOP, `0x00`=unknown, altro = STOP): quel
"7" è relativo a una base diversa (il buffer di snap7), **non** all'inizio del record, e non va
usato come offset nel record. Evento ereig osservato: `0x5144` o `0x4302` ecc.
**verificato** su `cisa/s7ident.pcap` e `cisa/snap7.pcap` (`0424 0000 0014 0001` + `5144 ff 08 …`
→ modo RUN, bzu-id = `0x08` all'offset 3 del record) e su `s7comm_reading_plc_status.pcap`.

#### `0x00A0` / `0x01A0` — buffer diagnostico (LENTHDR = 20)
`0x00A0` = tutte le entry nel modo attuale; `0x01A0` = le N più recenti (N in INDEX);
`0x0FA0` = solo header. **S7-300 restituisce fino a ~10 entry** (default), S7-400 fino
a 21. Record (20 byte): **ID event**(1 word) + info(5 word=10 byte) + time(4 word=8
byte, timestamp S7). Il significato dell'event ID si decodifica con STEP 7 (tabelle
`cpu_diag_eventid_*` in Wireshark, molto ampie; non riprodotte qui). **verificato** su
`s7comm_reading_plc_status.pcap` (`00a0 0000 0014 000a` + 10 record da 20 byte).

#### `0x0131` index 1 e 2 — capacità di comunicazione (LENTHDR = 40)
- **Index 0x0001** (dati generali comunicazione): Index(1w) + **pdu**(1w = max PDU
  size byte) + **anz**(1w = max connessioni di comunicazione) + mpi_bps(1 dword) +
  kbus_bps(1 dword) + res(26 byte). **verificato**: `0131 0001 0028 0001` +
  `0001 00f0 000c …` → pdu=0x00F0=**240**, max connessioni=0x000C=**12** (IM151-8);
  su `cisa/snap7.pcap` pdu=0x00F0=240, anz=0x0010=16 (CPU 315-2PN/DP).
- **Index 0x0002** (costanti funzioni test & installazione, TIS): bitfield delle
  funzioni supportate. Utile per sapere quali funzioni di debug la CPU offre.

#### `0x0232` index 4 — livello di protezione / posizione selettore
⚠️ **Attenzione all'ID**: la protezione è nella lista **`0x0132`/`0x0232` index `0x0004`**
(non 0x0232 come lista a sé). snap7 legge `ID=0x0232, Index=0x0004`. Record (40 byte):
Index(1w) + **sch_schal**(1w, livello impostato col selettore: 1/2/3) + **sch_par**(1w,
livello assegnato a parametro: 0/1/2/3; 0=nessuna password) + **sch_rel**(1w, livello
valido della CPU: 1/2/3) + **bart_sch**(1w, posizione selettore modo: 1=RUN, 2=RUN-P,
3=STOP, 4=MRES, 0=indefinito) + **anl_sch**(1w, selettore avvio: 1=CRST, 2=WRST, 0=n.d.)
+ ken_f/ken_rel/checksums HW e AWP (Intel/little-endian) + res.
**verificato** su `step7_s300_AuthPassword.pcapng` (`0132 0004` + `0004 0001 0003 0003
0002 …` → sch_schal=1(RUN), sch_par=3, sch_rel=3, bart_sch=2(RUN-P)).

#### `0x0000` — lista di tutti gli SZL id supportati (LENTHDR = 2)
Estratto `0x0000` = tutti; `0x0F00` = solo header. Record = 1 word per ogni SZL-ID
esistente sul modulo. **verificato** su `s7comm_reading_plc_status.pcap`
(112 record: `0000 0F00 0002 0011 0111 0F11 0012 … 07B5 …`).

### 7.4 Cosa restituisce tipicamente una S7-300

- PDU length 240, 8–16 connessioni (`0x0131/1`).
- Order number tipo `6ES7 3xx-…` (`0x0011`), copyright "Original Siemens Equipment".
- Protezione: livello 1 di default (nessuna password); byte di posizione selettore
  RUN-P in esercizio.
- Buffer diagnostico: ~10 entry.

Fonti: Siemens SSL manual cap. 34.5/34.8/34.9/34.10/34.13/34.14/34.18/34.29;
`packet-s7comm_szl_ids.c`; snap7 `opReadSZL`/`opGetCpuInfo`/`opGetCpInfo`/
`opGetPlcStatus`/`opGetProtection`.

---

## 8. Funzioni blocco (gruppo 3)

### 8.1 List blocks (subfunc `0x01`) — conteggi per tipo
Richiesta: data head + payload richiesta vuoto (`0a 00 00 00` nei follow). Risposta
dati: sequenza di record da 4 byte: **block type (2 byte ASCII) + count (2 byte)**.
Tipi ASCII: `"08"`=OB, `"0A"`=DB, `"0B"`=SDB, `"0C"`=FC, `"0D"`=SFC, `"0E"`=FB,
`"0F"`=SFB (vedi §8.4). **verificato**: `3038 0001 3045 0000 3043 0000 3041 0001
3042 000c 3044 0047 3046 000e` = OB:1, FB:0, FC:0, DB:1, SDB:12, SFC:71, SFB:14
(`s7comm_program_blocklist_onlineview.pcap`).

### 8.2 List blocks of type (subfunc `0x02`), con continuazione
Richiesta: payload = **tipo blocco (2 byte ASCII)**, es. `30 41` = DB. Risposta:
record da 4 byte: **block number (2 byte) + flag (1 byte) + language (1 byte)**.
Liste lunghe vengono frammentate (§6.7): primo pezzo last=01, poi richiesta next con
stesso seq e `0a 00 00 00`, ultimo pezzo last=00. **verificato**: lista DB in 2 pezzi
(`…0001 4201 0002 4201…` number+flag`0x42`+lang`0x01`=AWL/…). ⚠️ il byte "flag" è
documentato come sconosciuto; il byte language segue §8.5.

### 8.3 Get block info (subfunc `0x03`) — layout risposta completo
Richiesta payload (8 byte): **block type (2 byte ASCII)** + **block number (5 byte
ASCII, zero-padded)** + **filesystem letter (1 byte ASCII)**. Es. `30 41`("0A"=DB) +
`"00001"` + `"B"` → info del DB1 nel filesystem B. **verificato**.

Risposta (parte dati, dopo i 4 byte return/TS/len; ~78 byte):

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 2 | block type (ASCII) | es. `"0A"` |
| 2 | 2 | info length | lunghezza info in byte |
| 4 | 2 | unknown2 | |
| 6 | 2 | const "pp" | costante `0x7070` ASCII `"pp"` (magic, vedi §13) |
| 8 | 1 | unknown | |
| 9 | 1 | **block flags** | bit0 DB linked, bit1 standard block, bit3 non-retain |
| 10 | 1 | **language** | §8.5 |
| 11 | 1 | **subblk type** | `0x08`OB `0x0A`DB `0x0B`SDB `0x0C`FC `0x0D`SFC `0x0E`FB `0x0F`SFB |
| 12 | 2 | **block number** | intero |
| 14 | 4 | **load memory length** | byte (memoria di caricamento) |
| 18 | 4 | **block security** | 0=none, 3=know-how-protect |
| 22 | 6 | **code timestamp** | timestamp S7 (vedi §13) |
| 28 | 6 | **interface timestamp** | timestamp S7 |
| 34 | 2 | SSB length | |
| 36 | 2 | ADD length | |
| 38 | 2 | local data length | |
| 40 | 2 | **MC7 length** | lunghezza codice MC7 (byte) |
| 42 | 8 | **author** | ASCII |
| 50 | 8 | **family** | ASCII |
| 58 | 8 | **name (header)** | ASCII |
| 66 | 1 | **version** | nibble alto.nibble basso (es. `0x11` → "1.1") |
| 67 | 1 | unknown | |
| 68 | 2 | **checksum** | HEX (blocco) |
| 70 | 4 | reserved1 | |
| 74 | 4 | reserved2 | |

⚠️ Relazioni di lunghezza: "load memory length" ≈ MC7 length + header/footer
(errata, vedi §13: nei blocchi reali load length = lunghezza del file = 36 + MC7 + SSB + ADD + 36; il "+6" di STEP 7 non è verificato). MC7 length = dimensione netta del codice compilato.
**verificato** su `s7comm_program_blocklist_onlineview.pcap` (get-info DB1 e SDB1,
timestamp e stringhe `"SIMATIC"`,`"TestHMI"`,`"DATADB"` leggibili).

### 8.4 Codici tipo blocco

- **Nei nomi file / userdata (ASCII)**: `'0'`+cifra:
  OB=`"08"` (`0x3038`), DB=`"0A"` (`0x3041`), SDB=`"0B"` (`0x3042`),
  FC=`"0C"` (`0x3043`), SFC=`"0D"` (`0x3044`), FB=`"0E"` (`0x3045`), SFB=`"0F"` (`0x3046`).
  (Anche `"09"`=0x3039 CMod.)
- **Come subblk type / nei file (hex)**: OB=`0x08`, DB=`0x0A`, SDB=`0x0B`, FC=`0x0C`,
  SFC=`0x0D`, FB=`0x0E`, SFB=`0x0F`.

### 8.5 Codici linguaggio blocco

`0x00` non definito, `0x01` AWL (STL), `0x02` KOP (LAD), `0x03` FUP (FBD), `0x04` SCL,
`0x05` DB, `0x06` GRAPH, `0x07` SDB, `0x08` CPU-DB (creato da programma, CREAT_DB),
`0x11` SDB (dopo overall reset), `0x12` SDB (routing), `0x29` ENCRYPT (S7-Block-Privacy).

Fonti: `packet-s7comm.c` (`s7comm_decode_ud_block_subfunc`, `blocktype_names`,
`subblktype_names`, `blocklanguage_names`, `blocksecurity_names`); snap7 `opListBlocks`,
`opListBlocksOfType`, `opAgBlockInfo`, `TResDataBlockInfo`. **verificato**.

---

## 9. Upload (PLC → PG)

Tre funzioni (ROSCTR 1 richiesta / 3 risposta), stesse strutture di snap7
`TReqFunStartUploadParams`/`TResFunStartUploadParams`/`TReqFunUploadParams`/…:

### 9.1 Start upload (`0x1D`)
Richiesta param (18 byte): `1D` + function-status(1) + unknown(2) + **upload-id**(4, 0 all'inizio)
+ filename: len(1)=`0x09` + `'_'` + type(2 ASCII) + number(5 ASCII) + filesystem(1).
Es. `1d 00 …00 09 5f 30 42 30 30 30 30 30 41` = `_0B00000A` (SDB 0, filesystem A).
Risposta param (16 byte): `1D` + status(1) + unknown(**2**, `01 00`) + **upload-id**(4, assegnato dalla CPU)
+ len-string(1) + **length string** (ASCII decimale a 7 cifre, lunghezza totale del blocco in byte).
**verificato** su `cisa/snap7.pcap` (`1d 00 01 00 00 00 00 07 07 "0000216"` → upload-id 0x07,
lunghezza 216 byte).
*Errata (verificato su cattura `cisa/snap7.pcap`, 8 sequenze anche in `gymgit/snap7_s300_everything.pcapng`):*
nella risposta gli ignoti sono 2 byte, non 3 (altrimenti l'upload-id sarebbe `0x0707`).
Il codec tratta la stringa come opzionale: se manca o non è un numero la lunghezza totale è `null`
e la stringa grezza si conserva per il round trip.

### 9.2 Upload (`0x1E`)
Richiesta param (8 byte): `1E` + status(1) + unknown(2) + **upload-id**(4). Risposta param: `1E` +
**EoU**(1) (`0x00` = fine upload, `0x01` = in corso). Parte dati: len(2) + `0x00 0xFB`
(2 byte) + **payload del blocco** (**len** byte). Ripetere finché EoU=0.
**verificato**: `1e 00` + `00 d8 00 fb 7070…` → 216 byte di blocco, EoU=0 (ultimo).
*Errata (verificato su cattura `cisa/snap7.pcap`):* la richiesta è di 8 byte (non 1+6+4) e `len`
è la lunghezza del solo payload (0xd8 = 216 con parte dati di 220 byte), non `len−4`.
Il payload comincia con il magic `"pp"` (0x7070) del blocco (§13).

### 9.3 End upload (`0x1F`)
Richiesta param (8 byte): `1F` + status(1) + unknown(2) + **upload-id**(4). Risposta param: solo `1F`.
**verificato** su `cisa/snap7.pcap` (8 byte; errata: non 1+6+4).

### 9.4 Sequenza esatta
`StartUpload(0x1D)` → la CPU assegna upload-id e dichiara la lunghezza totale →
ripetere `Upload(0x1E)` finché EoU=`0x00`, concatenando i payload → `EndUpload(0x1F)`.
Upload di blocco inesistente: la CPU risponde con ROSCTR=2 (ack) ed error header
`0xD20C` (SDB non interpretabile) o `0xD209`. **verificato** su `cisa/snap7.pcap`.
In `cisa/snap7.pcap` l'upload dell'OB 0 e le quattro richieste di `cisa/s7ident.pcap` hanno
come risposta un ack senza parametro (nessun upload-id): non sono codificati dal codec upload.

Fonti: snap7 `opUpload`, `s7_types.h`; `packet-s7comm.c`
(`s7comm_decode_plc_controls_updownload`). **verificato**.

---

## 10. Download (PG → PLC)

### 10.1 Request download (`0x1A`), inviato dal PG
Param: `1A` + flags(1) + unknown(2) + unknown/download-id(4) + filename
(len `0x09` + `'_'` + type(2) + number(5) + `'P'`) + poi (se plen>18) len2(1)=`0x0D`
+ unknown(1)=`'1'` + **load memory length** (6 ASCII) + **MC7 length** (6 ASCII).
Es. `1a …_0A00001P 0D 31 "100086" "000002"` → load mem 100086, MC7 2 (DB1).
La CPU risponde con ack `1A` (oppure error `0xD241` se serve password, §14).
**verificato** su `s7comm_downloading_block_db1.pcap` e `icspcap/4-…`.

### 10.2 Pattern server-initiated: Download block (`0x1B`) **dalla CPU**
Dopo l'ack della request-download, è la **CPU** (server) a inviare al PG dei **job
`0x1B` (ROSCTR=1)** chiedendo i dati del blocco; il **PG risponde con ack-data
(ROSCTR=3)** contenente la fetta di dati. Questo è l'unico caso in cui ruoli di
richiesta/risposta si invertono sulla stessa connessione TCP.

- Job `0x1B` dalla CPU: param `1B` + unknown(7) + filename (`_` type number `P`).
- Ack-data dal PG: param `1B` + **EoS**(1) (`0x01`=seguono dati, `0x00`=ultimo pezzo)
  + parte dati: len(2) + `0x00 0xFB` + **fetta di codice del blocco**.

**verificato** su `s7comm_downloading_block_db1.pcap`: 3 cicli `1B` (CPU→PG job,
PG→CPU ack-data con payload `70 70 …` = magic blocco), ultimo con EoS=0.

### 10.3 Download ended (`0x1C`)
La CPU invia un job `0x1C` (filename) al PG; il PG risponde ack `1C`. Chiude il
trasferimento dati. **verificato**.

### 10.4 PLC control `0x28` con `_INSE` (inserimento blocco)
Dopo il download dei byte, il PG invia una **PI-service `0x28`** con servizio `_INSE`
per attivare il blocco nel filesystem di lavoro. Param: `28` + unknown(7, ultimo byte
`0xFD`) + len1(2)=`0x000A` + **block count**(1) + `0x00` + `'0'`(0x30) + type(1) +
number(5 ASCII) + subfun(1) + len2(1)=`0x05` + `"_INSE"`.
Es. `28 … fd 00 0a 01 00 30 41 "00001" P 05 "_INSE"`. **verificato** su
`s7comm_downloading_block_db1.pcap` e `icspcap/4-…`.

### 10.5 `_DELE` (cancella blocco)
Stessa struttura PI-service `0x28` ma servizio `"_DELE"` e subfun `0x42`. Cancella il
blocco indicato dal filesystem passivo. (Non in cattura S7-300 locale; struttura da
snap7 `opDelete` e dissector.)

Fonti: snap7 `opDownload`, `opDelete`, `TReqStartDownloadParams`,
`TReqControlBlockParams`, `pi_service_names`; `packet-s7comm.c`
(`s7comm_decode_pi_service`). **verificato** (download+INSE), `_DELE` **non verificato**.

---

## 11. PLC control e stop (gruppo funzioni di controllo)

### 11.1 PLC Stop (`0x29`)
Param: `29` + unknown(5, zero) + len2(1)=`0x09` + `"P_PROGRAM"` (9 ASCII).
Risposta: param `29` (ack-data). Se la CPU è già in STOP: risposta con para=`0x07`
→ "already in STOP" (snap7 `errCliAlreadyStop`). **verificato** su `snap7_s300_stop.pcapng`,
`step7_s300_stop.pcapng`, `cisa/snap7.pcap` (`29 …00 09 "P_PROGRAM"`).

### 11.2 PLC control `0x28` — warm/hot/cold restart
Tutti via `0x28` (PI-service `P_PROGRAM` con argomenti diversi):

- **Warm restart (hot start snap7)**: param `28` + unknown(7, ultimo `0xFD`) +
  len1(2)=`0x0000` + len2(1)=`0x09` + `"P_PROGRAM"` (nessun argomento).
- **Cold restart**: param `28` + unknown(7, `…FD`) + len1(2)=`0x0002` +
  **SFun**(2)=`0x4320` (ASCII `"C "`) + len2(1)=`0x09` + `"P_PROGRAM"`.

La parte "argomenti" è una stringa ASCII; `"C "` = cold. Risposta ack-data `28`; se
già in RUN → para=`0x03` ("already RUN", snap7 `errCliAlreadyRun`), para=`0x02` →
"cannot start". **verificato** cold start (`C ` + P_PROGRAM) su `cisa/snap7.pcap`.

⚠️ Terminologia: nelle *mode-transition* (SZL 0x0424 / `modetrans`) i modi sono
0=STOP, 1=Warm Restart, 2=RUN, 3=Hot Restart, 4=HOLD, 6=Cold Restart. S7-300 standard
supporta tipicamente solo **warm restart** (complete restart); cold/hot dipendono
dalla CPU (vedi SZL 0x0012 "system response").

### 11.3 Altri PI service
- `_GARB` — compress PLC memory (param `28` + …FD + len1=`0x0000` + len2=`0x05` +
  `"_GARB"`). **verificato** su `cisa/snap7.pcap`.
- `_MODU` — copy RAM to ROM (param `28` + …FD + len1=`0x0002` + SFun=`0x4550` ASCII
  `"EP"` + len2=`0x05` + `"_MODU"`). **verificato** su `step7_s300_copyRamToRom.pcapng`,
  `cisa/snap7.pcap`.
- `_INSE`/`_INS2` — attiva/inserisci blocco (§10.4); `_DELE` — cancella (§10.5).
- `_N_…` — famiglia di servizi Sinumerik NCK (login, file transfer, tool management):
  non pertinenti a una CPU S7-300 standard; elenco completo in `pi_service_names`.

### 11.4 Codici di risposta
Le risposte di controllo (`0x28`/`0x29`) sono ack-data con param = eco del codice
funzione; lo stato è nel byte `para` (snap7 `TResFunCtrl`): `0x00` OK, `0x07`
già STOP, `0x03` già RUN, `0x02` non eseguibile. Errori come header error code
(§3.3), es. `0xD241` "funzione non permessa nel livello di protezione" se serve
password.

Fonti: snap7 `opPlcStop`/`opPlcHotStart`/`opPlcColdStart`/`opCopyRamToRom`/`opCompress`,
`TReqFunPlcStop`/`TReqFunPlcColdStart`/`TReqFunCopyRamToRom`; `packet-s7comm.c`
(`s7comm_decode_plc_controls_param_hex29`, `s7comm_decode_pi_service`,
`modetrans_param_mode_names`). **verificato** stop/cold/modu/garb.

---

## 12. Funzioni tempo (gruppo 7)

- **Read clock**: userdata gruppo 7 subfunc `0x01` (o `0x03` "following"). Richiesta
  dati placeholder `0a 00 00 00`. Risposta dati: return `0xFF`, TS `0x09`, len
  `0x000A` (10) + **timestamp S7 di 10 byte** (§12.1).
- **Set clock**: gruppo 7 subfunc `0x02` (o `0x04`). Richiesta dati: return `0xFF`,
  TS `0x09`, len `0x000A` + timestamp 10 byte.

**verificato** su `s7comm_reading_setting_plc_time.pcap` (read: `…ff 09 00 0a
00 19 14 08 20 11 59 43 91 24` ; set: subfunc 02 con timestamp).

### 12.1 Layout timestamp BCD data/ora (DATE_AND_TIME, 10 byte)

Tutti i campi in **BCD**:

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 1 | reserved | spesso `0x00` (byte alto anno, da ignorare) |
| 1 | 1 | year (hi) | la CPU manda `0x19`; ignorato nel calcolo |
| 2 | 1 | year | BCD: se <89 → 20xx, altrimenti 19xx |
| 3 | 1 | month | BCD 1–12 |
| 4 | 1 | day | BCD |
| 5 | 1 | hour | BCD |
| 6 | 1 | minute | BCD |
| 7 | 1 | second | BCD |
| 8 | 1 | msec (2 cifre alte) | BCD |
| 9 | 1 | nibble alto = msec (cifra bassa), nibble basso = **weekday** (1=domenica…7=sabato) |

Esempio decodificato: `00 19 14 08 20 11 59 43 91 24` → anno 2014, mese 08, giorno 20,
11:59:43.912, weekday=4 (mercoledì). Il timestamp "corto" di 8 byte (usato nel diag
message e nel blockinfo) omette i byte 0–1 (reserved+year-hi). **verificato**.

Fonti: `packet-s7comm.c` (`s7comm_add_timestamp_to_tree`, `weekdaynames`); snap7
`opGetDateTime`/`opSetDateTime`, `TS7Time`. **verificato**.

---

## 13. Formato del blocco trasferito (upload/download)

Un client e un finto server devono memorizzare i blocchi **in modo opaco** e
rispondere coerentemente a get-block-info. L'header del blocco (prime decine di byte
del payload trasferito in §9.2/§10.2) ha questa struttura (snap7 `TS7CompactBlockInfo`
e footer):

Header (parte iniziale del payload del blocco):

| off | dim | campo | note |
|-----|-----|-------|------|
| 0 | 2 | magic | `0x7070` ASCII `"pp"` |
| 2 | 1 | attr | `0x01` (OB/DB), `0x03` (SDB) nelle catture |
| 3 | 1 | block flags | |
| 4 | 1 | language | §8.5 |
| 5 | 1 | subblk type | §8.4 |
| 6 | 2 | block number | |
| 8 | 4 | load memory length | |
| 12 | 4 | block security | |
| 16 | 6 | code timestamp | ms dalla mezzanotte (4) + giorni dal 1984-01-01 (2) |
| 22 | 6 | interface timestamp | come sopra |
| 28 | 2 | SSB length | |
| 30 | 2 | ADD length | |
| 32 | 2 | local data length | |
| 34 | 2 | **MC7 length** | |
| 36 | … | codice MC7 (MC7 length byte) | |

Tra l'MC7 e il footer ci sono `SSB length + ADD length` byte di sezioni che il codec
conserva grezze (`rest`).

Footer/trailer (snap7 `TS7BlockFooter`, **sempre gli ultimi 36 byte** del blocco):

| off nel footer | dim | campo |
|-----|-----|-------|
| 0 | 8 | author (ASCII, riempito con spazi o NUL) |
| 8 | 8 | family (ASCII) |
| 16 | 8 | name/header (ASCII) |
| 24 | 1 | version (nibble x.y; `0x00` negli SDB, `0x01` nei DB delle catture) |
| 25 | 1 | unknown (`0x00`) |
| 26 | 2 | **checksum** |
| 28 | 8 | reserved (non zero in alcuni blocchi: es. `3152481400000000`) |

Relazioni: **load memory length** = lunghezza dell'intero file = 36 (header) + MC7 length +
(SSB length + ADD length) + 36 (footer); la local data length non occupa spazio nel file.
*Errata, verificato su catture `cisa/snap7.pcap` (SDB 0, 216 byte: 36+144+0+36),
`s7comm_downloading_block_db1.pcap` (DB1, 500 byte: 36+400+28+36), `tia_s300_downloadOb1.pcapng`
(OB1, 332 byte: 36+212+(28+20)+36), `icspcap/4-S7comm-Download-DB1-with-password-request.pcap` (DB1,
86 byte: 36+2+12+36), `step7_s300_download.pcapng` e i 7 blocchi di `tia_s300_downloadHwConfig.pcapng`:
19 sessioni di blocco su 19 (8 upload dello stesso SDB 0 in due catture + 11 download), nessuna eccezione.* L'indicazione "load+6" (già nel testo di §8.3 e qui) non
trova riscontro nei byte dei blocchi: in questi la load length coincide con la lunghezza del file.
Il campo security può avere il bit alto
(`0x80000000` negli SDB reali) e va conservato come intero a 32 bit.
Un finto server deve: memorizzare i byte così come arrivano nel
download, estrarre number/type/MC7-length/timestamps dall'header per rispondere a
get-block-info (§8.3) in modo coerente, e restituire gli stessi byte all'upload.

⚠️ La **semantica del codice MC7** (istruzioni della macchina virtuale S7) **non è
coperta qui**: appartiene a un piano successivo. Vedi snap7 `s7_types.h`
(`TS7CompactBlockInfo`, `TS7BlockFooter`), e la documentazione MC7 non ufficiale
(Thomas Wiens, plc4x). **parzialmente verificato** (header `pp…` leggibile nei payload
di upload/download reali, campi number/type/MC7-len coerenti con get-block-info).

---

## 14. Comportamento della connessione

- **Keep-alive / timeout**: il protocollo S7 non ha keep-alive applicativo; si usa il
  keep-alive TCP. snap7 ha `RecvTimeout` default **3000 ms** ("alcuni dispositivi
  vecchi sono lenti a rispondere") e un `KeepAliveTime` configurabile lato socket.
  BaaPortal dovrebbe usare un timeout di risposta generoso (≥ 3 s) e, per operazioni
  lunghe (compress, copy-ram-to-rom), timeout più ampi.
- **Seconda connessione**: ogni connessione TCP:102 è indipendente, con il proprio
  setup-communication e la propria sequenza. ⚠️ Osservato: i tool online (Step7
  classic) aprono **una connessione TCP nuova per ogni transazione** e la chiudono
  subito (`s7comm_program_blocklist_onlineview.pcap`: porte client 4205→4209, una CR/CC
  per operazione). snap7/WinCC invece mantengono una connessione persistente.
- **Limiti di risorse S7-300**: numero massimo di connessioni di comunicazione dato
  da SZL `0x0131/1` campo `anz` (tipico **8–16** su S7-300; es. 12 su IM151-8, 16 su
  315-2PN/DP). Superato il limite, la CPU rifiuta la CC COTP o la connessione S7.
  Il numero di **job paralleli** per connessione è dato da Max AmQ del setup (§4).
- **Livelli di protezione**:
  - Livello 1 (default): accesso completo in lettura e scrittura.
  - Livello 2 (protezione in scrittura con password): **lettura libera**, scrittura e
    funzioni di modifica (write var, download, stop/start, set clock, _INSE/_DELE,
    copy-ram-to-rom) rifiutate senza password con error **`0xD241`** ("funzione non
    permessa nel livello di protezione attuale") o item/param error `0xD0A1`.
  - Livello 3 (protezione R/W): **anche la lettura** può richiedere password; molte
    funzioni restituiscono `0xD241`/`0xD241`.
  - Il livello valido è leggibile da SZL `0x0132/0x0004` (sch_rel, §7.3).
    **verificato parzialmente**: `icspcap/4-…` mostra un download che richiede password
    (sequenza security prima del download); `step7_s300_AuthPassword.pcapng` mostra la
    sequenza di autenticazione; sch_par=3/sch_rel=3 indicano livello 3.
- **Password (gruppo 5)**: BaaPortal non gestisce password. Con una protezione attiva, le funzioni non permesse rispondono con un errore, che BaaPortal riporta così com'è.

Fonti: snap7 `s7_isotcp.cpp` (`RecvTimeout`), `s7_types.h` (`p_u32_KeepAliveTime`),
`opSetPassword`/`opClearPassword`/`opGetProtection`; `packet-s7comm.c`
(`userdata_sec_subfunc_names`, error codes); Siemens SSL 0x0232/4.

---

## 15. Note di sicurezza per un client in sola lettura

Obiettivo: il kit di raccolta dell'amico e il client di default di BaaPortal 1D devono
**solo leggere**, senza mai alterare lo stato del PLC. Allowlist conservativa.

### 15.1 Funzioni **solo lettura** (ammesse nel kit read-only)

| funzione | codice | perché è sicura |
|----------|--------|-----------------|
| Setup communication | `0xF0` | negozia solo PDU/AmQ; nessuno stato PLC modificato |
| Read var | `0x04` | legge memoria; nessuna scrittura |
| Read SZL | UD grp4 sub `0x01` | lista di stato virtuale, "può solo essere letta, non modificata" (Siemens SSL manual) |
| Get block info | UD grp3 sub `0x03` | solo metadati |
| List blocks | UD grp3 sub `0x01` | solo conteggi |
| List blocks of type | UD grp3 sub `0x02` | solo elenco numeri |
| Read clock | UD grp7 sub `0x01`/`0x03` | legge l'orologio |
| Upload (`0x1D`/`0x1E`/`0x1F`) | — | ⚠️ vedi §15.3 |

### 15.2 Funzioni che **modificano lo stato** (vietate nel kit read-only)

- **Write var `0x05`** — scrive in memoria.
- **PLC Stop `0x29`**, **PLC control `0x28`** (warm/cold restart, `_INSE`,`_INS2`,
  `_DELE`,`_MODU`,`_GARB`) — cambiano modo CPU, memoria, blocchi, RAM↔ROM.
- **Download (`0x1A`/`0x1B`/`0x1C`)** — scrive blocchi.
- **Set clock** UD grp7 sub `0x02`/`0x04` — cambia l'orologio.
- **Security / password** UD grp5 — stabilisce/cancella la legittimazione (cambia lo
  stato della sessione lato CPU).
- **TIS/programmer** UD grp1 sub `0x07` force selection, `0x08` modify variable,
  `0x09` force, `0x0A` breakpoint, `0x0C` memory reset, `0x0D`–`0x12` job management,
  `0x16` flash LED — ⚠️ scrivono/forzano/mettono in hold/modificano I/O o lampeggiano
  LED. **Vietati**. Solo `0x01`/`0x13` block status e `0x02` variable status
  **leggono**, ma restano fuori dall'allowlist 1D per prudenza (possono innescare job
  di debug sulla CPU).
- **Cyclic data** UD grp2 sub `0x01` subscribe, `0x04` unsubscribe, `0x05`/`0x07`
  change — ⚠️ creano/alterano job ciclici persistenti sulla CPU (stato). Vietati.

### 15.3 L'upload è davvero privo di effetti collaterali?

Analisi: la sequenza upload (`0x1D`/`0x1E`/`0x1F`) **legge** il contenuto dei blocchi
e **non scrive** nulla sul PLC. Non cambia modo né memoria utente. Tuttavia:

- ⚠️ L'upload **alloca un upload-id** e tiene aperta una "sessione di upload" sulla
  CPU fino a `EndUpload`; se il client non chiude correttamente, consuma una risorsa
  finché la connessione non cade (vedi error `0x8304` "nessun upload parallelo
  possibile"). Il kit deve sempre inviare `EndUpload`.
- ⚠️ Carico sulla CPU in RUN: l'upload di molti/grandi blocchi aggiunge carico di
  comunicazione (letture di memoria di caricamento) ma non interrompe il ciclo
  utente. Siemens classifica le funzioni informative/upload come non intrusive sul
  ciclo. Resta prudente **limitare la frequenza** e non uploadare tutti i blocchi in
  loop stretto.

**Raccomandazione 1D**: includere l'upload nel kit read-only **solo** con chiusura
garantita (`EndUpload`), rate-limit, e preferibilmente su CPU non in produzione. Per
il semplice inventario, `list blocks` + `get block info` bastano senza upload.

### 15.4 Giustificazione dell'allowlist

Ogni voce ammessa in §15.1 o **non invia dati di scrittura** (read var, SZL, block
info/list, read clock: la parte dati della richiesta è vuota o un placeholder
`0a 00 00 00`) o, nel caso dell'upload, **trasferisce dati solo PLC→PG**. Tutte le
funzioni che portano una parte dati significativa C→S con write/control, o che usano
i codici `0x05`,`0x1A`,`0x1B`,`0x1C`,`0x28`,`0x29`, o userdata gruppi 1/2/5 con
subfunction di modifica, o gruppo 7 subfunc di set, sono escluse. Il finto server CI
può comunque implementarle per i test, ma il **client di raccolta** deve rifiutarsi
di emetterle.

Fonti: Siemens SSL manual (definizione SSL "can only be read"); snap7 (separazione
op read/write/control); analisi delle catture.

---

## 15bis. Stato di verifica per sezione

Sintesi (dettagli inline in ogni sezione). "verificato" = i byte reali in almeno una
cattura S7-300 confermano il layout.

| sez | argomento | stato |
|-----|-----------|-------|
| 1 | TPKT | **verificato** (tutte le catture) |
| 2.1–2.2 | COTP CR/CC/DT, parametri | **verificato** |
| 2.3 | TSAP S7-300 | **verificato** (0x0100/0x0102, varianti 0x0101/0x0302) |
| 2.4 | CP 343-1 / PN | parz.: PN **verificato** (slot 2); CP 343-1 slot **non verificato** |
| 2.5 | gateway RFC1006 MPI/DP | **non verificato** (tappa 3) |
| 2.6 | segmentazione COTP | **verificato** (nessun frammento COTP nei dati S7-300) |
| 3.1–3.3 | header S7, ROSCTR, error code | **verificato** (ROSCTR 1/2/3/7; err 0x0000/0xD209/0xD20C/0xD402/0xD0A5); tabella completa error code **non verificata** interamente |
| 4 | setup comm, PDU 240/480 | **verificato** |
| 5 | read/write var, item, transport, padding, limiti | **verificato** |
| 6 | userdata, frammentazione | **verificato** |
| 7 | SZL 0x0011/0x001C/0x0424/0x00A0/0x0131/0x0132-4/0x0000 | **verificato** |
| 8 | funzioni blocco (list/listtype/info) | **verificato** |
| 9 | upload 0x1D/1E/1F | **verificato** (`cisa/snap7.pcap`) |
| 10 | download 0x1A/1B/1C + _INSE | **verificato**; `_DELE` **non verificato** |
| 11 | stop/control/_MODU/_GARB/cold | **verificato**; hot/warm restart args parz. |
| 12 | time read/set + BCD | **verificato** |
| 13 | formato blocco (header pp, footer) | **verificato** byte-per-byte su 19 blocchi reali (header, rest SSB+ADD, footer di 36 byte, load length = lunghezza del file); la semantica MC7 non è coperta |
| 14 | connessione, protezione, password | parz.: PDU/conn/protezione **verificato**; codifica XOR password **non verificata** |
| 15 | allowlist read-only | analisi (non è un layout); upload side-effect **verificato** come PLC→PG |

Conteggio: **12 sezioni principali pienamente verificate** su cattura
(1,2.6,3-base,4,5,6,7,8,9,10-base,11-base,12), **6 parziali** (2.4, 3.3-tabella,
13, 14, 11-restart, 10-_DELE), **2 non verificate** (2.5 gateway, codifica password).

---

## 16. Catture pubbliche

Scaricate solo nello scratchpad (non nel repo). Un eventuale step CI può scaricarle a
tempo di test senza ridistribuirle. Tutte verificate come S7comm su S7-300 reale,
salvo dove indicato.

### 16.1 Wireshark wiki SampleCaptures (sezione S7COMM)
URL base: `https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/<file>`
Pagina: <https://wiki.wireshark.org/SampleCaptures> e <https://wiki.wireshark.org/S7comm>.
Licenza/termini: la pagina non dichiara una licenza esplicita per i singoli file
(contributi della community al wiki Wireshark). **Da non ridistribuire**; scaricare al
volo.

| file | SHA-256 | contenuto (CPU / operazioni) |
|------|---------|------------------------------|
| `s7comm_downloading_block_db1.pcap` | `48725bd1af7b778821351cd0f50f0ee259e438074a27f8431a8a1a3351dfd3d0` | S7-300 (SZL 0x0011 non presente; DB1). Download di DB1: setup, SZL 0132/0013/0131, list-blocks, **request download 0x1A + download block 0x1B (CPU→PG) + ended 0x1C + _INSE** |
| `s7comm_program_blocklist_onlineview.pcap` | `b2e7014362630b803b413dda595e4ba7a3a910105712f448c22dba517ec02851` | S7-300 **IM151-8 PN/DP** (SZL 0x0111 `6ES7 151-8AB01`). Lista blocchi: setup, SZL, **list blocks 0x01, list blocks of type 0x02 (con continuazione), get block info 0x03**. Una conn. TCP per operazione |
| `s7comm_reading_plc_status.pcap` | `e71f81b471bd67da2fd6e40dc69a7179574ba66771c6150cd7bfe232cc07b8a9` | S7-300 **IM151-8 PN/DP** (CPU `IM151-8 PN/DP CPU`, order `6ES7 151-8AB01-0AB0`). Stato PLC: setup PDU 480→240, **molte SZL** (0x0132/4, 0x0000, 0x0011, 0x001C, 0x0131, 0x0424, 0x00A0 diag buffer) |
| `s7comm_reading_setting_plc_time.pcap` | `d74c1eca1f2039dadcccd43c212f649b293acf6a80db1560e9ee22aeabb4c5d4` | S7-300 IM151-8 PN/DP. **Read clock (grp7 sub1)** ripetuto e **Set clock (grp7 sub2)**; SZL 0x0011/0x011C/0x0132 |
| `s7comm_varservice_libnodavedemo.pcap` | `a1ff275c087fafbfdc8821ea59ab9bfb11f5adcc9ce6bb5888a1c4a4d7b6affc` | S7-300. libnodave demo: setup PDU 1920→240, **read var** (DB1 64B, M 16B), **write var** M |
| `s7comm_varservice_libnodavedemo_bench.pcap` | `bdbacb1b09c621f23be1c4c55145aec24930b6fa5541e7f4626dab6a314f1308` | S7-300. Benchmark: molte read/write, **multi-item (5 item)**, letture 212/218 byte vicino al limite PDU 240 |
| `COTP_Example.pcapng.gz` | `0e5569a842e1b00ef5ba3c3ef43b692b0fdc3ea6b6b6146b40374561a73f6b58` | due PC che scambiano ISO 8073 su RFC 1006 (COTP puro, **non S7**). Utile solo per COTP |

### 16.2 automayt/ICS-pcap (GitHub, Git-LFS)
URL base media: `https://media.githubusercontent.com/media/automayt/ICS-pcap/master/S7/<n>/<n>.pcap`
(ogni cattura sta in una sottocartella con il suo nome; `raw.` darebbe il puntatore LFS)
Repo: <https://github.com/automayt/ICS-pcap>. Licenza: **non dichiarata** (raccolta da
digitalbond, 4SICS, netresec, scadahacker, Wireshark, kargs.net, Oak Ridge…). Trattare
come terze parti, non ridistribuire.

| file | SHA-256 | contenuto |
|------|---------|-----------|
| `1-S7comm-VarService-Read-DB1DBD0.pcap` | `0e9583b7e3d9df9f572e02e90329523281a9d149d9ee862ca16d0d4ad0c686b0` | S7-300, setup PDU 960→480, read DB1.DBD0 (4 byte) ripetuto; TSAP dst 0x0302 |
| `2-S7comm-VarService-CyclicData-1s.pcap` | `a5d778c725c34313883849eda83d62e184ffdc712bed18dcca2e96d068257147` | S7-300, **cyclic data (grp2 sub1 subscribe)**, read multi-item fino a 19 item, push ciclici |
| `3-S7comm-VAT_MB100_MW200_MD300_M400-0.pcap` | `d63d475d3a83e9cea2aceb58910142970f5ecff185efa007c2cf6616e50a8ff5` | S7-300, SZL 0x0132/4, 0x0131/2, 0x0424; variable table (grp1 var status) |
| `4-S7comm-Download-DB1-with-password-request.pcap` | `5aaed04c0d443c2e43df941dbf3ee732fb15ca0578874dfff4a7db402806dc3f` | S7-300, protezione livello 3 (sch_par=3): **security auth (grp5) + download DB1 + _INSE** |
| `S7-1200-Uploading-OB1-TIAV12.pcap` | `73e4b36469447e0fd45ccd38ca0583fbe60f6df27372b1ca11066e335deb650e` | ⚠️ **S7-1200/TIA** (S7comm-plus): fuori ambito, solo riferimento |
| `s7-1200-hmi.pcap` | `b38ccaf183673619e7f5d69476293a01da743076a281c96e949f0f29a42d1650` | ⚠️ **S7-1200** HMI: fuori ambito |

### 16.3 cisagov/icsnpp-s7comm (GitHub) — licenza **BSD 3-Clause**
URL base: `https://raw.githubusercontent.com/cisagov/icsnpp-s7comm/main/testing/traces/<file>`
Repo: <https://github.com/cisagov/icsnpp-s7comm>. **BSD 3-Clause** (Battelle Energy
Alliance) — licenza permissiva, dichiarata. La più adatta per un uso CI citabile.

| file | SHA-256 | contenuto |
|------|---------|-----------|
| `s7ident.pcap` | `7a2ae7f2992669a3eb36a878f0e4f124c86ecdf3fc3a284f78e2e6e1deeea680` | Client vs server (snap7-like) emulante **CPU 315-2EH14**; setup, SZL 0x0011/0x001C/0x0131/0x0424, start-upload rifiutato `0xD241` |
| `snap7.pcap` | `2b91f6a8a203ec83e4f2dbb69d5e61602845f23da0baa31d95d029fb24cbd427` | **CPU reale 315-2PN/DP** (`6ES7 315-2EH14`, S7300/ET200M): setup, SZL 0x0011/0x001C/0x0131/0x0424, **upload OB/DB/FB (0x1D/1E/1F) completo**, read/write var multi-item (incl. timer/counter), **PLC stop 0x29**, **_MODU / _GARB / cold start**. ⚠️ Identico (stesso SHA) a `gymgit/snap7_s300_everything.pcapng` |

### 16.4 gymgit/s7-pcaps (GitHub, **non** Git-LFS) — di Gyorgy Miru
URL base: `https://raw.githubusercontent.com/gymgit/s7-pcaps/master/<file>` (i file sono git normali:
`media.githubusercontent.com` dà 404, `raw.` dà i byte veri; stessi URL di `public.json`).
Repo: <https://github.com/gymgit/s7-pcaps>. Licenza: non dichiarata esplicitamente;
"created for public use", IP randomizzati. Catture S7-300/400 reali con Step7 5.5,
TIA V13, snap7, WinCC. Sottoinsieme S7-300 rilevante:

| file | SHA-256 | contenuto |
|------|---------|-----------|
| `snap7_s300_everything.pcapng` | `2b91f6a8a203ec83e4f2dbb69d5e61602845f23da0baa31d95d029fb24cbd427` | = `cisa/snap7.pcap` (vedi 16.3) |
| `snap7_s300_readVar.pcapng` | `19333fdf9b8e7bc582dbac9faadf1f6c23e79b82f4cd5c26806f7c95e4a3bd3d` | read var singola (DB1 64B) → error item `0x0A` (DB inesistente) |
| `snap7_s300_setupCommunication.pcapng` | `72ef8d4809b074e5d1734547db37a4d46d9b550261c7e381ae4da9664f332f52` | solo setup PDU 1920→240 |
| `snap7_s300_stop.pcapng` | `c3d47f730f76f37a0114fd7bae4dbe580c8bf22c71201852a2817cc5c9192de5` | PLC stop 0x29 (`P_PROGRAM`) |
| `step7_s300_download.pcapng` | `b70e89869a6e5fa950c403415d5fabcc3860d36adc8670bed09398a2d6b6339c` | download con Step7 Manager (setup) |
| `tia_s300_downloadOb1.pcapng` | `759440ab240a9b54824766ddd352fd09da50a897b08420e421fc9a4553450a74` | download OB1 da TIA (grp1 TIS) |
| `step7_s300_readVarTab.pcapng` | `9cd63c73f2e5715585357f1f278cfb5baeeae9ecaa326bb5fcd4a038afa1ca85` | read variable table (grp1 var status, molti cicli) |
| `wincc_s400_production.pcapng` | `d0bae738862ee3157c73b2ca90230a3d0c8e21402923155296f9b86804a2f0ae` | ⚠️ **S7-400** WinCC produzione: cyclic data (grp2 sub4/5/7), read/write var, alarm — utile per cyclic e alarm |

---

## 17. Appendice — vettori di test (hex)

Frame corti e rappresentativi. "[reale]" = estratto da una cattura; "[costruito]" =
costruito dalla documentazione per i test del finto server. Tutti i vettori reali sono
TPKT+COTP+S7 completi come appaiono sul filo.

### 17.1 Connessione COTP CR / CC [reale, `s7comm_reading_plc_status.pcap`]
```
CR (C→S): 0300 0016 11 e0 0000 000f 00 c1 02 0100 c2 02 0102 c0 01 0a
CC (S→C): 0300 0016 11 d0 000f 0003 00 c0 01 0a c1 02 0100 c2 02 0102
```
TPKT len 0x16=22; LI 0x11; src TSAP 0x0100 (PG), dst TSAP 0x0102 (rack0 slot2),
TPDU-size 0x0A=1024.

### 17.2 Setup communication request / response [reale, stessa cattura]
```
REQ (C→S): 0300 0019 02f080  32 01 0000 0200 0008 0000  f0 00 0001 0001 01e0
RES (S→C): 0300 001b 02f080  32 03 0000 0200 0008 0000 0000  f0 00 0001 0001 00f0
```
REQ: ROSCTR 1, plen 8, dlen 0, fn 0xF0, AmQ calling=1 called=1, PDU=0x01E0=480.
RES: ROSCTR 3, errcls/errcode 0x0000, AmQ 1/1, PDU=0x00F0=**240** (S7-300).

### 17.3 Read var, 2 item [costruito dalla doc; stile verificato su catture]
```
REQ (C→S): 0300 002b 02f080  32 01 0000 0100 001a 0000
           04 02
           12 0a 10 02 0010 0001 84 000000      ; item0: DB1.DBB0, 16 byte
           12 0a 10 02 0010 0000 83 000000      ; item1: MB0, 16 byte
```
Param len = 1 (funzione) + 1 (numero item) + 12 + 12 = 26 = `0x001A`; data len 0.
TPKT len = 4 (TPKT) + 3 (COTP DT) + 10 (header S7 job) + 26 = 43 = `0x002B`.
Item: `12 0a 10 TS LLLL DBDB AREA A0A1A2`. Risposta attesa per item OK:
`FF 04 <len_bit> <dati…>` con eventuale 1 byte di padding tra item se dispari.

Esempio reale di risposta read 1 item (64 byte) [reale, libnodave]:
```
RES (S→C): 32 03 0000 0000 0002 0044 0000  04 01  ff 04 0200  <64 byte dati>
```
`ff`=OK, `04`=BYTE/WORD/DWORD, len `0x0200`=512 bit=64 byte.

### 17.4 Read var multi-item (5 item) [reale, `..._bench.pcap`]
```
REQ param: 04 05
  12 0a 10 02 0006 0000 81 000000   ; IB0, 6 byte
  12 0a 10 02 0006 0000 83 000000   ; MB0, 6 byte
  12 0a 10 02 0006 0000 83 000030   ; MB6, 6 byte
  12 0a 10 02 0036 0000 83 000020   ; MB4, 54 byte
  12 0a 10 02 0004 0000 83 000020   ; MB4, 4 byte
RES data: FF04 0030 <6B> FF04 0030 <6B> FF04 0030 <6B> FF04 01B0 <54B> FF04 0020 <4B>
```
(len in bit: 0x30=48bit=6B, 0x1B0=432bit=54B, 0x20=32bit=4B.)

### 17.5 Read SZL 0x0011 (identificazione) con header lista [reale, `cisa/s7ident.pcap`]
```
REQ (C→S): 32 07 0000 0100 0008 0008  00 01 12 04 11 44 01 00  ff 09 0004 0011 0000
RES (S→C): 32 07 0000 0100 000c 007c  00 01 12 08 12 84 01 00 0000 0000
           ff 09 0078  0011 0000 001c 0004  <4 record da 28 byte>
```
Header dati SZL: id 0x0011, idx 0x0000, LENTHDR 0x1C=28, N_DR 4. Primo record contiene
`"6ES7 315-2EH14-0AB0 "`.

### 17.6 Read SZL 0x001C con frammentazione [reale, `cisa/snap7.pcap`]
```
REQ : 32 07 0000 0200 0008 0008  00 01 12 04 11 44 01 00  ff 09 0004 001c 0000
RES1: 32 07 0000 0200 000c 00da  00 01 12 08 12 84 01 02 d5 01 0000  ff 09 00d6 ...
      ; last-data-unit (off9)=0x01 → segue
REQ2: 32 07 0000 0300 000c 0004  00 01 12 08 12 44 01 02 0000 0000  0a 00 0000
      ; richiesta "next": stesso seq 0x02, payload 0a000000
RES2: 32 07 0000 0300 000c 008a  00 01 12 08 12 84 01 02 d5 00 0000  ff 09 0086 ...
      ; last-data-unit=0x00 → ultimo
```
Nella risposta frammentata l'header di lista (id/idx/LENTHDR/N_DR) è solo in RES1.

### 17.7 Get block info DB1 [reale, `s7comm_program_blocklist_onlineview.pcap`]
```
REQ : 32 07 0000 1200 0008 000c  00 01 12 04 11 43 03 00  ff 09 0008  3041 3030303031 42
      ; type "0A"(DB), number "00001", filesystem 'B'
RES : 32 07 0000 1200 000c 0052  00 01 12 08 12 83 03 00 0000 0000
      ff 09 004e  0041 004a 2200 7070 01 01 05 0a 0001 ... 54657374484d49 ...
      ; "pp" magic, lang 0x05(DB), timestamps, name "TestHMI"/"DATADB"
```

### 17.8 Sequenza upload (OB/DB) [reale, `cisa/snap7.pcap`]
```
StartUpload REQ: 32 01 0000 0800 0012 0000  1d 00 000000000000 09 5f 3042 3030303030 41
                 ; _ "0B"(SDB) "00000" 'A'
StartUpload RES: 32 03 0000 0800 0010 0000  1d 00 01 00000007 07 "0000216"
                 ; upload-id 0x07, lunghezza totale 216
Upload REQ     : 32 01 0000 0900 0008 0000  1e 00 00000007
Upload RES     : 32 03 0000 0900 0002 00dc  1e 00  00d8 00fb  <216 byte blocco (pp...)>
                 ; EoU=0x00 (ultimo)
EndUpload REQ  : 32 01 0000 0a00 0008 0000  1f 00 00000007
EndUpload RES  : 32 03 0000 0a00 0001 0000  1f
```

### 17.9 Sequenza download DB1 [reale, `s7comm_downloading_block_db1.pcap`]
```
ReqDownload (PG→CPU) : 32 01 .. 1a 00 01 0000 00000000 09 5f 3041 3030303031 50
                        0d 31 "100050" "000004"     ; load mem 100050, MC7 4
ReqDownload ack      : 32 03 .. 1a
DownloadBlock (CPU→PG job): 32 01 .. 1b 00 00000000 00 09 5f 3041 3030303031 50
DownloadBlock ack (PG→CPU): 32 03 .. 1b 01  00de 00fb  <222 byte di codice>   ; EoS=0x01
  ... ripetuto, ultimo pezzo EoS=0x00 ...
DownloadEnded (CPU→PG): 32 01 .. 1c 00 00000000 00 09 5f 3041 3030303031 50
DownloadEnded ack     : 32 03 .. 1c
_INSE (PG→CPU)        : 32 01 .. 28 00 000000 0000 fd 000a 01 00 30 3041 3030303031 50
                        05 5f494e5345   ; "_INSE"
```
Nota l'inversione di ruoli: `0x1B` è un **job ROSCTR=1 inviato dalla CPU**, risposto
dal PG con ROSCTR=3 ack-data contenente i dati.

### 17.10 PLC stop [reale, `snap7_s300_stop.pcapng`]
```
REQ (C→S): 0300 0021 02f080  32 01 0000 0200 0010 0000  29 0000000000 09 505f50524f4752414d
RES (S→C): 0300 0014 02f080  32 03 0000 0200 0001 0000 0000  29
```
`29` + 5 byte zero + len2 0x09 + `"P_PROGRAM"`. Risposta ack-data `29`.

### 17.11 Cold restart / _MODU / _GARB [reale, `cisa/snap7.pcap`]
```
Cold start: 32 01 .. 28 00 000000 0000 fd 0002 4320 09 505f50524f4752414d   ; "C " + P_PROGRAM
_MODU     : 32 01 .. 28 00 000000 0000 fd 0002 4550 05 5f4d4f4455            ; "EP" + _MODU
_GARB     : 32 01 .. 28 00 000000 0000 fd 0000 05 5f47415242                 ; _GARB
```

### 17.12 Read/Set clock [reale, `s7comm_reading_setting_plc_time.pcap`]
```
Read REQ : 32 07 0000 0700 0008 0004  00 01 12 04 11 47 01 00  0a 00 0000
Read RES : 32 07 0000 0700 000c 000e  00 01 12 08 12 87 01 01 0000 0000
           ff 09 000a  00 19 14 08 20 11 59 43 91 24     ; 2014-08-20 11:59:43.912 wd=4
Set  REQ : 32 07 0000 0c00 0008 000e  00 01 12 04 11 47 02 00
           ff 09 000a  00 19 14 08 20 11 59 33 04 00     ; set clock
```

Fine documento.
