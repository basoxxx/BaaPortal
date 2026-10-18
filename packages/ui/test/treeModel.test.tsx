import { describe, expect, it } from 'vitest';
import { createProject } from '@baaportal/project';
import { buildTree } from '../src/project/navigation/treeModel';
import type { OpenDoc } from '../src/state/store';

const doc = (name: string): OpenDoc => ({
  project: createProject({ name, author: '', comment: '' }, new Date('2026-01-01T00:00:00Z')),
  filePath: `/p/${name}.baap`,
  dirty: false,
});

describe('buildTree', () => {
  it('senza documento ha solo Accessi online', () => {
    const t = buildTree(null);
    expect(t.project).toBeNull();
    expect(t.onlineAccess.id).toBe('online-access');
    expect(t.onlineAccess.children).toEqual([]);
  });

  it("con documento: figli nell'ordine della spec, Aggiungi nuovo dispositivo disattivato", () => {
    const { project, onlineAccess } = buildTree(doc('Linea 3'));
    expect(project?.label).toBe('Linea 3');
    expect(project?.children.map((c) => c.id)).toEqual([
      'add-device',
      'devices-networks',
      'common-data',
      'doc-settings',
      'languages',
    ]);
    expect(project?.children.map((c) => c.enabled)).toEqual([false, true, true, true, true]);
    expect(onlineAccess.children).toEqual([]);
  });
});
