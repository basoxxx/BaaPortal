import { parseNetwork, type Statement } from '@baaportal/awl';
import {
  RAW_PLACEHOLDER,
  decodeInstruction,
  encodeInstruction,
  encodeJump,
  type DecodedCode,
  type EncodeOptions,
  type FormalType,
} from '../src';

export const hex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
export const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .filter((x) => x)
      .map((x) => parseInt(x, 16)),
  );

type Entry =
  | { raw: Uint8Array }
  | { stmt: Statement; label?: string; key: string; opts: EncodeOptions; jump: boolean };

/**
 * Ricostruisce la sezione MC7 dal solo `DecodedCode` (testo + metadati), senza il codificatore del
 * Task 5: i grezzi per posizione da `meta.raws`, le altre righe con `parseNetwork` +
 * `encodeInstruction`, le etichette risolte a mano. Dà anche l'elenco dei salti dell'ADD.
 */
export function rebuild(d: DecodedCode): { code: Uint8Array; jumps: number[] } {
  const out: number[] = [];
  const codeJumps: number[] = [];
  const nets: { entries: Entry[]; rawJumps: Set<number> }[] = [];
  d.networks.forEach((text, k) => {
    const raws = d.meta.raws.filter((r) => r.network === k);
    let rawIndex = 0;
    const entries: Entry[] = [];
    const rawJumps = new Set<number>();
    let n = 0;
    for (const line of text === '' ? [] : text.split('\n')) {
      const m = /^(?:([A-Za-z0-9_]+):)?\t(.*)$/.exec(line);
      if (!m) throw new Error(`riga inattesa: ${JSON.stringify(line)}`);
      const rest = m[2]!;
      if (rest.startsWith(RAW_PLACEHOLDER)) {
        const r = raws[rawIndex++];
        if (!r) throw new Error('segnaposto senza voce in raws');
        if (rest.slice(RAW_PLACEHOLDER.length) !== r.bytes) throw new Error('segnaposto ≠ raws');
        entries.push({ raw: fromHex(r.bytes) });
        const dj = decodeInstruction(fromHex(r.bytes), 0);
        if ('stmt' in dj && dj.stmt.jumpTo !== undefined) rawJumps.add(entries.length - 1);
        continue;
      }
      if (rest.startsWith('//')) continue;
      const src = rest.replace(/;$/, '');
      const p = parseNetwork(`\t${src};`, 'international');
      if (p.errors.length || p.statements.length !== 1)
        throw new Error(`non analizzabile: ${line}`);
      const st = p.statements[0]!;
      const key = `${k}:${n++}`;
      const ct = d.meta.constantTypes[key];
      const ft: FormalType | undefined = d.meta.formals?.[key];
      const opts: EncodeOptions = {
        ...(ct !== undefined ? { constantType: ct } : {}),
        formal: (name) => {
          const a = /^PAR(\d+)$/.exec(name);
          const b = /^PARW(\d+)$/.exec(name);
          const offset = a ? 2 * (Number(a[1]) + 1) : b ? Number(b[1]) : undefined;
          return offset !== undefined && ft ? { offset, type: ft } : undefined;
        },
      };
      const jump = st.operand?.kind === 'labelRef';
      entries.push({ stmt: st, ...(m[1] ? { label: m[1] } : {}), key, opts, jump });
    }
    if (rawIndex !== raws.length) throw new Error('voci di raws non usate');
    nets.push({ entries, rawJumps });
  });
  // lunghezze, poi etichette (valgono in tutto il blocco), poi byte definitivi
  const encode = (e: Entry, at: number, labels: Map<string, number>): Uint8Array => {
    if ('raw' in e) return e.raw;
    if (!e.jump) return encodeInstruction(e.stmt, e.opts);
    const id = e.stmt.instruction.def!.id;
    if (labels.size === 0) return encodeJump(id, 0);
    const target = labels.get((e.stmt.operand as { name: string }).name);
    if (target === undefined) throw new Error('etichetta mancante');
    const words = id === 'JL' ? (target - at - 4) / 4 : (target - at) / 2;
    return encodeJump(id, words);
  };
  const labels = new Map<string, number>();
  let pos = 0;
  for (const { entries } of nets) {
    for (const e of entries) {
      if (!('raw' in e) && e.label) labels.set(e.label, pos);
      pos += encode(e, pos, new Map()).length;
    }
  }
  for (const { entries, rawJumps } of nets) {
    entries.forEach((e, idx) => {
      const at = out.length;
      if (('raw' in e && rawJumps.has(idx)) || (!('raw' in e) && e.jump)) {
        codeJumps.push(at / 2);
      }
      out.push(...encode(e, at, labels));
    });
  }
  const tail = d.meta.tail ?? '65 00';
  out.push(...fromHex(tail));
  let jumps = codeJumps;
  if (d.meta.addJumps) jumps = d.meta.addJumps;
  else if (d.meta.jumpOrder) jumps = d.meta.jumpOrder.map((i) => codeJumps[i]!);
  return { code: Uint8Array.from(out), jumps };
}
