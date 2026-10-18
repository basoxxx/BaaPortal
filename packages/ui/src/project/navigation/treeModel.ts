import type { IconName } from '../../icons';
import type { OpenDoc, TreeNodeId } from '../../state/store';

export interface TreeNode {
  id: TreeNodeId;
  labelKey: string;
  /** Etichetta già pronta (nome del progetto); se presente prevale su `labelKey`. */
  label?: string;
  icon: IconName;
  enabled: boolean;
  children: TreeNode[];
}

const leaf = (id: TreeNodeId, labelKey: string, icon: IconName, enabled = true): TreeNode => ({
  id, labelKey, icon, enabled, children: [],
});

export function buildTree(doc: OpenDoc | null): { project: TreeNode | null; onlineAccess: TreeNode } {
  const onlineAccess = leaf('online-access', 'tree.onlineAccess', 'treeOnlineAccess');
  if (!doc) return { project: null, onlineAccess };
  return {
    project: {
      id: 'project',
      labelKey: 'tree.project',
      label: doc.project.meta.name,
      icon: 'treeProject',
      enabled: true,
      children: [
        leaf('add-device', 'tree.addDevice', 'treeAddDevice', false),
        leaf('devices-networks', 'tree.devicesNetworks', 'treeDevicesNetworks'),
        leaf('common-data', 'tree.commonData', 'treeCommonData'),
        leaf('doc-settings', 'tree.docSettings', 'treeDocSettings'),
        leaf('languages', 'tree.languages', 'treeLanguages'),
      ],
    },
    onlineAccess,
  };
}
