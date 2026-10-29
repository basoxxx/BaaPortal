import type { LadElem, LadOut } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import { renameWithReferences, type CodeBlock, type PlcDevice } from '../src/index';
import { makeDevice } from './fixtures';

const code = (d: PlcDevice, name: string) => d.blocks.find((b) => b.name === name) as CodeBlock;
const contact = (op: string): LadElem => ({ id: `c-${op}`, k: 'contact', neg: false, op });
const setLad = (b: CodeBlock, language: 'KOP' | 'FUP', series: LadElem[], outs: LadOut[] = []) => {
  b.language = language;
  b.networks = [
    {
      id: `${b.id}-n0`,
      title: '',
      comment: '',
      source: '',
      lad: { root: { id: 'root', series, outs: [{ id: 'q', k: 'coil', op: 'Q 4.0' }, ...outs] } },
    },
  ];
};
const lad = (b: CodeBlock) => b.networks[0]!.lad!.root;
const ops = (b: CodeBlock) =>
  lad(b).series.map((e) => (e.k === 'contact' ? e.op : e.k === 'box' ? e.pins : ''));

describe('rinomina negli operandi KOP e FUP', () => {
  it('un tag si rinomina nel grafico (KOP e FUP) e nella sorgente generata, non nei simili', () => {
    const d = makeDevice();
    const tag = d.tagTables[0]!.tags[0]!;
    setLad(
      code(d, 'Main'),
      'KOP',
      [contact('"Start"'), contact('"Start1"'), contact('#Start')],
      [{ id: 'o2', k: 'jmp', label: 'Start' }],
    );
    setLad(code(d, 'Linea'), 'FUP', [contact('"start"')]);
    renameWithReferences(
      d,
      { kind: 'tag', deviceId: d.id, tableId: d.tagTables[0]!.id, id: tag.id },
      'Avvio',
    );
    expect(ops(code(d, 'Main'))).toEqual(['"Avvio"', '"Start1"', '#Start']);
    expect(lad(code(d, 'Main')).outs[1]).toEqual({ id: 'o2', k: 'jmp', label: 'Start' });
    expect(ops(code(d, 'Linea'))).toEqual(['"Avvio"']);
    expect(lad(code(d, 'Main')).id).toBe('root');
    const src = code(d, 'Linea').networks[0]!.source;
    expect(src).toContain('"Avvio"');
    expect(src).not.toContain('"Start"');
  });

  it('un membro: #x locale nel blocco (non il globale omonimo); il parametro anche nei box CALL', () => {
    const d = makeDevice();
    const fb = code(d, 'Nastro');
    fb.interface.input.push({ id: 'p-vel', name: 'Vel', type: 'Int', comment: '' });
    setLad(fb, 'KOP', [contact('#Vel'), contact('"Vel"')]);
    const call: LadElem = {
      id: 'call',
      k: 'box',
      box: 'CALL',
      instance: 'FB 1, DB 2',
      pins: { Vel: '"Vel"', Altro: '1' },
      boolPins: {},
    };
    setLad(code(d, 'Linea'), 'FUP', [call]);
    renameWithReferences(
      d,
      { kind: 'member', deviceId: d.id, ownerKind: 'block', ownerId: fb.id, memberId: 'p-vel' },
      'Velocita',
    );
    expect(ops(fb)).toEqual(['#Velocita', '"Vel"']);
    expect(ops(code(d, 'Linea'))).toEqual([{ Velocita: '"Vel"', Altro: '1' }]);
  });

  it('un ingresso BOOL della CALL rinomina anche la chiave del pin con logica', () => {
    const d = makeDevice();
    const fb = code(d, 'Nastro');
    fb.interface.input.push({ id: 'p-run', name: 'Run', type: 'Bool', comment: '' });
    const call: LadElem = {
      id: 'call',
      k: 'box',
      box: 'CALL',
      instance: 'FB 1, DB 2',
      pins: {},
      boolPins: { Run: [contact('I 0.0')] },
    };
    setLad(code(d, 'Linea'), 'KOP', [call]);
    renameWithReferences(
      d,
      { kind: 'member', deviceId: d.id, ownerKind: 'block', ownerId: fb.id, memberId: 'p-run' },
      'Avvia',
    );
    const box = lad(code(d, 'Linea')).series[0] as Extract<LadElem, { k: 'box' }>;
    expect(Object.keys(box.boolPins)).toEqual(['Avvia']);
    const src = code(d, 'Linea').networks[0]!.source;
    expect(src).toContain('Avvia');
    expect(src).not.toMatch(/\bRun\b/);
  });
});
