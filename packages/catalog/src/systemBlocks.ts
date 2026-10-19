import { parseType, sameName, type TypedMember } from '@baaportal/s7-types';
import {
  CPU_MANUAL_2011,
  INSTRUCTION_LIST_2008,
  MANUAL_2010,
  RAW_SYSTEM_BLOCKS,
  type RawSystemBlock,
} from './systemBlocksData';

// Blocchi disponibili sulle CPU PROFINET secondo il manuale CPU, non nell'elenco istruzioni.
const FROM_CPU_MANUAL = new Set(['SFC99', 'SFB73', 'SFB74', 'SFB104']);

export interface SystemBlock {
  kind: 'SFC' | 'SFB';
  number: number;
  name: string;
  input: TypedMember[];
  output: TypedMember[];
  inOut: TypedMember[];
  /** Solo se il manuale pubblico documenta parametri statici. */
  static?: TypedMember[];
  /** Tipo di RET_VAL (solo SFC con valore di ritorno). */
  returnType?: string;
  /** Nomi alternativi dei parametri (alias -> nome canonico), es. SZL_ID per SSL_ID. */
  paramAliases?: Record<string, string>;
  source: string;
}

function members(owner: string, spec: string | string[] | undefined): TypedMember[] {
  if (spec === undefined) return [];
  const items = (Array.isArray(spec) ? spec : [spec]).flatMap((s) =>
    // Le dimensioni degli array contengono spazi ("Array[1..16] of Word"): si divide prima di un nome.
    s.split(/ (?=[A-Za-z_][A-Za-z0-9_]*:)/),
  );
  return items.map((item) => {
    const at = item.indexOf(':');
    const name = item.slice(0, at);
    const parsed = parseType(item.slice(at + 1));
    if (!parsed.ok) throw new Error(`Tipo non valido in ${owner}.${name}`);
    return { name, type: parsed.type };
  });
}

function build(raw: RawSystemBlock): SystemBlock {
  const owner = `${raw.kind} ${raw.number}`;
  const block: SystemBlock = {
    kind: raw.kind,
    number: raw.number,
    name: raw.name,
    input: members(owner, raw.i),
    output: members(owner, raw.o),
    inOut: members(owner, raw.io),
    source: `${MANUAL_2010}${raw.section ? `, section ${raw.section}` : ''}; availability on S7-300: ${
      FROM_CPU_MANUAL.has(`${raw.kind}${raw.number}`) ? CPU_MANUAL_2011 : INSTRUCTION_LIST_2008
    }`,
  };
  if (raw.s !== undefined) block.static = members(owner, raw.s);
  if (raw.ret !== undefined) block.returnType = raw.ret;
  if (raw.aliases !== undefined) block.paramAliases = raw.aliases;
  return block;
}

export const SYSTEM_BLOCKS: readonly SystemBlock[] = RAW_SYSTEM_BLOCKS.map(build);

const byNumber = new Map<string, SystemBlock>(
  SYSTEM_BLOCKS.map((b) => [`${b.kind}${b.number}`, b]),
);
const byName = new Map<string, SystemBlock>(SYSTEM_BLOCKS.map((b) => [b.name.toLowerCase(), b]));

/** Cerca una SFC/SFB per nome (senza distinguere maiuscole) o per tipo e numero. */
export function findSystemBlock(
  ref: { name: string } | { kind: 'SFC' | 'SFB'; number: number },
): SystemBlock | undefined {
  if ('name' in ref) {
    const hit = byName.get(ref.name.toLowerCase());
    return hit !== undefined && sameName(hit.name, ref.name) ? hit : undefined;
  }
  return byNumber.get(`${ref.kind}${ref.number}`);
}
