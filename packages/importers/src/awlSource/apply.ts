// Applica una sorgente letta a un dispositivo: crea o sostituisce UDT, blocchi e DB.
import { findCpu, findOb, OB_DEFINITIONS, SYSTEM_BLOCKS } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createUdt,
  nextFreeNumber,
  symbolNames,
  uniqueName,
  type Block,
  type CodeBlock,
  type Member,
  type NewId,
  type ObjectRef,
  type PlcDevice,
  type Udt,
} from '@baaportal/project';
import { formatType, sameName } from '@baaportal/s7-types';
import type { SourceUnit } from './types';

const FALLBACK_MAX = 65535;
const PLACEHOLDER = /"@(FB|UDT|SFB):(\d+)"/g;

type Kind = 'UDT' | 'OB' | 'FB' | 'FC' | 'DB';

const reId = (list: Member[], newId: NewId): Member[] =>
  list.map((m) => {
    const out: Member = { ...m, id: newId() };
    if (m.members) out.members = reId(m.members, newId);
    if (m.overrides) out.overrides = { ...m.overrides };
    return out;
  });

function maxFor(device: PlcDevice, kind: Kind): number {
  const limits = findCpu(device.cpu.typeId)?.limits;
  if (kind === 'FB') return limits?.maxFb ?? FALLBACK_MAX;
  if (kind === 'FC') return limits?.maxFc ?? FALLBACK_MAX;
  if (kind === 'DB') return limits?.maxDb ?? FALLBACK_MAX;
  return FALLBACK_MAX;
}

function freeNumber(device: PlcDevice, kind: Kind): number {
  const n = nextFreeNumber(device, kind, maxFor(device, kind));
  if (n !== null) return n;
  const used = [...device.udts.map((u) => u.number), ...device.blocks.map((b) => b.number)];
  return Math.max(0, ...used) + 1;
}

const familyOf = (kind: string): string => (kind === 'IDB' ? 'DB' : kind);

/** Nome di un oggetto indicato solo per numero: quello del catalogo per un OB, altrimenti `FB3`, `DB5`. */
function defaultName(device: PlcDevice, unitKind: SourceUnit['kind'], number: number): string {
  const base =
    unitKind === 'OB'
      ? (findOb(number)?.defaultName ?? `OB${number}`)
      : `${familyOf(unitKind)}${number}`;
  return uniqueName(base, symbolNames(device));
}

/**
 * Chi usa già `name` nel dispositivo (`FC3`, `UDT2` o il simbolo stesso), se qualcuno lo usa: un
 * oggetto nuovo non può prendere il nome di un altro blocco, UDT o simbolo.
 */
export function nameOwner(device: PlcDevice, name: string): string | undefined {
  const b = device.blocks.find((x) => sameName(x.name, name));
  if (b) return `${familyOf(b.kind)}${b.number}`;
  const u = device.udts.find((x) => sameName(x.name, name));
  if (u) return `UDT${u.number}`;
  const tag = symbolNames(device).find((n) => sameName(n, name));
  return tag === undefined ? undefined : `"${tag}"`;
}

/** L'oggetto del dispositivo che l'unità sostituirebbe (stessa famiglia, per numero o per nome). */
export function findExisting(device: PlcDevice, unit: SourceUnit): Udt | Block | undefined {
  const byNumber = unit.number !== undefined;
  if (unit.kind === 'UDT') {
    return device.udts.find((u) =>
      byNumber ? u.number === unit.number : sameName(u.name, unit.name),
    );
  }
  const sameFamily = (b: Block): boolean => familyOf(b.kind) === familyOf(unit.kind);
  const hit = device.blocks.find(
    (b) => sameFamily(b) && (byNumber ? b.number === unit.number : sameName(b.name, unit.name)),
  );
  if (hit || byNumber || unit.kind !== 'OB') return hit;
  // Un OB per nome del catalogo è l'OB di quel numero, anche se nel dispositivo ha un altro nome.
  const catalog = catalogNumber(unit);
  return catalog === undefined
    ? undefined
    : device.blocks.find((b) => sameFamily(b) && b.number === catalog);
}

/** Numero dell'OB del catalogo con il nome dell'unità, se c'è. */
const catalogNumber = (unit: SourceUnit): number | undefined =>
  OB_DEFINITIONS.find((o) => sameName(o.defaultName, unit.name))?.number;

function markStartInfo(block: CodeBlock): void {
  if (block.kind !== 'OB') return;
  const info = findOb(block.number)?.startInfo ?? [];
  for (const m of block.interface.temp) {
    if (info.some((s) => s.name === m.name && formatType(s.type) === m.type)) m.readOnly = true;
  }
}

type Target = { kind: 'udt'; obj: Udt } | { kind: 'block'; obj: Block };

const typeKey = (type: string): string => type.replace(/\s+/g, '').normalize('NFC').toLowerCase();

/**
 * I valori iniziali dei membri composti (`overrides`) non hanno una forma nella sorgente: quando la
 * sorgente sostituisce un oggetto, ogni membro allo stesso percorso (stesso nome, a ogni livello) e
 * con lo stesso tipo riprende quelli dell'oggetto vecchio che la sorgente non dà. Un array con valori
 * iniziali nella sorgente (`:= 1, 2, 3`) ha già i suoi elementi.
 */
function carryOverrides(from: Member[], to: Member[]): void {
  for (const m of to) {
    const old = from.find((o) => sameName(o.name, m.name));
    if (!old || typeKey(old.type) !== typeKey(m.type)) continue;
    const hasInitial = m.initial !== undefined && m.initial !== '';
    for (const [key, value] of Object.entries(old.overrides ?? {})) {
      if (hasInitial && key.startsWith('[')) continue;
      if (m.overrides && Object.hasOwn(m.overrides, key)) continue;
      (m.overrides ??= {})[key] = value;
    }
    if (old.members && m.members) carryOverrides(old.members, m.members);
  }
}

const SECTIONS = ['input', 'output', 'inOut', 'static', 'temp'] as const;

/**
 * Riporta i valori composti dell'oggetto sostituito (UDT e interfacce; i DB li hanno in BEGIN).
 * `old` è della stessa famiglia di `next` (lo garantisce findExisting).
 */
function keepStartValues(old: Udt | Block, next: Target): void {
  if (next.kind === 'udt') {
    carryOverrides((old as Udt).members, next.obj.members);
    return;
  }
  const b = next.obj;
  const o = old as Block;
  if (b.kind === 'DB' || b.kind === 'IDB' || o.kind === 'DB' || o.kind === 'IDB') return;
  for (const s of SECTIONS) carryOverrides(o.interface[s], b.interface[s]);
}

/**
 * Applica la sorgente al dispositivo, sul posto (da chiamare dentro un solo `edit`). Ordine: UDT, poi
 * OB/FB/FC, poi DB e DB di istanza. Un nome già presente (stessa famiglia) sostituisce l'oggetto e ne
 * tiene id, gruppo e numero; un'unità indicata per numero tiene quel numero (e, se esiste, il nome).
 */
export function applySource(
  device: PlcDevice,
  parsed: { units: SourceUnit[] },
  newId: NewId,
): { created: ObjectRef[]; replaced: ObjectRef[] } {
  const created: ObjectRef[] = [];
  const replaced: ObjectRef[] = [];
  const touched: Target[] = [];

  const build = (unit: SourceUnit, number: number, name: string): Target => {
    if (unit.kind === 'UDT') {
      const u = createUdt({ name, number, newId });
      Object.assign(u, {
        title: unit.udt.title,
        comment: unit.udt.comment,
        headerName: unit.udt.headerName,
        author: unit.udt.author,
        family: unit.udt.family,
        version: unit.udt.version,
        members: reId(unit.udt.members, newId),
      });
      return { kind: 'udt', obj: u };
    }
    if (unit.kind === 'DB') {
      const b = createGlobalDb({ number, name, newId });
      b.header = { ...unit.db.header };
      b.knowHowProtected = unit.db.knowHowProtected;
      b.attributes = { ...unit.db.attributes };
      b.members = reId(unit.db.members, newId);
      return { kind: 'block', obj: b };
    }
    if (unit.kind === 'IDB') {
      const b = createInstanceDb({ number, name, instanceOf: unit.instanceOf, newId });
      b.header = { ...unit.header };
      b.knowHowProtected = unit.knowHowProtected;
      b.attributes = { ...unit.attributes };
      b.overrides = { ...unit.overrides };
      return { kind: 'block', obj: b };
    }
    const src = unit.block;
    const b = createCodeBlock({ kind: unit.kind, number, name, language: src.language, newId });
    b.header = { ...src.header };
    b.knowHowProtected = src.knowHowProtected;
    b.interface = {
      input: reId(src.interface.input, newId),
      output: reId(src.interface.output, newId),
      inOut: reId(src.interface.inOut, newId),
      static: reId(src.interface.static, newId),
      temp: reId(src.interface.temp, newId),
      returnType: unit.kind === 'FC' ? src.interface.returnType : '',
    };
    b.networks = src.networks.map((n) => ({ ...n, id: newId() }));
    markStartInfo(b);
    return { kind: 'block', obj: b };
  };

  const groups: SourceUnit[][] = [
    parsed.units.filter((u) => u.kind === 'UDT'),
    parsed.units.filter((u) => u.kind === 'OB' || u.kind === 'FB' || u.kind === 'FC'),
    parsed.units.filter((u) => u.kind === 'DB' || u.kind === 'IDB'),
  ];
  for (const g of groups) placeGroup(g);
  resolveRefs(device, touched);
  return { created, replaced };

  function placeGroup(units: SourceUnit[]): void {
    const first = units.filter(
      (u) => u.number !== undefined || findExisting(device, u) !== undefined,
    );
    const rest = units.filter((u) => !first.includes(u));
    for (const u of first) applyOne(u);
    for (const u of rest) applyOne(u);
  }

  function applyOne(unit: SourceUnit): void {
    const existing = findExisting(device, unit);
    if (existing) {
      // Per numero (anche quello del catalogo) l'oggetto tiene il proprio nome.
      const keepName =
        unit.number !== undefined || (unit.kind === 'OB' && !sameName(existing.name, unit.name));
      const name = keepName ? existing.name : unit.name;
      const t = build(unit, existing.number, name);
      keepStartValues(existing, t);
      t.obj.id = existing.id;
      t.obj.group = existing.group;
      if (t.kind === 'udt') device.udts[device.udts.indexOf(existing as Udt)] = t.obj;
      else device.blocks[device.blocks.indexOf(existing as Block)] = t.obj;
      replaced.push(refOf(device, t));
      touched.push(t);
      return;
    }
    const kind: Kind = unit.kind === 'IDB' ? 'DB' : unit.kind;
    const number =
      unit.number ??
      (unit.kind === 'OB' ? catalogNumber(unit) : undefined) ??
      freeNumber(device, kind);
    // Non si crea mai un oggetto con un numero già usato: lo evitano la sostituzione e freeNumber.
    const taken =
      unit.kind === 'UDT'
        ? device.udts.some((u) => u.number === number)
        : device.blocks.some(
            (b) => familyOf(b.kind) === familyOf(unit.kind) && b.number === number,
          );
    if (taken) throw new Error(`Numero ${unit.kind} ${number} già in uso`);
    const owner = unit.name !== '' ? nameOwner(device, unit.name) : undefined;
    if (owner) throw new Error(`Nome "${unit.name}" già usato da ${owner}`);
    const name = unit.name !== '' ? unit.name : defaultName(device, unit.kind, number);
    const t = build(unit, number, name);
    if (t.kind === 'udt') device.udts.push(t.obj);
    else device.blocks.push(t.obj);
    created.push(refOf(device, t));
    touched.push(t);
  }
}

function refOf(device: PlcDevice, t: Target): ObjectRef {
  return t.kind === 'udt'
    ? { kind: 'udt', deviceId: device.id, id: t.obj.id }
    : { kind: 'block', deviceId: device.id, id: t.obj.id };
}

/** Nome dell'oggetto che il riferimento per numero indica (`@FB:3`), o il nome predefinito. */
function nameOfNumber(device: PlcDevice, kw: string, number: number): string {
  if (kw === 'UDT') return device.udts.find((u) => u.number === number)?.name ?? `UDT${number}`;
  if (kw === 'SFB') {
    return (
      SYSTEM_BLOCKS.find((b) => b.kind === 'SFB' && b.number === number)?.name ?? `SFB${number}`
    );
  }
  return device.blocks.find((b) => b.kind === 'FB' && b.number === number)?.name ?? `FB${number}`;
}

function resolveMembers(device: PlcDevice, list: Member[]): void {
  for (const m of list) {
    m.type = m.type.replace(
      PLACEHOLDER,
      (_, kw: string, n: string) => `"${nameOfNumber(device, kw, Number(n))}"`,
    );
    if (m.members) resolveMembers(device, m.members);
  }
}

function resolveRefs(device: PlcDevice, touched: Target[]): void {
  for (const t of touched) {
    if (t.kind === 'udt') resolveMembers(device, t.obj.members);
    else if (t.obj.kind === 'DB') resolveMembers(device, t.obj.members);
    else if (t.obj.kind === 'IDB') {
      const m = /^@(FB|SFB):(\d+)$/.exec(t.obj.instanceOf);
      if (m) t.obj.instanceOf = nameOfNumber(device, m[1]!, Number(m[2]));
    } else {
      const i = t.obj.interface;
      for (const list of [i.input, i.output, i.inOut, i.static, i.temp])
        resolveMembers(device, list);
    }
  }
}
