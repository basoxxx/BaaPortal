import type { CommandId } from '../commands/commands';

export type MenuEntry = CommandId | 'sep' | 'recent';
export interface MenuDef {
  id: 'project' | 'edit' | 'view' | 'insert' | 'online' | 'options' | 'tools' | 'window' | 'help';
  items: MenuEntry[];
}

/** Voci dei menu nell'ordine di TIA Portal; l'etichetta di ogni comando viene dal registro `commands`. */
export const MENUS: MenuDef[] = [
  {
    id: 'project',
    items: [
      'project.new',
      'project.open',
      'recent',
      'sep',
      'project.close',
      'project.save',
      'project.saveAs',
      'sep',
      'project.openReference',
      'sep',
      'project.archive',
      'project.retrieve',
      'sep',
      'project.print',
      'project.printPreview',
      'sep',
      'project.exit',
    ],
  },
  {
    id: 'edit',
    items: [
      'edit.undo',
      'edit.redo',
      'sep',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      'edit.rename',
      'sep',
      'edit.findReplace',
      'edit.selectAll',
      'sep',
      'edit.compile',
      'edit.compileFull',
    ],
  },
  {
    id: 'view',
    items: [
      'view.navigation',
      'view.details',
      'view.inspector',
      'view.taskCards',
      'sep',
      'view.portal',
    ],
  },
  { id: 'insert', items: ['insert.device', 'insert.block'] },
  {
    id: 'online',
    items: [
      'online.goOnline',
      'online.goOffline',
      'online.simulation',
      'sep',
      'online.download',
      'online.upload',
      'sep',
      'online.accessibleDevices',
      'online.startCpu',
      'online.stopCpu',
      'sep',
      'online.diagnostics',
    ],
  },
  { id: 'options', items: ['options.settings'] },
  {
    id: 'tools',
    items: ['tools.crossReferences', 'tools.callStructure', 'sep', 'tools.collectCpuData'],
  },
  {
    id: 'window',
    items: ['window.splitVertical', 'window.splitHorizontal', 'sep', 'window.closeAllEditors'],
  },
  { id: 'help', items: ['help.show', 'help.about'] },
];
