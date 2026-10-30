import { findDevice, type Project } from '@baaportal/project';
import { parseNodeId } from '../project/navigation/treeIds';
import type { PrintSelection } from './buildPrintDocument';

const inGroup = (g: string, path: string) => g === path || g.startsWith(`${path}/`);

/** Gli oggetti stampabili indicati dai nodi dell'albero (un PLC, una cartella, un gruppo, oggetti). */
export function selectionFromNodes(
  project: Project,
  nodeIds: Iterable<string>,
): PrintSelection | null {
  let sel: PrintSelection | null = null;
  for (const n of nodeIds) {
    const p = parseNodeId(n);
    if (p.kind === 'static' || p.kind === 'sysBlock') continue;
    const dev = findDevice(project, p.dev);
    if (!dev) continue;
    sel ??= { deviceId: p.dev, blocks: [], udts: [], tagTables: [], watchTables: [] };
    if (sel.deviceId !== p.dev) continue;
    const all = p.kind === 'plc';
    const folder = p.kind === 'folder' ? p.folder : '';
    const grp = p.kind === 'group' ? p : null;
    const pick = <X extends { id: string; group?: string }>(
      items: X[],
      kind: string,
      folders: string[],
      area: string,
    ): string[] =>
      items
        .filter(
          (x) =>
            all ||
            folders.includes(folder) ||
            (p.kind === kind && 'id' in p && p.id === x.id) ||
            (grp?.area === area && inGroup(x.group ?? '', grp.path)),
        )
        .map((x) => x.id);
    sel.blocks.push(...pick(dev.blocks, 'block', ['blocks'], 'blocks'));
    sel.udts.push(...pick(dev.udts, 'udt', ['types'], 'types'));
    sel.tagTables.push(...pick(dev.tagTables, 'tagTable', ['tags', 'tags-all'], 'tags'));
    sel.watchTables.push(...pick(dev.watchTables, 'watchTable', ['watch'], 'watch'));
  }
  if (!sel) return null;
  const uniq = (a: string[]) => [...new Set(a)];
  sel.blocks = uniq(sel.blocks);
  sel.udts = uniq(sel.udts);
  sel.tagTables = uniq(sel.tagTables);
  sel.watchTables = uniq(sel.watchTables);
  return sel.blocks.length + sel.udts.length + sel.tagTables.length + sel.watchTables.length === 0
    ? null
    : sel;
}
