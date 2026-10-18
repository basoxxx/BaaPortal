import i18next, { type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import it from './it.json';

export type Lang = 'it' | 'en';
const STORAGE_KEY = 'baa.lang';

export function readSavedLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' ? 'en' : 'it';
  } catch {
    return 'it';
  }
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
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage non disponibile: la lingua vale solo per questa sessione */
  }
  await i18next.changeLanguage(lang);
}

export const t: TFunction = i18next.t.bind(i18next) as TFunction;
export { i18next };
