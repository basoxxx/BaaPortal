import { findDevice, type Project } from '@baaportal/project';
import { parseNodeId } from '../project/navigation/treeIds';
import type { PrintSelection } from './buildPrintDocument';

const inGroup = (g: string, path: string) => g === path || g.startsWith(`${path}/`);

/** Come `selectionsFromNodes`, ma solo il primo PLC (chi stampa un PLC alla volta). */
export function selectionFromNodes(
  project: Project,
  nodeIds: Iterable<string>,
): PrintSelection | null {
  return selectionsFromNodes(project, nodeIds)[0] ?? null;
}

/** Gli oggetti stampabili indicati dai nodi dell'albero (PLC, cartelle, gruppi, oggetti), una selezione per PLC. */
export function selectionsFromNodes(project: Project, nodeIds: Iterable<string>): PrintSelection[] {
  const sels = new Map<string, PrintSelection>();
  for (const n of nodeIds) {
    const p = parseNodeId(n);
    if (p.kind === 'static' || p.kind === 'sysBlock') continue;
    const dev = findDevice(project, p.dev);
    if (!dev) continue;
    let sel = sels.get(p.dev);
    if (!sel)
      sels.set(
        p.dev,
        (sel = {
          deviceId: p.dev,
          blocks: [],
          udts: [],
          tagTables: [],
          watchTables: [],
          sources: [],
        }),
      );
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
    sel.sources!.push(...pick(dev.sources, 'source', ['sources'], 'sources'));
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return [...sels.values()]
    .map((s) => ({
      ...s,
      blocks: uniq(s.blocks),
      udts: uniq(s.udts),
      tagTables: uniq(s.tagTables),
      watchTables: uniq(s.watchTables),
      sources: uniq(s.sources ?? []),
    }))
    .filter(
      (s) =>
        s.blocks.length +
          s.udts.length +
          s.tagTables.length +
          s.watchTables.length +
          s.sources.length >
        0,
    );
}
