import type { EditorKind, EditorRef } from '../../state/workArea';

export type EditorBarItem =
  { type: 'single'; key: string } | { type: 'group'; kind: EditorKind; keys: string[] };

/**
 * Un pulsante per editor; se sono più di `maxButtons` si raggruppano per tipo, cominciando dal tipo
 * con più editor, finché ci stanno. Il gruppo prende il posto del primo editor del suo tipo.
 */
export function editorBarItems(editors: EditorRef[], maxButtons: number): EditorBarItem[] {
  const byKind = new Map<EditorKind, string[]>();
  for (const e of editors) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.key]);
  const grouped = new Set<EditorKind>();
  const count = () =>
    editors.length - [...grouped].reduce((n, k) => n + byKind.get(k)!.length - 1, 0);
  while (count() > maxButtons) {
    let best: EditorKind | null = null;
    for (const [kind, keys] of byKind) {
      if (grouped.has(kind) || keys.length < 2) continue;
      if (best === null || keys.length > byKind.get(best)!.length) best = kind;
    }
    if (best === null) break;
    grouped.add(best);
  }
  const items: EditorBarItem[] = [];
  const seen = new Set<EditorKind>();
  for (const e of editors) {
    if (!grouped.has(e.kind)) items.push({ type: 'single', key: e.key });
    else if (!seen.has(e.kind)) {
      seen.add(e.kind);
      items.push({ type: 'group', kind: e.kind, keys: byKind.get(e.kind)! });
    }
  }
  return items;
}
