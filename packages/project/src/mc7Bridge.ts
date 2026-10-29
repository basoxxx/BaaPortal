// Ponte tra il modello del progetto e @baaportal/mc7: compilazione, importazione ed esportazione.
import { parseNetwork, type AwlContext, type Operand, type Statement } from '@baaportal/awl';
import type { CpuType, SystemBlock } from '@baaportal/catalog';
import { findSystemBlock } from '@baaportal/catalog';
import {
  buildSsb,
  compileBlock,
  dataLayout,
  decodeInstruction,
  readBlockFile,
  readSsb,
  sameText,
  decodeBlock,
  generatedNames,
  initialLiteral,
  sectionsFromSsb,
  SymbolError,
  toolsOf,
  Mc7Error,
  type CalleeInterface,
  type CompileInput,
  type Mc7Block,
  type LineMapEntry,
  type Mc7Diagnostic,
  type NetworkFidelity,
  type ResolveCallee,
  type DataLayout,
  type SsbElement,
  type SsbInterface,
  type SsbSection,
  type SsbType,
} from '@baaportal/mc7';
import {
  formatType,
  parseType,
  sameName,
  type DataType,
  type FbSections,
  type TypedMember,
  type TypeResolver,
} from '@baaportal/s7-types';
import { createAwlContext } from './awlContext';
import { findSystemFb, toTypedMembers } from './members';
import { blockSources, kopSources, type KopNetworkResult } from './kopSources';
import { isGraphic } from './model';
import type {
  Block,
  BlockHeader,
  CodeBlock,
  DbAttributes,
  GlobalDb,
  InstanceDb,
  Member,
  Mc7Fidelity,
  Mc7Meta,
  PlcDevice,
} from './model';
import { createNamer, symbolNames, type NewId } from './plc';

export type { Mc7Diagnostic };

/** Codici delle diagnostiche che questo ponte emette (oltre a quelli di `MC7_DIAG_CODES`). */
export const MC7_BRIDGE_DIAG_CODES = [
  'ACCESSO_ASSOLUTO_ISTANZA',
  'BLOCCO_IMPORTATO_NON_RICODIFICABILE',
  'DB_GENERE_NON_GESTITO',
  'DB_NON_CONVERTITO',
  'CALL_RICOSTRUITA_CON_PROGETTO',
  'DIPENDENZA_ESTRANEA',
  'DIPENDENZA_RIFATTA',
  'DOPPIONE_RILETTO',
  'FB_ISTANZA_NON_TROVATO',
  'IDB_INCOERENTE',
  'IMPORT_CONTESTO_INCOERENTE',
  'INTERNAL',
  'KOP_BAD_INSTANCE',
  'KOP_BAD_LABEL',
  'KOP_BOX_IN_PARALLEL',
  'KOP_BOX_IN_PIN',
  'KOP_BOX_IN_TBRANCH',
  'KOP_EDGE_ON_RAIL',
  'KOP_EMPTY_BRANCH',
  'KOP_EMPTY_OPERAND',
  'KOP_FLOW_IN_BRANCH',
  'KOP_MIDLINE_ON_RAIL',
  'KOP_MUST_BE_ALONE',
  'KOP_NO_OUTPUT',
  'KOP_NOT_ON_RAIL',
  'KOP_RET_ON_RAIL',
  'KOP_TOO_MANY_LABELS',
  'LINGUAGGIO_NON_COMPILABILE',
  'VALORI_ATTUALI_PERSI',
  'VALORI_INIZIALI_DA_CAMPIONE',
] as const;

/** Le diagnostiche KOP come errori del ponte: `KOP_<CODICE>`, rete da 1; bloccano la compilazione. */
function kopDiagnostics(nets: KopNetworkResult[]): Mc7Diagnostic[] {
  return nets.flatMap((r, k) => [
    // SCL: il messaggio del traduttore e la riga SCL.
    ...(r.scl?.diagnostics ?? []).map((d) => ({
      ...err('SCL_ERRORE', d.message),
      network: k + 1,
      line: d.line,
    })),
    ...r.diagnostics.map((d) => ({
      ...err(`KOP_${d.code}`, `Rete ${k + 1}: ${d.code}`),
      network: k + 1,
      params: { network: String(k + 1), elemId: d.elemId, ...d.params },
    })),
  ]);
}

const defaultNewId: NewId = () => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------------------------

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** FNV-1a a 64 bit del testo (esadecimale). */
function fnv(text: string): string {
  const mask = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

const memberKey = (m: Member): unknown => [
  m.name,
  m.type,
  m.initial ?? null,
  m.overrides ?? null,
  (m.members ?? []).map(memberKey),
];

/**
 * Impronta esatta di reti (solo il sorgente), interfaccia o membri, intestazione, numero e
 * linguaggio, nomi dei membri compresi. Nome del blocco, gruppo, commenti dei membri e titoli non
 * ne fanno parte. Serve da chiave di compilazione (interfaccia) e da impronta di riserva; se un
 * blocco importato sia modificato lo decide la regola F (`fidelityState`), senza nomi né commenti.
 */
function interfaceKey(b: Block): unknown {
  const h = [b.header.author, b.header.family, b.header.headerName, b.header.version];
  let body: unknown;
  if (b.kind === 'DB') body = [b.members.map(memberKey)];
  else if (b.kind === 'IDB') body = [b.instanceOf, b.overrides];
  else {
    const i = b.interface;
    body = [
      b.language,
      [i.input, i.output, i.inOut, i.static, i.temp].map((l) => l.map(memberKey)),
      i.returnType,
    ];
  }
  return [b.kind, b.number, b.knowHowProtected, h, body];
}

/** Impronta di intestazione e interfaccia (senza le reti). */
export function interfaceHashOf(b: Block): string {
  return fnv(JSON.stringify(interfaceKey(b)));
}

export function sourceHashOf(b: Block): string {
  // Un segmento KOP conta per il suo grafico (la sorgente generata ne deriva); gli altri come prima.
  const nets =
    b.kind === 'DB' || b.kind === 'IDB'
      ? []
      : b.networks.map((n) => (isGraphic(b.language) && n.lad ? [n.lad] : n.source));
  return fnv(JSON.stringify([interfaceKey(b), nets]));
}

const err = (code: string, message: string): Mc7Diagnostic => ({
  severity: 'error',
  code,
  network: 0,
  line: 0,
  message,
});
const warn = (code: string, message: string): Mc7Diagnostic => ({
  severity: 'warning',
  code,
  network: 0,
  line: 0,
  message,
});

// ---------------------------------------------------------------------------------------------
// Compilazione
// ---------------------------------------------------------------------------------------------

const SECTION_KEYS = ['input', 'output', 'inOut', 'static', 'temp'] as const;
const LEAF_KINDS = new Set(['elementary', 'string', 'dateAndTime']);

/**
 * Valori iniziali per percorso (`a.b`) dai membri: scendono negli STRUCT, negli UDT (anche in
 * ARRAY) e nelle multi-istanze (valori iniziali dell'FB, poi i valori sostituiti del membro).
 */
function collectInitials(
  device: PlcDevice,
  members: Member[],
  prefix: string,
  out: Record<string, string>,
  depth = 0,
  sfb?: SfbInitials,
): void {
  if (depth > 8) return;
  for (const m of members) {
    const path = prefix === '' ? m.name : `${prefix}.${m.name}`;
    const parsed = parseType(m.type);
    if (!parsed.ok) continue;
    let base: DataType = parsed.type;
    while (base.kind === 'array') base = base.element;
    const isArray = parsed.type.kind === 'array';
    if (
      m.initial !== undefined &&
      m.initial.trim() !== '' &&
      (LEAF_KINDS.has(base.kind) || isArray)
    ) {
      out[path] = m.initial;
    }
    if (base.kind === 'struct') {
      collectInitials(device, m.members ?? [], path, out, depth + 1, sfb);
    } else if (base.kind === 'named') {
      const typeName = base.name;
      const udt = device.udts.find((u) => sameName(u.name, typeName));
      if (udt) collectInitials(device, udt.members, path, out, depth + 1, sfb);
      else {
        const fb = device.blocks.find((b) => b.kind === 'FB' && sameName(b.name, typeName));
        if (fb && fb.kind === 'FB') {
          for (const k of ['input', 'output', 'inOut', 'static'] as const) {
            collectInitials(device, fb.interface[k], path, out, depth + 1, sfb);
          }
        } else {
          // Multi-istanza di SFB: i valori iniziali delle statiche del campione reale
          const sample = sfb?.of(typeName, depth);
          for (const [k, v] of Object.entries(sample?.initials ?? {})) out[`${path}.${k}`] = v;
          if (sample && Object.keys(sample.initials).length > 0) sfb!.used.add(sample.sample);
        }
        for (const [k, v] of Object.entries(m.overrides ?? {})) out[`${path}.${k}`] = v;
      }
    }
  }
}

type Sections = Record<SsbSection, TypedMember[]>;

function sectionsOf(b: CodeBlock): Sections {
  const i = b.interface;
  const ret: TypedMember[] = [];
  if (i.returnType !== '' && i.returnType.toLowerCase() !== 'void') {
    const t = parseType(i.returnType);
    if (t.ok) ret.push({ name: 'RET_VAL', type: t.type });
  }
  return {
    in: toTypedMembers(i.input),
    out: toTypedMembers(i.output),
    inOut: toTypedMembers(i.inOut),
    stat: toTypedMembers(i.static),
    temp: toTypedMembers(i.temp),
    ret,
  };
}

const noSections = (over: Partial<Sections> = {}): Sections => ({
  in: [],
  out: [],
  inOut: [],
  stat: [],
  temp: [],
  ret: [],
  ...over,
});

type Fb = {
  input: TypedMember[];
  output: TypedMember[];
  inOut: TypedMember[];
  static: TypedMember[];
};

/**
 * Strutture delle multi-istanze del blocco importato lette dal suo SSB originale: servono quando
 * l'FB/SFB della multi-istanza non è nel progetto né nel catalogo (es. SFB14 in FB80).
 */
function multiInstanceTypes(ssb: Uint8Array): Map<string, Fb> {
  const out = new Map<string, Fb>();
  const typeOf = (e: SsbElement): DataType | undefined => {
    const t = e.type;
    if (t.kind === 'raw') return undefined;
    if (t.kind === 'struct') {
      const names = generatedNames(e.children ?? []);
      const members: TypedMember[] = [];
      for (const [i, k] of (e.children ?? []).entries()) {
        const mt = typeOf(k);
        if (mt) members.push({ name: names[i]!, type: mt });
      }
      return { kind: 'struct', members };
    }
    if (t.kind === 'array') {
      const el = e.children?.[0] && typeOf(e.children[0]);
      return el ? { kind: 'array', dims: t.dims, element: el } : undefined;
    }
    if (t.kind === 'named') {
      const inner = e.children?.[0]?.children ?? [];
      const names = generatedNames(inner);
      const f: Fb = { input: [], output: [], inOut: [], static: [] };
      inner.forEach((k, i) => {
        const mt = typeOf(k);
        const field =
          k.section === 'in'
            ? 'input'
            : k.section === 'out'
              ? 'output'
              : k.section === 'inOut'
                ? 'inOut'
                : 'static';
        if (mt) f[field].push({ name: names[i]!, type: mt });
      });
      out.set(t.name, f);
    }
    return t;
  };
  try {
    for (const e of readSsb(ssb, 'FB').elements) typeOf(e);
  } catch {
    /* SSB illeggibile: nessun tipo in più */
  }
  return out;
}

/** Contesto AWL del blocco, con le strutture delle multi-istanze lette dal suo SSB originale. */
function codeContext(block: Block, device: PlcDevice, cpu: CpuType | undefined): AwlContext {
  const ctx = createAwlContext(device, block.id, cpu);
  if (block.kind !== 'DB' && block.kind !== 'IDB' && block.mc7?.ssbRaw) {
    const extra = multiInstanceTypes(fromHex(block.mc7.ssbRaw));
    const resolve = ctx.resolve;
    ctx.resolve = (name) => {
      const found = resolve(name);
      if (found) return found;
      const f = extra.get(name);
      return f ? { kind: 'fb', sections: f } : null;
    };
  }
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Strutture reali degli SFB
// ---------------------------------------------------------------------------------------------
//
// Il catalogo dà degli SFB solo i parametri e le statiche documentate, ma le istanze reali hanno
// dati statici interni in più (SFB14 in FB3004): come struttura dell'istanza non vale. Per un
// layout si usa solo una struttura reale, letta da un SSB importato (regola S):
// - la multi-istanza `SFBn` nell'SSB originale di un FB importato (a ogni profondità);
// - un DB importato col numero n nei byte 1–2 dell'SSB, che un blocco dello stesso lotto usa come
//   istanza in `CALL SFB n, DB m` (da qui anche genere e numero per un nuovo DB di istanza).
// Una tabella per dispositivo: esempi di forma diversa, o che non tornano coi parametri del
// catalogo, rendono l'SFB sconosciuto. L'SSB del blocco stesso vale prima della tabella solo per
// le sue multi-istanze dirette (profondità 0); gli FB annidati passano dalla tabella.

interface LearnedSfb {
  /** Sezioni dell'istanza reale. */
  sections: FbSections;
  /** Forma del layout, per riconoscere esempi discordanti. */
  shape: string;
  /** I primi tre byte dell'SSB di un DB di istanza reale (genere e numero), se visto. */
  ssbHeader?: Uint8Array;
  /** Valori iniziali delle statiche del campione (percorso → letterale); undefined se non rappresentabili. */
  initials: Record<string, string> | undefined;
  /** Il blocco da cui vengono i valori iniziali. */
  sample: string;
  /** Il campione è un DB di istanza (preferito per i valori iniziali). */
  fromDb: boolean;
  /** Esempi discordanti, o che non tornano col catalogo: nessuna struttura affidabile. */
  conflict: boolean;
}

/** Valori iniziali delle statiche reali di un SFB (percorso → letterale), o undefined se non si scrivono. */
function staticInitials(stat: SsbElement[], names: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let ok = true;
  const walk = (e: SsbElement, path: string): void => {
    const t = e.type;
    if (t.kind === 'struct') {
      const kids = e.children ?? [];
      const nm = generatedNames(kids);
      kids.forEach((k, j) => walk(k, `${path}.${nm[j]}`));
      return;
    }
    if (!e.initial) return;
    if (t.kind === 'raw' || t.kind === 'array' || t.kind === 'named' || t.kind === 'void') {
      ok = false;
      return;
    }
    const lit = initialLiteral(t, e.initial);
    if (lit === undefined) ok = false;
    else out[path] = lit;
  };
  stat.forEach((e, i) => walk(e, names[i]!));
  return ok ? out : undefined;
}

/** Struttura di un'istanza di SFB n da righe SSB reali, o undefined se non si legge o non torna. */
function sfbFromElements(
  n: number,
  elements: SsbElement[],
):
  | { sections: FbSections; shape: string; initials: Record<string, string> | undefined }
  | undefined {
  const iface: SsbInterface = { header: INSTANCE_HEAD, elements, tail: new Uint8Array(0) };
  const layout = tryLayout(() => iface);
  if (!layout) return undefined;
  let s: Sections;
  try {
    s = sectionsFromSsb(iface).sections;
  } catch {
    return undefined;
  }
  const sys = findSystemBlock({ kind: 'SFB', number: n });
  const named = (
    real: TypedMember[],
    doc: TypedMember[] | undefined,
  ): TypedMember[] | undefined => {
    if (!doc) return real;
    if (doc.length !== real.length) return undefined;
    if (doc.some((d, i) => typeKey(d.type) !== typeKey(real[i]!.type))) return undefined;
    return doc.map((d, i) => ({ name: d.name, type: real[i]!.type }));
  };
  const input = named(s.in, sys?.input);
  const output = named(s.out, sys?.output);
  const inOut = named(s.inOut, sys?.inOut);
  if (!input || !output || !inOut) return undefined;
  const docStatic = sys?.static;
  const statics =
    docStatic && docStatic.length === s.stat.length ? (named(s.stat, docStatic) ?? s.stat) : s.stat;
  const statEls = elements.filter((e) => e.section === 'stat');
  return {
    sections: { input, output, inOut, static: statics },
    shape: shapeKey(layout),
    initials: staticInitials(
      statEls,
      statics.map((m) => m.name),
    ),
  };
}

/** Le multi-istanze `SFBn` di righe SSB, con la profondità (0 = membro diretto). */
function sfbEmbeds(els: SsbElement[], out: [number, SsbElement[], number][], depth = 0): void {
  for (const e of els) {
    if (e.type.kind !== 'named') continue;
    const inner = e.children?.[0]?.children ?? [];
    const m = /^SFB(\d+)$/.exec(e.type.name);
    if (m) out.push([Number(m[1]), inner, depth]);
    if (depth < 16) sfbEmbeds(inner, out, depth + 1);
  }
}

/** Le multi-istanze di SFB nell'SSB originale di un FB importato (in cache per i metadati). */
const embedCache = new WeakMap<object, [number, SsbElement[], number][]>();
function ownSfbEmbeds(b: Block): [number, SsbElement[], number][] {
  const meta = b.mc7;
  if (!meta?.ssbRaw || b.kind !== 'FB') return [];
  let got = embedCache.get(meta);
  if (!got) {
    got = [];
    try {
      sfbEmbeds(readSsb(fromHex(meta.ssbRaw), 'FB').elements, got);
    } catch {
      /* SSB illeggibile: nessuna struttura */
    }
    embedCache.set(meta, got);
  }
  return got;
}

/** `CALL SFB n, DB m` del codice originale di un blocco importato: coppie [n, m]. */
const usesCache = new WeakMap<object, [number, number][]>();
function sfbInstanceUses(b: Block): [number, number][] {
  const code = b.kind === 'DB' || b.kind === 'IDB' ? undefined : b.mc7?.code;
  if (!code) return [];
  let got = usesCache.get(code);
  if (!got) {
    got = [];
    for (const text of code.networkTexts) {
      for (const st of parseNetwork(text, 'international').statements) {
        const op = st.operand;
        const db = st.instanceDb;
        if (st.instruction.def?.id !== 'CALL' || op?.kind !== 'block' || db?.kind !== 'block')
          continue;
        if (op.blockKind === 'SFB' && db.blockKind === 'DB') got.push([op.number, db.number]);
      }
    }
    usesCache.set(code, got);
  }
  return got;
}

/** Intestazione (7 byte) dell'SSB originale di un DB importato, se si legge. */
function dbSsbHead(b: Block): Uint8Array | undefined {
  if ((b.kind !== 'DB' && b.kind !== 'IDB') || !b.mc7?.ssbRaw) return undefined;
  const raw = fromHex(b.mc7.ssbRaw);
  return raw.length >= 7 ? raw.subarray(0, 7) : undefined;
}

/**
 * I DB del lotto che un blocco dello stesso lotto usa come istanza di SFB n (`CALL SFB n, DB m`),
 * col numero n nei byte 1–2 del loro SSB (e un genere che non è quello dei DB globali). Il lotto
 * di un blocco è `batchOf` (all'importazione anche i doppioni identici saltati ne fanno parte).
 */
function sfbInstanceDbs(
  blocks: readonly Block[],
  batchOf: (b: Block) => string | undefined = (b) => b.mc7?.batch,
): Map<Block, number> {
  const out = new Map<Block, number>();
  const users = new Map<string, Set<number>>();
  for (const b of blocks) {
    const batch = batchOf(b);
    if (!batch) continue;
    for (const [n, m] of sfbInstanceUses(b)) {
      const key = `${batch}:${m}`;
      if (!users.has(key)) users.set(key, new Set());
      users.get(key)!.add(n);
    }
  }
  for (const b of blocks) {
    const head = dbSsbHead(b);
    const batch = batchOf(b);
    if (!head || !batch || head[0] === 0x05) continue;
    const sfbs = users.get(`${batch}:${b.number}`);
    const n = head[1]! | (head[2]! << 8);
    // un DB già istanza di un FB non è un esempio di SFB; uno già istanza di questo SFB sì
    if (b.kind === 'IDB' && findSystemFb(b.instanceOf)?.number !== n) continue;
    // un DB usato come istanza di SFB diversi, o con un altro numero nell'SSB, non dice nulla
    if (sfbs?.size === 1 && sfbs.has(n)) out.set(b, n);
  }
  return out;
}

/** Le strutture reali degli SFB nel dispositivo, dagli originali importati (una tabella). */
function learnedSfbs(device: PlcDevice): Map<number, LearnedSfb> {
  const out = new Map<number, LearnedSfb>();
  const add = (n: number, elements: SsbElement[], sample: string, ssbHeader?: Uint8Array) => {
    const got = sfbFromElements(n, elements);
    const prev = out.get(n);
    if (!got) {
      // un esempio che non torna col catalogo rende dubbio ogni altro
      if (prev) prev.conflict = true;
      else {
        out.set(n, {
          sections: { input: [], output: [], inOut: [], static: [] },
          shape: '',
          initials: undefined,
          sample,
          fromDb: false,
          conflict: true,
        });
      }
      return;
    }
    if (!prev) {
      out.set(n, {
        ...got,
        ...(ssbHeader ? { ssbHeader } : {}),
        sample,
        fromDb: ssbHeader !== undefined,
        conflict: false,
      });
      return;
    }
    if (prev.shape !== got.shape) prev.conflict = true;
    if (ssbHeader) {
      if (prev.ssbHeader && hexOf(prev.ssbHeader) !== hexOf(ssbHeader)) prev.conflict = true;
      prev.ssbHeader ??= ssbHeader;
      if (!prev.fromDb) {
        // i valori iniziali di un DB di istanza reale valgono prima di quelli di una multi-istanza
        prev.initials = got.initials;
        prev.sample = sample;
        prev.fromDb = true;
      }
    }
  };
  for (const b of device.blocks) for (const [n, els] of ownSfbEmbeds(b)) add(n, els, b.name);
  const dbs = sfbInstanceDbs(device.blocks);
  // DB già dimostrati istanza di un SFB (anche di un altro lotto): esempi reali
  for (const b of device.blocks) {
    const proof = b.mc7?.sfbInstance;
    const head = dbSsbHead(b);
    if (!proof || !head || head[0] === 0x05 || dbs.has(b)) continue;
    if ((head[1]! | (head[2]! << 8)) === proof.ssbNumber) dbs.set(b, proof.sfb);
  }
  for (const [db, n] of dbs) {
    try {
      const iface = readSsb(fromHex(db.mc7!.ssbRaw!), 'DB');
      add(n, iface.elements, db.name, iface.header.slice(0, 3));
    } catch {
      /* SSB illeggibile */
    }
  }
  return out;
}

/** Il numero dell'SFB di un nome di tipo (`"TON"`, `SFB14`), se non è un UDT o un FB del progetto. */
function sfbNumberOf(name: string, device: PlcDevice): number | undefined {
  if (device.udts.some((u) => sameName(u.name, name))) return undefined;
  if (device.blocks.some((b) => b.kind === 'FB' && sameName(b.name, name))) return undefined;
  const sys = findSystemFb(name);
  if (sys) return sys.number;
  const m = /^SFB(\d+)$/i.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** Le multi-istanze dirette (profondità 0) di SFB n nell'SSB originale del blocco `b`. */
function ownSfb(n: number, b: Block): LearnedSfb | undefined {
  for (const [k, els, depth] of ownSfbEmbeds(b)) {
    if (k !== n || depth !== 0) continue;
    const got = sfbFromElements(n, els);
    if (got) return { ...got, sample: b.name, fromDb: false, conflict: false };
  }
  return undefined;
}

const unknownSfb = (n: number, conflict = false): SymbolError => {
  const name = findSystemBlock({ kind: 'SFB', number: n })?.name;
  const why = conflict
    ? 'i blocchi importati ne danno strutture diverse (esempi discordanti)'
    : "la struttura reale dell'istanza (dati statici interni) non è nota, il catalogo ha solo i parametri documentati";
  return new SymbolError(
    'LAYOUT_SFB_SCONOSCIUTO',
    `SFB ${n}${name ? ` (${name})` : ''}: ${why}. Serve un blocco reale che la contenga, per esempio un kit letto dal PLC.`,
    { sfb: `SFB${n}`, ...(conflict ? { reason: 'conflict' } : {}) },
  );
};

/**
 * Il risolutore dei tipi per i layout del blocco: come quello del contesto, ma un SFB ha la sua
 * struttura reale (multi-istanza diretta nell'SSB del blocco, poi la tabella del dispositivo);
 * senza, `LAYOUT_SFB_SCONOSCIUTO` (mai la struttura del catalogo).
 */
function layoutResolverFor(b: Block, device: PlcDevice, ctx: AwlContext): TypeResolver {
  let cache: Map<number, LearnedSfb> | undefined;
  const learned = () => (cache ??= learnedSfbs(device));
  return (name) => {
    const n = sfbNumberOf(name, device);
    if (n === undefined) return ctx.resolve(name);
    const own = ownSfb(n, b);
    if (own) return { kind: 'fb', sections: own.sections };
    const l = learned().get(n);
    if (!l || l.conflict) throw unknownSfb(n, l?.conflict);
    return { kind: 'fb', sections: l.sections };
  };
}

/** Valori iniziali delle statiche reali degli SFB per `collectInitials`, e i campioni usati. */
interface SfbInitials {
  of: (
    typeName: string,
    depth: number,
  ) => { initials: Record<string, string>; sample: string } | undefined;
  used: Set<string>;
}

function sfbInitialsFor(b: Block, device: PlcDevice): SfbInitials {
  let cache: Map<number, LearnedSfb> | undefined;
  return {
    used: new Set(),
    of: (typeName, depth) => {
      const n = sfbNumberOf(typeName, device);
      if (n === undefined) return undefined;
      const l = (depth === 0 ? ownSfb(n, b) : undefined) ?? (cache ??= learnedSfbs(device)).get(n);
      if (!l || l.conflict) return undefined;
      if (!l.initials) throw unknownSfbInitials(n, l.sample);
      return { initials: l.initials, sample: l.sample };
    },
  };
}

const unknownSfbInitials = (n: number, sample: string): SymbolError =>
  new SymbolError(
    'LAYOUT_SFB_SCONOSCIUTO',
    `SFB ${n}: i valori iniziali delle statiche del campione ${sample} non si scrivono come letterali; non si azzerano.`,
    { sfb: `SFB${n}`, reason: 'initials' },
  );

interface InstanceFb {
  kind: 'FB' | 'SFB';
  number: number;
  sections: Sections;
  initials: Record<string, string>;
  /** SFB: la struttura reale è nota (altrimenti `sections` sono solo i parametri del catalogo). */
  known: boolean;
  /** SFB: la tabella ha esempi discordanti. */
  conflict?: boolean;
  /** SFB: genere e numero dell'SSB di un DB di istanza reale. */
  ssbHeader?: Uint8Array;
  /** Blocchi da cui vengono valori iniziali reali di SFB (campioni). */
  samples: Set<string>;
}

/**
 * L'FB (del progetto) o l'SFB di un DB di istanza, con i suoi valori iniziali. Per un SFB la
 * struttura è quella reale imparata dai blocchi importati (`learnedSfbs`), coi valori iniziali
 * delle statiche del campione; se non c'è, `known` è falso e le sezioni del catalogo non vanno
 * usate per un layout.
 */
function instanceFbOf(
  block: InstanceDb,
  device: PlcDevice,
  forBytes = true,
): InstanceFb | undefined {
  const fb = device.blocks.find((b) => b.kind === 'FB' && sameName(b.name, block.instanceOf));
  if (fb && fb.kind === 'FB') {
    const initials: Record<string, string> = {};
    // i valori iniziali reali degli SFB servono ai byte, non alle impronte
    const sfb = forBytes ? sfbInitialsFor(fb, device) : undefined;
    for (const k of ['input', 'output', 'inOut', 'static'] as const) {
      collectInitials(device, fb.interface[k], '', initials, 0, sfb);
    }
    const sections = sectionsOf(fb);
    const samples = sfb?.used ?? new Set<string>();
    return { kind: 'FB', number: fb.number, sections, initials, known: true, samples };
  }
  const sfb = findSystemFb(block.instanceOf);
  if (!sfb) return undefined;
  const l = learnedSfbs(device).get(sfb.number);
  const real = l && !l.conflict ? l : undefined;
  const s = real?.sections ?? {
    input: sfb.input,
    output: sfb.output,
    inOut: sfb.inOut,
    static: sfb.static ?? [],
  };
  if (forBytes && real && !real.initials) throw unknownSfbInitials(sfb.number, real.sample);
  return {
    kind: 'SFB',
    number: sfb.number,
    sections: noSections({ in: s.input, out: s.output, inOut: s.inOut, stat: s.static }),
    initials: { ...(real?.initials ?? {}) },
    known: real !== undefined,
    ...(l?.conflict ? { conflict: true } : {}),
    ...(real?.ssbHeader ? { ssbHeader: real.ssbHeader } : {}),
    samples: new Set(real && Object.keys(real.initials ?? {}).length > 0 ? [real.sample] : []),
  };
}

function compileModel(
  block: Block,
  device: PlcDevice,
  cpu: CpuType | undefined,
  now: Date,
  state: FidelityState | undefined,
): { file?: Uint8Array; diagnostics: Mc7Diagnostic[] } {
  const header = {
    author: block.header.author,
    family: block.header.family,
    name: block.header.headerName,
    version: block.header.version,
  };
  const base = {
    number: block.number,
    knowHowProtected: block.knowHowProtected,
    header,
    ctx: codeContext(block, device, cpu),
    now,
  };
  const initials: Record<string, string> = {};
  // Valori iniziali delle statiche reali degli SFB (campioni): si dicono, non si azzerano.
  let samples = new Set<string>();
  let input: CompileInput;
  let sclLines: { line: number; sclLine: number }[] | undefined;
  try {
    if (block.kind === 'DB') {
      collectInitials(device, block.members, '', initials);
      input = {
        ...base,
        kind: 'DB',
        sections: noSections({ stat: toTypedMembers(block.members) }),
        initials,
        networks: [],
      };
    } else if (block.kind === 'IDB') {
      const fb = instanceFbOf(block, device);
      if (!fb) {
        return {
          diagnostics: [
            err(
              'FB_ISTANZA_NON_TROVATO',
              `FB "${block.instanceOf}" del DB di istanza non trovato.`,
            ),
          ],
        };
      }
      if (!fb.known) throw unknownSfb(fb.number, fb.conflict);
      samples = fb.samples;
      input = {
        ...base,
        kind: 'IDB',
        sections: noSections(),
        initials: { ...block.overrides },
        networks: [],
        instanceOf: {
          kind: fb.kind,
          number: fb.number,
          sections: fb.sections,
          initials: fb.initials,
          ...(fb.ssbHeader ? { ssbHeader: fb.ssbHeader } : {}),
        },
      };
    } else {
      const sfb = sfbInitialsFor(block, device);
      for (const k of SECTION_KEYS) {
        collectInitials(device, block.interface[k], '', initials, 0, sfb);
      }
      samples = sfb.used;
      const kop = kopSources(block, device);
      const kopErrors = kopDiagnostics(kop);
      if (kopErrors.length > 0) return { diagnostics: kopErrors };
      sclLines = kop[0]?.scl?.lines;
      input = codeInput(
        block,
        base,
        initials,
        state,
        kop.map((r) => r.source),
      );
    }
  } catch (e) {
    if (!(e instanceof SymbolError)) throw e;
    return {
      diagnostics: [{ ...err(e.code, e.message), ...(e.params ? { params: e.params } : {}) }],
    };
  }
  // Layout (SSB, istanze, offset) con le strutture reali degli SFB; il controllo AWL usa ctx.
  input.layoutResolve = layoutResolverFor(block, device, base.ctx);
  const r = compileBlock(input);
  // SCL: gli errori dell'AWL generato tornano alla riga SCL che ha prodotto la riga AWL.
  const diagnostics = r.diagnostics.map((d) => {
    if (!sclLines || d.network !== 1 || d.line < 1) return d;
    const owner = sclLines.filter((l) => l.line <= d.line - 1).at(-1);
    return owner ? { ...d, line: owner.sclLine } : { ...d, line: 0 };
  });
  samples.delete(block.name);
  if (r.file && samples.size > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'VALORI_INIZIALI_DA_CAMPIONE',
      network: 0,
      line: 0,
      message: `Valori iniziali dei dati statici interni degli SFB presi dal blocco reale ${[...samples].join(', ')}.`,
      params: { sample: [...samples].join(', ') },
    });
  }
  return finishModel(block, state, r, diagnostics);
}

/** L'ingresso del compilatore per un blocco di codice (regola F per un blocco importato). */
function codeInput(
  block: CodeBlock,
  base: Pick<CompileInput, 'number' | 'knowHowProtected' | 'header' | 'ctx' | 'now'>,
  initials: Record<string, string>,
  state: FidelityState | undefined,
  sources: string[],
): CompileInput {
  let keep: Partial<CompileInput> = {};
  const code = block.mc7?.code;
  if (block.mc7 && code && state) {
    // Regola F: ogni rete sa se tiene i byte originali; header, footer e SSB solo con il layout invariato.
    keep = { codeMeta: code, fidelity: state.networks };
    if (state.layoutSame) {
      keep.headerRaw = fromHex(block.mc7.headerRaw);
      keep.footerRaw = fromHex(block.mc7.footerRaw);
      if (block.mc7.ssbRaw) keep.ssb = fromHex(block.mc7.ssbRaw);
    }
  }
  return {
    ...base,
    kind: block.kind,
    sections: sectionsOf(block),
    initials,
    networks: sources,
    ...(block.language !== 'AWL' ? { language: block.language } : {}),
    ...keep,
  };
}

/** Avvisi dopo la compilazione del modello (accessi assoluti all'istanza, valori attuali). */
function finishModel(
  block: Block,
  state: FidelityState | undefined,
  r: { file?: Uint8Array; diagnostics: Mc7Diagnostic[]; lines?: LineMapEntry[] },
  diagnostics: Mc7Diagnostic[],
): { file?: Uint8Array; diagnostics: Mc7Diagnostic[]; lines?: LineMapEntry[] } {
  if (block.kind === 'FB' && block.mc7 && state?.layoutChanged) {
    diagnostics.push(...instanceAccessWarnings(block));
  }
  if ((block.kind === 'DB' || block.kind === 'IDB') && block.mc7 && r.file) {
    const fbChanged =
      block.kind === 'IDB' &&
      state !== undefined &&
      [...state.changed].some((k) => /^S?FB/.test(k));
    diagnostics.push(
      warn(
        'VALORI_ATTUALI_PERSI',
        fbChanged
          ? "L'FB del DB di istanza è cambiato: il DB si rigenera dall'FB e usa i valori iniziali; i valori attuali sono persi."
          : `I valori attuali del ${block.kind === 'IDB' ? 'DB di istanza' : 'DB'} non sono modificabili: il file ricompilato usa i valori iniziali.`,
      ),
    );
  }
  return r.file
    ? { file: r.file, diagnostics, ...(r.lines ? { lines: r.lines } : {}) }
    : { diagnostics };
}

/** Un accesso assoluto all'area d'istanza: `DIX`/`DIB`/`DIW`/`DID n` o `[AR2,P#…]` nel DI. */
function isInstanceAccess(op: Operand | null | undefined): boolean {
  if (!op) return false;
  if (op.kind === 'address') return op.area === 'DI';
  if (op.kind === 'indirect') {
    return op.via.kind === 'register' && op.via.ar === 2 && (op.area === 'DI' || op.area === null);
  }
  return false;
}

/**
 * Regola F, avviso: la rete di un FB importato si ricompila dal testo com'è scritto. Se il testo
 * accede in modo assoluto all'area d'istanza e il layout dell'FB è cambiato, quegli offset non
 * seguono i membri spostati: `ACCESSO_ASSOLUTO_ISTANZA`, uno per rete (alla prima riga).
 */
function instanceAccessWarnings(block: CodeBlock): Mc7Diagnostic[] {
  const out: Mc7Diagnostic[] = [];
  block.networks.forEach((n, k) => {
    const parsed = parseNetwork(n.source, 'international');
    const hit = parsed.statements.find(
      (st) =>
        isInstanceAccess(st.operand) ||
        isInstanceAccess(st.instanceDb) ||
        (st.params ?? []).some((x) => isInstanceAccess(x.value)),
    );
    if (!hit) return;
    out.push({
      severity: 'warning',
      code: 'ACCESSO_ASSOLUTO_ISTANZA',
      network: k + 1,
      line: hit.range.from.line + 1,
      message: `Rete ${k + 1}: l'interfaccia è cambiata: gli accessi assoluti all'area d'istanza non seguono i nuovi offset, verificarli.`,
      params: { network: String(k + 1) },
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Regola F: la fedeltà per rete richiede un contesto dei byte invariato
// ---------------------------------------------------------------------------------------------
//
// Un blocco importato si esporta coi byte originali, e una sua rete li tiene, solo se ciò che
// arriva ai byte non è cambiato. Il confronto usa proiezioni senza nomi né commenti:
// - layout (`layoutFingerprint`): l'SSB che il compilatore costruirebbe dal modello;
// - reti (`analyzeNetwork`): le istruzioni come AST senza commenti, i nomi dell'interfaccia del
//   blocco e i parametri delle CALL per posizione, i segnaposto grezzi compresi;
// - dipendenze: l'impronta del layout di ogni chiamato (per tipo e numero), null se assente.
// Le impronte dell'importazione stanno in `Mc7Meta.fidelity`; senza (metadati vecchi) il blocco
// conta come modificato e nessuna rete tiene i byte.

const CALLABLE = new Set(['FC', 'FB', 'SFC', 'SFB']);
const RAW_LINE = /^\s*\/\/\s*MC7 grezzo:(.*)$/;
const normHex = (s: string): string => s.trim().toLowerCase().split(/\s+/).join(' ');
const nameKey = (s: string): string => s.normalize('NFC').toLowerCase();
const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Forma dei membri senza nomi né commenti (impronta di riserva se l'SSB non si costruisce). */
const shapeOf = (m: Member): unknown => [
  m.type,
  m.initial ?? null,
  m.overrides ?? null,
  (m.members ?? []).map(shapeOf),
];

/**
 * Impronta del layout: l'SSB che il compilatore costruirebbe (sezioni, ordine, tipi con limiti
 * degli ARRAY, STRUCT, UDT e multi-istanze risolti, dimensioni, valori iniziali; niente nomi), con
 * tipo, numero e know-how del blocco. DB di istanza: l'SSB dell'FB e quello coi valori del DB.
 */
function layoutFingerprint(b: Block, device: PlcDevice): string {
  const head: unknown[] = [b.kind, b.number, b.knowHowProtected];
  try {
    // Impronta, non byte: un SFB vale per la sua identità (la struttura reale è del firmware e
    // non cambia; cambia solo ciò che ne sappiamo, che qui non deve rendere modificato un blocco).
    const tools = toolsOf(codeContext(b, device, undefined));
    const initials: Record<string, string> = {};
    let ssb: string[];
    if (b.kind === 'DB') {
      collectInitials(device, b.members, '', initials);
      const stat = toTypedMembers(b.members);
      ssb = [hexOf(buildSsb(noSections({ stat }), initials, 'DB', { ...tools, number: b.number }))];
    } else if (b.kind === 'IDB') {
      const sfb = device.blocks.some((x) => x.kind === 'FB' && sameName(x.name, b.instanceOf))
        ? undefined
        : findSystemFb(b.instanceOf);
      if (sfb) return fnv(JSON.stringify([...head, 'SFB', sfb.number, b.overrides]));
      const fb = instanceFbOf(b, device, false);
      if (!fb) throw new Error('FB del DB di istanza assente');
      head.push(fb.kind, fb.number);
      const opts = { ...tools, genre: 0x0a, number: fb.number };
      ssb = [
        hexOf(buildSsb(fb.sections, fb.initials, 'FB', opts)),
        hexOf(buildSsb(fb.sections, { ...fb.initials, ...b.overrides }, 'FB', opts)),
      ];
    } else {
      for (const k of SECTION_KEYS) collectInitials(device, b.interface[k], '', initials);
      const number = b.kind === 'OB' || b.knowHowProtected ? 0 : b.number;
      ssb = [hexOf(buildSsb(sectionsOf(b), initials, b.kind, { ...tools, number }))];
    }
    return fnv(JSON.stringify([...head, ssb]));
  } catch {
    const body =
      b.kind === 'DB'
        ? b.members.map(shapeOf)
        : b.kind === 'IDB'
          ? b.overrides
          : [...SECTION_KEYS.map((k) => b.interface[k].map(shapeOf)), b.interface.returnType];
    return fnv(JSON.stringify([...head, 'senza layout', body]));
  }
}

/** Dell'originale di un blocco importato: SSB, lunghezza dei dati o del codice, numero dell'header. */
const originCache = new WeakMap<object, unknown>();
function originOf(b: Block): unknown {
  const meta = b.mc7;
  if (!meta) return null;
  let got = originCache.get(meta);
  if (got === undefined) {
    try {
      const f = readBlockFile(fromHex(meta.original));
      got = [hexOf(f.ssb), f.mc7.length, f.header.number];
    } catch {
      got = ['illeggibile', meta.original.length];
    }
    originCache.set(meta, got);
  }
  return got;
}

/**
 * Impronta di una dipendenza; null se non c'è:
 * - `FC20`, `FB10`, `SFC20`, `SFB4`: il layout del chiamato;
 * - `DB11` (DB di istanza di una CALL o di un `OPN DI`): tipo del DB, FB di cui è l'istanza e
 *   layout di quell'FB; per un DB importato anche SSB, lunghezza e numero dell'originale (un DB
 *   cancellato, sostituito o di sola lettura cambia l'impronta).
 */
function depFingerprint(key: string, device: PlcDevice): string | null {
  const m = /^(FC|FB|SFC|SFB|DB)(\d+)$/.exec(key);
  if (!m) return null;
  const number = Number(m[2]);
  if (m[1] === 'DB') {
    const db = device.blocks.find(
      (x) => (x.kind === 'DB' || x.kind === 'IDB') && x.number === number,
    );
    if (!db) return null;
    if (db.kind !== 'IDB') {
      return fnv(JSON.stringify(['DB', originOf(db), layoutFingerprint(db, device)]));
    }
    let fb: InstanceFb | undefined;
    try {
      fb = instanceFbOf(db, device, false);
    } catch {
      fb = undefined;
    }
    const fp = fb ? depFingerprint(`${fb.kind}${fb.number}`, device) : null;
    return fnv(JSON.stringify(['IDB', fb?.kind ?? null, fb?.number ?? null, fp, originOf(db)]));
  }
  if (m[1] === 'FC' || m[1] === 'FB') {
    const b = device.blocks.find((x) => x.kind === m[1] && x.number === number);
    return b ? layoutFingerprint(b, device) : null;
  }
  const sys = findSystemBlock({ kind: m[1] as 'SFC' | 'SFB', number });
  return sys ? fnv(JSON.stringify(systemSections(sys))) : null;
}

interface ParamLists {
  input: TypedMember[];
  output: TypedMember[];
  inOut: TypedMember[];
}

interface Projector {
  /** `#nome` del blocco (minuscolo) → posizione (`in:0`, `stat:2`, `ret`). */
  local: Map<string, string>;
  /** Tipo dei membri del blocco per nome (multi-istanze). */
  types: Map<string, DataType>;
  ctx: AwlContext;
}

function projectorOf(b: CodeBlock, ctx: AwlContext): Projector {
  const local = new Map<string, string>();
  const types = new Map<string, DataType>();
  const sections = [
    ['in', b.interface.input],
    ['out', b.interface.output],
    ['inOut', b.interface.inOut],
    ['stat', b.interface.static],
    ['temp', b.interface.temp],
  ] as const;
  for (const [sec, list] of sections) {
    list.forEach((m, i) => {
      const k = nameKey(m.name);
      if (local.has(k)) return;
      local.set(k, `${sec}:${i}`);
      const t = toTypedMembers([m])[0];
      if (t) types.set(k, t.type);
    });
  }
  const ret = b.interface.returnType;
  if (b.kind === 'FC' && ret !== '' && ret.toLowerCase() !== 'void') local.set('ret_val', 'ret');
  return { local, types, ctx };
}

/** Il membro `name` dentro il tipo `t` (STRUCT, UDT, FB di una multi-istanza), per posizione. */
function memberAt(
  t: DataType | undefined,
  name: string,
  p: Projector,
): { id: string; type: DataType } | undefined {
  const pick = (list: TypedMember[], tag: string) => {
    const at = list.findIndex((m) => sameName(m.name, name));
    return at >= 0 ? { id: `${tag}${at}`, type: list[at]!.type } : undefined;
  };
  if (t?.kind === 'struct') return pick(t.members, '.');
  if (t?.kind !== 'named') return undefined;
  const found = p.ctx.resolve(t.name);
  if (found?.kind === 'udt') return pick(found.members, '.');
  if (found?.kind !== 'fb') return undefined;
  const s = found.sections;
  return (
    pick(s.input, 'in:') ??
    pick(s.output, 'out:') ??
    pick(s.inOut, 'inOut:') ??
    pick(s.static, 'stat:')
  );
}

/**
 * Percorso di un locale per posizione: la radice nell'interfaccia del blocco, ogni membro interno
 * nel suo tipo risolto (STRUCT, UDT, multi-istanza; un indice passa all'elemento dell'ARRAY). Un
 * nome che non si risolve resta com'è.
 */
function localPath(path: readonly { name: string; index?: number[] }[], p: Projector): unknown {
  let t: DataType | undefined;
  return path.map((seg, i) => {
    let id: string;
    if (i === 0) {
      id = p.local.get(nameKey(seg.name)) ?? `?${seg.name}`;
      t = p.types.get(nameKey(seg.name));
    } else {
      const m = memberAt(t, seg.name, p);
      id = m?.id ?? `?${seg.name}`;
      t = m?.type;
    }
    if (seg.index && t?.kind === 'array') t = t.element;
    return [id, seg.index ?? null];
  });
}

/** Un operando senza posizioni nel testo, coi locali per posizione. */
function canon(o: unknown, p: Projector): unknown {
  if (Array.isArray(o)) return o.map((x) => canon(x, p));
  if (!o || typeof o !== 'object') return o ?? null;
  const r = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k !== 'range' && k !== 'nameRange') out[k] = canon(v, p);
  }
  if (r.kind === 'local' && Array.isArray(r.path)) out.path = localPath(r.path, p);
  if (r.kind === 'constant' && Array.isArray(r.pointerTo))
    out.pointerTo = localPath(r.pointerTo, p);
  return out;
}

/** Interfaccia del blocco chiamato da una CALL (per i nomi dei parametri). */
function calleeParams(st: Statement, p: Projector): ParamLists | undefined {
  const op = st.operand;
  if (op?.kind === 'block' && CALLABLE.has(op.blockKind)) {
    return p.ctx.block({ kind: op.blockKind as 'FC' | 'FB' | 'SFC' | 'SFB', number: op.number })
      ?.iface;
  }
  if (op?.kind === 'symbol' && op.path.length === 1) return p.ctx.block(op.path[0]!)?.iface;
  if (op?.kind === 'local' && op.path.length === 1) {
    const t = p.types.get(nameKey(op.path[0]!.name));
    const found = t?.kind === 'named' ? p.ctx.resolve(t.name) : null;
    return found?.kind === 'fb' ? found.sections : undefined;
  }
  return undefined;
}

/** Il parametro di una CALL per posizione nel chiamato (`i0`, `o1`, `x0`, `r`). */
function paramId(lists: ParamLists | undefined, name: string): string {
  if (lists) {
    for (const [tag, list] of [
      ['i', lists.input],
      ['o', lists.output],
      ['x', lists.inOut],
    ] as const) {
      const at = list.findIndex((m) => sameName(m.name, name));
      if (at >= 0) return `${tag}${at}`;
    }
  }
  return sameName(name, 'RET_VAL') ? 'r' : `?${name}`;
}

/** Il DB `DB11` di un operando (`%DB11`, `%DI11`, `"Motore_DB"`), se è un DB del progetto o un numero. */
function dbRefOf(op: Operand | null | undefined, p: Projector): string | undefined {
  if (op?.kind === 'block' && (op.blockKind === 'DB' || op.blockKind === 'DI')) {
    return `DB${op.number}`;
  }
  if (op?.kind === 'symbol' && op.path.length === 1) {
    const b = p.ctx.block(op.path[0]!);
    return b && (b.kind === 'DB' || b.kind === 'IDB') ? `DB${b.number}` : undefined;
  }
  return undefined;
}

/**
 * Le dipendenze di un'istruzione: il chiamato di CALL, UC o CC e il DB di istanza di una CALL
 * (`CALL FB10, DB11`) o di un `OPN DI` (CALL di FB espansa nel testo).
 */
function refsOf(st: Statement, p: Projector): string[] {
  const out: string[] = [];
  const t = targetOf(st, p);
  if (t) out.push(t);
  const id = st.instruction.def?.id;
  const db =
    id === 'CALL'
      ? dbRefOf(st.instanceDb, p)
      : id === 'OPN' && st.operand?.kind === 'block' && st.operand.blockKind === 'DI'
        ? dbRefOf(st.operand, p)
        : undefined;
  if (db) out.push(db);
  return out;
}

/** Il blocco chiamato da CALL, UC o CC (`FC20`), se si sa quale. */
function targetOf(
  st: Statement | { id: string; operand?: Operand },
  p: Projector,
): string | undefined {
  const id = 'instruction' in st ? st.instruction.def?.id : st.id;
  if (id !== 'CALL' && id !== 'UC' && id !== 'CC') return undefined;
  const op = st.operand;
  if (op?.kind === 'block') {
    return CALLABLE.has(op.blockKind) ? `${op.blockKind}${op.number}` : undefined;
  }
  if (op?.kind === 'symbol' && op.path.length === 1) {
    const b = p.ctx.block(op.path[0]!);
    return b && CALLABLE.has(b.kind) ? `${b.kind}${b.number}` : undefined;
  }
  if (id === 'CALL' && op?.kind === 'local' && op.path.length === 1) {
    const t = p.types.get(nameKey(op.path[0]!.name));
    const n = t?.kind === 'named' ? toolsOf(p.ctx).blockNumber(t.name) : undefined;
    return n ? `${n.block}${n.number}` : undefined;
  }
  return undefined;
}

/** Il chiamato di un'istruzione grezza `UC`/`CC` (con la lista dei puntatori), se si legge. */
function rawTarget(hex: string, p: Projector): string | undefined {
  const parts = normHex(hex).split(' ');
  if (parts.some((x) => !/^[0-9a-f]{2}$/.test(x))) return undefined;
  try {
    const d = decodeInstruction(Uint8Array.from(parts.map((x) => parseInt(x, 16))), 0);
    return 'stmt' in d ? targetOf(d.stmt, p) : undefined;
  } catch {
    return undefined;
  }
}

interface NetworkView {
  /** Impronta della proiezione della rete. */
  hash: string;
  /** Blocchi chiamati dalla rete. */
  refs: string[];
}

/**
 * Proiezione di una rete: ciò che il codificatore legge (segnaposto grezzi e istruzioni, in ordine
 * di riga), senza commenti né posizioni, coi nomi dell'interfaccia del blocco e dei parametri dei
 * chiamati per posizione. Un testo con errori di sintassi vale com'è.
 */
function analyzeNetwork(text: string, p: Projector): NetworkView {
  const parsed = parseNetwork(text, 'international');
  if (parsed.errors.length) return { hash: fnv(`!${text}`), refs: [] };
  const items: { line: number; key: unknown }[] = [];
  const refs = new Set<string>();
  text.split(/\r?\n/).forEach((l, line) => {
    const m = RAW_LINE.exec(l);
    if (!m) return;
    items.push({ line, key: ['grezzo', normHex(m[1]!)] });
    const t = rawTarget(m[1]!, p);
    if (t) refs.add(t);
  });
  for (const st of parsed.statements) {
    const call = st.instruction.def?.id === 'CALL' ? calleeParams(st, p) : undefined;
    items.push({
      line: st.range.from.line,
      key: [
        st.label?.name ?? null,
        st.instruction.def?.id ?? st.instruction.text.toUpperCase(),
        canon(st.operand, p),
        canon(st.instanceDb, p),
        st.params?.map((x) => [paramId(call, x.name), x.arrow, canon(x.value, p)]) ?? null,
      ],
    });
    for (const r of refsOf(st, p)) refs.add(r);
  }
  items.sort((a, b) => a.line - b.line);
  return { hash: fnv(JSON.stringify(items.map((x) => x.key))), refs: [...refs].sort() };
}

interface BlockView {
  block: string;
  layout: string;
  networks: NetworkView[];
  /** Chiavi delle dipendenze (chiamati delle reti, multi-istanze, FB del DB di istanza). */
  deps: string[];
}

function viewOf(b: Block, device: PlcDevice): BlockView {
  const layout = layoutFingerprint(b, device);
  const h = [b.header.author, b.header.family, b.header.headerName, b.header.version];
  const deps = new Set<string>();
  let networks: NetworkView[] = [];
  let language: string | null = null;
  if (b.kind === 'IDB') {
    const fb = instanceFbOf(b, device);
    if (fb) deps.add(`${fb.kind}${fb.number}`);
  } else if (b.kind !== 'DB') {
    language = b.language;
    const ctx = codeContext(b, device, undefined);
    const p = projectorOf(b, ctx);
    networks = blockSources(b, device).map((text) => analyzeNetwork(text, p));
    for (const n of networks) for (const r of n.refs) deps.add(r);
    const tools = toolsOf(ctx);
    for (const m of b.interface.static) {
      const t = parseType(m.type);
      const n = t.ok && t.type.kind === 'named' ? tools.blockNumber(t.type.name) : undefined;
      if (n) deps.add(`${n.block}${n.number}`);
    }
  }
  const block = fnv(JSON.stringify([b.kind, layout, h, language, networks.map((n) => n.hash)]));
  return { block, layout, networks, deps: [...deps].sort() };
}

// ---------------------------------------------------------------------------------------------
// Regola S all'importazione: fiducia per provenienza
// ---------------------------------------------------------------------------------------------
//
// Che dei byte compilati sul PLC di un altro corrispondano a un blocco che c'è già nel progetto
// non si dimostra dai byte. Ogni dipendenza che arriva ai byte (chiamati FC/FB, DB di istanza,
// tipi delle multi-istanze) si classifica per provenienza:
// - firmware: interfaccia di chiamata di un SFC/SFB, fissata dalla CPU. Fidata;
// - lotto: un blocco della stessa importazione (un kit, i .blk di un caricamento). Fidata;
// - doppione identico: un blocco del progetto non modificato coi byte originali uguali al file del
//   lotto con lo stesso numero. Si salta (nomi e commenti restano com'erano) ma è un membro del
//   lotto: fidato per gli altri, coi controlli del lotto sui suoi byte; le sue dipendenze fuori dal
//   lotto tengono la fiducia della sua importazione se l'impronta è la stessa;
// - estranea: ogni altro blocco del progetto. Impronta `FOREIGN`, che non coincide mai: le reti che
//   la usano si ricompilano dal testo (grezzi: RAW_CONTESTO_CAMBIATO), un DB di istanza di un FB
//   estraneo è bloccato (IDB_INCOERENTE).
// Le sole verifiche sui byte confrontano due artefatti reali dello stesso lotto (conflitto di data
// e ora di STEP 7): numero dei puntatori di una chiamata contro una FC del lotto; SSB di un DB di
// istanza contro l'SSB del suo FB del lotto; multi-istanza nell'SSB di un FB contro l'SSB dell'FB
// del lotto; DB del lotto di una `CALL FB/SFB n, DB m` contro il numero n nel suo SSB. Una
// differenza è `INCOHERENT` con la nota IMPORT_CONTESTO_INCOERENTE.

/** Impronta che non coincide mai: blocco del progetto che non viene dall'importazione. */
const FOREIGN = 'estraneo';
/** Impronta che non coincide mai: due artefatti dello stesso lotto non si corrispondono. */
const INCOHERENT = 'incoerente';
/** Impronta che non coincide mai: un blocco del lotto di cui BaaPortal rifà la struttura. */
const REBUILT = 'rifatto';
const INSTANCE_HEAD = Uint8Array.of(0x0a, 0, 0, 0, 0, 0, 0);

/** Tipo di una voce del layout, senza i dettagli che il nostro SSB scrive in un altro modo. */
function typeKey(t: SsbType): string {
  switch (t.kind) {
    case 'elementary':
    case 'parameter':
    case 'named':
      return `${t.kind}:${t.name}`;
    case 'string':
      return `string:${t.length}`;
    case 'array':
      return `array:${t.dims.map((d) => `${d.lo}..${d.hi}`).join(',')}`;
    case 'raw':
      return `raw:${t.code}`;
    default:
      return t.kind;
  }
}

/** Forma di un layout: dimensione, posizioni e tipi (i percorsi generati sono posizionali). */
const shapeKey = (l: DataLayout): string =>
  JSON.stringify([
    l.size,
    l.offsets.map((o) => [o.path, o.byte, o.bit ?? null, o.strideBits ?? null, typeKey(o.type)]),
  ]);

/** Il layout, o undefined se non si legge (allora non si può dire nulla). */
function tryLayout(make: () => SsbInterface): DataLayout | undefined {
  try {
    return dataLayout(make());
  } catch {
    return undefined;
  }
}

/** Layout dell'istanza di un FB letto dal suo SSB originale (reale). */
function realInstanceLayout(fb: Block): DataLayout | undefined {
  const raw = fb.mc7?.ssbRaw;
  if (fb.kind !== 'FB' || !raw) return undefined;
  return tryLayout(() => ({
    header: INSTANCE_HEAD,
    elements: readSsb(fromHex(raw), 'FB').elements,
    tail: new Uint8Array(0),
  }));
}

const hexBytes = (h: string): Uint8Array | undefined => {
  const parts = normHex(h).split(' ');
  return parts.some((x) => !/^[0-9a-f]{2}$/.test(x))
    ? undefined
    : Uint8Array.from(parts.map((x) => parseInt(x, 16)));
};

/** Cosa sa l'importazione: i blocchi del lotto, i doppioni identici, il dispositivo di prima. */
interface ImportScope {
  /** Id dei blocchi del lotto nel dispositivo come sarà (doppioni identici saltati compresi). */
  batch: ReadonlySet<string>;
  /** Id dei doppioni identici saltati: membri del lotto che restano com'erano. */
  kept: ReadonlySet<string>;
  /** Il dispositivo prima dell'importazione. */
  before: PlcDevice;
}

type Provenance = 'firmware' | 'batch' | 'foreign' | 'absent';

/** Chiave di un blocco come dipendenza: `FC20`, `FB10`, `DB11` (DB e IDB). */
const depKeyOf = (b: Block): string => `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}`;

/** Il blocco di una chiave di dipendenza nel dispositivo. */
function blockOfKey(key: string, device: PlcDevice): Block | undefined {
  const m = /^(FC|FB|DB)(\d+)$/.exec(key);
  if (!m) return undefined;
  const n = Number(m[2]);
  return device.blocks.find(
    (x) =>
      (m[1] === 'DB' ? x.kind === 'DB' || x.kind === 'IDB' : x.kind === m[1]) && x.number === n,
  );
}

/** Provenienza di una dipendenza dell'importazione (regola S). */
function provenanceOf(key: string, future: PlcDevice, scope: ImportScope): Provenance {
  if (/^SF[BC]\d+$/.test(key)) return 'firmware';
  const b = blockOfKey(key, future);
  if (!b) return 'absent';
  return scope.batch.has(b.id) ? 'batch' : 'foreign';
}

/**
 * Il layout di un blocco nel dispositivo è ancora quello della sua importazione (multi-istanze
 * risolte comprese): l'SSB che BaaPortal emette è il suo SSB originale. Le reti non contano.
 */
function layoutKept(b: Block, device: PlcDevice): boolean {
  try {
    return fidelityState(b, device).layoutSame;
  } catch {
    return false;
  }
}

/**
 * Perché un blocco del progetto (di un'importazione precedente) cambierà struttura: la sua stessa
 * importazione l'ha segnata (multi-istanza estranea o incoerente), o il suo layout, uguale a quello
 * dell'importazione prima di questa, non lo è più dopo (questa importazione sostituisce una sua
 * multi-istanza). Undefined se non è così (allora è semplicemente estraneo).
 */
function deviceChange(b: Block, future: PlcDevice, scope: ImportScope): RebuildCause | undefined {
  const fid = savedFidelity(b);
  if (!b.mc7 || !fid) return undefined;
  if (fid.layout === FOREIGN || fid.layout === INCOHERENT || fid.layout === REBUILT) {
    return rootCause(b, future, new Map(), scope.batch);
  }
  if (!layoutKept(b, scope.before) || layoutKept(b, future)) return undefined;
  return changeCause(b, fid, future, scope.batch, true, multiInstanceKeys(b, future));
}

/**
 * Le dipendenze per cui due artefatti reali dello stesso lotto (o di un doppione identico) non si
 * corrispondono, e se il layout stesso del blocco è incoerente (multi-istanza).
 */
function batchIncoherence(
  b: Block,
  future: PlcDevice,
  trusted: (key: string) => boolean,
): { keys: string[]; layout: boolean } {
  const keys = new Set<string>();
  let layout = false;
  if (!b.mc7) return { keys: [], layout };
  const original = readBlockFile(fromHex(b.mc7.original));
  if (b.kind === 'IDB') {
    const fb = future.blocks.find((x) => x.kind === 'FB' && sameName(x.name, b.instanceOf));
    if (fb && trusted(depKeyOf(fb))) {
      const real = realInstanceLayout(fb);
      const mine = tryLayout(() => readSsb(original.ssb, 'DB'));
      if (
        real &&
        mine &&
        (shapeKey(real) !== shapeKey(mine) || original.mc7.length !== real.size)
      ) {
        keys.add(depKeyOf(fb));
      }
    }
    return { keys: [...keys], layout };
  }
  if (b.kind === 'DB') return { keys: [], layout };
  if (b.kind === 'FB') {
    let els: SsbElement[] = [];
    try {
      els = readSsb(original.ssb, 'FB').elements;
    } catch {
      /* SSB illeggibile: niente da confrontare */
    }
    for (const e of els) {
      const m = e.type.kind === 'named' ? /^FB(\d+)$/.exec(e.type.name) : null;
      if (e.section !== 'stat' || !m) continue;
      const fb = blockOfKey(`FB${m[1]}`, future);
      if (!fb || fb.id === b.id || !trusted(depKeyOf(fb))) continue;
      const real = realInstanceLayout(fb);
      const mine = tryLayout(() => ({
        header: INSTANCE_HEAD,
        elements: e.children?.[0]?.children ?? [],
        tail: new Uint8Array(0),
      }));
      if (real && mine && shapeKey(real) !== shapeKey(mine)) {
        keys.add(depKeyOf(fb));
        layout = true;
      }
    }
  }
  const code = b.mc7.code;
  if (!code) return { keys: [...keys], layout };
  // Numero dei puntatori di UC/CC contro l'interfaccia di una FC del lotto
  const checkCall = (id: string, op: Operand | undefined, pointers: number) => {
    if ((id !== 'UC' && id !== 'CC') || op?.kind !== 'block' || op.blockKind !== 'FC') return;
    const key = `FC${op.number}`;
    const fc = blockOfKey(key, future);
    if (!fc || fc.kind !== 'FC' || !trusted(key)) return;
    const s = sectionsOf(fc);
    if (pointers !== s.in.length + s.ret.length + s.out.length + s.inOut.length) keys.add(key);
  };
  const scan = (bytes: Uint8Array) => {
    for (let at = 0; at < bytes.length;) {
      const r = decodeInstruction(bytes, at);
      if ('stmt' in r) checkCall(r.stmt.id, r.stmt.operand, r.stmt.pointers?.length ?? 0);
      at += Math.max(1, r.length);
    }
  };
  for (const raw of code.raws) {
    const bytes = hexBytes(raw.bytes);
    if (bytes) scan(bytes);
  }
  for (const h of Object.values(code.calls ?? {})) {
    const bytes = hexBytes(h);
    if (bytes) scan(bytes);
  }
  let learned: Map<number, LearnedSfb> | undefined;
  for (const text of code.networkTexts) {
    for (const st of parseNetwork(text, 'international').statements) {
      const id = st.instruction.def?.id ?? '';
      // `UC FC n` nel testo: la lista dei puntatori è vuota (una lista non vuota sarebbe un grezzo)
      checkCall(id, st.operand, 0);
      // `CALL FB/SFB n, DB m` con DB m del lotto: il suo SSB reale dev'essere un'istanza di n
      const op = st.operand;
      const idb = st.instanceDb;
      if (id !== 'CALL' || op?.kind !== 'block' || idb?.kind !== 'block') continue;
      const key = `DB${idb.number}`;
      const db = blockOfKey(key, future);
      if (!db || !trusted(key)) continue;
      const head = dbSsbHead(db);
      if (!head) continue;
      // genere: 0a per un FB (mc7 §1.9), quello imparato da un DB reale per un SFB
      const genre =
        op.blockKind === 'FB'
          ? 0x0a
          : (learned ??= learnedSfbs(future)).get(op.number)?.ssbHeader?.[0];
      if (
        head[0] === 0x05 ||
        (genre !== undefined && head[0] !== genre) ||
        (head[1]! | (head[2]! << 8)) !== op.number
      ) {
        keys.add(key);
      }
    }
  }
  return { keys: [...keys], layout };
}

/**
 * Le impronte della regola F del blocco nel dispositivo: all'importazione (il dispositivo come
 * sarà dopo `applyImport`) vanno in `Mc7Meta.fidelity`.
 */
export function mc7FidelityOf(block: Block, device: PlcDevice): Mc7Fidelity {
  const v = viewOf(block, device);
  return {
    block: v.block,
    layout: v.layout,
    networks: v.networks.map((n) => n.hash),
    deps: Object.fromEntries(v.deps.map((k) => [k, depFingerprint(k, device)])),
  };
}

interface FidelityState {
  /** Da ricompilare: proiezione o dipendenze cambiate (o impronte assenti). */
  modified: boolean;
  /** Layout dell'interfaccia uguale a quello dell'importazione: header, footer e SSB originali. */
  layoutSame: boolean;
  /** Le impronte ci sono e il layout è diverso da quello dell'importazione (non: sconosciuto). */
  layoutChanged: boolean;
  /** Dipendenze con un'impronta diversa da quella dell'importazione. */
  changed: Set<string>;
  /** Per ogni rete: tiene i byte, testo modificato o contesto cambiato. */
  networks: NetworkFidelity[];
}

/** Le impronte salvate, se hanno la forma giusta (un progetto modificato a mano conta come sconosciuto). */
function savedFidelity(block: Block): Mc7Fidelity | undefined {
  const f: unknown = block.mc7?.fidelity;
  if (!f || typeof f !== 'object') return undefined;
  const x = f as Partial<Mc7Fidelity>;
  const ok =
    typeof x.block === 'string' &&
    typeof x.layout === 'string' &&
    Array.isArray(x.networks) &&
    x.networks.every((n) => typeof n === 'string') &&
    !!x.deps &&
    typeof x.deps === 'object' &&
    Object.values(x.deps).every((d) => d === null || typeof d === 'string');
  return ok ? (x as Mc7Fidelity) : undefined;
}

function fidelityState(block: Block, device: PlcDevice): FidelityState {
  const fid = savedFidelity(block);
  const v = viewOf(block, device);
  const code = block.kind === 'DB' || block.kind === 'IDB' ? [] : block.networks;
  if (!fid) {
    // Metadati senza impronte: contesto sconosciuto, nessuna rete tiene i byte.
    const texts = block.mc7?.code?.networkTexts ?? [];
    return {
      modified: true,
      layoutSame: false,
      layoutChanged: false,
      changed: new Set(),
      networks: code.map((n, k) =>
        sameText(n.source, texts[k]) ? { reason: 'unknown' } : 'changed',
      ),
    };
  }
  const changed = new Set(
    Object.entries(fid.deps)
      .filter(([k, fp]) => depFingerprint(k, device) !== fp)
      .map(([k]) => k),
  );
  const layoutSame = v.layout === fid.layout;
  const marked = (mark: string) => Object.keys(fid.deps).filter((k) => fid.deps[k] === mark);
  const causeOf = (key: string): NetworkFidelity => ({
    reason:
      fid.deps[key] === FOREIGN
        ? 'foreign'
        : fid.deps[key] === INCOHERENT
          ? 'incoherent'
          : fid.deps[key] === REBUILT
            ? 'rebuilt'
            : 'callee',
    callee: key,
  });
  const networks = v.networks.map((n, k): NetworkFidelity => {
    if (fid.networks[k] !== n.hash) return 'changed';
    if (!layoutSame) {
      // layout segnato all'importazione (multi-istanza estranea, incoerente o rifatta): la causa è quella
      const why =
        fid.layout === FOREIGN || fid.layout === INCOHERENT || fid.layout === REBUILT
          ? marked(fid.layout)[0]
          : undefined;
      return why ? causeOf(why) : { reason: 'interface' };
    }
    const hit = n.refs.find((r) => !Object.hasOwn(fid.deps, r) || changed.has(r));
    return hit ? causeOf(hit) : 'keep';
  });
  return {
    modified: v.block !== fid.block || changed.size > 0,
    layoutSame,
    layoutChanged: !layoutSame,
    changed,
    networks,
  };
}

/**
 * Il file MC7 di un blocco: i byte originali se importato e non modificato (regola F: stessa
 * proiezione e stesse impronte dei chiamati), altrimenti compilato.
 */
export function blockToMc7File(
  block: Block,
  device: PlcDevice,
  cpu: CpuType | undefined,
  now: Date = new Date(),
): { file?: Uint8Array; diagnostics: Mc7Diagnostic[]; lines?: LineMapEntry[] } {
  try {
    const state = block.mc7 ? fidelityState(block, device) : undefined;
    if (block.mc7 && state && !state.modified) {
      return { file: fromHex(block.mc7.original), diagnostics: [] };
    }
    const lock =
      block.kind === 'IDB'
        ? Object.values(savedFidelity(block)?.deps ?? {}).find(
            (v) => v === FOREIGN || v === INCOHERENT || v === REBUILT,
          )
        : undefined;
    if (block.kind === 'IDB' && lock) {
      // l'FB di cui il DB è istanza adesso (anche se instanceOf è stato cambiato)
      let fb: InstanceFb | undefined;
      try {
        fb = instanceFbOf(block, device);
      } catch {
        fb = undefined;
      }
      const current = fb ? `${fb.kind}${fb.number}` : block.instanceOf;
      const fbBlock = device.blocks.find(
        (x) => x.kind === 'FB' && sameName(x.name, block.instanceOf),
      );
      const cause = lock === REBUILT && fbBlock ? rootCause(fbBlock, device) : undefined;
      const self = fbBlock ? depKeyOf(fbBlock) : current;
      const why =
        lock === FOREIGN
          ? `l'FB ${current} ("${block.instanceOf}") del progetto non viene dall'importazione: nulla prova che i byte del DB siano stati compilati per lui`
          : lock === INCOHERENT
            ? `i byte del DB non corrispondono all'FB ${current} ("${block.instanceOf}") importato con lui`
            : `BaaPortal rifà la struttura dell'FB ${current} ("${block.instanceOf}"), quindi non è più quella dei byte del DB (${cause ? causeText(cause, self) : 'FB assente'})`;
      // la causa anche nei testi tradotti: `mc7.diag.IDB_INCOERENTE_<contesto>`
      const sub = cause ? causeContext(cause, self) : undefined;
      const context =
        lock === FOREIGN
          ? 'foreign'
          : lock === INCOHERENT
            ? 'incoherent'
            : sub
              ? `rebuilt_${sub}`
              : 'rebuilt';
      return {
        diagnostics: [
          {
            ...err(
              'IDB_INCOERENTE',
              `Il DB di istanza ${block.name} importato è bloccato: ${why}. Cancellarlo e ricrearlo come istanza dell'FB, o reimportarlo insieme a ${current}.`,
            ),
            params: {
              fb: current,
              context,
              ...(cause ? { src: cause.src, ...(cause.via ? { via: cause.via } : {}) } : {}),
            },
          },
        ],
      };
    }
    if (block.mc7 && !block.mc7.exact) {
      return {
        diagnostics: [
          err(
            'BLOCCO_IMPORTATO_NON_RICODIFICABILE',
            `Il blocco ${block.name} importato non si può ricodificare dopo le modifiche: ripristinarlo o reimportarlo.`,
          ),
        ],
      };
    }
    if (
      block.kind !== 'DB' &&
      block.kind !== 'IDB' &&
      block.language !== 'AWL' &&
      block.language !== 'SCL' &&
      !isGraphic(block.language)
    ) {
      return {
        diagnostics: [
          err(
            'LINGUAGGIO_NON_COMPILABILE',
            `Il blocco ${block.name} è in ${block.language}: linguaggio non ancora compilabile.`,
          ),
        ],
      };
    }
    return compileModel(block, device, cpu, now, state);
  } catch (e) {
    return {
      diagnostics: [
        err('INTERNAL', `Errore interno: ${e instanceof Error ? e.message : String(e)}`),
      ],
    };
  }
}

/** Compila i blocchi del dispositivo (o solo quelli di `only`, per id); un errore non ferma gli altri. */
export function compileDevice(
  device: PlcDevice,
  cpu: CpuType | undefined,
  only?: string[],
  now: Date = new Date(),
): {
  results: {
    blockId: string;
    file?: Uint8Array;
    diagnostics: Mc7Diagnostic[];
    lines?: LineMapEntry[];
  }[];
} {
  const results = device.blocks
    .filter((b) => only === undefined || only.includes(b.id))
    .map((b) => ({ blockId: b.id, ...blockToMc7File(b, device, cpu, now) }));
  return { results };
}

// ---------------------------------------------------------------------------------------------
// Importazione
// ---------------------------------------------------------------------------------------------

function systemSections(b: SystemBlock): Sections {
  const ret = b.returnType === undefined ? undefined : parseType(b.returnType);
  return noSections({
    in: b.input,
    out: b.output,
    inOut: b.inOut,
    stat: b.static ?? [],
    ret: ret?.ok && ret.type.kind !== 'void' ? [{ name: 'RET_VAL', type: ret.type }] : [],
  });
}

/**
 * Interfacce dei blocchi chiamati per la decodifica (ricostruzione delle CALL): prima gli FC/FB
 * del lotto importato (`batch`, interfaccia dell'SSB coi nomi generati, come diventeranno nel
 * progetto), poi quelli del dispositivo (nomi veri), infine SFC/SFB dal catalogo.
 */
function resolverFor(device: PlcDevice, batch: ReadonlyMap<string, SsbInterface>): ResolveCallee {
  return (kind, number): CalleeInterface | undefined => {
    if (kind === 'SFC' || kind === 'SFB') {
      const sys = findSystemBlock({ kind, number });
      return sys ? { sections: systemSections(sys) } : undefined;
    }
    const incoming = batch.get(`${kind}${number}`);
    if (incoming) {
      try {
        return { sections: sectionsFromSsb(incoming).sections };
      } catch {
        return undefined; // tipi grezzi nell'interfaccia: chiamato sconosciuto
      }
    }
    const b = device.blocks.find((x) => x.kind === kind && x.number === number);
    return b && (b.kind === 'FC' || b.kind === 'FB') ? { sections: sectionsOf(b) } : undefined;
  };
}

/** I chiamati FC/FB che la decodifica prende dal dispositivo e non dal lotto: `FB10` → nome. */
function deviceCallees(
  device: PlcDevice,
  batch: ReadonlyMap<string, SsbInterface>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of device.blocks) {
    const key = `${b.kind}${b.number}`;
    if ((b.kind === 'FC' || b.kind === 'FB') && !batch.has(key) && !out.has(key)) {
      out.set(key, b.name);
    }
  }
  return out;
}

/**
 * Le CALL ricostruite nella decodifica di `d` con l'interfaccia di un blocco del progetto (non del
 * lotto importato): i byte sono gli stessi, ma i parametri prendono i nomi di quel blocco, che
 * può essere diverso da quello per cui il chiamante è stato scritto. Una voce per chiamato.
 */
function rebuiltAgainst(d: Mc7Block, fromDevice: ReadonlyMap<string, string>): string[] {
  if (!d.meta.code?.calls || !d.networks) return [];
  const out = new Set<string>();
  for (const text of d.networks) {
    for (const st of parseNetwork(text, 'international').statements) {
      const op = st.operand;
      if (st.instruction.def?.id !== 'CALL' || op?.kind !== 'block') continue;
      const key = `${op.blockKind}${op.number}`;
      if (fromDevice.has(key)) out.add(key);
    }
  }
  return [...out].sort();
}

/** Interfacce dei blocchi chiamati note nel dispositivo (FC, FB) e nel catalogo (SFC, SFB). */
export function calleeResolver(device: PlcDevice): ResolveCallee {
  return resolverFor(device, new Map());
}

interface BuildCtx {
  newId: NewId;
  fbName: (n: number) => string;
  warnings: string[];
  /** Note di importazione con codice (vedi `ImportNote`). */
  notes: { code: ImportNote['code']; params?: Record<string, string> }[];
  /** Falso se qualcosa non si può riscrivere dai campi del modello. */
  rewritable: boolean;
}

/** Nota di importazione con un codice (testo in `mc7.diag.<codice>`), per blocco. */
export interface ImportNote {
  block: string;
  code:
    | 'BLOCCO_PROTETTO_KNOW_HOW'
    | 'CALL_RICOSTRUITA_CON_PROGETTO'
    | 'DB_GENERE_NON_GESTITO'
    | 'DB_NON_CONVERTITO'
    | 'DIPENDENZA_ESTRANEA'
    | 'DIPENDENZA_RIFATTA'
    | 'DOPPIONE_RILETTO'
    | 'IMPORT_CONTESTO_INCOERENTE';
  params?: Record<string, string>;
}

function memberOf(el: SsbElement, name: string, c: BuildCtx): Member {
  const m: Member = { id: c.newId(), name, type: 'Word', comment: '' };
  const t = el.type;
  if (t.kind === 'raw') {
    c.warnings.push(`${name}: tipo 0x${t.code.toString(16)} non riconosciuto`);
    c.rewritable = false;
    return m;
  }
  if (t.kind === 'named') {
    const isSfb = t.name.startsWith('SFB');
    const n = Number(t.name.replace(/^S?FB/, ''));
    const sys = isSfb ? findSystemBlock({ kind: 'SFB', number: n }) : undefined;
    m.type = `"${isSfb ? (sys?.name ?? t.name) : c.fbName(n)}"`;
    return m;
  }
  if (t.kind === 'struct') {
    const kids = el.children ?? [];
    const names = generatedNames(kids);
    m.type = 'Struct';
    m.members = kids.map((k, i) => memberOf(k, names[i]!, c));
    return m;
  }
  if (t.kind === 'array') {
    const inner = memberOf(el.children![0]!, name, c);
    const dims = t.dims.map((d) => `${d.lo}..${d.hi}`).join(', ');
    m.type = `Array[${dims}] of ${inner.type}`;
    if (inner.members) m.members = inner.members;
    if (el.initial) {
      c.warnings.push(`${name}: valore iniziale dell'ARRAY non importato`);
      c.rewritable = false;
    }
    return m;
  }
  m.type = formatType(t);
  if (el.initial) {
    const lit = initialLiteral(t, el.initial);
    if (lit === undefined) {
      c.warnings.push(`${name}: valore iniziale non rappresentabile`);
      c.rewritable = false;
    } else m.initial = lit;
  }
  return m;
}

const SECTION_FIELD = {
  in: 'input',
  out: 'output',
  inOut: 'inOut',
  stat: 'static',
  temp: 'temp',
} as const;

function headerOf(d: Mc7Block): BlockHeader {
  return {
    title: '',
    comment: '',
    author: d.header.author,
    family: d.header.family,
    headerName: d.header.name,
    version: d.header.version,
  };
}

const plainAttributes = (): DbAttributes => ({
  unlinked: false,
  readOnly: false,
  nonRetain: false,
});

export interface ImportContext {
  newId: NewId;
  /** Nome dell'FB con questo numero, se il dispositivo o l'importazione ne hanno uno. */
  fbName?: (n: number) => string | undefined;
  /** Numeri degli FB noti (per riconoscere un DB di istanza). */
  hasFb: (n: number) => boolean;
}

/** Nomi dei parametri formali di una FC nell'ordine dei puntatori (#PARn = posizione n). */
function formalNames(els: SsbElement[]): string[] {
  const names = generatedNames(els);
  const pick = (sec: SsbSection): string[] =>
    els.flatMap((e, i) => (e.section === sec ? [names[i]!] : []));
  const ret = els.some((e) => e.section === 'ret' && e.type.kind !== 'void') ? ['RET_VAL'] : [];
  return [...pick('in'), ...ret, ...pick('out'), ...pick('inOut')];
}

function codeBlockOf(d: Mc7Block, kind: 'OB' | 'FB' | 'FC', c: BuildCtx): CodeBlock {
  const els = d.iface.elements;
  const names = generatedNames(els);
  const iface: CodeBlock['interface'] = {
    input: [],
    output: [],
    inOut: [],
    static: [],
    temp: [],
    returnType: kind === 'FC' ? 'Void' : '',
  };
  // #PARn del testo decodificato = posizione nell'elenco IN, RET_VAL, OUT, IN_OUT (scelta documentata:
  // il testo importato usa i nomi generati; per le reti invariate si riscrive #nome -> #PARn al
  // momento della compilazione, così i byte originali restano esatti).
  const formals = formalNames(els);
  els.forEach((e, i) => {
    if (e.section === 'ret') {
      if (e.type.kind === 'raw') {
        c.warnings.push('RET_VAL: tipo non riconosciuto');
        c.rewritable = false;
      } else iface.returnType = formatType(e.type);
      return;
    }
    iface[SECTION_FIELD[e.section]].push(memberOf(e, names[i]!, c));
  });
  const rewrite = (src: string): string =>
    kind === 'FC'
      ? src.replace(/#PAR(\d+)\b/g, (whole, n: string) => {
          const f = formals[Number(n)];
          return f ? `#${f}` : whole;
        })
      : src;
  const sources = d.networks && d.networks.length > 0 ? d.networks : [''];
  return {
    id: c.newId(),
    kind,
    number: d.number,
    name: `${kind}${d.number}`,
    group: '',
    header: headerOf(d),
    knowHowProtected: d.knowHowProtected,
    language: 'AWL',
    interface: iface,
    networks: sources.map((s) => ({ id: c.newId(), title: '', comment: '', source: rewrite(s) })),
  };
}

function dbOf(d: Mc7Block, fbNumberKnown: boolean, c: BuildCtx): GlobalDb | InstanceDb {
  const base = {
    id: c.newId(),
    number: d.number,
    name: `DB${d.number}`,
    group: '',
    header: headerOf(d),
    knowHowProtected: d.knowHowProtected,
    attributes: plainAttributes(),
  };
  const genre = d.iface.header[0];
  if (d.instanceOf && fbNumberKnown) {
    return {
      ...base,
      kind: 'IDB',
      instanceOf: c.fbName(d.instanceOf.number),
      overrides: {},
    };
  }
  if (d.instanceOf) {
    c.warnings.push(`FB ${d.instanceOf.number} non presente: importato come DB globale`);
    c.rewritable = false;
  }
  if (d.iface.header.length === 0) {
    c.warnings.push('DB senza interfaccia: nessun membro importato');
    c.rewritable = false;
    return { ...base, kind: 'DB', members: [] };
  }
  if (genre !== 0x05 && genre !== 0x0a) {
    // Genere che il lettore accetta ma che il modello non sa rappresentare (es. 0x10, probabile
    // istanza di SFB): DB di sola lettura senza membri, coi byte originali.
    c.rewritable = false;
    c.notes.push({
      code: 'DB_GENERE_NON_GESTITO',
      params: { genre: `0x${(genre ?? 0).toString(16)}` },
    });
    return { ...base, kind: 'DB', members: [] };
  }
  const els = genre === 0x05 ? (d.iface.elements[0]?.children ?? []) : d.iface.elements;
  const names = generatedNames(els);
  return {
    ...base,
    kind: 'DB',
    members: els.map((e, i) => memberOf({ ...e, section: 'stat' }, names[i]!, c)),
  };
}

function decodedToBlock(
  d: Mc7Block,
  ic: ImportContext,
): { block: Block; warnings: string[]; notes: Omit<ImportNote, 'block'>[] } {
  if (d.kind === 'SFB' || d.kind === 'SFC' || d.kind === 'SDB') {
    throw new Mc7Error('UNSUPPORTED', `${d.kind}: blocco di sistema, non importato`);
  }
  const c: BuildCtx = {
    newId: ic.newId,
    fbName: (n) => ic.fbName?.(n) ?? `FB${n}`,
    warnings: [...d.warnings],
    notes: [],
    rewritable: true,
  };
  // Protezione know-how (spec): interfaccia sì, codice no; blocco bloccato, byte originali.
  const protectedCode = d.kind !== 'DB' && d.knowHowProtected;
  if (protectedCode) c.notes.push({ code: 'BLOCCO_PROTETTO_KNOW_HOW' });
  const block: Block =
    d.kind === 'DB'
      ? dbOf(d, d.instanceOf !== undefined && ic.hasFb(d.instanceOf.number), c)
      : codeBlockOf(d, d.kind, c);
  if (!d.exact) c.warnings.push('Blocco non ricodificabile al byte: importato in sola lettura');
  const meta: Mc7Meta = {
    ...d.meta,
    exact: d.exact && c.rewritable && !protectedCode,
    sourceHash: '',
    interfaceHash: '',
  };
  if (protectedCode) meta.knowHowLocked = true;
  block.mc7 = meta;
  meta.sourceHash = sourceHashOf(block);
  meta.interfaceHash = interfaceHashOf(block);
  return { block, warnings: c.warnings, notes: c.notes };
}

const fbNameIn =
  (device: PlcDevice) =>
  (n: number): string | undefined =>
    device.blocks.find((b) => b.kind === 'FB' && b.number === n)?.name;

/** Un file MC7 come blocco del progetto (non lo aggiunge). Lancia `Mc7Error` per SDB e file illeggibili. */
export function blockFromMc7(
  device: PlcDevice,
  file: Uint8Array,
  newId: NewId = defaultNewId,
  fbName: (n: number) => string | undefined = fbNameIn(device),
): { block: Block; warnings: string[]; notes: Omit<ImportNote, 'block'>[] } {
  const d = decodeBlock(file, { resolveCallee: calleeResolver(device) });
  const r = decodedToBlock(d, {
    newId,
    fbName,
    hasFb: (n) => fbName(n) !== undefined,
  });
  for (const callee of rebuiltAgainst(d, deviceCallees(device, new Map()))) {
    r.notes.push({ code: 'CALL_RICOSTRUITA_CON_PROGETTO', params: { callee } });
  }
  // Impronte nel dispositivo come sarà col blocco aggiunto (al posto di uno con lo stesso numero):
  // il lotto è il solo blocco.
  const b = r.block;
  if (b.mc7) b.mc7.batch = newId();
  const others = device.blocks.filter(
    (x) => !(classOf(x.kind) === classOf(b.kind) && x.number === b.number),
  );
  const scope: ImportScope = { batch: new Set([b.id]), kept: new Set(), before: device };
  for (const n of stampFidelity([b], { ...device, blocks: [...others, b] }, scope)) {
    r.notes.push({ code: n.code, ...(n.params ? { params: n.params } : {}) });
  }
  return r;
}

/** I tipi delle multi-istanze di un FB come dipendenze (`FB10`), nel dispositivo. */
function multiInstanceKeys(b: Block, device: PlcDevice): string[] {
  if (b.kind !== 'FB') return [];
  const out: string[] = [];
  for (const m of b.interface.static) {
    const t = parseType(m.type);
    if (!t.ok || t.type.kind !== 'named') continue;
    const name = t.type.name;
    const fb = device.blocks.find((x) => x.kind === 'FB' && sameName(x.name, name));
    if (fb) out.push(depKeyOf(fb));
  }
  return out;
}

/**
 * Regola S: le impronte dell'importazione, calcolate nel dispositivo come sarà dopo, con la
 * provenienza di ogni dipendenza (`provenanceOf`). Una dipendenza estranea ha l'impronta
 * `FOREIGN` (nota DIPENDENZA_ESTRANEA); una differenza tra due artefatti del lotto ha
 * `INCOHERENT` (nota IMPORT_CONTESTO_INCOERENTE). Un DB di istanza col suo FB estraneo o
 * incoerente resta bloccato coi suoi byte. Se le impronte non si calcolano restano assenti: il
 * blocco conta come modificato (mai byte originali fuori contesto).
 */
function stampFidelity(blocks: Block[], future: PlcDevice, scope: ImportScope): ImportNote[] {
  const notes: ImportNote[] = [];
  const fids = new Map<Block, Mc7Fidelity>();
  for (const b of blocks) {
    if (!b.mc7) continue;
    try {
      const fid = mc7FidelityOf(b, future);
      const prov = new Map<string, Provenance>();
      const of = (key: string): Provenance => {
        if (!prov.has(key)) prov.set(key, provenanceOf(key, future, scope));
        return prov.get(key)!;
      };
      const multi = multiInstanceKeys(b, future);
      const layoutDep = (k: string) =>
        multi.includes(k) || (b.kind === 'IDB' && k.startsWith('FB') && k === idbFbKey(b, future));
      // Un doppione identico saltato: una dipendenza fuori dal lotto con la stessa impronta della
      // sua importazione tiene la fiducia di allora
      const saved = scope.kept.has(b.id) ? savedFidelity(b) : undefined;
      const carried = (k: string) => saved !== undefined && saved.deps[k] === fid.deps[k];
      // Estranea, salvo una prova di layout tra due importazioni (regola 3 di A6)
      const foreign = Object.keys(fid.deps).filter(
        (k) =>
          of(k) === 'foreign' && !carried(k) && !(layoutDep(k) && crossBatchLayout(b, k, future)),
      );
      for (const k of foreign) {
        // un blocco del progetto che cambierà struttura: la causa vera, non "estraneo"
        const target = blockOfKey(k, future);
        const cause = target ? deviceChange(target, future, scope) : undefined;
        fid.deps[k] = cause ? REBUILT : FOREIGN;
        notes.push(
          cause
            ? { block: b.name, code: 'DIPENDENZA_RIFATTA', params: causeParams(k, cause) }
            : { block: b.name, code: 'DIPENDENZA_ESTRANEA', params: { dep: k } },
        );
      }
      // Una multi-istanza di un FB estraneo o rifatto: nemmeno il layout del blocco vale
      const multiBad = multi.find((k) => foreign.includes(k));
      if (multiBad) fid.layout = fid.deps[multiBad] === REBUILT ? REBUILT : FOREIGN;
      const trusted = (k: string): boolean => of(k) === 'batch';
      const bad = batchIncoherence(b, future, trusted);
      for (const k of bad.keys) {
        fid.deps[k] = INCOHERENT;
        notes.push({ block: b.name, code: 'IMPORT_CONTESTO_INCOERENTE', params: { dep: k } });
      }
      if (bad.layout) fid.layout = INCOHERENT;
      fids.set(b, fid);
    } catch {
      delete b.mc7.fidelity;
    }
  }
  // Punto fisso: un blocco del lotto di cui BaaPortal rifà la struttura (layout segnato, o senza
  // impronte) non vale più per chi ne dipende. I suoi DB di istanza si bloccano, gli FB che lo
  // contengono come multi-istanza rifanno anche loro la struttura (e così via), chi lo chiama si
  // ricompila dal testo.
  const sentinel = (v: string | null | undefined) =>
    v === FOREIGN || v === INCOHERENT || v === REBUILT;
  const rebuilt = (x: Block): boolean => {
    if (!blocks.includes(x) || !x.mc7) return false;
    const f = fids.get(x);
    return !f || sentinel(f.layout);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [b, fid] of fids) {
      const multi = multiInstanceKeys(b, future);
      for (const k of Object.keys(fid.deps)) {
        if (sentinel(fid.deps[k])) continue;
        const target = blockOfKey(k, future);
        if (!target || target.id === b.id || !rebuilt(target)) continue;
        fid.deps[k] = REBUILT;
        notes.push({
          block: b.name,
          code: 'DIPENDENZA_RIFATTA',
          params: causeParams(k, rootCause(target, future, fids, scope.batch)),
        });
        if (multi.includes(k) && !sentinel(fid.layout)) fid.layout = REBUILT;
        changed = true;
      }
    }
  }
  for (const [b, fid] of fids) {
    // Un DB di istanza non si rigenera da un FB estraneo, incoerente o rifatto: resta bloccato coi
    // suoi byte (IDB_INCOERENTE); si può cancellare e ricreare, o reimportare col suo FB.
    if (b.kind === 'IDB' && Object.values(fid.deps).some(sentinel)) b.mc7!.exact = false;
    b.mc7!.fidelity = fid;
  }
  return notes;
}

/** Chiave dell'FB di un DB di istanza nel dispositivo (`FB10`), se è un FB del progetto. */
function idbFbKey(b: InstanceDb, device: PlcDevice): string | undefined {
  const fb = device.blocks.find((x) => x.kind === 'FB' && sameName(x.name, b.instanceOf));
  return fb ? depKeyOf(fb) : undefined;
}

/**
 * Regola 3 di A6: un FB di un'importazione precedente vale per il layout di chi dipende da lui
 * (DB di istanza, multi-istanza) se il suo layout, dopo l'importazione, è ancora quello della sua
 * importazione (il layout che BaaPortal emette è quello del suo SSB originale; le reti modificate
 * non contano) e l'artefatto reale del dipendente torna con quel layout. Solo layout: i chiamati
 * delle liste dei puntatori restano estranei.
 */
function crossBatchLayout(b: Block, key: string, future: PlcDevice): boolean {
  const fb = blockOfKey(key, future);
  if (!fb || fb.kind !== 'FB' || !fb.mc7 || !b.mc7) return false;
  // il layout che BaaPortal emette per l'FB, dopo l'importazione, è il suo SSB originale
  if (!layoutKept(fb, future)) return false;
  const real = realInstanceLayout(fb);
  if (!real) return false;
  const original = readBlockFile(fromHex(b.mc7.original));
  if (b.kind === 'IDB') {
    const mine = tryLayout(() => readSsb(original.ssb, 'DB'));
    return !!mine && shapeKey(mine) === shapeKey(real) && original.mc7.length === real.size;
  }
  if (b.kind !== 'FB') return false;
  let els: SsbElement[] = [];
  try {
    els = readSsb(original.ssb, 'FB').elements;
  } catch {
    return false;
  }
  const embeds = els.filter(
    (e) => e.section === 'stat' && e.type.kind === 'named' && e.type.name === `FB${fb.number}`,
  );
  return (
    embeds.length > 0 &&
    embeds.every((e) => {
      const mine = tryLayout(() => ({
        header: INSTANCE_HEAD,
        elements: e.children?.[0]?.children ?? [],
        tail: new Uint8Array(0),
      }));
      return !!mine && shapeKey(mine) === shapeKey(real);
    })
  );
}

/**
 * Perché BaaPortal rifà la struttura di un blocco: `src` non viene dall'importazione (`foreign`),
 * non torna con lo stesso lotto (`incoherent`), cambia con questa importazione (`import`) o è
 * cambiato dopo (`changed`); `via` è il blocco che si rifà per questo.
 */
interface RebuildCause {
  kind: 'foreign' | 'incoherent' | 'import' | 'changed' | 'unknown';
  src: string;
  via?: string;
}

/**
 * Il testo della causa (italiano, anche nei messaggi del compilatore). `self` è il blocco di cui si
 * parla: se è lui a rifarsi non lo si ripete (`perché FB20 cambia con questa importazione`).
 */
function causeText(c: RebuildCause, self?: string): string {
  const who = c.via && c.via !== self ? `${c.via} si rifà ` : '';
  switch (c.kind) {
    case 'foreign':
      return `${c.src} non viene dall'importazione`;
    case 'incoherent':
      return `${c.src} non torna con lo stesso lotto`;
    case 'import':
      return `${who}perché ${c.src} cambia con questa importazione`;
    case 'changed':
      return `${who}perché ${c.src} è cambiato`;
    default:
      return `struttura di ${c.src} rifatta`;
  }
}

/**
 * Il contesto di i18next della causa (`mc7.diag.<CODICE>_<contesto>`): il tipo, con `_via` se a
 * rifarsi è un altro blocco che `self`; undefined se la causa non è nota.
 */
function causeContext(c: RebuildCause, self: string): string | undefined {
  if (c.kind === 'unknown') return undefined;
  return (c.kind === 'import' || c.kind === 'changed') && c.via && c.via !== self
    ? `${c.kind}_via`
    : c.kind;
}

/**
 * Parametri della nota DIPENDENZA_RIFATTA: `cause` (italiano) e, per i testi tradotti, `context`
 * (`mc7.diag.DIPENDENZA_RIFATTA_<contesto>`), `src` e `via`.
 */
function causeParams(dep: string, c: RebuildCause): Record<string, string> {
  const context = causeContext(c, dep);
  return {
    dep,
    cause: causeText(c, dep),
    ...(context ? { context } : {}),
    src: c.src,
    ...(c.via ? { via: c.via } : {}),
  };
}

/**
 * Una dipendenza di `b` con un'impronta diversa da quella salvata, prima fra `prefer` (le
 * multi-istanze, che fanno il layout) e fra i blocchi del lotto: `import` se è un blocco del lotto
 * (o `byImport`: il layout era invariato prima dell'importazione), altrimenti `changed`.
 */
function changeCause(
  b: Block,
  fid: Mc7Fidelity,
  device: PlcDevice,
  batch: ReadonlySet<string>,
  byImport = false,
  prefer: readonly string[] = [],
): RebuildCause {
  const changed = Object.keys(fid.deps).filter((k) => depFingerprint(k, device) !== fid.deps[k]);
  const inBatch = (k: string) => {
    const x = blockOfKey(k, device);
    return x !== undefined && batch.has(x.id);
  };
  const preferred = changed.filter((k) => prefer.includes(k));
  const k = preferred.find(inBatch) ?? preferred[0] ?? changed.find(inBatch) ?? changed[0];
  if (!k) return { kind: 'unknown', src: depKeyOf(b) };
  return { kind: byImport || inBatch(k) ? 'import' : 'changed', src: k, via: depKeyOf(b) };
}

/** La causa prima per cui BaaPortal rifà la struttura di `b` (segue le impronte). */
function rootCause(
  b: Block,
  device: PlcDevice,
  fids: ReadonlyMap<Block, Mc7Fidelity> = new Map(),
  batch: ReadonlySet<string> = new Set(),
  depth = 0,
): RebuildCause {
  const fid = fids.get(b) ?? savedFidelity(b);
  if (!fid) return { kind: 'unknown', src: depKeyOf(b) };
  // prima la dipendenza che ha segnato il layout (la multi-istanza), poi le altre
  const deps = Object.entries(fid.deps).sort(
    ([, x], [, y]) => Number(y === fid.layout) - Number(x === fid.layout),
  );
  for (const [k, v] of deps) {
    if (v === FOREIGN) return { kind: 'foreign', src: k };
    if (v === INCOHERENT) return { kind: 'incoherent', src: k };
  }
  if (depth < 16) {
    for (const [k, v] of deps) {
      if (v !== REBUILT) continue;
      const next = blockOfKey(k, device);
      if (next && next.id !== b.id) return rootCause(next, device, fids, batch, depth + 1);
    }
  }
  // nessun segno all'importazione: una dipendenza ha un'altra impronta
  return changeCause(b, fid, device, batch, false, multiInstanceKeys(b, device));
}

/**
 * Un DB del lotto usato da un blocco dello stesso lotto come istanza di SFB n (col numero n
 * nell'SSB) diventa un DB di istanza dell'SFB: così una CALL SFB n, DB m modificata non dà un falso
 * CALL_INSTANCE_WRONG. I byte originali restano (e la sola lettura, se c'era).
 */
function asSfbInstance(db: GlobalDb, n: number, batch: string): InstanceDb | undefined {
  const sys = findSystemBlock({ kind: 'SFB', number: n });
  if (!sys || !db.mc7) return undefined;
  const idb: InstanceDb = {
    id: db.id,
    kind: 'IDB',
    number: db.number,
    name: db.name,
    group: db.group,
    header: db.header,
    knowHowProtected: db.knowHowProtected,
    attributes: db.attributes,
    instanceOf: sys.name,
    overrides: {},
  };
  idb.mc7 = {
    ...db.mc7,
    sourceHash: '',
    interfaceHash: '',
    sfbInstance: { sfb: n, ssbNumber: n, batch },
  };
  idb.mc7.sourceHash = sourceHashOf(idb);
  idb.mc7.interfaceHash = interfaceHashOf(idb);
  return idb;
}

export interface ImportPlan {
  create: Block[];
  replace: { existing: Block; incoming: Block }[];
  /**
   * Blocchi del progetto coi byte uguali al file, che restano com'erano (nomi e commenti compresi):
   * l'importazione ne aggiorna solo i metadati MC7 (le impronte, la sola lettura di un DB di
   * istanza bloccato) o ne fa un DB di istanza dell'FB o dell'SFB del lotto. I byte non cambiano:
   * non serve conferma.
   */
  refresh: { existing: Block; incoming: Block }[];
  skipped: { reason: string; index: number }[];
  /** Avvisi per blocco (`<nome>: …`). */
  warnings: string[];
  /** Note con codice (blocco protetto know-how, DB di genere non gestito). */
  notes: ImportNote[];
}

const classOf = (kind: string): string => (kind === 'IDB' ? 'DB' : kind);

/** Prepara l'importazione di file MC7 nel dispositivo senza modificarlo. */
export function planImport(
  device: PlcDevice,
  files: Uint8Array[],
  newId: NewId = defaultNewId,
): ImportPlan {
  const plan: ImportPlan = {
    create: [],
    replace: [],
    refresh: [],
    skipped: [],
    warnings: [],
    notes: [],
  };
  const decoded: {
    index: number;
    d: Mc7Block;
    cls: string;
    name: string;
    existing?: Block;
    /** DB del progetto coi byte uguali, importato prima del suo FB (che è nel lotto). */
    convert?: boolean;
  }[] = [];
  const seen = new Set<string>();
  // Le interfacce di tutti gli FC/FB del lotto prima di decodificare il codice: le CALL verso un
  // chiamato del lotto, del dispositivo o del catalogo si ricostruiscono (mc7 callRebuild.ts).
  const batch = new Map<string, SsbInterface>();
  for (const f of files) {
    try {
      const r = readBlockFile(f);
      const kind = r.header.kind;
      if (kind !== 'FC' && kind !== 'FB') continue;
      const key = `${kind}${r.header.number}`;
      if (!batch.has(key)) batch.set(key, readSsb(r.ssb, kind));
    } catch {
      /* file illeggibile: lo segnala la decodifica qui sotto */
    }
  }
  const resolveCallee = resolverFor(device, batch);
  const fromDevice = deviceCallees(device, batch);
  files.forEach((f, index) => {
    try {
      const d = decodeBlock(f, { resolveCallee });
      if (d.kind === 'SFB' || d.kind === 'SFC' || d.kind === 'SDB') {
        throw new Mc7Error('UNSUPPORTED', `${d.kind}: blocco di sistema, non importato`);
      }
      const cls = d.kind;
      const key = `${cls}${d.number}`;
      if (seen.has(key)) {
        plan.skipped.push({ index, reason: `${key}: presente più volte nell'importazione` });
        return;
      }
      seen.add(key);
      decoded.push({ index, d, cls, name: key });
    } catch (e) {
      plan.skipped.push({ index, reason: e instanceof Error ? e.message : String(e) });
    }
  });
  // Nomi: i blocchi esistenti mantengono il proprio, gli altri <TIPO><n> libero.
  const namer = createNamer(symbolNames(device));
  for (const x of decoded) {
    x.existing = device.blocks.find((b) => classOf(b.kind) === x.cls && b.number === x.d.number);
    x.name = x.existing ? x.existing.name : namer(`${x.cls}${x.d.number}`);
  }
  // Doppione identico: un blocco del progetto importato coi byte uguali e non modificato resta
  // com'è (nomi e commenti compresi), anche se questa importazione sostituisce qualcosa da cui
  // dipende. Per la regola S è un membro del lotto: i suoi byte originali passano i controlli del
  // lotto (impronte calcolate su un gemello, più sotto). Non resta com'è se i byte, letti con le
  // interfacce del lotto, danno altre CALL o altri grezzi (il modello non sarebbe più il loro): si
  // reimporta. Un DB importato prima del suo FB, che ora è nel lotto, diventa sul posto il suo DB
  // di istanza.
  const batchFbs = new Set(decoded.filter((x) => x.cls === 'FB').map((x) => x.d.number));
  /** DB di istanza convertiti sul posto (regola 3 di A9), con l'indice del loro file. */
  const converted = new Map<Block, number>();
  const same: Block[] = [];
  const sameIndex = new Map<Block, number>();
  const kept = decoded.filter((x) => {
    const ex = x.existing;
    if (!ex?.mc7 || ex.mc7.original !== x.d.meta.original) return true;
    try {
      if (fidelityState(ex, device).modified) return true;
    } catch {
      return true;
    }
    if (ex.kind === 'DB' && x.d.instanceOf && batchFbs.has(x.d.instanceOf.number)) {
      x.convert = true;
      return true;
    }
    const differ = decodingDiff(ex.mc7.code, x.d.meta.code);
    if (differ.length > 0) {
      const callees = [...new Set(differ.flatMap(calleesOf))].sort();
      plan.notes.push({
        block: x.name,
        code: 'DOPPIONE_RILETTO',
        params: { dep: (callees.length > 0 ? callees : [`${x.cls}${x.d.number}`]).join(', ') },
      });
      return true;
    }
    plan.skipped.push({
      index: x.index,
      reason: `${x.name}: già nel progetto con gli stessi byte`,
    });
    same.push(ex);
    sameIndex.set(ex, x.index);
    return false;
  });
  decoded.splice(0, decoded.length, ...kept);
  const fbNames = new Map<number, string>();
  for (const b of device.blocks) if (b.kind === 'FB') fbNames.set(b.number, b.name);
  for (const x of decoded) if (x.cls === 'FB') fbNames.set(x.d.number, x.name);
  for (const x of decoded) {
    try {
      const { block, warnings, notes } = decodedToBlock(x.d, {
        newId,
        fbName: (n) => fbNames.get(n),
        hasFb: (n) => fbNames.has(n),
      });
      block.name = x.name;
      if (x.existing) {
        block.id = x.existing.id;
        block.group = x.existing.group;
      }
      for (const w of warnings) plan.warnings.push(`${x.name}: ${w}`);
      for (const n of notes) plan.notes.push({ ...n, block: x.name });
      for (const callee of rebuiltAgainst(x.d, fromDevice)) {
        plan.notes.push({
          block: x.name,
          code: 'CALL_RICOSTRUITA_CON_PROGETTO',
          params: { callee },
        });
      }
      if (x.existing && x.convert && block.kind === 'IDB' && x.existing.kind === 'DB') {
        const idb = asFbInstance(x.existing, block);
        converted.set(idb, x.index);
        plan.refresh.push({ existing: x.existing, incoming: idb });
      } else if (x.existing) plan.replace.push({ existing: x.existing, incoming: block });
      else plan.create.push(block);
    } catch (e) {
      plan.skipped.push({
        index: x.index,
        reason: `${x.name}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  plan.skipped.sort((a, b) => a.index - b.index);
  // Regola S: i blocchi di questa importazione sono un lotto.
  const batchId = newId();
  const incoming = () => [
    ...plan.create,
    ...plan.replace.map((r) => r.incoming),
    ...plan.refresh.map((r) => r.incoming),
  ];
  for (const b of incoming()) if (b.mc7) b.mc7.batch = batchId;
  // DB del lotto usati come istanza di un SFB da un blocco del lotto (anche un doppione saltato):
  // DB di istanza dell'SFB, con la prova nei metadati. Un DB che sostituisce un DB già dimostrato
  // istanza dello stesso SFB, con la stessa forma, lo resta.
  const members = new Set<Block>([...incoming(), ...same]);
  const proven = sfbInstanceDbs([...members], (b) => (members.has(b) ? batchId : undefined));
  for (const r of plan.replace) {
    const proof = r.existing.mc7?.sfbInstance;
    const head = dbSsbHead(r.incoming);
    if (!proof || !head || r.incoming.kind !== 'DB' || proven.has(r.incoming)) continue;
    const n = head[1]! | (head[2]! << 8);
    // stesso numero e stesso genere dell'SSB del DB già dimostrato
    if (head[0] === 0x05 || n !== proof.ssbNumber || head[0] !== dbSsbHead(r.existing)?.[0]) {
      continue;
    }
    const shape = (b: Block) => tryLayout(() => readSsb(fromHex(b.mc7!.ssbRaw!), 'DB'));
    const a = shape(r.incoming);
    const b = shape(r.existing);
    if (a && b && shapeKey(a) === shapeKey(b)) proven.set(r.incoming, proof.sfb);
  }
  for (const [db, n] of proven) {
    if (db.kind !== 'DB' || !members.has(db)) continue;
    const idb = asSfbInstance(db, n, batchId);
    if (!idb) continue;
    if (same.includes(db)) {
      // doppione identico non ancora dimostrato: si converte sul posto (stessi byte, stesso id)
      idb.mc7!.batch = db.mc7!.batch ?? batchId;
      plan.refresh.push({ existing: db, incoming: idb });
      plan.skipped = plan.skipped.filter((x) => x.index !== sameIndex.get(db));
      same.splice(same.indexOf(db), 1);
    }
    plan.create = plan.create.map((b) => (b === db ? idb : b));
    plan.replace = plan.replace.map((r) => (r.incoming === db ? { ...r, incoming: idb } : r));
    // non è più un DB di genere sconosciuto: è un DB di istanza dell'SFB
    plan.notes = plan.notes.filter(
      (x) => !(x.block === db.name && x.code === 'DB_GENERE_NON_GESTITO'),
    );
  }
  // DB coi valori attuali cambiati e lo stesso SSB: il modello del progetto (nomi, commenti,
  // titolo) resta, cambiano solo i metadati MC7 coi byte nuovi
  plan.replace = plan.replace.map((r) => {
    const keep = keptDbModel(r.existing, r.incoming, device);
    return keep ? { ...r, incoming: keep } : r;
  });
  // I doppioni identici nel lotto: un gemello coi metadati copiati, perché le impronte si
  // calcolano senza toccare il dispositivo. Se cambiano (una dipendenza del lotto con un'altra
  // impronta, un'incoerenza, una dipendenza rifatta) si aggiornano solo i metadati.
  const stampAll = () => {
    const replaced = new Map(
      [...plan.replace, ...plan.refresh].map((r) => [r.existing.id, r.incoming]),
    );
    const twins = new Map(same.map((b) => [b.id, { ...b, mc7: structuredClone(b.mc7!) } as Block]));
    const stamped = [...incoming(), ...twins.values()];
    const future: PlcDevice = {
      ...device,
      blocks: [
        ...device.blocks.map((b) => replaced.get(b.id) ?? twins.get(b.id) ?? b),
        ...plan.create,
      ],
    };
    const batch = new Set(stamped.map((b) => b.id));
    const notes = stampFidelity(stamped, future, {
      batch,
      kept: new Set(twins.keys()),
      before: device,
    });
    return { twins, future, batch, notes };
  };
  // Un DB convertito sul posto che verrebbe bloccato (il suo FB nel lotto non torna coi suoi byte o
  // si rifà) non si converte: resta il DB globale coi suoi byte, con una nota che dice perché. Le
  // impronte si rifanno senza la conversione.
  const snapshot = new Map(incoming().map((b) => [b, structuredClone(b.mc7)]));
  let pass = stampAll();
  const keptRefresh = plan.refresh.filter((r) => {
    const why = converted.has(r.incoming)
      ? lockedConversion(r.incoming, pass.future, pass.batch)
      : undefined;
    if (!why) return true;
    plan.notes.push({ block: r.existing.name, code: 'DB_NON_CONVERTITO', params: why });
    same.push(r.existing);
    sameIndex.set(r.existing, converted.get(r.incoming)!);
    plan.skipped.push({
      index: converted.get(r.incoming)!,
      reason: `${r.existing.name}: già nel progetto con gli stessi byte`,
    });
    return false;
  });
  if (keptRefresh.length !== plan.refresh.length) {
    plan.refresh = keptRefresh;
    plan.skipped.sort((a, b) => a.index - b.index);
    for (const [b, mc7] of snapshot) b.mc7 = mc7;
    pass = stampAll();
  }
  const { twins, notes } = pass;
  plan.notes.push(...notes);
  for (const ex of same) {
    const twin = twins.get(ex.id)!;
    const mc7 = twin.mc7!;
    if (stableJson(mc7.fidelity) === stableJson(ex.mc7!.fidelity) && mc7.exact === ex.mc7!.exact) {
      continue;
    }
    // non più saltato: se ne aggiornano i metadati
    plan.refresh.push({ existing: ex, incoming: twin });
    plan.skipped = plan.skipped.filter((x) => x.index !== sameIndex.get(ex));
  }
  return plan;
}

/**
 * Le sequenze per cui il modello del blocco del progetto non è più quello dei byte letti con le
 * interfacce del lotto (`old` la decodifica salvata, `now` quella nuova; esadecimale): una CALL
 * ricostruita di prima che ora non lo è, o un grezzo nuovo. Un grezzo di prima che ora è una CALL
 * non conta: le righe grezze sono esatte al byte. Le CALL si confrontano per rete e byte (l'indice
 * dell'istruzione cambia se un grezzo prima di loro diventa una CALL).
 */
function decodingDiff(old: Mc7Meta['code'], now: Mc7Meta['code']): string[] {
  const calls = (c: Mc7Meta['code']) =>
    Object.entries(c?.calls ?? {}).map(([k, v]) => [`${k.split(':')[0]} ${v}`, v] as const);
  const raws = (c: Mc7Meta['code']) =>
    (c?.raws ?? []).map((r) => [`${r.network}:${r.offset} ${r.bytes}`, r.bytes] as const);
  /** Le voci di `a` che mancano in `b` (contate: due CALL uguali nella stessa rete sono due). */
  const missing = (a: (readonly [string, string])[], b: (readonly [string, string])[]) => {
    const left = new Map<string, number>();
    for (const [k] of b) left.set(k, (left.get(k) ?? 0) + 1);
    return a.filter(([k]) => {
      const n = left.get(k) ?? 0;
      left.set(k, n - 1);
      return n <= 0;
    });
  };
  return [...missing(calls(old), calls(now)), ...missing(raws(now), raws(old))].map(([, v]) => v);
}

/** I chiamati (`FC20`, `FB10`, `SFC46`) delle UC/CC di una sequenza di byte (esadecimale). */
function calleesOf(hex: string): string[] {
  const bytes = hexBytes(hex);
  if (!bytes) return [];
  const out: string[] = [];
  for (let at = 0; at < bytes.length;) {
    const r = decodeInstruction(bytes, at);
    const op = 'stmt' in r ? r.stmt.operand : undefined;
    if ('stmt' in r && (r.stmt.id === 'UC' || r.stmt.id === 'CC') && op?.kind === 'block') {
      out.push(`${op.blockKind}${op.number}`);
    }
    at += Math.max(1, r.length);
  }
  return out;
}

/**
 * Un DB del progetto importato prima del suo FB (DB globale in sola lettura), coi byte uguali al
 * file e l'FB ora nel lotto: il DB di istanza decodificato, al posto del DB (stesso id, nome,
 * gruppo, titolo e commento).
 */
function asFbInstance(db: Block, idb: InstanceDb): InstanceDb {
  const out: InstanceDb = {
    ...idb,
    id: db.id,
    name: db.name,
    group: db.group,
    header: { ...idb.header, title: db.header.title, comment: db.header.comment },
  };
  out.mc7 = { ...idb.mc7!, sourceHash: '', interfaceHash: '' };
  out.mc7.sourceHash = sourceHashOf(out);
  out.mc7.interfaceHash = interfaceHashOf(out);
  return out;
}

/**
 * Perché un DB di istanza convertito sul posto resterebbe bloccato coi suoi byte (impronte del
 * lotto con un'impronta che non coincide mai): i parametri della nota DB_NON_CONVERTITO, con il
 * contesto di i18next (`incoherent`, `foreign`, `rebuilt` o `rebuilt_<causa>`). Undefined se vale.
 */
function lockedConversion(
  idb: Block,
  future: PlcDevice,
  batch: ReadonlySet<string>,
): Record<string, string> | undefined {
  const fid = savedFidelity(idb);
  // impronte non calcolabili: il DB di istanza conterebbe come modificato, e bloccato
  if (!fid) return { fb: idb.kind === 'IDB' ? idb.instanceOf : '', context: 'rebuilt' };
  const hit = Object.entries(fid.deps).find(
    ([, v]) => v === FOREIGN || v === INCOHERENT || v === REBUILT,
  );
  if (!hit) return undefined;
  const [fb, mark] = hit;
  if (mark === INCOHERENT) return { fb, context: 'incoherent' };
  if (mark === FOREIGN) return { fb, context: 'foreign' };
  const target = blockOfKey(fb, future);
  const cause = target ? rootCause(target, future, new Map(), batch) : undefined;
  const sub = cause ? causeContext(cause, fb) : undefined;
  return {
    fb,
    context: sub ? `rebuilt_${sub}` : 'rebuilt',
    ...(cause ? { src: cause.src, ...(cause.via ? { via: cause.via } : {}) } : {}),
  };
}

/**
 * Un DB del progetto non modificato sostituito da uno con lo stesso SSB (valori attuali cambiati):
 * il modello del progetto (nomi, commenti, titolo) coi metadati MC7 del nuovo (byte e valori
 * attuali), i campi dell'intestazione e la protezione know-how dei byte nuovi. Undefined se non è
 * così.
 */
function keptDbModel(ex: Block, inc: Block, device: PlcDevice): Block | undefined {
  if ((inc.kind !== 'DB' && inc.kind !== 'IDB') || ex.kind !== inc.kind) return undefined;
  if (!ex.mc7?.ssbRaw || ex.mc7.ssbRaw !== inc.mc7?.ssbRaw) return undefined;
  if (inc.kind === 'IDB' && ex.kind === 'IDB' && !sameName(ex.instanceOf, inc.instanceOf)) {
    return undefined;
  }
  try {
    if (fidelityState(ex, device).modified) return undefined;
  } catch {
    return undefined;
  }
  const out = { ...structuredClone({ ...ex, mc7: undefined }), mc7: inc.mc7 } as Block;
  // la protezione know-how viene dai byte (come l'intestazione)
  out.knowHowProtected = inc.knowHowProtected;
  const h = inc.header;
  out.header = {
    ...out.header,
    author: h.author,
    family: h.family,
    headerName: h.headerName,
    version: h.version,
  };
  return out;
}

/** JSON con le chiavi in ordine (per confrontare metadati salvati e ricalcolati). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/**
 * Applica il piano: aggiunge i blocchi nuovi, sostituisce sul posto quelli esistenti (stesso id,
 * nome e gruppo) e quelli di cui si aggiornano solo i metadati (`refresh`).
 */
export function applyImport(device: PlcDevice, plan: ImportPlan): void {
  for (const { existing, incoming } of [...plan.replace, ...plan.refresh]) {
    const at = device.blocks.findIndex((b) => b.id === existing.id);
    if (at < 0)
      throw new Error(
        `applyImport: il blocco ${existing.name} (${existing.id}) non è più nel dispositivo`,
      );
    device.blocks[at] = incoming;
  }
  device.blocks.push(...plan.create);
  // Tipi delle multi-istanze e degli IDB: i nomi sono già quelli finali (decisi in planImport).
}
