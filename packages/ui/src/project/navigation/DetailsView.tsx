import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../icons';
import '../../icons/tree';
import { useAppStore } from '../../state/AppContext';
import { buildTree, type TreeNode } from './treeModel';

function find(node: TreeNode | null, id: string): TreeNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

export function DetailsView() {
  const { t } = useTranslation();
  const doc = useAppStore((s) => s.doc);
  const selection = useAppStore((s) => s.selection);
  const children = useMemo(() => {
    const { project, onlineAccess } = buildTree(doc);
    return (find(project, selection ?? '') ?? (selection === onlineAccess.id ? onlineAccess : null))?.children ?? [];
  }, [doc, selection]);
  return (
    <table className="baa-table">
      <thead>
        <tr><th scope="col">{t('details.name')}</th></tr>
      </thead>
      <tbody>
        {children.map((c) => (
          <tr key={c.id} data-testid="details-row" aria-disabled={c.enabled ? undefined : true}>
            <td><Icon name={c.icon} size={16} /> {c.label ?? t(c.labelKey)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
