import { listen } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';

/**
 * PLC di prova locale (CPU simulata su 127.0.0.1) per `npm run dev` e per i test e2e. Parte solo con
 * BAAPORTAL_TEST_PLC=1: nell'app impacchettata, senza quella variabile, non parte mai.
 */
export async function startTestPlc(
  o: { port?: number } = {},
): Promise<{ port: number; close(): Promise<void> }> {
  if (process.env['BAAPORTAL_TEST_PLC'] !== '1') {
    throw new Error('PLC di prova disattivato: serve BAAPORTAL_TEST_PLC=1');
  }
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: {
      maxCycleMs: 150,
      minCycleMs: 0,
      clockMemory: { enabled: false, byte: 0 },
      retentivity: { mBytes: 16, timers: 0, counters: 8 },
      cyclicInterruptMs: 0,
    },
  });
  cpu.run();
  const server = await listen(simBackend(cpu), { host: '127.0.0.1', port: o.port ?? 0 });
  return { port: server.port, close: () => server.close() };
}
