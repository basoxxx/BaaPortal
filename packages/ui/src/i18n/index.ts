import i18next, { type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import it from './it.json';
import { getSettings, updateSettings } from '../settings/settings';

export type Lang = 'it' | 'en';

/** La lingua scelta nelle impostazioni (che migrano la vecchia chiave `baa.lang`). */
export function readSavedLang(): Lang {
  return getSettings().general.language;
}

export async function initI18n(lang: Lang = readSavedLang()): Promise<void> {
  if (i18next.isInitialized) {
    await i18next.changeLanguage(lang);
    return;
  }
  await i18next.use(initReactI18next).init({
    lng: lang,
    fallbackLng: 'it',
    resources: { it: { translation: it }, en: { translation: en } },
    // I percorsi dei file contengono '/': nessun escape HTML (React esegue già l'escape).
    interpolation: { escapeValue: false },
  });
}

export async function setLanguage(lang: Lang): Promise<void> {
  updateSettings({ general: { language: lang } });
  await i18next.changeLanguage(lang);
}

export const t: TFunction = i18next.t.bind(i18next) as TFunction;
export { i18next };
