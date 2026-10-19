import { createUdt } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { parseAwlSource, type ParsedSource, type SourceError } from '../src/index';
import { emptyDevice, fixture, seq } from './helpers';

function ok(text: string): ParsedSource {
  const r = parseAwlSource(text);
  if (!r.ok) throw new Error(`errori: ${JSON.stringify(r.errors)}`);
  return r.source;
}
function errors(text: string): SourceError[] {
  const r = parseAwlSource(text);
  if (r.ok) throw new Error('atteso un errore');
  return r.errors;
}

describe('parseAwlSource: unità', () => {
  it('sorgente con UDT, FB, FC, OB1, DB globale e DB di istanza si importa', () => {
    const s = ok(fixture('tutto.awl'));
    expect(s.mnemonic).toBe('international');
    expect(s.units.map((u) => [u.kind, u.name])).toEqual([
      ['UDT', 'Asse'],
      ['FC', 'Somma'],
      ['FB', 'Nastro'],
      ['FB', 'Linea'],
      ['OB', ''],
      ['DB', 'Dati'],
      ['IDB', 'Nastro_DB'],
      ['IDB', 'Linea_DB'],
    ]);
    const nastro = s.units[2]!;
    if (nastro.kind !== 'FB') throw new Error();
    expect(nastro.block.interface.input.map((m) => m.name)).toEqual(['Avvio', 'Arresto']);
    expect(nastro.block.interface.static[1]).toMatchObject({ name: 'Velocita', initial: '100' });
    expect(nastro.block.networks).toHaveLength(2);
    expect(nastro.block.language).toBe('AWL');
    const somma = s.units[1]!;
    if (somma.kind !== 'FC') throw new Error();
    expect(somma.block.interface.returnType).toBe('Int');
    const idb = s.units[6]!;
    if (idb.kind !== 'IDB') throw new Error();
    expect(idb.instanceOf).toBe('Nastro');
    expect(idb.overrides).toEqual({ Velocita: '120' });
  });

  it('intestazione: titolo, commento, autore, famiglia, nome, versione', () => {
    const s = ok(fixture('fb.awl'));
    const u = s.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    expect(u.block.header).toEqual({
      title: 'Gestione motore',
      comment: 'Comanda un motore.\nCon avvio e arresto.',
      author: 'Diego',
      family: 'Motori',
      headerName: 'Motore',
      version: '1.0',
    });
  });

  it('segmenti: titolo, commento di rete e codice (commenti rientrati restano nel codice)', () => {
    const s = ok(fixture('fb.awl'));
    const u = s.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    const [n1, n2] = u.block.networks;
    expect(n1).toMatchObject({ title: 'Avvio', comment: 'Parte il motore.' });
    expect(n1!.source).toBe('\tA #Avvio; // start\n\tAN %I0.1;\n\t= %Q0.0;');
    expect(n2!.comment).toBe('Conta fino a cinque.');
    expect(n2!.source).toContain('\t// commento di codice');
    expect(n2!.source).toContain('fine:\tNOP 0;');
  });

  it('struct annidati, array di struct, stringhe e commenti nelle dichiarazioni', () => {
    const s = ok(fixture('udt.awl'));
    const u = s.units[0]!;
    if (u.kind !== 'UDT') throw new Error();
    const m = u.udt.members;
    expect(u.udt.comment).toBe('Asse di movimentazione.\n\nSeconda parte del commento.');
    expect(m[0]).toMatchObject({
      name: 'Attivo',
      type: 'Bool',
      initial: 'TRUE',
      comment: 'abilitazione',
    });
    expect(m[1]).toMatchObject({ name: 'Pos', type: 'Struct', comment: 'posizione' });
    expect(m[1]!.members!.map((x) => [x.name, x.type])).toEqual([
      ['X', 'Real'],
      ['Y', 'Real'],
      ['Limiti', 'Array[0..1] of Real'],
    ]);
    expect(m[3]).toMatchObject({ name: 'Punti', type: 'Array[1..3] of Struct' });
    expect(m[3]!.members).toHaveLength(2);
    expect(m[4]).toMatchObject({ type: 'String[20]', initial: "'Asse'" });
  });

  it('DB globale: valori in BEGIN diventano overrides del membro, iniziali dei membri diretti', () => {
    const s = ok(fixture('db.awl'));
    const u = s.units[0]!;
    if (u.kind !== 'DB') throw new Error();
    const by = (n: string) => u.db.members.find((m) => m.name === n)!;
    expect(by('Giri').initial).toBe('5');
    expect(by('Asse').overrides).toEqual({ '.Pos.X': '3.5' });
    expect(by('Lista').overrides).toEqual({ '[1].Attivo': 'TRUE' });
    expect(by('Valori').overrides).toEqual({ '[2]': '7' });
    expect(by('Loc').members![0]).toMatchObject({ name: 'P', initial: '2.5' });
  });

  it('un valore in BEGIN su un membro di struct locale diventa iniziale del membro interno', () => {
    const s = ok(
      'DATA_BLOCK "D"\nSTRUCT\n  S : Struct\n    A : Int;\n  END_STRUCT;\nEND_STRUCT;\nBEGIN\n  S.A := 4;\nEND_DATA_BLOCK\n',
    );
    const u = s.units[0]!;
    if (u.kind !== 'DB') throw new Error();
    expect(u.db.members[0]!.members![0]!.initial).toBe('4');
  });

  it('attributi di blocco e di DB', () => {
    const s = ok(fixture('attributi.awl'));
    const fb = s.units[0]!;
    const db = s.units[1]!;
    if (fb.kind !== 'FB' || db.kind !== 'DB') throw new Error();
    expect(fb.block.knowHowProtected).toBe(true);
    expect(db.db.knowHowProtected).toBe(true);
    expect(db.db.attributes).toEqual({ unlinked: true, readOnly: true, nonRetain: true });
  });

  it('nomi con spazi e accenti, anche nei percorsi dei valori', () => {
    const s = ok(fixture('nomi.awl'));
    const db = s.units[2]!;
    if (db.kind !== 'DB') throw new Error();
    expect(db.name).toBe('Dati Più');
    expect(db.db.members[0]!.overrides).toEqual({ '.Velocità max': '1.5' });
  });
});

describe('parseAwlSource: forma classica e TIA', () => {
  it('mnemonico tedesco rilevato e convertito in internazionale', () => {
    const s = ok(fixture('tedesco.awl'));
    expect(s.mnemonic).toBe('german');
    const u = s.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    expect(u.block.networks[0]!.source).toBe(
      '\tA %I0.0;\n\tAN %I0.1;\n\t= %Q0.0;\n\tL %IW2;\n\tT %MW10;',
    );
  });

  it('FB 1 assoluto tiene il numero; tipi maiuscoli normalizzati', () => {
    const s = ok(fixture('tedesco.awl'));
    const u = s.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    expect(u.number).toBe(1);
    expect(u.name).toBe('');
    expect(u.block.interface.input.map((m) => m.type)).toEqual(['Bool', 'Array[1..3] of Int']);
  });

  it("righe { S7_Optimized_Access := 'FALSE' } e attributi in linea ignorati", () => {
    const text = [
      'FUNCTION_BLOCK "A"',
      "{ S7_Optimized_Access := 'FALSE' }",
      'VERSION : 0.1',
      '',
      'VAR_INPUT',
      "  Avvio { ExternalVisible := 'False'} : Bool;",
      'END_VAR',
      '',
      'BEGIN',
      'END_FUNCTION_BLOCK',
    ].join('\r\n');
    const s = ok(text);
    const u = s.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    expect(u.block.interface.input[0]).toMatchObject({ name: 'Avvio', type: 'Bool' });
  });

  it('tipi UDT n e FB n assoluti, DB di istanza con FB n', () => {
    const s = ok(
      'DATA_BLOCK DB 7\nFB 3\nBEGIN\nEND_DATA_BLOCK\n\nFUNCTION_BLOCK FB 9\nVAR\n  x : UDT 2;\n  y : FB 3;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    );
    const db = s.units[0]!;
    const fb = s.units[1]!;
    if (db.kind !== 'IDB' || fb.kind !== 'FB') throw new Error();
    expect(db.number).toBe(7);
    expect(db.instanceOf).toBe('@FB:3');
    expect(fb.block.interface.static.map((m) => m.type)).toEqual(['"@UDT:2"', '"@FB:3"']);
  });

  it('parole chiave in minuscolo e BOM iniziale', () => {
    const s = ok('﻿function_block "A"\nversion : 0.1\nbegin\nend_function_block\n');
    expect(s.units[0]!.name).toBe('A');
  });
});

describe('parseAwlSource: errori', () => {
  it('errore a metà file: elenco con riga e colonna, niente applicato', () => {
    const r = parseAwlSource(fixture('errore_riga_12.awl'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatchObject({ line: 12, col: 5, code: 'UNKNOWN_INSTRUCTION' });
    expect(!r.ok && r.errors).toHaveLength(2);
    expect(!r.ok && r.errors[1]).toMatchObject({ line: 13, col: 2 });
  });

  it('struttura: unità senza fine', () => {
    const e = errors('FUNCTION_BLOCK "A"\nBEGIN\nNETWORK\nTITLE =\n');
    expect(e.map((x) => x.code)).toContain('MISSING_END');
  });

  it('struttura: END_VAR mancante, tipo errato, dichiarazione errata', () => {
    const e = errors(
      'FUNCTION_BLOCK "A"\nVAR_INPUT\n  a : Pippo 3;\n  b Int;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    );
    expect(e.map((x) => [x.code, x.line])).toEqual([
      ['BAD_TYPE', 3],
      ['BAD_DECLARATION', 4],
    ]);
  });

  it('testo estraneo fuori dalle unità', () => {
    const e = errors('pippo\nFUNCTION "A" : Void\nBEGIN\nEND_FUNCTION\n');
    expect(e[0]).toMatchObject({ code: 'UNEXPECTED_TOKEN', line: 1, col: 1 });
  });

  it('attributo sconosciuto', () => {
    const e = errors('FUNCTION "A" : Void\nCOLORE : rosso\nBEGIN\nEND_FUNCTION\n');
    expect(e[0]).toMatchObject({ code: 'UNKNOWN_ATTRIBUTE', line: 2 });
  });

  it('unità duplicate nella stessa sorgente', () => {
    const e = errors(
      'FUNCTION "A" : Void\nBEGIN\nEND_FUNCTION\n\nFUNCTION "a" : Void\nBEGIN\nEND_FUNCTION\n',
    );
    expect(e[0]).toMatchObject({ code: 'DUPLICATE_UNIT', line: 5 });
  });

  it('valore su un membro che non esiste in un DB', () => {
    const e = errors(
      'DATA_BLOCK "D"\nSTRUCT\n  a : Int;\nEND_STRUCT;\nBEGIN\n  b := 1;\nEND_DATA_BLOCK\n',
    );
    expect(e[0]).toMatchObject({ code: 'UNKNOWN_MEMBER', line: 6 });
  });

  it('errori di codice in reti diverse e unità diverse sono tutti raccolti, con righe del file', () => {
    const e = errors(
      [
        'FUNCTION "A" : Void',
        'BEGIN',
        'NETWORK',
        'TITLE =',
        '\tA %Q9.9;',
        '\tA %I0.0 %I0.1;',
        'END_FUNCTION',
        'FUNCTION "B" : Void',
        'BEGIN',
        'NETWORK',
        'TITLE =',
        '\tQQQ 1;',
        'END_FUNCTION',
      ].join('\n'),
    );
    expect(e.map((x) => [x.line, x.code])).toEqual([
      [5, 'BAD_OPERAND'],
      [6, 'SYNTAX'],
      [12, 'UNKNOWN_INSTRUCTION'],
    ]);
    expect(e[e.length - 1]).toMatchObject({ line: 12, code: 'UNKNOWN_INSTRUCTION' });
  });

  it('i simboli sconosciuti non sono errori di importazione', () => {
    const r = parseAwlSource(
      'FUNCTION "A" : Void\nBEGIN\nNETWORK\nTITLE =\n\tA "NonEsiste";\nEND_FUNCTION\n',
    );
    expect(r.ok).toBe(true);
  });
});

describe('parseAwlSource: DB dichiarato con un UDT', () => {
  const ASSE = [
    'TYPE "Asse"',
    'VERSION : 0.1',
    'STRUCT',
    '  Pos : Real := 1.0; // posizione',
    '  Vel : Int;',
    'END_STRUCT;',
    'END_TYPE',
    '',
  ].join('\n');
  const db = (type: string, begin: string[] = []) =>
    [
      'DATA_BLOCK "Dati"',
      'TITLE =',
      'VERSION : 0.1',
      type,
      'BEGIN',
      ...begin,
      'END_DATA_BLOCK',
    ].join('\n');

  it('UDT della stessa sorgente per nome: DB globale con una copia dei membri e i valori di BEGIN', () => {
    const s = ok(`${ASSE}\n${db('"Asse"', ['  Vel := 5;'])}\n`);
    const u = s.units[1]!;
    if (u.kind !== 'DB') throw new Error(u.kind);
    expect(u.db.members.map((m) => [m.name, m.type, m.initial, m.comment])).toEqual([
      ['Pos', 'Real', '1.0', 'posizione'],
      ['Vel', 'Int', '5', ''],
    ]);
    // La copia è indipendente: l'UDT non riceve il valore del DB.
    const udt = s.units[0]!;
    if (udt.kind !== 'UDT') throw new Error();
    expect(udt.udt.members[1]!.initial).toBeUndefined();
  });

  it('forma assoluta UDT n, anche con il TYPE scritto dopo il DB', () => {
    const s = ok(
      `${db('UDT 4', ['  Pos := 2.5;'])}\n\n${ASSE.replace('TYPE "Asse"', 'TYPE UDT 4')}`,
    );
    const u = s.units[0]!;
    if (u.kind !== 'DB') throw new Error(u.kind);
    expect(u.db.members.map((m) => [m.name, m.initial])).toEqual([
      ['Pos', '2.5'],
      ['Vel', undefined],
    ]);
  });

  it('UDT del dispositivo, per nome e per numero', () => {
    const d = emptyDevice();
    const asse = createUdt({ name: 'Asse', number: 3, newId: seq('u') });
    asse.members.push({ id: 'm1', name: 'Pos', type: 'Real', comment: 'c', initial: '0.5' });
    d.udts.push(asse);
    for (const type of ['"Asse"', 'UDT 3']) {
      const r = parseAwlSource(db(type, ['  Pos := 9.0;']), d);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      const u = r.source.units[0]!;
      if (u.kind !== 'DB') throw new Error(`${type}: ${u.kind}`);
      expect(u.db.members).toEqual([
        { id: 'm1', name: 'Pos', type: 'Real', comment: 'c', initial: '9.0' },
      ]);
    }
    // Il membro dell'UDT del dispositivo non cambia.
    expect(asse.members[0]!.initial).toBe('0.5');
  });

  it('il nome di un FB resta un DB di istanza; un nome sconosciuto anche', () => {
    const fb = 'FUNCTION_BLOCK "Asse"\nBEGIN\nEND_FUNCTION_BLOCK\n';
    expect(ok(`${fb}${db('"Asse"', ['  x := 1;'])}`).units[1]).toMatchObject({
      kind: 'IDB',
      instanceOf: 'Asse',
      overrides: { x: '1' },
    });
    expect(ok(db('"Boh"')).units[0]).toMatchObject({ kind: 'IDB', instanceOf: 'Boh' });
  });

  it('un valore su un membro che l UDT non ha: UNKNOWN_MEMBER alla sua riga', () => {
    const e = errors(`${ASSE}\n${db('"Asse"', ['  Pippo := 5;'])}\n`);
    expect(e).toEqual([{ line: 14, col: 3, code: 'UNKNOWN_MEMBER', params: { path: 'Pippo' } }]);
  });

  it('UDT n che non esiste: errore sulla riga del tipo', () => {
    const e = errors(db('UDT 9'));
    expect(e).toEqual([{ line: 4, col: 1, code: 'BAD_DECLARATION', params: { text: 'UDT 9' } }]);
  });
});

describe('parseAwlSource: mnemonico', () => {
  it('codice tedesco con soli mnemonici comuni e aree tedesche si importa', () => {
    const s = ok(
      'FUNCTION "F" : Void\nVERSION : 0.1\nBEGIN\nNETWORK\nTITLE =\n\tL %EW0;\n\tT %AW0;\n\tO %E0.0;\n\t= %A4.0;\nEND_FUNCTION\n',
    );
    expect(s.mnemonic).toBe('german');
    const u = s.units[0]!;
    if (u.kind !== 'FC') throw new Error();
    expect(u.block.networks[0]!.source).toBe('\tL %IW0;\n\tT %QW0;\n\tO %I0.0;\n\t= %Q4.0;');
  });

  it('a parità di errori vince il mnemonico internazionale', () => {
    const s = ok(
      'FUNCTION "F" : Void\nBEGIN\nNETWORK\nTITLE =\n\tL %MW0;\n\tT %MW2;\nEND_FUNCTION\n',
    );
    expect(s.mnemonic).toBe('international');
  });
});

describe("parseAwlSource: righe dell'intestazione", () => {
  it('CODE_VERSION1 si accetta e si ignora', () => {
    const s = ok(
      'FUNCTION_BLOCK FB 1\nTITLE =\nAUTHOR : Diego\nVERSION : 0.1\nCODE_VERSION1\n\nVAR_INPUT\n  a : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    );
    const u = s.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    expect(u.block.header).toMatchObject({ author: 'Diego', version: '0.1' });
    expect(u.block.interface.input.map((m) => m.name)).toEqual(['a']);
  });

  it("una parola sconosciuta: un solo UNKNOWN_ATTRIBUTE e l'intestazione continua", () => {
    const text =
      'FUNCTION_BLOCK "A"\nTITLE =\nPIPPO\nVERSION : 0.2\nVAR_INPUT\n  a : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';
    expect(errors(text)).toEqual([
      { line: 3, col: 1, code: 'UNKNOWN_ATTRIBUTE', params: { name: 'PIPPO' } },
    ]);
    expect(errors(text.replace('"A"', '"A"\nPIPPO'))).toHaveLength(2);
  });

  it('DB: la parola sconosciuta non diventa il tipo; un nome subito prima di BEGIN sì', () => {
    expect(errors('DATA_BLOCK "D"\nPIPPO\n"Nastro"\nBEGIN\nEND_DATA_BLOCK\n')).toEqual([
      { line: 2, col: 1, code: 'UNKNOWN_ATTRIBUTE', params: { name: 'PIPPO' } },
    ]);
    expect(
      ok('DATA_BLOCK "D"\nVERSION : 0.1\nNastro\nBEGIN\nEND_DATA_BLOCK\n').units[0],
    ).toMatchObject({ kind: 'IDB', instanceOf: 'Nastro' });
  });

  it('commento del blocco dopo VERSION (TIA), dopo TITLE (STEP 7) o in tutti e due i punti', () => {
    const fb = ok(
      'FUNCTION_BLOCK "A"\nTITLE = Titolo\nVERSION : 0.1\n//Riga 1\n//Riga 2\nVAR_INPUT\n  a : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    ).units[0]!;
    if (fb.kind !== 'FB') throw new Error();
    expect(fb.block.header).toMatchObject({ title: 'Titolo', comment: 'Riga 1\nRiga 2' });

    const db = ok(
      'DATA_BLOCK "D"\nTITLE =\nVERSION : 0.1\nNON_RETAIN\n//Commento del DB\nSTRUCT\n  a : Int;\nEND_STRUCT;\nBEGIN\nEND_DATA_BLOCK\n',
    ).units[0]!;
    if (db.kind !== 'DB') throw new Error();
    expect(db.db.header.comment).toBe('Commento del DB');
    expect(db.db.attributes.nonRetain).toBe(true);

    const both = ok(
      'FUNCTION "F" : Void\nTITLE =\n//uno\nAUTHOR : Me\n//due\nVERSION : 0.1\nBEGIN\nEND_FUNCTION\n',
    ).units[0]!;
    if (both.kind !== 'FC') throw new Error();
    expect(both.block.header).toMatchObject({ comment: 'uno\ndue', author: 'Me' });
  });
});
