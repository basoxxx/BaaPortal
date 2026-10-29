import { describe, expect, it } from 'vitest';
import { blockToMc7File, createCodeBlock, type CodeBlock } from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

function compileWith(source: string) {
  const device = makeDevice();
  device.blocks = [];
  const b = createCodeBlock({
    kind: 'OB',
    number: 1,
    name: 'Main',
    language: 'AWL',
    newId: seq('b'),
  }) as CodeBlock;
  b.networks = [{ id: 'n1', title: '', comment: '', source } as never];
  device.blocks.push(b);
  return blockToMc7File(b, device, cpu315pn, now);
}

describe('numeri di timer e contatori nella compilazione', () => {
  it('oltre i limiti della CPU: errore ADDRESS_OUT_OF_RANGE, nessun file', () => {
    for (const src of ['A T 256\n= M 0.0', 'A C 256\n= M 0.0']) {
      const out = compileWith(src);
      expect(out.file).toBeUndefined();
      expect(out.diagnostics.map((d) => d.code)).toEqual(['ADDRESS_OUT_OF_RANGE']);
    }
  });

  it("l'ultimo numero ammesso si compila", () => {
    expect(compileWith('A T 255\nA C 255\n= M 0.0').file).toBeDefined();
  });
});
