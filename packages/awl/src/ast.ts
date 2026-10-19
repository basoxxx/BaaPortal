import type { InstructionDef } from './instructions';
import type { Range } from './lexer';

export type AreaId = 'I' | 'Q' | 'M' | 'PI' | 'PQ' | 'L' | 'DB' | 'DI' | 'T' | 'C';
export type AddressSize = 'X' | 'B' | 'W' | 'D';

export interface PathSegment {
  /** Nome senza virgolette e senza '#'. */
  name: string;
  quoted: boolean;
  index?: number[];
  /** Il nome come scritto (virgolette comprese, '#' escluso). */
  range: Range;
}

export type Operand =
  | {
      kind: 'address';
      area: AreaId;
      /** Le aree a bit (I, Q, M, L, DBX, DIX) hanno 'X'. */
      size: AddressSize | null;
      byte: number;
      bit?: number;
      db?: number;
      range: Range;
    }
  | { kind: 'timerCounter'; area: 'T' | 'C'; number: number; range: Range }
  | { kind: 'symbol'; path: PathSegment[]; range: Range }
  | { kind: 'local'; path: PathSegment[]; range: Range }
  | { kind: 'constant'; text: string; range: Range }
  | {
      kind: 'indirect';
      /** null = accesso tra aree (`B [AR1, P#0.0]`, `[AR1, P#0.0]`): l'area sta nel registro. */
      area: AreaId | null;
      size: AddressSize | null;
      via: { kind: 'memory'; location: Operand } | { kind: 'register'; ar: 1 | 2; offset: string };
      range: Range;
    }
  | {
      kind: 'block';
      blockKind: 'FB' | 'FC' | 'SFB' | 'SFC' | 'DB' | 'DI';
      number: number;
      range: Range;
    }
  | { kind: 'labelRef'; name: string; range: Range }
  | { kind: 'status'; condition: string; range: Range }
  | { kind: 'special'; name: 'STW' | 'DBLG' | 'DBNO' | 'DILG' | 'DINO'; range: Range };

export interface CallParam {
  name: string;
  nameRange: Range;
  arrow: ':=' | '=>';
  value: Operand | null;
  range: Range;
}

export interface Statement {
  label?: { name: string; range: Range };
  instruction: { text: string; def: InstructionDef | null; range: Range };
  /** Per CALL: il blocco; dopo ',' il DB di istanza in instanceDb. */
  operand?: Operand;
  instanceDb?: Operand;
  params?: CallParam[];
  comment?: string;
  range: Range;
}

export interface ParseError {
  code: 'SYNTAX' | 'UNKNOWN_INSTRUCTION' | 'BAD_OPERAND' | 'UNCLOSED_STRING' | 'UNCLOSED_PARAMS';
  range: Range;
  params?: Record<string, string>;
}
