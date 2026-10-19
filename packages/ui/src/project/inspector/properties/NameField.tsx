import { useTranslation } from 'react-i18next';
import { checkRename, renameInfo, renameNode } from '../../navigation/objectCommands';
import { useAppStore, useServices } from '../../../state/AppContext';
import { TextField } from './fields';

/** Nome dell'oggetto: stesso controllo e stessa rinomina dell'albero (riferimenti inclusi). */
export function NameField({ nodeId, fallback }: { nodeId: string; fallback: string }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const doc = useAppStore((s) => s.doc);
  const info = renameInfo(doc, nodeId);
  return (
    <TextField
      label={t('inspector.name')}
      value={info?.name ?? fallback}
      onCommit={info ? (v) => void renameNode(store, nodeId, v) : undefined}
      validate={(v) => {
        const e = checkRename(store.getState().doc, nodeId, v);
        return e ? t(e === 'INVALID' ? 'diag.NAME_INVALID' : 'diag.NAME_DUPLICATE') : null;
      }}
    />
  );
}
