import type { ConnectOptions } from '../connection';
import { S7WriteClient } from '../writeClient';
import { tcpTransport } from './tcpTransport';

/** Client con scrittura su TCP (node:net), sempre in modo `online-write`. Per le CPU proprie. */
export function connectWriteTcp(
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
): Promise<S7WriteClient> {
  return S7WriteClient.connect({ ...o, transport: tcpTransport });
}
