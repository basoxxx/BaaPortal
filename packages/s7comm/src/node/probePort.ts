import net from 'node:net';

/**
 * Prova se una porta TCP accetta il collegamento: apre il socket e lo chiude subito, senza
 * mandare un solo byte (nessun traffico S7, quindi nulla da filtrare). Mai rifiuta: l'esito
 * negativo (rifiuto, nessuna risposta, annullamento) è `false`. Il socket è sempre distrutto.
 */
export function probePort(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(ok);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
