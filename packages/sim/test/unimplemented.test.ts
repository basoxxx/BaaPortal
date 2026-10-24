import { describe, expect, it, vi } from 'vitest';

// Un id che nessun piano implementerà: l'istruzione decodificata è costruita a mano.
vi.mock('@baaportal/mc7', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@baaportal/mc7')>();
  return {
    ...orig,
    decodeInstruction: (_code: Uint8Array, at: number) => ({
      stmt: { id: at === 0 ? 'NOP' : 'ID_INESISTENTE', text: 'x' },
      length: 2,
    }),
  };
});

import { SimError } from '../src';
import { runCode } from './helpers';

describe('operazione senza gestore', () => {
  it('operazione non implementata → SimError con offset', () => {
    // Un id senza gestore dà MC7_NON_ESEGUIBILE con blocco, offset e rete.
    let err: unknown;
    try {
      runCode(new Uint8Array(4), [0]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SimError);
    expect((err as SimError).code).toBe('MC7_NON_ESEGUIBILE');
    expect((err as SimError).detail).toBe('operazione non implementata: ID_INESISTENTE');
    expect((err as SimError).offset).toBe(2);
    expect((err as SimError).network).toBe(1);
  });
});
