import { PARSE_ERROR_CODES, type Mnemonic } from '@baaportal/awl';
import type {
  CodeBlock,
  DbAttributes,
  BlockHeader,
  GlobalDb,
  Language,
  Member,
  ObjectRef,
  Udt,
} from '@baaportal/project';

/** Errore di una sorgente: `line` e `col` partono da 1 e si riferiscono a tutto il file. */
export interface SourceError {
  line: number;
  col: number;
  code: string;
  params?: Record<string, string>;
}

/** Codici di struttura che il lettore delle sorgenti produce. */
export const SOURCE_STRUCTURE_ERROR_CODES = [
  'UNEXPECTED_TOKEN',
  'MISSING_END',
  'BAD_DECLARATION',
  'BAD_TYPE',
  'BAD_ASSIGNMENT',
  'UNKNOWN_ATTRIBUTE',
  'UNKNOWN_MEMBER',
  'DUPLICATE_UNIT',
  'OB_NUMBER_UNKNOWN',
  'UNSUPPORTED_SECTION',
] as const;

/** Codici del codice AWL, inoltrati dal parser dei segmenti: lo stesso elenco del parser. */
export const SOURCE_AWL_ERROR_CODES = PARSE_ERROR_CODES;

/** Tutti i codici possibili di `SourceError.code`: chi li mostra deve avere un messaggio per ciascuno. */
export const SOURCE_ERROR_CODES: readonly string[] = [
  ...SOURCE_STRUCTURE_ERROR_CODES,
  ...SOURCE_AWL_ERROR_CODES,
];

export type SourceUnit =
  | {
      kind: 'UDT';
      name: string;
      number?: number;
      udt: Omit<Udt, 'id' | 'number' | 'group'> & { number?: number };
    }
  | {
      kind: 'OB' | 'FB' | 'FC';
      name: string;
      number?: number;
      block: Omit<CodeBlock, 'id' | 'group' | 'number'> & { number?: number };
    }
  | {
      kind: 'DB';
      name: string;
      number?: number;
      db: Omit<GlobalDb, 'id' | 'group' | 'number'> & { number?: number };
    }
  | {
      kind: 'IDB';
      name: string;
      number?: number;
      /** Nome dell'FB, oppure `@FB:n` / `@SFB:n` se indicato per numero (risolto da applySource). */
      instanceOf: string;
      overrides: Record<string, string>;
      header: BlockHeader;
      knowHowProtected: boolean;
      attributes: DbAttributes;
    };

export interface ParsedSource {
  mnemonic: Mnemonic;
  units: SourceUnit[];
}

/**
 * Ciò che la generazione non ha potuto scrivere, per oggetto: i valori iniziali dei membri composti
 * (non c'è una forma verificata nella sorgente) o un blocco non AWL (non si esporta).
 */
export type GenerateWarning =
  | {
      kind: 'startValues';
      ref: ObjectRef;
      name: string;
      /** Percorsi dei membri, es. `T1`, `Gruppo.Asse`. */
      members: string[];
    }
  | { kind: 'language'; ref: ObjectRef; name: string; language: Language };

export interface GeneratedSource {
  text: string;
  warnings: GenerateWarning[];
}

export type { Member };
