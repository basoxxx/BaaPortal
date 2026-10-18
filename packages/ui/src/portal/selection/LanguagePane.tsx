import { useTranslation } from 'react-i18next';
import { setLanguage, type Lang } from '../../i18n';

const LANGS: { id: Lang; label: string }[] = [
  { id: 'it', label: 'Italiano' },
  { id: 'en', label: 'English' },
];

export function LanguagePane() {
  const { t, i18n } = useTranslation();
  return (
    <>
      <h2>{t('portal.action.language')}</h2>
      <div className="baa-lang-options">
        {LANGS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="baa-btn"
            aria-pressed={i18n.language === id}
            onClick={() => void setLanguage(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
