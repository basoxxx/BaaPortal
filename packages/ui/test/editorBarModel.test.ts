import { describe, expect, it } from 'vitest';
import { editorBarItems } from '../src/project/workarea/editorBarModel';
import { editorKey, type EditorRef } from '../src/state/workArea';

const ref = (kind: EditorRef['kind'], objectId: string): EditorRef => ({
  key: editorKey(kind, 'd', objectId),
  kind,
  deviceId: 'd',
  objectId,
});
const blk = (id: string) => ref('block', id);
const tbl = (id: string) => ref('tagTable', id);
const udt = (id: string) => ref('udt', id);
const k = (r: EditorRef) => r.key;

describe('editorBarItems', () => {
  it("nessun gruppo se c'è spazio; poi raggruppa il tipo più numeroso", () => {
    const [a, b, c, x, u] = [blk('a'), blk('b'), blk('c'), tbl('x'), udt('u')] as [
      EditorRef,
      EditorRef,
      EditorRef,
      EditorRef,
      EditorRef,
    ];
    const e = [a, b, c, x, u];
    expect(editorBarItems(e, 10).map((i) => i.type)).toEqual([
      'single',
      'single',
      'single',
      'single',
      'single',
    ]);
    expect(editorBarItems(e, 3)).toEqual([
      { type: 'group', kind: 'block', keys: [k(a), k(b), k(c)] },
      { type: 'single', key: k(x) },
      { type: 'single', key: k(u) },
    ]);
  });

  it('continua con il tipo successivo finché non ci stanno; un tipo con un solo editor non si raggruppa', () => {
    const e = [blk('a'), tbl('t1'), blk('b'), tbl('t2'), udt('u')];
    const items = editorBarItems(e, 2);
    expect(items.map((i) => i.type)).toEqual(['group', 'group', 'single']);
    expect(editorBarItems(e, 1)).toHaveLength(3); // più di così non si può
  });

  it('Infinity non raggruppa e un elenco vuoto resta vuoto', () => {
    expect(editorBarItems([blk('a'), blk('b')], Infinity)).toHaveLength(2);
    expect(editorBarItems([], 0)).toEqual([]);
  });
});
