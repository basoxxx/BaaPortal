import {
  ELEMENTARY_TYPES,
  PARAMETER_TYPES,
  type ArrayDim,
  type DataType,
  type ElementaryTypeName,
  type ParameterTypeName,
} from './types';

export type TypeError =
  | 'SYNTAX'
  | 'STRING_LENGTH'
  | 'ARRAY_BOUNDS'
  | 'ARRAY_DIMENSIONS'
  | 'NESTED_ARRAY'
  | 'ARRAY_OF_PARAMETER';

type Token =
  | { t: 'ident'; v: string }
  | { t: 'num'; v: number }
  | { t: 'quoted'; v: string }
  | { t: 'sym'; v: '..' | ',' | '[' | ']' | '-' };

const MAX_DIMS = 6;
const BOUND_MIN = -32768;
const BOUND_MAX = 32767;

const ELEMENTARY_BY_KEY = new Map<string, ElementaryTypeName>(
  ELEMENTARY_TYPES.map((n) => [n.toLowerCase(), n]),
);
const PARAMETER_BY_KEY = new Map<string, ParameterTypeName>(
  PARAMETER_TYPES.map((n) => [n.toLowerCase(), n]),
);
const ALIASES: Record<string, ElementaryTypeName | 'dateAndTime'> = {
  tod: 'Time_Of_Day',
  dt: 'dateAndTime',
  date_and_time: 'dateAndTime',
};

// Restituisce null se il testo contiene caratteri o stringhe non valide.
function tokenize(text: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return null;
      out.push({ t: 'quoted', v: text.slice(i + 1, end) });
      i = end + 1;
    } else if (text.startsWith('..', i)) {
      out.push({ t: 'sym', v: '..' });
      i += 2;
    } else if (c === ',' || c === '[' || c === ']' || c === '-') {
      out.push({ t: 'sym', v: c });
      i++;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j] as string)) j++;
      out.push({ t: 'num', v: Number(text.slice(i, j)) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j++;
      out.push({ t: 'ident', v: text.slice(i, j) });
      i = j;
    } else {
      return null;
    }
  }
  return out;
}

class Fail extends Error {
  constructor(readonly code: TypeError) {
    super(code);
  }
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isSym(v: string): boolean {
    const tok = this.peek();
    return tok?.t === 'sym' && tok.v === v;
  }

  private expectSym(v: string): void {
    if (!this.isSym(v)) throw new Fail('SYNTAX');
    this.pos++;
  }

  private isWord(v: string): boolean {
    const tok = this.peek();
    return tok?.t === 'ident' && tok.v.toLowerCase() === v;
  }

  private integer(): number {
    let sign = 1;
    if (this.isSym('-')) {
      sign = -1;
      this.pos++;
    }
    const tok = this.peek();
    if (tok?.t !== 'num') throw new Fail('SYNTAX');
    this.pos++;
    return sign * tok.v;
  }

  parseAll(): DataType {
    const type = this.type(false);
    if (this.peek()) throw new Fail('SYNTAX');
    return type;
  }

  private type(inArray: boolean): DataType {
    const tok = this.peek();
    if (!tok) throw new Fail('SYNTAX');
    if (tok.t === 'quoted') {
      if (tok.v === '') throw new Fail('SYNTAX');
      this.pos++;
      return { kind: 'named', name: tok.v };
    }
    if (tok.t !== 'ident') throw new Fail('SYNTAX');
    this.pos++;
    const key = tok.v.toLowerCase();
    if (key === 'string') return this.stringType();
    if (key === 'struct') return { kind: 'struct', members: [] };
    if (key === 'void') {
      if (inArray) throw new Fail('SYNTAX');
      return { kind: 'void' };
    }
    if (key === 'array') {
      if (inArray) {
        // un array dentro un array: va riconosciuto come tale
        throw new Fail('NESTED_ARRAY');
      }
      return this.arrayType();
    }
    const alias = ALIASES[key];
    if (alias === 'dateAndTime') return { kind: 'dateAndTime' };
    const elementary = alias ?? ELEMENTARY_BY_KEY.get(key);
    if (elementary) return { kind: 'elementary', name: elementary };
    const parameter = PARAMETER_BY_KEY.get(key);
    if (parameter) {
      if (inArray) throw new Fail('ARRAY_OF_PARAMETER');
      return { kind: 'parameter', name: parameter };
    }
    throw new Fail('SYNTAX');
  }

  private stringType(): DataType {
    if (!this.isSym('[')) return { kind: 'string', length: 254 };
    this.pos++;
    const length = this.integer();
    this.expectSym(']');
    if (length < 1 || length > 254) throw new Fail('STRING_LENGTH');
    return { kind: 'string', length };
  }

  private arrayType(): DataType {
    this.expectSym('[');
    const dims: ArrayDim[] = [];
    do {
      const lo = this.integer();
      this.expectSym('..');
      const hi = this.integer();
      dims.push({ lo, hi });
      if (!this.isSym(',')) break;
      this.pos++;
    } while (true);
    this.expectSym(']');
    if (!this.isWord('of')) throw new Fail('SYNTAX');
    this.pos++;
    if (dims.length > MAX_DIMS) throw new Fail('ARRAY_DIMENSIONS');
    for (const d of dims) {
      if (
        d.lo < BOUND_MIN ||
        d.hi > BOUND_MAX ||
        d.lo > d.hi ||
        d.hi < BOUND_MIN ||
        d.lo > BOUND_MAX
      )
        throw new Fail('ARRAY_BOUNDS');
    }
    return { kind: 'array', dims, element: this.type(true) };
  }
}

export function parseType(
  text: string,
): { ok: true; type: DataType } | { ok: false; error: TypeError } {
  const tokens = tokenize(text);
  if (!tokens) return { ok: false, error: 'SYNTAX' };
  try {
    return { ok: true, type: new Parser(tokens).parseAll() };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.code };
    throw e;
  }
}

export function formatType(type: DataType): string {
  switch (type.kind) {
    case 'elementary':
    case 'parameter':
      return type.name;
    case 'string':
      return `String[${type.length}]`;
    case 'dateAndTime':
      return 'Date_And_Time';
    case 'array':
      return `Array[${type.dims.map((d) => `${d.lo}..${d.hi}`).join(', ')}] of ${formatType(type.element)}`;
    case 'struct':
      return 'Struct';
    case 'named':
      return `"${type.name}"`;
    case 'void':
      return 'Void';
  }
}
