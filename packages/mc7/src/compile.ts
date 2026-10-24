import {
  checkBlockCode,
  parseNetwork,
  type AwlCode,
  type AwlContext,
  type AwlDiagnostic,
  type Statement,
} from '@baaportal/awl';
import type { TypedMember, TypeResolver } from '@baaportal/s7-types';
import { serializeAdd, type Mc7Add } from './add';
import { decodeFooter, decodeHeader, writeBlockFile } from './blockFile';
import { expandCall } from './callExpand';
import { codeEnvironment, toolsOf, type CodeEnvironment } from './codeEnv';
import { blockChecksum } from './crc';
import type { CodeMeta } from './decode';
import { encodeCode, sameText, type LineMapEntry, type Mc7Diagnostic } from './encode';
import { dataLayout, generatedNames, type LayoutOffset } from './layout';
import { absoluteLocalEnd, callBase, localDataLength } from './localData';
import {
  SymbolError,
  formalParam,
  resolveValue,
  rewriteStatement,
  structLayout,
  type Sections,
  type SymbolEnv,
} from './resolveSymbols';
import {
  buildSsb,
  readSsb,
  type SsbElement,
  type SsbInterface,
  type SsbSection,
  type SsbType,
} from './ssb';

/**
 * Compilatore dei blocchi del progetto (Task 7): un blocco AWL internazionale, con simboli, diventa
 * un file di blocco S7-300 valido (mc7 §1.12).
 *
 * Passi per OB, FB e FC:
 * 1. `checkBlockCode` (piano 1C): con errori nessun file, solo le diagnostiche (gli avvisi restano);
 * 2. simboli → operandi assoluti o formali (`resolveSymbols.ts`);
 * 3. ogni `CALL` → sequenza degli schemi reali (`callExpand.ts`);
 * 4. `encodeCode`;
 * 5. interfaccia con `buildSsb`;
 * 6. header e footer, dati locali (`localData.ts`), checksum con `blockChecksum`;
 * 7. `writeBlockFile`.
 *
 * Blocco importato (`codeMeta`, regola F): una rete tiene i byte originali solo se il ponte la
 * dichiara `'keep'` in `fidelity` (testo invariato a meno di nomi e commenti, interfaccia del
 * blocco e chiamati invariati) e se il codice non accede all'area L oltre la base originale dei
 * temporanei delle CALL; le altre reti si compilano dal testo, coi loro controlli.
 *
 * DB globale: SSB dalle variabili STAT con i valori iniziali; dati = layout con i valori iniziali.
 * DB di istanza: SSB dell'FB (genere 0a, numero dell'FB come DB1806, mc7 §1.9) con i valori iniziali
 * dell'FB; dati = valori iniziali dell'FB sostituiti da `initials` (i valori del DB).
 *
 * Header: firma `70 70`, formato 01, attributo 01 (collegato) più il bit 2 negli FB con multi-istanze
 * (FB80 e FB3004 reali ⚠️ significato non documentato), linguaggio 01 AWL (05 nei DB), know-how
 * header[15] = 03 (mc7 §1.8). I due timestamp sono `now` nell'ora locale: ms dalla mezzanotte e
 * giorni dal 1984-01-01. SSB[1..2] = numero del blocco nelle FC e negli FB non protetti, 0 negli OB
 * e nei blocchi protetti (11 blocchi reali di codice su 12; regola ⚠️ ignota, mc7 §1.4.1).
 */
export interface CompileInput {
  kind: 'OB' | 'FB' | 'FC' | 'DB' | 'IDB';
  number: number;
  knowHowProtected: boolean;
  /** Footer: autore, famiglia, nome (ASCII, al massimo 8 caratteri) e versione `a.b`. */
  header: { author: string; family: string; name: string; version: string };
  /** Interfaccia del blocco (DB globale: solo `stat`; IDB: non usata, vale `instanceOf`). */
  sections: Record<SsbSection, TypedMember[]>;
  /** Valori iniziali per percorso (`a.b`); in un IDB i valori del DB, sopra quelli dell'FB. */
  initials: Record<string, string>;
  networks: string[];
  /** Contesto AWL: `owner.iface` deve corrispondere a `sections`; i tag portano `address`. */
  ctx: AwlContext;
  /** DB di istanza: l'FB o SFB, le sue sezioni e i suoi valori iniziali (nell'SSB del DB). */
  instanceOf?: {
    kind: 'FB' | 'SFB';
    number: number;
    sections: Record<SsbSection, TypedMember[]>;
    initials?: Record<string, string>;
    /**
     * SFB: i primi tre byte dell'SSB di un DB di istanza reale dello stesso SFB (genere e numero).
     * Il genere dei DB di SFB non è documentato (mc7 §1.9): senza un esempio reale il DB non si
     * compila (`LAYOUT_SFB_SCONOSCIUTO`).
     */
    ssbHeader?: Uint8Array;
  };
  /**
   * Risolutore dei tipi per i layout (SSB, istanze, offset), se diverso da `ctx.resolve` (che
   * resta per il controllo AWL). Il ponte vi mette le strutture reali degli SFB; un risolutore
   * può lanciare un `SymbolError`, che diventa la diagnostica col suo codice.
   */
  layoutResolve?: TypeResolver;
  /** Timestamp di codice e interfaccia, letti nell'ora locale (come STEP 7 sul PC). */
  now: Date;
  /**
   * Blocco importato (solo OB, FB, FC): metadati di `decodeCode`. Le reti che tengono i byte
   * (`fidelity`) li riprendono tali e quali, grezzi e tipi compresi, senza controllo né
   * compilazione; le altre passano dal percorso normale. Gli errori `RAW_IN_CHANGED_NETWORK`,
   * `RAW_CONTESTO_CAMBIATO` e `RAW_JUMP_ACROSS_CHANGED` e l'ADD seguono `encodeCode`.
   */
  codeMeta?: CodeMeta;
  /**
   * Regola F, decisa dal ponte per ogni rete (da 0) del blocco importato:
   * - `'keep'`: la rete tiene i byte originali. Il compilatore usa `codeMeta.networkTexts[k]`, che
   *   ha lo stesso significato del testo attuale coi nomi originali (`#PARn` nelle FC);
   * - `'changed'`: testo modificato, si compila dal testo;
   * - una causa (`ContextCause`): testo invariato ma contesto dei byte cambiato. Si compila dal
   *   testo e un grezzo nella rete è l'errore `RAW_CONTESTO_CAMBIATO`.
   * Senza questo campo (uso diretto del compilatore) tengono i byte le reti col testo uguale a
   * quello importato (`sameText`). Il compilatore toglie comunque i byte a tutte le reti se il
   * testo attuale accede all'area L oltre la base originale dei temporanei delle CALL (causa
   * `localData`), o se non conosce i dati locali originali (`headerRaw` o `codeMeta.localData`;
   * causa `unknown`). Con una rete tenuta i dati locali sono il massimo tra gli originali e i nuovi.
   */
  fidelity?: readonly NetworkFidelity[];
  /** SSB originale: se dato, sostituisce quello costruito (interfaccia non modificata). */
  ssb?: Uint8Array;
  /** Header e footer originali (36 byte): si aggiornano solo tempo del codice, dati locali e campi del footer. */
  headerRaw?: Uint8Array;
  footerRaw?: Uint8Array;
}

export interface CompileResult {
  file?: Uint8Array;
  /**
   * Righe compilate: una voce per istruzione del codice MC7 (solo blocchi di codice compilati). Le
   * reti invariate di un blocco importato si ricodificano dal testo, quindi hanno la mappa come le
   * altre.
   */
  lines?: LineMapEntry[];
  diagnostics: Mc7Diagnostic[];
}

/**
 * Perché una rete col testo invariato non tiene i byte originali (regola F):
 * - `interface`: l'interfaccia (il layout) del blocco è cambiata dopo l'importazione;
 * - `callee`: è cambiato il blocco chiamato `callee` (`FC20`), oppure è stato aggiunto o tolto;
 * - `incoherent`: già all'importazione i byte non corrispondevano a `callee` dello stesso lotto
 *   (FB di una multi-istanza, chiamato di una lista dei puntatori, DB di istanza);
 * - `foreign`: `callee` è un blocco del progetto che non viene dall'importazione (regola S);
 * - `rebuilt`: `callee` è del lotto, ma BaaPortal ne rifà la struttura (una sua dipendenza è
 *   estranea o incoerente), quindi non è più quella per cui i byte sono stati compilati;
 * - `localData`: il codice accede all'area L oltre la base originale dei temporanei delle CALL;
 * - `unknown`: i metadati dell'importazione non hanno le impronte del contesto, o manca la
 *   lunghezza originale dei dati locali.
 */
export interface ContextCause {
  reason: 'interface' | 'callee' | 'incoherent' | 'foreign' | 'rebuilt' | 'localData' | 'unknown';
  callee?: string;
}

/** Decisione per una rete di un blocco importato (`CompileInput.fidelity`). */
export type NetworkFidelity = 'keep' | 'changed' | ContextCause;

const CAUSE_TEXT: Record<ContextCause['reason'], (c: ContextCause) => string> = {
  interface: () =>
    "l'interfaccia del blocco è cambiata dopo l'importazione e i byte originali valgono solo con quella di allora. Ripristinare l'interfaccia o riscrivere la rete senza righe grezze",
  callee: (c) =>
    `il blocco chiamato ${c.callee ?? '?'} è cambiato (o è stato aggiunto o tolto) dopo l'importazione. Reimportare il blocco insieme ai chiamati o riscrivere la rete senza righe grezze`,
  incoherent: (c) =>
    `i byte importati non corrispondono a ${c.callee ?? '?'} dello stesso lotto importato (IMPORT_CONTESTO_INCOERENTE). Allineare ${c.callee ?? '?'} o riscrivere la rete senza righe grezze`,
  rebuilt: (c) =>
    `${c.callee ?? '?'} si ricompila con una struttura diversa da quella per cui i byte importati sono stati compilati (una sua multi-istanza non viene dall'importazione o non torna). Reimportare il blocco insieme ai blocchi giusti o riscrivere la rete senza righe grezze`,
  foreign: (c) =>
    `${c.callee ?? '?'} non viene dall'importazione: è un blocco del progetto e nulla prova che i byte importati siano stati compilati per lui. Reimportare il blocco insieme a ${c.callee ?? '?'} o riscrivere la rete senza righe grezze`,
  localData: () =>
    "il codice accede all'area L oltre i dati locali usati dalle CALL originali. Ripristinare le reti o riscrivere la rete senza righe grezze",
  unknown: () =>
    "i metadati dell'importazione non dicono in quale contesto valgono i byte (versione precedente). Reimportare il blocco o riscrivere la rete senza righe grezze",
};

function contextDiagnostic(
  net: number,
  c: ContextCause,
): { code: string; message: string; params: Record<string, string> } {
  return {
    code: 'RAW_CONTESTO_CAMBIATO',
    message: `Rete ${net}: contiene istruzioni MC7 grezze, ma ${CAUSE_TEXT[c.reason](c)}.`,
    params: { reason: c.reason, ...(c.callee ? { callee: c.callee } : {}) },
  };
}

const CALLABLE = new Set(['FC', 'FB', 'SFC', 'SFB']);

/**
 * Una multi-istanza (tipo FB o SFB) dentro un ARRAY o una STRUCT (anche di un UDT): STEP 7 V5 non
 * la ammette e nessun blocco reale la mostra. Il percorso del primo membro trovato, o undefined.
 */
function nestedInstance(
  members: readonly TypedMember[],
  ctx: AwlContext,
  path = '',
  inside = false,
  depth = 0,
): string | undefined {
  if (depth > 16) return undefined;
  for (const m of members) {
    const at = path ? `${path}.${m.name}` : m.name;
    let t = m.type;
    let inArray = false;
    while (t.kind === 'array') {
      t = t.element;
      inArray = true;
    }
    if (t.kind === 'struct') {
      const hit = nestedInstance(t.members, ctx, at, true, depth + 1);
      if (hit) return hit;
    } else if (t.kind === 'named') {
      const found = ctx.resolve(t.name);
      if (found?.kind === 'fb' && (inside || inArray)) return at;
      if (found?.kind === 'udt') {
        const hit = nestedInstance(found.members, ctx, at, true, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

function nestedInstanceError(where: string): Mc7Diagnostic {
  return blockError(
    'DICHIARAZIONE_NON_AMMESSA',
    `${where}: una multi-istanza (FB o SFB) dentro un ARRAY o una STRUCT non è ammessa da STEP 7.`,
    { name: where },
  );
}

/**
 * `UC`/`CC` di un blocco la cui interfaccia nota ha parametri IN, OUT o IN_OUT, o un RET_VAL non
 * Void: una FC leggerebbe i byte seguenti come lista dei puntatori, e STEP 7 lo rifiuta. Si usa
 * `CALL`.
 */
function checkUcTarget(st: Statement, env: SymbolEnv): void {
  const id = st.instruction.def?.id;
  const op = st.operand;
  if ((id !== 'UC' && id !== 'CC') || (op?.kind !== 'block' && op?.kind !== 'symbol')) return;
  const v = resolveValue(op, env);
  if (v.k !== 'block' || !CALLABLE.has(v.blockKind)) return;
  const kind = v.blockKind as 'FC' | 'FB' | 'SFC' | 'SFB';
  const f = env.ctx.block({ kind, number: v.number })?.iface;
  const ret = f?.returnType != null && f.returnType.kind !== 'void';
  if (f && (f.input.length + f.output.length + f.inOut.length > 0 || ret)) {
    throw new SymbolError(
      'UC_BLOCCO_CON_PARAMETRI',
      `${id} ${kind} ${v.number}: il blocco ha parametri (IN, OUT, IN_OUT o RET_VAL) e va chiamato con CALL.`,
      { block: `${kind}${v.number}` },
    );
  }
}

const KIND_CODE = { OB: 0x08, FC: 0x0c, FB: 0x0e, DB: 0x0a, IDB: 0x0a } as const;
const LANGUAGE_AWL = 0x01;
const LANGUAGE_DB = 0x05;
const ATTR_LINKED = 0x01;
const ATTR_MULTI = 0x04;
const INSTANCE_GENRE = 0x0a;

const AWL_TEXT: Partial<Record<AwlCode, string>> = {
  SYNTAX: 'errore di sintassi',
  UNKNOWN_INSTRUCTION: 'istruzione sconosciuta',
  BAD_OPERAND: 'operando non valido',
  OPERAND_MISSING: 'operando mancante',
  OPERAND_NOT_ALLOWED: 'operando non ammesso',
  TYPE_MISMATCH: 'tipo non compatibile',
  UNKNOWN_SYMBOL: 'simbolo sconosciuto',
  UNKNOWN_LOCAL: 'variabile locale sconosciuta',
  UNKNOWN_MEMBER: 'membro sconosciuto',
  UNKNOWN_BLOCK: 'blocco sconosciuto',
  UNKNOWN_LABEL: 'etichetta non definita',
  DUPLICATE_LABEL: 'etichetta definita due volte',
  LABEL_TOO_LONG: 'etichetta più lunga di 4 caratteri',
  BRACKET_UNCLOSED: 'parentesi non chiusa',
  BRACKET_UNEXPECTED: 'parentesi chiusa senza apertura',
  BRACKET_DEPTH: 'troppe parentesi annidate',
  MCR_DEPTH: 'troppe MCR annidate',
  ADDRESS_OUT_OF_RANGE: 'indirizzo fuori dai limiti della CPU',
  CALL_PARAM_MISSING: 'parametro della CALL mancante',
  CALL_PARAM_UNKNOWN: 'parametro della CALL sconosciuto',
  CALL_PARAM_TYPE: 'tipo del parametro della CALL non compatibile',
  CALL_PARAM_DIRECTION: 'direzione del parametro della CALL sbagliata',
  CALL_INSTANCE_MISSING: 'DB di istanza mancante',
  CALL_INSTANCE_WRONG: 'DB di istanza sbagliato',
  LOCAL_NOT_ACCESSIBLE: 'variabile temporanea non accessibile',
  CONSTANT_OUT_OF_RANGE: 'costante fuori intervallo',
  UNCLOSED_STRING: 'stringa non chiusa',
  UNCLOSED_PARAMS: 'parametri della CALL non chiusi',
};

function fromAwl(d: AwlDiagnostic): Mc7Diagnostic {
  const network = d.network + 1;
  const line = d.range.from.line + 1;
  const extra = d.params
    ? ` (${Object.entries(d.params)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')})`
    : '';
  return {
    severity: d.severity,
    code: d.code,
    network,
    line,
    message: `Rete ${network}, riga ${line}: ${AWL_TEXT[d.code] ?? d.code}${extra}.`,
    ...(d.params ? { params: d.params } : {}),
  };
}

const blockError = (
  code: string,
  message: string,
  params?: Record<string, string>,
): Mc7Diagnostic => ({
  severity: 'error',
  code,
  network: 0,
  line: 0,
  message,
  ...(params ? { params } : {}),
});

/** Autore, famiglia, nome (ASCII, al massimo 8 caratteri) e versione `a.b` (0–15). */
function checkHeader(h: CompileInput['header'], out: Mc7Diagnostic[]): number {
  for (const [field, value] of [
    ['author', h.author],
    ['family', h.family],
    ['name', h.name],
  ] as const) {
    if (/[^\x20-\x7e]/.test(value)) {
      out.push(
        blockError(
          'HEADER_FIELD_NOT_ASCII',
          `Header: il campo ${field} contiene caratteri non ASCII.`,
          {
            field,
          },
        ),
      );
    } else if (value.length > 8) {
      out.push(
        blockError('HEADER_FIELD_TOO_LONG', `Header: il campo ${field} supera gli 8 caratteri.`, {
          field,
          length: String(value.length),
        }),
      );
    }
  }
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(h.version.trim());
  if (!m || Number(m[1]) > 15 || Number(m[2]) > 15) {
    out.push(
      blockError('HEADER_VERSION', `Header: versione "${h.version}" non valida (da 0.0 a 15.15).`, {
        version: h.version,
      }),
    );
    return 0;
  }
  return (Number(m[1]) << 4) | Number(m[2]);
}

/** Timestamp di blocco (mc7 §1.2): 4 byte ms dalla mezzanotte + 2 byte giorni dal 1984-01-01. */
function blockTime(d: Date): Uint8Array | undefined {
  const ms =
    ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
  const days = Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1984, 0, 1)) / 86_400_000,
  );
  if (!Number.isFinite(days) || days < 0 || days > 0xffff) return undefined;
  return Uint8Array.of(
    ms >>> 24,
    (ms >> 16) & 255,
    (ms >> 8) & 255,
    ms & 255,
    days >> 8,
    days & 255,
  );
}

const ascii8 = (s: string): number[] =>
  Array.from({ length: 8 }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0));

interface Parts {
  kindCode: number;
  attr: number;
  language: number;
  number: number;
  knowHow: boolean;
  time: Uint8Array;
  localData: number;
  version: number;
  header: CompileInput['header'];
  mc7: Uint8Array;
  ssb: Uint8Array;
  add: Mc7Add;
  headerRaw?: Uint8Array;
  footerRaw?: Uint8Array;
}

function assemble(p: Parts): Uint8Array {
  const h = p.headerRaw ? Uint8Array.from(p.headerRaw) : new Uint8Array(36);
  if (!p.headerRaw) {
    h.set([0x70, 0x70, 0x01, p.attr, p.language, p.kindCode, p.number >> 8, p.number & 255]);
    h[15] = p.knowHow ? 3 : 0;
    h.set(p.time, 22);
  }
  h.set(p.time, 16);
  const localData = p.headerRaw ? Math.max(p.localData, (h[32]! << 8) | h[33]!) : p.localData;
  h[32] = localData >> 8;
  h[33] = localData & 255;
  const crc = blockChecksum(p.kindCode, p.mc7);
  const f = p.footerRaw ? Uint8Array.from(p.footerRaw) : new Uint8Array(36);
  f.set([...ascii8(p.header.author), ...ascii8(p.header.family), ...ascii8(p.header.name)]);
  f[24] = p.version;
  f[26] = crc >> 8;
  f[27] = crc & 255;
  const empty = p.add.networks.length === 0 && p.add.jumps.length === 0 && p.add.rest.length === 0;
  return writeBlockFile({
    header: decodeHeader(h),
    mc7: p.mc7,
    ssb: p.ssb,
    add: p.add,
    addRaw: empty ? new Uint8Array(0) : serializeAdd(p.add),
    footer: decodeFooter(f),
  });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Il contesto per i layout: `ctx` col risolutore `layoutResolve`, se dato. */
const layoutContext = (i: CompileInput): AwlContext =>
  i.layoutResolve ? { ...i.ctx, resolve: i.layoutResolve } : i.ctx;

/** Errore dell'interfaccia; un `SymbolError` (es. `LAYOUT_SFB_SCONOSCIUTO`) tiene il suo codice. */
const interfaceError = (e: unknown, what: string): Mc7Diagnostic =>
  e instanceof SymbolError
    ? blockError(e.code, e.message, e.params)
    : blockError('INTERFACE', `${what}: ${message(e)}`);

export function compileBlock(i: CompileInput): CompileResult {
  try {
    return compileUnchecked(i);
  } catch (e) {
    // Un errore inatteso non deve fermare la compilazione degli altri blocchi (Task 8)
    return {
      diagnostics: [blockError('INTERNAL', `Errore interno del compilatore: ${message(e)}`)],
    };
  }
}

function compileUnchecked(i: CompileInput): CompileResult {
  const diagnostics: Mc7Diagnostic[] = [];
  const version = checkHeader(i.header, diagnostics);
  const time = blockTime(i.now);
  if (!time)
    diagnostics.push(
      blockError('TIMESTAMP_RANGE', 'Data fuori dal formato dei blocchi (1984–2163).'),
    );
  if (!Number.isInteger(i.number) || i.number < 0 || i.number > 0xffff) {
    diagnostics.push(blockError('BLOCK_NUMBER', `Numero di blocco ${i.number} fuori intervallo.`));
  }
  const ok = (): boolean => !diagnostics.some((d) => d.severity === 'error');
  const file = (p: Omit<Parts, 'time' | 'version' | 'header'>): CompileResult => {
    if (!ok()) return { diagnostics };
    try {
      return { file: assemble({ ...p, time: time!, version, header: i.header }), diagnostics };
    } catch (e) {
      diagnostics.push(
        blockError('BLOCK_TOO_LARGE', `Il blocco non entra nel formato: ${message(e)}.`),
      );
      return { diagnostics };
    }
  };
  if (i.kind === 'DB' || i.kind === 'IDB') return compileData(i, diagnostics, file);
  return compileCode(i, i.kind, diagnostics, file);
}

function compileCode(
  i: CompileInput,
  kind: 'OB' | 'FB' | 'FC',
  diagnostics: Mc7Diagnostic[],
  file: (p: Omit<Parts, 'time' | 'version' | 'header'>) => CompileResult,
): CompileResult {
  // 0. Regola F: le reti di un blocco importato che tengono i byte originali.
  const meta = i.codeMeta;
  const layoutCtx = layoutContext(i);
  const tools = toolsOf(layoutCtx);
  const s: Sections = i.sections;
  const parse = (n: string): Statement[] => parseNetwork(n, 'international').statements;
  let status: NetworkFidelity[] = i.networks.map((t, k) => {
    const original = meta?.networkTexts[k];
    if (original === undefined) return 'changed';
    if (i.fidelity) return i.fidelity[k] ?? 'changed';
    return sameText(t, original) ? 'keep' : 'changed';
  });
  if (meta && status.includes('keep')) {
    // Le CALL e i grezzi tenuti usano i temporanei dalla base originale (localData.ts, regola 1):
    // un nuovo accesso assoluto all'area L oltre quella base potrebbe esserne sovrascritto.
    let tempEnd = 0;
    try {
      tempEnd = Math.ceil(structLayout(s.temp, tools).endBits / 8);
    } catch {
      /* interfaccia senza layout: l'errore arriva più avanti */
    }
    const kept = i.networks.map((t, k) => (status[k] === 'keep' ? meta.networkTexts[k]! : t));
    const before = Math.max(tempEnd, callBase(meta.networkTexts.map(parse)));
    const after = Math.max(tempEnd, callBase(kept.map(parse)));
    if (after > before) {
      status = status.map((x): NetworkFidelity => (x === 'keep' ? { reason: 'localData' } : x));
    }
  }
  // Una rete tenuta usa i dati locali dell'originale: senza quel valore nessuna rete tiene i byte.
  const originalLocal = i.headerRaw ? (i.headerRaw[32]! << 8) | i.headerRaw[33]! : meta?.localData;
  if (originalLocal === undefined) {
    status = status.map((x): NetworkFidelity => (x === 'keep' ? { reason: 'unknown' } : x));
  }
  const keep = status.map((x) => x === 'keep');
  // Reti che tengono i byte (da 1): nessun controllo né compilazione.
  const same = new Set(keep.flatMap((x, k) => (x ? [k + 1] : [])));
  const texts = i.networks.map((t, k) => (keep[k] ? meta!.networkTexts[k]! : t));

  const nested = nestedInstance(
    [...s.in, ...s.out, ...s.inOut, ...s.stat, ...s.temp, ...s.ret],
    i.ctx,
  );
  if (nested) {
    diagnostics.push(nestedInstanceError(nested));
    return { diagnostics };
  }

  // 1. Controllo AWL del piano 1C (sul testo attuale: nomi attuali)
  diagnostics.push(
    ...checkBlockCode(i.networks, i.ctx, 'international')
      .filter((d) => !same.has(d.network + 1))
      .map(fromAwl),
  );
  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };

  // 2. Interfaccia e layout; 3. base dei temporanei delle CALL (localData.ts)
  const parsed: Statement[][] = texts.map(parse);
  let ssb: Uint8Array;
  let ce: CodeEnvironment;
  try {
    const number = kind === 'OB' || i.knowHowProtected ? 0 : i.number;
    ssb = buildSsb(s, i.initials, kind, { ...tools, number });
    if (i.ssb) ssb = i.ssb;
    ce = codeEnvironment(kind, s, layoutCtx, parsed);
  } catch (e) {
    diagnostics.push(interfaceError(e, 'Interfaccia non compilabile'));
    return { diagnostics };
  }
  const { env, callEnv, base, warnings } = ce;
  if (kind === 'FC') {
    // Ordine della lista dei puntatori: IN, RET_VAL, OUT, IN_OUT (mc7 §2.2.6, §2.5)
    const ret = s.ret.filter((m) => m.type.kind !== 'void');
    if (ret.length > 0 && s.out.length + s.inOut.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'FC_ORDINE_PARAMETRI_NON_VERIFICATO',
        network: 0,
        line: 0,
        message:
          'Ordine dei parametri della FC con RET_VAL verificato su un solo blocco reale: controllare i richiami.',
      });
    }
  }
  const multi = s.stat.filter(
    (m) => m.type.kind === 'named' && tools.resolve(m.type.name)?.kind === 'fb',
  );

  // 4. Codice
  const code = encodeCode(texts, meta, {
    formal: (name) => formalParam(env, name),
    keep,
    contextChanged: (k) => {
      const c = status[k];
      return typeof c === 'object' ? contextDiagnostic(k + 1, c) : undefined;
    },
    rewrite: (st, net) => {
      if (same.has(net)) return [st];
      try {
        checkUcTarget(st, env);
        return rewriteStatement(st, env);
      } catch (e) {
        if (!(e instanceof SymbolError)) throw e;
        const line = st.range.from.line + 1;
        return {
          error: {
            severity: 'error',
            code: e.code,
            network: net,
            line,
            message: `Rete ${net}, riga ${line}: ${e.message}`,
            ...(e.params ? { params: e.params } : {}),
          },
        };
      }
    },
    expandCall: (st, net) => (same.has(net) ? [st] : expandCall(st, net, callEnv)),
  });
  diagnostics.push(...code.diagnostics, ...warnings);
  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };

  // I temporanei delle CALL già espanse nel testo non spostano la base, ma sono dati locali.
  let localData = localDataLength(Math.max(base, absoluteLocalEnd(parsed.flat())), callEnv.ends);
  // Regola F: con una rete tenuta i dati locali non scendono sotto quelli dell'originale.
  if (same.size > 0 && originalLocal !== undefined) localData = Math.max(localData, originalLocal);
  if (localData > 0xffff) {
    diagnostics.push(blockError('LOCAL_DATA_TOO_LARGE', `Dati locali di ${localData} byte.`));
  }
  const result = file({
    kindCode: KIND_CODE[kind],
    attr: ATTR_LINKED | (kind === 'FB' && multi.length > 0 ? ATTR_MULTI : 0),
    language: LANGUAGE_AWL,
    number: i.number,
    knowHow: i.knowHowProtected,
    localData,
    mc7: code.mc7,
    ssb,
    add: code.add,
    ...(i.headerRaw ? { headerRaw: i.headerRaw } : {}),
    ...(i.footerRaw ? { footerRaw: i.footerRaw } : {}),
  });
  return result.file ? { ...result, lines: code.lines } : result;
}

const isComplex = (t: SsbType): boolean =>
  t.kind === 'struct' ||
  t.kind === 'array' ||
  t.kind === 'string' ||
  t.kind === 'dateAndTime' ||
  t.kind === 'named';

/** Scrive un valore iniziale (little-endian nell'SSB, mc7 §1.4.6) nei dati, big-endian (§1.4.8). */
function writeValue(
  out: Uint8Array,
  at: number,
  t: SsbType,
  initial: Uint8Array | undefined,
): void {
  const byte = at >> 3;
  if (t.kind === 'string') {
    // Senza valore iniziale: lunghezza massima scritta, attuale 0 (mc7 §1.9 ⚠️ dedotto dal layout)
    out[byte] = t.length;
    if (initial) out.set(initial.subarray(1, 2 + initial[1]!), byte + 1);
    return;
  }
  if (!initial) return;
  if (t.kind === 'elementary' && t.name === 'Bool') {
    if (initial[0]) out[byte]! |= 1 << (at & 7);
  } else if (t.kind === 'dateAndTime') out.set(initial, byte);
  else out.set(Uint8Array.from(initial).reverse(), byte);
}

function fill(
  els: SsbElement[],
  prefix: string,
  off: Map<string, LayoutOffset>,
  out: Uint8Array,
  shift: number,
): void {
  const names = generatedNames(els);
  els.forEach((e, k) => {
    if (e.section === 'temp' || e.section === 'ret') return;
    const path = prefix ? `${prefix}.${names[k]}` : names[k]!;
    const o = off.get(path);
    if (!o) return;
    const at = o.byte * 8 + (o.bit ?? 0) + shift;
    const t = e.type;
    if (e.section === 'inOut' && isComplex(t)) return; // puntatore di 6 byte: resta a zero
    if (t.kind === 'struct') fill(e.children ?? [], path, off, out, shift);
    else if (t.kind === 'named') fill(e.children?.[0]?.children ?? [], path, off, out, shift);
    else if (t.kind === 'array') {
      const elem = e.children?.[0];
      if (!elem || o.strideBits === undefined) return;
      const n = t.dims.reduce((a, d) => a * (d.hi - d.lo + 1), 1);
      const first = `${path}[${t.dims.map((d) => d.lo).join(',')}]`;
      for (let j = 0; j < n; j++) {
        const step = j * o.strideBits;
        if (elem.type.kind === 'struct') fill(elem.children ?? [], first, off, out, shift + step);
        else writeValue(out, at + step, elem.type, elem.initial);
      }
    } else writeValue(out, at, t, e.initial);
  });
}

/** Dati di un DB = layout dell'interfaccia con i valori iniziali. */
function dataImage(iface: SsbInterface): Uint8Array {
  const lay = dataLayout(iface);
  const off = new Map(lay.offsets.map((o) => [o.path, o]));
  const out = new Uint8Array(lay.size);
  const top = iface.header[0] === 0x05 ? (iface.elements[0]?.children ?? []) : iface.elements;
  fill(top, '', off, out, 0);
  return out;
}

function compileData(
  i: CompileInput,
  diagnostics: Mc7Diagnostic[],
  file: (p: Omit<Parts, 'time' | 'version' | 'header'>) => CompileResult,
): CompileResult {
  const tools = toolsOf(layoutContext(i));
  const sec = i.kind === 'DB' ? i.sections : i.instanceOf?.sections;
  const nested = sec
    ? nestedInstance([...sec.in, ...sec.out, ...sec.inOut, ...sec.stat], i.ctx)
    : undefined;
  if (nested) {
    diagnostics.push(nestedInstanceError(nested));
    return { diagnostics };
  }
  let ssb: Uint8Array;
  let data: Uint8Array;
  try {
    if (i.kind === 'DB') {
      ssb = buildSsb(i.sections, i.initials, 'DB', { ...tools, number: i.number });
      data = dataImage(readSsb(ssb, 'DB'));
    } else {
      const fb = i.instanceOf;
      if (!fb) {
        diagnostics.push(blockError('IDB_WITHOUT_FB', 'DB di istanza senza FB.'));
        return { diagnostics };
      }
      // mc7 §1.9: il genere SSB del DB di un SFB non è documentato. Si usa solo quello di un DB
      // reale dello stesso SFB; senza, il DB non si compila (mai un genere indovinato).
      const head = fb.ssbHeader;
      if (fb.kind === 'SFB' && (!head || head.length < 3)) {
        diagnostics.push(
          blockError(
            'LAYOUT_SFB_SCONOSCIUTO',
            `DB di istanza dell'SFB ${fb.number}: genere SSB e struttura reale dell'istanza non noti; servono da un blocco reale (per esempio un kit letto dal PLC).`,
            { sfb: `SFB${fb.number}` },
          ),
        );
        return { diagnostics };
      }
      const opts = {
        ...tools,
        genre: head ? head[0]! : INSTANCE_GENRE,
        number: head ? head[1]! | (head[2]! << 8) : fb.number,
      };
      ssb = buildSsb(fb.sections, fb.initials ?? {}, 'FB', opts);
      const actual = buildSsb(fb.sections, { ...(fb.initials ?? {}), ...i.initials }, 'FB', opts);
      data = dataImage(readSsb(actual, 'DB'));
    }
  } catch (e) {
    diagnostics.push(interfaceError(e, 'Interfaccia del DB non compilabile'));
    return { diagnostics };
  }
  return file({
    kindCode: KIND_CODE[i.kind],
    attr: ATTR_LINKED,
    language: LANGUAGE_DB,
    number: i.number,
    knowHow: i.knowHowProtected,
    localData: 0,
    mc7: data,
    ssb,
    add: { networks: [], jumps: [], rest: new Uint8Array(0) },
  });
}
