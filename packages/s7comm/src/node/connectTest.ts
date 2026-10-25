import type { ConnectOptions } from '../connection';
import { S7TestClient } from '../testClient';
import { tcpTransport } from './tcpTransport';

/** Client con funzioni di test su TCP (node:net), sempre in modo `online-test`. Per le CPU proprie. */
export function connectTestTcp(
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
): Promise<S7TestClient> {
  return S7TestClient.connect({ ...o, transport: tcpTransport });
}
