// Più file esportati da STEP 7 V5.5 letti insieme: sorgenti AWL e SCL e tabelle dei simboli.
import type { PlcDevice } from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import { applySource } from '../awlSource/apply';
import { decodeSourceBytes, type SourceEncoding } from '../awlSource/decode';
import { parseAwlSource } from '../awlSource/parse';
import type { SourceError, SourceUnit } from '../awlSource/types';
import type { RowError, TagRow } from '../tags/rows';
import { parseSclSource } from './scl';
import { parseStep7Symbols, type BlockSymbol, type Step7SymbolFormat } from './symbols';

/** Oltre questa dimensione un file non si legge (un'esportazione reale è molto più piccola). */
export const MAX_STEP7_FILE_BYTES = 16 * 1024 * 1024;
export const STEP7_EXTENSIONS = ['awl', 'scl', 'sdf', 'seq', 'dif', 'asc'] as const;

export type Step7FileKind = 'awl' | 'scl' | 'symbols' | 'unknown';

export interface Step7FileResult {
  name: string;
  kind: Step7FileKind;
  encoding?: SourceEncoding;
  /** File non letto (`FILE_TOO_LARGE`, `UNKNOWN_FORMAT`) o sorgente con errori: non si importa nulla. */
  errors: SourceError[];
  /** Righe scartate di una tabella dei simboli (le altre si importano). */
  rowErrors: RowError[];
  /** Avvisi: testo spostato (SCL) o unità già data da un altro file (`DUPLICATE_UNIT`). */
  warnings: SourceError[];
}

export interface Step7Unit {
  unit: SourceUnit;
  file: string;
}

export interface Step7Read {
  files: Step7FileResult[];
  /** Unità di tutte le sorgenti lette senza errori, coi numeri e i nomi dai simboli. */
  units: Step7Unit[];
  tags: (TagRow & { file: string })[];
  blocks: (BlockSymbol & { file: string })[];
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

const familyOf = (kind: string): string => (kind === 'IDB' ? 'DB' : kind);

export const unitKey = (u: SourceUnit): string =>
  u.number !== undefined
    ? `${familyOf(u.kind)}#${u.number}`
    : `${familyOf(u.kind)}:${u.name.normalize('NFC').toLowerCase()}`;

function parseSource(kind: 'awl' | 'scl', text: string, device: PlcDevice) {
  if (kind === 'scl') return parseSclSource(text, device);
  const r = parseAwlSource(text, device);
  return r.ok ? { ...r, warnings: [] } : r;
}

/**
 * Numeri e nomi delle unità dai simboli dei blocchi: un'unità per nome prende il numero del simbolo
 * omonimo della stessa famiglia, un'unità per numero il nome del simbolo di quel numero.
 */
function numberFromSymbols(units: SourceUnit[], blocks: BlockSymbol[]): void {
  for (const u of units) {
    const fam = familyOf(u.kind);
    const sym = blocks.find(
      (b) =>
        b.kind === fam &&
        (u.number !== undefined ? b.number === u.number : sameName(b.name, u.name)),
    );
    if (!sym) continue;
    if (u.number === undefined) u.number = sym.number;
    if (u.name === '') u.name = sym.name;
  }
}

/**
 * Legge i file di un'esportazione di STEP 7. Le tabelle dei simboli si leggono per prime: danno numeri
 * e nomi alle unità. Le sorgenti si leggono due volte se ci sono UDT: la seconda con gli UDT di tutti i
 * file già nel dispositivo, così un DB che usa un UDT di un altro file è un DB globale con i suoi membri.
 * Non cambia `device`.
 */
export function readStep7Files(
  files: readonly { name: string; bytes: Uint8Array }[],
  device: PlcDevice,
): Step7Read {
  const results: Step7FileResult[] = [];
  const texts: { result: Step7FileResult; kind: 'awl' | 'scl'; text: string }[] = [];
  const tags: Step7Read['tags'] = [];
  const blocks: Step7Read['blocks'] = [];
  const tagNames = new Set<string>();
  const blockNames = new Set<string>();
  for (const f of files) {
    const ext = extOf(f.name);
    const kind: Step7FileKind =
      ext === 'awl' || ext === 'scl'
        ? ext
        : (STEP7_EXTENSIONS as readonly string[]).includes(ext)
          ? 'symbols'
          : 'unknown';
    const result: Step7FileResult = { name: f.name, kind, errors: [], rowErrors: [], warnings: [] };
    results.push(result);
    if (kind === 'unknown') {
      result.errors.push({ line: 1, col: 1, code: 'UNKNOWN_FORMAT', params: { name: f.name } });
      continue;
    }
    if (f.bytes.length > MAX_STEP7_FILE_BYTES) {
      result.errors.push({ line: 1, col: 1, code: 'FILE_TOO_LARGE', params: { name: f.name } });
      continue;
    }
    const { text, encoding } = decodeSourceBytes(f.bytes);
    result.encoding = encoding;
    if (kind !== 'symbols') {
      texts.push({ result, kind, text });
      continue;
    }
    const parsed = parseStep7Symbols(text, ext as Step7SymbolFormat);
    result.rowErrors.push(...parsed.errors);
    // Un nome già dato da un file precedente: vale il primo.
    for (const t of parsed.tags) {
      const key = t.name.toLowerCase();
      if (tagNames.has(key) || blockNames.has(key)) {
        result.rowErrors.push({ line: t.line, code: 'NOME_DOPPIO', detail: t.name });
      } else {
        tagNames.add(key);
        tags.push({ ...t, file: f.name });
      }
    }
    for (const b of parsed.blocks) {
      const key = b.name.toLowerCase();
      if (tagNames.has(key) || blockNames.has(key)) {
        result.rowErrors.push({ line: b.line, code: 'NOME_DOPPIO', detail: b.name });
      } else {
        blockNames.add(key);
        blocks.push({ ...b, file: f.name });
      }
    }
  }

  const readAll = (dev: PlcDevice): Step7Unit[] => {
    const out: Step7Unit[] = [];
    const seen = new Set<string>();
    for (const t of texts) {
      t.result.errors = [];
      t.result.warnings = [];
      const r = parseSource(t.kind, t.text, dev);
      if (!r.ok) {
        t.result.errors = r.errors;
        continue;
      }
      t.result.warnings.push(...r.warnings);
      numberFromSymbols(r.source.units, blocks);
      for (const unit of r.source.units) {
        const key = unitKey(unit);
        if (seen.has(key)) {
          t.result.warnings.push({
            line: 1,
            col: 1,
            code: 'DUPLICATE_UNIT',
            params: { name: unit.name || String(unit.number) },
          });
          continue;
        }
        seen.add(key);
        out.push({ unit, file: t.result.name });
      }
    }
    return out;
  };

  let units = readAll(device);
  const udts = units.filter((u) => u.unit.kind === 'UDT').map((u) => u.unit);
  if (udts.length > 0 && texts.length > 1) {
    const scratch = structuredClone(device);
    let n = 0;
    try {
      applySource(scratch, { units: udts }, () => `step7-${++n}`);
      units = readAll(scratch);
    } catch {
      // UDT non applicabili (numeri in conflitto): restano i risultati della prima lettura.
    }
  }
  return { files: results, units, tags, blocks };
}
