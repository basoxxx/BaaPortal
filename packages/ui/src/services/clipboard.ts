import type { Block, HmiObject, TagTable, Udt, WatchTable } from '@baaportal/project';
import type { BaaBridge } from '../bridge';

export type ClipboardItem =
  | { type: 'block'; block: Block }
  | { type: 'udt'; udt: Udt }
  | { type: 'tagTable'; table: TagTable };

export type ClipboardPayload =
  | {
      kind: 'objects';
      deviceId: string;
      items: ClipboardItem[];
      /** Taglia: l'incolla sposta e consuma gli appunti. */
      cut?: boolean;
    }
  | { kind: 'rows'; rowKind: 'tag' | 'constant' | 'member' | 'watch'; rows: unknown[] }
  | { kind: 'watchTables'; deviceId: string; tables: WatchTable[] }
  | { kind: 'hmiObjects'; objects: HmiObject[] };

// Gli appunti di sistema portano solo testo: l'ultimo oggetto copiato vive qui e vale
// finché il testo di sistema è ancora quello che abbiamo scritto.
let last: { text: string; payload: ClipboardPayload } | null = null;

export function copyToClipboard(bridge: BaaBridge, text: string, payload: ClipboardPayload): void {
  last = { text, payload };
  bridge.clipboardWriteText(text);
}

export async function readClipboard(
  bridge: BaaBridge,
): Promise<{ text: string; payload: ClipboardPayload | null }> {
  const text = await bridge.clipboardReadText();
  return { text, payload: last && last.text === text ? last.payload : null };
}

/** Ultimo oggetto copiato, senza controllare gli appunti di sistema (che si leggono in modo asincrono). */
export function peekClipboardPayload(): ClipboardPayload | null {
  return last?.payload ?? null;
}

/** Dopo un taglia-incolla l'origine non esiste più: la voce non è più incollabile. */
export function forgetClipboard(): void {
  last = null;
}
