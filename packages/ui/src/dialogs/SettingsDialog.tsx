import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../components/Dialog';
import { i18next } from '../i18n';
import { useUpdateState } from '../update/updateController';
import {
  DEFAULT_SETTINGS,
  FONT_SIZES,
  RECOVERY_MINUTES,
  TAB_SIZES,
  UI_SCALES,
  getSettings,
  saveSettings,
  type Settings,
} from '../settings/settings';
import './settingsDialog.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="baa-settings-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Impostazioni dell'applicazione: si modifica una bozza, applicata solo con OK. Non fanno parte del progetto. */
export function SettingsDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { info } = useUpdateState();
  const updatesOn = info?.enabled === true;
  const [draft, setDraft] = useState<Settings>(() => structuredClone(getSettings()));
  const general = (patch: Partial<Settings['general']>) =>
    setDraft((d) => ({ ...d, general: { ...d.general, ...patch } }));
  const editor = (patch: Partial<Settings['editor']>) =>
    setDraft((d) => ({ ...d, editor: { ...d.editor, ...patch } }));

  const updates = (patch: Partial<Settings['updates']>) =>
    setDraft((d) => ({ ...d, updates: { ...d.updates, ...patch } }));
  // Senza valore esplicito la casella segue il canale della build.
  const prereleaseShown = draft.updates.prerelease ?? info?.prereleaseBuild ?? false;

  const apply = () => {
    saveSettings(draft);
    void i18next.changeLanguage(draft.general.language);
    onClose();
  };

  return (
    <Dialog
      title={t('settings.title')}
      onClose={onClose}
      onOk={apply}
      testId="settings-dialog"
      footer={
        <>
          <button
            type="button"
            data-testid="settings-reset"
            onClick={() => setDraft(structuredClone(DEFAULT_SETTINGS))}
          >
            {t('settings.reset')}
          </button>
          <button type="button" data-testid="dialog-ok" onClick={apply}>
            {t('dialog.ok')}
          </button>
          <button type="button" data-testid="dialog-cancel" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
        </>
      }
    >
      <div className="baa-settings">
        <section>
          <h3>{t('settings.general')}</h3>
          <Row label={t('settings.language')}>
            <select
              value={draft.general.language}
              onChange={(e) =>
                general({ language: e.target.value as Settings['general']['language'] })
              }
            >
              <option value="it">Italiano</option>
              <option value="en">English</option>
            </select>
          </Row>
          <Row label={t('settings.author')}>
            <input
              value={draft.general.author}
              onChange={(e) => general({ author: e.target.value })}
            />
          </Row>
          <Row label={t('settings.recovery')}>
            <select
              value={draft.general.recoveryMinutes}
              onChange={(e) =>
                general({
                  recoveryMinutes: Number(e.target.value) as Settings['general']['recoveryMinutes'],
                })
              }
            >
              {RECOVERY_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t('settings.recoveryOff') : t('settings.minutes', { count: m })}
                </option>
              ))}
            </select>
          </Row>
        </section>
        <section>
          <h3>{t('settings.appearance')}</h3>
          <Row label={t('settings.uiScale')}>
            <select
              value={draft.appearance.uiScale}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  appearance: {
                    uiScale: Number(e.target.value) as Settings['appearance']['uiScale'],
                  },
                }))
              }
            >
              {UI_SCALES.map((s) => (
                <option key={s} value={s}>{`${s}%`}</option>
              ))}
            </select>
          </Row>
        </section>
        <section>
          <h3>{t('settings.editor')}</h3>
          <Row label={t('settings.mnemonic')}>
            <select
              value={draft.editor.mnemonic}
              onChange={(e) =>
                editor({ mnemonic: e.target.value as Settings['editor']['mnemonic'] })
              }
            >
              <option value="int">{t('block.mnemonicInternational')}</option>
              <option value="de">{t('block.mnemonicGerman')}</option>
            </select>
          </Row>
          <Row label={t('settings.fontSize')}>
            <select
              value={draft.editor.fontSize}
              onChange={(e) =>
                editor({ fontSize: Number(e.target.value) as Settings['editor']['fontSize'] })
              }
            >
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>{`${s} px`}</option>
              ))}
            </select>
          </Row>
          <Row label={t('settings.tabSize')}>
            <select
              value={draft.editor.tabSize}
              onChange={(e) =>
                editor({ tabSize: Number(e.target.value) as Settings['editor']['tabSize'] })
              }
            >
              {TAB_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t('settings.autocomplete')}>
            <input
              type="checkbox"
              checked={draft.editor.autocomplete}
              onChange={(e) => editor({ autocomplete: e.target.checked })}
            />
          </Row>
          <Row label={t('settings.lineNumbers')}>
            <input
              type="checkbox"
              checked={draft.editor.lineNumbers}
              onChange={(e) => editor({ lineNumbers: e.target.checked })}
            />
          </Row>
        </section>
        <section>
          <h3>{t('settings.online.title')}</h3>
          <Row label={t('settings.online.experimental')}>
            <input
              type="checkbox"
              checked={draft.online.experimental}
              onChange={(e) =>
                setDraft((d) => ({ ...d, online: { experimental: e.target.checked } }))
              }
              data-testid="settings-experimental"
            />
          </Row>
          <p className="baa-settings-note">{t('settings.online.note')}</p>
        </section>
        <section data-testid="settings-updates">
          <h3>{t('settings.updates')}</h3>
          <Row label={t('settings.updatesCheck')}>
            <input
              type="checkbox"
              disabled={!updatesOn}
              checked={draft.updates.checkOnStartup}
              onChange={(e) => updates({ checkOnStartup: e.target.checked })}
            />
          </Row>
          <Row label={t('settings.updatesPrerelease')}>
            <input
              type="checkbox"
              disabled={!updatesOn}
              checked={prereleaseShown}
              onChange={(e) => updates({ prerelease: e.target.checked })}
            />
          </Row>
          {info ? (
            <p>
              {info.prereleaseBuild
                ? t('settings.updatesChannelBeta')
                : t('settings.updatesChannelStable')}
            </p>
          ) : null}
          {updatesOn ? null : <p>{t('settings.updatesDisabled')}</p>}
        </section>
      </div>
    </Dialog>
  );
}
