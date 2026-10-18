import type { FC } from 'react';

export type IconName =
  | 'portalStart'
  | 'portalDevices'
  | 'portalPlc'
  | 'portalOnline'
  | 'actionOpen'
  | 'actionNew'
  | 'actionMigrate'
  | 'actionClose'
  | 'actionFirstSteps'
  | 'actionInstalled'
  | 'actionHelp'
  | 'actionLanguage'
  | 'new'
  | 'open'
  | 'save'
  | 'print'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'compile'
  | 'download'
  | 'upload'
  | 'simulation'
  | 'goOnline'
  | 'goOffline'
  | 'accessibleDevices'
  | 'startCpu'
  | 'stopCpu'
  | 'splitWorkArea'
  | 'search'
  | 'pin'
  | 'treeProject'
  | 'treeAddDevice'
  | 'treeDevicesNetworks'
  | 'treeCommonData'
  | 'treeDocSettings'
  | 'treeLanguages'
  | 'treeOnlineAccess';

const registry = new Map<IconName, FC<{ size: number }>>();

export function registerIcon(name: IconName, svg: FC<{ size: number }>): void {
  registry.set(name, svg);
}

/** Un'icona non ancora registrata diventa un riquadro vuoto della stessa misura. */
export function Icon({ name, size = 16 }: { name: IconName; size?: 16 | 32 }) {
  const Svg = registry.get(name);
  if (!Svg) {
    return (
      <span
        aria-hidden="true"
        data-icon={name}
        style={{ display: 'inline-block', width: size, height: size }}
      />
    );
  }
  return <Svg size={size} />;
}
