// Rinomina nel testo SCL: tag, blocchi, membri di DB, variabili e parametri delle chiamate.
import { describe, expect, it } from 'vitest';
import {
  createCodeBlock,
  renameMemberWithOverrides,
  renameWithReferences,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { makeDevice, seq } from './fixtures';

const net = (b: CodeBlock): string => b.networks[0]!.source;
const setScl = (b: CodeBlock, source: string) => {
  b.language = 'SCL';
  b.networks = [{ id: `${b.id}-n0`, title: '', comment: '', source }];
};
const code = (d: PlcDevice, name: string) => d.blocks.find((b) => b.name === name) as CodeBlock;

function withFc(d: PlcDevice): CodeBlock {
  const fc = createCodeBlock({
    kind: 'FC',
    number: 1,
    name: 'Calcola',
    language: 'SCL',
    newId: seq('fc'),
  });
  fc.interface.input.push({ id: 'fc-a', name: 'A', type: 'Int', comment: '' });
  d.blocks.push(fc);
  return fc;
}

describe('rinomina nel testo SCL', () => {
  it('un tag: solo "Start", non "Start2", né commenti e stringhe', () => {
    const d = makeDevice();
    const scl =
      'IF "Start" THEN "Start2" := "start"; END_IF; // "Start"\n(* "Start" *) #s := \'"Start"\';';
    setScl(code(d, 'Nastro'), scl);
    renameWithReferences(
      d,
      { kind: 'tag', deviceId: d.id, tableId: d.tagTables[0]!.id, id: d.tagTables[0]!.tags[0]!.id },
      'Avvio',
    );
    expect(net(code(d, 'Nastro'))).toBe(
      'IF "Avvio" THEN "Start2" := "Avvio"; END_IF; // "Start"\n(* "Start" *) #s := \'"Start"\';',
    );
  });

  it('un blocco chiamato e un DB', () => {
    const d = makeDevice();
    withFc(d);
    setScl(code(d, 'Main'), '"Calcola"(A := "Dati".A);\nCalcola(A := Calcola);');
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: code(d, 'Calcola').id }, 'Calc');
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: code(d, 'Dati').id }, 'Valori');
    expect(net(code(d, 'Main'))).toBe('"Calc"(A := "Valori".A);\nCalc(A := Calcola);');
  });

  it('una variabile: #A e A nel suo blocco, non i membri né gli altri blocchi', () => {
    const d = makeDevice();
    const fc = withFc(d);
    setScl(fc, '#A := A + 1;\n"Dati".A := #A;');
    setScl(code(d, 'Main'), '#A := 1;');
    renameMemberWithOverrides(d, { kind: 'block', id: fc.id }, 'fc-a', 'Ingresso');
    expect(net(fc)).toBe('#Ingresso := Ingresso + 1;\n"Dati".A := #Ingresso;');
    expect(net(code(d, 'Main'))).toBe('#A := 1;');
  });

  it('un parametro: il nome solo nelle chiamate di quel blocco', () => {
    const d = makeDevice();
    const fc = withFc(d);
    setScl(code(d, 'Main'), '"Calcola"(A := #A);\nCalcola(A := A);\n"Altro"(A := 1);\n#A := A;');
    renameMemberWithOverrides(d, { kind: 'block', id: fc.id }, 'fc-a', 'Ingresso');
    expect(net(code(d, 'Main'))).toBe(
      '"Calcola"(Ingresso := #A);\nCalcola(Ingresso := A);\n"Altro"(A := 1);\n#A := A;',
    );
  });

  it('un parametro di FB: col DB di istanza e con la multi-istanza', () => {
    const d = makeDevice();
    const fb = code(d, 'Nastro');
    fb.interface.input.push({ id: 'v', name: 'Vel', type: 'Int', comment: '' });
    setScl(code(d, 'Main'), '"Nastro_DB"(Vel := 1);\n"Nastro_DB".Vel := 2;');
    // Linea ha la multi-istanza N di "Nastro"
    setScl(code(d, 'Linea'), '#N(Vel := 3);\nN(Vel := 4);\n#N.Vel := 5;');
    renameMemberWithOverrides(d, { kind: 'block', id: fb.id }, 'v', 'Velocita');
    expect(net(code(d, 'Main'))).toBe('"Nastro_DB"(Velocita := 1);\n"Nastro_DB".Velocita := 2;');
    expect(net(code(d, 'Linea'))).toBe('#N(Velocita := 3);\nN(Velocita := 4);\n#N.Velocita := 5;');
  });

  it('un membro di DB annidato, anche dopo un indice', () => {
    const d = makeDevice();
    // Dati.A è un "Asse": Pos.X
    setScl(code(d, 'Main'), '"Dati".A.Pos.X := 1.0;\n"Altro".A.Pos.X := 2.0;');
    const asse = d.udts.find((u) => u.name === 'Asse')!;
    renameMemberWithOverrides(d, { kind: 'udt', id: asse.id }, asse.members[0]!.id, 'Posizione');
    expect(net(code(d, 'Main'))).toBe('"Dati".A.Posizione.X := 1.0;\n"Altro".A.Pos.X := 2.0;');
  });
});
