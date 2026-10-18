import { useTranslation } from 'react-i18next';
import { commands } from '../commands/commands';
import { useServices } from '../state/AppContext';

/** Barra degli editor: vuota in 1A, con il collegamento alla vista portale a sinistra. */
export function EditorBar() {
  const { t } = useTranslation();
  const ctx = useServices();
  return (
    <div data-testid="editor-bar" className="baa-editor-bar">
      <button
        type="button"
        data-testid="link-portal-view"
        className="baa-link-portal"
        onClick={() => void commands['view.portal'].run(ctx)}
      >
        <span aria-hidden="true">◂ </span>
        {t(commands['view.portal'].labelKey)}
      </button>
    </div>
  );
}
