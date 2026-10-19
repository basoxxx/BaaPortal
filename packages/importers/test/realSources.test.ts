import { findCpu } from '@baaportal/catalog';
import { checkDevice, type CodeBlock, type PlcDevice } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { applySource, generateAwlSource, parseAwlSource } from '../src/index';
import { allRefs, emptyDevice, fixture, seq } from './helpers';

// Sorgenti scritte da noi nella disposizione di STEP 7 V5.5 e di TIA Portal.

function load(name: string): PlcDevice {
  const r = parseAwlSource(fixture(name));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const d = emptyDevice();
  applySource(d, r.source, seq('n'));
  return d;
}

const block = (d: PlcDevice, kind: string, number: number) =>
  d.blocks.find((b) => b.kind === kind && b.number === number);

describe('sorgenti nella disposizione di STEP 7 V5.5 e di TIA', () => {
  it.each(['step7_v55.awl', 'tia.awl'])('%s si importa senza errori, con LF e con CRLF', (name) => {
    for (const text of [fixture(name), fixture(name).replace(/\n/g, '\r\n')]) {
      const r = parseAwlSource(text);
      expect(r.ok ? [] : r.errors).toEqual([]);
    }
  });

  it('STEP 7 V5.5: tedesco con soli L/T, CODE_VERSION1, DT a due cifre, DB da UDT, CALL con spazi', () => {
    const r = parseAwlSource(fixture('step7_v55.awl'));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.source.mnemonic).toBe('german');
    const d = load('step7_v55.awl');
    const fc = block(d, 'FC', 1) as CodeBlock;
    expect(fc.networks[0]!.source).toBe('\tL %IW0;\n\tT %QW0;\n\tL %IW2;\n\tT %MW20;');
    const fb = block(d, 'FB', 1) as CodeBlock;
    expect(fb.header).toMatchObject({
      title: 'Contatore',
      comment: "Conta i fronti dell'ingresso.",
      author: 'Diego',
    });
    expect(fb.interface.static[0]).toMatchObject({
      name: 'Ora',
      type: 'Date_And_Time',
      initial: 'DT#90-1-1-0:0:0.000',
      comment: 'Ultimo fronte',
    });
    // I valori iniziali degli array restano come scritti.
    expect(fb.interface.static.slice(2).map((m) => [m.name, m.type, m.initial])).toEqual([
      ['Soglie', 'Array[1..3] of Int', '1, 2, 3'],
      ['Zeri', 'Array[0..3] of Int', '4(0)'],
      ['Maschera', 'Word', '2#0000_0000_0000_0001'],
    ]);
    expect(block(d, 'IDB', 1)).toMatchObject({
      instanceOf: 'FB1',
      overrides: {
        Avvio: 'FALSE',
        Pronto: 'FALSE',
        Ora: 'DT#90-1-1-0:0:0.000',
        Conta: '0',
        'Soglie[1]': '1',
        'Zeri[3]': '0',
        Maschera: 'W#16#1',
      },
    });
    const db2 = block(d, 'DB', 2);
    if (db2?.kind !== 'DB') throw new Error(db2?.kind);
    expect(db2.members.map((m) => [m.name, m.type, m.initial, m.comment])).toEqual([
      ['Pos', 'Real', '0.000000e+000', "Posizione dell'asse"],
      ['Vel', 'Int', '10', ''],
    ]);
    const ob = block(d, 'OB', 1) as CodeBlock;
    expect(ob.networks[1]!.source).toBe(
      '\tCALL %FB1, %DB1\n\t(\n\t   Avvio  := %I0.1,\n\t   Pronto := %Q4.1\n\t);',
    );
  });

  it('TIA: commento del blocco dopo VERSION, anche per il DB', () => {
    const d = load('tia.awl');
    const fb = d.blocks.find((b) => b.name === 'Pompa') as CodeBlock;
    expect(fb.header).toMatchObject({
      title: 'Comando pompa',
      comment: 'Comanda una pompa con avvio e arresto.\nSeconda riga del commento.',
      author: 'Diego',
      family: 'Pompe',
    });
    expect(fb.networks[0]).toMatchObject({ title: 'Marcia', comment: 'Avvio con autoritenuta.' });
    const idb = d.blocks.find((b) => b.name === 'Pompa_DB');
    expect(idb).toMatchObject({
      kind: 'IDB',
      instanceOf: 'Pompa',
      overrides: { Giri: '120' },
      header: { comment: 'Istanza della pompa.' },
      attributes: { nonRetain: true },
    });
  });

  it.each(['step7_v55.awl', 'tia.awl'])(
    '%s: il controllo del dispositivo non trova valori non validi',
    (name) => {
      const d = load(name);
      const cpu = findCpu(d.cpu.typeId);
      const bad = checkDevice(d, cpu).filter((x) => x.code === 'VALUE_INVALID');
      expect(bad).toEqual([]);
    },
  );

  it('i valori iniziali di un array si rileggono e si riscrivono come scritti', () => {
    const r = parseAwlSource(
      'FUNCTION_BLOCK "A"\nVAR\n  L : ARRAY [1..5] OF INT := 2(1),\n    3;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const u = r.source.units[0]!;
    if (u.kind !== 'FB') throw new Error();
    expect(u.block.interface.static[0]!.initial).toBe('2(1), 3');
    const d = emptyDevice();
    applySource(d, r.source, seq('n'));
    expect(generateAwlSource(d, allRefs(d), 'international').text).toContain(
      '  L : Array[1..5] of Int := 2(1), 3;',
    );
  });
});
