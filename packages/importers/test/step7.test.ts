import { readFileSync } from 'node:fs';
import { createCodeBlock } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import {
  applySource,
  parseAwlSource,
  parseSclSource,
  parseStep7Symbols,
  readStep7Files,
  MAX_STEP7_FILE_BYTES,
} from '../src/index';
import { emptyDevice, seq } from './helpers';

const bytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/step7/${name}`, import.meta.url)));
const text = (name: string): string => new TextDecoder().decode(bytes(name));
/** Testo in Windows-1252 (ANSI), come lo scrive STEP 7. */
const ansi = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));

describe('parseStep7Symbols', () => {
  it('SDF: variabili, simboli dei blocchi e righe sbagliate col numero', () => {
    const p = parseStep7Symbols(text('simboli.sdf'), 'sdf');
    expect(p.tags.map((t) => [t.name, t.address, t.type, t.comment])).toEqual([
      ['Start', '%I0.0', 'Bool', 'Start button'],
      ['Motor_on', '%Q4.1', 'Bool', ''],
      ['Speed', '%MW10', 'Int', 'Set point'],
      ['T1', '%T1', 'Timer', 'Delay'],
      ['Pieces', '%C5', 'Counter', ''],
    ]);
    expect(p.blocks.map((b) => [b.name, b.kind, b.number])).toEqual([
      ['Conveyor', 'FB', 10],
      ['Conveyor_DB', 'DB', 10],
      ['Axis', 'UDT', 1],
      ['Main', 'OB', 1],
      ['Watch', 'VAT', 1],
    ]);
    expect(p.errors).toEqual([{ line: 11, code: 'RIGA_ILLEGGIBILE' }]);
  });

  it('ASC a colonne fisse con mnemonici tedeschi', () => {
    const lines = [
      '126,Start                   E       0.0 BOOL      Starttaster',
      '126,Motor ein               A       4.1 BOOL      Motor läuft',
      '126,Zähler                  Z       3   COUNTER   ',
      '126,Eingang Wort            PEW   256   WORD      Analog',
      '126,Kaputt',
    ];
    const p = parseStep7Symbols(lines.join('\r\n'), 'asc');
    expect(p.tags.map((t) => [t.name, t.address, t.type, t.comment])).toEqual([
      ['Start', '%I0.0', 'Bool', 'Starttaster'],
      ['Motor ein', '%Q4.1', 'Bool', 'Motor läuft'],
      ['Zähler', '%C3', 'Counter', ''],
      ['Eingang Wort', '%PIW256', 'Word', 'Analog'],
    ]);
    expect(p.errors).toEqual([{ line: 5, code: 'RIGA_ILLEGGIBILE' }]);
  });

  it('SEQ separato da tabulazioni, anche senza tipo (dedotto dall’indirizzo)', () => {
    const p = parseStep7Symbols(
      ['126,I 0.0\tStart\tBOOL\tAvvio', '126,MW 2\tValore\t\t', '126,FC 3\tCalcolo\tFC 3\t'].join(
        '\n',
      ),
      'seq',
    );
    expect(p.tags.map((t) => [t.name, t.address, t.type, t.comment])).toEqual([
      ['Start', '%I0.0', 'Bool', 'Avvio'],
      ['Valore', '%MW2', 'Word', ''],
    ]);
    expect(p.blocks).toMatchObject([{ name: 'Calcolo', kind: 'FC', number: 3 }]);
  });

  it('DIF: righe tra BOT ed EOD, stringhe con virgolette raddoppiate', () => {
    const dif = [
      'TABLE',
      '0,1',
      '""',
      'VECTORS',
      '0,2',
      '""',
      'TUPLES',
      '0,4',
      '""',
      'DATA',
      '0,0',
      '""',
      '-1,0',
      'BOT',
      '1,0',
      '"Start"',
      '1,0',
      '"I 0.0"',
      '1,0',
      '"BOOL"',
      '1,0',
      '"Il ""primo"""',
      '-1,0',
      'BOT',
      '1,0',
      '"Nastro"',
      '1,0',
      '"FB 2"',
      '1,0',
      '"FB 2"',
      '1,0',
      '""',
      '-1,0',
      'EOD',
    ].join('\r\n');
    const p = parseStep7Symbols(dif, 'dif');
    expect(p.tags).toMatchObject([{ name: 'Start', address: '%I0.0', comment: 'Il "primo"' }]);
    expect(p.blocks).toMatchObject([{ name: 'Nastro', kind: 'FB', number: 2 }]);
    expect(parseStep7Symbols('niente', 'dif').errors).toEqual([
      { line: 1, code: 'RIGA_ILLEGGIBILE' },
    ]);
  });

  it('tipo che non sta nell’indirizzo, tipo sconosciuto, nome doppio', () => {
    const p = parseStep7Symbols(
      [
        '"A","MB 1","INT",""',
        '"B","M 0.0","FOO",""',
        '"C","M 0.1","BOOL",""',
        '"c","M 0.2","BOOL",""',
      ].join('\n'),
      'sdf',
    );
    expect(p.tags.map((t) => t.name)).toEqual(['C']);
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [1, 'INDIRIZZO_NON_VALIDO'],
      [2, 'TIPO_NON_VALIDO'],
      [4, 'NOME_DOPPIO'],
    ]);
  });
});

describe('parseSclSource', () => {
  it('dichiarazioni su più righe e più dichiarazioni sulla stessa riga', () => {
    const src = `FUNCTION_BLOCK "Multi"
VAR_INPUT
  A,
  B : INT;
  Lista :
    ARRAY[1..3]
    OF BOOL;
END_VAR
VAR
  X : INT; Y : REAL; // due
END_VAR
BEGIN
  X := A;
END_FUNCTION_BLOCK
`;
    const r = parseSclSource(src);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const fb = r.source.units[0];
    if (fb?.kind !== 'FB') throw new Error('unità');
    expect(fb.block.interface.input.map((m) => [m.name, m.type])).toEqual([
      ['A', 'Int'],
      ['B', 'Int'],
      ['Lista', 'Array[1..3] of Bool'],
    ]);
    expect(fb.block.interface.static.map((m) => [m.name, m.type, m.comment])).toEqual([
      ['X', 'Int', ''],
      ['Y', 'Real', 'due'],
    ]);
  });

  it('interfaccia dalle sezioni VAR, corpo come testo SCL, CONST spostata con avviso', () => {
    const r = parseSclSource(text('conveyor.scl'));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const [fb, fc] = r.source.units;
    if (fb?.kind !== 'FB' || fc?.kind !== 'FC') throw new Error('unità');
    expect(fb.name).toBe('Conveyor');
    expect(fb.block.language).toBe('SCL');
    expect(fb.block.header).toMatchObject({
      title: 'Comando nastro',
      author: 'Baso',
      version: '1.2',
      comment: 'Nastro trasportatore\nCommento del blocco\nsu due righe',
    });
    expect(fb.block.interface.input).toMatchObject([
      { name: 'Start', type: 'Bool', comment: 'avvio' },
      { name: 'Stop', type: 'Bool', initial: 'TRUE', comment: 'arresto' },
    ]);
    expect(fb.block.interface.static).toMatchObject([{ name: 'Speed', initial: '10' }]);
    const body = fb.block.networks[0]!.source;
    expect(body.split('\n')[0]).toBe('// CONST');
    expect(body).toContain('// MaxSpeed := 100;');
    expect(body).toContain('IF Start AND NOT Stop THEN\n    Running := TRUE;');
    expect(body).toContain('Speed := MaxSpeed; (* costante *)');
    expect(r.warnings).toEqual([
      { line: 10, col: 1, code: 'SCL_SECTION_MOVED', params: { section: 'CONST' } },
    ]);
    expect(fc.block.interface.returnType).toBe('Int');
    expect(fc.block.networks[0]!.source).toBe('Add := A + B;');
  });

  it('errori dell’intestazione con la riga del file', () => {
    const r = parseSclSource(
      'FUNCTION_BLOCK "X"\nVAR\n  a INT;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ line: 3 });
  });

  it('il blocco SCL applicato ha il testo e la lingua', () => {
    const r = parseSclSource(text('conveyor.scl'));
    if (!r.ok) throw new Error();
    const dev = emptyDevice();
    applySource(dev, r.source, seq());
    const fb = dev.blocks.find((b) => b.name === 'Conveyor');
    expect(fb).toMatchObject({ kind: 'FB', language: 'SCL' });
    if (fb?.kind !== 'FB') throw new Error();
    expect(fb.networks).toHaveLength(1);
    expect(fb.networks[0]!.source).toContain('Running := TRUE;');
  });
});

describe('readStep7Files', () => {
  const files = () => [
    { name: 'dati.awl', bytes: bytes('dati.awl') },
    { name: 'conveyor.scl', bytes: bytes('conveyor.scl') },
    { name: 'tipi.awl', bytes: bytes('tipi.awl') },
    { name: 'simboli.sdf', bytes: bytes('simboli.sdf') },
  ];

  it('UDT di un altro file: il DB è globale coi membri; numeri dai simboli', () => {
    const r = readStep7Files(files(), emptyDevice());
    expect(r.files.map((f) => [f.name, f.kind, f.errors])).toEqual([
      ['dati.awl', 'awl', []],
      ['conveyor.scl', 'scl', []],
      ['tipi.awl', 'awl', []],
      ['simboli.sdf', 'symbols', []],
    ]);
    const kinds = r.units.map((u) => [u.unit.kind, u.unit.name, u.unit.number]);
    expect(kinds).toEqual([
      ['DB', 'AxisData', undefined],
      ['FB', 'Conveyor', 10],
      ['FC', 'Add', undefined],
      ['UDT', 'Axis', 1],
    ]);
    const db = r.units[0]!.unit;
    if (db.kind !== 'DB') throw new Error();
    expect(db.db.members).toMatchObject([{ name: 'Pos', initial: '5' }, { name: 'Speed' }]);
    expect(r.tags).toHaveLength(5);
    expect(r.blocks.map((b) => b.name)).toContain('Conveyor_DB');

    const dev = emptyDevice();
    applySource(dev, { units: r.units.map((u) => u.unit) }, seq());
    expect(dev.udts.map((u) => [u.name, u.number])).toEqual([['Axis', 1]]);
    expect(dev.blocks.find((b) => b.name === 'Conveyor')?.number).toBe(10);
  });

  it('Windows-1252, file troppo grande, formato sconosciuto, unità doppia fra file', () => {
    const big = new Uint8Array(MAX_STEP7_FILE_BYTES + 1);
    const r = readStep7Files(
      [
        {
          name: 'simboli.asc',
          bytes: ansi('126,Störung                 M       1.0 BOOL      Fehler\r\n'),
        },
        { name: 'grande.awl', bytes: big },
        { name: 'x.txt', bytes: ansi('') },
        { name: 'a.awl', bytes: bytes('tipi.awl') },
        { name: 'b.awl', bytes: bytes('tipi.awl') },
      ],
      emptyDevice(),
    );
    expect(r.files[0]).toMatchObject({ encoding: 'windows-1252' });
    expect(r.tags).toMatchObject([{ name: 'Störung', address: '%M1.0' }]);
    expect(r.files[1]!.errors[0]!.code).toBe('FILE_TOO_LARGE');
    expect(r.files[2]!.errors[0]!.code).toBe('UNKNOWN_FORMAT');
    expect(r.files[4]!.warnings[0]).toMatchObject({ code: 'DUPLICATE_UNIT' });
    expect(r.units).toHaveLength(1);
  });

  it('una sorgente con errori non ferma le altre', () => {
    const dev = emptyDevice();
    dev.blocks.push(createCodeBlock({ kind: 'FC', number: 1, name: 'Vecchia', language: 'AWL' }));
    const r = readStep7Files(
      [
        { name: 'rotta.awl', bytes: ansi('FUNCTION_BLOCK "X"\nBOH\n') },
        { name: 'tipi.awl', bytes: bytes('tipi.awl') },
      ],
      dev,
    );
    expect(r.files[0]!.errors.length).toBeGreaterThan(0);
    expect(r.units.map((u) => u.unit.name)).toEqual(['Axis']);
  });
});

describe('nome già usato da un altro oggetto', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const withFc3 = () => {
    const d = emptyDevice();
    d.blocks.push(createCodeBlock({ kind: 'FC', number: 3, name: 'Motore', language: 'AWL' }));
    return d;
  };

  it('STEP 7: FC 10 col nome di FC3 dai simboli non si crea', () => {
    const d = withFc3();
    const src = 'FUNCTION "Motore" : VOID\nBEGIN\nNETWORK\nTITLE =\n      NOP 0;\nEND_FUNCTION\n';
    const r = readStep7Files(
      [
        { name: 'a.awl', bytes: enc(src) },
        { name: 's.sdf', bytes: enc('"Motore","FC 10","FC 10",""\r\n') },
      ],
      d,
    );
    expect(() => applySource(d, { units: r.units.map((u) => u.unit) }, seq())).toThrow(
      'Nome "Motore" già usato da FC3',
    );
    expect(d.blocks.map((b) => `${b.kind}${b.number}`)).toEqual(['FC3']);
  });

  it('sorgente AWL: un FB col nome di un FC non si crea', () => {
    const d = withFc3();
    const r = parseAwlSourceOk(
      'FUNCTION_BLOCK "Motore"\nBEGIN\nNETWORK\nTITLE =\nEND_FUNCTION_BLOCK\n',
    );
    expect(() => applySource(d, r, seq())).toThrow('già usato da FC3');
    expect(d.blocks).toHaveLength(1);
  });
});

function parseAwlSourceOk(text: string) {
  const r = parseAwlSource(text, emptyDevice());
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.source;
}
