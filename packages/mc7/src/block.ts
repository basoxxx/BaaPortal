import { emptyAdd, parseAdd, type Mc7Add } from './add';
import {
  decodeFooter,
  decodeHeader,
  Mc7Error,
  readBlockFile,
  writeBlockFile,
  type BlockKind,
} from './blockFile';
import type { ResolveCallee } from './callRebuild';
import { blockChecksum } from './crc';
import { decodeCode, type CodeMeta } from './decode';
import { encodeCode, type EncodeCodeOptions, type Mc7Diagnostic } from './encode';
import { readSsb, writeSsb, type SsbInterface } from './ssb';

/** Tutto ciò che serve a ricodificare un blocco letto identico al byte (esadecimale dove serve). */
export interface BlockMeta {
  /** Header di 36 byte originale. Se ne toccano solo i campi che `Mc7Block` ha cambiato. */
  headerRaw: string;
  /** SSB originale (diagnostica: la scrittura parte da `iface`). */
  ssbRaw?: string;
  /** ADD originale, per tenerne i byte se la struttura non cambia. */
  addRaw: string;
  code?: CodeMeta;
  /** Checksum originale: si riscrive se MC7 (o dati) e tipo sono invariati (mc7 §1.7). */
  checksum: number;
  /** Il file intero originale in esadecimale: `encodeBlock` lo restituisce se `exact` è false. */
  original: string;
  /** Impronta dello stato decodificato (solo se `exact` è false): rileva le modifiche. */
  stateHash?: string;
  /** FNV-1a 64 (esadecimale) di byte di tipo + MC7 come decodificati. */
  mc7Hash: string;
  footerRaw: string;
  /** Timestamp di codice e interfaccia (6 byte ciascuno, esadecimale). */
  times: { code: string; iface: string };
}

export interface Mc7Block {
  kind: BlockKind;
  number: number;
  language: number;
  knowHowProtected: boolean;
  header: { author: string; family: string; name: string; version: string };
  iface: SsbInterface;
  networks?: string[];
  /** Valori attuali di un DB (la sezione MC7). I valori iniziali sono in `iface` (`initial`). */
  data?: Uint8Array;
  /** DB di istanza: FB cui appartiene (mc7 §1.9: SSB[0] = 0a, SSB[1..2] = numero FB). */
  instanceOf?: { kind: 'FB'; number: number };
  /** true se `encodeBlock` riscrive il blocco identico al byte; altrimenti è di sola lettura. */
  exact: boolean;
  /** Perché `exact` è false (o altri problemi di decodifica). */
  warnings: string[];
  /**
   * Note della decodifica (info). `BLOCCO_PROTETTO_KNOW_HOW`: il codice di un blocco protetto non
   * si decodifica (spec: "la protezione si rispetta"); `networks` e `meta.code` mancano e i byte
   * originali sono l'unica fonte.
   */
  diagnostics?: Mc7Diagnostic[];
  meta: BlockMeta;
}

export type EncodeBlockOptions = EncodeCodeOptions;

export interface DecodeBlockOptions {
  /**
   * Interfaccia dei blocchi chiamati: nei blocchi di codice le CALL con un chiamato noto si
   * ricostruiscono, verificate al byte (`callRebuild.ts`); senza, il codice resta come decodificato.
   */
  resolveCallee?: ResolveCallee;
}

/** Errore di compilazione con le diagnostiche del codificatore. */
export class Mc7CompileError extends Mc7Error {
  readonly diagnostics: Mc7Diagnostic[];
  constructor(message: string, diagnostics: Mc7Diagnostic[]) {
    super('COMPILE', message);
    this.diagnostics = diagnostics;
  }
}

const CODE_KINDS = new Set<BlockKind>(['OB', 'FB', 'FC', 'SFB', 'SFC']);
const INSTANCE_GENRE = 0x0a;

const toHex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new RangeError(`esadecimale non valido`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** FNV-1a a 64 bit di [codice tipo, ...MC7]. */
function mc7Hash(kindCode: number, mc7: Uint8Array): string {
  const mask = (1n << 64n) - 1n;
  const prime = 0x100000001b3n;
  let h = 0xcbf29ce484222325n;
  const feed = (b: number): void => {
    h = ((h ^ BigInt(b)) * prime) & mask;
  };
  feed(kindCode);
  for (const b of mc7) feed(b);
  return h.toString(16).padStart(16, '0');
}

const hexOf = (b: Uint8Array): string => toHex(b);

/** Impronta dello stato modificabile di un blocco (per riconoscere le modifiche). */
function stateHash(b: Mc7Block): string {
  let ssb = '';
  try {
    ssb = hexOf(writeSsb(b.iface));
  } catch {
    ssb = 'illeggibile';
  }
  const text = JSON.stringify([
    b.kind,
    b.number,
    b.language,
    b.knowHowProtected,
    b.header,
    b.networks ?? null,
    b.data ? hexOf(b.data) : null,
    b.instanceOf ?? null,
    ssb,
    b.meta.times,
  ]);
  return mc7Hash(0, new TextEncoder().encode(text));
}

function sectionAt(f: ReturnType<typeof readBlockFile>, i: number): string {
  if (i < 36) return 'header';
  i -= 36;
  if (i < f.mc7.length) return `MC7 (byte ${i})`;
  i -= f.mc7.length;
  if (i < f.ssb.length) return `SSB (byte ${i})`;
  i -= f.ssb.length;
  if (i < f.addRaw.length) return `ADD (byte ${i})`;
  return 'footer';
}

/**
 * Decodifica un blocco leggibile da `readBlockFile`. Se `encodeBlock` lo riscrive identico al byte,
 * `exact` è true. Altrimenti il blocco si restituisce lo stesso con `exact = false` e le cause in
 * `warnings`: `encodeBlock` ne restituisce i byte originali se non è stato modificato. Solo i file
 * illeggibili e gli SDB danno errore.
 */
export function decodeBlock(file: Uint8Array, opts: DecodeBlockOptions = {}): Mc7Block {
  const block = decodeBlockUnchecked(file, opts);
  const decodeWarnings = block.warnings.length;
  let why: string | undefined;
  try {
    const back = encodeBlock(block);
    const n = Math.min(back.length, file.length);
    let i = 0;
    while (i < n && back[i] === file[i]) i++;
    if (i < file.length || back.length !== file.length) {
      why = `la ricodifica differisce a partire dal byte 0x${i.toString(16)} (${sectionAt(readBlockFile(file), i)})`;
    }
  } catch (e) {
    why = `la ricodifica fallisce: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (why !== undefined || decodeWarnings > 0) {
    if (why !== undefined) block.warnings.push(why);
    block.exact = false;
    block.meta.stateHash = stateHash(block);
  }
  return block;
}

function decodeBlockUnchecked(file: Uint8Array, opts: DecodeBlockOptions): Mc7Block {
  const f = readBlockFile(file);
  const kind = f.header.kind;
  if (kind === 'SDB') {
    throw new Mc7Error('UNSUPPORTED', 'SDB: contenitore opaco, contenuto non decodificabile');
  }
  if (kind === undefined) {
    throw new Mc7Error(
      'UNSUPPORTED',
      `tipo di blocco sconosciuto: 0x${f.header.kindCode.toString(16)}`,
    );
  }
  const warnings: string[] = [];
  let iface: SsbInterface = { header: new Uint8Array(0), elements: [], tail: new Uint8Array(0) };
  let ifaceRead = false;
  try {
    iface = readSsb(f.ssb, kind);
    ifaceRead = true;
  } catch (e) {
    warnings.push(`interfaccia non leggibile: ${e instanceof Error ? e.message : String(e)}`);
  }
  const block: Mc7Block = {
    kind,
    number: f.header.number,
    language: f.header.language,
    knowHowProtected: f.header.knowHowProtected,
    header: {
      author: f.footer.author,
      family: f.footer.family,
      name: f.footer.name,
      version: f.footer.version,
    },
    iface,
    exact: true,
    warnings,
    meta: {
      original: toHex(file),
      headerRaw: toHex(f.header.raw),
      addRaw: toHex(f.addRaw),
      checksum: f.footer.checksum,
      mc7Hash: mc7Hash(f.header.kindCode, f.mc7),
      footerRaw: toHex(f.footer.raw),
      times: { code: toHex(f.header.codeTime), iface: toHex(f.header.interfaceTime) },
    },
  };
  if (f.ssb.length > 0) block.meta.ssbRaw = toHex(f.ssb);
  if (CODE_KINDS.has(kind) && f.header.knowHowProtected) {
    // Protezione know-how (spec): si legge l'interfaccia, il codice non si decodifica né si mostra.
    block.diagnostics = [
      {
        severity: 'info',
        code: 'BLOCCO_PROTETTO_KNOW_HOW',
        network: 0,
        line: 0,
        message:
          'Blocco protetto know-how: il codice non si decodifica, si mostra solo l’interfaccia.',
      },
    ];
  } else if (CODE_KINDS.has(kind)) {
    try {
      const caller =
        ifaceRead && (kind === 'OB' || kind === 'FB' || kind === 'FC')
          ? { kind, iface }
          : undefined;
      const d = decodeCode(
        f.mc7,
        f.add,
        opts.resolveCallee && caller ? { resolveCallee: opts.resolveCallee, caller } : {},
      );
      block.networks = d.networks;
      block.meta.code = { ...d.meta, localData: f.header.localDataLength };
    } catch (e) {
      warnings.push(`codice non decodificabile: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (kind === 'DB') {
    block.data = f.mc7;
    if (iface.header.length === 7 && iface.header[0] === INSTANCE_GENRE) {
      block.instanceOf = { kind: 'FB', number: iface.header[1]! | (iface.header[2]! << 8) };
    }
  } else {
    throw new Mc7Error('UNSUPPORTED', `tipo di blocco non gestito: ${kind}`);
  }
  return block;
}

/**
 * Riscrive un blocco. Non ricalcola la lunghezza dei dati locali (byte 32-33 dell'header): la
 * imposta il compilatore (Task 7) in `meta.headerRaw`. Con `exact = false` restituisce i byte
 * originali se il blocco non è stato modificato, altrimenti `Mc7Error('UNSUPPORTED')`.
 */
export function encodeBlock(b: Mc7Block, opts: EncodeBlockOptions = {}): Uint8Array {
  // Blocco protetto letto da file: senza reti si restituiscono i byte originali (nulla da ricodificare).
  if (CODE_KINDS.has(b.kind) && b.knowHowProtected && b.networks === undefined && b.exact) {
    return fromHex(b.meta.original);
  }
  if (!b.exact) {
    if (b.meta.stateHash !== undefined && stateHash(b) === b.meta.stateHash) {
      return fromHex(b.meta.original);
    }
    throw new Mc7Error('UNSUPPORTED', 'blocco non ricodificabile al byte: modifiche non possibili');
  }
  return encodeExact(b, opts);
}

function encodeExact(b: Mc7Block, opts: EncodeBlockOptions): Uint8Array {
  const headerRaw = fromHex(b.meta.headerRaw);
  const footerRaw = fromHex(b.meta.footerRaw);
  if (headerRaw.length !== 36)
    throw new Mc7Error('FORMAT', 'meta.headerRaw deve essere di 36 byte');
  if (footerRaw.length !== 36)
    throw new Mc7Error('FORMAT', 'meta.footerRaw deve essere di 36 byte');
  const addRaw = fromHex(b.meta.addRaw);

  let mc7: Uint8Array;
  let add: Mc7Add;
  if (CODE_KINDS.has(b.kind)) {
    if (!b.networks) throw new RangeError('blocco di codice senza reti');
    const r = encodeCode(b.networks, b.meta.code, opts);
    if (r.diagnostics.some((d) => d.severity === 'error')) {
      throw new Mc7CompileError(
        `errori di compilazione: ${r.diagnostics.filter((d) => d.severity === 'error').length}`,
        r.diagnostics,
      );
    }
    mc7 = r.mc7;
    add = r.add;
  } else if (b.kind === 'DB') {
    if (!b.data) throw new RangeError('DB senza dati');
    mc7 = b.data;
    add = (addRaw.length > 0 ? parseAdd(addRaw, mc7.length) : undefined) ?? emptyAdd();
  } else {
    throw new Mc7Error('UNSUPPORTED', `tipo di blocco non gestito: ${b.kind}`);
  }

  // Legame con l'FB di un DB di istanza: SSB[1..2].
  const iface = b.iface;
  if (
    b.kind === 'DB' &&
    b.instanceOf &&
    iface.header.length === 7 &&
    iface.header[0] === INSTANCE_GENRE
  ) {
    const n = b.instanceOf.number;
    if (!Number.isInteger(n) || n < 0 || n > 0xffff)
      throw new RangeError(`FB fuori intervallo: ${n}`);
    const head = Uint8Array.from(iface.header);
    head[1] = n & 0xff;
    head[2] = n >> 8;
    return finish({ ...iface, header: head });
  }
  return finish(iface);

  function finish(i: SsbInterface): Uint8Array {
    const header = decodeHeader(headerRaw);
    header.kind = b.kind;
    header.number = b.number;
    header.language = b.language;
    header.knowHowProtected = b.knowHowProtected;
    header.codeTime = fromHex(b.meta.times.code);
    header.interfaceTime = fromHex(b.meta.times.iface);
    const footer = decodeFooter(footerRaw);
    footer.author = b.header.author;
    footer.family = b.header.family;
    footer.name = b.header.name;
    footer.version = b.header.version;
    footer.checksum = b.meta.checksum;
    const out = writeBlockFile({ header, mc7, ssb: writeSsb(i), add, addRaw, footer });
    const kindCode = out[5]!;
    if (mc7Hash(kindCode, mc7) !== b.meta.mc7Hash) {
      const crc = blockChecksum(kindCode, mc7);
      out[out.length - 36 + 26] = crc >> 8;
      out[out.length - 36 + 27] = crc & 0xff;
    }
    return out;
  }
}
