import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIS_JOBS, fileJobStore } from '../../src/main/plc/tisJobs';

describe('registro dei job di test', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tisjobs-'));
    file = join(dir, 'tis-jobs.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('file corrotto → vuoto, con un avviso', () => {
    writeFileSync(file, '{non json');
    const warn = vi.fn();
    const s = fileJobStore(file, warn);
    expect(s.list('192.0.2.1:102/0/2')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('file assente → vuoto, senza avviso', () => {
    const warn = vi.fn();
    expect(fileJobStore(file, warn).list('x')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('65 voci → la più vecchia esce; il file si rilegge e non resta il temporaneo', () => {
    const s = fileJobStore(file);
    for (let i = 0; i <= MAX_TIS_JOBS; i++) s.add('cpu', 0x13, i);
    const list = s.list('cpu');
    expect(list).toHaveLength(MAX_TIS_JOBS);
    expect(list[0]).toEqual({ fn: 0x13, job: 1 });
    expect(fileJobStore(file).list('cpu')).toEqual(list);
    expect(readdirSync(dir)).toEqual(['tis-jobs.json']);
  });

  it('add, remove e list per CPU', () => {
    const s = fileJobStore(file);
    s.add('a', 0x13, 5);
    s.add('b', 0x13, 6);
    s.remove('a', 0x13, 5);
    expect(s.list('a')).toEqual([]);
    expect(s.list('b')).toEqual([{ fn: 0x13, job: 6 }]);
    s.flush?.();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('i remove ravvicinati → una scrittura sola dopo 500 ms; add e flush scrivono subito', () => {
    vi.useFakeTimers();
    try {
      const s = fileJobStore(file);
      s.add('a', 0x13, 1);
      s.add('a', 0x13, 2);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);
      s.remove('a', 0x13, 1);
      s.remove('a', 0x13, 2);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);
      vi.advanceTimersByTime(500);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(0);
      s.add('a', 0x13, 3);
      s.remove('a', 0x13, 3);
      s.flush?.();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('voci malformate nel file si scartano', () => {
    writeFileSync(file, JSON.stringify([{ cpu: 'a', fn: 0x13, job: 3 }, { cpu: 1 }, 'x']));
    expect(fileJobStore(file).list('a')).toEqual([{ fn: 0x13, job: 3 }]);
  });
});
