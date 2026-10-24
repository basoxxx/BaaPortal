import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import type { IconName } from '../icons';
import type { ProjectService } from '../services/projectService';
import type { AppState, EditAction, PanelName } from '../state/store';
import { getProgress } from '../project/progress';
import { compileProgram } from '../project/compile/compileActions';
import { openReference } from '../project/reference/referenceStore';
import { requestFind } from '../search/findActions';
import { simControllerFor } from '../sim/simController';
import { targetPlcId } from '../project/navigation/treeIds';

export type CommandId =
  | 'project.new'
  | 'project.open'
  | 'project.close'
  | 'project.save'
  | 'project.saveAs'
  | 'project.openReference'
  | 'project.archive'
  | 'project.retrieve'
  | 'project.print'
  | 'project.printPreview'
  | 'project.exit'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.delete'
  | 'edit.rename'
  | 'edit.findReplace'
  | 'edit.replace'
  | 'edit.selectAll'
  | 'edit.compile'
  | 'edit.compileFull'
  | 'view.navigation'
  | 'view.details'
  | 'view.inspector'
  | 'view.taskCards'
  | 'view.portal'
  | 'insert.device'
  | 'insert.block'
  | 'online.goOnline'
  | 'online.goOffline'
  | 'online.simulation'
  | 'online.download'
  | 'online.upload'
  | 'online.accessibleDevices'
  | 'online.startCpu'
  | 'online.stopCpu'
  | 'online.diagnostics'
  | 'options.settings'
  | 'tools.crossReferences'
  | 'tools.callStructure'
  | 'tools.collectCpuData'
  | 'window.splitVertical'
  | 'window.splitHorizontal'
  | 'window.closeAllEditors'
  | 'help.show'
  | 'help.about';

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
  altShortcuts?: string[];
  isEnabled(s: AppState): boolean;
  isChecked?(s: AppState): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

const hasDoc = (s: AppState) => s.doc !== null;
const hasPlc = (s: AppState) => (s.doc?.project.devices.length ?? 0) > 0;
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
    run: ({ store }) =>
      store.getState().setPanel(panel, { open: !store.getState().panels[panel].open }),
  });
}

/** Accende e spegne la divisione dell'area di lavoro nella modalità data. */
function splitToggle(id: CommandId, mode: 'vertical' | 'horizontal'): Command {
  return def(id, {
    icon: 'splitWorkArea',
    isEnabled: hasDoc,
    isChecked: (s) => s.workArea.split === mode,
    run: ({ store }) =>
      store.getState().setSplit(store.getState().workArea.split === mode ? 'none' : mode),
  });
}

/** Comando di Modifica: agisce sull'elemento col focus (`editTarget`) se questo lo permette. */
function editCommand(
  id: CommandId,
  action: EditAction,
  shortcut: string,
  icon?: IconName,
): Command {
  return def(id, {
    ...(icon ? { icon } : {}),
    shortcut,
    isEnabled: (s) => !!s.editTarget?.can[action],
    run: async ({ store }) => {
      await store.getState().editTarget?.run(action);
    },
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
  def('project.save', {
    icon: 'save',
    shortcut: 'Mod+S',
    isEnabled: hasDoc,
    run: async ({ service }) => void (await service.save()),
  }),
  def('project.saveAs', {
    shortcut: 'Mod+Shift+S',
    isEnabled: hasDoc,
    run: async ({ service }) => void (await service.saveAs()),
  }),
  def('project.openReference', {
    isEnabled: always,
    run: async ({ store, bridge }) => {
      const path = await bridge.showOpenProjectDialog();
      if (!path) return;
      await openReference(path, bridge);
      store.getState().setReferenceProjectsOpen(true);
    },
  }),
  def('project.archive', {
    isEnabled: hasDoc,
    run: async ({ service }) => void (await service.archive()),
  }),
  def('project.retrieve', {
    isEnabled: always,
    run: async ({ service }) => void (await service.retrieve()),
  }),
  def('project.print', { icon: 'print' }),
  def('project.printPreview'),
  def('project.exit', { isEnabled: always, run: ({ service }) => service.handleCloseRequest() }),
  def('edit.undo', {
    icon: 'undo',
    shortcut: 'Mod+Z',
    isEnabled: (s) => s.history.past.length > 0,
    run: ({ store }) => store.getState().undo(),
  }),
  def('edit.redo', {
    icon: 'redo',
    shortcut: 'Mod+Y',
    altShortcuts: ['Mod+Shift+Z'],
    isEnabled: (s) => s.history.future.length > 0,
    run: ({ store }) => store.getState().redo(),
  }),
  editCommand('edit.cut', 'cut', 'Mod+X', 'cut'),
  editCommand('edit.copy', 'copy', 'Mod+C', 'copy'),
  editCommand('edit.paste', 'paste', 'Mod+V', 'paste'),
  editCommand('edit.delete', 'delete', 'Delete', 'delete'),
  editCommand('edit.rename', 'rename', 'F2'),
  def('edit.findReplace', {
    icon: 'search',
    shortcut: 'Mod+F',
    isEnabled: hasDoc,
    run: ({ store }) => requestFind(store, 'find'),
  }),
  def('edit.replace', {
    shortcut: 'Mod+H',
    isEnabled: hasDoc,
    run: ({ store }) => requestFind(store, 'replace'),
  }),
  editCommand('edit.selectAll', 'selectAll', 'Mod+A'),
  def('edit.compile', {
    icon: 'compile',
    shortcut: 'Mod+B',
    isEnabled: (s) => hasPlc(s) && !getProgress(),
    run: ({ store, bridge }) => {
      const deviceId = targetPlcId(store.getState());
      if (deviceId) compileProgram({ store, bridge }, deviceId, 'changes');
    },
  }),
  def('edit.compileFull', {
    isEnabled: (s) => hasPlc(s) && !getProgress(),
    run: ({ store, bridge }) => {
      const deviceId = targetPlcId(store.getState());
      if (deviceId) compileProgram({ store, bridge }, deviceId, 'full');
    },
  }),
  panelToggle('view.navigation', 'navigation'),
  panelToggle('view.details', 'details'),
  panelToggle('view.inspector', 'inspector'),
  panelToggle('view.taskCards', 'taskCards'),
  def('view.portal', { isEnabled: always, run: ({ store }) => store.getState().setView('portal') }),
  def('insert.device', {
    icon: 'treeAddDevice',
    isEnabled: hasDoc,
    run: ({ store }) => store.getState().openDialog({ kind: 'addDevice' }),
  }),
  def('insert.block', {
    isEnabled: hasPlc,
    run: ({ store }) => {
      const deviceId = targetPlcId(store.getState());
      if (deviceId) store.getState().openDialog({ kind: 'addBlock', deviceId });
    },
  }),
  def('online.goOnline', { icon: 'goOnline' }),
  def('online.goOffline', { icon: 'goOffline' }),
  def('online.simulation', {
    icon: 'simulation',
    isEnabled: (s) => hasPlc(s) || s.sim.phase !== 'off',
    isChecked: (s) => s.sim.phase !== 'off',
    run: ({ store }) => simControllerFor(store).toggle(),
  }),
  def('online.download', {
    icon: 'download',
    isEnabled: (s) => s.sim.phase === 'on' && !s.sim.downloading && !getProgress(),
    run: ({ store, bridge }) => simControllerFor(store).download({ store, bridge }),
  }),
  def('online.upload', { icon: 'upload' }),
  def('online.accessibleDevices', { icon: 'accessibleDevices' }),
  def('online.startCpu', {
    icon: 'startCpu',
    isEnabled: (s) => s.sim.phase === 'on' && s.sim.mode === 'STOP',
    run: ({ store }) => simControllerFor(store).setMode('RUN'),
  }),
  def('online.stopCpu', {
    icon: 'stopCpu',
    isEnabled: (s) => s.sim.phase === 'on' && s.sim.mode !== 'STOP',
    run: ({ store }) => simControllerFor(store).setMode('STOP'),
  }),
  def('online.diagnostics'),
  def('options.settings', {
    isEnabled: always,
    run: ({ store }) => store.getState().openDialog({ kind: 'settings' }),
  }),
  def('tools.crossReferences'),
  def('tools.callStructure'),
  def('tools.collectCpuData', {
    isEnabled: always,
    run: ({ store }) => store.getState().openDialog({ kind: 'collectKit' }),
  }),
  splitToggle('window.splitVertical', 'vertical'),
  splitToggle('window.splitHorizontal', 'horizontal'),
  def('window.closeAllEditors', {
    isEnabled: (s) => s.workArea.editors.length > 0,
    run: ({ store }) => store.getState().closeAllEditors(),
  }),
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

export const commands = Object.fromEntries(list.map((c) => [c.id, c])) as Record<
  CommandId,
  Command
>;

/** Confronta un evento di tastiera con una scorciatoia tipo 'Mod+Shift+S'. Mod = Cmd su macOS, Ctrl altrove. */
export function matchShortcut(
  e: KeyboardEvent,
  shortcut: string,
  platform: BaaBridge['platform'],
): boolean {
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
