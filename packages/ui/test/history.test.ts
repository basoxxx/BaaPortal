import { describe, expect, it } from 'vitest';
import { createProject } from '@baaportal/project';
import { HISTORY_LIMIT, applyHistory, pushLimited, recordEdit } from '../src/state/history';

const project = () => createProject({ name: 'P', author: 'A', comment: '' }, new Date(0));

describe('history', () => {
  it('recordEdit produce patch e inverse reversibili', () => {
    const p = project();
    const r = recordEdit(p, (d) => {
      d.meta.author = 'B';
    })!;
    expect(r.next.meta.author).toBe('B');
    expect(applyHistory(r.next, r.inverse)).toEqual(p);
    expect(applyHistory(p, r.patches).meta.author).toBe('B');
  });
  it('una ricetta senza effetto restituisce null', () => {
    expect(recordEdit(project(), () => {})).toBeNull();
    expect(
      recordEdit(project(), (d) => {
        d.meta.author = 'A';
      }),
    ).toBeNull();
  });
  it('pushLimited scarta le voci più vecchie oltre il limite', () => {
    let past: ReturnType<typeof entry>[] = [];
    const entry = (n: number) => ({
      labelKey: `k${n}`,
      patches: [],
      inverse: [],
      before: n,
      after: n + 1,
    });
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) past = pushLimited(past, entry(i));
    expect(past).toHaveLength(HISTORY_LIMIT);
    expect(past[0]!.labelKey).toBe('k5');
  });
});
