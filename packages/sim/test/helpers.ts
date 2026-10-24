import { encodeCode } from '@baaportal/mc7';
import {
  CounterBank,
  Program,
  SimMemory,
  TimerBank,
  memorySizesFor,
  newRegisters,
  runBlock,
  type ExecContext,
  type LoadedBlock,
  type Registers,
  type StatusWord,
  type TraceStep,
} from '../src';

export interface RunInit {
  /** Memoria da riusare (per più cicli di fila); se manca ne nasce una nuova. */
  mem?: SimMemory;
  /** Preimposta byte di memoria prima dell'esecuzione. */
  setup?: (mem: SimMemory) => void;
  /** Orologio e temporizzatori da riusare fra più esecuzioni. */
  now?: () => number;
  timers?: TimerBank;
  counters?: CounterBank;
  regs?: Partial<Omit<Registers, 'stw'>> & { stw?: Partial<StatusWord> };
}

export interface RunResult {
  regs: Registers;
  mem: SimMemory;
  trace: TraceStep[];
}

/** Esegue un blocco MC7 grezzo come OB1 su una CPU fresca. */
export function runCode(code: Uint8Array, networkStarts: number[], init: RunInit = {}): RunResult {
  const mem = init.mem ?? new SimMemory(memorySizesFor('cpu-315-2-pn-dp'));
  const regs = newRegisters();
  const { stw, ...rest } = init.regs ?? {};
  Object.assign(regs, rest);
  Object.assign(regs.stw, stw);
  init.setup?.(mem);
  const program = new Program();
  const block: LoadedBlock = { kind: 'OB', number: 1, code, localBytes: 64, networkStarts };
  program.put(block);
  const trace: TraceStep[] = [];
  const ctx: ExecContext = {
    mem,
    regs,
    program,
    now: init.now ?? (() => 0),
    timers: init.timers ?? new TimerBank(256, init.now ?? (() => 0)),
    counters: init.counters ?? new CounterBank(256),
    maxCycleMs: 150,
    cycleStart: 0,
    trace: (t) => trace.push(t),
  };
  runBlock(ctx, 'OB', 1);
  return { regs, mem, trace };
}

/** Compila reti AWL (indirizzi assoluti) con encodeCode e le esegue una volta come OB1. */
export function runAwl(networks: string[], init: RunInit = {}): RunResult {
  const r = encodeCode(networks);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length)
    throw new Error(`AWL non compilabile: ${errors.map((d) => d.message).join('; ')}`);
  const starts: number[] = [];
  let sum = 0;
  for (const len of r.add.networks) {
    starts.push(sum);
    sum += len;
  }
  return runCode(r.mc7, starts, init);
}
