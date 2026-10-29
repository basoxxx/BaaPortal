// Informazioni sul programma (tappa 7A): riferimenti incrociati e struttura di chiamata di un
// dispositivo. Si leggono dall'AWL di ogni segmento (`kopSources`: anche quello generato da KOP, FUP
// e SCL) con il parser AWL, e ogni operando si risolve come il compilatore (`resolveGlobalOperand`):
// così la forma simbolica e quella assoluta dello stesso indirizzo sono la stessa voce.
import {
  parseNetwork,
  type AwlContext,
  type Mnemonic,
  type Operand,
  type Statement,
} from '@baaportal/awl';
import { resolveGlobalOperand, SymbolError } from '@baaportal/mc7';
import { formatAddress, sameName } from '@baaportal/s7-types';
import { createAwlContext } from './awlContext';
import { kopSources } from './kopSources';
import type { CodeBlock, Language, PlcDevice } from './model';

export type XrefAccess = 'read' | 'write' | 'readWrite' | 'call' | 'open';

/** Un punto del programma in cui si usa un operando. */
export interface XrefUse {
  blockId: string;
  /** Tipo e numero del blocco che usa l'operando: `OB1`, `FC5`. */
  block: string;
  language: Language;
  /** Segmento (da 1). */
  network: number;
  /** Riga (da 1): dell'AWL del segmento, o del testo SCL in un blocco SCL. */
  line: number;
  /** In un segmento KOP/FUP: l'elemento del grafico che ha prodotto la riga. */
  elemId?: string;
  /** Mnemonico internazionale dell'istruzione (`A`, `=`, `CALL`…). */
  instruction: string;
  access: XrefAccess;
  /** In una CALL di FB: il DB di istanza (`DB2`) o la multi-istanza (`#Nastro`). */
  instance?: string;
}

export type XrefKind =
  'I' | 'Q' | 'M' | 'PI' | 'PQ' | 'DB' | 'DI' | 'T' | 'C' | 'block' | 'constant' | 'unknown';

/** Un operando del programma con tutti i suoi punti d'uso. */
export interface XrefOperand {
  key: string;
  /** Indirizzo assoluto (`%M10.3`, `%DB5.DBW2`, `%T5`, `FC1`) o, se non si risolve, il testo scritto. */
  address: string;
  /** Simbolo: il tag della tabella, il membro del DB come scritto, il nome del blocco. */
  symbol?: string;
  kind: XrefKind;
  /** Tipo di dato (dal tag o dalla dimensione dell'accesso) o tipo del blocco. */
  type?: string;
  /** Il numero del DB di un accesso qualificato (`%DB5.DBW2`). */
  db?: number;
  uses: XrefUse[];
  /** Chiavi degli altri operandi che toccano almeno un bit in comune (MW10 con M10.3 e MB11). */
  overlaps: string[];
}

const NO_RANGE = {
  from: { line: 0, col: 0, offset: 0 },
  to: { line: 0, col: 0, offset: 0 },
};
const SIZE_TYPE = { X: 'Bool', B: 'Byte', W: 'Word', D: 'DWord' } as const;
const SIZE_BITS = { X: 1, B: 8, W: 16, D: 32 } as const;
const READ = new Set(['A', 'AN', 'O', 'ON', 'X', 'XN', 'L', 'LC', 'LAR1', 'LAR2']);
const WRITE = new Set([
  '=',
  'S',
  'R',
  'T',
  'TAR1',
  'TAR2',
  'SP',
  'SE',
  'SD',
  'SS',
  'SF',
  'FR',
  'CU',
  'CD',
]);
const CALLS = new Set(['CALL', 'UC', 'CC']);

/** Tipo dell'accesso di un'istruzione al suo operando; `undefined` se non accede (salti, costanti). */
function accessOf(instr: string): XrefAccess | undefined {
  if (READ.has(instr)) return 'read';
  if (WRITE.has(instr)) return 'write';
  if (instr === 'FP' || instr === 'FN') return 'readWrite'; // il merker del fronte si legge e si scrive
  if (CALLS.has(instr)) return 'call';
  if (instr === 'OPN') return 'open';
  return undefined;
}

const blockLabel = (kind: string, number: number) => `${kind === 'IDB' ? 'DB' : kind}${number}`;

type Entry = Omit<XrefOperand, 'uses' | 'overlaps'> & {
  /** Area, DB e bit occupati, per le sovrapposizioni. */
  span?: { area: string; from: number; to: number };
};

/** Il testo di `op` com'è scritto nella sorgente. */
const textOf = (src: string, op: Operand) => src.slice(op.range.from.offset, op.range.to.offset);

/** La voce di un operando; `undefined` per ciò che non è un operando del programma (locali, L, costanti scritte). */
function entryOf(ctx: AwlContext, op: Operand, written: string): Entry | undefined {
  if (op.kind === 'local' || op.kind === 'labelRef' || op.kind === 'status') return undefined;
  if (op.kind === 'special' || op.kind === 'indirect') return undefined;
  if (op.kind === 'address' && op.area === 'L') return undefined;
  let v;
  try {
    v = resolveGlobalOperand(op, ctx);
  } catch (e) {
    if (!(e instanceof SymbolError)) throw e;
    // Simbolo sconosciuto o non risolvibile: resta una voce col testo scritto.
    return { key: `?${written.toLowerCase()}`, address: written, kind: 'unknown' };
  }
  const symbol = op.kind === 'symbol' ? written : undefined;
  const withSym = <T extends object>(e: T) => (symbol ? { ...e, symbol } : e);
  switch (v.k) {
    case 'tc': {
      const address = formatAddress({ area: v.area, number: v.number });
      return withSym({
        key: address,
        address,
        kind: v.area,
        type: v.area === 'T' ? 'Timer' : 'Counter',
      });
    }
    case 'block': {
      const address = blockLabel(v.blockKind === 'DI' ? 'DB' : v.blockKind, v.number);
      const kind = v.blockKind === 'DI' ? 'DB' : v.blockKind;
      const name = ctx.block({ kind, number: v.number })?.name;
      return {
        key: address,
        address,
        kind: 'block',
        type: kind,
        ...(name ? { symbol: name } : {}),
      };
    }
    case 'const': {
      // Costante simbolica della tabella: voce per nome; le costanti scritte non sono operandi.
      if (op.kind !== 'symbol') return undefined;
      const type = v.type?.kind === 'elementary' ? v.type.name : undefined;
      return {
        key: `"${op.path[0]!.name.toLowerCase()}"`,
        address: written,
        symbol: written,
        kind: 'constant',
        ...(type ? { type } : {}),
      };
    }
    case 'area': {
      if (v.area === 'L') return undefined;
      const type =
        v.type?.kind === 'elementary' ? v.type.name : v.size ? SIZE_TYPE[v.size] : undefined;
      if (!v.size) {
        // Dato complesso (STRUCT, ARRAY) passato intero: niente indirizzo elementare.
        return {
          key: `?${written.toLowerCase()}`,
          address: written,
          kind: v.area as XrefKind,
          ...(symbol ? { symbol } : {}),
        };
      }
      const byte = v.bit >> 3;
      const bit = v.bit & 7;
      let address: string;
      let db: number | undefined;
      if (v.area === 'DB' || v.area === 'DI') {
        const pre = v.area === 'DB' && v.db !== undefined ? `DB${v.db}.` : '';
        const field = v.size === 'X' ? `${v.area}X${byte}.${bit}` : `${v.area}${v.size}${byte}`;
        address = `%${pre}${field}`;
        if (v.db !== undefined) db = v.db;
      } else {
        const area = v.area as 'I' | 'Q' | 'M' | 'PI' | 'PQ';
        address = formatAddress(
          v.size === 'X' ? { area, size: 'X', byte, bit } : { area, size: v.size, byte },
        );
      }
      const span = {
        area: `${v.area}${v.db ?? ''}`,
        from: v.bit,
        to: v.bit + SIZE_BITS[v.size],
      };
      return withSym({
        key: address,
        address,
        kind: v.area as XrefKind,
        ...(type ? { type } : {}),
        ...(db !== undefined ? { db } : {}),
        span,
      });
    }
    default:
      return undefined;
  }
}

/** Il blocco chiamato da `CALL #multi`: il tipo del dato statico del blocco che chiama. */
function multiInstanceCallee(ctx: AwlContext, block: CodeBlock, op: Operand): Operand | undefined {
  if (op.kind !== 'local' || op.path.length !== 1) return undefined;
  const m = block.interface.static.find((s) => sameName(s.name, op.path[0]!.name));
  if (!m) return undefined;
  const t = m.type.trim();
  const abs = /^(FB|SFB)\s*(\d+)$/i.exec(t);
  const callee = abs
    ? ctx.block({ kind: abs[1]!.toUpperCase() as 'FB' | 'SFB', number: Number(abs[2]) })
    : ctx.block({ name: t.replace(/^"|"$/g, '') });
  if (!callee) return undefined;
  return {
    kind: 'block',
    blockKind: callee.kind as 'FB' | 'SFB',
    number: callee.number,
    range: op.range,
  };
}

/** Direzione dei parametri del blocco chiamato da `st`: nome (minuscolo) → accesso. */
function paramAccess(ctx: AwlContext, callee: Operand | undefined): Map<string, XrefAccess> {
  const out = new Map<string, XrefAccess>();
  if (!callee) return out;
  let info;
  if (callee.kind === 'block' && callee.blockKind !== 'DB' && callee.blockKind !== 'DI') {
    info = ctx.block({ kind: callee.blockKind, number: callee.number });
  } else if (callee.kind === 'symbol' && callee.path.length === 1) {
    info = ctx.block({ name: callee.path[0]!.name });
  }
  const i = info?.iface;
  if (!i) return out;
  const set = (ms: { name: string }[], a: XrefAccess) =>
    ms.forEach((m) => out.set(m.name.toLowerCase(), a));
  set(i.input, 'read');
  set(i.output, 'write');
  set(i.inOut, 'readWrite');
  if (i.returnType) out.set('ret_val', 'write');
  for (const [alias, name] of Object.entries(info?.paramAliases ?? {})) {
    const a = out.get(name.toLowerCase());
    if (a) out.set(alias.toLowerCase(), a);
  }
  return out;
}

type Hit = { op: Operand; access: XrefAccess; line: number; instr: string; instance?: string };

/** Gli operandi usati da un'istruzione, col loro tipo d'accesso. */
function hitsOf(ctx: AwlContext, block: CodeBlock, st: Statement, src: string): Hit[] {
  const instr = st.instruction.def?.id;
  if (!instr) return [];
  const line = st.range.from.line + 1;
  const hits: Hit[] = [];
  const op = st.operand;
  const access = accessOf(instr);
  const callee = op && CALLS.has(instr) ? (multiInstanceCallee(ctx, block, op) ?? op) : op;
  if (op && callee && access) {
    const instance = st.instanceDb
      ? textOf(src, st.instanceDb)
      : callee !== op
        ? textOf(src, op)
        : undefined;
    hits.push({ op: callee, access, line, instr, ...(instance ? { instance } : {}) });
    if (op.kind === 'indirect' && op.via.kind === 'memory') {
      // `L MW [MD 20]`: il puntatore si legge; l'indirizzo puntato non si conosce.
      hits.push({ op: op.via.location, access: 'read', line, instr });
    }
  }
  if (st.instanceDb) hits.push({ op: st.instanceDb, access: 'call', line, instr });
  if (st.params?.length) {
    const dirs = paramAccess(ctx, callee);
    for (const p of st.params) {
      if (!p.value) continue;
      // Parametro sconosciuto: né lettura né scrittura si possono escludere.
      const a = dirs.get(p.name.toLowerCase()) ?? 'readWrite';
      hits.push({ op: p.value, access: a, line: p.range.from.line + 1, instr });
    }
  }
  return hits;
}

/** Tutti gli operandi del programma del dispositivo, ordinati per indirizzo, con i punti d'uso. */
export function crossReferences(dev: PlcDevice): XrefOperand[] {
  const all = new Map<string, XrefOperand & { span?: Entry['span'] }>();
  // Indirizzo → tag, per dare simbolo e tipo agli accessi assoluti.
  const tagOf = new Map<string, Entry>();
  const globalCtx = createAwlContext(dev, '', undefined);
  for (const t of dev.tagTables.flatMap((x) => x.tags)) {
    const op: Operand = {
      kind: 'symbol',
      path: [{ name: t.name, quoted: true, range: NO_RANGE }],
      range: NO_RANGE,
    };
    const e = entryOf(globalCtx, op, `"${t.name}"`);
    if (e && e.kind !== 'unknown' && !tagOf.has(e.key)) tagOf.set(e.key, e);
  }
  for (const block of dev.blocks) {
    if (block.kind === 'DB' || block.kind === 'IDB' || block.mc7?.knowHowLocked) continue;
    const ctx = createAwlContext(dev, block.id, undefined);
    const label = blockLabel(block.kind, block.number);
    kopSources(block, dev).forEach((net, n) => {
      const { statements } = parseNetwork(net.source, 'international' satisfies Mnemonic);
      for (const st of statements) {
        for (const h of hitsOf(ctx, block, st, net.source)) {
          const e = entryOf(ctx, h.op, textOf(net.source, h.op));
          if (!e) continue;
          let line = h.line;
          let elemId: string | undefined;
          if (net.scl)
            line = net.scl.lines.filter((l) => l.line <= h.line - 1).at(-1)?.sclLine ?? 1;
          else if (net.lines.length)
            elemId = net.lines.filter((l) => l.line <= h.line - 1).at(-1)?.elemId;
          const use: XrefUse = {
            blockId: block.id,
            block: label,
            language: block.language,
            network: n + 1,
            line,
            instruction: h.instr,
            access: h.access,
            ...(elemId ? { elemId } : {}),
            ...(h.instance ? { instance: h.instance } : {}),
          };
          let cur = all.get(e.key);
          if (!cur) {
            const tag = tagOf.get(e.key);
            cur = {
              ...e,
              ...(tag ? { symbol: tag.symbol!, type: tag.type! } : {}),
              uses: [],
              overlaps: [],
            };
            all.set(e.key, cur);
          } else if (!cur.symbol && e.symbol) cur.symbol = e.symbol;
          cur.uses.push(use);
        }
      }
    });
  }
  const list = [...all.values()].sort((a, b) =>
    a.address.localeCompare(b.address, 'en', { numeric: true }),
  );
  // Sovrapposizioni: per area (e DB), in ordine di primo bit, finché gli intervalli si toccano.
  const spans = list
    .filter((x) => x.span)
    .sort((a, b) => a.span!.area.localeCompare(b.span!.area) || a.span!.from - b.span!.from);
  for (let i = 0; i < spans.length; i++) {
    const a = spans[i]!;
    for (let j = i + 1; j < spans.length; j++) {
      const b = spans[j]!;
      if (b.span!.area !== a.span!.area || b.span!.from >= a.span!.to) break;
      a.overlaps.push(b.key);
      b.overlaps.push(a.key);
    }
  }
  for (const x of list) delete x.span;
  return list;
}

/**
 * L'operando AWL alla colonna `col` (da 0) della riga `lineText` del blocco `blockId`, col nome
 * della sua voce nei riferimenti incrociati (indirizzo assoluto, o il testo se non si risolve).
 * `undefined` se nella riga non c'è un operando in quel punto (Maiusc+F11 dall'editor).
 */
export function xrefOperandAt(
  dev: PlcDevice,
  blockId: string,
  lineText: string,
  col: number,
  mnemonic: Mnemonic,
): string | undefined {
  const ctx = createAwlContext(dev, blockId, undefined);
  for (const st of parseNetwork(lineText, mnemonic).statements) {
    const ops = [st.operand, st.instanceDb, ...(st.params ?? []).map((p) => p.value)];
    for (const op of ops) {
      if (!op || op.range.from.col > col || op.range.to.col < col) continue;
      const written = textOf(lineText, op);
      return entryOf(ctx, op, written)?.address ?? written;
    }
  }
  return undefined;
}
