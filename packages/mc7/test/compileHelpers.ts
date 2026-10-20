import type { AwlBlockInfo, AwlContext, AwlInterface } from '@baaportal/awl';
import type { DataType, TypedMember } from '@baaportal/s7-types';
import {
  decodeInstruction,
  initialLiteral,
  readBlockFile,
  type Mc7File,
  type SsbElement,
  type SsbInterface,
  type SsbSection,
} from '../src';

/**
 * Aiuti per ricompilare i blocchi reali dal loro AWL decodificato (Task 7): interfaccia decodificata
 * → sezioni e valori iniziali in testo, sostituzione delle espansioni di CALL con la sorgente CALL,
 * salti grezzi tra reti → etichette, confronto delle reti e delle CALL al byte.
 */

export type Sections = Record<SsbSection, TypedMember[]>;
export const SECTIONS: SsbSection[] = ['in', 'out', 'inOut', 'stat', 'temp', 'ret'];
export const emptySections = (over: Partial<Sections> = {}): Sections => ({
  in: [],
  out: [],
  inOut: [],
  stat: [],
  temp: [],
  ret: [],
  ...over,
});

export const toAwlIface = (s: Sections): AwlInterface => ({
  input: s.in,
  output: s.out,
  inOut: s.inOut,
  static: s.stat,
  temp: s.temp,
  returnType: s.ret[0]?.type ?? { kind: 'void' },
});

const NAME_OF: Record<SsbSection, string> = {
  in: 'IN',
  out: 'OUT',
  inOut: 'IN_OUT',
  stat: 'STAT',
  temp: 'TEMP',
  ret: 'RET_VAL',
};

/**
 * Interfaccia decodificata → sezioni con i nomi generati (`IN0`, `STAT1`…; nelle FC i parametri
 * `PAR<k>` come i formali `#PARk` del testo decodificato), valori iniziali in testo e le strutture
 * delle multi-istanze (`FB<n>` → sezioni).
 */
export function interfaceInput(
  iface: SsbInterface,
  kind: 'OB' | 'FB' | 'FC',
): { sections: Sections; initials: Record<string, string>; fbTypes: Map<string, Sections> } {
  const initials: Record<string, string> = {};
  const fbTypes = new Map<string, Sections>();
  const typeOf = (e: SsbElement, path: string): DataType => {
    const t = e.type;
    if (t.kind === 'raw') throw new Error(`${path}: tipo grezzo ${t.code}`);
    if (t.kind === 'struct') return { kind: 'struct', members: members(e.children ?? [], path) };
    if (t.kind === 'array') {
      const el = e.children?.[0];
      if (!el) throw new Error(`${path}: ARRAY senza elemento`);
      return { kind: 'array', dims: t.dims, element: typeOf(el, path) };
    }
    if (t.kind === 'named') {
      const inner = e.children?.[0]?.children ?? [];
      const s = emptySections();
      const named = names(inner);
      inner.forEach((c, i) => {
        s[c.section].push({ name: named[i]!, type: typeOf(c, `${path}.${named[i]}`) });
        literalOf(c, `${path}.${named[i]}`);
      });
      fbTypes.set(t.name, s);
      return t;
    }
    literalOf(e, path);
    return t;
  };
  const literalOf = (e: SsbElement, path: string): void => {
    if (!e.initial || e.type.kind === 'raw' || e.type.kind === 'array') return;
    if (e.type.kind === 'struct' || e.type.kind === 'named') return;
    const text = initialLiteral(e.type, e.initial);
    if (text !== undefined) initials[path] = text;
  };
  const names = (els: SsbElement[]): string[] => {
    const count: Record<string, number> = {};
    return els.map((e) => {
      const base = NAME_OF[e.section];
      const n = count[base] ?? 0;
      count[base] = n + 1;
      return `${base}${n}`;
    });
  };
  const members = (els: SsbElement[], prefix: string): TypedMember[] => {
    const named = names(els);
    return els.map((e, i) => ({ name: named[i]!, type: typeOf(e, `${prefix}.${named[i]}`) }));
  };

  const sections = emptySections();
  const top = names(iface.elements);
  let par = 0;
  iface.elements.forEach((e, i) => {
    const isParam = e.section === 'in' || e.section === 'out' || e.section === 'inOut';
    const name =
      kind === 'FC' && isParam ? `PAR${par++}` : e.section === 'ret' ? 'RET_VAL' : top[i]!;
    sections[e.section].push({ name, type: typeOf(e, name) });
  });
  return { sections, initials, fbTypes };
}

/** Contesto AWL per un blocco ricompilato: nessun simbolo, i blocchi chiamati dati, le multi-istanze. */
export function selfContext(
  kind: 'OB' | 'FB' | 'FC',
  sections: Sections,
  blocks: AwlBlockInfo[],
  fbTypes: Map<string, Sections>,
): AwlContext {
  const find = (ref: { name: string } | { kind: string; number: number }) => {
    if ('name' in ref) {
      const b = blocks.find((x) => x.name.toLowerCase() === ref.name.toLowerCase());
      if (b) return b;
      const m = /^(FB|SFB)(\d+)$/i.exec(ref.name);
      const s = fbTypes.get(ref.name);
      if (m && s) {
        return {
          name: ref.name,
          kind: m[1]!.toUpperCase() as 'FB' | 'SFB',
          number: Number(m[2]),
          iface: toAwlIface(s),
        };
      }
      return undefined;
    }
    return blocks.find((x) => x.kind === ref.kind && x.number === ref.number);
  };
  return {
    owner: { kind, iface: toAwlIface(sections) },
    symbol: () => undefined,
    block: find,
    resolve: (name) => {
      const s = fbTypes.get(name);
      return s
        ? { kind: 'fb', sections: { input: s.in, output: s.out, inOut: s.inOut, static: s.stat } }
        : null;
    },
    allSymbols: () => [],
    allBlocks: () => blocks,
  };
}

/** Byte di ogni rete secondo l'ADD del file. */
export function networkBytes(f: Mc7File): Uint8Array[] {
  const out: Uint8Array[] = [];
  let o = 0;
  for (const n of f.add.networks) {
    out.push(f.mc7.subarray(o, o + n));
    o += n;
  }
  return out;
}

/** Inizi delle istruzioni (offset assoluti nella sezione MC7) di ogni rete. */
function instructionStarts(f: Mc7File): number[][] {
  let base = 0;
  return f.add.networks.map((n) => {
    const starts: number[] = [];
    const code = f.mc7.subarray(base, base + n);
    for (let at = 0; at < code.length;) {
      starts.push(base + at);
      at += Math.max(1, decodeInstruction(code, at).length);
    }
    base += n;
    return starts;
  });
}

const TEXT_LINE = /^\s*\/\/ MC7 testo:/;
const RAW_LINE = /^\s*\/\/ MC7 grezzo: (.*)$/;
const LABEL = /^([A-Za-z]\w*):/;
const bytesOf = (s: string): Uint8Array =>
  Uint8Array.from(s.trim().split(/\s+/), (x) => parseInt(x, 16));

/**
 * Salti grezzi (destinazione in un'altra rete, mc7 §2.4) → `Jxx Znnn` con un'etichetta sulla
 * destinazione; `UC FC [mem]` (senza sintassi AWL nel parser) → `UC FC 256`, stessa lunghezza.
 * Restituisce le reti e il numero di sostituzioni fatte.
 */
export function relabelRawJumps(
  networks: string[],
  file: Uint8Array,
): { networks: string[]; jumps: number; indirectCalls: number } {
  const f = readBlockFile(file);
  const starts = instructionStarts(f);
  const lines = networks.map((n) => (n === '' ? [] : n.split('\n')));
  // indice d'istruzione → riga
  const lineOf = lines.map((ls) => ls.flatMap((l, i) => (TEXT_LINE.test(l) ? [] : [i])));
  const labelAt = new Map<number, string>();
  lines.forEach((ls, k) =>
    lineOf[k]!.forEach((li, idx) => {
      const m = LABEL.exec(ls[li]!);
      if (m) labelAt.set(starts[k]![idx]!, m[1]!);
    }),
  );
  let next = 1;
  let jumps = 0;
  let indirectCalls = 0;
  const replaced = lines.map((ls) => [...ls]);
  const drop = lines.map(() => new Set<number>());
  lines.forEach((ls, k) => {
    lineOf[k]!.forEach((li, idx) => {
      const m = RAW_LINE.exec(ls[li]!);
      if (!m) return;
      const bytes = bytesOf(m[1]!);
      const d = decodeInstruction(bytes, 0);
      if (!('stmt' in d)) return;
      const keepLabel = LABEL.exec(ls[li]!)?.[0] ?? '';
      if (d.stmt.indirectBlock) {
        replaced[k]![li] = `${keepLabel}\t${d.stmt.id} FC 256;`;
        if (TEXT_LINE.test(ls[li + 1] ?? '')) drop[k]!.add(li + 1);
        indirectCalls++;
        return;
      }
      if (d.stmt.jumpTo === undefined) return;
      const target = starts[k]![idx]! + d.stmt.jumpTo;
      let name = labelAt.get(target);
      if (!name) {
        const j = starts.findIndex((s) => s.includes(target));
        if (j < 0) return; // fine del codice: resta grezzo
        name = `Z${String(next++).padStart(3, '0')}`;
        labelAt.set(target, name);
        const tl = lineOf[j]![starts[j]!.indexOf(target)]!;
        replaced[j]![tl] = `${name}:${replaced[j]![tl]!.replace(/^[A-Za-z]\w*:/, '')}`;
      }
      replaced[k]![li] = `${replaced[k]![li]!.match(LABEL)?.[0] ?? ''}\t${d.stmt.id} ${name};`;
      if (TEXT_LINE.test(ls[li + 1] ?? '')) drop[k]!.add(li + 1);
      jumps++;
    });
  });
  return {
    networks: replaced.map((ls, k) => ls.filter((_, i) => !drop[k]!.has(i)).join('\n')),
    jumps,
    indirectCalls,
  };
}

/**
 * Sostituisce le espansioni di CALL (`BLD n` … `BLD n+1`, n dispari < 100) con le sorgenti date,
 * in ordine di apparizione nel blocco. L'etichetta della riga `BLD n` resta sulla CALL.
 */
export function replaceCalls(networks: string[], sources: string[]): string[] {
  let used = 0;
  const out = networks.map((text) => {
    if (text === '') return text;
    const lines = text.split('\n');
    const res: string[] = [];
    let open: { n: number; label: string } | undefined;
    for (const line of lines) {
      const m = /^(?:([A-Za-z]\w*):)?\tBLD (\d+);/.exec(line);
      if (m && open === undefined && Number(m[2]) % 2 === 1 && Number(m[2]) < 100) {
        open = { n: Number(m[2]), label: m[1] ? `${m[1]}:` : '' };
        continue;
      }
      if (open !== undefined) {
        if (m && Number(m[2]) === open.n + 1) {
          const src = sources[used++];
          if (src === undefined) throw new Error('sorgenti CALL finite');
          res.push(`${open.label}\t${src};`);
          open = undefined;
        } else if (LABEL.test(line)) {
          throw new Error(`etichetta dentro una CALL: ${line}`);
        }
        continue;
      }
      res.push(line);
    }
    if (open) throw new Error('CALL senza chiusura');
    return res.join('\n');
  });
  if (used !== sources.length) throw new Error(`sorgenti CALL usate ${used} di ${sources.length}`);
  return out;
}

/** Le espansioni di CALL (`BLD n` … `BLD n+1`) di un file, in ordine, come byte. */
export function callSpans(file: Uint8Array): { network: number; bytes: Uint8Array }[] {
  const f = readBlockFile(file);
  const out: { network: number; bytes: Uint8Array }[] = [];
  networkBytes(f).forEach((code, k) => {
    let open: { n: number; at: number } | undefined;
    for (let at = 0; at < code.length;) {
      const len = Math.max(1, decodeInstruction(code, at).length);
      if (code[at] === 0x10 && len === 2) {
        const n = code[at + 1]!;
        if (!open && n % 2 === 1 && n < 100) open = { n, at };
        else if (open && n === open.n + 1) {
          out.push({ network: k + 1, bytes: code.slice(open.at, at + 2) });
          open = undefined;
        }
      }
      at += len;
    }
  });
  return out;
}

/** I blocchi chiamati dal testo (`UC/CC %FCn`, `CALL FC n`…), con un'interfaccia vuota. */
export function calledBlocks(networks: string[]): AwlBlockInfo[] {
  const seen = new Map<string, AwlBlockInfo>();
  for (const n of networks) {
    for (const m of n.matchAll(/\b(?:UC|CC|CALL)\s+%?(FC|FB|SFC|SFB)\s*(\d+)/g)) {
      const kind = m[1] as 'FC' | 'FB' | 'SFC' | 'SFB';
      const key = `${kind}${m[2]}`;
      if (!seen.has(key)) {
        seen.set(key, {
          name: key,
          kind,
          number: Number(m[2]),
          iface: toAwlIface(emptySections()),
        });
      }
    }
  }
  return [...seen.values()];
}

export const hex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/** Primo byte diverso (o la fine del più corto), -1 se uguali. */
export function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

export { initialLiteral };
