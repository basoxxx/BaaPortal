import { compileBlock } from '@baaportal/mc7';
import type { AwlContext } from '@baaportal/awl';
import type { SimCpuProps } from '@baaportal/sim';

export const PROPS: SimCpuProps = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 0,
};

/** Compila un OB1 senza interfaccia dalle reti AWL date. */
export function ob1(networks: string[]): Uint8Array {
  const iface = {
    input: [],
    output: [],
    inOut: [],
    static: [],
    temp: [],
    returnType: { kind: 'void' as const },
  };
  const ctx = {
    owner: { kind: 'OB', iface },
    symbol: () => undefined,
    block: () => undefined,
    resolve: () => null,
    allSymbols: () => [],
    allBlocks: () => [],
  } as unknown as AwlContext;
  const r = compileBlock({
    kind: 'OB',
    number: 1,
    now: new Date(2026, 9, 20),
    header: { author: 'T', family: 'Prove', name: 'Ciclo', version: '0.1' },
    knowHowProtected: false,
    sections: { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] },
    initials: {},
    networks,
    ctx,
  });
  if (!r.file) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.file;
}
