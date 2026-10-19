import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS, parseNetwork, type Mnemonic, type Operand } from '../src';

const op = (src: string, m: Mnemonic = 'international') => {
  const r = parseNetwork(src, m);
  return { operand: r.statements[0]?.operand, errors: r.errors, r };
};
const fixtures = readdirSync(new URL('./fixtures', import.meta.url))
  .filter((f) => f.endsWith('.awl'))
  .map((f) => [
    f,
    readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'),
    f.startsWith('german') ? 'german' : 'international',
  ]) as [string, string, Mnemonic][];

describe('parseNetwork', () => {
  it('analizza istruzioni, etichette, commenti e operandi', () => {
    const { statements, errors } = parseNetwork(
      'M001: A %I0.0 // avvio\n      AN "Stop"\n      = #Uscita.bit;\n      JC M001',
      'international',
    );
    expect(errors).toEqual([]);
    expect(
      statements.map((s) => [s.label?.name ?? '', s.instruction.def?.id, s.operand?.kind]),
    ).toEqual([
      ['M001', 'A', 'address'],
      ['', 'AN', 'symbol'],
      ['', '=', 'local'],
      ['', 'JC', 'labelRef'],
    ]);
    expect(statements[0]!.comment).toBe('avvio');
  });

  it('indirizzi assoluti, indiretti e qualificati', () => {
    expect(op('L DB10.DBW 4').operand).toMatchObject({
      kind: 'address',
      area: 'DB',
      db: 10,
      size: 'W',
      byte: 4,
    });
    expect(op('A DBX 2.1').operand).toMatchObject({ area: 'DB', size: 'X', byte: 2, bit: 1 });
    expect(op('A %I0.7').operand).toMatchObject({ area: 'I', size: 'X', byte: 0, bit: 7 });
    expect(op('L PIW 256').operand).toMatchObject({ area: 'PI', size: 'W', byte: 256 });
    expect(op('A T 5').operand).toMatchObject({ kind: 'timerCounter', area: 'T', number: 5 });
    expect(op('OPN DB 10').operand).toMatchObject({ kind: 'block', blockKind: 'DB', number: 10 });
    expect(op('A I [MD 2]').operand).toMatchObject({
      kind: 'indirect',
      area: 'I',
      via: { kind: 'memory', location: { kind: 'address', area: 'M', size: 'D', byte: 2 } },
    });
    expect(op('T W [AR1, P#2.0]').operand).toMatchObject({
      kind: 'indirect',
      area: null,
      size: 'W',
      via: { kind: 'register', ar: 1, offset: 'P#2.0' },
    });
    expect(op('A M [AR2, P#0.1]').operand).toMatchObject({
      kind: 'indirect',
      area: 'M',
      via: { kind: 'register', ar: 2 },
    });
    expect(op('OPN DB [MW 2]').operand).toMatchObject({ kind: 'indirect', area: 'DB' });
  });

  it('simboli, locali, costanti, speciali e stato', () => {
    const sym = op('A "DB".arr[1,2].x').operand as Extract<Operand, { kind: 'symbol' }>;
    expect(sym.path.map((p) => [p.name, p.quoted, p.index])).toEqual([
      ['DB', true, undefined],
      ['arr', false, [1, 2]],
      ['x', false, undefined],
    ]);
    expect(op('A #"nome x".y').operand).toMatchObject({ kind: 'local' });
    expect(op('L P#M 0.0').operand).toMatchObject({ kind: 'constant', text: 'P#M 0.0' });
    expect(op('L 1.5e+002').operand).toMatchObject({ kind: 'constant', text: '1.5e+002' });
    expect(op('L STW').operand).toMatchObject({ kind: 'special', name: 'STW' });
    expect(op('T STW').operand).toMatchObject({ kind: 'special', name: 'STW' });
    expect(op('L DINO').operand).toMatchObject({ kind: 'special', name: 'DINO' });
    expect(op('NOP 1').operand).toMatchObject({ kind: 'constant', text: '1' });
    expect(op('A ==0').operand).toMatchObject({ kind: 'status', condition: '==0' });
    expect(op('O OV').operand).toMatchObject({ kind: 'status', condition: 'OV' });
    expect(op('U BIE', 'german').operand).toMatchObject({ kind: 'status', condition: 'BIE' });
  });

  it('range esatti degli operandi', () => {
    const src = 'A I0.0\n   L DB10.DBW 4';
    const r = parseNetwork(src, 'international');
    const o = r.statements[1]!.operand!;
    expect(src.slice(o.range.from.offset, o.range.to.offset)).toBe('DB10.DBW 4');
    expect(o.range.from).toEqual({ line: 1, col: 5, offset: 12 });
  });

  it('CALL con istanza e parametri su più righe, := e =>', () => {
    const { statements, errors } = parseNetwork(
      'CALL "Nastro", "Nastro_DB"\n(  Avvio := %I0.0,\n   Errore => %M10.0\n);',
      'international',
    );
    expect(errors).toEqual([]);
    expect(statements[0]!.operand).toMatchObject({ kind: 'symbol' });
    expect(statements[0]!.instanceDb).toMatchObject({ kind: 'symbol' });
    expect(statements[0]!.params!.map((p) => [p.name, p.arrow])).toEqual([
      ['Avvio', ':='],
      ['Errore', '=>'],
    ]);
    expect(statements[0]!.params![1]!.value).toMatchObject({ kind: 'address', area: 'M' });
  });

  it('CALL FC 1 con parentesi sulla riga seguente, CRLF e senza parametri', () => {
    const { statements, errors } = parseNetwork(
      'CALL FC 1\r\n(\r\n  x := 5\r\n);\r\nCALL FB 1, DB 1\r\nBE',
      'international',
    );
    expect(errors).toEqual([]);
    expect(statements.map((s) => s.instruction.text)).toEqual(['CALL', 'CALL', 'BE']);
    expect(statements[0]!.operand).toMatchObject({ kind: 'block', blockKind: 'FC' });
    expect(statements[1]!.params).toBeUndefined();
    expect(statements[1]!.instanceDb).toMatchObject({ kind: 'block', blockKind: 'DB' });
  });

  it('parametri non chiusi', () => {
    const { errors } = parseNetwork('CALL FC 1\n(\n a := 1,\n', 'international');
    expect(errors.map((e) => e.code)).toEqual(['UNCLOSED_PARAMS']);
  });

  it('mnemonico tedesco', () => {
    const { statements, errors } = parseNetwork('U E 0.0\nSPB M1\nSE T 1\nU A 0.1', 'german');
    expect(errors).toEqual([]);
    expect(statements.map((s) => s.instruction.def?.id)).toEqual(['A', 'JC', 'SD', 'A']);
    expect(statements[0]!.operand).toMatchObject({ area: 'I' });
    expect(statements[3]!.operand).toMatchObject({ area: 'Q' });
  });

  it('A tedesco è un prefisso di area, A internazionale è istruzione', () => {
    expect(op('L AW 4', 'german').operand).toMatchObject({ area: 'Q', size: 'W' });
    expect(op('L QW 4', 'german').errors).toHaveLength(1);
    expect(op('L EW 4').errors).toHaveLength(1);
  });

  it('istruzione sconosciuta: errore con posizione esatta, senza errori a cascata', () => {
    const r = parseNetwork('A I0.0\nXYZ M0.0 junk', 'international');
    expect(r.errors).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_INSTRUCTION',
        range: expect.objectContaining({
          from: { line: 1, col: 0, offset: 7 },
          to: { line: 1, col: 3, offset: 10 },
        }),
      }),
    ]);
    expect(r.statements).toHaveLength(1);
    expect(parseNetwork('U I0.0', 'international').errors[0]!.code).toBe('UNKNOWN_INSTRUCTION');
  });

  it('operando malformato: BAD_OPERAND, istruzione mantenuta senza operando', () => {
    const r = parseNetwork('A Z9\nA "aperto\nL 5X', 'international');
    expect(r.errors.map((e) => e.code)).toEqual(['BAD_OPERAND', 'UNCLOSED_STRING', 'BAD_OPERAND']);
    expect(r.statements.map((s) => s.operand)).toEqual([undefined, undefined, undefined]);
    expect(r.errors[0]!.range.from).toMatchObject({ line: 0, col: 2 });
  });

  it('etichette: troppo lunga, senza istruzione', () => {
    expect(parseNetwork('LUNGA: A I0.0', 'international').errors[0]!.code).toBe('SYNTAX');
    const r = parseNetwork('M1:\n// c\nA I0.0', 'international');
    expect(r.errors).toEqual([]);
    expect(r.statements[0]!.label!.name).toBe('M1');
  });

  it('non lancia mai su input casuale', () => {
    const alphabet = 'AIQMEU0123456789.#"\'%[]()=<>+-*/:;,_ \t\r\nPBWDLCTCALL//DBX';
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 1500; n++) {
      let s = '';
      for (let k = rnd() * 80; k > 0; k--) s += alphabet[Math.floor(rnd() * alphabet.length)];
      for (const m of ['international', 'german'] as const) {
        const r = parseNetwork(s, m);
        for (const e of r.errors)
          expect(e.range.from.offset).toBeLessThanOrEqual(e.range.to.offset);
      }
    }
  });

  it.each(fixtures)('fixture %s senza errori', (_name, src, m) => {
    expect(parseNetwork(src, m).errors).toEqual([]);
  });

  it('le fixture coprono ogni istruzione della tabella', () => {
    for (const lang of ['international', 'german'] as const) {
      const f = fixtures.find(([n]) => n === `${lang}.awl`)!;
      const seen = new Set(parseNetwork(f[1], lang).statements.map((s) => s.instruction.def?.id));
      expect(INSTRUCTIONS.filter((i) => !seen.has(i.id)).map((i) => i.id)).toEqual([]);
    }
  });

  it('2000 righe si analizzano in tempi accettabili', { timeout: 30_000 }, () => {
    const line = 'A I0.0\nAN "Stop"\n= #Uscita.bit;\nL DB10.DBW 4\nT MW 2 // c\n';
    const src = line.repeat(400);
    const t0 = performance.now();
    const r = parseNetwork(src, 'international');
    const dt = performance.now() - t0;
    expect(r.errors).toEqual([]);
    expect(r.statements).toHaveLength(2000);
    // soglia larga per i runner CI lenti; in locale resta sotto i 100 ms
    expect(dt).toBeLessThan(1000);
  });
});
