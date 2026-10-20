import { formatNetwork, parseNetwork } from '@baaportal/awl';
import type { Mc7Add } from './add';
import { rebuildCalls, type RebuiltCall, type ResolveCallee } from './callRebuild';
import {
  decodeInstruction,
  encodeDecoded,
  encodeInstruction,
  type DecodedStatement,
  type EncodeOptions,
} from './opcodes';
import type { FormalType } from './operands';
import type { SsbInterface } from './ssb';

/**
 * Decodificatore del codice di un blocco: sezione MC7 + ADD → reti AWL e metadati per la ricodifica
 * identica (mc7 §1.5, §2.4, §2.5, §3). La ricodifica la fa il Task 5; qui si garantisce che
 * `networks` + `meta` bastino a ricostruire **tutti** i byte della sezione MC7.
 *
 * ## Contratto di ricodifica (per il Task 5)
 *
 * - **Reti.** `networks[k]` è la rete k di `add.networks`, in AWL internazionale canonico
 *   (`formatNetwork`), con LF. Una rete vuota è la stringa vuota. Senza ADD leggibile (nessuna rete,
 *   o reti più lunghe del codice) tutto il codice è una rete sola.
 * - **Coda.** I byte dopo l'ultima rete (di norma il `BE` finale `65 00`, fuori dalle reti) non sono
 *   nel testo: `meta.tail` è la loro forma esadecimale; se manca, la coda è `65 00`.
 * - **Istruzioni normali.** Ogni istruzione che il testo sa portare da sola è una riga AWL
 *   (`parseNetwork` + `encodeInstruction` la ricodifica a byte uguali). Le istruzioni sono
 *   numerate in ordine di rete e posizione tra le sole righe di istruzione di quella rete (i
 *   segnaposto grezzi e i commenti non contano): la chiave è `"<rete>:<indice>"`.
 * - **Byte di tipo delle costanti.** `meta.constantTypes[chiave]` = `constantType` da passare a
 *   `encodeInstruction` (solo dove il testo non lo porta).
 * - **Parametri formali.** Il testo usa i nomi generati `#PAR<n>` (`PARW<offset>` se dispari);
 *   l'offset è `2·(n + 1)`. Il tipo originale (la forma dell'istruzione) è in `meta.formals[chiave]`.
 * - **Salti.** Ogni destinazione è un'etichetta `M001`, `M002`… all'inizio dell'istruzione di
 *   destinazione, in ordine di offset su tutto il blocco (al massimo 4 caratteri; MC7 non ha
 *   etichette). La destinazione può stare in un'altra rete, purché sia un inizio di istruzione
 *   normale (non nel mezzo di un'istruzione, non sul BE finale, non su un grezzo). Lo
 *   spostamento si ricalcola dalle etichette (`encodeJump`); `JL` salta a `JL + 4 + 4·n`.
 * - **Istruzioni grezze.** Ciò che ricodificato dal testo non darebbe gli stessi byte (opcode
 *   sconosciuti, righe finali troncate, forme non canoniche, liste di puntatori di UC/CC, `UC FC
 *   [mem]`, salti con destinazione non valida come sopra…) è un **segnaposto**: una riga solo commento
 *   `// MC7 grezzo: <hex>`, seguita se esiste dal testo migliore `// MC7 testo: <istruzione>` (un
 *   commento, così ricompilando non si esegue codice sbagliato). I byte stanno in `meta.raws`, in
 *   ordine di rete e posizione; **il Task 5 li reinserisce per posizione**: l'i-esimo segnaposto
 *   della rete k (le righe che cominciano per `// MC7 grezzo:`) è la i-esima voce di `raws` con
 *   `network === k`. `offset` è il byte dall'inizio della rete. I grezzi non si ricodificano mai dal
 *   testo.
 * - **CALL ricostruite.** Con `resolveCallee` e `caller` (`decodeBlock` li dà), una sequenza
 *   `BLD n` … `BLD n+1` di un chiamato noto diventa una riga `CALL` se l'espansione del compilatore
 *   ridà i suoi byte (`callRebuild.ts`); `meta.calls[chiave]` sono quei byte, che una rete
 *   invariata rimette tali e quali. La CALL conta come una sola istruzione nelle chiavi.
 * - **ADD.** Le lunghezze delle reti vengono dalle reti stesse. L'elenco dei salti è l'insieme dei
 *   salti non grezzi (offset in parole, in ordine di codice): `jumpOrder` è la permutazione se
 *   l'ordine dell'ADD è diverso (FC100): `add.jumps[i] = ordineDiCodice[jumpOrder[i]]`. Se
 *   l'insieme dell'ADD non coincide con quello ricavato (salti grezzi, offset dispari…) c'è
 *   `addJumps`, l'elenco letterale. `addRest` è il resto dell'ADD in esadecimale (FB101).
 */
export interface DecodedCode {
  networks: string[];
  meta: CodeMeta;
}

export interface CodeMeta {
  /** Permutazione dell'elenco dei salti dell'ADD rispetto all'ordine di codice (solo se diverso). */
  jumpOrder?: number[];
  /** Elenco letterale dei salti dell'ADD (parole), solo se non coincide con i salti decodificati. */
  addJumps?: number[];
  /** Istruzioni grezze, in ordine di rete e posizione; `offset` in byte dall'inizio della rete. */
  raws: { network: number; offset: number; bytes: string }[];
  /** Byte di tipo delle costanti che il testo non porta, per chiave `"<rete>:<indice>"`. */
  constantTypes: Record<string, number>;
  /** Tipo originale dei parametri formali `#PARn`, per chiave `"<rete>:<indice>"`. */
  formals?: Record<string, FormalType>;
  /** CALL ricostruite: i byte originali della sequenza (esadecimale), per chiave `"<rete>:<indice>"`. */
  calls?: Record<string, string>;
  /** Lunghezza in byte di ogni rete nel codice originale (per i salti grezzi tra reti). */
  networkLengths?: number[];
  /**
   * Tabella delle reti letterale dell'ADD, solo se non era leggibile o non copriva il codice (e
   * quindi tutto il codice è una rete sola).
   */
  addNetworks?: number[];
  /** Resto dell'ADD (byte ignoti dopo la tabella dei salti), in esadecimale. */
  addRest?: string;
  /** Byte dopo l'ultima rete in esadecimale; assente = il `BE` standard `65 00`. */
  tail?: string;
  /**
   * Dati locali del blocco originale (header byte 32–33), messi da `decodeBlock`: quando una rete
   * tiene i byte originali il compilatore non li fa scendere sotto (`compile.ts`).
   */
  localData?: number;
  /**
   * Il testo decodificato di ogni rete (uguale a `networks`). Il codificatore lo confronta con la
   * rete che riceve: una rete uguale è "invariata" e usa tutti i metadati; una diversa è
   * "modificata" e si ricodifica dal solo testo (i metadati sono legati alla posizione delle
   * istruzioni e non sopravvivono a una modifica).
   */
  networkTexts: string[];
}

/** Prefisso del segnaposto grezzo (Task 5: lo riconosce con questo testo). */
export const RAW_PLACEHOLDER = '// MC7 grezzo: ';
/** Prefisso del testo migliore, sempre un commento. */
export const RAW_TEXT = '// MC7 testo: ';

const MAX_LABELS = 999;
const hex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

interface Item {
  start: number; // dall'inizio della rete
  bytes: Uint8Array;
  stmt?: DecodedStatement;
  text?: string; // testo migliore (anche se l'istruzione diventa grezza)
  raw: boolean;
  constantType?: number;
}

/** L'istruzione, scritta come riga AWL e ricodificata dal solo testo, dà gli stessi byte? */
function textCarries(stmt: DecodedStatement, bytes: Uint8Array): { ok: boolean; ct?: number } {
  try {
    if (!same(encodeDecoded(stmt), bytes)) return { ok: false };
  } catch {
    return { ok: false };
  }
  const text = stmt.jumpTo !== undefined ? `${stmt.id} M001` : stmt.text;
  const parsed = parseNetwork(`\t${text};`, 'international');
  const st = parsed.statements[0];
  if (parsed.errors.length || parsed.statements.length !== 1 || !st?.instruction.def) {
    return { ok: false };
  }
  const base: EncodeOptions = {
    ...(stmt.jumpWords !== undefined ? { jumpWords: stmt.jumpWords } : {}),
    formal: (n) =>
      stmt.formal && n === stmt.formal.name
        ? { offset: stmt.formal.offset, type: stmt.formal.type }
        : undefined,
  };
  const attempt = (o: EncodeOptions): boolean => {
    try {
      return same(encodeInstruction(st, o), bytes);
    } catch {
      return false;
    }
  };
  if (attempt(base)) return { ok: true };
  if (stmt.constantType !== undefined && attempt({ ...base, constantType: stmt.constantType })) {
    return { ok: true, ct: stmt.constantType };
  }
  return { ok: false };
}

function decodeNetwork(code: Uint8Array): Item[] {
  const items: Item[] = [];
  let at = 0;
  while (at < code.length) {
    const r = decodeInstruction(code, at);
    const len = Math.max(1, r.length);
    const bytes = code.slice(at, at + len);
    if ('raw' in r) {
      items.push({ start: at, bytes, raw: true });
    } else {
      const c = textCarries(r.stmt, bytes);
      items.push({
        start: at,
        bytes,
        stmt: r.stmt,
        text: r.stmt.text,
        raw: !c.ok,
        ...(c.ct !== undefined ? { constantType: c.ct } : {}),
      });
    }
    at += len;
  }
  return items;
}

export interface DecodeCodeOptions {
  /** Interfaccia dei blocchi chiamati: le CALL con un chiamato noto si ricostruiscono. */
  resolveCallee?: ResolveCallee;
  /** Il blocco che contiene il codice (tipo e interfaccia): serve alla verifica delle CALL. */
  caller?: { kind: 'OB' | 'FB' | 'FC'; iface: SsbInterface };
}

export function decodeCode(
  mc7: Uint8Array,
  add: Mc7Add,
  opts: DecodeCodeOptions = {},
): DecodedCode {
  // Reti dall'ADD; senza ADD leggibile una rete sola con tutto il codice
  const ranges: [number, number][] = [];
  const total = add.networks.reduce((a, n) => a + n, 0);
  let tail: string | undefined;
  let addNetworks: number[] | undefined;
  if (add.networks.length > 0 && total <= mc7.length) {
    let o = 0;
    for (const n of add.networks) {
      ranges.push([o, o + n]);
      o += n;
    }
    const t = hex(mc7.subarray(o));
    if (t !== '65 00') tail = t;
  } else {
    ranges.push([0, mc7.length]);
    tail = '';
    addNetworks = [...add.networks];
  }

  const nets = ranges.map(([a, z]) => ({ base: a, items: decodeNetwork(mc7.subarray(a, z)) }));

  // Salti validi: destinazione su un inizio di istruzione normale, in qualunque rete del blocco
  // (le etichette valgono in tutto il blocco, come nel codificatore)
  const isJump = (it: Item): boolean => !it.raw && it.stmt?.jumpTo !== undefined;
  for (;;) {
    let changed = false;
    const targets = new Set<number>();
    const starts = new Set<number>();
    for (const net of nets) {
      for (const i of net.items) if (!i.raw) starts.add(net.base + i.start);
    }
    for (const net of nets) {
      for (const it of net.items) {
        if (!isJump(it)) continue;
        if (!starts.has(net.base + it.stmt!.jumpTo!)) {
          it.raw = true;
          changed = true;
        } else targets.add(net.base + it.stmt!.jumpTo!);
      }
    }
    const kept = new Set([...targets].sort((a, b) => a - b).slice(0, MAX_LABELS));
    if (kept.size < targets.size) {
      for (const net of nets) {
        for (const it of net.items) {
          if (isJump(it) && !kept.has(net.base + it.stmt!.jumpTo!)) {
            it.raw = true;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  const targetList = new Set<number>();
  for (const net of nets) {
    for (const it of net.items) if (isJump(it)) targetList.add(net.base + it.stmt!.jumpTo!);
  }
  const labelOf = new Map<number, string>();
  [...targetList]
    .sort((a, b) => a - b)
    .forEach((off, i) => labelOf.set(off, `M${String(i + 1).padStart(3, '0')}`));

  const codeJumps: number[] = [];
  for (const net of nets) {
    for (const it of net.items)
      if (it.stmt?.jumpTo !== undefined) codeJumps.push((net.base + it.start) / 2);
  }

  /** Testo e metadati delle reti, con le CALL `calls` al posto delle loro sequenze. */
  const render = (calls: readonly RebuiltCall[]): { networks: string[]; meta: CodeMeta } => {
    const meta: CodeMeta = { raws: [], constantTypes: {}, networkTexts: [] };
    const formals: Record<string, FormalType> = {};
    const callBytes: Record<string, string> = {};
    const networks: string[] = [];
    nets.forEach((net, k) => {
      if (net.items.length === 0) {
        networks.push('');
        return;
      }
      const mine = new Map(calls.filter((c) => c.network === k).map((c) => [c.from, c]));
      const lines: string[] = [];
      let n = 0;
      for (let i = 0; i < net.items.length; i++) {
        const it = net.items[i]!;
        const abs = net.base + it.start;
        const call = mine.get(i);
        if (call) {
          const label = labelOf.get(abs);
          callBytes[`${k}:${n++}`] = hex(call.bytes);
          lines.push(`${label ? `${label}:` : ''}\t${call.text};`);
          i = call.to;
          continue;
        }
        if (it.raw) {
          meta.raws.push({ network: k, offset: it.start, bytes: hex(it.bytes) });
          lines.push(`\t${RAW_PLACEHOLDER}${hex(it.bytes)}`);
          if (it.text) lines.push(`\t${RAW_TEXT}${it.text}`);
          continue;
        }
        const st = it.stmt!;
        const key = `${k}:${n++}`;
        const label = labelOf.get(abs);
        let text = st.text;
        if (st.jumpTo !== undefined) {
          text = `${st.id} ${labelOf.get(net.base + st.jumpTo)!}`;
        }
        if (it.constantType !== undefined) meta.constantTypes[key] = it.constantType;
        if (st.formal) formals[key] = st.formal.type;
        lines.push(`${label ? `${label}:` : ''}\t${text};`);
      }
      networks.push(formatNetwork(lines.join('\n'), 'international'));
    });
    if (Object.keys(formals).length) meta.formals = formals;
    if (Object.keys(callBytes).length) meta.calls = callBytes;
    return { networks, meta };
  };

  let rebuilt: RebuiltCall[] = [];
  try {
    if (opts.resolveCallee && opts.caller) {
      rebuilt = rebuildCalls({
        nets,
        // destinazioni dei salti, anche grezzi: non devono cadere dentro una CALL ricostruita
        targets: new Set([
          ...labelOf.keys(),
          ...nets.flatMap((net) =>
            net.items.flatMap((it) =>
              it.stmt?.jumpTo !== undefined ? [net.base + it.stmt.jumpTo] : [],
            ),
          ),
        ]),
        render: (calls) => render(calls).networks,
        resolveCallee: opts.resolveCallee,
        caller: opts.caller,
      });
    }
  } catch {
    rebuilt = []; // la ricostruzione non deve mai rendere illeggibile il codice: resta com'è
  }
  const { networks, meta } = render(rebuilt);
  meta.networkTexts = [...networks];
  meta.networkLengths = ranges.map(([a, z]) => z - a);
  if (tail !== undefined) meta.tail = tail;
  if (addNetworks) meta.addNetworks = addNetworks;

  // Tabella dei salti dell'ADD
  const sortedAdd = [...add.jumps].sort((a, b) => a - b);
  if (sortedAdd.length === codeJumps.length && sortedAdd.every((v, i) => v === codeJumps[i])) {
    if (add.jumps.some((v, i) => v !== codeJumps[i])) {
      const used = new Set<number>();
      meta.jumpOrder = add.jumps.map((v) => {
        const i = codeJumps.findIndex((c, j) => c === v && !used.has(j));
        used.add(i);
        return i;
      });
    }
  } else {
    meta.addJumps = [...add.jumps];
  }
  if (add.rest.length) meta.addRest = hex(add.rest);
  return { networks, meta };
}
