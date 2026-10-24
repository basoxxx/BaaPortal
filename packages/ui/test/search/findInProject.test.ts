import { describe, expect, it } from 'vitest';
import { createTagTable, type CodeBlock } from '@baaportal/project';
import { findInProject } from '../../src/search/findInProject';
import type { Hit } from '../../src/search/types';
import { block, opts, withBlocks } from './fixtures';

const hits = (r: Hit[] | { error: string }): Hit[] => {
  if (!Array.isArray(r)) throw new Error(r.error);
  return r;
};

describe('findInProject', () => {
  it('trova "MW10" in due reti di due blocchi e in un commento di variabile', () => {
    const a = block('A', ['L MW10\nT MW12', 'NOP 0']);
    const b = block('B', ['L MW10']);
    const p = withBlocks([a, b], (d) => {
      const t = createTagTable('T');
      t.tags.push({
        id: 't1',
        name: 'x',
        type: 'Int',
        address: 'MW10',
        hmi: false,
        comment: 'usa MW10',
      });
      d.tagTables.push(t);
    });
    const r = hits(findInProject(p, opts('MW10')));
    expect(r.filter((h) => h.loc.kind === 'network')).toHaveLength(2);
    const tag = r.filter((h) => h.loc.kind === 'tag');
    expect(tag).toHaveLength(1);
    expect(tag[0]!.loc).toMatchObject({ field: 'comment', from: 4, to: 8 });
    expect(r.every((h) => h.editable)).toBe(true);
  });

  it('mnemonica de: cerca "U M0.0" trova la riga salvata come "A M0.0"', () => {
    const p = withBlocks([block('A', ['A M0.0\n= M1.0'])]);
    expect(hits(findInProject(p, opts('U M0.0', { mnemonic: 'de' })))).toHaveLength(1);
    expect(hits(findInProject(p, opts('U M0.0', { mnemonic: 'int' })))).toHaveLength(0);
  });

  it('letterale "(.*)" non è regex', () => {
    const p = withBlocks([block('A', ['L 1 // (.*)\nL 2 // x'])]);
    const r = hits(findInProject(p, opts('(.*)')));
    expect(r).toHaveLength(1);
  });

  it('wholeWord: "M1" non trova "M10"', () => {
    const p = withBlocks([block('A', ['A M10.0\nA M1.0'])]);
    expect(hits(findInProject(p, opts('M1', { wholeWord: false })))).toHaveLength(2);
    const w = hits(findInProject(p, opts('M1', { wholeWord: true })));
    expect(w).toHaveLength(1);
    expect(w[0]!.preview).toBe('A M1.0');
    const only10 = withBlocks([block('A', ['A M10.0'])]);
    expect(hits(findInProject(only10, opts('M1', { wholeWord: true })))).toHaveLength(0);
  });

  it('regex non valida → {error:"REGEX_NON_VALIDA"}', () => {
    const r = findInProject(withBlocks([]), opts('(', { regex: true }));
    expect(r).toMatchObject({ error: 'REGEX_NON_VALIDA' });
  });

  it('le corrispondenze di lunghezza zero si saltano', () => {
    const p = withBlocks([block('A', ['L 1'])]);
    expect(hits(findInProject(p, opts('^', { regex: true })))).toHaveLength(0);
    expect(hits(findInProject(p, opts('x*', { regex: true })))).toHaveLength(0);
  });

  it('rete MC7 grezzo → hit editable:false reason MC7_GREZZO', () => {
    const p = withBlocks([block('A', ['\t// MC7 grezzo: 1234\n\tL MW10'])]);
    const r = hits(findInProject(p, opts('MW10')));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ editable: false, reason: 'MC7_GREZZO' });
  });

  it('blocco protetto → nessun hit nel codice, hit nel titolo editable:false', () => {
    const b = block('A', ['L MW10']);
    b.knowHowProtected = true;
    b.header.title = 'MW10 titolo';
    const r = hits(findInProject(withBlocks([b]), opts('MW10')));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ editable: false, reason: 'PROTETTO' });
    expect(r[0]!.loc.kind).toBe('blockTitle');
  });

  it('scope object limita ai soli risultati di quel blocco', () => {
    const a = block('A', ['L MW10']);
    const b = block('B', ['L MW10']);
    const p = withBlocks([a, b]);
    const r = hits(
      findInProject(
        p,
        opts('MW10', {
          scope: { kind: 'object', ref: { kind: 'block', deviceId: p.devices[0]!.id, id: b.id } },
        }),
      ),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.loc).toMatchObject({ blockId: b.id });
  });

  it('letterali con "-", "/" e "#" non sono errori', () => {
    const p = withBlocks([block('A', ['L M-1 // a/b #x'])]);
    for (const q of ['M-1', 'a/b', '#x']) {
      expect(hits(findInProject(p, opts(q)))).toHaveLength(1);
    }
  });

  it('wholeWord non trova dentro "#M1" né dentro "\"M1\""', () => {
    const p = withBlocks([block('A', ['L #M1\nL "M1"\nL M1'])]);
    const r = hits(findInProject(p, opts('M1', { wholeWord: true })));
    expect(r).toHaveLength(1);
    expect(r[0]!.preview).toBe('L M1');
  });

  it('blocco non esatto: titolo e commenti sono editable:false MC7_GREZZO', () => {
    const b = block('A', ['L 1']);
    b.header.title = 'MW10';
    b.header.comment = 'MW10';
    b.networks[0]!.title = 'MW10';
    b.networks[0]!.comment = 'MW10';
    b.mc7 = { exact: false } as CodeBlock['mc7'];
    const r = hits(findInProject(withBlocks([b]), opts('MW10')));
    expect(r.map((h) => h.loc.kind).sort()).toEqual([
      'blockComment',
      'blockTitle',
      'networkComment',
      'networkTitle',
    ]);
    expect(r.every((h) => !h.editable && h.reason === 'MC7_GREZZO')).toBe(true);
  });

  it('blocco protetto: il commento del blocco non si cerca', () => {
    const b = block('A', ['L 1']);
    b.knowHowProtected = true;
    b.header.comment = 'MW10';
    expect(hits(findInProject(withBlocks([b]), opts('MW10')))).toHaveLength(0);
  });
});
