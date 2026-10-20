import { findInstruction, type AwlBlockInfo, type Operand, type Statement } from '@baaportal/awl';
import { layoutStruct, sameName, type DataType } from '@baaportal/s7-types';
import type { CompiledStatement, Mc7Diagnostic } from './encode';
import { allocateCall, type LocalSlot } from './localData';
import { address, blockRef, constant, indirectReg, pointerText } from './operands';
import {
  SymbolError,
  ar2Offset,
  constantFor,
  instanceLayout,
  locate,
  resolveValue,
  sectionsOf,
  sizeOf,
  toOperand,
  type NamedLayout,
  type SymbolEnv,
  type Value,
} from './resolveSymbols';
import type { SsbType } from './ssb';

/**
 * Espansione di `CALL` (mc7 §2.5): `CALL` non è un'istruzione MC7, il compilatore la scrive come
 * una sequenza tra due `BLD` seguendo gli schemi dei blocchi reali. Il criterio è l'**equivalenza**
 * (stessi parametri, stesso DB di istanza, stessa semantica), non l'identità con STEP 7, le cui
 * regole nessuna fonte documenta (mc7 §6.3).
 *
 * Schemi (temporanei: `localData.ts`):
 * - **FC/SFC**: `BLD 1|7; [= L r]; [TAR2 LD a]; copie in L; UC FC|SFC n + puntatori; [LAR2 LD a];
 *   copie delle uscite; BLD 2|8`. Un puntatore per parametro, nell'ordine IN, RET_VAL, OUT, IN_OUT:
 *   le variabili dell'area L passano con `P#V` diretto, le costanti e i dati di DB si copiano in L.
 *   `TAR2/LAR2` solo da un FB con dati d'istanza (AR2 è la base dell'istanza, FB80; FB101 senza
 *   dati d'istanza non lo salva). `= L r` (RLO) manca se la CALL è la prima istruzione della rete
 *   (FB101).
 * - **FB/SFB con DB**: `BLD 3|9; [= L r]; [copie verso L]; CDB; OPN DI m; TAR2 LD a; copie in DIx;
 *   LAR2 P#DBX 0.0; UC FB|SFB n; LAR2 LD a; copie da DIx; CDB; [copie da L]; BLD 4|10` (OB1).
 *   I valori che usano i registri DB/DI (DB qualificati, dati d'istanza del chiamante, formali di
 *   FC) passano da un temporaneo in L prima del primo `CDB` e dopo l'ultimo.
 * - **Multi-istanza** `CALL #x` (⚠️ nessun esempio reale, mc7 §2.5 «solo: DN»): `BLD 14|16;
 *   [= L r]; TAR2 LD a; copie in DIx[AR2,P#x+o]; L LD a; L P#x; +D; LAR2; UC FB|SFB n; LAR2 LD a;
 *   copie da DIx[AR2,P#x+o]; BLD 15|17`. AR2 si sposta con istruzioni verificate (`+D`, `LAR2`)
 *   invece di `+AR2 P#`, la cui codifica è in disaccordo tra le fonti (mc7 §6.2).
 *
 * Ogni CALL la cui forma non è nella tabella `CALL_FORMS` (verificata al byte sui blocchi reali)
 * si compila con le stesse regole e dà l'avviso `CALL_NON_VERIFICATO`, che nomina le forme.
 */

export interface CallForm {
  /** Tipo di chiamata o tipo di parametro: `<classe>:<direzione>:<valore>`. */
  key: string;
  description: string;
  /** CALL reali riprodotte al byte con questa forma (test `compile.test.ts`). */
  evidence: string[];
}

/**
 * Forme verificate: per ciascuna almeno una CALL reale, riscritta come sorgente `CALL` con
 * l'interfaccia decodificata, si ricompila identica al byte (21 CALL reali: 20 identiche; la
 * diversa è la CALL FB dell'OB1 TIA, base dei temporanei per rete e REAL 80.0 caricato come DINT).
 */
export const CALL_FORMS: readonly CallForm[] = [
  {
    key: 'FC',
    description: 'CALL FC: BLD 1; = L r; copie; UC FC n + puntatori P#V; BLD 2',
    evidence: ['FC1 reti 1–3 (9 CALL)', 'FC21 rete 1 (2)', 'FC100 reti 2 e 6 (4)', 'FB101 rete 3'],
  },
  {
    key: 'SFC',
    description: 'CALL SFC: BLD 7; = L r; copie; UC SFC n + puntatori; BLD 8',
    evidence: ['FC100 reti 2 e 9 (SFC 20)'],
  },
  {
    key: 'AR2',
    description: "da un FB con dati d'istanza: TAR2 LD a dopo = L r, LAR2 LD a dopo UC",
    evidence: ['FB80 rete 2 (FC 13)'],
  },
  {
    key: 'senza RLO',
    description: 'CALL prima istruzione della rete: nessun = L r',
    evidence: ['FB101 rete 3 (FC 100)'],
  },
  {
    key: 'SFB',
    description:
      'CALL SFB, DB: BLD 9; = L r; CDB; OPN DI m; TAR2 LD a; copie; LAR2 P#DBX 0.0; UC SFB n; LAR2 LD a; copie; CDB; BLD 10',
    evidence: ['OB1 TIA rete 2 (SFB 0, DB 1)'],
  },
  {
    key: 'FC:IN:costante',
    description: 'L costante; T L…; puntatore P#V',
    evidence: ['FC1: INT (FC 96), DINT (FC 16, FC 21)', 'FB101: INT (FC 100)'],
  },
  {
    key: 'FC:IN:costante-BOOL',
    description: 'SET o CLR; = L x.y; puntatore P#V x.y',
    evidence: ['FC1: FALSE (FC 94, FC 97)', 'FC100: TRUE (FC 94, FC 97)'],
  },
  {
    key: 'FC:L',
    description: "variabile dell'area L: puntatore P#V diretto, senza copia",
    evidence: ['FC100: INT (FC 95); ANY e RET_VAL (SFC 20)'],
  },
  {
    key: 'FC:IN:DB',
    description: 'accesso DB qualificato: OPN DB; L DBx; T L…; puntatore P#V',
    evidence: ['FB80: 5 DINT (FC 13)'],
  },
  {
    key: 'FC:ANY-costante',
    description: 'ANY costruito in L: L W#16#10tt (tipo 00); L n; L db; L P#area; T …',
    evidence: ['FC100: SRCBLK e DSTBLK (SFC 20)'],
  },
  {
    key: 'FB:IN:costante',
    description: "L costante; T DIx nell'istanza",
    evidence: ['OB1 TIA: PV (SFB 0)'],
  },
  {
    key: 'FB:IN:semplice',
    description: "A/L da I, Q, M, L; =/T DIx nell'istanza",
    evidence: ['OB1 TIA: CU := L20.0 (SFB 0)'],
  },
  {
    key: 'FB:OUT:semplice',
    description: "A/L DIx dall'istanza; =/T verso I, Q, M, L",
    evidence: ['OB1 TIA: CV => MW2 (SFB 0)'],
  },
];
const VERIFIED = new Set(CALL_FORMS.map((f) => f.key));

export interface CallEnv {
  sym: SymbolEnv;
  /** FB con dati d'istanza: AR2 si salva intorno alle CALL di FC/SFC. */
  ownerHasInstance: boolean;
  /** Primo byte libero per i temporanei delle CALL. */
  base: number;
  /** La CALL è la prima istruzione della sua rete (`network` da 1). */
  first(stmt: Statement, network: number): boolean;
  /** Fine dei temporanei di ogni CALL espansa (per i dati locali). */
  ends: number[];
  warn(d: Mc7Diagnostic): void;
}

type Dir = 'IN' | 'OUT' | 'IN_OUT';
interface Param {
  name: string;
  type: DataType;
  dir: Dir;
}
interface ParamPlan {
  form: string;
  /** Temporaneo richiesto: un bit o n byte. */
  slot?: 'bit' | number;
  pointer?: (s?: LocalSlot) => number[];
  before?: (s?: LocalSlot) => Statement[];
  after?: (s?: LocalSlot) => Statement[];
  /** Solo CALL con DB di istanza: prima del primo CDB / dopo l'ultimo. */
  stageIn?: (s?: LocalSlot) => Statement[];
  stageOut?: (s?: LocalSlot) => Statement[];
}

const fail = (code: string, message: string): never => {
  throw new SymbolError(code, message);
};
const bits24 = (v: number): number[] => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
const AREA_POINTER: Record<string, number> = {
  PI: 0x80,
  PQ: 0x80,
  I: 0x81,
  Q: 0x82,
  M: 0x83,
  DB: 0x84,
  DI: 0x85,
  // l'area L del chiamante è V per il blocco chiamato (mc7 §2.2.4)
  L: 0x87,
};
const SIMPLE = new Set(['I', 'Q', 'M', 'PI', 'PQ', 'L']);
const isSimple = (v: Value): boolean => v.k === 'area' && SIMPLE.has(v.area) && v.db === undefined;
const isParam = (t: SsbType | undefined, name: string): boolean =>
  t?.kind === 'parameter' && t.name === name;

const ANY_TYPES: Record<string, number> = {
  BOOL: 0x01,
  BYTE: 0x02,
  CHAR: 0x03,
  WORD: 0x04,
  INT: 0x05,
  DWORD: 0x06,
  DINT: 0x07,
  REAL: 0x08,
  DATE: 0x09,
  TOD: 0x0a,
  TIME_OF_DAY: 0x0a,
  TIME: 0x0b,
  S5TIME: 0x0c,
  DT: 0x0e,
  DATE_AND_TIME: 0x0e,
  STRING: 0x13,
};
const ANY_OF_ELEMENTARY: Record<string, number> = {
  Bool: 0x01,
  Byte: 0x02,
  Char: 0x03,
  Word: 0x04,
  Int: 0x05,
  DWord: 0x06,
  DInt: 0x07,
  Real: 0x08,
  Date: 0x09,
  Time_Of_Day: 0x0a,
  Time: 0x0b,
  S5Time: 0x0c,
};
const AREA_WORDS: Record<string, number> = {
  DBX: 0x84,
  DB: 0x84,
  DIX: 0x85,
  DI: 0x85,
  M: 0x83,
  I: 0x81,
  E: 0x81,
  Q: 0x82,
  A: 0x82,
  P: 0x80,
  PE: 0x80,
  PA: 0x80,
  PI: 0x80,
  PQ: 0x80,
  L: 0x87,
  V: 0x87,
};

interface AreaPointer {
  db: number;
  area: number;
  bit: number;
}
/** `P#DB10.DBX 2.0`, `P#M 10.3`, `P#2.0` (+ ` BYTE 10` per un ANY). */
function parseAreaPointer(
  text: string,
): (AreaPointer & { type?: number; count?: number }) | undefined {
  const m =
    /^P#(?:(DB|DI)(\d+)\.)?(?:([A-Za-z]+)[ \t]*)?(\d+)\.([0-7])(?:[ \t]+([A-Za-z_]+)[ \t]+(\d+))?$/i.exec(
      text.trim(),
    );
  if (!m) return undefined;
  const db = m[2] === undefined ? 0 : Number(m[2]);
  const area =
    m[3] === undefined
      ? m[1]
        ? AREA_WORDS[m[1].toUpperCase()]
        : 0
      : AREA_WORDS[m[3].toUpperCase()];
  if (area === undefined || db > 0xffff) return undefined;
  const bit = Number(m[4]) * 8 + Number(m[5]);
  if (bit > 0x7ffff) return undefined;
  if (m[6] === undefined) return { db, area, bit };
  const type = ANY_TYPES[m[6].toUpperCase()];
  const count = Number(m[7]);
  if (type === undefined || count > 0xffff) return undefined;
  return { db, area, bit, type, count };
}

/** Testo di un intero a 16 bit per `L` (forma INT, `30 03`, come `L 400` in FC100). */
const int16 = (n: number): string => String(n > 0x7fff ? n - 0x10000 : n);

/** Costruisce un'istruzione con la posizione della CALL (le diagnostiche puntano alla sua riga). */
function maker(at: Statement) {
  return (
    id: string,
    operand?: Operand,
    encode?: CompiledStatement['encode'],
  ): CompiledStatement => {
    const def = findInstruction(id, 'international');
    if (!def) throw new Error(`istruzione sconosciuta nel compilatore: ${id}`);
    return {
      instruction: { text: id, def, range: at.range },
      ...(operand ? { operand } : {}),
      ...(encode ? { encode } : {}),
      range: at.range,
    };
  };
}

const boolConst = (text: string): boolean => {
  const t = text.trim().toUpperCase();
  if (t === 'TRUE' || t === '1') return true;
  if (t === 'FALSE' || t === '0') return false;
  return fail('UNSUPPORTED', `costante BOOL non valida: ${text}`);
};
const bytesOfSize = { X: 1, B: 1, W: 2, D: 4 } as const;

interface Callee {
  info: AwlBlockInfo;
  kind: 'FC' | 'SFC' | 'FB' | 'SFB';
  number: number;
  /** Multi-istanza: posizione (bit) nell'istanza del chiamante. */
  multi?: number;
  /** CALL FB/SFB: numero del DB di istanza. */
  db?: number;
}

function findCallee(stmt: Statement, env: CallEnv): Callee {
  const op = stmt.operand;
  const ctx = env.sym.ctx;
  let info: AwlBlockInfo | undefined;
  let multi: number | undefined;
  if (op?.kind === 'block' && op.blockKind !== 'DI' && op.blockKind !== 'DB') {
    info = ctx.block({ kind: op.blockKind, number: op.number });
  } else if (op?.kind === 'symbol' && op.path.length === 1) {
    info = ctx.block({ name: op.path[0]!.name });
  } else if (op?.kind === 'local' && env.sym.owner === 'FB' && env.sym.instance) {
    const name = op.path[0]!.name;
    const m = env.sym.sections.stat.find((x) => sameName(x.name, name));
    if (m?.type.kind === 'named') {
      info = ctx.block({ name: m.type.name });
      if (!info) {
        const n = env.sym.tools.blockNumber(m.type.name);
        const found = env.sym.tools.resolve(m.type.name);
        if (n && found?.kind === 'fb') {
          const s = found.sections;
          info = {
            name: m.type.name,
            kind: n.block,
            number: n.number,
            iface: {
              input: s.input,
              output: s.output,
              inOut: s.inOut,
              static: s.static,
              temp: [],
              returnType: null,
            },
          };
        }
      }
      multi = locate(env.sym.instance, op.path, `#${name}`).bit;
    }
  }
  if (!info) return fail('UNSUPPORTED', 'CALL: blocco chiamato non trovato');
  if (info.kind !== 'FC' && info.kind !== 'SFC' && info.kind !== 'FB' && info.kind !== 'SFB') {
    return fail('UNSUPPORTED', `CALL di un ${info.kind}`);
  }
  const out: Callee = { info, kind: info.kind, number: info.number };
  if (multi !== undefined) {
    if (info.kind !== 'FB' && info.kind !== 'SFB')
      return fail('UNSUPPORTED', 'multi-istanza di un FC');
    out.multi = multi;
  } else if (info.kind === 'FB' || info.kind === 'SFB') {
    const inst = stmt.instanceDb;
    if (inst?.kind === 'block') out.db = inst.number;
    else if (inst?.kind === 'symbol' && inst.path.length === 1) {
      const d = ctx.block({ name: inst.path[0]!.name });
      if (d && (d.kind === 'DB' || d.kind === 'IDB')) out.db = d.number;
    }
    if (out.db === undefined)
      return fail('UNSUPPORTED', `CALL ${info.name}: DB di istanza mancante`);
  }
  return out;
}

/** Assegnazioni della CALL per nome canonico (alias risolti, mc7 §2.5). */
function assignments(stmt: Statement, info: AwlBlockInfo): Map<string, Operand> {
  const out = new Map<string, Operand>();
  for (const p of stmt.params ?? []) {
    if (!p.value) continue;
    const raw = p.name.startsWith('"') ? p.name.slice(1, -1) : p.name;
    const alias = Object.entries(info.paramAliases ?? {}).find(([a]) => sameName(a, raw));
    out.set((alias ? alias[1] : raw).normalize('NFC').toLowerCase(), p.value);
  }
  return out;
}

/** Specifica ANY di una variabile (⚠️ nessun esempio reale: tipo e numero dal tipo dichiarato). */
function anyOfVariable(
  v: Extract<Value, { k: 'area' }>,
  env: CallEnv,
): AreaPointer & { type: number; count: number } {
  const area = AREA_POINTER[v.area]!;
  const base = { db: v.db ?? 0, area, bit: v.bit };
  const t = v.type;
  if (!t) {
    const code = { X: 0x01, B: 0x02, W: 0x04, D: 0x06 }[v.size ?? 'B'];
    return { ...base, type: code, count: 1 };
  }
  if (t.kind === 'elementary') return { ...base, type: ANY_OF_ELEMENTARY[t.name]!, count: 1 };
  if (t.kind === 'dateAndTime') return { ...base, type: 0x0e, count: 1 };
  if (t.kind === 'array' && t.element.kind === 'elementary') {
    const n = t.dims.reduce((a, d) => a * (d.hi - d.lo + 1), 1);
    return { ...base, type: ANY_OF_ELEMENTARY[t.element.name]!, count: n };
  }
  if (t.kind === 'raw') return fail('UNSUPPORTED', 'ANY di un tipo sconosciuto');
  const size =
    t.kind === 'string'
      ? t.length + 2
      : (() => {
          const r = layoutStruct([{ name: 'x', type: t }], env.sym.tools.resolve);
          return r.ok ? r.sizeBytes : fail('UNSUPPORTED', 'ANY: dimensione del tipo sconosciuta');
        })();
  return { ...base, type: 0x02, count: size };
}

/** Espande una CALL; gli avvisi vanno in `env.warn`, gli errori nel risultato. */
export function expandCall(
  stmt: Statement,
  network: number,
  env: CallEnv,
): CompiledStatement[] | { error: Mc7Diagnostic } {
  const line = stmt.range.from.line + 1;
  try {
    return expand(stmt, network, line, env);
  } catch (e) {
    if (!(e instanceof SymbolError)) throw e;
    return {
      error: {
        severity: 'error',
        code: e.code,
        network,
        line,
        message: `Rete ${network}, riga ${line}: ${e.message}`,
        ...(e.params ? { params: e.params } : {}),
      },
    };
  }
}

function expand(stmt: Statement, network: number, line: number, env: CallEnv): CompiledStatement[] {
  const mk = maker(stmt);
  const callee = findCallee(stmt, env);
  const given = assignments(stmt, callee.info);
  const iface = callee.info.iface;
  const params: Param[] = [];
  const add = (list: { name: string; type: DataType }[] | undefined, dir: Dir): void => {
    for (const m of list ?? []) params.push({ name: m.name, type: m.type, dir });
  };
  const fcLike = callee.kind === 'FC' || callee.kind === 'SFC';
  add(iface?.input, 'IN');
  if (fcLike && iface?.returnType && iface.returnType.kind !== 'void') {
    params.push({ name: 'RET_VAL', type: iface.returnType, dir: 'OUT' });
  }
  add(iface?.output, 'OUT');
  add(iface?.inOut, 'IN_OUT');

  const rlo = !env.first(stmt, network);
  const plans: ParamPlan[] = [];
  const forms: string[] = [];
  let instLayout: NamedLayout | undefined;
  if (!fcLike) {
    const k = `inst:${callee.kind}${callee.number}`;
    instLayout = env.sym.cache.get(k);
    if (!instLayout) {
      try {
        instLayout = instanceLayout(sectionsOf(callee.info), env.sym.tools);
      } catch (e) {
        // un SymbolError tiene il suo codice (es. LAYOUT_SFB_SCONOSCIUTO)
        if (e instanceof SymbolError) {
          throw new SymbolError(e.code, `istanza di ${callee.info.name}: ${e.message}`, e.params);
        }
        return fail(
          'UNSUPPORTED',
          `istanza di ${callee.info.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      env.sym.cache.set(k, instLayout);
    }
  }
  for (const p of params) {
    const op = given.get(p.name.normalize('NFC').toLowerCase());
    if (!op) {
      if (fcLike)
        return fail('CALL_PARAM_MISSING', `CALL ${callee.info.name}: manca il parametro ${p.name}`);
      continue; // FB: un parametro non assegnato tiene il valore dell'istanza
    }
    const v = resolveValue(op, env.sym);
    const plan = fcLike ? planFc(p, v, mk, env) : planInstance(p, v, mk, callee, instLayout!);
    plans.push(plan);
    forms.push(plan.form);
  }

  // Temporanei
  const needsAr2 = fcLike ? env.ownerHasInstance : true;
  const bitPlans = plans.filter((p) => p.slot === 'bit');
  const bytePlans = plans.filter((p) => typeof p.slot === 'number');
  const slots = allocateCall(env.base, {
    ar2: needsAr2,
    rlo,
    bits: bitPlans.length,
    bytes: bytePlans.map((p) => p.slot as number),
  });
  const slotOf = new Map<ParamPlan, LocalSlot>();
  bitPlans.forEach((p, i) => slotOf.set(p, slots.bits[i]!));
  bytePlans.forEach((p, i) => slotOf.set(p, { byte: slots.bytes[i]! }));
  env.ends.push(slots.end);
  const each = (f: (p: ParamPlan, s?: LocalSlot) => Statement[] | undefined): Statement[] =>
    plans.flatMap((p) => f(p, slotOf.get(p)) ?? []);
  const ar2 = slots.ar2 !== undefined ? address('L', 'D', slots.ar2) : undefined;
  const rloSave = slots.rlo ? [mk('=', address('L', 'X', slots.rlo.byte, slots.rlo.bit))] : [];

  let out: Statement[];
  const keys: string[] = [];
  if (fcLike) {
    keys.push(callee.kind);
    if (ar2) keys.push('AR2');
    const pointers = plans.map((p) => p.pointer!(slotOf.get(p)));
    const [open, close] = callee.kind === 'FC' ? [1, 2] : [7, 8];
    out = [
      mk('BLD', constant(String(open))),
      ...rloSave,
      ...(ar2 ? [mk('TAR2', ar2)] : []),
      ...each((p, s) => p.before?.(s)),
      mk('UC', blockRef(callee.kind, callee.number), { pointers }),
      ...(ar2 ? [mk('LAR2', ar2)] : []),
      ...each((p, s) => p.after?.(s)),
      mk('BLD', constant(String(close))),
    ];
  } else if (callee.multi !== undefined) {
    keys.push(`multi-istanza ${callee.kind}`);
    const [open, close] = callee.kind === 'FB' ? [14, 15] : [16, 17];
    const at = callee.multi;
    out = [
      mk('BLD', constant(String(open))),
      ...rloSave,
      mk('TAR2', ar2!),
      ...each((p, s) => p.before?.(s)),
      mk('L', ar2!),
      mk('L', constant(`P#${at >> 3}.${at & 7}`)),
      mk('+D'),
      mk('LAR2'),
      mk('UC', blockRef(callee.kind, callee.number)),
      mk('LAR2', ar2!),
      ...each((p, s) => p.after?.(s)),
      mk('BLD', constant(String(close))),
    ];
  } else {
    keys.push(callee.kind);
    const [open, close] = callee.kind === 'FB' ? [3, 4] : [9, 10];
    out = [
      mk('BLD', constant(String(open))),
      ...rloSave,
      ...each((p, s) => p.stageIn?.(s)),
      mk('CDB'),
      mk('OPN', blockRef('DI', callee.db!)),
      mk('TAR2', ar2!),
      ...each((p, s) => p.before?.(s)),
      mk('LAR2', constant('P#DBX 0.0')),
      mk('UC', blockRef(callee.kind, callee.number)),
      mk('LAR2', ar2!),
      ...each((p, s) => p.after?.(s)),
      mk('CDB'),
      ...each((p, s) => p.stageOut?.(s)),
      mk('BLD', constant(String(close))),
    ];
  }
  if (!rlo) keys.push('senza RLO');
  keys.push(...forms);
  const unverified = [...new Set(keys)].filter((k) => !VERIFIED.has(k));
  if (unverified.length) {
    env.warn({
      severity: 'warning',
      code: 'CALL_NON_VERIFICATO',
      network,
      line,
      message: `Rete ${network}, riga ${line}: CALL ${callee.info.name} compilata con forme senza esempio reale verificato: ${unverified.join(', ')}.`,
      params: { forms: unverified.join(', '), block: callee.info.name },
    });
  }
  return out;
}

type Mk = ReturnType<typeof maker>;

const lAt = (s: LocalSlot | undefined, size: 'X' | 'B' | 'W' | 'D'): Operand =>
  address('L', size, s!.byte, size === 'X' ? (s!.bit ?? 0) : undefined);
const vPointer = (s?: LocalSlot): number[] => [0x87, ...bits24(s!.byte * 8 + (s!.bit ?? 0))];

/** Copia di un valore verso/da un temporaneo: `A x; = y` per i BOOL, `L x; T y` per gli altri. */
const move = (mk: Mk, from: Operand, to: Operand, bool: boolean): Statement[] =>
  bool ? [mk('A', from), mk('=', to)] : [mk('L', from), mk('T', to)];

function buildPointerLike(
  mk: Mk,
  p: AreaPointer & { type?: number; count?: number },
  s: LocalSlot,
): Statement[] {
  const out: Statement[] = [];
  let at = s.byte;
  if (p.type !== undefined) {
    out.push(
      mk('L', constant(`W#16#10${p.type.toString(16).padStart(2, '0').toUpperCase()}`), {
        constantType: 0,
      }),
      mk('T', address('L', 'W', at)),
      mk('L', constant(int16(p.count!))),
      mk('T', address('L', 'W', at + 2)),
    );
    at += 4;
  }
  out.push(
    mk('L', constant(int16(p.db))),
    mk('T', address('L', 'W', at)),
    mk('L', constant(pointerText([p.area, ...bits24(p.bit)])!)),
    mk('T', address('L', 'D', at + 2)),
  );
  return out;
}

/** Un parametro di FC/SFC: voce della lista dei puntatori ed eventuali copie (mc7 §2.5). */
function planFc(p: Param, v: Value, mk: Mk, env: CallEnv): ParamPlan {
  const t = p.type;
  const size = sizeOf(t);
  const dir = p.dir;
  if (size) {
    const bool = size === 'X';
    if (v.k === 'const') {
      if (dir !== 'IN')
        return fail('UNSUPPORTED', `${p.name}: una costante non può ricevere un'uscita`);
      if (bool) {
        const on = boolConst(v.text);
        return {
          form: 'FC:IN:costante-BOOL',
          slot: 'bit',
          before: (s) => [mk(on ? 'SET' : 'CLR'), mk('=', lAt(s, 'X'))],
          pointer: vPointer,
        };
      }
      const text = constantFor(t, v.text);
      return {
        form: 'FC:IN:costante',
        slot: bytesOfSize[size],
        before: (s) => [mk('L', constant(text)), mk('T', lAt(s, size))],
        pointer: vPointer,
      };
    }
    if (v.k === 'area' && v.area === 'L' && v.db === undefined) {
      return { form: 'FC:L', pointer: () => [0x87, ...bits24(v.bit)] };
    }
    if (isSimple(v) && v.k === 'area') {
      return { form: 'FC:I/Q/M', pointer: () => [AREA_POINTER[v.area]!, ...bits24(v.bit)] };
    }
    if (v.k === 'area' || v.k === 'inst' || v.k === 'formal') {
      const src = toOperand(v, p.name);
      const cls = v.k === 'inst' ? 'istanza' : v.k === 'formal' ? 'formale' : 'DB';
      return {
        form: `FC:${dir}:${cls}`,
        slot: bool ? 'bit' : bytesOfSize[size],
        ...(dir !== 'OUT' ? { before: (s?: LocalSlot) => move(mk, src, lAt(s, size), bool) } : {}),
        ...(dir !== 'IN' ? { after: (s?: LocalSlot) => move(mk, lAt(s, size), src, bool) } : {}),
        pointer: vPointer,
      };
    }
    return fail('UNSUPPORTED', `${p.name}: valore non supportato per un parametro di FC`);
  }
  if (t.kind === 'parameter' && (t.name === 'Timer' || t.name === 'Counter')) {
    if (v.k !== 'tc')
      return fail('UNSUPPORTED', `${p.name}: serve un temporizzatore o contatore assoluto`);
    // mc7 §2.5 ⚠️ solo [DN]: il numero nei primi 2 byte della voce
    return {
      form: `FC:${t.name.toUpperCase()}`,
      pointer: () => [v.number >> 8, v.number & 255, 0, 0],
    };
  }
  if (t.kind === 'parameter' && t.name.startsWith('Block_')) {
    if (v.k !== 'block') return fail('UNSUPPORTED', `${p.name}: serve un blocco assoluto`);
    return { form: 'FC:BLOCK', pointer: () => [v.number >> 8, v.number & 255, 0, 0] };
  }
  if (t.kind === 'parameter' && (t.name === 'Any' || t.name === 'Pointer')) {
    const any = t.name === 'Any';
    if (v.k === 'area' && v.area === 'L' && isParam(v.type, t.name)) {
      return { form: 'FC:L', pointer: () => [0x87, ...bits24(v.bit)] };
    }
    let spec: (AreaPointer & { type?: number; count?: number }) | undefined;
    let form: string;
    if (v.k === 'const') {
      spec = parseAreaPointer(v.text);
      if (!spec || (any && spec.type === undefined) || (!any && spec.type !== undefined)) {
        return fail(
          'UNSUPPORTED',
          `${p.name}: puntatore ${v.text} non valido per ${t.name.toUpperCase()}`,
        );
      }
      form = `FC:${t.name.toUpperCase()}-costante`;
    } else if (v.k === 'area') {
      spec = any
        ? anyOfVariable(v, env)
        : { db: v.db ?? 0, area: AREA_POINTER[v.area]!, bit: v.bit };
      form = `FC:${t.name.toUpperCase()}-variabile`;
    } else {
      return fail(
        'UNSUPPORTED',
        `${p.name}: ${t.name.toUpperCase()} di un dato d'istanza o di un parametro: l'indirizzo si calcola solo a run time (non supportato)`,
      );
    }
    const sp = spec;
    return {
      form,
      slot: any ? 10 : 6,
      before: (s) => buildPointerLike(mk, sp, s!),
      pointer: vPointer,
    };
  }
  return fail(
    'UNSUPPORTED',
    `${p.name}: parametro di tipo complesso (STRUCT, ARRAY, STRING, DT, UDT) di FC/SFC: nessun esempio reale né fonte per il formato`,
  );
}

/** Un parametro di FB/SFB: copia nell'istanza prima della chiamata o dall'istanza dopo. */
function planInstance(p: Param, v: Value, mk: Mk, callee: Callee, lay: NamedLayout): ParamPlan {
  const r = locate(lay, [{ name: p.name, quoted: false, range: { from: ZERO, to: ZERO } }], p.name);
  const multi = callee.multi;
  const size = sizeOf(p.type);
  const dir = p.dir;
  const target = (sz: 'X' | 'B' | 'W' | 'D'): Operand =>
    multi !== undefined
      ? indirectReg('DI', sz, 2, ar2Offset(multi + r.bit, p.name))
      : address('DI', sz, r.bit >> 3, sz === 'X' ? r.bit & 7 : undefined);
  if (!size) {
    if (p.type.kind === 'parameter' && ['Timer', 'Counter'].includes(p.type.name) && v.k === 'tc') {
      if (dir !== 'IN') return fail('UNSUPPORTED', `${p.name}: TIMER/COUNTER solo in ingresso`);
      return {
        form: 'FB:IN:numero',
        before: () => [mk('L', constant(int16(v.number))), mk('T', target('W'))],
      };
    }
    if (p.type.kind === 'parameter' && p.type.name.startsWith('Block_') && v.k === 'block') {
      if (dir !== 'IN') return fail('UNSUPPORTED', `${p.name}: BLOCK solo in ingresso`);
      return {
        form: 'FB:IN:numero',
        before: () => [mk('L', constant(int16(v.number))), mk('T', target('W'))],
      };
    }
    return fail(
      'UNSUPPORTED',
      `${p.name}: parametro di FB di tipo complesso o puntatore (STRUCT, ARRAY, STRING, DT, ANY, POINTER): non supportato`,
    );
  }
  const bool = size === 'X';
  const dst = target(size);
  if (v.k === 'const') {
    if (dir !== 'IN')
      return fail('UNSUPPORTED', `${p.name}: una costante non può ricevere un'uscita`);
    if (bool) {
      const on = boolConst(v.text);
      return { form: 'FB:IN:costante-BOOL', before: () => [mk(on ? 'SET' : 'CLR'), mk('=', dst)] };
    }
    const text = constantFor(p.type, v.text);
    return { form: 'FB:IN:costante', before: () => [mk('L', constant(text)), mk('T', dst)] };
  }
  if (v.k !== 'area' && v.k !== 'inst' && v.k !== 'formal') {
    return fail('UNSUPPORTED', `${p.name}: valore non supportato per un parametro di FB`);
  }
  const src = toOperand(v, p.name);
  if (isSimple(v) || multi !== undefined) {
    const cls = isSimple(v) ? 'semplice' : 'dati';
    const form = dir === 'IN_OUT' ? `FB:IN_OUT:${cls}` : `FB:${dir}:${cls}`;
    return {
      form,
      ...(dir !== 'OUT' ? { before: () => move(mk, src, dst, bool) } : {}),
      ...(dir !== 'IN' ? { after: () => move(mk, dst, src, bool) } : {}),
    };
  }
  // DB qualificati, dati d'istanza del chiamante, formali: passano da L fuori dai CDB
  return {
    form: dir === 'IN_OUT' ? 'FB:IN_OUT:dati' : `FB:${dir}:dati`,
    slot: bool ? 'bit' : bytesOfSize[size],
    ...(dir !== 'OUT'
      ? {
          stageIn: (s?: LocalSlot) => move(mk, src, lAt(s, size), bool),
          before: (s?: LocalSlot) => move(mk, lAt(s, size), dst, bool),
        }
      : {}),
    ...(dir !== 'IN'
      ? {
          after: (s?: LocalSlot) => move(mk, dst, lAt(s, size), bool),
          stageOut: (s?: LocalSlot) => move(mk, lAt(s, size), src, bool),
        }
      : {}),
  };
}

const ZERO = { line: 0, col: 0, offset: 0 };
