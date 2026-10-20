import type { Block } from '@baaportal/project';

/**
 * Un blocco importato da MC7 che non si può ricodificare identico (`mc7.exact` falso) si mostra
 * in sola lettura: il suo file originale resta l'unica fonte dei byte (si esporta com'è).
 */
export const isLockedImport = (b: Block | undefined): boolean => !!b?.mc7 && !b.mc7.exact;

/** Una rete che contiene righe `// MC7 grezzo:` (istruzioni che il testo non sa esprimere). */
export const hasRawLines = (source: string): boolean => /^[ \t]*\/\/ MC7 grezzo:/m.test(source);

/** Blocco protetto know-how importato: si mostra solo l'interfaccia, il codice non c'è. */
export const isKnowHowLocked = (b: Block | undefined): boolean => !!b?.mc7?.knowHowLocked;

/** Chiave del testo del banner di un blocco bloccato (`block.knowHowBanner` o `block.readOnlyBanner`). */
export const lockedBannerKey = (b: Block | undefined): string =>
  isKnowHowLocked(b) ? 'block.knowHowBanner' : 'block.readOnlyBanner';
