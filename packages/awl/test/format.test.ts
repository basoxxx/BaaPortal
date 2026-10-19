import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatNetwork, parseNetwork, type Mnemonic } from '../src';

const fixtures = readdirSync(new URL('./fixtures', import.meta.url))
  .filter((f) => f.endsWith('.awl'))
  .map((f) => [
    f,
    readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'),
    f.startsWith('german') ? 'german' : 'international',
  ]) as [string, string, Mnemonic][];

describe('formatNetwork', () => {
  it('produce la forma canonica', () => {
    const src = 'M001:  a   i 0.0 // avvio\n an "Stop"\n= db10.dbx 2.0;\nju   M001';
    expect(formatNetwork(src, 'international')).toBe(
      'M001:\tA %I0.0; // avvio\n\tAN "Stop";\n\t= %DB10.DBX2.0;\n\tJU M001;',
    );
  });

  it('indirizzi indiretti, blocchi e costanti', () => {
    const src = 'A I [MD 2]\nT W [AR1,P#2.0]\nOPN DB [MW 2]\nL P#M 0.0\nA T 5\nCALL fc 1';
    expect(formatNetwork(src, 'international').split('\n')).toEqual([
      '\tA %I[MD2];',
      '\tT %W[AR1,P#2.0];',
      '\tOPN %DB[MW2];',
      '\tL P#M 0.0;',
      '\tA %T5;',
      '\tCALL %FC1;',
    ]);
  });

  it('mnemonico tedesco', () => {
    expect(formatNetwork('u e 0.0\nspb m1\nse t 1', 'german')).toBe(
      '\tU %E0.0;\n\tSPB m1;\n\tSE %T1;',
    );
  });

  it('parametri di CALL su righe separate con frecce allineate', () => {
    const src = 'CALL "Nastro", "Nastro_DB"\n(Avvio := %I0.0, Errore_lungo => %M10.0);// x';
    expect(formatNetwork(src, 'international')).toBe(
      [
        '\tCALL "Nastro", "Nastro_DB"',
        '\t(',
        '\t   Avvio        := %I0.0,',
        '\t   Errore_lungo => %M10.0',
        '\t); // x',
      ].join('\n'),
    );
  });

  it("righe con errori restano com'erano, le altre si normalizzano", () => {
    expect(formatNetwork('a  i0.0\n  XYZ   q0.0\n\n// nota\nbe', 'international')).toBe(
      '\tA %I0.0;\n  XYZ   q0.0\n\n\t// nota\n\tBE;',
    );
  });

  it('mantiene CRLF e riga finale', () => {
    expect(formatNetwork('A I0.0\r\nBE\r\n', 'international')).toBe('\tA %I0.0;\r\n\tBE;\r\n');
  });

  it('commenti dentro i parametri non si perdono', () => {
    const src = 'CALL FC 1\n(\n a := 1, // uno\n b := 2\n);';
    expect(formatNetwork(src, 'international')).toBe(src);
  });

  it('commento fra CALL e parentesi, etichette sole e righe vuote', () => {
    const src = 'CALL FC 1 // c\n(\n a := 1\n);\nM1:\n\n\nBE';
    expect(formatNetwork(src, 'international')).toBe(
      'CALL FC 1 // c\n(\n a := 1\n);\nM1:\n\n\n\tBE;',
    );
  });

  it.each(fixtures)('fixture %s: idempotente e con le stesse istruzioni', (_n, src, m) => {
    const once = formatNetwork(src, m);
    expect(formatNetwork(once, m)).toBe(once);
    const a = parseNetwork(src, m);
    const b = parseNetwork(once, m);
    expect(b.errors).toEqual([]);
    expect(b.statements.map((s) => [s.instruction.def?.id, s.operand?.kind, s.comment])).toEqual(
      a.statements.map((s) => [s.instruction.def?.id, s.operand?.kind, s.comment]),
    );
  });

  it('testo casuale: non lancia e resta idempotente', () => {
    const alphabet = 'AIQMEU0123456789.#"%[]()=<>:;,_ \nPBWDCTL//XCALL';
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 500; n++) {
      let s = '';
      for (let k = rnd() * 60; k > 0; k--) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const once = formatNetwork(s, 'international');
      expect(formatNetwork(once, 'international')).toBe(once);
    }
  });
});
