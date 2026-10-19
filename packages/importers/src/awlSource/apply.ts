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

function defaultName(device: PlcDevice, unitKind: SourceUnit['kind'], number: number): string {
  const base =
    unitKind === 'OB' ? (findOb(number)?.defaultName ?? `OB${number}`) : `${unitKind}${number}`;
  return uniqueName(base, symbolNames(device));
}

const familyOf = (kind: string): string => (kind === 'IDB' ? 'DB' : kind);

function findExisting(device: PlcDevice, unit: SourceUnit): Udt | Block | undefined {
  const byNumber = unit.number !== undefined;
  if (unit.kind === 'UDT') {
    return device.udts.find((u) =>
      byNumber ? u.number === unit.number : sameName(u.name, unit.name),
    );
  }
  return device.blocks.find(
    (b) =>
      familyOf(b.kind) === familyOf(unit.kind) &&
      (byNumber ? b.number === unit.number : sameName(b.name, unit.name)),
  );
}

function markStartInfo(block: CodeBlock): void {
  if (block.kind !== 'OB') return;
  const info = findOb(block.number)?.startInfo ?? [];
  for (const m of block.interface.temp) {
    if (info.some((s) => s.name === m.name && formatType(s.type) === m.type)) m.readOnly = true;
  }
}

type Target = { kind: 'udt'; obj: Udt } | { kind: 'block'; obj: Block };

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
    const b = createCodeBlock({ kind: unit.kind, number, name, language: 'AWL', newId });
    const src = unit.block;
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
      const name = unit.number !== undefined ? existing.name : unit.name;
      const t = build(unit, existing.number, name);
      t.obj.id = existing.id;
      t.obj.group = existing.group;
      if (t.kind === 'udt') device.udts[device.udts.indexOf(existing as Udt)] = t.obj;
      else device.blocks[device.blocks.indexOf(existing as Block)] = t.obj;
      replaced.push(refOf(device, t));
      touched.push(t);
      return;
    }
    const kind: Kind = unit.kind === 'IDB' ? 'DB' : unit.kind;
    const catalogOb =
      unit.kind === 'OB' && unit.number === undefined
        ? OB_DEFINITIONS.find((o) => sameName(o.defaultName, unit.name))
        : undefined;
    const number = unit.number ?? catalogOb?.number ?? freeNumber(device, kind);
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
