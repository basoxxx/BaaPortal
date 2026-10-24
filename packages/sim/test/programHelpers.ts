import { compileBlock, type CompileInput } from '@baaportal/mc7';
import type { AwlBlockInfo, AwlContext } from '@baaportal/awl';
import {
  Program,
  SimMemory,
  memorySizesFor,
  newRegisters,
  runBlock,
  type ExecContext,
  type MemorySizes,
  type Registers,
} from '../src';

type Sections = CompileInput['sections'];

export const el = (name: string) => ({ kind: 'elementary', name }) as never;
export const named = (name: string) => ({ kind: 'named', name }) as never;
export const m = (name: string, type: never) => ({ name, type });
export const EMPTY: Sections = { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] };
export const sec = (s: Partial<Sections>): Sections => ({ ...EMPTY, ...s });

export interface BlockSpec {
  kind: 'OB' | 'FB' | 'FC';
  number: number;
  sections?: Sections;
  networks: string[];
}

const ifaceOf = (s: Sections) => ({
  input: s.in,
  output: s.out,
  inOut: s.inOut,
  static: s.stat,
  temp: s.temp,
  returnType: { kind: 'void' as const },
});

/** Compila i blocchi con mc7 (CALL comprese) e li carica in un Program; `idbs` = DB di istanza (numero → FB). */
export function buildProgram(
  specs: BlockSpec[],
  idbs: Record<number, number> = {},
  extra: AwlBlockInfo[] = [],
): Program {
  const program = new Program();
  for (const file of buildFiles(specs, idbs, extra)) program.load(file);
  return program;
}

/** Come `buildProgram`, ma restituisce i file di blocco compilati (per il download). */
export function buildFiles(
  specs: BlockSpec[],
  idbs: Record<number, number> = {},
  extra: AwlBlockInfo[] = [],
): Uint8Array[] {
  const infos: AwlBlockInfo[] = specs.map(
    (b) =>
      ({
        name: `${b.kind}${b.number}`,
        kind: b.kind,
        number: b.number,
        iface: ifaceOf(b.sections ?? EMPTY),
      }) as AwlBlockInfo,
  );
  infos.push(...extra);
  for (const [db, fb] of Object.entries(idbs))
    infos.push({
      name: `IDB${db}`,
      kind: 'IDB',
      number: Number(db),
      instanceOf: `FB${fb}`,
    } as AwlBlockInfo);
  const files: Uint8Array[] = [];
  for (const b of specs) {
    const s = b.sections ?? EMPTY;
    const ctx = {
      owner: { kind: b.kind, iface: ifaceOf(s) },
      symbol: () => undefined,
      block: (r: { name: string } | { kind: string; number: number }) =>
        'name' in r
          ? infos.find((x) => x.name.toLowerCase() === r.name.toLowerCase())
          : infos.find((x) => x.kind === r.kind && x.number === r.number),
      resolve: (name: string) => {
        const f = specs.find((x) => x.kind === 'FB' && `FB${x.number}` === name.toUpperCase());
        const fs = f?.sections ?? EMPTY;
        return f
          ? {
              kind: 'fb',
              sections: { input: fs.in, output: fs.out, inOut: fs.inOut, static: fs.stat },
            }
          : null;
      },
      allSymbols: () => [],
      allBlocks: () => infos,
    } as unknown as AwlContext;
    const r = compileBlock({
      kind: b.kind,
      number: b.number,
      now: new Date(2026, 9, 20),
      header: { author: 'T', family: 'Prove', name: 'Blocco', version: '0.1' },
      knowHowProtected: false,
      sections: s,
      initials: {},
      networks: b.networks,
      ctx,
    });
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length || !r.file)
      throw new Error(`${b.kind}${b.number}: ${errs.map((d) => d.message).join('; ')}`);
    files.push(r.file);
  }
  return files;
}

export interface ProgRun {
  mem: SimMemory;
  regs: Registers;
}

/** Esegue OB1 del programma; `dbs` = DB da creare (numero → byte). */
export function runProgram(
  program: Program,
  opts: {
    dbs?: Record<number, number>;
    setup?: (mem: SimMemory) => void;
    mem?: SimMemory;
    sizes?: MemorySizes;
    regs?: { stw?: Partial<Registers['stw']> };
  } = {},
): ProgRun {
  const mem = opts.mem ?? new SimMemory(opts.sizes ?? memorySizesFor('cpu-315-2-pn-dp'));
  for (const [n, len] of Object.entries(opts.dbs ?? {}))
    mem.dbs.set(Number(n), {
      data: new Uint8Array(len),
      initial: new Uint8Array(len),
      retentive: false,
    });
  opts.setup?.(mem);
  const regs = newRegisters();
  Object.assign(regs.stw, opts.regs?.stw);
  const ctx: ExecContext = {
    mem,
    regs,
    program,
    now: () => 0,
    maxCycleMs: 150,
    cycleStart: 0,
  };
  runBlock(ctx, 'OB', 1);
  return { mem, regs };
}

export const word = (mem: SimMemory, byte: number): number =>
  (mem.M[byte]! << 8) | mem.M[byte + 1]!;
export const setWord = (mem: SimMemory, byte: number, v: number): void => {
  mem.M[byte] = v >> 8;
  mem.M[byte + 1] = v & 255;
};
