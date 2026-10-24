import { readBlockFile } from '@baaportal/mc7';

/** Blocco di codice caricato nella CPU simulata. */
export interface LoadedBlock {
  kind: 'OB' | 'FB' | 'FC' | 'DB';
  number: number;
  code: Uint8Array;
  /** Byte di dati locali del blocco (header). */
  localBytes: number;
  /** Offset MC7 (byte) dell'inizio di ogni rete, dalla tabella ADD. */
  networkStarts: number[];
}

const KINDS = new Set(['OB', 'FB', 'FC', 'DB']);

/** Insieme dei blocchi caricati, indicizzati per tipo e numero. */
export class Program {
  private readonly blocks = new Map<string, LoadedBlock>();

  private static key(kind: string, number: number): string {
    return `${kind}${number}`;
  }

  /** Legge un file di blocco (header, MC7, ADD) e lo carica; sostituisce un blocco omonimo. */
  load(file: Uint8Array): LoadedBlock {
    const f = readBlockFile(file);
    const kind = f.header.kind;
    if (kind === undefined || !KINDS.has(kind))
      throw new Error(`tipo di blocco non caricabile: ${kind ?? f.header.kindCode}`);
    const starts: number[] = [];
    let sum = 0;
    for (const len of f.add.networks) {
      starts.push(sum);
      sum += len;
    }
    return this.put({
      kind: kind as LoadedBlock['kind'],
      number: f.header.number,
      code: f.mc7,
      localBytes: f.header.localDataLength,
      networkStarts: starts,
    });
  }

  /** Inserisce un blocco già costruito (usato anche dai test). */
  put(block: LoadedBlock): LoadedBlock {
    this.blocks.set(Program.key(block.kind, block.number), block);
    return block;
  }

  get(kind: string, number: number): LoadedBlock | undefined {
    return this.blocks.get(Program.key(kind, number));
  }

  delete(kind: string, number: number): void {
    this.blocks.delete(Program.key(kind, number));
  }

  list(): LoadedBlock[] {
    return [...this.blocks.values()];
  }
}
