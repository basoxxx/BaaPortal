import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@baaportal/project';
import { initI18n, setLanguage, t } from '../src/i18n';
import { diagnosticText } from '../src/state/diagnostics';

const overlap = (count: string): Diagnostic => ({
  severity: 'warning',
  code: 'ADDRESS_OVERLAP',
  ref: { kind: 'tag', deviceId: 'd', tableId: 'tb', id: 't' },
  field: 'address',
  params: { other: 'Motore', count },
});

describe('diagnosticText', () => {
  it('sovrapposizione: con più tag il testo dice quanti sono', async () => {
    await initI18n('it');
    try {
      expect(diagnosticText(overlap('1'), t)).toBe("L'indirizzo si sovrappone a Motore");
      expect(diagnosticText(overlap('999'), t)).toBe(
        "L'indirizzo si sovrappone a 999 variabili, fra cui Motore",
      );
      await setLanguage('en');
      expect(diagnosticText(overlap('1'), t)).toBe('The address overlaps Motore');
      expect(diagnosticText(overlap('3'), t)).toBe('The address overlaps 3 tags, including Motore');
    } finally {
      await setLanguage('it');
    }
  });
});
