import { formatNetwork, parseNetwork, type Statement } from '@baaportal/awl';
import type { Mc7Add } from './add';
import { emptyAdd } from './add';
import { Mc7Error } from './blockFile';
import type { CodeMeta } from './decode';
import { decodeInstruction, encodeInstruction, encodeJump, type EncodeOptions } from './opcodes';
import type { FormalParam, FormalType } from './operands';

export interface Mc7Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  /** Rete, da 1 (0 = non legato a una rete). */
  network: number;
  /** Riga della rete, da 1 (0 = non legato a una riga). */
  line: number;
  message: string;
  params?: Record<string, string>;
}

/**
 * Una istruzione del codice MC7 e la riga di testo da cui viene. `offset` e `length` sono in byte
 * dall'inizio del codice (senza coda), `network` e `line` partono da 0; `line` è l'indice nel testo
 * della rete come lo riceve il codificatore (commenti e righe vuote contano). Tutte le istruzioni
 * di una `CALL` espansa puntano alla riga della `CALL`.
 */
export interface LineMapEntry {
  offset: number;
  length: number;
  network: number;
  line: number;
}

export interface EncodeCodeOptions {
  /**
   * Espande una `CALL` (macro) in istruzioni semplici. `network` è la rete, da 1. Senza questo
   * hook una `CALL` dà l'errore `CALL_NEEDS_COMPILER`.
   */
  expandCall?: (stmt: Statement, network: number) => Statement[] | { error: Mc7Diagnostic };
  /**
   * Compilatore: riscrive ogni istruzione che non è una `CALL` prima di codificarla (simboli →
   * operandi assoluti o formali). `network` parte da 1.
   */
  rewrite?: (stmt: Statement, network: number) => Statement[] | { error: Mc7Diagnostic };
  /**
   * Compilatore: risolve `#nome` in un parametro formale di FC. Nelle reti modificate ha la
   * precedenza sui metadati; nelle reti invariate (testo originale, `#PARn`) vengono prima i
   * metadati, così un nome attuale uguale a un `PARn` non sposta l'offset.
   */
  formal?: (name: string) => FormalParam | undefined;
  /**
   * Compilatore (regola F): per ogni rete (da 0) se può tenere i byte originali. Una rete con
   * `false` si ricodifica dal testo anche se è uguale a `meta.networkTexts[k]`. Senza questo
   * elenco conta solo il confronto del testo.
   */
  keep?: readonly boolean[];
  /**
   * Compilatore (regola F): per una rete (da 0) col testo invariato ma il contesto dei byte
   * cambiato, la diagnostica dei suoi grezzi al posto di `RAW_IN_CHANGED_NETWORK`.
   */
  contextChanged?: (
    k: number,
  ) => { code: string; message: string; params?: Record<string, string> } | undefined;
}

/**
 * Istruzione prodotta dal compilatore (`expandCall`, `rewrite`) con le opzioni di codifica che il
 * testo non porta: la lista dei puntatori di UC/CC FC/SFC e il byte di tipo di una costante.
 */
export interface CompiledStatement extends Statement {
  encode?: Pick<EncodeOptions, 'pointers' | 'constantType'>;
  /**
   * Riga sorgente (da 0) per la tabella delle righe, se diversa da quella dell'istruzione espansa:
   * le copie di un parametro di una CALL vanno sulla riga del parametro (osservazione).
   */
  line?: number;
}

const RAW_LINE = /^\s*\/\/\s*MC7 grezzo:(.*)$/;
const hexByte = /^[0-9a-fA-F]{2}$/;

function parseHex(s: string): Uint8Array | undefined {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 0 || parts.some((p) => !hexByte.test(p))) return undefined;
  return Uint8Array.from(parts.map((p) => parseInt(p, 16)));
}
const normHex = (s: string): string => s.trim().toLowerCase().split(/\s+/).join(' ');

const jumpCache = new Map<string, boolean>();
function isJumpId(id: string): boolean {
  let v = jumpCache.get(id);
  if (v === undefined) {
    try {
      encodeJump(id, 0);
      v = true;
    } catch {
      v = false;
    }
    jumpCache.set(id, v);
  }
  return v;
}

type Entry = {
  line: number;
  label?: string;
  /** Byte già noti (istruzioni normali e grezzi); i salti li calcola la seconda passata. */
  bytes?: Uint8Array;
  /** Salto: istruzione ed etichetta di destinazione. */
  jump?: { id: string; target: string };
  /** Grezzo che è un salto: ha una voce nella tabella dei salti dell'ADD. */
  rawJump?: boolean;
  /** Grezzo che è un salto: destinazione in byte dall'inizio della sua istruzione. */
  rawTo?: number;
  /** Riga (da 0) nella tabella delle righe, se non è `line - 1` (`CompiledStatement.line`). */
  mapLine?: number;
};

/** Nome `#PARn` / `#PARWn` → offset del campo `wwww` (mc7 §2.2.6). */
function formalOffset(name: string): number | undefined {
  const a = /^PAR(\d+)$/.exec(name);
  if (a) return 2 * (Number(a[1]) + 1);
  const b = /^PARW(\d+)$/.exec(name);
  return b ? Number(b[1]) : undefined;
}

/** Tipo dei parametri formali per nome, ricavato dai metadati e dal testo decodificato. */
function formalTypes(meta: CodeMeta | undefined): Map<string, FormalType> {
  const out = new Map<string, FormalType>();
  if (!meta?.formals || !meta.networkTexts) return out;
  const cache = new Map<number, { stmts: Statement[]; lines: string[] }>();
  for (const [key, type] of Object.entries(meta.formals)) {
    const [k, n] = key.split(':').map(Number) as [number, number];
    const text = meta.networkTexts[k];
    if (text === undefined) continue;
    let c = cache.get(k);
    if (!c) {
      c = { stmts: parseNetwork(text, 'international').statements, lines: text.split(/\r?\n/) };
      cache.set(k, c);
    }
    const st = c.stmts[n];
    const line = st ? c.lines[st.range.from.line] : undefined;
    const m = line ? /#(PARW?\d+)/.exec(line) : null;
    if (m) out.set(m[1]!, type);
  }
  return out;
}

/** Testo con i segnaposto grezzi in forma canonica e `formatNetwork` (spazi e maiuscole non contano). */
function canonical(text: string): string | undefined {
  try {
    const lines = text.split(/\r?\n/).map((l) => {
      const m = RAW_LINE.exec(l);
      return m ? `\t// MC7 grezzo: ${normHex(m[1]!)}` : l;
    });
    return formatNetwork(lines.join('\n'), 'international');
  } catch {
    return undefined;
  }
}

export function sameText(text: string, original: string | undefined): boolean {
  if (original === undefined) return false;
  if (text === original) return true;
  const c = canonical(text);
  return c !== undefined && c === canonical(original);
}

/**
 * Codificatore del codice di un blocco: reti AWL → sezione MC7 + ADD (mc7 §1.5, §2.4, §2.7, §3).
 * È l'inverso di `decodeCode`.
 *
 * ## Fedeltà per rete (sicurezza di modifica)
 *
 * I metadati di `decodeCode` sono legati alla posizione delle istruzioni, quindi valgono solo per
 * una rete **invariata**, cioè uguale a `meta.networkTexts[k]` (anche dopo `formatNetwork`) e,
 * se il compilatore dà `keep`, con `keep[k]` vero: il compilatore toglie una rete dalle invariate
 * quando il contesto dei suoi byte (interfaccia del blocco, chiamati) è cambiato (regola F,
 * `compile.ts`); i suoi grezzi danno allora l'errore di `contextChanged`.
 * - Rete invariata: i grezzi (`// MC7 grezzo: <hex>`) rientrano per posizione, con i byte letti
 *   dalla riga stessa (`meta.raws` serve solo da controllo di integrità), più `constantTypes`; una
 *   `CALL` ricostruita dalla decodifica rimette i byte di `meta.calls` senza `expandCall`.
 * - Rete modificata: si ricodifica dal solo testo. Un segnaposto grezzo è un errore bloccante
 *   (`RAW_IN_CHANGED_NETWORK`); il byte di tipo di una costante si perde (avviso
 *   `CONSTANT_TYPE_LOST`); un grezzo cancellato dà l'avviso `RAW_REMOVED`.
 * - `#PARn` si risolve col tipo del parametro formale noto dai metadati (il tipo dipende dal
 *   nome, quindi vale in tutte le reti del blocco); senza tipo è `FORMAL_UNKNOWN`.
 * - `jumpOrder`, `addJumps` e `addRest` valgono solo se nessuna rete è cambiata e il numero di
 *   reti è lo stesso; altrimenti l'ADD si ricostruisce in ordine di codice, senza resto.
 *
 * Numeri di rete e di riga nelle diagnostiche, e l'argomento `network` di `expandCall` e
 * `rewrite`, partono da 1. Le etichette valgono in tutto il blocco: un salto può andare in
 * un'altra rete (come nel controllo AWL e nei blocchi reali FB80 e FC100).
 *
 * Un salto grezzo (congelato) di una rete invariata può avere la destinazione in un'altra rete: se
 * una rete tra il salto e la destinazione (estremi compresi) è cambiata, lo spostamento non
 * sarebbe più giusto e si dà l'errore `RAW_JUMP_ACROSS_CHANGED`.
 *
 * Con un errore non si restituisce alcun byte (`mc7` e `add` vuoti).
 */
export function encodeCode(
  networks: string[],
  meta?: CodeMeta,
  opts: EncodeCodeOptions = {},
): { mc7: Uint8Array; add: Mc7Add; diagnostics: Mc7Diagnostic[]; lines: LineMapEntry[] } {
  const diagnostics: Mc7Diagnostic[] = [];
  const diag = (
    severity: 'error' | 'warning',
    code: string,
    network: number,
    line: number,
    message: string,
    params?: Record<string, string>,
  ): void => {
    diagnostics.push({ severity, code, network, line, message, ...(params ? { params } : {}) });
  };
  const formals = formalTypes(meta);
  let unresolvedFormal: string | undefined;
  const fromMeta = (name: string): FormalParam | undefined => {
    const offset = formalOffset(name);
    const type = formals.get(name);
    return offset !== undefined && type ? { offset, type } : undefined;
  };
  const formalFn = (name: string): FormalParam | undefined => {
    const found = opts.formal?.(name) ?? fromMeta(name);
    if (!found) unresolvedFormal = name;
    return found;
  };
  // Rete invariata: il testo è quello originale (`#PARn`), quindi prima i metadati.
  const formalKept = (name: string): FormalParam | undefined => {
    const found = fromMeta(name) ?? opts.formal?.(name);
    if (!found) unresolvedFormal = name;
    return found;
  };

  const unchanged = networks.map(
    (t, k) => (opts.keep?.[k] ?? true) && sameText(t, meta?.networkTexts?.[k]),
  );
  const noneChanged =
    meta?.networkTexts !== undefined &&
    networks.length === meta.networkTexts.length &&
    unchanged.every(Boolean);

  // Passata 1: byte delle istruzioni normali, grezzi e salti per rete
  const built: Entry[][] = [];
  networks.forEach((text, k) => {
    const net = k + 1;
    const entries: Entry[] = [];
    built.push(entries);
    const rawLines = text.split(/\r?\n/).flatMap((l, i) => {
      const m = RAW_LINE.exec(l);
      return m ? [{ line: i, hex: m[1]! }] : [];
    });
    const parsed = parseNetwork(text, 'international');
    if (parsed.errors.length) {
      for (const e of parsed.errors) {
        diag(
          'error',
          'SYNTAX',
          net,
          e.range.from.line + 1,
          `Rete ${net}, riga ${e.range.from.line + 1}: errore di sintassi (${e.code}).`,
          { reason: e.code, ...(e.params ?? {}) },
        );
      }
      return;
    }
    const same = unchanged[k]!;
    const originalRaws = (meta?.raws ?? []).filter((r) => r.network === k);
    if (!same) {
      if (rawLines.length) {
        const cause = opts.contextChanged?.(k);
        if (cause)
          diag('error', cause.code, net, rawLines[0]!.line + 1, cause.message, cause.params);
        else {
          diag(
            'error',
            'RAW_IN_CHANGED_NETWORK',
            net,
            rawLines[0]!.line + 1,
            `Rete ${net} modificata: contiene istruzioni MC7 grezze. Ripristinare la rete o rimuovere le righe grezze.`,
          );
        }
        return;
      }
      if (originalRaws.length) {
        diag(
          'warning',
          'RAW_REMOVED',
          net,
          0,
          `Rete ${net} modificata: ${originalRaws.length} istruzioni MC7 grezze non ci sono più e i loro byte non sono nel codice.`,
          { count: String(originalRaws.length) },
        );
      }
      const lost = Object.keys(meta?.constantTypes ?? {}).filter((key) => key.startsWith(`${k}:`));
      if (lost.length) {
        diag(
          'warning',
          'CONSTANT_TYPE_LOST',
          net,
          0,
          `Rete ${net} modificata: ${lost.length} costanti perdono il byte di tipo originale e usano la codifica di base.`,
          { count: String(lost.length) },
        );
      }
    } else if (
      rawLines.length !== originalRaws.length ||
      rawLines.some((r, i) => normHex(r.hex) !== normHex(originalRaws[i]!.bytes))
    ) {
      diag(
        'warning',
        'RAW_META_MISMATCH',
        net,
        0,
        `Rete ${net}: i grezzi nel testo non coincidono con i metadati; si usano i byte delle righe.`,
      );
    }

    // Righe grezze e istruzioni nell'ordine del testo
    type Item = { line: number; raw?: string; stmt?: Statement };
    const items: Item[] = [
      ...rawLines.map((r) => ({ line: r.line, raw: r.hex })),
      ...parsed.statements.map((s) => ({ line: s.range.from.line, stmt: s })),
    ].sort((a, b) => a.line - b.line);

    let n = 0;
    for (const it of items) {
      const line = it.line + 1;
      const fail = (e: unknown): void => {
        const code = e instanceof Mc7Error ? e.code : 'UNSUPPORTED';
        const msg = e instanceof Error ? e.message : String(e);
        diag(
          'error',
          code === 'FORMAT' || code === 'COMPILE' ? code : 'UNSUPPORTED',
          net,
          line,
          `Rete ${net}, riga ${line}: ${msg}`,
        );
      };
      if (it.raw !== undefined) {
        const bytes = parseHex(it.raw);
        if (!bytes) {
          diag(
            'error',
            'RAW_HEX_INVALID',
            net,
            line,
            `Rete ${net}, riga ${line}: esadecimale non valido nel segnaposto grezzo.`,
          );
          continue;
        }
        const d = decodeInstruction(bytes, 0);
        entries.push({
          line,
          bytes,
          ...('stmt' in d && d.stmt.jumpTo !== undefined
            ? { rawJump: true, rawTo: d.stmt.jumpTo }
            : {}),
        });
        continue;
      }
      const src = it.stmt!;
      const key = `${k}:${n++}`;
      const id = src.instruction.def?.id;
      // CALL ricostruita nella decodifica: in una rete invariata tornano i byte originali
      const callHex = same && id === 'CALL' ? meta?.calls?.[key] : undefined;
      const callBytes = callHex !== undefined ? parseHex(callHex) : undefined;
      if (callBytes) {
        entries.push({ line, ...(src.label ? { label: src.label.name } : {}), bytes: callBytes });
        continue;
      }
      let stmts: Statement[] = [src];
      const hook = id === 'CALL' ? opts.expandCall : opts.rewrite;
      if (id === 'CALL' && !hook) {
        diag(
          'error',
          'CALL_NEEDS_COMPILER',
          net,
          line,
          `Rete ${net}, riga ${line}: CALL richiede il compilatore dei blocchi (non disponibile qui).`,
        );
        continue;
      }
      if (hook) {
        const x = hook(src, net);
        if (!Array.isArray(x)) {
          diagnostics.push(x.error);
          continue;
        }
        stmts = x;
        // L'etichetta della riga va sulla prima istruzione prodotta
        if (src.label && stmts[0] && !stmts[0].label)
          stmts = [{ ...stmts[0], label: src.label }, ...stmts.slice(1)];
        else if (src.label && stmts.length === 0) {
          diag(
            'error',
            'UNSUPPORTED',
            net,
            line,
            `Rete ${net}, riga ${line}: un'istruzione con etichetta non può espandersi in nulla.`,
          );
          continue;
        }
      }
      for (const st of stmts) {
        const sid = st.instruction.def?.id;
        const label = st.label?.name;
        if (!sid) {
          fail(new Mc7Error('UNSUPPORTED', `istruzione sconosciuta: ${st.instruction.text}`));
          continue;
        }
        if (isJumpId(sid)) {
          if (st.operand?.kind !== 'labelRef') {
            fail(new Mc7Error('UNSUPPORTED', `${sid} richiede un'etichetta`));
            continue;
          }
          entries.push({
            line,
            ...(label ? { label } : {}),
            jump: { id: sid, target: st.operand.name },
          });
          continue;
        }
        const o: EncodeOptions = {
          ...(st as CompiledStatement).encode,
          formal: same ? formalKept : formalFn,
        };
        unresolvedFormal = undefined;
        const ct = same && id !== 'CALL' ? meta?.constantTypes[key] : undefined;
        if (ct !== undefined) o.constantType = ct;
        try {
          const mapLine = (st as CompiledStatement).line;
          entries.push({
            line,
            ...(label ? { label } : {}),
            ...(mapLine !== undefined ? { mapLine } : {}),
            bytes: encodeInstruction(st, o),
          });
        } catch (e) {
          if (unresolvedFormal !== undefined && formalOffset(unresolvedFormal) !== undefined) {
            diag(
              'error',
              'FORMAL_UNKNOWN',
              net,
              line,
              `Rete ${net}, riga ${line}: il parametro formale #${unresolvedFormal} non ha un tipo noto.`,
              { name: unresolvedFormal },
            );
            continue;
          }
          fail(e);
        }
      }
    }
  });

  // Passata 2: posizioni, etichette, spostamenti
  const code: number[] = [];
  const lengths: number[] = [];
  const codeJumps: number[] = [];
  const lines: LineMapEntry[] = [];
  const origLengths = meta?.networkLengths;
  const origStarts: number[] = [];
  (origLengths ?? []).reduce((a, n) => (origStarts.push(a), a + n), 0);
  /** Salto grezzo congelato: nessuna rete tra salto e destinazione (originali) deve essere cambiata. */
  const checkRawJump = (k: number, at: number, to: number, line: number): void => {
    let lo = 0;
    let hi = networks.length - 1; // senza layout originale: tutto il blocco
    if (origLengths && origLengths.length !== networks.length) {
      diag(
        'error',
        'RAW_JUMP_ACROSS_CHANGED',
        k + 1,
        line,
        'Il numero di reti è cambiato e il blocco contiene salti MC7 grezzi. Ripristinare le reti o rimuovere i salti grezzi.',
        { reason: 'network-count' },
      );
      return;
    }
    if (origLengths) {
      const target = origStarts[k]! + at + to;
      let j = origLengths.findIndex(
        (n, i) => n > 0 && target >= origStarts[i]! && target < origStarts[i]! + n,
      );
      if (j < 0) j = target < origStarts[k]! ? 0 : origLengths.length - 1; // coda/BE: fino all'ultima
      lo = Math.min(k, j);
      hi = Math.max(k, j);
    }
    for (let m = lo; m <= hi; m++) {
      if (m === k || unchanged[m]) continue;
      diag(
        'error',
        'RAW_JUMP_ACROSS_CHANGED',
        k + 1,
        line,
        `Rete ${k + 1}: un salto MC7 grezzo attraversa la rete ${m + 1} modificata. Ripristinare la rete ${m + 1} o rimuovere il salto grezzo.`,
        { changed: String(m + 1) },
      );
      return;
    }
  };
  if (!diagnostics.some((d) => d.severity === 'error')) {
    // Le etichette valgono in tutto il blocco (come nel controllo AWL): un salto può andare in
    // un'altra rete (FB80, FC100 reali). Posizioni assolute nel codice prima di risolvere i salti.
    const layout = built.map((entries) => {
      const starts: number[] = [];
      let pos = 0;
      for (const e of entries) {
        starts.push(pos);
        pos += e.jump ? 4 : e.bytes!.length;
      }
      return { starts, size: pos };
    });
    const bases: number[] = [];
    layout.reduce((a, l) => (bases.push(a), a + l.size), 0);
    const labels = new Map<string, number>();
    built.forEach((entries, k) => {
      entries.forEach((e, i) => {
        if (!e.label) return;
        if (labels.has(e.label)) {
          diag(
            'error',
            'DUPLICATE_LABEL',
            k + 1,
            e.line,
            `Rete ${k + 1}, riga ${e.line}: etichetta ${e.label} definita due volte.`,
            { label: e.label },
          );
        } else labels.set(e.label, bases[k]! + layout[k]!.starts[i]!);
      });
    });
    built.forEach((entries, k) => {
      const net = k + 1;
      const base = code.length;
      const { starts, size: pos } = layout[k]!;
      entries.forEach((e, i) => {
        const at = starts[i]!;
        const length = (starts[i + 1] ?? pos) - at;
        if (length > 0)
          lines.push({ offset: base + at, length, network: k, line: e.mapLine ?? e.line - 1 });
        if (e.rawJump || e.jump) codeJumps.push((base + at) >> 1);
        if (e.rawJump && e.rawTo !== undefined) checkRawJump(k, at, e.rawTo, e.line);
        if (!e.jump) {
          code.push(...e.bytes!);
          return;
        }
        const target = labels.get(e.jump.target);
        if (target === undefined) {
          diag(
            'error',
            'UNKNOWN_LABEL',
            net,
            e.line,
            `Rete ${net}, riga ${e.line}: etichetta ${e.jump.target} non definita.`,
            { label: e.jump.target },
          );
          code.push(0, 0, 0, 0);
          return;
        }
        const list = e.jump.id === 'JL';
        const here = bases[k]! + at;
        const delta = list ? target - here - 4 : target - here;
        if (list && delta < 0) {
          diag(
            'error',
            'JL_TARGET',
            net,
            e.line,
            `Rete ${net}, riga ${e.line}: l'etichetta di JL deve seguire la lista dei salti.`,
          );
          code.push(0, 0, 0, 0);
          return;
        }
        const words = list ? delta / 4 : delta / 2;
        if (!Number.isInteger(words)) {
          diag(
            'error',
            'JUMP_ALIGN',
            net,
            e.line,
            `Rete ${net}, riga ${e.line}: la destinazione di ${e.jump.id} non è allineata.`,
          );
          code.push(0, 0, 0, 0);
          return;
        }
        const [lo, hi] = list ? [0, 0xffff] : [-0x8000, 0x7fff];
        if (words < lo || words > hi) {
          diag(
            'error',
            'JUMP_TOO_FAR',
            net,
            e.line,
            `Rete ${net}, riga ${e.line}: ${e.jump.id} ${e.jump.target} è troppo lontano (${words} parole).`,
            { words: String(words) },
          );
          code.push(0, 0, 0, 0);
          return;
        }
        code.push(...encodeJump(e.jump.id, words));
      });
      lengths.push(pos);
      if (pos > 0xffff) {
        diag('error', 'NETWORK_TOO_LONG', net, 0, `Rete ${net}: più di 65535 byte.`);
      }
    });
  }

  const failed = diagnostics.some((d) => d.severity === 'error');
  if (!failed && codeJumps.some((j) => j > 0xffff)) {
    diag(
      'error',
      'ADD_RANGE',
      0,
      0,
      "La tabella dei salti dell'ADD non può indirizzare questo codice.",
    );
  }
  if (diagnostics.some((d) => d.severity === 'error')) {
    return { mc7: new Uint8Array(0), add: emptyAdd(), diagnostics, lines: [] };
  }

  const tail = meta?.tail !== undefined ? (parseHex(meta.tail) ?? new Uint8Array(0)) : [0x65, 0x00];
  const mc7 = Uint8Array.from([...code, ...tail]);

  let jumps = codeJumps;
  let rest: Uint8Array = new Uint8Array(0);
  if (noneChanged && meta) {
    if (meta.addJumps) jumps = [...meta.addJumps];
    else if (meta.jumpOrder && meta.jumpOrder.length === codeJumps.length) {
      jumps = meta.jumpOrder.map((i) => codeJumps[i]!);
    }
    if (meta.addRest) rest = parseHex(meta.addRest) ?? rest;
  }
  if (meta?.addRest && !(noneChanged && meta.addRest)) {
    diag(
      'warning',
      'ADD_REST_DROPPED',
      0,
      0,
      "Il blocco è stato modificato: il resto dell'ADD (byte ignoti) non viene riscritto.",
    );
  }
  return {
    mc7,
    add: {
      networks: noneChanged && meta?.addNetworks ? [...meta.addNetworks] : lengths,
      jumps,
      rest,
    },
    diagnostics,
    lines,
  };
}
