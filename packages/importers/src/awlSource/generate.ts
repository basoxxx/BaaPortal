// Scrittura di una sorgente AWL in stile TIA: nomi tra virgolette, tipi canonici, indirizzi con '%'.
import { convertMnemonics, formatNetwork, parseNetwork, type Mnemonic } from '@baaportal/awl';
import { blockSources } from '@baaportal/project';
import type {
  Block,
  BlockHeader,
  CodeBlock,
  DbAttributes,
  GlobalDb,
  InstanceDb,
  Member,
  ObjectRef,
  PlcDevice,
  Udt,
} from '@baaportal/project';
import { parseType, sameName } from '@baaportal/s7-types';
import { commentLines, quoteName, quotePathKey, quoted } from './text';
import type { GeneratedSource, GenerateWarning } from './types';

const CALLS = new Set(['CALL', 'UC', 'CC']);

/** Ordina in modo che ogni elemento segua le sue dipendenze; a parità e nei cicli resta l'ordine dato. */
function orderByDeps<T>(items: T[], deps: (item: T) => T[]): T[] {
  const out: T[] = [];
  const state = new Map<T, 'visiting' | 'done'>();
  const visit = (item: T): void => {
    if (state.has(item)) return;
    state.set(item, 'visiting');
    for (const d of deps(item)) visit(d);
    state.set(item, 'done');
    out.push(item);
  };
  for (const item of items) visit(item);
  return out;
}

function namedTypes(list: Member[], out: string[] = []): string[] {
  for (const m of list) {
    const p = parseType(m.type);
    if (p.ok) {
      const base = p.type.kind === 'array' ? p.type.element : p.type;
      if (base.kind === 'named') out.push(base.name);
    }
    if (m.members) namedTypes(m.members, out);
  }
  return out;
}

function calledBlocks(block: CodeBlock, blocks: CodeBlock[], device: PlcDevice): CodeBlock[] {
  const out: CodeBlock[] = [];
  for (const source of blockSources(block, device)) {
    if (source === '') continue;
    for (const st of parseNetwork(source, 'international').statements) {
      if (!st.instruction.def || !CALLS.has(st.instruction.def.id) || !st.operand) continue;
      const op = st.operand;
      if (op.kind === 'block') {
        const hit = blocks.find((b) => b.kind === op.blockKind && b.number === op.number);
        if (hit) out.push(hit);
      } else if (op.kind === 'symbol' && op.path[0]) {
        const name = op.path[0].name;
        const hit = blocks.find((b) => sameName(b.name, name));
        if (hit) out.push(hit);
      }
    }
  }
  return out;
}

function header(
  unit: string,
  title: string,
  comment: string,
  h: BlockHeader,
  flags: string[],
  extra: string[],
): string[] {
  const out = [unit, title === '' ? 'TITLE =' : `TITLE = ${title}`, ...commentLines(comment)];
  if (flags.includes('KNOW_HOW_PROTECT')) out.push('KNOW_HOW_PROTECT');
  if (h.author !== '') out.push(`AUTHOR : ${h.author}`);
  if (h.family !== '') out.push(`FAMILY : ${h.family}`);
  if (h.headerName !== '') out.push(`NAME : ${h.headerName}`);
  out.push(`VERSION : ${h.version}`);
  out.push(...extra);
  out.push('');
  return out;
}

const attrLines = (a: DbAttributes): string[] => [
  ...(a.unlinked ? ['UNLINKED'] : []),
  ...(a.readOnly ? ['READ_ONLY'] : []),
  ...(a.nonRetain ? ['NON_RETAIN'] : []),
];

function memberLines(list: Member[], depth: number): string[] {
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  for (const m of list) {
    const tail = m.comment === '' ? '' : ` // ${m.comment}`;
    if (m.members && /\bStruct$/.test(m.type)) {
      out.push(`${pad}${quoteName(m.name)} : ${m.type}`);
      out.push(...memberLines(m.members, depth + 1));
      out.push(`${pad}END_STRUCT;${tail}`);
    } else {
      const init = m.initial === undefined || m.initial === '' ? '' : ` := ${m.initial}`;
      out.push(`${pad}${quoteName(m.name)} : ${m.type}${init};${tail}`);
    }
  }
  return out;
}

const structLines = (members: Member[]): string[] => [
  'STRUCT',
  ...memberLines(members, 1),
  'END_STRUCT;',
  '',
];

function overrideLines(members: Member[], prefix: string, out: string[]): void {
  for (const m of members) {
    const path = prefix === '' ? quoteName(m.name) : `${prefix}.${quoteName(m.name)}`;
    for (const [key, value] of Object.entries(m.overrides ?? {})) {
      out.push(`  ${path}${quotePathKey(key)} := ${value};`);
    }
    if (m.members) overrideLines(m.members, path, out);
  }
}

function udtLines(u: Udt): string[] {
  return [
    ...header(
      `TYPE ${quoted(u.name)}`,
      u.title,
      u.comment,
      {
        title: u.title,
        comment: u.comment,
        author: u.author,
        family: u.family,
        headerName: u.headerName,
        version: u.version,
      },
      [],
      [],
    ),
    ...structLines(u.members),
    'END_TYPE',
  ];
}

function codeLines(b: CodeBlock, mnemonic: Mnemonic, device: PlcDevice): string[] {
  const unit =
    b.kind === 'OB'
      ? `ORGANIZATION_BLOCK OB ${b.number}`
      : b.kind === 'FB'
        ? `FUNCTION_BLOCK ${quoted(b.name)}`
        : `FUNCTION ${quoted(b.name)} : ${b.interface.returnType === '' ? 'Void' : b.interface.returnType}`;
  const out = header(
    unit,
    b.header.title,
    b.header.comment,
    b.header,
    b.knowHowProtected ? ['KNOW_HOW_PROTECT'] : [],
    [],
  );
  const i = b.interface;
  const sections: [string, Member[]][] = [
    ['VAR_INPUT', i.input],
    ['VAR_OUTPUT', i.output],
    ['VAR_IN_OUT', i.inOut],
    ['VAR', i.static],
    ['VAR_TEMP', i.temp],
  ];
  for (const [kw, list] of sections) {
    if (list.length === 0) continue;
    out.push(kw, ...memberLines(list, 1), 'END_VAR', '');
  }
  out.push('BEGIN');
  const sources = blockSources(b, device);
  for (const [k, n] of b.networks.entries()) {
    const source = sources[k]!;
    out.push(
      'NETWORK',
      n.title === '' ? 'TITLE =' : `TITLE = ${n.title}`,
      ...commentLines(n.comment),
    );
    if (source === '') continue;
    const text =
      mnemonic === 'international' ? source : convertMnemonics(source, 'international', mnemonic);
    out.push(...formatNetwork(text, mnemonic).split(/\r?\n/));
  }
  out.push(
    `END_${b.kind === 'OB' ? 'ORGANIZATION_BLOCK' : b.kind === 'FB' ? 'FUNCTION_BLOCK' : 'FUNCTION'}`,
  );
  return out;
}

function dbLines(b: GlobalDb | InstanceDb): string[] {
  const out = header(
    `DATA_BLOCK ${quoted(b.name)}`,
    b.header.title,
    b.header.comment,
    b.header,
    b.knowHowProtected ? ['KNOW_HOW_PROTECT'] : [],
    attrLines(b.attributes),
  );
  if (b.kind === 'DB') {
    out.push(...structLines(b.members), 'BEGIN');
    overrideLines(b.members, '', out);
  } else {
    out.push(quoted(b.instanceOf), '', 'BEGIN');
    for (const [key, value] of Object.entries(b.overrides))
      out.push(`  ${quotePathKey(key)} := ${value};`);
  }
  out.push('END_DATA_BLOCK');
  return out;
}

/** Percorsi dei membri con valori iniziali composti (`overrides`), che la sorgente non scrive. */
function startValueMembers(list: Member[], prefix = '', out: string[] = []): string[] {
  for (const m of list) {
    const path = prefix === '' ? m.name : `${prefix}.${m.name}`;
    if (m.overrides && Object.keys(m.overrides).length > 0) out.push(path);
    if (m.members) startValueMembers(m.members, path, out);
  }
  return out;
}

/**
 * Sorgente AWL (stile TIA) degli oggetti indicati: UDT in ordine di dipendenza, poi i blocchi di
 * codice AWL con i richiamati prima dei chiamanti, poi DB e DB di istanza. Un'unità per volta, separate
 * da una riga vuota. `warnings` dice, per oggetto, che cosa non è stato scritto: i blocchi in un'altra
 * lingua e i valori iniziali dei membri composti di UDT e interfacce (i DB li scrivono in BEGIN).
 */
export function generateAwlSource(
  device: PlcDevice,
  refs: ObjectRef[],
  mnemonic: Mnemonic,
): GeneratedSource {
  const seen = new Set<string>();
  const udts: Udt[] = [];
  const blocks: Block[] = [];
  const warnings: GenerateWarning[] = [];
  for (const r of refs) {
    if (r.kind !== 'udt' && r.kind !== 'block') continue;
    if (seen.has(`${r.kind}:${r.id}`)) continue;
    seen.add(`${r.kind}:${r.id}`);
    if (r.kind === 'udt') {
      const u = device.udts.find((x) => x.id === r.id);
      if (u) udts.push(u);
    } else {
      const b = device.blocks.find((x) => x.id === r.id);
      if (b) blocks.push(b);
    }
  }
  const startValues = (ref: ObjectRef, name: string, list: Member[]) => {
    const members = startValueMembers(list);
    if (members.length > 0) warnings.push({ kind: 'startValues', ref, name, members });
  };
  for (const u of udts) {
    startValues({ kind: 'udt', deviceId: device.id, id: u.id }, u.name, u.members);
  }
  const code: CodeBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'DB' || b.kind === 'IDB') continue;
    const ref: ObjectRef = { kind: 'block', deviceId: device.id, id: b.id };
    // SCL e FUP non sono AWL: scritti come reti AWL non si potrebbero rileggere. Un blocco KOP
    // si esporta con l'AWL generato.
    if (b.language !== 'AWL' && b.language !== 'KOP') {
      warnings.push({ kind: 'language', ref, name: b.name, language: b.language });
      continue;
    }
    const i = b.interface;
    startValues(ref, b.name, [...i.input, ...i.output, ...i.inOut, ...i.static, ...i.temp]);
    code.push(b);
  }
  const sortedUdts = orderByDeps(udts, (u) =>
    namedTypes(u.members).flatMap((n) => udts.filter((x) => x !== u && sameName(x.name, n))),
  );
  const sortedCode = orderByDeps(code, (b) => {
    const i = b.interface;
    const typed = namedTypes([...i.input, ...i.output, ...i.inOut, ...i.static]);
    const fbs = typed.flatMap((n) => code.filter((x) => x.kind === 'FB' && sameName(x.name, n)));
    return [...fbs, ...calledBlocks(b, code, device)].filter((x) => x !== b);
  });
  const dbs = blocks.filter((b): b is GlobalDb | InstanceDb => b.kind === 'DB' || b.kind === 'IDB');
  const units: string[][] = [
    ...sortedUdts.map(udtLines),
    ...sortedCode.map((b) => codeLines(b, mnemonic, device)),
    ...dbs.map(dbLines),
  ];
  const text = units.map((u) => u.join('\n')).join('\n\n') + (units.length > 0 ? '\n' : '');
  return { text, warnings };
}
