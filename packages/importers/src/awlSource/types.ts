import type { Mnemonic } from '@baaportal/awl';
import type {
  CodeBlock,
  DbAttributes,
  BlockHeader,
  GlobalDb,
  Member,
  Udt,
} from '@baaportal/project';

/** Errore di una sorgente: `line` e `col` partono da 1 e si riferiscono a tutto il file. */
export interface SourceError {
  line: number;
  col: number;
  code: string;
  params?: Record<string, string>;
}

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

export type { Member };
