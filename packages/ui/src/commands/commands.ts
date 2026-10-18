import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import type { IconName } from '../icons';
import type { ProjectService } from '../services/projectService';
import type { AppState, PanelName } from '../state/store';

export type CommandId =
  | 'project.new' | 'project.open' | 'project.close' | 'project.save' | 'project.saveAs' | 'project.archive' | 'project.retrieve'
  | 'project.print' | 'project.printPreview' | 'project.exit'
  | 'edit.undo' | 'edit.redo' | 'edit.cut' | 'edit.copy' | 'edit.paste' | 'edit.delete' | 'edit.rename' | 'edit.findReplace' | 'edit.selectAll' | 'edit.compile'
  | 'view.navigation' | 'view.details' | 'view.inspector' | 'view.taskCards' | 'view.portal'
  | 'insert.device' | 'insert.block'
  | 'online.goOnline' | 'online.goOffline' | 'online.simulation' | 'online.download' | 'online.upload' | 'online.accessibleDevices' | 'online.startCpu' | 'online.stopCpu' | 'online.diagnostics'
  | 'options.settings' | 'tools.crossReferences' | 'tools.callStructure'
  | 'window.splitVertical' | 'window.splitHorizontal' | 'window.closeAllEditors'
  | 'help.show' | 'help.about';

export interface CommandContext {
  store: StoreApi<AppState>;
  service: ProjectService;
  bridge: BaaBridge;
}

export interface Command {
  id: CommandId;
  labelKey: string;
  icon?: IconName;
  shortcut?: string;
  isEnabled(s: AppState): boolean;
  isChecked?(s: AppState): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

const hasDoc = (s: AppState) => s.doc !== null;
const always = () => true;
const never = () => false;
const noop = () => {};

function def(id: CommandId, over: Partial<Command> = {}): Command {
  return { id, labelKey: `commands.${id}`, isEnabled: never, run: noop, ...over };
}

function panelToggle(id: CommandId, panel: PanelName): Command {
  return def(id, {
    isEnabled: always,
    isChecked: (s) => s.panels[panel].open,
    run: ({ store }) => store.getState().setPanel(panel, { open: !store.getState().panels[panel].open }),
  });
}

const list: Command[] = [
  def('project.new', {
    icon: 'new',
    shortcut: 'Mod+N',
    isEnabled: always,
    run: ({ store }) => {
      const s = store.getState();
      s.setView('portal');
      s.setPortal('start');
      s.setStartAction('new');
    },
  }),
  def('project.open', {
    icon: 'open',
    shortcut: 'Mod+O',
    isEnabled: always,
    run: async ({ service }) => void (await service.openFromDialog()),
  }),
  def('project.close', {
    isEnabled: hasDoc,
    run: async ({ service }) => void (await service.close()),
  }),
  def('project.save', { icon: 'save', shortcut: 'Mod+S', isEnabled: hasDoc, run: async ({ service }) => void (await service.save()) }),
  def('project.saveAs', { shortcut: 'Mod+Shift+S', isEnabled: hasDoc, run: async ({ service }) => void (await service.saveAs()) }),
  def('project.archive'),
  def('project.retrieve'),
  def('project.print', { icon: 'print' }),
  def('project.printPreview'),
  def('project.exit', { isEnabled: always, run: ({ service }) => service.handleCloseRequest() }),
  def('edit.undo', { icon: 'undo' }),
  def('edit.redo', { icon: 'redo' }),
  def('edit.cut', { icon: 'cut' }),
  def('edit.copy', { icon: 'copy' }),
  def('edit.paste', { icon: 'paste' }),
  def('edit.delete', { icon: 'delete' }),
  def('edit.rename'),
  def('edit.findReplace', { icon: 'search' }),
  def('edit.selectAll'),
  def('edit.compile', { icon: 'compile' }),
  panelToggle('view.navigation', 'navigation'),
  panelToggle('view.details', 'details'),
  panelToggle('view.inspector', 'inspector'),
  panelToggle('view.taskCards', 'taskCards'),
  def('view.portal', { isEnabled: always, run: ({ store }) => store.getState().setView('portal') }),
  def('insert.device', { icon: 'treeAddDevice' }),
  def('insert.block'),
  def('online.goOnline', { icon: 'goOnline' }),
  def('online.goOffline', { icon: 'goOffline' }),
  def('online.simulation', { icon: 'simulation' }),
  def('online.download', { icon: 'download' }),
  def('online.upload', { icon: 'upload' }),
  def('online.accessibleDevices', { icon: 'accessibleDevices' }),
  def('online.startCpu', { icon: 'startCpu' }),
  def('online.stopCpu', { icon: 'stopCpu' }),
  def('online.diagnostics'),
  def('options.settings'),
  def('tools.crossReferences'),
  def('tools.callStructure'),
  def('window.splitVertical', { icon: 'splitWorkArea' }),
  def('window.splitHorizontal', { icon: 'splitWorkArea' }),
  def('window.closeAllEditors'),
  def('help.show'),
  def('help.about', {
    isEnabled: always,
    run: ({ store }) => {
      const s = store.getState();
      s.setView('portal');
      s.setPortal('start');
      s.setStartAction('installed');
    },
  }),
];

export const commands = Object.fromEntries(list.map((c) => [c.id, c])) as Record<CommandId, Command>;

/** Confronta un evento di tastiera con una scorciatoia tipo 'Mod+Shift+S'. Mod = Cmd su macOS, Ctrl altrove. */
export function matchShortcut(e: KeyboardEvent, shortcut: string, platform: BaaBridge['platform']): boolean {
  const parts = shortcut.split('+');
  const key = parts[parts.length - 1]!.toLowerCase();
  const mods = new Set(parts.slice(0, -1));
  const mac = platform === 'darwin';
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  return (
    e.key.toLowerCase() === key &&
    mod === mods.has('Mod') &&
    !otherMod &&
    e.shiftKey === mods.has('Shift') &&
    e.altKey === mods.has('Alt')
  );
}
