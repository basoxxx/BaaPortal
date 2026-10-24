import { compileBlock } from '@baaportal/mc7';
import type { AwlContext } from '@baaportal/awl';
import type { SimCpuProps } from '@baaportal/sim';
import { SimHost } from '../../src/sim/host';
import type { SimWorkerLike } from '../../src/sim/session';
import type { SimNotice, SimWireMessage, SimWireRequest } from '../../src/sim/protocol';

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

/** Worker finto: fa girare `SimHost` in memoria con l'orologio e i timer veri. */
export function fakeWorker() {
  const w: SimWorkerLike & { terminated: boolean; sent: SimWireRequest[] } = {
    terminated: false,
    sent: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(m: SimWireRequest) {
      w.sent.push(m);
      void host.handle(m.req).then(
        (value) => reply({ type: 'response', id: m.id, ok: true, value }),
        (e: unknown) =>
          reply({
            type: 'response',
            id: m.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
      );
    },
    terminate() {
      w.terminated = true;
    },
  };
  const reply = (data: SimWireMessage) => {
    if (!w.terminated) queueMicrotask(() => w.onmessage?.({ data }));
  };
  const host = new SimHost({
    post: (notice: SimNotice) => reply({ type: 'notice', notice }),
    now: () => performance.now(),
    schedule: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
  });
  return w;
}
