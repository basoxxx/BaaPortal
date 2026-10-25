import { syntheticSdb } from '@baaportal/s7-server';
import { connectTestTcp } from '@baaportal/s7comm/node';
import { listen } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';

/**
 * PLC di prova locale (CPU simulata su 127.0.0.1) per `npm run dev` e per i test e2e. Parte solo con
 * BAAPORTAL_TEST_PLC=1: nell'app impacchettata, senza quella variabile, non parte mai.
 */
export async function startTestPlc(
  o: { port?: number } = {},
): Promise<{ port: number; close(): Promise<void>; tisJobs(): Promise<number[]> }> {
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
  const server = await listen(
    simBackend(cpu, { systemBlocks: [syntheticSdb(0, 64), syntheticSdb(1, 64)] }),
    { host: '127.0.0.1', port: o.port ?? 0 },
  );
  // La CPU simulata esegue un ciclo solo se qualcuno glielo chiede: senza, il programma non gira mai
  // e l'osservazione del blocco non avrebbe valori.
  const cycler = setInterval(() => cpu.cycle(), 20);
  cycler.unref();
  return {
    port: server.port,
    close: () => {
      clearInterval(cycler);
      return server.close();
    },
    // Solo per la e2e: i job di stato del blocco (0x13) vivi nel server, letti con un collegamento a parte.
    tisJobs: async () => {
      const c = await connectTestTcp({
        host: '127.0.0.1',
        port: server.port,
        rack: 0,
        slot: 2,
        connectionType: 'op',
        timeoutMs: 3000,
      });
      try {
        return (await c.readJobList()).filter((j) => j.fn === 0x13).map((j) => j.job);
      } finally {
        await c.close();
      }
    },
  };
}
