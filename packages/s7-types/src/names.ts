export type NameCheck =
  | { ok: true }
  | { ok: false; reason: 'EMPTY' | 'TOO_LONG' | 'INVALID_CHARS' | 'LEADING_TRAILING_SPACE' };

const MAX_NAME_LENGTH = 128;

export function validateS7Name(name: string): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'EMPTY' };
  if (Array.from(name).length > MAX_NAME_LENGTH) return { ok: false, reason: 'TOO_LONG' };
  if (/["\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'INVALID_CHARS' };
  if (/^\s|\s$/.test(name)) return { ok: false, reason: 'LEADING_TRAILING_SPACE' };
  return { ok: true };
}

function key(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function sameName(a: string, b: string): boolean {
  return key(a) === key(b);
}

// Aggiunge `_1`, oppure incrementa il numero finale conservando gli zeri iniziali.
export function incrementName(name: string): string {
  const m = /^(.*)_(\d+)$/.exec(name);
  if (!m) return `${name}_1`;
  const digits = m[2] as string;
  return `${m[1]}_${(BigInt(digits) + 1n).toString().padStart(digits.length, '0')}`;
}
