import { describe, expect, it } from 'vitest';
import * as core from '../src';
import * as node from '../src/node';

describe('punti di ingresso', () => {
  it('./node esporta esattamente le funzioni di alto livello con il filtro di sola lettura', () => {
    expect(Object.keys(node).sort()).toEqual([
      'collectTcp',
      'connectTcp',
      'connectTestTcp',
      'connectWriteTcp',
      'listMpiNodesSerial',
      'listSerialPorts',
      'mpiSerialLink',
      'openTcp',
      'probePort',
    ]);
    for (const f of Object.values(node)) expect(typeof f).toBe('function');
  });

  it('nessun punto di ingresso esporta il trasporto TCP grezzo', () => {
    expect('tcpTransport' in node).toBe(false);
    expect('tcpTransport' in core).toBe(false);
  });

  it('nessun punto di ingresso esporta la porta seriale grezza', () => {
    for (const k of ['openSerial', 'serialTransport', 'SerialPort']) {
      expect(k in node).toBe(false);
      expect(k in core).toBe(false);
    }
  });
});
