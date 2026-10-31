import { afterEach, describe, expect, it } from 'vitest';
import { INTERRUPT_MESSAGE } from '../../src/main/plc/closeGuard';
import { EN, setDialogLang, tr } from '../../src/main/plc/dialogText';

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

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

  it('ogni chiave ha it ed en non vuoti, con gli stessi segnaposto', () => {
    for (const [it, en] of Object.entries(EN)) {
      expect(it.trim(), en).not.toBe('');
      expect(en.trim(), it).not.toBe('');
      expect(placeholders(en), it).toEqual(placeholders(it));
    }
  });

  it('dettagli lunghi ed errori tradotti, italiano identico', () => {
    expect(tr(INTERRUPT_MESSAGE)).toBe(
      'Un caricamento nella CPU è in corso. Interromperlo? La CPU può restare con un programma incompleto.',
    );
    setDialogLang('en');
    expect(tr(INTERRUPT_MESSAGE)).toMatch(/^A download to the CPU is in progress/);
    expect(tr('FUNZIONE SPERIMENTALE, mai provata su una CPU reale. La CPU andrà in STOP.')).toBe(
      'EXPERIMENTAL FUNCTION, never tried on a real CPU. The CPU will go to STOP.',
    );
    expect(tr('Nessuna risposta da {where}', { where: '192.168.0.1:102' })).toBe(
      'No response from 192.168.0.1:102',
    );
  });
});
