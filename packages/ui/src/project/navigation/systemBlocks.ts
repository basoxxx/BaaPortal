import { parseNetwork } from '@baaportal/awl';
import { findSystemBlock } from '@baaportal/catalog';
import { blockSources, findSystemFb, type Member, type PlcDevice } from '@baaportal/project';
import { parseType, sameName } from '@baaportal/s7-types';

export interface SystemBlockUse {
  kind: 'SFC' | 'SFB';
  number: number;
  name: string;
}

type Call = { name: string } | { kind: 'SFC' | 'SFB'; number: number };

const CALLS = new Set(['CALL', 'UC', 'CC']);
const MAX_CACHED = 4000;
// Le chiamate di un segmento dipendono solo dal suo testo: si riusano finché il testo non cambia.
const cache = new Map<string, Call[]>();

function callsIn(source: string): Call[] {
  const hit = cache.get(source);
  if (hit) return hit;
  const out: Call[] = [];
  for (const s of parseNetwork(source, 'international').statements) {
    const op = s.operand;
    if (!op || !CALLS.has(s.instruction.text.toUpperCase())) continue;
    if (op.kind === 'block' && (op.blockKind === 'SFC' || op.blockKind === 'SFB')) {
      out.push({ kind: op.blockKind, number: op.number });
    } else if (op.kind === 'symbol' && op.path.length === 1) {
      out.push({ name: op.path[0]!.name });
    }
  }
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(source, out);
  return out;
}

/** I nomi di tipo (anche come elemento di un array) usati dai membri, struct comprese. */
function typeNames(members: Member[], out: Set<string>): void {
  for (const m of members) {
    const parsed = parseType(m.type);
    if (parsed.ok) {
      const t = parsed.type;
      if (t.kind === 'named') out.add(t.name);
      else if (t.kind === 'array' && t.element.kind === 'named') out.add(t.element.name);
    }
    if (m.members) typeNames(m.members, out);
  }
}

/**
 * Le SFC e le SFB che il dispositivo usa: richiamate dal codice (`CALL "TON"`, `CALL SFC 1`, UC, CC),
 * come tipo di un DB di istanza o come multi-istanza nei dati Static di un FB. Un blocco o un UDT del
 * progetto con lo stesso nome ha la precedenza. Ordinate per nome.
 */
export function systemBlocksOf(device: PlcDevice): SystemBlockUse[] {
  const found = new Map<string, SystemBlockUse>();
  const add = (b: ReturnType<typeof findSystemBlock>) => {
    if (b) found.set(`${b.kind}${b.number}`, { kind: b.kind, number: b.number, name: b.name });
  };
  const own = (name: string) =>
    device.blocks.some((b) => b.kind !== 'IDB' && b.kind !== 'DB' && sameName(b.name, name)) ||
    device.udts.some((u) => sameName(u.name, name));
  for (const b of device.blocks) {
    if (b.kind === 'DB') continue;
    if (b.kind === 'IDB') {
      if (!own(b.instanceOf)) add(findSystemFb(b.instanceOf));
      continue;
    }
    for (const source of blockSources(b, device)) {
      for (const c of callsIn(source)) {
        if ('name' in c) {
          if (!own(c.name)) add(findSystemBlock({ name: c.name }));
        } else add(findSystemBlock(c));
      }
    }
    if (b.kind === 'FB') {
      const names = new Set<string>();
      typeNames(b.interface.static, names);
      for (const name of names) if (!own(name)) add(findSystemFb(name));
    }
  }
  return [...found.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}
