import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createProject,
  createUdt,
} from '@baaportal/project';
import { ids, nodeIdForRef, parseNodeId } from '../src/project/navigation/treeIds';
import { buildTree, type TreeNode } from '../src/project/navigation/treeModel';
import type { OpenDoc } from '../src/state/store';

const doc = (name: string, plc = false): OpenDoc => {
  const project = createProject(
    { name, author: '', comment: '' },
    new Date('2026-01-01T00:00:00Z'),
  );
  if (plc) {
    let n = 0;
    project.devices.push(
      createPlcDevice({
        cpu: findCpu('cpu-315-2-pn-dp')!,
        orderNumber: '6ES7 315-2EH14-0AB0',
        firmware: 'V3.2.1',
        name: 'PLC_1',
        texts: { defaultTagTable: 'Tabella delle variabili standard' },
        newId: () => `i${++n}`,
      }),
    );
  }
  return { project, filePath: `/p/${name}.baap`, dirty: false, revision: 0, savedRevision: 0 };
};

const flat = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(flat)];
const labelOf = (n: TreeNode, t: Record<string, string> = {}) =>
  n.label ?? t[n.labelKey] ?? n.labelKey;

describe('buildTree', () => {
  it('senza documento ha solo Accessi online', () => {
    const t = buildTree(null);
    expect(t.project).toBeNull();
    expect(t.onlineAccess.id).toBe('online-access');
    expect(t.onlineAccess.children).toEqual([]);
  });

  it("con documento: figli nell'ordine della spec, tutti attivi", () => {
    const { project, onlineAccess } = buildTree(doc('Linea 3'));
    expect(project?.label).toBe('Linea 3');
    expect(project?.children.map((c) => c.id)).toEqual([
      'add-device',
      'devices-networks',
      'common-data',
      'doc-settings',
      'languages',
    ]);
    expect(project?.children.every((c) => c.enabled)).toBe(true);
    expect(onlineAccess.children).toEqual([]);
  });

  it("albero di un PLC nuovo: cartelle nell'ordine della spec, etichette e nodi disattivati", () => {
    const plc = buildTree(doc('P', true)).project!.children.find((c) => c.id === 'plc:i1')!;
    expect(plc.label).toBe('PLC_1 [CPU 315-2 PN/DP]');
    expect(plc.children.map((c) => c.labelKey)).toEqual([
      'tree.plc.deviceConfig',
      'tree.plc.onlineDiag',
      'tree.plc.blocks',
      'tree.plc.sources',
      'tree.plc.tags',
      'tree.plc.types',
      'tree.plc.watch',
      'tree.plc.backup',
      'tree.plc.progInfo',
    ]);
    expect(plc.children.filter((c) => !c.enabled).map((c) => c.labelKey)).toEqual([
      'tree.plc.deviceConfig',
      'tree.plc.backup',
    ]);
    const blocks = plc.children[2]!;
    expect(blocks.children.map((c) => labelOf(c))).toEqual([
      'tree.plc.addBlock',
      'Main [OB1]',
      'tree.plc.systemBlocks',
    ]);
    expect(plc.children[3]!.children.map((c) => labelOf(c))).toEqual(['tree.plc.addSource']);
    const tags = plc.children[4]!;
    expect(tags.children.map((c) => labelOf(c))).toEqual([
      'tree.plc.allTags',
      'tree.plc.addTagTable',
      'Tabella delle variabili standard [0]',
    ]);
    expect(plc.children[5]!.children.map((c) => labelOf(c))).toEqual(['tree.plc.addUdt']);
    expect(plc.children[6]!.children.map((c) => labelOf(c))).toEqual(['tree.plc.addWatchTable']);
    expect([blocks.dropArea, tags.dropArea, plc.children[5]!.dropArea]).toEqual([
      'blocks',
      'tags',
      'types',
    ]);
  });

  it('blocchi con numero e tipo (anche DB di istanza), UDT col solo nome, tag contati', () => {
    const d = doc('P', true);
    const dev = d.project.devices[0]!;
    dev.blocks.push(
      createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL' }),
      createInstanceDb({ number: 2, name: 'Nastro_DB', instanceOf: 'Nastro' }),
      createGlobalDb({ number: 1, name: 'Dati' }),
    );
    dev.udts.push(createUdt({ name: 'Motore', number: 1 }));
    dev.tagTables[0]!.tags.push(
      { id: 't1', name: 'A', type: 'Bool', address: 'M0.0', hmi: false, comment: '' },
      { id: 't2', name: 'B', type: 'Bool', address: 'M0.1', hmi: false, comment: '' },
      { id: 't3', name: 'C', type: 'Bool', address: 'M0.2', hmi: false, comment: '' },
    );
    const labels = flat(buildTree(d).project!).map((n) => labelOf(n));
    expect(labels).toEqual(
      expect.arrayContaining([
        'Nastro [FB1]',
        'Nastro_DB [DB2]',
        'Dati [DB1]',
        'Motore',
        'Tabella delle variabili standard [3]',
      ]),
    );
  });

  it('prima i gruppi poi gli oggetti, per nome senza maiuscole; gruppi annidati da A/B', () => {
    const d = doc('P', true);
    const dev = d.project.devices[0]!;
    dev.groups.blocks.push('zeta', 'Alfa/Beta');
    const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'beta', language: 'AWL' });
    const inner = createCodeBlock({ kind: 'FC', number: 2, name: 'Dentro', language: 'AWL' });
    inner.group = 'Alfa/Beta';
    const apple = createCodeBlock({ kind: 'FC', number: 3, name: 'Apple', language: 'AWL' });
    dev.blocks.push(fc, inner, apple);
    const blocks = buildTree(d).project!.children.find((c) => c.id === 'plc:i1')!.children[2]!;
    // Aggiungi nuovo blocco, gruppi (Alfa, zeta), oggetti (Apple, beta, Main), Blocchi di sistema.
    expect(blocks.children.map((c) => labelOf(c))).toEqual([
      'tree.plc.addBlock',
      'Alfa',
      'zeta',
      'Apple [FC3]',
      'beta [FC1]',
      'Main [OB1]',
      'tree.plc.systemBlocks',
    ]);
    const alfa = blocks.children[1]!;
    expect(alfa.id).toBe(ids.group('i1', 'blocks', 'Alfa'));
    expect(alfa.dropArea).toBe('blocks');
    const beta = alfa.children[0]!;
    expect(beta.id).toBe(ids.group('i1', 'blocks', 'Alfa/Beta'));
    expect(beta.children.map((c) => labelOf(c))).toEqual(['Dentro [FC2]']);
  });
});

describe('id dei nodi', () => {
  it('parseNodeId inverte i costruttori', () => {
    expect(parseNodeId(ids.block('d', 'b'))).toEqual({ kind: 'block', dev: 'd', id: 'b' });
    expect(parseNodeId(ids.tagTable('d', 'b'))).toEqual({ kind: 'tagTable', dev: 'd', id: 'b' });
    expect(parseNodeId(ids.udt('d', 'b'))).toEqual({ kind: 'udt', dev: 'd', id: 'b' });
    expect(parseNodeId(ids.plc('d'))).toEqual({ kind: 'plc', dev: 'd' });
    expect(parseNodeId(ids.folder('d', 'tags-add'))).toEqual({
      kind: 'folder',
      dev: 'd',
      folder: 'tags-add',
    });
    expect(parseNodeId('add-device')).toEqual({ kind: 'static', id: 'add-device' });
  });
  it('percorsi di gruppo con ":" e "/" restano reversibili', () => {
    const path = 'A:B/C d%1';
    expect(parseNodeId(ids.group('d', 'tags', path))).toEqual({
      kind: 'group',
      dev: 'd',
      area: 'tags',
      path,
    });
  });
  it("nodeIdForRef porta al nodo che contiene l'oggetto", () => {
    expect(nodeIdForRef({ kind: 'device', deviceId: 'd' })).toBe('plc:d');
    expect(nodeIdForRef({ kind: 'tag', deviceId: 'd', tableId: 't', id: 'x' })).toBe(
      ids.tagTable('d', 't'),
    );
    expect(
      nodeIdForRef({
        kind: 'member',
        deviceId: 'd',
        ownerKind: 'udt',
        ownerId: 'u',
        memberId: 'm',
      }),
    ).toBe(ids.udt('d', 'u'));
  });
});
