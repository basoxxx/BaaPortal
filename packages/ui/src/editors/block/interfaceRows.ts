import {
  memberPath,
  toTypedMembers,
  typeResolver,
  type CodeBlock,
  type GlobalDb,
  type InstanceDb,
  type Member,
  type PlcDevice,
  type Udt,
} from '@baaportal/project';
import {
  defaultLiteral,
  formatOffset,
  formatType,
  layoutInstance,
  layoutStruct,
  parseType,
  type DataType,
  type LayoutEntry,
  type LayoutResult,
} from '@baaportal/s7-types';

export type SectionId = 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'return' | 'members';
export type InterfaceOwner =
  | { kind: 'OB' | 'FB' | 'FC'; block: CodeBlock }
  | { kind: 'DB'; db: GlobalDb }
  | { kind: 'IDB'; db: InstanceDb }
  | { kind: 'UDT'; udt: Udt };

export interface InterfaceRow {
  /** 'section:<id>' | id del membro | '<id membro>[i,j]' | '<id membro>/<percorso>' | 'return' */
  key: string;
  /** derived = membro di UDT o FB mostrato in sola lettura. */
  kind: 'section' | 'member' | 'element' | 'derived';
  section: SectionId;
  depth: number;
  name: string;
  type: string;
  offset: string;
  initial: string;
  /** Valore proposto (in grigio) quando `initial` è vuoto; '' se il tipo non ha valori. */
  defaultValue: string;
  comment: string;
  editable: { name: boolean; type: boolean; initial: boolean; comment: boolean };
  expandable: boolean;
  memberId?: string;
  /** Dove si salva un valore iniziale sostituito: chiave di `overrides`. */
  overridePath?: string;
  /** Riga che contiene la riga (sezione o struct); null al primo livello. */
  parentKey: string | null;
  /** Righe informative degli OB: grigie, senza modifica né eliminazione. */
  readOnly: boolean;
  /** Può ospitare nuovi membri (sezione o struct modificabile). */
  container: boolean;
}

const MAX_ELEMENTS = 1000;
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();

const SECTION_NAME: Record<SectionId, string> = {
  input: 'Input',
  output: 'Output',
  inOut: 'InOut',
  static: 'Static',
  temp: 'Temp',
  return: 'Return',
  members: 'Static',
};

export const sectionKey = (s: SectionId): string => `section:${s}`;

/** Sezioni in ordine per tipo di proprietario. */
export function sectionsOf(kind: InterfaceOwner['kind']): SectionId[] {
  switch (kind) {
    case 'OB':
      return ['temp'];
    case 'FB':
      return ['input', 'output', 'inOut', 'static', 'temp'];
    case 'FC':
      return ['input', 'output', 'inOut', 'temp', 'return'];
    case 'IDB':
      return ['input', 'output', 'inOut', 'static'];
    case 'DB':
      return ['members'];
    case 'UDT':
      return [];
  }
}

/** Chiavi delle righe di sezione: l'editor le parte da espanse. */
export const defaultExpanded = (kind: InterfaceOwner['kind']): Set<string> =>
  new Set(sectionsOf(kind).map(sectionKey));

// Il valore iniziale non c'è in Temp, InOut (S7-300) e Return.
const hasValues = (s: SectionId): boolean => s !== 'temp' && s !== 'inOut' && s !== 'return';

type DerivedItem = {
  name: string;
  type: string;
  initial?: string;
  comment: string;
  members?: Member[];
  noValue?: boolean;
};

interface Ctx {
  udts: Map<string, Udt>;
  fbs: Map<string, CodeBlock>;
  expanded: ReadonlySet<string>;
  out: InterfaceRow[];
  /** Solo per i DB di istanza: i valori sostituiti, con il percorso dalla radice. */
  idb: InstanceDb | null;
}

const baseOf = (t: DataType): DataType => (t.kind === 'array' ? baseOf(t.element) : t);

function itemOf(m: Member): DerivedItem {
  const item: DerivedItem = { name: m.name, type: m.type, comment: m.comment };
  if (m.initial !== undefined) item.initial = m.initial;
  if (m.members) item.members = m.members;
  return item;
}

/** Membri mostrati sotto un tipo: struct locale, UDT o interfaccia di un FB. */
function childrenOfType(ctx: Ctx, type: DataType | null, members?: Member[]): DerivedItem[] {
  if (!type || type.kind === 'array') return [];
  if (type.kind === 'struct') return (members ?? []).map(itemOf);
  if (type.kind !== 'named') return [];
  const key = nameKey(type.name);
  const udt = ctx.udts.get(key);
  if (udt) return udt.members.map(itemOf);
  const fb = ctx.fbs.get(key);
  if (!fb) return [];
  const i = fb.interface;
  return [
    ...i.input.map(itemOf),
    ...i.output.map(itemOf),
    ...i.inOut.map((m) => ({ ...itemOf(m), noValue: true })),
    ...i.static.map(itemOf),
  ];
}

const parsedType = (text: string): DataType | null => {
  const p = parseType(text);
  return p.ok ? p.type : null;
};

function entryOffset(e: LayoutEntry | undefined, index = 0): string {
  if (!e) return '';
  if (index === 0) return formatOffset(e);
  const bits = e.byte * 8 + e.bit + index * (e.strideBits ?? 0);
  return formatOffset({ byte: Math.floor(bits / 8), bit: bits % 8 });
}

type Offsets = ReadonlyMap<string, LayoutEntry> | null;

function toOffsets(r: LayoutResult): Offsets {
  if (!r.ok) return null;
  const map = new Map<string, LayoutEntry>();
  for (const e of r.entries) if (!map.has(e.path)) map.set(e.path, e);
  return map;
}

const instanceSections = (fb: CodeBlock) => {
  const i = fb.interface;
  return {
    input: toTypedMembers(i.input),
    output: toTypedMembers(i.output),
    inOut: toTypedMembers(i.inOut),
    static: toTypedMembers(i.static),
  };
};

// Indice degli elementi di un array a più dimensioni, in ordine di riga.
function elementIndices(dims: { lo: number; hi: number }[]): number[][] {
  const out: number[][] = [];
  const walk = (d: number, acc: number[]) => {
    if (out.length >= MAX_ELEMENTS) return;
    if (d === dims.length) return void out.push(acc);
    const { lo, hi } = dims[d]!;
    for (let i = lo; i <= hi; i++) walk(d + 1, [...acc, i]);
  };
  walk(0, []);
  return out;
}

const NOT_EDITABLE = { name: false, type: false, initial: false, comment: false };

function makeRow(
  partial: Partial<InterfaceRow> & Pick<InterfaceRow, 'key' | 'kind'>,
): InterfaceRow {
  return {
    section: 'members',
    depth: 0,
    name: '',
    type: '',
    offset: '',
    initial: '',
    defaultValue: '',
    comment: '',
    editable: NOT_EDITABLE,
    expandable: false,
    parentKey: null,
    readOnly: false,
    container: false,
    ...partial,
  };
}

interface Place {
  section: SectionId;
  depth: number;
  parentKey: string | null;
}

function memberRows(
  ctx: Ctx,
  list: readonly Member[],
  at: Place,
  parentPath: string,
  offsets: Offsets,
): void {
  const values = hasValues(at.section);
  for (const m of list) {
    const type = parsedType(m.type);
    const path = memberPath(parentPath, m.name);
    const base = type ? baseOf(type) : null;
    const isArray = type?.kind === 'array';
    const structy = base?.kind === 'struct';
    const valueType = type !== null && defaultLiteral(type) !== null && values;
    const derivedKids = !isArray && !structy ? childrenOfType(ctx, type) : [];
    const elements = type?.kind === 'array' && !structy ? elementIndices(type.dims) : [];
    const locked = ctx.idb !== null || !!m.readOnly;
    const editStruct = structy && !locked;
    const expandable = structy || elements.length > 0 || derivedKids.length > 0;
    const initial = ctx.idb ? (ctx.idb.overrides[path] ?? m.initial ?? '') : (m.initial ?? '');
    const row = makeRow({
      key: m.id,
      kind: 'member',
      section: at.section,
      depth: at.depth,
      name: m.name,
      type: m.type,
      offset: entryOffset(offsets?.get(path)),
      initial: valueType ? initial : '',
      defaultValue: valueType ? (defaultLiteral(type) ?? '') : '',
      comment: m.comment,
      editable: {
        name: !locked,
        type: !locked,
        initial: valueType && !m.readOnly,
        comment: !locked,
      },
      expandable,
      memberId: m.id,
      parentKey: at.parentKey,
      readOnly: !!m.readOnly,
      container: editStruct,
    });
    if (ctx.idb) row.overridePath = path;
    ctx.out.push(row);
    if (!expandable || !ctx.expanded.has(m.id)) continue;

    const inner: Place = { section: at.section, depth: at.depth + 1, parentKey: m.id };
    if (structy) memberRows(ctx, m.members ?? [], inner, path, offsets);
    else if (elements.length > 0 && type?.kind === 'array') {
      const elType = type.element;
      const elValue = defaultLiteral(elType) !== null && values;
      const stride = offsets?.get(path);
      elements.forEach((idx, n) => {
        const label = `[${idx.join(',')}]`;
        const ov = ctx.idb ? `${path}${label}` : label;
        const stored = ctx.idb ? ctx.idb.overrides[ov] : m.overrides?.[ov];
        ctx.out.push(
          makeRow({
            key: `${m.id}${label}`,
            kind: 'element',
            section: at.section,
            depth: inner.depth,
            name: label,
            type: formatType(elType),
            offset: entryOffset(stride, n),
            initial: elValue ? (stored ?? '') : '',
            defaultValue: elValue ? (defaultLiteral(elType) ?? '') : '',
            editable: { ...NOT_EDITABLE, initial: elValue && !m.readOnly },
            memberId: m.id,
            overridePath: ov,
            parentKey: m.id,
          }),
        );
      });
    } else derivedRows(ctx, m, derivedKids, '', inner, path, offsets, values);
  }
}

function derivedRows(
  ctx: Ctx,
  root: Member,
  items: DerivedItem[],
  relPrefix: string,
  at: Place,
  rootPath: string,
  offsets: Offsets,
  values: boolean,
): void {
  for (const item of items) {
    const rel = relPrefix ? `${relPrefix}.${item.name}` : item.name;
    const type = parsedType(item.type);
    const fullPath = `${rootPath}.${rel}`;
    const valueType = type !== null && defaultLiteral(type) !== null && values && !item.noValue;
    const kids = childrenOfType(ctx, type, item.members);
    const key = `${root.id}/${rel}`;
    const ov = ctx.idb ? fullPath : `.${rel}`;
    const stored = ctx.idb ? ctx.idb.overrides[ov] : root.overrides?.[ov];
    ctx.out.push(
      makeRow({
        key,
        kind: 'derived',
        section: at.section,
        depth: at.depth,
        name: item.name,
        type: item.type,
        offset: entryOffset(offsets?.get(fullPath)),
        initial: valueType ? (stored ?? item.initial ?? '') : '',
        defaultValue: valueType ? (defaultLiteral(type) ?? '') : '',
        comment: item.comment,
        editable: { ...NOT_EDITABLE, initial: valueType && !root.readOnly },
        expandable: kids.length > 0,
        memberId: root.id,
        overridePath: ov,
        parentKey: at.parentKey,
      }),
    );
    if (kids.length > 0 && ctx.expanded.has(key))
      derivedRows(
        ctx,
        root,
        kids,
        rel,
        { section: at.section, depth: at.depth + 1, parentKey: key },
        rootPath,
        offsets,
        values,
      );
  }
}

/** Il blocco FB a cui si riferisce un DB di istanza. */
export function instanceFb(device: PlcDevice, db: InstanceDb): CodeBlock | undefined {
  const key = nameKey(db.instanceOf);
  return device.blocks.find((b): b is CodeBlock => b.kind === 'FB' && nameKey(b.name) === key);
}

export function interfaceRows(
  owner: InterfaceOwner,
  device: PlcDevice,
  expanded: ReadonlySet<string>,
): InterfaceRow[] {
  const ctx: Ctx = {
    udts: new Map(device.udts.map((u) => [nameKey(u.name), u])),
    fbs: new Map(
      device.blocks.flatMap((b) => (b.kind === 'FB' ? [[nameKey(b.name), b] as const] : [])),
    ),
    expanded,
    out: [],
    idb: owner.kind === 'IDB' ? owner.db : null,
  };
  const resolve = typeResolver(device);

  // Elenco dei membri e posizioni (offset) per sezione.
  let lists: Partial<Record<SectionId, readonly Member[]>> = {};
  let offsetsOf: (s: SectionId) => Offsets = () => null;
  switch (owner.kind) {
    case 'OB':
    case 'FC':
    case 'FB': {
      const i = owner.block.interface;
      lists = { input: i.input, output: i.output, inOut: i.inOut, static: i.static, temp: i.temp };
      const temp = toOffsets(layoutStruct(toTypedMembers(i.temp), resolve));
      const inst =
        owner.kind === 'FB'
          ? toOffsets(layoutInstance(instanceSections(owner.block), resolve))
          : null;
      offsetsOf = (s) => (s === 'temp' ? temp : s === 'return' ? null : inst);
      break;
    }
    case 'IDB': {
      const fb = instanceFb(device, owner.db);
      if (fb) {
        const i = fb.interface;
        lists = { input: i.input, output: i.output, inOut: i.inOut, static: i.static };
        const inst = toOffsets(layoutInstance(instanceSections(fb), resolve));
        offsetsOf = () => inst;
      }
      break;
    }
    case 'DB': {
      lists = { members: owner.db.members };
      const o = toOffsets(layoutStruct(toTypedMembers(owner.db.members), resolve));
      offsetsOf = () => o;
      break;
    }
    case 'UDT': {
      lists = { members: owner.udt.members };
      const o = toOffsets(layoutStruct(toTypedMembers(owner.udt.members), resolve));
      offsetsOf = () => o;
      break;
    }
  }

  if (owner.kind === 'UDT') {
    memberRows(
      ctx,
      owner.udt.members,
      { section: 'members', depth: 0, parentKey: null },
      '',
      offsetsOf('members'),
    );
    return ctx.out;
  }
  for (const section of sectionsOf(owner.kind)) {
    const key = sectionKey(section);
    const addable = section !== 'return' && owner.kind !== 'IDB';
    ctx.out.push(
      makeRow({
        key,
        kind: 'section',
        section,
        name: SECTION_NAME[section],
        expandable: true,
        container: addable,
      }),
    );
    if (!expanded.has(key)) continue;
    if (section === 'return' && owner.kind === 'FC') {
      ctx.out.push(
        makeRow({
          key: 'return',
          kind: 'member',
          section,
          depth: 1,
          name: 'Ret_Val',
          type: owner.block.interface.returnType,
          editable: { ...NOT_EDITABLE, type: true },
          parentKey: key,
        }),
      );
      continue;
    }
    memberRows(
      ctx,
      lists[section] ?? [],
      { section, depth: 1, parentKey: key },
      '',
      offsetsOf(section),
    );
  }
  return ctx.out;
}

/** Posizione di una riga `<Aggiungi>`: dove va e a quale elenco di membri appartiene. */
export interface AddSlot {
  /** 'section:<id>', id del membro struct, o null per il primo livello di un UDT. */
  containerKey: string | null;
  section: SectionId;
  /** Ultima riga visibile del contenitore (o la riga stessa se è vuoto). */
  afterKey: string | null;
}

export function addSlots(
  rows: readonly InterfaceRow[],
  kind: InterfaceOwner['kind'],
  expanded: ReadonlySet<string>,
): AddSlot[] {
  const slots: { slot: AddSlot; depth: number }[] = [];
  rows.forEach((row, i) => {
    if (!row.container || !expanded.has(row.key)) return;
    let end = i;
    while (rows[end + 1] && rows[end + 1]!.depth > row.depth) end++;
    slots.push({
      slot: { containerKey: row.key, section: row.section, afterKey: rows[end]!.key },
      depth: row.depth,
    });
  });
  // I contenitori più interni vengono prima, come le righe <Aggiungi> annidate.
  slots.sort((a, b) => b.depth - a.depth);
  const out = slots.map((s) => s.slot);
  if (kind === 'UDT')
    out.push({
      containerKey: null,
      section: 'members',
      afterKey: rows[rows.length - 1]?.key ?? null,
    });
  return out;
}

export function ownerOf(
  device: PlcDevice,
  ref: { kind: 'block' | 'udt'; id: string },
): InterfaceOwner | undefined {
  if (ref.kind === 'udt') {
    const udt = device.udts.find((u) => u.id === ref.id);
    return udt && { kind: 'UDT', udt };
  }
  const b = device.blocks.find((x) => x.id === ref.id);
  if (!b) return undefined;
  if (b.kind === 'DB') return { kind: 'DB', db: b };
  if (b.kind === 'IDB') return { kind: 'IDB', db: b };
  return { kind: b.kind, block: b };
}
