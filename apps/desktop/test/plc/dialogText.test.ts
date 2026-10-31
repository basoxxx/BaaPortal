import { afterEach, describe, expect, it } from 'vitest';
import { setDialogLang, tr } from '../../src/main/plc/dialogText';

describe('testi delle conferme native', () => {
  afterEach(() => setDialogLang('it'));

  it('italiano per default, inglese dopo app:set-language, segnaposto sostituiti', () => {
    expect(tr('Caricare nella CPU {cpu}?', { cpu: 'CPU 315' })).toBe('Caricare nella CPU CPU 315?');
    setDialogLang('en');
    expect(tr('Caricare nella CPU {cpu}?', { cpu: 'CPU 315' })).toBe(
      'Download to the CPU CPU 315?',
    );
    expect(tr('Annulla')).toBe('Cancel');
    // Senza traduzione resta l'italiano; una lingua sconosciuta non cambia nulla.
    expect(tr('Testo nuovo')).toBe('Testo nuovo');
    setDialogLang('fr');
    expect(tr('Annulla')).toBe('Cancel');
  });
});
