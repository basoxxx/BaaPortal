import { describe, expect, it } from 'vitest';
import { callInstanceOf } from '../src/editors/block/callInstance';
import { fb, fc, instanceDb, plc } from './blockFixtures';

const drag = (dev: ReturnType<typeof plc>, id: string) =>
  JSON.stringify({ deviceId: dev.id, refs: [{ kind: 'block', id }] });

describe('callInstanceOf', () => {
  it('FC: solo il simbolo', () => {
    const d = plc();
    const f = fc('Calcolo');
    d.blocks.push(f);
    expect(callInstanceOf(d, drag(d, f.id))).toBe('"Calcolo"');
  });

  it('FB: il suo DB di istanza, anche se il nome differisce solo per maiuscole', () => {
    const d = plc();
    const f = fb('Nastro');
    d.blocks.push(f, instanceDb('Nastro_DB', 'NASTRO'));
    expect(callInstanceOf(d, drag(d, f.id))).toBe('"Nastro", "Nastro_DB"');
  });

  it('FB senza DB di istanza: il DB resta vuoto', () => {
    const d = plc();
    const f = fb('Nastro');
    d.blocks.push(f);
    expect(callInstanceOf(d, drag(d, f.id))).toBe('"Nastro", ');
  });
});
