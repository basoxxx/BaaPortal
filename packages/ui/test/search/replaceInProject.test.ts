import { describe, expect, it } from 'vitest';
import { createTagTable, type CodeBlock, type Project } from '@baaportal/project';
import { findInProject } from '../../src/search/findInProject';
import { replaceInProject } from '../../src/search/replaceInProject';
import type { Hit } from '../../src/search/types';
import { block, opts, withBlocks } from './fixtures';

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};
const NAMES = ['A', 'B', 'C', 'P', 'R'];
const src = (p: Project, i: number, n = 0): string =>
  (p.devices[0]!.blocks.find((b) => b.name === NAMES[i]) as CodeBlock).networks[n]!.source;
const blockNamed = (p: Project, name: string) => p.devices[0]!.blocks.find((b) => b.name === name);

describe('replaceInProject', () => {
  it('sostituisci tutto "MW10"→"MW12" in 3 blocchi: replaced 3, testo salvato in internazionale', () => {
    const p = withBlocks([block('A', ['L MW10']), block('B', ['L MW10']), block('C', ['T MW10'])]);
    const r = replaceInProject(p, opts('MW10'), 'MW12');
    expect(r.replaced).toBe(3);
    expect(r.skipped).toBe(0);
    expect(src(r.project, 0)).toBe('L MW12');
    expect(src(r.project, 2)).toBe('T MW12');
  });

  it('mnemonica de: sostituisci "U"→"UN" come parola intera produce "AN" salvato', () => {
    const p = withBlocks([block('A', ['A M0.0\nA M1.0'])]);
    const r = replaceInProject(p, opts('U', { mnemonic: 'de', wholeWord: true }), 'UN');
    expect(r.replaced).toBe(2);
    expect(src(r.project, 0)).toBe('AN M0.0\nAN M1.0');
  });

  it('hit protetti/grezzi contati in skipped, blocchi invariati', () => {
    const prot = block('P', ['L MW10']);
    prot.knowHowProtected = true;
    prot.header.title = 'MW10';
    const raw = block('R', ['// MC7 grezzo: 12\nL MW10']);
    const p = withBlocks([prot, raw]);
    const r = replaceInProject(p, opts('MW10'), 'MW12');
    expect(r.replaced).toBe(0);
    expect(r.skipped).toBe(2);
    expect(blockNamed(r.project, 'P')).toEqual(blockNamed(p, 'P'));
    expect(src(r.project, 4)).toBe(src(p, 4));
  });

  it('only=[un hit] sostituisce solo quello; le reti senza hit restano identiche', () => {
    const p = withBlocks([block('A', ['L MW10\r\n', 'L MW10']), block('B', ['L MW10'])]);
    const all = findInProject(p, opts('MW10')) as Hit[];
    const r = replaceInProject(p, opts('MW10'), 'MW12', [all[1]!]);
    expect(r.replaced).toBe(1);
    expect(src(r.project, 0, 0)).toBe('L MW10\r\n');
    expect(src(r.project, 0, 1)).toBe('L MW12');
    expect(src(r.project, 1)).toBe('L MW10');
  });

  it('un hit obsoleto (il testo non corrisponde più) si salta', () => {
    const p = withBlocks([block('A', ['L MW10'])]);
    const [h] = findInProject(p, opts('MW10')) as Hit[];
    const p2 = withBlocks([block('A', ['L MW99'])]);
    p2.devices[0] = { ...p2.devices[0]!, id: p.devices[0]!.id };
    const r = replaceInProject(p2, opts('MW10'), 'MW12', [h!]);
    expect(r.replaced).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('regex: $1 e $& sono per corrispondenza', () => {
    const p = withBlocks([block('A', ['L MW10\nT MW12'])]);
    const r = replaceInProject(p, opts('MW(\\d+)', { regex: true }), 'MD$1 /*$&*/');
    expect(src(r.project, 0)).toBe('L MD10 /*MW10*/\nT MD12 /*MW12*/');
    const lit = replaceInProject(p, opts('MW10'), '$1');
    expect(src(lit.project, 0)).toBe('L $1\nT MW12');
  });

  it('un nome di variabile duplicato si salta; il rinomino valido si applica', () => {
    const p = withBlocks([], (d) => {
      const t = createTagTable('T');
      const mk = (id: string, name: string) => ({
        id,
        name,
        type: 'Bool',
        address: '',
        hmi: false,
        comment: '',
      });
      t.tags.push(mk('1', 'Motor_1'), mk('2', 'Motor_2'), mk('3', 'Valve'));
      d.tagTables.push(t);
    });
    const r = replaceInProject(p, opts('Motor_1', { matchCase: true }), 'Motor_2');
    expect(r.replaced).toBe(0);
    expect(r.skipped).toBe(1);
    const ok = replaceInProject(p, opts('Valve'), 'Pump');
    expect(ok.replaced).toBe(1);
    expect(ok.project.devices[0]!.tagTables.find((t) => t.name === 'T')!.tags[2]!.name).toBe(
      'Pump',
    );
  });

  it('il progetto di partenza non è mutato', () => {
    const p = deepFreeze(withBlocks([block('A', ['L MW10'])]));
    const r = replaceInProject(p, opts('MW10'), 'MW12');
    expect(r.replaced).toBe(1);
    expect(src(p, 0)).toBe('L MW10');
  });

  it('un hit con lo stesso posto ma testo cambiato è obsoleto', () => {
    const p = withBlocks([block('A', ['L MW10'])]);
    const o = opts('MW\\d+', { regex: true });
    const [h] = findInProject(p, o) as Hit[];
    const p2 = withBlocks([block('A', ['L MW11'])]);
    p2.devices[0] = { ...p2.devices[0]!, id: p.devices[0]!.id };
    const r = replaceInProject(p2, o, 'MW12', [h!]);
    expect(r.replaced).toBe(0);
    expect(r.skipped).toBe(1);
    expect(src(r.project, 0)).toBe('L MW11');
  });

  it('regex: $1 e $2 con più corrispondenze nella stessa riga', () => {
    const p = withBlocks([block('A', ['L MW10, MD20'])]);
    const r = replaceInProject(p, opts('(M[WD])(\\d+)', { regex: true }), '$2$1');
    expect(r.replaced).toBe(2);
    expect(src(r.project, 0)).toBe('L 10MW, 20MD');
  });
});
