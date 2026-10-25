import {
  FrameReader,
  decodeBcdDateTime,
  decodeBlockInfoRequest,
  decodeBlockListOfTypeRequest,
  decodeCotp,
  decodeEndUpload,
  decodePlcControlRequest,
  decodeDownloadBlockAck,
  decodeReadRequest,
  decodeRequestDownload,
  decodeS7,
  decodeSetup,
  decodeStartUpload,
  decodeSzlRequest,
  decodeUploadRequest,
  decodeUserdata,
  decodeWriteRequest,
  encodeBcdDateTime,
  encodeBlockCounts,
  encodeBlockListOfType,
  encodeControlResponse,
  encodeCotp,
  encodeDownloadBlockJob,
  encodeDownloadEnded,
  encodeEndUploadResponse,
  encodeReadResponse,
  encodeS7,
  encodeSetup,
  encodeStartUploadResponse,
  encodeSzl,
  encodeTpkt,
  encodeUploadResponse,
  encodeUserdata,
  encodeWriteResponse,
  itemByteLength,
  itemReturnName,
  parseBlockFile,
  parseBlockFileName,
  responseTransportFor,
  type BlockFilesystem,
  type BlockType,
  type CotpPdu,
  type DecodedUserdata,
  type ItemResult,
  type S7Pdu,
  type Transport,
} from '@baaportal/s7comm';
import type { CpuBackend } from './backend';
import { chunked, functionOf } from './faults';
import { buildSzl } from './szlData';

/**
 * Codici di errore del finto PLC. Sono i codici di proto §3.3; dove una CPU vera li ha mostrati
 * nelle catture del repository lo si dice.
 */
const ERR = {
  /** Funzione non permessa nel livello di protezione: visto su s7ident.pcap (start upload). */
  PROTECTED: [0xd2, 0x41],
  /** Blocco non trovato (start upload di un blocco assente): visto su snap7.pcap. */
  UPLOAD_MISSING: [0xd2, 0x0c],
  /** Errore di sintassi nel nome del blocco. */
  BLOCK_NAME: [0xd2, 0x01],
  /** Frame errati: richiesta malformata o risposta che non entra nella PDU. */
  WRONG_FRAMES: [0x85, 0x00],
  /** Servizio non implementato sul modulo: funzione sconosciuta. */
  NOT_IMPLEMENTED: [0x81, 0x04],
  /** Nessun ulteriore upload parallelo possibile. */
  NO_PARALLEL_UPLOAD: [0x83, 0x04],
  /** Sequenza di servizio non valida: upload id sconosciuto, continuazione fuori sequenza. */
  BAD_SEQUENCE: [0x84, 0x01],
} as const;

/** Userdata: codici nel parametro (con return code 0x0A), come negli errori visti nelle catture. */
const UD = {
  /** Funzione informativa non disponibile: SZL con id o indice sconosciuti (goOnline.pcapng). */
  SZL_UNKNOWN: 0xd402,
  /** Blocco non trovato (snap7.pcap). */
  BLOCK_MISSING: 0xd209,
  /** Nessun blocco di quel tipo. */
  NO_BLOCKS: 0xd20e,
  BLOCK_NAME: 0xd201,
  BLOCK_PARAM: 0xd202,
  NOT_IMPLEMENTED: 0x8104,
  BAD_SEQUENCE: 0x8401,
  /**
   * Set clock con la CPU protetta. IPOTESI di proto §12.0 ("non verificato"): livello 3 → 0xD0A1,
   * livello 2 → 0xD241 (lo stesso codice che le altre scritture hanno nell'header).
   */
  SET_CLOCK_LEVEL3: 0xd0a1,
  SET_CLOCK_LEVEL2: 0xd241,
} as const;

/** DR: motivi X.224. */
const DR_ADDRESS_UNKNOWN = 0x03;
const DR_CONGESTION = 0x01;

const MAX_FRAGMENTS = 64;
const MAX_REASSEMBLED = 0xffff + 16;
/** Id di upload assegnato dalla CPU: la 315 vera risponde 7 a ogni sequenza (snap7.pcap). */
const UPLOAD_ID = 7;
const NOTHING = new Uint8Array(0);

interface Pending {
  group: number;
  sub: number;
  seq: number;
  dur: number;
  pieces: Uint8Array[];
  next: number;
}

/**
 * Download in corso (proto §10): il finto PLC manda i job 0x1B/0x1C e il PG risponde con ack-data.
 * `phase`: 'start' = ack 0x1A appena risposto, 'block' = in attesa dell'ack-data di un 0x1B,
 * 'ended' = in attesa dell'ack del 0x1C, 'insert' = trasferimento finito, attende l'_INSE.
 * I byte stanno qui e nel blockMap solo dopo l'_INSE.
 */
interface Download {
  type: BlockType;
  number: number;
  fs: BlockFilesystem;
  loadLength: number;
  mc7Length: number;
  phase: 'start' | 'block' | 'ended' | 'insert';
  /** pduRef dell'ultimo job mandato: l'ack-data deve riportarlo. */
  ref: number;
  pieces: Uint8Array[];
  received: number;
  /** Byte oltre la lunghezza dichiarata o lunghezza finale diversa: l'_INSE sarà rifiutato. */
  bad: boolean;
}

class Session {
  private readonly reader = new FrameReader();
  private state: 'idle' | 'open' | 'closed' = 'idle';
  private readonly ourRef: number;
  private tpduExp = 0x0a;
  private pdu: number;
  private readonly frags: Uint8Array[] = [];
  private fragBytes = 0;
  private upload: { bytes: Uint8Array; offset: number; done: boolean } | undefined;
  private cont: Pending | undefined;
  private dl: Download | undefined;
  private jobRef = 0;
  private responses = 0;
  private seqCounter = 0;
  private durCounter = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cpu: CpuBackend,
    private readonly t: Transport,
  ) {
    this.pdu = cpu.config.pduLength;
    this.ourRef = cpu.nextRef();
    t.onData((chunk) => this.onData(chunk));
    t.onClose(() => this.shutdown());
  }

  close(): void {
    this.shutdown();
  }

  // `state` cambia dentro i gestori: una lettura per metodo evita che TS lo dia per costante
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  // ---- chiusura ----------------------------------------------------------------------------

  private shutdown(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.upload = undefined;
    this.cont = undefined;
    this.dl = undefined; // un download interrotto prima dell'_INSE non lascia nulla
    this.cpu.detach(this);
    try {
      this.t.close();
    } catch {
      // già chiuso
    }
  }

  // ---- invio -------------------------------------------------------------------------------

  private rawSend(bytes: Uint8Array): void {
    try {
      this.t.send(bytes);
    } catch {
      this.shutdown();
    }
  }

  /** Esegue `fn` ora, o dopo `delayMs` (stesso ritardo per tutti: l'ordine si conserva). */
  private schedule(fn: () => void): void {
    const delay = this.cpu.config.faults.delayMs;
    if (!delay) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.state !== 'closed') fn();
    }, delay);
    this.timers.add(timer);
  }

  private emit(tpkts: Uint8Array[]): void {
    const size = this.cpu.config.faults.chunkSize;
    for (const tpkt of tpkts) for (const piece of chunked(tpkt, size)) this.rawSend(piece);
  }

  private sendCotp(p: CotpPdu): void {
    const tpkt = encodeTpkt(encodeCotp(p));
    this.schedule(() => this.emit([tpkt]));
  }

  /** Un DR di rifiuto parte subito, senza guasti, e chiude. */
  private refuse(cr: Extract<CotpPdu, { type: 'CR' | 'CC' }>, reason: number): void {
    this.rawSend(
      encodeTpkt(encodeCotp({ type: 'DR', dstRef: cr.srcRef, srcRef: this.ourRef, reason })),
    );
    this.shutdown();
  }

  private sendPdu(pdu: S7Pdu): void {
    const bytes = encodeS7(pdu);
    // un DT porta al più 2^tpdu - 3 byte; la TPDU-size annunciata nel CC non scende sotto 128
    const cap = Math.max(2 ** Math.max(this.tpduExp, 7) - 3, 1);
    const tpkts: Uint8Array[] = [];
    for (let o = 0; o === 0 || o < bytes.length; o += cap) {
      const eot = o + cap >= bytes.length;
      tpkts.push(encodeTpkt(encodeCotp({ type: 'DT', eot, data: bytes.slice(o, o + cap) })));
    }
    this.schedule(() => {
      this.emit(tpkts);
      this.responses++;
      const drop = this.cpu.config.faults.dropAfterResponses;
      if (drop !== undefined && this.responses >= drop) this.shutdown();
    });
  }

  // ---- ricezione ---------------------------------------------------------------------------

  private onData(chunk: Uint8Array): void {
    if (this.state === 'closed') return;
    let payloads: Uint8Array[];
    try {
      payloads = this.reader.push(chunk);
    } catch {
      this.shutdown();
      return;
    }
    for (const payload of payloads) {
      if (this.isClosed()) return;
      try {
        this.onCotp(decodeCotp(payload));
      } catch {
        this.shutdown();
        return;
      }
    }
  }

  private onCotp(c: CotpPdu): void {
    switch (c.type) {
      case 'CR': {
        if (this.state !== 'idle') return this.shutdown();
        if (c.dstTsap === undefined || !this.cpu.config.tsaps.includes(c.dstTsap)) {
          return this.refuse(c, DR_ADDRESS_UNKNOWN);
        }
        if (!this.cpu.attach(this)) return this.refuse(c, DR_CONGESTION);
        this.state = 'open';
        this.tpduExp = Math.min(c.tpduSize ?? 0x0a, 0x0a);
        // layout della CPU vera (proto §17.1): TPDU-size, TSAP chiamante, TSAP chiamato
        this.sendCotp({
          type: 'CC',
          dstRef: c.srcRef,
          srcRef: this.ourRef,
          tpduSize: this.tpduExp,
          srcTsap: c.srcTsap,
          dstTsap: c.dstTsap,
        });
        return;
      }
      case 'DT': {
        if (this.state !== 'open') return this.shutdown();
        this.frags.push(c.data);
        this.fragBytes += c.data.length;
        if (this.frags.length > MAX_FRAGMENTS || this.fragBytes > MAX_REASSEMBLED) {
          return this.shutdown();
        }
        if (!c.eot) return;
        const whole = new Uint8Array(this.fragBytes);
        let at = 0;
        for (const f of this.frags.splice(0)) {
          whole.set(f, at);
          at += f.length;
        }
        this.fragBytes = 0;
        this.onPdu(decodeS7(whole));
        return;
      }
      default:
        // CC, DR, ER dal cliente: la connessione finisce qui
        return this.shutdown();
    }
  }

  private onPdu(pdu: S7Pdu): void {
    const faults = this.cpu.config.faults;
    if (faults.dropAfterResponses !== undefined && this.responses >= faults.dropAfterResponses) {
      return this.shutdown();
    }
    // ack-data (o errore) del cliente: esistono solo come risposte ai job 0x1B/0x1C del download
    if (pdu.rosctr === 2 || pdu.rosctr === 3) return this.onAck(pdu);
    if (pdu.rosctr !== 1 && pdu.rosctr !== 7) return;
    const fn = functionOf(pdu);
    if (fn !== undefined && faults.ignoreFunction === fn) return;
    let reply: S7Pdu | undefined;
    try {
      if (fn !== undefined && faults.errorFor?.function === fn) {
        reply = this.forcedError(pdu, faults.errorFor.errorClass, faults.errorFor.errorCode);
      } else {
        reply = pdu.rosctr === 1 ? this.job(pdu) : this.userdata(pdu);
      }
    } catch {
      reply = headerError(pdu, ERR.WRONG_FRAMES);
    }
    if (reply) this.sendPdu(reply);
    // l'ack 0x1A è partito: ora il finto PLC chiede la prima fetta
    if (this.dl?.phase === 'start') {
      this.dl.phase = 'block';
      this.sendJob(this.dl, encodeDownloadBlockJob(this.dl.type, this.dl.number, this.dl.fs));
    }
  }

  private forcedError(pdu: S7Pdu, errorClass: number, errorCode: number): S7Pdu {
    if (pdu.rosctr === 7) {
      try {
        return udError(pdu, decodeUserdata(pdu.param, pdu.data), (errorClass << 8) | errorCode);
      } catch {
        // userdata illeggibile: errore di header
      }
    }
    return headerError(pdu, [errorClass, errorCode]);
  }

  // ---- job (ROSCTR 1) -----------------------------------------------------------------------

  private job(p: S7Pdu): S7Pdu {
    switch (p.param[0]) {
      case 0xf0:
        return this.setup(p);
      case 0x04:
        return this.readVar(p);
      case 0x1d:
        return this.startUpload(p);
      case 0x1e:
        return this.uploadChunk(p);
      case 0x1f:
        return this.endUpload(p);
      case 0x05:
        return this.writeVar(p);
      case 0x28:
      case 0x29:
        return this.plcControl(p);
      case 0x1a:
        return this.requestDownload(p);
      case 0x1b: // download block e download ended arrivano come job solo dalla CPU: dal PG, mai
      case 0x1c:
        return headerError(p, ERR.PROTECTED);
      default:
        return headerError(p, ERR.NOT_IMPLEMENTED);
    }
  }

  private setup(p: S7Pdu): S7Pdu {
    let req;
    try {
      req = decodeSetup(p.param);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    this.pdu = Math.min(req.pduLength, this.cpu.config.pduLength);
    return ack(
      p,
      encodeSetup({
        amqCalling: Math.min(req.amqCalling, 1),
        amqCalled: Math.min(req.amqCalled, 1),
        pduLength: this.pdu,
      }),
    );
  }

  private readVar(p: S7Pdu): S7Pdu {
    // ASSUNZIONE, non verificata su una CPU vera: a livello 3 la lettura variabili è rifiutata
    // con 0xD241 nell'header (come l'upload, visto su s7ident.pcap). L'unica cattura di lettura
    // protetta è di un server snap7, che risponde con 0x0A per item: il client gestisce
    // entrambe le forme (vedi client.test.ts, "lettura protetta").
    if (this.cpu.config.protectionLevel === 3) return headerError(p, ERR.PROTECTED);
    let items;
    try {
      items = decodeReadRequest(p.param);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    if (items.length === 0) return headerError(p, ERR.WRONG_FRAMES);
    // la risposta (header 12 + parametro 2 + item con riempimento) deve entrare nella PDU
    let size = 14;
    items.forEach((it, i) => {
      const n = itemByteLength(it);
      size += 4 + n + (n % 2 === 1 && i < items.length - 1 ? 1 : 0);
    });
    if (size > this.pdu) return headerError(p, ERR.WRONG_FRAMES);
    const results: ItemResult[] = items.map((it) => {
      const r = this.cpu.readItem(it);
      if ('rc' in r) return { ok: false, returnCode: r.rc, name: itemReturnName(r.rc) };
      return {
        ok: true,
        data: r.data,
        transportSize: responseTransportFor(it),
        rawLength: it.size === 'BIT' ? it.count : undefined,
      };
    });
    const { param, data } = encodeReadResponse(results);
    return ack(p, param, data);
  }

  // ---- scrittura e controllo (allowlist) -----------------------------------------------------

  /** Con protezione 2 o 3 le funzioni che cambiano stato sono rifiutate (proto §14); la lettura no. */
  private writeProtected(): boolean {
    return this.cpu.config.protectionLevel >= 2;
  }

  private writeVar(p: S7Pdu): S7Pdu {
    if (this.writeProtected()) return headerError(p, ERR.PROTECTED);
    let items;
    try {
      items = decodeWriteRequest(p.param, p.data);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    if (items.length === 0) return headerError(p, ERR.WRONG_FRAMES);
    const { param, data } = encodeWriteResponse(this.cpu.applyWrite(items));
    return ack(p, param, data);
  }

  private plcControl(p: S7Pdu): S7Pdu {
    let req;
    try {
      req = decodePlcControlRequest(p.param);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    // _INSE attiva il blocco solo a trasferimento finito (proto §10.4); altrove non è ammesso
    if (req.service === '_INSE' && this.dl?.phase === 'insert')
      return this.insertBlock(p, req.block);
    if (req.service === '_DELE' || req.service === '_MODU' || req.service === '_GARB') {
      return this.piService(p, req.service, req.block);
    }
    // fuori allowlist (cold restart, _INSE fuori download)
    if (req.service !== 'P_PROGRAM') return headerError(p, ERR.PROTECTED);
    if (this.writeProtected()) return headerError(p, ERR.PROTECTED);
    const code = req.function === 0x29 ? this.cpu.applyStop() : this.cpu.applyWarmRestart();
    return ack(p, encodeControlResponse(req.function, code));
  }

  /** `_DELE`, `_MODU` e `_GARB`: se il backend non li ha, "servizio non implementato" (proto §3.3). */
  private piService(
    p: S7Pdu,
    service: '_DELE' | '_MODU' | '_GARB',
    block: { type: BlockType; number: number } | undefined,
  ): S7Pdu {
    if (this.writeProtected()) return headerError(p, ERR.PROTECTED);
    if (service === '_DELE') {
      if (!this.cpu.deleteBlock || !block) return headerError(p, ERR.NOT_IMPLEMENTED);
      if (block.type === 'SDB') return headerError(p, ERR.PROTECTED); // gli SDB non si cancellano
      // il nome e' lungo 8 caratteri e finisce a p[19]: come TIA (proto §10.5), solo il filesystem 'A'
      if (p.param[19] !== 0x41) return headerError(p, ERR.WRONG_FRAMES);
      if (!this.cpu.deleteBlock(block.type, block.number)) {
        return headerError(p, ERR.UPLOAD_MISSING); // blocco assente: stesso d20c di snap7.pcap
      }
    } else if (service === '_MODU') {
      if (!this.cpu.copyRamToRom) return headerError(p, ERR.NOT_IMPLEMENTED);
      this.cpu.copyRamToRom();
    } else {
      if (!this.cpu.compressMemory) return headerError(p, ERR.NOT_IMPLEMENTED);
      this.cpu.compressMemory();
    }
    return ack(p, encodeControlResponse(0x28, 0));
  }

  // ---- download (ruoli invertiti, proto §10.2) ------------------------------------------------

  private requestDownload(p: S7Pdu): S7Pdu {
    if (this.writeProtected()) return headerError(p, ERR.PROTECTED);
    let req;
    try {
      req = decodeRequestDownload(p.param);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    // gli SDB non si scrivono in 3C: la CPU li espone solo in lettura
    if (req.type === 'SDB') return headerError(p, ERR.PROTECTED);
    // un download già in trasferimento blocca il secondo; uno finito che aspetta solo l'_INSE si sostituisce
    if (this.dl && this.dl.phase !== 'insert') return headerError(p, ERR.NO_PARALLEL_UPLOAD);
    this.dl = { ...req, phase: 'start', ref: 0, pieces: [], received: 0, bad: false };
    return ack(p, Uint8Array.of(0x1a));
  }

  /** Un job (ROSCTR 1) dal finto PLC verso il PG; l'ack-data attesa riporta questo pduRef. */
  private sendJob(d: Download, param: Uint8Array): void {
    this.jobRef = (this.jobRef % 0xffff) + 1;
    d.ref = this.jobRef;
    this.sendPdu({
      rosctr: 1,
      pduRef: d.ref,
      errorClass: 0,
      errorCode: 0,
      param,
      data: NOTHING,
    });
  }

  /** Ack-data del PG a un job 0x1B/0x1C. Fuori sequenza o illeggibile: il download è abbandonato. */
  private onAck(pdu: S7Pdu): void {
    const d = this.dl;
    if (!d || (d.phase !== 'block' && d.phase !== 'ended')) return; // nessun job in attesa
    if (pdu.rosctr !== 3 || pdu.pduRef !== d.ref) {
      this.dl = undefined;
      return;
    }
    if (d.phase === 'ended') {
      if (pdu.param.length !== 1 || pdu.param[0] !== 0x1c) {
        this.dl = undefined;
        return;
      }
      d.phase = 'insert';
      return;
    }
    let slice;
    try {
      slice = decodeDownloadBlockAck(pdu.param, pdu.data);
    } catch {
      this.dl = undefined;
      return;
    }
    if (d.received + slice.chunk.length > d.loadLength) {
      d.bad = true; // oltre il dichiarato: non si accumula, l'_INSE sarà rifiutato
    } else {
      d.pieces.push(slice.chunk);
      d.received += slice.chunk.length;
    }
    if (slice.eos) {
      this.sendJob(d, encodeDownloadBlockJob(d.type, d.number, d.fs));
      return;
    }
    if (d.received !== d.loadLength) d.bad = true;
    d.phase = 'ended';
    this.sendJob(d, encodeDownloadEnded(d.type, d.number, d.fs));
  }

  /** `_INSE` a trasferimento finito: solo qui il blocco entra nel blockMap. */
  private insertBlock(p: S7Pdu, block: { type: BlockType; number: number } | undefined): S7Pdu {
    const d = this.dl!;
    this.dl = undefined; // riuscito o no, questo download è chiuso
    if (!block || block.type !== d.type || block.number !== d.number) {
      return headerError(p, ERR.BLOCK_NAME);
    }
    if (d.bad) return headerError(p, ERR.WRONG_FRAMES);
    const file = new Uint8Array(d.received);
    let at = 0;
    for (const piece of d.pieces) {
      file.set(piece, at);
      at += piece.length;
    }
    try {
      const h = parseBlockFile(file).header;
      if (h.type !== d.type || h.number !== d.number || h.mc7Length !== d.mc7Length) {
        return headerError(p, ERR.WRONG_FRAMES);
      }
      this.cpu.applyDownloadedBlock(d.type, d.number, file);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    return ack(p, encodeControlResponse(0x28, 0));
  }

  // ---- upload ------------------------------------------------------------------------------

  private startUpload(p: S7Pdu): S7Pdu {
    if (this.cpu.config.protectionLevel === 3) return headerError(p, ERR.PROTECTED);
    let req;
    try {
      req = decodeStartUpload(p.param);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    let name;
    try {
      name = parseBlockFileName(req.fileName);
    } catch {
      return headerError(p, ERR.BLOCK_NAME);
    }
    if (!['A', 'P', 'B'].includes(name.filesystem)) return headerError(p, ERR.BLOCK_NAME);
    if (this.upload) return headerError(p, ERR.NO_PARALLEL_UPLOAD);
    const block = this.cpu.block(name.type, name.number);
    if (!block) return headerError(p, ERR.UPLOAD_MISSING);
    this.upload = { bytes: block.file, offset: 0, done: false };
    return ack(p, encodeStartUploadResponse(UPLOAD_ID, block.file.length));
  }

  private uploadChunk(p: S7Pdu): S7Pdu {
    if (this.cpu.config.protectionLevel === 3) return headerError(p, ERR.PROTECTED);
    let id;
    try {
      id = decodeUploadRequest(p.param).uploadId;
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    const u = this.upload;
    if (!u || id !== UPLOAD_ID || u.done) return headerError(p, ERR.BAD_SEQUENCE);
    // il pezzo riempie la PDU: header 12 + parametro 2 + intestazione dati 4
    const n = Math.min(Math.max(this.pdu - 18, 1), u.bytes.length - u.offset);
    const chunk = u.bytes.slice(u.offset, u.offset + n);
    u.offset += n;
    const more = u.offset < u.bytes.length;
    if (!more) u.done = true;
    const { param, data } = encodeUploadResponse(more, chunk);
    return ack(p, param, data);
  }

  private endUpload(p: S7Pdu): S7Pdu {
    if (this.cpu.config.protectionLevel === 3) return headerError(p, ERR.PROTECTED);
    let id;
    try {
      id = decodeEndUpload(p.param).uploadId;
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    if (!this.upload || id !== UPLOAD_ID) return headerError(p, ERR.BAD_SEQUENCE);
    this.upload = undefined;
    return ack(p, encodeEndUploadResponse());
  }

  // ---- userdata (ROSCTR 7) ---------------------------------------------------------------------

  private userdata(p: S7Pdu): S7Pdu | undefined {
    let u: DecodedUserdata;
    try {
      u = decodeUserdata(p.param, p.data);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    if (u.param.method !== 'request') return undefined;
    const { group, subfunction } = u.param;
    // richiesta di continuazione (proto §6.7): parametro di 8 byte con lo stesso sequence
    if (u.param.dataUnitRef !== undefined) return this.continuation(p, u);
    this.cont = undefined;

    switch (`${group}/${subfunction}`) {
      case '4/1': {
        let req;
        try {
          req = decodeSzlRequest(u.payload);
        } catch {
          return udError(p, u, UD.SZL_UNKNOWN);
        }
        if (this.cpu.config.faults.szlUnavailable?.includes(req.id)) {
          return udError(p, u, UD.SZL_UNKNOWN);
        }
        const list = buildSzl(this.cpu, req.id, req.index);
        if (!list) return udError(p, u, UD.SZL_UNKNOWN);
        return this.pieces(p, u, encodeSzl(list, Math.max(this.pdu - 26, 9)));
      }
      case '3/1':
        return this.pieces(p, u, [encodeBlockCounts(this.cpu.blockCounts())]);
      case '3/2': {
        let type;
        try {
          type = decodeBlockListOfTypeRequest(u.payload);
        } catch {
          return udError(p, u, UD.BLOCK_PARAM);
        }
        const list = this.cpu.blockList(type);
        // Nostra ipotesi, documentata e non vista in nessuna cattura: come risponde una CPU vera a un
        // tipo senza blocchi non è verificato (STEP 7 chiede solo i tipi con conteggio > 0). Il
        // client accetta sia 0xD20E sia una lista valida e vuota.
        if (list.length === 0) return udError(p, u, UD.NO_BLOCKS);
        // pezzi di PDU - 32 byte, a record interi (208 con PDU 240, come la CPU vera)
        const max = Math.max(Math.floor((this.pdu - 32) / 4) * 4, 4);
        return this.pieces(p, u, encodeBlockListOfType(list, max));
      }
      case '3/3': {
        let req;
        try {
          req = decodeBlockInfoRequest(u.payload);
        } catch {
          return udError(p, u, UD.BLOCK_NAME);
        }
        if (!['A', 'P', 'B'].includes(req.filesystem)) return udError(p, u, UD.BLOCK_NAME);
        const block = this.cpu.block(req.type, req.number);
        if (!block) return udError(p, u, UD.BLOCK_MISSING);
        return this.pieces(p, u, [this.cpu.blockInfo(block)]);
      }
      case '7/1':
      case '7/3':
        return this.pieces(p, u, [encodeBcdDateTime(this.cpu.now())]);
      case '7/2':
        return this.setClock(p, u);
      default:
        break;
    }
    // Funzioni che cambierebbero lo stato (TIS, cyclic, security, set clock alternativo 7/4):
    // rifiutate come da protezione. Il codec non costruisce risposte userdata per questi gruppi.
    if (group === 1 || group === 2 || group === 5 || (group === 7 && subfunction === 4)) {
      return headerError(p, ERR.PROTECTED);
    }
    return udError(p, u, group === 4 ? UD.SZL_UNKNOWN : UD.NOT_IMPLEMENTED);
  }

  /** Set clock (7/2, proto §12.0): vale in ogni modo; l'ora arriva a 10 byte e il giorno lo calcola la CPU. */
  private setClock(p: S7Pdu, u: DecodedUserdata): S7Pdu {
    const level = this.cpu.config.protectionLevel;
    if (level === 3) return setClockReply(p, u, UD.SET_CLOCK_LEVEL3);
    if (level === 2) return setClockReply(p, u, UD.SET_CLOCK_LEVEL2);
    if (!this.cpu.setClock) return setClockReply(p, u, UD.NOT_IMPLEMENTED);
    let t;
    try {
      t = decodeBcdDateTime(u.payload);
    } catch {
      return headerError(p, ERR.WRONG_FRAMES);
    }
    delete t.weekday; // quello scritto dal PG non conta: la CPU lo ricalcola
    this.cpu.setClock(t);
    return setClockReply(p, u, 0);
  }

  /** Una risposta in uno o più pezzi: dal secondo in poi servono richieste di continuazione. */
  private pieces(p: S7Pdu, u: DecodedUserdata, pieces: Uint8Array[]): S7Pdu {
    const { group, subfunction } = u.param;
    if (pieces.length === 1) {
      return udResponse(p, group, subfunction, u.param.sequence, 0, false, pieces[0]!);
    }
    const seq = (this.seqCounter = (this.seqCounter % 255) + 1);
    const dur = (this.durCounter = (this.durCounter % 255) + 1);
    this.cont = { group, sub: subfunction, seq, dur, pieces, next: 1 };
    return udResponse(p, group, subfunction, seq, dur, true, pieces[0]!);
  }

  private continuation(p: S7Pdu, u: DecodedUserdata): S7Pdu {
    const c = this.cont;
    const { group, subfunction, sequence } = u.param;
    if (!c || c.group !== group || c.sub !== subfunction || c.seq !== sequence) {
      return udError(p, u, UD.BAD_SEQUENCE);
    }
    const piece = c.pieces[c.next]!;
    c.next++;
    const more = c.next < c.pieces.length;
    if (!more) this.cont = undefined;
    return udResponse(p, group, subfunction, c.seq, c.dur, more, piece);
  }
}

// ---- costruzione delle risposte -------------------------------------------------------------------

function ack(p: S7Pdu, param: Uint8Array, data: Uint8Array = NOTHING): S7Pdu {
  return { rosctr: 3, pduRef: p.pduRef, errorClass: 0, errorCode: 0, param, data };
}

/** ack (ROSCTR 2) con l'errore nell'header, senza parametro né dati: la forma di d241 e d20c reali. */
function headerError(p: S7Pdu, [errorClass, errorCode]: readonly [number, number]): S7Pdu {
  return { rosctr: 2, pduRef: p.pduRef, errorClass, errorCode, param: NOTHING, data: NOTHING };
}

function udResponse(
  p: S7Pdu,
  group: number,
  subfunction: number,
  sequence: number,
  dataUnitRef: number,
  more: boolean,
  payload: Uint8Array,
): S7Pdu {
  const { param, data } = encodeUserdata(
    {
      method: 'response',
      group,
      subfunction,
      sequence,
      dataUnitRef,
      lastDataUnit: more,
      errorCode: 0,
    },
    payload,
  );
  return { rosctr: 7, pduRef: p.pduRef, errorClass: 0, errorCode: 0, param, data };
}

/** Errore userdata come la CPU vera: codice nel parametro, return code 0x0A, dati `0a 00 00 00`. */
function udError(p: S7Pdu, u: DecodedUserdata, code: number): S7Pdu {
  try {
    const { param, data } = encodeUserdata(
      {
        method: 'response',
        group: u.param.group,
        subfunction: u.param.subfunction,
        sequence: u.param.sequence,
        dataUnitRef: 0,
        lastDataUnit: false,
        errorCode: code,
      },
      NOTHING,
      0x0a,
    );
    return { rosctr: 7, pduRef: p.pduRef, errorClass: 0, errorCode: 0, param, data };
  } catch {
    // il codec non risponde ai gruppi di modifica: errore di header
    return headerError(p, [code >> 8, code & 0xff]);
  }
}

/**
 * Risposta al set clock (proto §12.0): parametro `00 01 12 08 12 87 02 SS 00 00 CC CC` e dati
 * `0a 00 00 00`, con l'error code nel parametro. Il codec non costruisce questa risposta (il set
 * clock è fuori dall'allowlist di sola lettura), quindi i byte sono scritti qui.
 */
function setClockReply(p: S7Pdu, u: DecodedUserdata, code: number): S7Pdu {
  const param = Uint8Array.of(
    0x00,
    0x01,
    0x12,
    0x08,
    0x12,
    0x87,
    0x02,
    u.param.sequence,
    0x00,
    0x00,
    code >> 8,
    code & 0xff,
  );
  return {
    rosctr: 7,
    pduRef: p.pduRef,
    errorClass: 0,
    errorCode: 0,
    param,
    data: Uint8Array.of(0x0a, 0x00, 0x00, 0x00),
  };
}

/**
 * Serve una connessione ISO-on-TCP su `t` come farebbe una CPU 315-2 PN/DP. `close()` chiude la
 * sessione e il trasporto; una chiusura dall'altra parte la libera da sola.
 */
export function serve(cpu: CpuBackend, t: Transport): { close(): void } {
  const s = new Session(cpu, t);
  return { close: () => s.close() };
}
