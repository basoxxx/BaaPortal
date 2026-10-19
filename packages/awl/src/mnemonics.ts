// Conversione tra mnemonici internazionali e tedeschi, limitata ai token riconosciuti.
import type { Mnemonic } from './instructions';
import { parseDetailed } from './parser';

export function convertMnemonics(source: string, from: Mnemonic, to: Mnemonic): string {
  if (from === to) return source;
  const { tokens } = parseDetailed(source, from);
  let out = '';
  let pos = 0;
  for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
    if (t.start < pos) continue;
    const original = source.slice(t.start, t.end);
    const replacement = t[to];
    // minuscolo resta minuscolo, cosi' l'andata e ritorno e' identica
    const cased = original === original.toLowerCase() ? replacement.toLowerCase() : replacement;
    out += source.slice(pos, t.start) + cased;
    pos = t.end;
  }
  return out + source.slice(pos);
}
