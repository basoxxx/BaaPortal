import { useMemo } from 'react';
import { displayLanguage, shownText, type TextField } from '@baaportal/project';
import { useAppStore } from './AppContext';

export interface ShownTexts {
  /** Lingua di traduzione mostrata, o null: si mostra e si modifica il testo della lingua di modifica. */
  lang: string | null;
  /** Il testo da mostrare; con una traduzione scelta ricade sul testo di modifica se manca. */
  shown(deviceId: string, ownerId: string, field: TextField, original: string): string;
}

/**
 * Commenti e titoli nella lingua scelta per il progetto (7D). Finché si guarda una traduzione i
 * campi sono di sola lettura: si modificano nella lingua di modifica o da «Testi di progetto».
 */
export function useShownTexts(): ShownTexts {
  const languages = useAppStore((s) => s.doc?.project.languages);
  const texts = useAppStore((s) => s.doc?.project.texts);
  const lang = displayLanguage({ languages });
  return useMemo(
    () => ({
      lang,
      shown: (deviceId, ownerId, field, original) =>
        lang ? shownText({ languages, texts }, deviceId, ownerId, field, original) : original,
    }),
    [lang, languages, texts],
  );
}
