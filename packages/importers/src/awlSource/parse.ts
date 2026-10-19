// Lettura di una sorgente AWL: unità (UDT, OB, FB, FC, DB), intestazioni, dichiarazioni e reti.
import { OB_DEFINITIONS } from '@baaportal/catalog';
import type { BlockHeader, DbAttributes, Member, PlcDevice } from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import { detectMnemonic, finishNetworks, splitNetworks, type RawNetwork } from './code';
import { assignToMembers, normalizeType, readMembers } from './declarations';
import { Reader } from './reader';
import { cleanLine, commentText, indexOutside, parsePath, pathKey, splitLines } from './text';
import type { ParsedSource, SourceError, SourceUnit } from './types';

const UNIT_START = /^(TYPE|ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK)\b\s*(.*)$/i;
const END_OF: Record<string, RegExp> = {
  TYPE: /^END_TYPE\b/i,
  ORGANIZATION_BLOCK: /^END_ORGANIZATION_BLOCK\b/i,
  FUNCTION_BLOCK: /^END_FUNCTION_BLOCK\b/i,
  FUNCTION: /^END_FUNCTION\b/i,
  DATA_BLOCK: /^END_DATA_BLOCK\b/i,
};
const KIND_OF: Record<string, 'UDT' | 'OB' | 'FB' | 'FC' | 'DB'> = {
  TYPE: 'UDT',
  ORGANIZATION_BLOCK: 'OB',
  FUNCTION_BLOCK: 'FB',
  FUNCTION: 'FC',
  DATA_BLOCK: 'DB',
};
const ABSOLUTE = /^(OB|FB|FC|DB|UDT|SFB)\s*(\d+)$/i;
const SECTION = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR)(\s+\S.*)?$/i;
const BODY_WORD = /^(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|BEGIN|STRUCT)\b/i;
const END_ANY = /^END_(TYPE|ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK)\b/i;
const UNKNOWN_ATTR = /^[A-Za-z_][A-Za-z0-9_]*\s*[:=]/;

/** Inizio di un'unità; esclude `Type := 1` e simili (un membro di nome uguale a una parola chiave). */
const isUnitStart = (code: string): boolean =>
  UNIT_START.test(code) && !/^\w+\s*(:=|\.|\[)/.test(code);

const emptyHeader = (): BlockHeader => ({
  title: '',
  comment: '',
  author: '',
  family: '',
  headerName: '',
  version: '0.1',
});

interface Header {
  header: BlockHeader;
  knowHowProtected: boolean;
  attributes: DbAttributes;
}

interface UnitName {
  name: string;
  number?: number;
  /** Per FUNCTION: il tipo dopo i due punti, se c'è. */
  returnType?: string;
}

/** Nome di un'unità: `"Nome"`, `Nome`, oppure `FB 1` (nome vuoto e numero). */
/** MISSING_END: alla riga corrente (l'unità seguente) o, a fine file, all'ultima riga. */
function missingEnd(r: Reader, expected: string): void {
  const line = Math.min(r.i, r.lines.length - 1);
  r.error(line, r.indent(line), 'MISSING_END', { expected });
}

function readUnitName(r: Reader, line: number, rest: string, keyword: string): UnitName | null {
  const col = r.indent(line);
  let head = rest.trim();
  let returnType: string | undefined;
  if (keyword.toUpperCase() === 'FUNCTION') {
    const c = indexOutside(head, ':');
    if (c >= 0) {
      returnType = head.slice(c + 1).trim();
      head = head.slice(0, c).trim();
    }
  }
  const abs = ABSOLUTE.exec(head);
  if (abs) {
    const kw = abs[1]!.toUpperCase();
    const expected = {
      TYPE: 'UDT',
      ORGANIZATION_BLOCK: 'OB',
      FUNCTION_BLOCK: 'FB',
      FUNCTION: 'FC',
      DATA_BLOCK: 'DB',
    }[keyword.toUpperCase()];
    if (kw !== expected) {
      r.error(line, col, 'BAD_DECLARATION', { name: head });
      return null;
    }
    return {
      name: '',
      number: Number(abs[2]),
      ...(returnType === undefined ? {} : { returnType }),
    };
  }
  const path = parsePath(head);
  if (!path || path.length !== 1 || path[0]!.index !== undefined) {
    r.error(line, col, 'BAD_DECLARATION', { name: head });
    return null;
  }
  return { name: path[0]!.name, ...(returnType === undefined ? {} : { returnType }) };
}

/** Legge TITLE, commento, AUTHOR, FAMILY, NAME, VERSION e i flag fino al corpo dell'unità. */
function readHeader(r: Reader): Header {
  const h: Header = {
    header: emptyHeader(),
    knowHowProtected: false,
    attributes: { unlinked: false, readOnly: false, nonRetain: false },
  };
  while (!r.done) {
    const raw = r.lines[r.i]!;
    const { code } = cleanLine(raw);
    if (code === '') {
      r.i++;
      continue;
    }
    const title = /^TITLE\s*=(.*)$/i.exec(code);
    if (title) {
      // Il titolo può contenere '//': si rilegge la riga intera.
      const full = /^\s*TITLE\s*=(.*)$/i.exec(raw);
      h.header.title = (full?.[1] ?? title[1]!).trim();
      r.i++;
      const lines: string[] = [];
      while (!r.done && r.lines[r.i]!.startsWith('//')) {
        lines.push(commentText(r.lines[r.i]!));
        r.i++;
      }
      h.header.comment = lines.join('\n');
      continue;
    }
    const field = /^(AUTHOR|FAMILY|NAME|VERSION)\s*:(.*)$/i.exec(code);
    if (field) {
      const value = field[2]!.trim();
      const key = field[1]!.toUpperCase();
      if (key === 'AUTHOR') h.header.author = value;
      else if (key === 'FAMILY') h.header.family = value;
      else if (key === 'NAME') h.header.headerName = value;
      else h.header.version = value;
      r.i++;
      continue;
    }
    const flag = code.toUpperCase();
    if (flag === 'KNOW_HOW_PROTECT') h.knowHowProtected = true;
    else if (flag === 'UNLINKED') h.attributes.unlinked = true;
    else if (flag === 'READ_ONLY') h.attributes.readOnly = true;
    else if (flag === 'NON_RETAIN') h.attributes.nonRetain = true;
    else if (BODY_WORD.test(code) || END_ANY.test(code) || !UNKNOWN_ATTR.test(code)) return h;
    else if (isUnitStart(code)) return h;
    else r.error(r.i, r.indent(r.i), 'UNKNOWN_ATTRIBUTE', { name: code.split(/[\s:=]/)[0]! });
    r.i++;
  }
  return h;
}

/** Salta le righe vuote; restituisce il codice pulito della riga corrente (senza consumarla). */
function peekCode(r: Reader): string | undefined {
  while (!r.done && cleanLine(r.lines[r.i]!).code === '') r.i++;
  return r.done ? undefined : cleanLine(r.lines[r.i]!).code;
}

/** Corpo di un blocco di codice: sezioni di variabili e BEGIN ... fine. Restituisce false se manca la fine. */
function readCodeBody(
  r: Reader,
  keyword: string,
  startLine: number,
  iface: Record<'input' | 'output' | 'inOut' | 'static' | 'temp', Member[]>,
  nets: RawNetwork[],
): void {
  const end = END_OF[keyword]!;
  for (;;) {
    const code = peekCode(r);
    if (code === undefined) {
      missingEnd(r, `END_${keyword}`);
      return;
    }
    if (end.test(code)) {
      r.i++;
      return;
    }
    if (isUnitStart(code)) {
      missingEnd(r, `END_${keyword}`);
      return;
    }
    const section = SECTION.exec(code);
    if (section) {
      const at = r.i;
      if (section[2] !== undefined) {
        r.error(at, r.indent(at), 'UNSUPPORTED_SECTION', { section: code });
      }
      r.i++;
      const members = readMembers(r, (c) => /^END_VAR\b/i.test(c));
      if (!r.done && /^END_VAR\b/i.test(cleanLine(r.lines[r.i]!).code)) r.i++;
      else missingEnd(r, 'END_VAR');
      const key = {
        VAR_INPUT: 'input',
        VAR_OUTPUT: 'output',
        VAR_IN_OUT: 'inOut',
        VAR: 'static',
        VAR_TEMP: 'temp',
      }[section[1]!.toUpperCase()] as keyof typeof iface;
      iface[key].push(...members);
      continue;
    }
    if (/^BEGIN$/i.test(code)) {
      r.i++;
      const from = r.i;
      while (!r.done) {
        const c = cleanLine(r.lines[r.i]!).code;
        if (end.test(c) || isUnitStart(c)) break;
        r.i++;
      }
      nets.push(...splitNetworks(r.lines, from, r.i));
      if (!r.done && end.test(cleanLine(r.lines[r.i]!).code)) r.i++;
      else missingEnd(r, `END_${keyword}`);
      return;
    }
    r.error(r.i, r.indent(r.i), 'UNEXPECTED_TOKEN', { text: code.split(/\s/)[0]! });
    r.i++;
  }
}

interface StructBody {
  members: Member[];
}

/** `STRUCT ... END_STRUCT;` di un UDT o di un DB. */
function readStruct(r: Reader): StructBody {
  const members: Member[] = [];
  r.i++;
  members.push(...readMembers(r, (c) => /^END_STRUCT\b/i.test(c)));
  if (!r.done && /^END_STRUCT\b/i.test(cleanLine(r.lines[r.i]!).code)) r.i++;
  else missingEnd(r, 'END_STRUCT');
  return { members };
}

/** Assegnazioni `percorso := valore;` fino alla fine dell'unità. */
function readAssignments(
  r: Reader,
  end: RegExp,
  startLine: number,
  apply: (path: string, value: string, line: number, col: number) => void,
): void {
  let buffer = '';
  let bufferLine = 0;
  const flush = (): void => {
    let rest = buffer;
    for (;;) {
      const semi = indexOutside(rest, ';');
      if (semi < 0) break;
      const stmt = rest.slice(0, semi);
      rest = rest.slice(semi + 1);
      const eq = stmt.indexOf(':=');
      const col = r.indent(bufferLine);
      if (eq < 0 || stmt.slice(0, eq).trim() === '') {
        r.error(bufferLine, col, 'BAD_ASSIGNMENT');
        continue;
      }
      apply(stmt.slice(0, eq).trim(), stmt.slice(eq + 2).trim(), bufferLine, col);
    }
    buffer = rest;
  };
  while (!r.done) {
    const { code } = cleanLine(r.lines[r.i]!);
    if (code !== '' && buffer.trim() === '' && end.test(code)) {
      r.i++;
      return;
    }
    if (isUnitStart(code)) break;
    if (code !== '') {
      if (buffer.trim() === '') bufferLine = r.i;
      buffer += (buffer === '' ? '' : ' ') + code;
      flush();
    }
    r.i++;
  }
  missingEnd(r, 'END_DATA_BLOCK');
}

const unitKey = (u: SourceUnit): string => {
  const fam = u.kind === 'IDB' ? 'DB' : u.kind;
  return u.number !== undefined
    ? `${fam}#${u.number}`
    : `${fam}:${u.name.normalize('NFC').toLowerCase()}`;
};

function readUnit(
  r: Reader,
  rawKeyword: string,
  rest: string,
  nets: RawNetwork[],
  device: PlcDevice | undefined,
): SourceUnit | null {
  const startLine = r.i;
  const keyword = rawKeyword.toUpperCase();
  const kind = KIND_OF[keyword]!;
  r.i++;
  const un = readUnitName(r, startLine, rest, keyword);
  const h = readHeader(r);
  if (!un) {
    // Unità illeggibile: si salta fino alla fine per non produrre errori a catena.
    skipToEnd(r, keyword);
    return null;
  }
  const num = un.number === undefined ? {} : { number: un.number };
  // Un OB è identificato dal numero: per nome solo se il nome è del catalogo o è già nel dispositivo.
  if (
    kind === 'OB' &&
    un.number === undefined &&
    !OB_DEFINITIONS.some((o) => sameName(o.defaultName, un.name)) &&
    !device?.blocks.some((b) => b.kind === 'OB' && sameName(b.name, un.name))
  ) {
    r.error(startLine, r.indent(startLine), 'OB_NUMBER_UNKNOWN', { name: un.name });
  }

  if (kind === 'UDT') {
    const code = peekCode(r);
    let members: Member[] = [];
    if (code !== undefined && /^STRUCT$/i.test(code)) members = readStruct(r).members;
    else if (code !== undefined && !END_OF.TYPE!.test(code)) {
      r.error(r.i, r.indent(r.i), 'UNEXPECTED_TOKEN', { text: code.split(/\s/)[0]! });
    }
    closeUnit(r, keyword);
    const hd = h.header;
    return {
      kind: 'UDT',
      name: un.name,
      ...num,
      udt: {
        name: un.name,
        title: hd.title,
        comment: hd.comment,
        author: hd.author,
        family: hd.family,
        headerName: hd.headerName,
        version: hd.version,
        members,
      },
    };
  }

  if (kind === 'DB') {
    const code = peekCode(r);
    const lineAt = r.i;
    let members: Member[] | undefined;
    let instanceOf: string | undefined;
    if (code !== undefined && SECTION.test(code)) {
      // I DB con VAR ... END_VAR sono dell'S7-1x00; l'S7-300 usa STRUCT.
      r.error(lineAt, r.indent(lineAt), 'UNSUPPORTED_SECTION', { section: code });
      skipToEnd(r, keyword);
      return null;
    }
    if (code !== undefined && /^STRUCT$/i.test(code)) members = readStruct(r).members;
    else if (code !== undefined && !/^BEGIN$/i.test(code) && !END_OF.DATA_BLOCK!.test(code)) {
      const abs = ABSOLUTE.exec(code);
      const path = parsePath(code);
      if (abs && ['FB', 'SFB'].includes(abs[1]!.toUpperCase())) {
        instanceOf = `@${abs[1]!.toUpperCase()}:${abs[2]}`;
      } else if (path && path.length === 1 && path[0]!.index === undefined)
        instanceOf = path[0]!.name;
      else r.error(lineAt, r.indent(lineAt), 'BAD_DECLARATION', { text: code });
      r.i++;
    }
    if (!r.done && /^BEGIN$/i.test(peekCode(r) ?? '')) r.i++;
    const overrides: Record<string, string> = {};
    const mem = members ?? [];
    readAssignments(r, END_OF.DATA_BLOCK!, startLine, (path, value, line, col) => {
      if (instanceOf !== undefined || members === undefined) {
        const p = parsePath(path);
        if (!p) r.error(line, col, 'BAD_ASSIGNMENT', { path });
        else overrides[pathKey(p)] = value;
      } else if (!assignToMembers(mem, path, value)) {
        r.error(line, col, 'UNKNOWN_MEMBER', { path });
      }
    });
    if (instanceOf !== undefined || members === undefined) {
      if (instanceOf === undefined) {
        r.error(startLine, r.indent(startLine), 'BAD_DECLARATION', { text: 'DATA_BLOCK' });
        return null;
      }
      return {
        kind: 'IDB',
        name: un.name,
        ...num,
        instanceOf,
        overrides,
        header: h.header,
        knowHowProtected: h.knowHowProtected,
        attributes: h.attributes,
      };
    }
    return {
      kind: 'DB',
      name: un.name,
      ...num,
      db: {
        kind: 'DB',
        name: un.name,
        header: h.header,
        knowHowProtected: h.knowHowProtected,
        members: mem,
        attributes: h.attributes,
      },
    };
  }

  const iface = { input: [], output: [], inOut: [], static: [], temp: [] } as Record<
    'input' | 'output' | 'inOut' | 'static' | 'temp',
    Member[]
  >;
  const mine: RawNetwork[] = [];
  readCodeBody(r, keyword, startLine, iface, mine);
  nets.push(...mine);
  let returnType = '';
  if (kind === 'FC') {
    if (un.returnType === undefined) returnType = 'Void';
    else {
      const t = normalizeType(un.returnType);
      if (t === null) r.error(startLine, r.indent(startLine), 'BAD_TYPE', { type: un.returnType });
      returnType = t ?? 'Void';
    }
  }
  const networks = mine.map((n) => n.network);
  if (networks.length === 0) networks.push({ id: '', title: '', comment: '', source: '' });
  return {
    kind,
    name: un.name,
    ...num,
    block: {
      kind,
      name: un.name,
      language: 'AWL',
      header: h.header,
      knowHowProtected: h.knowHowProtected,
      interface: { ...iface, returnType },
      networks,
    },
  };
}

function closeUnit(r: Reader, keyword: string): void {
  const code = peekCode(r);
  if (code !== undefined && END_OF[keyword]!.test(code)) r.i++;
  else missingEnd(r, `END_${keyword}`);
}

function skipToEnd(r: Reader, keyword: string): void {
  while (!r.done) {
    const { code } = cleanLine(r.lines[r.i]!);
    r.i++;
    if (END_OF[keyword]!.test(code)) return;
  }
}

/**
 * Legge una sorgente. Con `device`, un OB indicato per nome è accettato anche se il nome è quello di un
 * OB già presente (altrimenti serve un nome del catalogo, o il numero: `OB 35`).
 */
export function parseAwlSource(
  text: string,
  device?: PlcDevice,
): { ok: true; source: ParsedSource } | { ok: false; errors: SourceError[] } {
  const r = new Reader(splitLines(text));
  const units: SourceUnit[] = [];
  const nets: RawNetwork[] = [];
  const seen = new Set<string>();
  while (!r.done) {
    const line = r.lines[r.i]!;
    const { code } = cleanLine(line);
    if (code === '') {
      r.i++;
      continue;
    }
    const m = UNIT_START.exec(code);
    if (!m) {
      r.error(r.i, r.indent(r.i), 'UNEXPECTED_TOKEN', { text: code.split(/\s/)[0]! });
      r.i++;
      continue;
    }
    const at = r.i;
    const unit = readUnit(r, m[1]!, m[2]!, nets, device);
    if (!unit) continue;
    const key = unitKey(unit);
    if (seen.has(key))
      r.error(at, r.indent(at), 'DUPLICATE_UNIT', { name: unit.name || String(unit.number) });
    seen.add(key);
    units.push(unit);
  }
  const mnemonic = detectMnemonic(nets);
  r.errors.push(...finishNetworks(nets, mnemonic));
  if (r.errors.length > 0) {
    const errors = [...r.errors].sort((a, b) => a.line - b.line || a.col - b.col);
    return { ok: false, errors };
  }
  return { ok: true, source: { mnemonic, units } };
}
