// Rinomina nel testo SCL, sui token del lexer (commenti e stringhe restano come sono): `"Motore"`
// non è `"Motore2"`, `#a` e `a` sono la variabile locale, un nome dopo `.` è un membro, `x :=`
// dentro una chiamata è il parametro del blocco chiamato.
import type { BlockFamily, RenameTarget, Renumber } from '@baaportal/awl';
import { sameName } from '@baaportal/s7-types';
import { isNewAddress, lex, type Tok } from './lexer.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s);
const ARROWS = [':=', '=>'];

export type SclRenameOptions = {
  /** Con `callParam` di un FB: i DB di istanza con cui lo si chiama, `"Inst_DB"(…)`. */
  instanceDbs?: string[];
  /**
   * Con `symbol`: il testo è il codice della FC rinominata, senza variabili col suo nome. Il nome
   * usato come valore di ritorno (`Fc := …`, `#Fc`) la segue (`RET_VAL` se il nome nuovo non è un
   * identificatore SCL).
   */
  ownFc?: boolean;
};

/**
 * Una variabile locale o un parametro si scrivono senza virgolette: con un nome che non è un
 * identificatore SCL (`Motor Speed`, `Velocità`) `renameInScl` lascia il testo com'è.
 */
const needsIdentifier = (target: RenameTarget, newName: string): boolean =>
  (target.kind === 'local' || target.kind === 'callParam') && !IDENT.test(newName);

/** Riscrive `source` sostituendo solo i token che si riferiscono a `target`. */
export function renameInScl(
  source: string,
  target: RenameTarget,
  newName: string,
  opts: SclRenameOptions = {},
): string {
  // Un nome con virgolette o caratteri di controllo romperebbe il codice.
  if (/["\u0000-\u001f\u007f\u2028\u2029]/.test(newName)) return source;
  // `"Motor Speed"` sarebbe un simbolo globale: meglio il nome vecchio, che non compila.
  if (needsIdentifier(target, newName)) return source;
  const edits = sclEdits(source, target, newName, opts);
  if (edits.size === 0) return source;
  let out = '';
  let pos = 0;
  for (const [t, text] of [...edits].sort((a, b) => a[0].from - b[0].from)) {
    out += source.slice(pos, t.from) + text;
    pos = t.from + t.text.length;
  }
  return out + source.slice(pos);
}

/** Vero se `source` usa `target` ma `renameInScl` lo lascia com'è perché `newName` non si può scrivere. */
export function sclRenameSkipped(
  source: string,
  target: RenameTarget,
  newName: string,
  opts: SclRenameOptions = {},
): boolean {
  return needsIdentifier(target, newName) && sclEdits(source, target, 'x', opts).size > 0;
}

function sclEdits(
  source: string,
  target: RenameTarget,
  newName: string,
  opts: SclRenameOptions,
): Map<Tok, string> {
  // `AW1`, `ED0`: per il traduttore restano una variabile se l'interfaccia ne ha una con quel nome
  const toks = lex(source, { errors: [] }).map((t) =>
    t.kind === 'addr' && isNewAddress(t.text) ? { ...t, kind: 'id' as const } : t,
  );
  const quoted = `"${newName}"`;
  const bare = IDENT.test(newName) ? newName : quoted;
  const edits = new Map<Tok, string>();
  const at = (i: number) => toks[i]?.text ?? '';
  /** `x` in `(x :=` o `, x =>`: il nome di un parametro della chiamata. */
  const isParamName = (i: number) =>
    toks[i]!.kind === 'id' && ['(', ','].includes(at(i - 1)) && ARROWS.includes(at(i + 1));
  /** Inizio di un operando: non dopo `.` e non nome di un parametro. */
  const isRoot = (i: number) => at(i - 1) !== '.' && !isParamName(i);
  const isLocal = (i: number, name: string) => {
    const t = toks[i]!;
    if (t.kind === 'local') return sameName(t.text.slice(1), name);
    return t.kind === 'id' && sameName(t.text, name);
  };
  const isCallee = (i: number) => {
    if (target.kind !== 'callParam') return false;
    const t = toks[i]!;
    if (t.kind === 'symbol')
      return [target.block, ...(opts.instanceDbs ?? [])].some((n) => sameName(unquote(t.text), n));
    // una FC si chiama anche senza virgolette: `Fc(…)`
    if (t.kind === 'id' && sameName(t.text, target.block)) return true;
    return (target.instances ?? []).some((n) => isLocal(i, n));
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (!['id', 'local', 'symbol'].includes(t.kind) || !isRoot(i)) continue;
    switch (target.kind) {
      case 'symbol':
        if (t.kind === 'symbol' && sameName(unquote(t.text), target.oldName)) edits.set(t, quoted);
        // la chiamata di una FC senza virgolette: `Fc(…)`
        else if (t.kind === 'id' && at(i + 1) === '(' && sameName(t.text, target.oldName))
          edits.set(t, bare);
        // il nome nuovo potrebbe essere una TEMP o un indirizzo (`x`, `AW2`): sempre RET_VAL
        else if (opts.ownFc && t.kind !== 'symbol' && isLocal(i, target.oldName))
          edits.set(t, t.kind === 'local' ? '#RET_VAL' : 'RET_VAL');
        break;
      case 'local':
        // `Nome(…)` senza `#` chiama un blocco (come in sclToAwl), anche se c'è un locale `Nome`.
        if (t.kind === 'id' && at(i + 1) === '(') break;
        if (isLocal(i, target.oldName)) edits.set(t, t.kind === 'local' ? `#${newName}` : newName);
        break;
      case 'member': {
        const rootOk =
          target.root === 'symbol'
            ? t.kind === 'symbol' &&
              (target.rootName === null || sameName(unquote(t.text), target.rootName))
            : t.kind !== 'symbol' && (target.rootName === null || isLocal(i, target.rootName));
        if (!rootOk) break;
        // I membri dopo la radice, saltando gli indici `[…]`.
        const segs: Tok[] = [];
        let q = i + 1;
        for (;;) {
          if (at(q) === '[') {
            let depth = 0;
            for (; q < toks.length; q++) {
              if (at(q) === '[') depth++;
              if (at(q) === ']' && --depth === 0) break;
            }
            q++;
          }
          if (at(q) !== '.' || !['id', 'symbol'].includes(toks[q + 1]?.kind ?? '')) break;
          segs.push(toks[q + 1]!);
          q += 2;
        }
        const seg = segs[target.path.length];
        if (
          seg &&
          sameName(unquote(seg.text), target.oldName) &&
          target.path.every((n, k) => sameName(unquote(segs[k]!.text), n))
        )
          edits.set(seg, bare);
        break;
      }
      case 'callParam': {
        if (at(i + 1) !== '(' || !isCallee(i)) break;
        let depth = 0;
        for (let q = i + 1; q < toks.length; q++) {
          if (at(q) === '(') depth++;
          else if (at(q) === ')' && --depth === 0) break;
          else if (depth === 1 && isParamName(q) && sameName(toks[q]!.text, target.oldName))
            edits.set(toks[q]!, newName);
        }
        break;
      }
    }
  }
  return edits;
}

/**
 * I riferimenti assoluti ai blocchi (`FC1(…)`, `DB2.DW0`) con i numeri di `renumber`. `unsafe`: il
 * testo sceglie un DB da una variabile (`WORD_TO_BLOCK_DB`), che non si riscrive.
 */
export function renumberInScl(
  source: string,
  renumber: Renumber,
): { source: string; unsafe: boolean } {
  const toks = lex(source, { errors: [] });
  let unsafe = false;
  let out = '';
  let pos = 0;
  toks.forEach((t, i) => {
    if (t.kind !== 'id' || toks[i - 1]?.text === '.') return;
    if (t.text.toUpperCase() === 'WORD_TO_BLOCK_DB') unsafe = true;
    const m = /^(FB|FC|DB)(\d+)$/i.exec(t.text);
    if (!m) return;
    const kind = m[1]!.toUpperCase() as BlockFamily;
    // Senza `#` `DB1`, `FC1` sono anche nomi di variabili locali: è un blocco solo come chiamata
    // `FC1(…)`, `DB1(…)` o accesso `DB1.DW0`.
    const next = toks[i + 1]?.text;
    if (next !== '(' && !(kind === 'DB' && next === '.')) return;
    const n = Number(m[2]);
    const to = renumber(kind, n);
    if (to === undefined || to === n) return;
    out += source.slice(pos, t.from) + m[1] + String(to);
    pos = t.from + t.text.length;
  });
  return { source: out + source.slice(pos), unsafe };
}
