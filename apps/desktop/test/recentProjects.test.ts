import { describe, expect, it } from 'vitest';
import { addRecent, removeRecent, samePath } from '../src/main/recentProjects';

const t = (n: number) => new Date(2026, 0, n);

describe('recentProjects', () => {
  it('il più recente va in cima e senza doppioni', () => {
    let l = addRecent([], '/a/x.baap', 'x', t(1), 'darwin');
    l = addRecent(l, '/a/y.baap', 'y', t(2), 'darwin');
    l = addRecent(l, '/a/X.baap', 'x', t(3), 'darwin');
    expect(l.map((e) => e.path)).toEqual(['/a/X.baap', '/a/y.baap']);
  });
  it('massimo 10 voci', () => {
    let l: ReturnType<typeof addRecent> = [];
    for (let i = 1; i <= 12; i++) l = addRecent(l, `/a/${i}.baap`, `p${i}`, t(i), 'linux');
    expect(l).toHaveLength(10);
    expect(l.map((e) => e.path)).not.toContain('/a/1.baap');
    expect(l[0]?.path).toBe('/a/12.baap');
  });
  it('removeRecent toglie la voce', () => {
    const l = addRecent([], '/a/x.baap', 'x', t(1), 'linux');
    expect(removeRecent(l, '/a/x.baap', 'linux')).toEqual([]);
  });
  it('su win32 C:\\A\\x.baap e c:\\a\\X.baap sono lo stesso file', () => {
    expect(samePath('C:\\A\\x.baap', 'c:\\a\\X.baap', 'win32')).toBe(true);
  });
  it('su linux i percorsi distinguono maiuscole', () => {
    expect(samePath('/a/x.baap', '/a/X.baap', 'linux')).toBe(false);
  });
});
