import { parseType, type DataType } from '@baaportal/s7-types';
import type { Block, CodeBlock, Member, PlcDevice, Udt } from './model';

// Stessa chiave di sameName.
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();
const SEGMENT = /^(.+?)(\[[^\]]*\])?$/;
const ELEMENT = /^(\[[^\]]*\])(?:\.(.*))?$/;

interface Types {
  udts: Map<string, Udt>;
  fbs: Map<string, CodeBlock>;
}

const baseType = (t: DataType): DataType => (t.kind === 'array' ? baseType(t.element) : t);

const fbMembers = (fb: CodeBlock): Member[] => {
  const i = fb.interface;
  return [...i.input, ...i.output, ...i.inOut, ...i.static];
};

// Membri raggiungibili da un membro: struct locale, UDT o interfaccia di un FB (come nei controlli).
function childrenOf(types: Types, m: Member): Member[] | undefined {
  const parsed = parseType(m.type);
  if (!parsed.ok) return undefined;
  const base = baseType(parsed.type);
  if (base.kind === 'struct') return m.members ?? [];
  if (base.kind !== 'named') return undefined;
  const udt = types.udts.get(nameKey(base.name));
  if (udt) return udt.members;
  const fb = types.fbs.get(nameKey(base.name));
  return fb ? fbMembers(fb) : undefined;
}

/**
 * Percorso come "Asse.Pos.X" o "Lista[1].X" a partire da `roots`: ogni tratto che indica `target`
 * prende il nome nuovo. null se il percorso non passa dal membro.
 */
function rewritePath(
  types: Types,
  roots: Member[],
  path: string,
  target: Member,
  newName: string,
): string | null {
  const segments = path.split('.');
  let list: Member[] | undefined = roots;
  let changed = false;
  for (let i = 0; i < segments.length && list; i++) {
    const seg = SEGMENT.exec(segments[i] ?? '');
    const key = seg?.[1] === undefined ? undefined : nameKey(seg[1]);
    const found: Member | undefined = list.find((x) => nameKey(x.name) === key);
    if (!found) break;
    if (found === target) {
      segments[i] = `${newName}${seg?.[2] ?? ''}`;
      changed = true;
    }
    list = childrenOf(types, found);
  }
  return changed ? segments.join('.') : null;
}

// Valori sostituiti di un membro: `[i]` (con l'eventuale `.percorso` dell'elemento) o `.percorso`.
function rewriteMemberKey(
  types: Types,
  owner: Member,
  key: string,
  target: Member,
  newName: string,
): string | null {
  const roots = childrenOf(types, owner);
  if (!roots) return null;
  const element = ELEMENT.exec(key);
  if (element) {
    const rest = element[2];
    if (rest === undefined) return null;
    const next = rewritePath(types, roots, rest, target, newName);
    return next === null ? null : `${element[1]}.${next}`;
  }
  const dotted = key.startsWith('.');
  const next = rewritePath(types, roots, dotted ? key.slice(1) : key, target, newName);
  return next === null ? null : `${dotted ? '.' : ''}${next}`;
}

// Le chiavi già presenti non si sovrascrivono: il valore resta alla vecchia chiave.
function applyRenames(rec: Record<string, string>, renames: [string, string][]): void {
  for (const [from, to] of renames) {
    if (from === to || Object.hasOwn(rec, to)) continue;
    rec[to] = rec[from] as string;
    delete rec[from];
  }
}

function blockLists(b: Block): Member[][] {
  if (b.kind === 'DB') return [b.members];
  if (b.kind === 'IDB') return [];
  const i = b.interface;
  return [i.input, i.output, i.inOut, i.static, i.temp];
}

function findIn(list: Member[], id: string): Member | undefined {
  for (const m of list) {
    if (m.id === id) return m;
    const inner = m.members ? findIn(m.members, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

function eachMember(list: Member[], visit: (m: Member) => void): void {
  for (const m of list) {
    visit(m);
    if (m.members) eachMember(m.members, visit);
  }
}

// Un nome vuoto o con '.', '[' o ']' non si può scrivere in un percorso.
const pathSafe = (name: string): boolean => name !== '' && !/[.[\]]/.test(name);

/**
 * Rinomina un membro di un blocco o di un UDT (da usare dentro `edit`) e sposta sul nome nuovo le
 * chiavi dei valori sostituiti che passano da lui: nei DB di istanza (anche attraverso multi-istanze)
 * e nei membri di tipo UDT o FB, diretti, in array o annidati.
 */
export function renameMemberWithOverrides(
  device: PlcDevice,
  owner: { kind: 'block' | 'udt'; id: string },
  memberId: string,
  newName: string,
): void {
  const lists =
    owner.kind === 'udt'
      ? device.udts.filter((u) => u.id === owner.id).map((u) => u.members)
      : device.blocks.filter((b) => b.id === owner.id).flatMap(blockLists);
  let target: Member | undefined;
  for (const l of lists) target ??= findIn(l, memberId);
  if (!target) return;
  if (target.name === newName) return;

  if (pathSafe(newName)) {
    const types: Types = { udts: new Map(), fbs: new Map() };
    for (const u of device.udts)
      if (!types.udts.has(nameKey(u.name))) types.udts.set(nameKey(u.name), u);
    for (const b of device.blocks)
      if (b.kind === 'FB' && !types.fbs.has(nameKey(b.name))) types.fbs.set(nameKey(b.name), b);
    const found = target;
    // Le chiavi si calcolano tutte con il nome vecchio, poi si applicano.
    const pending: [Record<string, string>, [string, string][]][] = [];
    const collect = (rec: Record<string, string>, rewrite: (key: string) => string | null) => {
      const renames: [string, string][] = [];
      for (const key of Object.keys(rec)) {
        const next = rewrite(key);
        if (next !== null) renames.push([key, next]);
      }
      if (renames.length > 0) pending.push([rec, renames]);
    };
    for (const b of device.blocks) {
      if (b.kind !== 'IDB') continue;
      const fb = types.fbs.get(nameKey(b.instanceOf));
      if (!fb) continue;
      const roots = fbMembers(fb);
      collect(b.overrides, (key) => rewritePath(types, roots, key, found, newName));
    }
    const visit = (m: Member) => {
      if (m.overrides)
        collect(m.overrides, (key) => rewriteMemberKey(types, m, key, found, newName));
    };
    for (const b of device.blocks) for (const l of blockLists(b)) eachMember(l, visit);
    for (const u of device.udts) eachMember(u.members, visit);
    for (const [rec, renames] of pending) applyRenames(rec, renames);
  }
  target.name = newName;
}
