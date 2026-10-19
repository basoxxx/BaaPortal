import { describe, expect, it } from 'vitest';
import {
  applySource,
  decodeSourceBytes,
  encodeSourceText,
  generateAwlSource,
  parseAwlSource,
} from '../src/index';
import { allRefs, emptyDevice, fixture, seq } from './helpers';

const normalize = (t: string) => decodeSourceBytes(encodeSourceText(t)).text;

const CANONICAL = [
  'udt.awl',
  'fb.awl',
  'fc.awl',
  'ob1.awl',
  'db.awl',
  'idb.awl',
  'attributi.awl',
  'nomi.awl',
  'tutto.awl',
  'collaudo.awl',
];

function roundTrip(text: string): string {
  const parsed = parseAwlSource(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const d = emptyDevice();
  applySource(d, parsed.source, seq('n'));
  return generateAwlSource(d, allRefs(d), parsed.source.mnemonic);
}

describe('andata e ritorno', () => {
  it.each(CANONICAL)('si riesporta identica: %s', (name) => {
    const text = fixture(name);
    expect(normalize(roundTrip(text))).toBe(normalize(text));
  });

  it('con le fine riga CRLF e il BOM il risultato è lo stesso', () => {
    const text = fixture('tutto.awl');
    const crlf = '﻿' + text.replace(/\n/g, '\r\n');
    expect(normalize(roundTrip(crlf))).toBe(normalize(text));
  });

  it('una seconda importazione sullo stesso dispositivo sostituisce, non duplica', () => {
    const text = fixture('tutto.awl');
    const d = emptyDevice();
    const p = parseAwlSource(text);
    if (!p.ok) throw new Error();
    applySource(d, p.source, seq('a'));
    const first = d.blocks.length + d.udts.length;
    const r = applySource(d, p.source, seq('b'));
    expect(d.blocks.length + d.udts.length).toBe(first);
    expect(r.created).toHaveLength(0);
    expect(r.replaced).toHaveLength(first);
    expect(normalize(generateAwlSource(d, allRefs(d), 'international'))).toBe(normalize(text));
  });
});

describe('prestazioni', () => {
  it(
    'una sorgente generata di circa 5000 righe si analizza in meno di 2 s',
    { timeout: 30_000 },
    () => {
      const net = [
        'NETWORK',
        'TITLE = Rete',
        '\tA %I0.0;',
        '\tAN %I0.1;',
        '\t= %Q0.0;',
        '\tL %MW10;',
        '\tL 5;',
        '\t>I;',
      ];
      const unit = (n: number) =>
        [
          `FUNCTION_BLOCK "Blocco${n}"`,
          'TITLE =',
          'VERSION : 0.1',
          '',
          'VAR_INPUT',
          '  Avvio : Bool;',
          'END_VAR',
          '',
          'BEGIN',
          ...Array.from({ length: 40 }, () => net).flat(),
          'END_FUNCTION_BLOCK',
          '',
        ].join('\n');
      const text = Array.from({ length: 16 }, (_, n) => unit(n)).join('\n');
      expect(text.split('\n').length).toBeGreaterThan(5000);
      const t0 = performance.now();
      const r = parseAwlSource(text);
      const ms = performance.now() - t0;
      expect(r.ok).toBe(true);
      expect(ms).toBeLessThan(2000);
    },
  );
});
