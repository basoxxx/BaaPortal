import type { ConnectOptions } from '../connection';
import { S7WriteClient } from '../writeClient';
import { tcpTransport } from './tcpTransport';

/**
 * Client con scrittura su TCP (node:net), in modo `online-write` o, per il ripristino di un
 * backup, `online-restore`. Per le CPU proprie.
 */
export function connectWriteTcp(
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
  mode: 'online-write' | 'online-restore' = 'online-write',
): Promise<S7WriteClient> {
  return S7WriteClient.connect({ ...o, transport: tcpTransport }, mode);
}
