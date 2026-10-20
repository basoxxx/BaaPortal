// Contesto semantico per il controllo, il completamento e la rinomina. Neutro: lo costruisce il progetto.
import type { DataType, TypedMember, TypeResolver } from '@baaportal/s7-types';
import type { Range } from './lexer';

export interface AwlInterface {
  input: TypedMember[];
  output: TypedMember[];
  inOut: TypedMember[];
  static: TypedMember[];
  temp: TypedMember[];
  returnType: DataType | null;
}

export interface AwlBlockInfo {
  name: string;
  kind: 'OB' | 'FB' | 'FC' | 'DB' | 'IDB' | 'SFC' | 'SFB';
  number: number;
  iface?: AwlInterface;
  /** Membri di un DB globale. */
  dbMembers?: TypedMember[];
  /** Per un IDB: il nome dell'FB di cui e' l'istanza. */
  instanceOf?: string;
  /** Nomi alternativi dei parametri (alias -> nome canonico). */
  paramAliases?: Record<string, string>;
}

export interface AwlSymbolInfo {
  name: string;
  kind: 'tag' | 'constant';
  type: DataType | null;
  /** Tag: indirizzo assoluto come nella tabella dei simboli (`%M10.0`, `MW 4`, `T 5`); serve al compilatore. */
  address?: string;
  /** Costante: valore come nella tabella (`100`, `16#FF`); serve al compilatore. */
  value?: string;
}

export interface AwlContext {
  owner: { kind: 'OB' | 'FB' | 'FC'; iface: AwlInterface };
  /** Tag o costante globale (il confronto dei nomi e' `sameName`). */
  symbol(
    name: string,
  ):
    | { kind: 'tag' | 'constant'; type: DataType | null; address?: string; value?: string }
    | undefined;
  block(
    ref: { name: string } | { kind: AwlBlockInfo['kind']; number: number },
  ): AwlBlockInfo | undefined;
  resolve: TypeResolver;
  limits?: {
    timers: number;
    counters: number;
    mBytes: number;
    inputBytes: number;
    outputBytes: number;
  };
  /** Elenchi per il completamento (non servono al controllo). */
  allSymbols(): readonly AwlSymbolInfo[];
  allBlocks(): readonly AwlBlockInfo[];
}

/** Tutti i codici di diagnostica (fonte unica: il tipo `AwlCode` ne deriva). */
export const AWL_CODES = [
  'SYNTAX',
  'UNKNOWN_INSTRUCTION',
  'BAD_OPERAND',
  'OPERAND_MISSING',
  'OPERAND_NOT_ALLOWED',
  'TYPE_MISMATCH',
  'UNKNOWN_SYMBOL',
  'UNKNOWN_LOCAL',
  'UNKNOWN_MEMBER',
  'UNKNOWN_BLOCK',
  'UNKNOWN_LABEL',
  'DUPLICATE_LABEL',
  'LABEL_TOO_LONG',
  'BRACKET_UNCLOSED',
  'BRACKET_UNEXPECTED',
  'BRACKET_DEPTH',
  'MCR_DEPTH',
  'ADDRESS_OUT_OF_RANGE',
  'CALL_PARAM_MISSING',
  'CALL_PARAM_UNKNOWN',
  'CALL_PARAM_TYPE',
  'CALL_PARAM_DIRECTION',
  'CALL_INSTANCE_MISSING',
  'CALL_INSTANCE_WRONG',
  'LOCAL_NOT_ACCESSIBLE',
  'CONSTANT_OUT_OF_RANGE',
  'UNCLOSED_STRING',
  'UNCLOSED_PARAMS',
] as const;

export type AwlCode = (typeof AWL_CODES)[number];

export interface AwlDiagnostic {
  severity: 'error' | 'warning';
  code: AwlCode;
  /** Indice in `networks[]`. */
  network: number;
  /** Relativo alla stringa di quella rete. */
  range: Range;
  params?: Record<string, string>;
}
