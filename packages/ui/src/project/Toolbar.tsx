import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commands, type CommandId } from '../commands/commands';
import { Icon } from '../icons';
import '../icons/toolbar';
import { useAppStore, useServices } from '../state/AppContext';
import { searchFromToolbar } from '../search/findActions';
import { shortcutLabel } from './MenuBar';

/** Gruppi della barra degli strumenti (spec §8.2, punto 3), nell'ordine di TIA Portal. */
const GROUPS: CommandId[][] = [
  ['project.new', 'project.open', 'project.save', 'project.print'],
  ['edit.cut', 'edit.copy', 'edit.paste', 'edit.delete'],
  ['edit.undo', 'edit.redo'],
  ['edit.compile', 'online.download', 'online.upload', 'online.simulation'],
  [
    'online.goOnline',
    'online.goOffline',
    'online.accessibleDevices',
    'online.startCpu',
    'online.stopCpu',
  ],
  ['window.splitVertical'],
];

export function Toolbar() {
  const { t } = useTranslation();
  const ctx = useServices();
  const appState = useAppStore((s) => s);
  const [text, setText] = useState('');

  return (
    <div role="toolbar" data-testid="toolbar" className="baa-toolbar">
      {GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 ? (
            <span role="separator" aria-orientation="vertical" className="baa-toolbar-sep" />
          ) : null}
          {group.map((id) => {
            const cmd = commands[id];
            const label = t(cmd.labelKey);
            const checked = cmd.isChecked?.(appState);
            // Annulla/Ripeti dicono quale modifica toccano.
            const entry =
              id === 'edit.undo'
                ? appState.history.past.at(-1)
                : id === 'edit.redo'
                  ? appState.history.future[0]
                  : undefined;
            const name = entry ? `${label}: ${t(entry.labelKey)}` : label;
            return (
              <button
                key={id}
                type="button"
                className="baa-toolbar-btn"
                aria-label={label}
                aria-pressed={checked}
                title={
                  cmd.shortcut
                    ? `${name} (${shortcutLabel(cmd.shortcut, ctx.bridge.platform)})`
                    : name
                }
                disabled={!cmd.isEnabled(appState)}
                onClick={() => void cmd.run(ctx)}
              >
                {cmd.icon ? <Icon name={cmd.icon} size={16} /> : null}
              </button>
            );
          })}
        </Fragment>
      ))}
      <input
        type="search"
        className="baa-toolbar-search"
        placeholder={t('toolbar.search')}
        aria-label={t('toolbar.search')}
        value={text}
        disabled={!appState.doc}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim() !== '') searchFromToolbar(ctx.store, text);
        }}
      />
    </div>
  );
}
