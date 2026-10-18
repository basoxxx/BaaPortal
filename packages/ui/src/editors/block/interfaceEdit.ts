import { createNamer, type Member, type NewId } from '@baaportal/project';
import { parseType } from '@baaportal/s7-types';
import { toTsv } from '../../grid/tsv';
import { normalizeType } from '../tags/tagRows';
import type { InterfaceOwner, SectionId } from './interfaceRows';

/** Elenco dei membri di una sezione del proprietario (null se non ne ha). */
export function listOf(owner: InterfaceOwner, section: SectionId): Member[] | null {
  switch (owner.kind) {
    case 'OB':
    case 'FB':
    case 'FC': {
      const i = owner.block.interface;
      const lists: Partial<Record<SectionId, Member[]>> = {
        input: i.input,
        output: i.output,
        inOut: i.inOut,
        static: i.static,
        temp: i.temp,
      };
      return lists[section] ?? null;
    }
    case 'DB':
      return section === 'members' ? owner.db.members : null;
    case 'UDT':
      return section === 'members' ? owner.udt.members : null;
    case 'IDB':
      return null;
  }
}

const SECTIONS_WITH_MEMBERS: SectionId[] = [
  'input',
  'output',
  'inOut',
  'static',
  'temp',
  'members',
];

/** Ogni elenco di membri di primo livello del proprietario. */
function topLists(owner: InterfaceOwner): Member[][] {
  return SECTIONS_WITH_MEMBERS.flatMap((s) => {
    const l = listOf(owner, s);
    return l ? [l] : [];
  });
}

export interface Located {
  member: Member;
  list: Member[];
}

function search(list: Member[], id: string): Located | null {
  for (const member of list) {
    if (member.id === id) return { member, list };
    if (member.members) {
      const inner = search(member.members, id);
      if (inner) return inner;
    }
  }
  return null;
}

export function findMember(owner: InterfaceOwner, id: string): Located | null {
  for (const list of topLists(owner)) {
    const found = search(list, id);
    if (found) return found;
  }
  return null;
}

/** Toglie i membri con questi id, ovunque siano (anche dentro le struct). */
export function removeMembers(owner: InterfaceOwner, ids: ReadonlySet<string>): void {
  const strip = (list: Member[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!;
      if (ids.has(m.id)) list.splice(i, 1);
      else if (m.members) strip(m.members);
    }
  };
  for (const list of topLists(owner)) strip(list);
}

/** Nomi dei membri di primo livello di tutte le sezioni, per rendere unico un nome nuovo. */
export function interfaceNames(owner: InterfaceOwner): string[] {
  return topLists(owner).flatMap((l) => l.map((m) => m.name));
}

export function isStructType(text: string): boolean {
  const p = parseType(text);
  if (!p.ok) return false;
  const t = p.type.kind === 'array' ? p.type.element : p.type;
  return t.kind === 'struct';
}

/** Tipo scritto nella cella: normalizzato; `Struct` crea i membri, un altro tipo li toglie. */
export function applyType(member: Member, text: string): void {
  const type = normalizeType(text);
  if (type === member.type) return;
  member.type = type;
  // I valori sostituiti dipendono dal tipo: non valgono più.
  delete member.overrides;
  if (isStructType(type)) member.members ??= [];
  else delete member.members;
}

/** Valore vuoto = cancella la chiave (o il valore iniziale). */
export function setRecord(rec: Record<string, string>, key: string, value: string): void {
  if (value === '') delete rec[key];
  else rec[key] = value;
}

export function setOverride(member: Member, key: string, value: string): void {
  const rec = member.overrides ?? {};
  setRecord(rec, key, value);
  if (Object.keys(rec).length === 0) delete member.overrides;
  else member.overrides = rec;
}

export function newMember(id: string, name: string): Member {
  return { id, name, type: 'Bool', comment: '' };
}

/** Copia profonda con id nuovi; i nomi di primo livello restano unici rispetto a `taken`. */
export function cloneMembers(rows: unknown[], taken: string[], newId: NewId): Member[] {
  const unique = createNamer(taken);
  const copy = (m: Member): Member => {
    const out: Member = { ...m, id: newId() };
    delete out.readOnly;
    if (m.overrides) out.overrides = { ...m.overrides };
    if (m.members) out.members = m.members.map(copy);
    return out;
  };
  const out: Member[] = [];
  for (const r of rows) {
    if (!isMember(r)) continue;
    const m = copy(r);
    if (m.name !== '') m.name = unique(m.name);
    out.push(m);
  }
  return out;
}

const isMember = (x: unknown): x is Member =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as Member).name === 'string' &&
  typeof (x as Member).type === 'string';

/** Colonne: Nome, Tipo di dati, Valore predefinito, Commento. */
export function membersToTsv(members: Member[]): string {
  return toTsv(members.map((m) => [m.name, m.type, m.initial ?? '', m.comment]));
}

export function membersFromTsv(rows: string[][], taken: string[], newId: NewId): Member[] {
  const unique = createNamer(taken);
  return rows.map((r) => {
    const name = r[0] ?? '';
    const type = r[1] === undefined || r[1].trim() === '' ? 'Bool' : normalizeType(r[1]);
    const m: Member = {
      id: newId(),
      name: name === '' ? '' : unique(name),
      type,
      comment: r[3] ?? '',
    };
    if ((r[2] ?? '') !== '') m.initial = r[2]!;
    if (isStructType(type)) m.members = [];
    return m;
  });
}
