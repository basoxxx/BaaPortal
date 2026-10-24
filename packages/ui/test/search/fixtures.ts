import { createProject, type CodeBlock, type Project } from '@baaportal/project';
import type { FindOptions } from '../../src/search/types';
import { fb, plc } from '../blockFixtures';

export const opts = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({
  query,
  matchCase: false,
  wholeWord: false,
  regex: false,
  mnemonic: 'int',
  scope: { kind: 'project' },
  ...extra,
});

export function withBlocks(blocks: CodeBlock[], build?: (d: ReturnType<typeof plc>) => void) {
  const p: Project = createProject({ name: 'P', author: '', comment: '' }, new Date(0));
  const d = plc();
  d.blocks.push(...blocks);
  build?.(d);
  p.devices.push(d);
  return p;
}

export function block(name: string, sources: string[]): CodeBlock {
  const b = fb(name);
  b.networks = sources.map((source, i) => ({
    id: `${name}-n${i}`,
    title: '',
    comment: '',
    source,
  }));
  return b;
}
