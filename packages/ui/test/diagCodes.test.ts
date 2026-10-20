import { describe, expect, it } from 'vitest';
import { AWL_CODES } from '@baaportal/awl';
import { MC7_DIAG_CODES } from '@baaportal/mc7';
import { MC7_BRIDGE_DIAG_CODES } from '@baaportal/project';
import en from '../src/i18n/en.json';
import it_ from '../src/i18n/it.json';
import { localizeDiagnostic } from '../src/project/compile/CompileMessages';
import i18next from 'i18next';

const has = (tree: unknown, path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], tree);

describe('testi delle diagnostiche di compilazione', () => {
  it('ogni codice emesso ha un testo in italiano e in inglese', () => {
    for (const lang of [it_, en]) {
      for (const c of [...MC7_DIAG_CODES, ...MC7_BRIDGE_DIAG_CODES]) {
        expect(typeof has(lang, `mc7.diag.${c}`), c).toBe('string');
      }
      for (const c of AWL_CODES) expect(typeof has(lang, `awl.diag.${c}`), c).toBe('string');
    }
  });

  it('DIPENDENZA_RIFATTA e IDB_INCOERENTE: ogni contesto della causa ha il suo testo (it ed en)', () => {
    const contexts = {
      DIPENDENZA_RIFATTA: [
        'foreign',
        'incoherent',
        'import',
        'import_via',
        'changed',
        'changed_via',
      ],
      DB_NON_CONVERTITO: [
        'incoherent',
        'foreign',
        'rebuilt',
        'rebuilt_foreign',
        'rebuilt_incoherent',
        'rebuilt_import',
        'rebuilt_import_via',
        'rebuilt_changed',
        'rebuilt_changed_via',
      ],
      IDB_INCOERENTE: [
        'foreign',
        'incoherent',
        'rebuilt',
        'rebuilt_foreign',
        'rebuilt_incoherent',
        'rebuilt_changed',
        'rebuilt_changed_via',
      ],
    };
    for (const lang of [it_, en]) {
      for (const [code, list] of Object.entries(contexts)) {
        for (const c of list) {
          expect(typeof has(lang, `mc7.diag.${code}_${c}`), `${code}_${c}`).toBe('string');
        }
      }
    }
  });

  it('DIPENDENZA_RIFATTA: il contesto sceglie il testo; il blocco che si rifà non si ripete', () => {
    const it = i18next.getFixedT('it');
    const en = i18next.getFixedT('en');
    // FB 10 si rifà lui stesso: niente "FB10: FB10 si rifà"
    const self = { dep: 'FB10', cause: 'x', context: 'import', src: 'FB20', via: 'FB10' };
    expect(it('mc7.diag.DIPENDENZA_RIFATTA', self)).toContain(
      'rifà la struttura di FB10 perché FB20 cambia con questa importazione',
    );
    expect(en('mc7.diag.DIPENDENZA_RIFATTA', self)).toContain(
      'layout of FB10 because FB20 changes with this import',
    );
    // FB 30 si rifà perché FB 20, del lotto, cambia
    const via = { dep: 'FB40', cause: 'x', context: 'changed_via', src: 'FB20', via: 'FB30' };
    expect(it('mc7.diag.DIPENDENZA_RIFATTA', via)).toContain(
      'di FB40: FB30 si rifà perché FB20 è cambiato',
    );
    expect(en('mc7.diag.DIPENDENZA_RIFATTA', via)).toContain(
      'of FB40: FB30 is rebuilt because FB20 has changed',
    );
    // senza contesto: il testo generico con la causa
    expect(en('mc7.diag.DIPENDENZA_RIFATTA', { dep: 'DB30', cause: 'x' })).toContain('(x)');
  });

  it('IDB_INCOERENTE: il testo tradotto dice la causa', () => {
    const it = i18next.getFixedT('it');
    const en = i18next.getFixedT('en');
    const p = { fb: 'FB30', context: 'rebuilt_incoherent', src: 'FB20' };
    expect(it('mc7.diag.IDB_INCOERENTE', p)).toContain(
      'rifà la struttura di FB30 (FB20 non torna con lo stesso lotto)',
    );
    expect(en('mc7.diag.IDB_INCOERENTE', p)).toContain(
      'layout of FB30 (FB20 does not match the same batch)',
    );
    const changed = { fb: 'FB30', context: 'rebuilt_changed', src: 'FB20', via: 'FB30' };
    expect(it('mc7.diag.IDB_INCOERENTE', changed)).toContain('di FB30 perché FB20 è cambiato');
    expect(en('mc7.diag.IDB_INCOERENTE', changed)).toContain('of FB30 because FB20 has changed');
    expect(en('mc7.diag.IDB_INCOERENTE', { fb: 'FB10', context: 'foreign' })).toContain(
      'FB10 in the project does not come from the import',
    );
    // senza contesto (diagnostica di prima): il testo generico
    expect(it('mc7.diag.IDB_INCOERENTE', { fb: 'FB10' })).toContain(
      'non è stato compilato per FB10',
    );
  });

  it('i parametri della diagnostica si interpolano; un codice sconosciuto usa il messaggio', () => {
    const t = i18next.t.bind(i18next);
    const exists = (k: string) => i18next.exists(k);
    const base = { severity: 'warning' as const, network: 1, line: 2 };
    expect(
      localizeDiagnostic(t, exists, {
        ...base,
        code: 'CALL_NON_VERIFICATO',
        message: 'x',
        params: { block: 'FC7', forms: 'senza RLO' },
      }),
    ).toBe('CALL FC7 compilata con forme senza esempio reale verificato: senza RLO.');
    expect(
      localizeDiagnostic(t, exists, {
        ...base,
        code: 'NUOVO_CODICE',
        message: 'testo {{x}} grezzo',
      }),
    ).toBe('testo {{x}} grezzo');
    // Codice del controllo AWL con parametro `name`: testo di awl.diag.
    expect(
      localizeDiagnostic(t, exists, {
        ...base,
        code: 'UNKNOWN_SYMBOL',
        message: 'm',
        params: { name: 'Pippo' },
      }),
    ).toBe('Il simbolo "Pippo" non esiste');
    // Lo stesso codice senza parametri (dal compilatore): testo con il dettaglio.
    expect(
      localizeDiagnostic(t, exists, { ...base, code: 'UNKNOWN_SYMBOL', message: 'dettaglio' }),
    ).toBe('Simbolo sconosciuto: dettaglio');
  });
});
