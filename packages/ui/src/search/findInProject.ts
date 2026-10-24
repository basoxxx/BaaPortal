import type { Block, Network, PlcDevice, Project } from '@baaportal/project';
import { displayText } from '../editors/awl/awlExtensions';
import { hasRawLines, isKnowHowLocked, isLockedImport } from '../editors/block/readOnlyImport';
import type { FindError, FindOptions, Hit, HitLocation } from './types';

/** Un risultato con il modo di calcolare il suo testo sostitutivo (usato da replaceInProject). */
export interface Match {
  hit: Hit;
  /** Testo in cui sono stati calcolati from/to (il testo mostrato per le reti). */
  text: string;
  replacement: (replacement: string) => string;
}

const PREVIEW_MAX = 200;
// Confini di identificatore AWL: lettere, cifre, `_`, `#` e `"` restano dentro la parola.
const WORD = '[\\p{L}\\p{N}_#"]';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Compila la ricerca. Una regex non valida dà un errore, mai un'eccezione. */
export function buildRegExp(o: FindOptions): RegExp | FindError {
  let body = o.regex ? o.query : escapeRegExp(o.query);
  if (o.wholeWord) body = `(?<!${WORD})(?:${body})(?!${WORD})`;
  try {
    return new RegExp(body, `gu${o.matchCase ? '' : 'i'}`);
  } catch (e) {
    return { error: 'REGEX_NON_VALIDA', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Espande `$1`, `$&`, `$<nome>`, `$$`, `` $` `` e `$'` come String.prototype.replace, per un match. */
function expand(tpl: string, m: RegExpExecArray, text: string): string {
  return tpl.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (all, tok: string) => {
    if (tok === '$') return '$';
    if (tok === '&') return m[0];
    if (tok === '`') return text.slice(0, m.index);
    if (tok === "'") return text.slice(m.index + m[0].length);
    if (tok[0] === '<') {
      const g = m.groups;
      return g && tok.slice(1, -1) in g ? (g[tok.slice(1, -1)] ?? '') : all;
    }
    const n = Number(tok);
    if (n >= 1 && n < m.length) return m[n] ?? '';
    // "$12" con un solo gruppo: come JS, vale "$1" seguito da "2".
    if (tok.length === 2 && Number(tok[0]) >= 1 && Number(tok[0]) < m.length) {
      return (m[Number(tok[0])] ?? '') + tok[1];
    }
    return all;
  });
}

function previewOf(text: string, from: number, to: number): string {
  const start = text.lastIndexOf('\n', from - 1) + 1;
  const nl = text.indexOf('\n', to);
  const line = text.slice(start, nl < 0 ? text.length : nl).trim();
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line;
}

type Meta = Pick<Hit, 'editable' | 'reason'>;

function scanText(
  re: RegExp,
  text: string,
  o: FindOptions,
  locate: (from: number, to: number) => HitLocation,
  meta: Meta,
  out: Match[],
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      // Le corrispondenze di lunghezza zero non si riportano e non si sostituiscono.
      re.lastIndex++;
      continue;
    }
    const match = m;
    const from = m.index;
    const to = from + m[0].length;
    const hit: Hit = { loc: locate(from, to), preview: previewOf(text, from, to), ...meta };
    out.push({
      hit,
      text,
      replacement: (r) => (o.regex ? expand(r, match, text) : r),
    });
  }
}

const isProtected = (b: Block): boolean => b.knowHowProtected || isKnowHowLocked(b);

function scanBlock(re: RegExp, o: FindOptions, d: PlcDevice, b: Block, out: Match[]): void {
  const ok: Meta = { editable: true };
  const protectedBlock = isProtected(b);
  const head: Meta = protectedBlock ? { editable: false, reason: 'PROTETTO' } : ok;
  const at =
    (kind: 'blockTitle' | 'blockComment') =>
    (from: number, to: number): HitLocation => ({
      kind,
      deviceId: d.id,
      blockId: b.id,
      from,
      to,
    });
  scanText(re, b.header.title, o, at('blockTitle'), head, out);
  // Di un blocco protetto si cerca solo nel titolo (e nell'interfaccia): mai nel codice.
  if (protectedBlock) return;
  scanText(re, b.header.comment, o, at('blockComment'), ok, out);
  if (b.kind === 'DB' || b.kind === 'IDB') return;
  const unwritable = isLockedImport(b);
  b.networks.forEach((n: Network, i) => {
    const ni = (kind: 'networkTitle' | 'networkComment') => (from: number, to: number) =>
      ({ kind, deviceId: d.id, blockId: b.id, networkIndex: i, from, to }) as HitLocation;
    scanText(re, n.title, o, ni('networkTitle'), ok, out);
    scanText(re, n.comment, o, ni('networkComment'), ok, out);
    const meta: Meta =
      unwritable || hasRawLines(n.source) ? { editable: false, reason: 'MC7_GREZZO' } : ok;
    const shown = displayText(n.source, o.mnemonic === 'de' ? 'german' : 'international');
    scanText(
      re,
      shown,
      o,
      (from, to) => ({
        kind: 'network',
        deviceId: d.id,
        blockId: b.id,
        networkIndex: i,
        from,
        to,
      }),
      meta,
      out,
    );
  });
}

function scanDevice(re: RegExp, o: FindOptions, d: PlcDevice, out: Match[]): void {
  const only = o.scope.kind === 'object' ? o.scope.ref : undefined;
  const wants = (kind: string, id: string): boolean =>
    !only ||
    only.kind === 'device' ||
    (only.kind === kind && 'id' in only && only.id === id) ||
    (only.kind === 'tagTable' && kind === 'tag');
  for (const b of d.blocks) if (wants('block', b.id)) scanBlock(re, o, d, b, out);
  for (const s of d.sources) {
    if (!wants('source', s.id)) continue;
    scanText(
      re,
      s.text,
      o,
      (from, to) => ({ kind: 'source', deviceId: d.id, sourceId: s.id, from, to }),
      { editable: true },
      out,
    );
  }
  for (const t of d.tagTables) {
    for (const tag of t.tags) {
      if (only && only.kind !== 'device') {
        const direct = only.kind === 'tag' && only.id === tag.id;
        if (!direct && !(only.kind === 'tagTable' && only.id === t.id)) continue;
      }
      for (const field of ['name', 'comment'] as const) {
        scanText(
          re,
          tag[field],
          o,
          (from, to) => ({
            kind: 'tag',
            field,
            deviceId: d.id,
            tableId: t.id,
            tagId: tag.id,
            from,
            to,
          }),
          { editable: true },
          out,
        );
      }
    }
  }
}

/** Tutte le corrispondenze con il modo di sostituirle; la ricerca pubblica ne restituisce i soli `hit`. */
export function scanProject(p: Project, o: FindOptions): Match[] | FindError {
  const re = buildRegExp(o);
  if (!(re instanceof RegExp)) return re;
  const out: Match[] = [];
  if (o.query === '') return out;
  const scope = o.scope;
  for (const d of p.devices) {
    if (scope.kind === 'object' && d.id !== scope.ref.deviceId) continue;
    scanDevice(re, o, d, out);
  }
  return out;
}

export function findInProject(p: Project, o: FindOptions): Hit[] | FindError {
  const r = scanProject(p, o);
  return Array.isArray(r) ? r.map((m) => m.hit) : r;
}
