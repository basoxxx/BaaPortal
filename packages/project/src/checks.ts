import {
  addressBitRange,
  addressFitsType,
  layoutInstance,
  layoutStruct,
  parseAddress,
  parseLiteral,
  parseType,
  validateS7Name,
  type AbsoluteAddress,
  type DataType,
} from '@baaportal/s7-types';
import type { CpuType } from '@baaportal/catalog';
import { toTypedMembers, typeResolver } from './members';
import type {
  Block,
  CodeBlock,
  CpuProperties,
  Member,
  ObjectRef,
  PlcDevice,
  Tag,
  TagTable,
  Udt,
} from './model';

export type DiagnosticCode =
  | 'NAME_INVALID'
  | 'NAME_DUPLICATE'
  | 'TYPE_INVALID'
  | 'TYPE_NOT_ALLOWED'
  | 'TYPE_UNKNOWN'
  | 'TYPE_CYCLE'
  | 'ADDRESS_INVALID'
  | 'ADDRESS_TYPE_MISMATCH'
  | 'ADDRESS_OUT_OF_RANGE'
  | 'ADDRESS_OVERLAP'
  | 'VALUE_INVALID'
  | 'NUMBER_DUPLICATE'
  | 'NUMBER_OUT_OF_RANGE'
  | 'OB_NOT_SUPPORTED'
  | 'INSTANCE_FB_MISSING'
  | 'HEADER_INVALID'
  | 'PROPERTY_INVALID'
  | 'CPU_UNKNOWN';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: DiagnosticCode;
  ref: ObjectRef;
  field?: 'name' | 'type' | 'address' | 'value' | 'number' | 'header' | 'property';
  property?: string;
  params?: Record<string, string>;
}

type Section = 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'return' | 'members';
type Owner = 'FB' | 'FC' | 'OB' | 'DB' | 'UDT';

// ---- Tipi ammessi per sezione ----

type Category = 'elementary' | 'complex' | 'multi' | 'void' | string;

function categorize(type: DataType, isFb: (name: string) => boolean): Category {
  switch (type.kind) {
    case 'elementary':
      return 'elementary';
    case 'parameter':
      return type.name;
    case 'void':
      return 'void';
    case 'named':
      return isFb(type.name) ? 'multi' : 'complex';
    default:
      return 'complex';
  }
}

const BLOCKS = ['Block_FB', 'Block_FC', 'Block_DB', 'Block_SDB'];
const BASE = ['elementary', 'complex'];

export function memberAllowed(
  owner: Owner,
  section: Section,
  type: DataType,
  isFb: (name: string) => boolean,
): boolean {
  const k = categorize(type, isFb);
  const within = (list: string[]): boolean => list.includes(k);
  if (owner === 'DB' || owner === 'UDT') return section === 'members' && within(BASE);
  if (owner === 'OB') return section === 'temp' && within([...BASE, 'Any']);
  if (section === 'temp') return within([...BASE, 'Any']);
  if (section === 'inOut') return within([...BASE, 'Pointer', 'Any']);
  if (section === 'input') {
    const extra = owner === 'FC' ? ['Pointer', 'Any'] : [];
    return within([...BASE, 'Timer', 'Counter', ...BLOCKS, ...extra]);
  }
  if (section === 'output') return within(owner === 'FC' ? [...BASE, 'Pointer', 'Any'] : BASE);
  if (section === 'static') return owner === 'FB' && within([...BASE, 'multi']);
  if (section === 'return') return owner === 'FC' && within(['void', 'elementary']);
  return false;
}

// ---- Utilità ----

// Stessa chiave di sameName (non esportata da s7-types).
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();

function groupByName<T>(items: T[], nameOf: (x: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const x of items) {
    const key = nameKey(nameOf(x));
    const list = map.get(key);
    if (list) list.push(x);
    else map.set(key, [x]);
  }
  return map;
}

/** Elemento base di un Array (o il tipo stesso). */
const baseType = (t: DataType): DataType => (t.kind === 'array' ? baseType(t.element) : t);

interface Ctx {
  device: PlcDevice;
  cpu: CpuType | undefined;
  out: Diagnostic[];
  udtByName: Map<string, Udt>;
  fbByName: Map<string, CodeBlock>;
  isFb: (name: string) => boolean;
  symbols: Map<string, number>;
}

const add = (ctx: Ctx, d: Diagnostic): void => {
  ctx.out.push(d);
};

// Nome valido e, se richiesto, unico nello spazio indicato.
function checkName(ctx: Ctx, ref: ObjectRef, name: string, duplicates: number): void {
  const v = validateS7Name(name);
  if (!v.ok) {
    add(ctx, {
      severity: 'error',
      code: 'NAME_INVALID',
      ref,
      field: 'name',
      params: { reason: v.reason },
    });
  }
  if (name !== '' && duplicates > 1) {
    add(ctx, { severity: 'error', code: 'NAME_DUPLICATE', ref, field: 'name' });
  }
}

// ---- Proprietà della CPU ----

function parseIp(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

const toInt = (o: number[]): number =>
  (((o[0] ?? 0) * 256 + (o[1] ?? 0)) * 256 + (o[2] ?? 0)) * 256 + (o[3] ?? 0);

function maskValue(text: string): number | null {
  const o = parseIp(text);
  if (!o) return null;
  const m = toInt(o);
  // Fra 128.0.0.0 e 255.255.255.252, con i bit a uno tutti in testa.
  if (m < 0x80000000 || m > 0xfffffffc) return null;
  const inverse = 0xffffffff - m;
  return (inverse & (inverse + 1)) === 0 ? m : null;
}

// Primo ottetto 1..223 senza 127.
const unicastFirst = (o: number[]): boolean => {
  const a = o[0] ?? 0;
  return a >= 1 && a <= 223 && a !== 127;
};

// Maschera di classe, usata quando quella indicata non è valida.
function classMask(o: number[]): number {
  const a = o[0] ?? 0;
  if (a < 128) return 0xff000000;
  if (a < 192) return 0xffff0000;
  return 0xffffff00;
}

function hostIsSpecial(ip: number, mask: number): boolean {
  const host = (ip & ~mask) >>> 0;
  return host === 0 || host === ~mask >>> 0;
}

const inRange = (n: number, lo: number, hi: number): boolean =>
  Number.isInteger(n) && n >= lo && n <= hi;

function checkProperties(ctx: Ctx): void {
  const { device, cpu } = ctx;
  const p: CpuProperties = device.properties;
  const ref: ObjectRef = { kind: 'device', deviceId: device.id };
  const bad = (property: string): void =>
    add(ctx, { severity: 'error', code: 'PROPERTY_INVALID', ref, field: 'property', property });

  if (p.pn) {
    const ip = parseIp(p.pn.ipAddress);
    const maskOk = maskValue(p.pn.subnetMask);
    const effectiveMask = maskOk ?? (ip ? classMask(ip) : 0);
    if (!ip || !unicastFirst(ip) || hostIsSpecial(toInt(ip), effectiveMask)) bad('pn.ipAddress');
    if (maskOk === null) bad('pn.subnetMask');
    if (p.pn.useRouter) {
      const r = parseIp(p.pn.routerAddress);
      const sameNet =
        ip && r && (toInt(ip) & effectiveMask) >>> 0 === (toInt(r) & effectiveMask) >>> 0;
      if (!r || !unicastFirst(r) || hostIsSpecial(toInt(r), effectiveMask) || (ip && !sameNet)) {
        bad('pn.routerAddress');
      }
    }
  }
  if (!inRange(p.mpiAddress, 0, 126)) bad('mpiAddress');
  if (p.dpAddress !== undefined && !inRange(p.dpAddress, 1, 125)) bad('dpAddress');
  const c = p.cycle;
  if (!inRange(c.maxCycleMs, 1, 6000)) bad('cycle.maxCycleMs');
  if (!inRange(c.minCycleMs, 0, Math.min(c.maxCycleMs, 6000))) bad('cycle.minCycleMs');
  if (!inRange(c.commLoadPercent, 5, 50)) bad('cycle.commLoadPercent');
  const upper = (limit: number | undefined, fallback: number): number => limit ?? fallback;
  if (
    !inRange(p.clockMemory.byte, 0, upper(cpu && cpu.limits.mBytes - 1, Number.MAX_SAFE_INTEGER))
  ) {
    bad('clockMemory.byte');
  }
  const r = p.retentivity;
  const max = cpu?.retentiveMax;
  if (!inRange(r.mBytes, 0, upper(max?.mBytes, Number.MAX_SAFE_INTEGER))) bad('retentivity.mBytes');
  if (!inRange(r.timers, 0, upper(max?.timers, Number.MAX_SAFE_INTEGER))) bad('retentivity.timers');
  if (!inRange(r.counters, 0, upper(max?.counters, Number.MAX_SAFE_INTEGER))) {
    bad('retentivity.counters');
  }
  if (!inRange(p.cyclicInterrupts.ob35Ms, 1, 60000)) bad('cyclicInterrupts.ob35Ms');
}

// ---- Tabelle delle variabili ----

function addressInLimits(a: AbsoluteAddress, cpu: CpuType): boolean {
  const l = cpu.limits;
  if ('number' in a) return a.number < (a.area === 'T' ? l.timers : l.counters);
  const last = addressBitRange(a).to >> 3;
  if (a.area === 'M') return last < l.mBytes;
  if (a.area === 'I' || a.area === 'PI') return last < l.inputBytes;
  return last < l.outputBytes;
}

interface Placed {
  tag: Tag;
  area: string;
  from: number;
  to: number;
}

function checkTag(ctx: Ctx, table: TagTable, tag: Tag, placed: Placed[]): void {
  const ref: ObjectRef = { kind: 'tag', deviceId: ctx.device.id, tableId: table.id, id: tag.id };
  checkName(ctx, ref, tag.name, ctx.symbols.get(nameKey(tag.name)) ?? 0);

  const t = parseType(tag.type);
  let type: DataType | undefined;
  if (!t.ok) {
    add(ctx, {
      severity: 'error',
      code: 'TYPE_INVALID',
      ref,
      field: 'type',
      params: { reason: t.error },
    });
  } else if (
    t.type.kind === 'elementary' ||
    (t.type.kind === 'parameter' && (t.type.name === 'Timer' || t.type.name === 'Counter'))
  ) {
    type = t.type;
  } else {
    add(ctx, { severity: 'error', code: 'TYPE_NOT_ALLOWED', ref, field: 'type' });
  }

  const a = parseAddress(tag.address);
  if (!a.ok) {
    add(ctx, {
      severity: 'error',
      code: 'ADDRESS_INVALID',
      ref,
      field: 'address',
      params: { reason: a.error },
    });
    return;
  }
  if (type && !addressFitsType(a.address, type)) {
    add(ctx, { severity: 'error', code: 'ADDRESS_TYPE_MISMATCH', ref, field: 'address' });
  }
  if (ctx.cpu && !addressInLimits(a.address, ctx.cpu)) {
    add(ctx, { severity: 'error', code: 'ADDRESS_OUT_OF_RANGE', ref, field: 'address' });
  }
  placed.push({ tag, ...addressBitRange(a.address) });
}

// Ordina per area e inizio e scorre: ogni coppia sovrapposta è visitata una volta.
function overlapsByTag(placed: Placed[]): Map<Tag, string[]> {
  const sorted = [...placed].sort((x, y) =>
    x.area === y.area ? x.from - y.from : x.area < y.area ? -1 : 1,
  );
  const others = new Map<Tag, string[]>();
  const push = (t: Tag, other: string): void => {
    const list = others.get(t);
    if (list) list.push(other);
    else others.set(t, [other]);
  };
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i] as Placed;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j] as Placed;
      if (b.area !== a.area || b.from > a.to) break;
      push(a.tag, b.tag.name);
      push(b.tag, a.tag.name);
    }
  }
  return others;
}

function checkTagTables(ctx: Ctx): void {
  const { device } = ctx;
  const tableNames = groupByName(device.tagTables, (t) => t.name);
  const placed: Placed[] = [];
  for (const table of device.tagTables) {
    const tref: ObjectRef = { kind: 'tagTable', deviceId: device.id, id: table.id };
    checkName(ctx, tref, table.name, tableNames.get(nameKey(table.name))?.length ?? 0);
    for (const tag of table.tags) checkTag(ctx, table, tag, placed);
    for (const c of table.constants) {
      const ref: ObjectRef = { kind: 'constant', deviceId: device.id, tableId: table.id, id: c.id };
      checkName(ctx, ref, c.name, ctx.symbols.get(nameKey(c.name)) ?? 0);
      const t = parseType(c.type);
      if (!t.ok) {
        add(ctx, {
          severity: 'error',
          code: 'TYPE_INVALID',
          ref,
          field: 'type',
          params: { reason: t.error },
        });
        continue;
      }
      if (t.type.kind !== 'elementary') {
        add(ctx, { severity: 'error', code: 'TYPE_NOT_ALLOWED', ref, field: 'type' });
        continue;
      }
      const v = parseLiteral(t.type, c.value);
      if (!v.ok) {
        add(ctx, {
          severity: 'error',
          code: 'VALUE_INVALID',
          ref,
          field: 'value',
          params: { reason: v.error },
        });
      }
    }
  }
  const others = overlapsByTag(placed);
  for (const table of device.tagTables) {
    for (const tag of table.tags) {
      const ref: ObjectRef = { kind: 'tag', deviceId: device.id, tableId: table.id, id: tag.id };
      for (const other of others.get(tag) ?? []) {
        add(ctx, {
          severity: 'warning',
          code: 'ADDRESS_OVERLAP',
          ref,
          field: 'address',
          params: { other },
        });
      }
    }
  }
}

// ---- Membri di interfaccia ----

// Membri raggiungibili da un tipo: struct locale, UDT o interfaccia di un FB.
function childrenOf(ctx: Ctx, m: Member): Member[] | undefined {
  const parsed = parseType(m.type);
  if (!parsed.ok) return undefined;
  const base = baseType(parsed.type);
  if (base.kind === 'struct') return m.members ?? [];
  if (base.kind !== 'named') return undefined;
  const udt = ctx.udtByName.get(nameKey(base.name));
  if (udt) return udt.members;
  const fb = ctx.fbByName.get(nameKey(base.name));
  if (!fb) return undefined;
  const i = fb.interface;
  return [...i.input, ...i.output, ...i.inOut, ...i.static];
}

// Tipo del membro indicato da un percorso come "Asse.Pos.X" o "Lista[1].X".
function typeAtPath(ctx: Ctx, roots: Member[], path: string): DataType | undefined {
  let list: Member[] | undefined = roots;
  const segments = path.split('.');
  for (let i = 0; i < segments.length; i++) {
    const seg = /^(.+?)(\[[^\]]*\])?$/.exec(segments[i] ?? '');
    const name = seg?.[1];
    const m: Member | undefined =
      name === undefined ? undefined : list?.find((x) => nameKey(x.name) === nameKey(name));
    if (!m) return undefined;
    if (i === segments.length - 1) {
      const parsed = parseType(m.type);
      if (!parsed.ok) return undefined;
      return seg?.[2] && parsed.type.kind === 'array' ? parsed.type.element : parsed.type;
    }
    list = childrenOf(ctx, m);
  }
  return undefined;
}

function checkOverrides(
  ctx: Ctx,
  ref: ObjectRef,
  roots: Member[],
  overrides: Record<string, string> | undefined,
): void {
  for (const [path, value] of Object.entries(overrides ?? {})) {
    const type = typeAtPath(ctx, roots, path);
    const v = type ? parseLiteral(type, value) : undefined;
    if (!v || !v.ok) {
      add(ctx, { severity: 'error', code: 'VALUE_INVALID', ref, field: 'value', params: { path } });
    }
  }
}

interface MemberScope {
  owner: Owner;
  ownerKind: 'block' | 'udt';
  ownerId: string;
}

// Controlli di un elenco di membri; `section` è null dentro uno struct.
function checkMemberList(
  ctx: Ctx,
  scope: MemberScope,
  section: Section | null,
  list: Member[],
  siblings: Member[],
): void {
  const names = groupByName(siblings, (m) => m.name);
  for (const m of list) {
    const ref: ObjectRef = {
      kind: 'member',
      deviceId: ctx.device.id,
      ownerKind: scope.ownerKind,
      ownerId: scope.ownerId,
      memberId: m.id,
    };
    checkName(ctx, ref, m.name, names.get(nameKey(m.name))?.length ?? 0);
    const parsed = parseType(m.type);
    if (!parsed.ok) {
      add(ctx, {
        severity: 'error',
        code: 'TYPE_INVALID',
        ref,
        field: 'type',
        params: { reason: parsed.error },
      });
    } else {
      const type = parsed.type;
      // Dentro uno struct valgono le regole di DB e UDT: elementari e complessi.
      const allowed = section
        ? memberAllowed(scope.owner, section, type, ctx.isFb)
        : memberAllowed('DB', 'members', type, ctx.isFb);
      if (!allowed) add(ctx, { severity: 'error', code: 'TYPE_NOT_ALLOWED', ref, field: 'type' });
      const base = baseType(type);
      if (base.kind === 'named' && !ctx.udtByName.has(nameKey(base.name)) && !ctx.isFb(base.name)) {
        add(ctx, {
          severity: 'error',
          code: 'TYPE_UNKNOWN',
          ref,
          field: 'type',
          params: { name: base.name },
        });
      }
      if (m.initial !== undefined && m.initial !== '') {
        const v = parseLiteral(type, m.initial);
        if (!v.ok) {
          add(ctx, {
            severity: 'error',
            code: 'VALUE_INVALID',
            ref,
            field: 'value',
            params: { reason: v.error },
          });
        }
      }
      if (m.overrides && Object.keys(m.overrides).length > 0) {
        const kids = childrenOf(ctx, m);
        checkOverrides(ctx, ref, kids ?? [], m.overrides);
      }
    }
    if (m.members) checkMemberList(ctx, scope, null, m.members, m.members);
  }
}

// ---- UDT e blocchi ----

const HEADER_TEXT = /^[A-Za-z0-9_]{0,8}$/;
const HEADER_VERSION = /^(\d|1[0-5])\.(\d|1[0-5])$/;

function checkHeaderFields(
  ctx: Ctx,
  ref: ObjectRef,
  h: { author: string; family: string; version: string; headerName?: string },
): void {
  const fields: [string, string | undefined, RegExp][] = [
    ['headerName', h.headerName, HEADER_TEXT],
    ['family', h.family, HEADER_TEXT],
    ['author', h.author, HEADER_TEXT],
    ['version', h.version, HEADER_VERSION],
  ];
  for (const [property, value, re] of fields) {
    if (value !== undefined && !re.test(value)) {
      add(ctx, { severity: 'error', code: 'HEADER_INVALID', ref, field: 'header', property });
    }
  }
}

function checkNumber(
  ctx: Ctx,
  ref: ObjectRef,
  number: number,
  count: number,
  max: number | undefined,
): void {
  if (count > 1) {
    add(ctx, {
      severity: 'error',
      code: 'NUMBER_DUPLICATE',
      ref,
      field: 'number',
      params: { number: String(number) },
    });
  }
  if (!Number.isInteger(number) || number < 1 || (max !== undefined && number > max)) {
    add(ctx, {
      severity: 'error',
      code: 'NUMBER_OUT_OF_RANGE',
      ref,
      field: 'number',
      params: { number: String(number) },
    });
  }
}

function checkCycle(
  ctx: Ctx,
  ref: ObjectRef,
  name: string,
  result: { ok: boolean; error?: string },
): void {
  if (!result.ok && result.error === 'CYCLE') {
    add(ctx, { severity: 'error', code: 'TYPE_CYCLE', ref, field: 'type', params: { name } });
  }
}

function checkUdts(ctx: Ctx): void {
  const { device } = ctx;
  const numbers = new Map<number, number>();
  for (const u of device.udts) numbers.set(u.number, (numbers.get(u.number) ?? 0) + 1);
  const resolver = typeResolver(device);
  for (const u of device.udts) {
    const ref: ObjectRef = { kind: 'udt', deviceId: device.id, id: u.id };
    checkName(ctx, ref, u.name, ctx.symbols.get(nameKey(u.name)) ?? 0);
    checkNumber(ctx, ref, u.number, numbers.get(u.number) ?? 0, 65535);
    checkHeaderFields(ctx, ref, u);
    checkMemberList(
      ctx,
      { owner: 'UDT', ownerKind: 'udt', ownerId: u.id },
      'members',
      u.members,
      u.members,
    );
    checkCycle(ctx, ref, u.name, layoutStruct(toTypedMembers(u.members), resolver));
  }
}

function allSections(b: CodeBlock): [Section, Member[]][] {
  const i = b.interface;
  return [
    ['input', i.input],
    ['output', i.output],
    ['inOut', i.inOut],
    ['static', i.static],
    ['temp', i.temp],
  ];
}

function checkCodeBlock(ctx: Ctx, b: CodeBlock, ref: ObjectRef): void {
  const scope: MemberScope = { owner: b.kind, ownerKind: 'block', ownerId: b.id };
  const sections = allSections(b);
  const all = sections.flatMap(([, list]) => list);
  for (const [section, list] of sections) checkMemberList(ctx, scope, section, list, all);
  if (b.kind === 'FC') {
    const t = parseType(b.interface.returnType);
    if (!t.ok) {
      add(ctx, {
        severity: 'error',
        code: 'TYPE_INVALID',
        ref,
        field: 'type',
        params: { reason: t.error },
      });
    } else if (!memberAllowed('FC', 'return', t.type, ctx.isFb)) {
      add(ctx, { severity: 'error', code: 'TYPE_NOT_ALLOWED', ref, field: 'type' });
    }
  }
  if (b.kind === 'FB') {
    const i = b.interface;
    const sectionsTyped = {
      input: toTypedMembers(i.input),
      output: toTypedMembers(i.output),
      inOut: toTypedMembers(i.inOut),
      static: toTypedMembers(i.static),
    };
    checkCycle(ctx, ref, b.name, layoutInstance(sectionsTyped, typeResolver(ctx.device)));
  }
}

function checkBlocks(ctx: Ctx): void {
  const { device, cpu } = ctx;
  // DB e DB di istanza condividono la numerazione.
  const numberGroup = (b: Block): string => (b.kind === 'IDB' ? 'DB' : b.kind);
  const counts = new Map<string, number>();
  const countKey = (b: Block): string => `${numberGroup(b)}:${b.number}`;
  for (const b of device.blocks) counts.set(countKey(b), (counts.get(countKey(b)) ?? 0) + 1);

  for (const b of device.blocks) {
    const ref: ObjectRef = { kind: 'block', deviceId: device.id, id: b.id };
    checkName(ctx, ref, b.name, ctx.symbols.get(nameKey(b.name)) ?? 0);
    const limits = cpu?.limits;
    const max =
      b.kind === 'FB'
        ? limits?.maxFb
        : b.kind === 'FC'
          ? limits?.maxFc
          : b.kind === 'OB'
            ? undefined
            : limits?.maxDb;
    if (b.kind === 'OB') {
      // Nessun intervallo per gli OB: conta il supporto della CPU.
      checkNumber(ctx, ref, b.number, counts.get(countKey(b)) ?? 0, undefined);
      if (cpu && !cpu.obs.includes(b.number)) {
        add(ctx, {
          severity: 'error',
          code: 'OB_NOT_SUPPORTED',
          ref,
          field: 'number',
          params: { number: String(b.number) },
        });
      }
    } else {
      checkNumber(ctx, ref, b.number, counts.get(countKey(b)) ?? 0, max);
    }
    checkHeaderFields(ctx, ref, { ...b.header });

    if (b.kind === 'IDB') {
      const fb = ctx.fbByName.get(nameKey(b.instanceOf));
      if (!fb) {
        add(ctx, {
          severity: 'error',
          code: 'INSTANCE_FB_MISSING',
          ref,
          field: 'type',
          params: { name: b.instanceOf },
        });
      } else {
        const i = fb.interface;
        checkOverrides(ctx, ref, [...i.input, ...i.output, ...i.inOut, ...i.static], b.overrides);
      }
    } else if (b.kind === 'DB') {
      checkMemberList(
        ctx,
        { owner: 'DB', ownerKind: 'block', ownerId: b.id },
        'members',
        b.members,
        b.members,
      );
    } else {
      checkCodeBlock(ctx, b, ref);
    }
  }
}

// ---- Ingresso ----

export function checkDevice(device: PlcDevice, cpu: CpuType | undefined): Diagnostic[] {
  const udtByName = new Map<string, Udt>();
  for (const u of device.udts)
    if (!udtByName.has(nameKey(u.name))) udtByName.set(nameKey(u.name), u);
  const fbByName = new Map<string, CodeBlock>();
  for (const b of device.blocks) {
    if (b.kind === 'FB' && !fbByName.has(nameKey(b.name))) fbByName.set(nameKey(b.name), b);
  }
  // Spazio dei simboli: tag, costanti, blocchi e UDT.
  const symbols = new Map<string, number>();
  const claim = (name: string): void => {
    symbols.set(nameKey(name), (symbols.get(nameKey(name)) ?? 0) + 1);
  };
  for (const t of device.tagTables) {
    for (const x of t.tags) claim(x.name);
    for (const c of t.constants) claim(c.name);
  }
  for (const b of device.blocks) claim(b.name);
  for (const u of device.udts) claim(u.name);

  const ctx: Ctx = {
    device,
    cpu,
    out: [],
    udtByName,
    fbByName,
    isFb: (name) => fbByName.has(nameKey(name)),
    symbols,
  };
  if (!cpu) {
    add(ctx, {
      severity: 'error',
      code: 'CPU_UNKNOWN',
      ref: { kind: 'device', deviceId: device.id },
    });
  }
  checkProperties(ctx);
  checkTagTables(ctx);
  checkUdts(ctx);
  checkBlocks(ctx);
  return ctx.out;
}
