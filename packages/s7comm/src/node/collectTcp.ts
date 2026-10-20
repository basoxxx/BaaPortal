import { collect, type KitOptions, type KitProgress, type KitResult } from '../kit/collect';
import { tcpTransport } from './tcpTransport';

/** Esegue il kit di raccolta in sola lettura su TCP (node:net). Unico modo di usarlo su una rete vera. */
export function collectTcp(
  o: Omit<KitOptions, 'transport'>,
  onProgress: (p: KitProgress) => void,
  signal?: AbortSignal,
  appVersion?: string,
): Promise<KitResult> {
  return collect({ ...o, transport: tcpTransport }, onProgress, signal, appVersion);
}
