import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SourceError } from '@baaportal/importers';
import { findDevice } from '@baaportal/project';
import { Dialog } from '../../components/Dialog';
import { useServices } from '../../state/AppContext';
import { sourceErrorKey } from '../navigation/sourceActions';
import {
  defaultSelection,
  pickStep7Files,
  planStep7Import,
  runStep7Import,
  type Step7Item,
  type Step7Plan,
} from '../navigation/step7Import';

const OWN_CODES = new Set(['FILE_TOO_LARGE', 'UNKNOWN_FORMAT', 'SCL_SECTION_MOVED']);

/** «Importa da STEP 7…»: scelta dei file, anteprima con le voci da importare, importazione. */
export function Step7ImportDialog({ deviceId, onClose }: { deviceId: string; onClose(): void }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const [plan, setPlan] = useState<Step7Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const errorText = (e: SourceError) =>
    t(OWN_CODES.has(e.code) ? `step7.err.${e.code}` : sourceErrorKey(e.code), e.params ?? {});

  const pick = async () => {
    setBusy(true);
    try {
      const files = await pickStep7Files({ store, bridge });
      const doc = store.getState().doc;
      const dev = doc && findDevice(doc.project, deviceId);
      if (!files || !dev) return;
      const next = planStep7Import(dev, files);
      setPlan(next);
      setSelected(defaultSelection(next));
    } finally {
      setBusy(false);
    }
  };

  const ok = () => {
    if (!plan || selected.size === 0) return;
    runStep7Import(store, deviceId, plan, selected);
    onClose();
  };

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const state = (i: Step7Item): string =>
    i.kind === 'tags'
      ? t('step7.state.tags', { count: i.number ?? 0 })
      : i.kind === 'rename'
        ? t('step7.state.rename', { old: i.replaces ?? '' })
        : i.nameTakenBy !== undefined
          ? t('step7.state.nameTaken', { owner: i.nameTakenBy })
          : i.replaces !== undefined
            ? t('step7.state.replaces', { name: i.replaces })
            : t('step7.state.new');

  return (
    <Dialog
      title={t('step7.title')}
      onClose={onClose}
      onOk={ok}
      okDisabled={!plan || selected.size === 0}
      testId="step7-import"
      footer={
        <>
          <button
            type="button"
            data-testid="dialog-ok"
            disabled={!plan || selected.size === 0}
            onClick={ok}
          >
            {t('step7.import')}
          </button>
          <button type="button" data-testid="dialog-cancel" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
        </>
      }
    >
      <p>{t('step7.intro')}</p>
      <button type="button" data-testid="step7-pick" disabled={busy} onClick={() => void pick()}>
        {t('step7.pick')}
      </button>
      {plan ? (
        <>
          <h3>{t('step7.files')}</h3>
          <ul data-testid="step7-files">
            {plan.read.files.map((f) => (
              <li key={f.name}>
                {f.name}
                {f.errors.length > 0
                  ? ` — ${t('step7.fileErrors', { count: f.errors.length })}`
                  : ''}
                {f.errors.length + f.rowErrors.length + f.warnings.length > 0 ? (
                  <ul>
                    {f.errors.map((e, n) => (
                      <li key={`e${n}`} className="error">
                        {t('step7.lineMessage', { line: e.line, message: errorText(e) })}
                      </li>
                    ))}
                    {f.rowErrors.map((e, n) => (
                      <li key={`r${n}`}>
                        {t('step7.lineMessage', {
                          line: e.line,
                          message: t(`tagIo.err.${e.code}`, { detail: e.detail ?? '' }),
                        })}
                      </li>
                    ))}
                    {f.warnings.map((e, n) => (
                      <li key={`w${n}`}>
                        {t('step7.lineMessage', { line: e.line, message: errorText(e) })}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {plan.items.length === 0 ? (
            <p>{t('step7.empty')}</p>
          ) : (
            <table data-testid="step7-items">
              <thead>
                <tr>
                  <th>{t('step7.col.include')}</th>
                  <th>{t('step7.col.kind')}</th>
                  <th>{t('step7.col.name')}</th>
                  <th>{t('step7.col.file')}</th>
                  <th>{t('step7.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((i) => (
                  <tr key={i.key}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={i.name}
                        checked={selected.has(i.key)}
                        disabled={i.nameTakenBy !== undefined}
                        onChange={() => toggle(i.key)}
                      />
                    </td>
                    <td>
                      {t(`step7.kind.${i.kind}`)}
                      {i.number !== undefined && i.kind !== 'tags' ? ` ${i.number}` : ''}
                    </td>
                    <td>{i.name}</td>
                    <td>{i.file}</td>
                    <td>
                      {state(i)}
                      {i.sclErrors ? (
                        <span title={i.sclErrors.map((e) => `${e.line}: ${e.message}`).join('\n')}>
                          {' '}
                          {t('step7.sclErrors', { count: i.sclErrors.length })}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
