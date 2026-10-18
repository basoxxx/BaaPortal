export type NameCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'EMPTY' | 'TOO_LONG' | 'INVALID_CHARS' | 'RESERVED' | 'TRAILING_DOT_OR_SPACE';
    };

const MAX_LENGTH = 128;
const INVALID_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Il nome del progetto deve essere utilizzabile come nome di file su Windows e macOS. */
export function validateProjectName(name: string): NameCheck {
  if (name.trim() === '') return { ok: false, reason: 'EMPTY' };
  if (name.length > MAX_LENGTH) return { ok: false, reason: 'TOO_LONG' };
  if (INVALID_CHARS.test(name)) return { ok: false, reason: 'INVALID_CHARS' };
  // Windows riserva questi nomi anche con un'estensione (es. "CON.txt").
  if (RESERVED.test(name.split('.')[0]!.trimEnd())) return { ok: false, reason: 'RESERVED' };
  if (name.endsWith('.') || name.endsWith(' ')) {
    return { ok: false, reason: 'TRAILING_DOT_OR_SPACE' };
  }
  return { ok: true };
}
