// Libreria standard IEC (tappa 7B), scritta da zero in AWL dalle definizioni della IEC 61131-3:
// funzioni di selezione e blocchi di fronte e bistabili, senza STRING. Sola lettura, con l'app.
import type { CodeBlock, Library, LibraryItem, Member } from './model';
import { createCodeBlock } from './plc';

type Num = 'INT' | 'DINT' | 'REAL';
const TYPE: Record<Num, string> = { INT: 'Int', DINT: 'DInt', REAL: 'Real' };
// Suffisso dei confronti AWL e zero del tipo.
const CMP: Record<Num, string> = { INT: 'I', DINT: 'D', REAL: 'R' };
const ZERO: Record<Num, string> = { INT: '0', DINT: 'L#0', REAL: '0.0' };
const NUMS: Num[] = ['INT', 'DINT', 'REAL'];

/** Corpo AWL e interfaccia di ciascuna funzione, per tipo. */
const FUNCTIONS: {
  name: string;
  comment: string;
  inputs: (t: Num) => [string, string][];
  body: (t: Num) => string;
}[] = [
  {
    name: 'LIMIT',
    comment: 'Limita IN tra MN e MX: RET_VAL = MIN(MAX(IN, MN), MX).',
    inputs: (t) => [
      ['MN', TYPE[t]],
      ['IN', TYPE[t]],
      ['MX', TYPE[t]],
    ],
    body: (t) =>
      [
        'L #IN',
        'L #MN',
        `<${CMP[t]}`,
        'JC a1',
        'TAK',
        'a1: L #MX',
        `>${CMP[t]}`,
        'JC a2',
        'TAK',
        'a2: T #RET_VAL',
        'SET',
        'SAVE',
      ].join('\n'),
  },
  {
    name: 'MAX',
    comment: 'Il maggiore tra IN1 e IN2.',
    inputs: (t) => [
      ['IN1', TYPE[t]],
      ['IN2', TYPE[t]],
    ],
    body: (t) =>
      ['L #IN1', 'L #IN2', `>${CMP[t]}`, 'JCN a1', 'TAK', 'a1: T #RET_VAL', 'SET', 'SAVE'].join(
        '\n',
      ),
  },
  {
    name: 'MIN',
    comment: 'Il minore tra IN1 e IN2.',
    inputs: (t) => [
      ['IN1', TYPE[t]],
      ['IN2', TYPE[t]],
    ],
    body: (t) =>
      ['L #IN1', 'L #IN2', `<${CMP[t]}`, 'JCN a1', 'TAK', 'a1: T #RET_VAL', 'SET', 'SAVE'].join(
        '\n',
      ),
  },
  {
    name: 'SEL',
    comment: 'Selezione binaria: IN0 con G = 0, IN1 con G = 1.',
    inputs: (t) => [
      ['G', 'Bool'],
      ['IN0', TYPE[t]],
      ['IN1', TYPE[t]],
    ],
    body: () =>
      ['A #G', 'JC a1', 'L #IN0', 'JU a2', 'a1: L #IN1', 'a2: T #RET_VAL', 'SET', 'SAVE'].join(
        '\n',
      ),
  },
  {
    name: 'MUX',
    comment:
      'Multiplexer: IN0…IN3 secondo K (0…3). K fuori campo: RET_VAL = 0 e ENO = 0 (errore IEC).',
    inputs: (t) => [
      ['K', 'Int'],
      ['IN0', TYPE[t]],
      ['IN1', TYPE[t]],
      ['IN2', TYPE[t]],
      ['IN3', TYPE[t]],
    ],
    body: (t) =>
      [
        'L #K',
        'L 3',
        '>I',
        'JC err',
        'TAK',
        'L 0',
        '<I',
        'JC err',
        'TAK',
        'JL err',
        'JU k0',
        'JU k1',
        'JU k2',
        'JU k3',
        `err: L ${ZERO[t]}`,
        'T #RET_VAL',
        'CLR',
        'SAVE',
        'BEU',
        'k0: L #IN0',
        'JU out',
        'k1: L #IN1',
        'JU out',
        'k2: L #IN2',
        'JU out',
        'k3: L #IN3',
        'out: T #RET_VAL',
        'SET',
        'SAVE',
      ].join('\n'),
  },
];

/** Blocchi di fronte e bistabili: ingressi, uscita, statici e corpo. */
const FBS: {
  name: string;
  comment: string;
  inputs: string[];
  output: string;
  statics: string[];
  body: string;
}[] = [
  {
    name: 'R_TRIG',
    comment: 'Fronte di salita: Q vale 1 per un ciclo quando CLK passa da 0 a 1.',
    inputs: ['CLK'],
    output: 'Q',
    statics: ['M'],
    body: 'A #CLK\nAN #M\n= #Q\nA #CLK\n= #M',
  },
  {
    name: 'F_TRIG',
    comment:
      'Fronte di discesa: Q vale 1 per un ciclo quando CLK passa da 1 a 0 (M ricorda il CLK precedente).',
    inputs: ['CLK'],
    output: 'Q',
    statics: ['M'],
    body: 'AN #CLK\nA #M\n= #Q\nA #CLK\n= #M',
  },
  {
    name: 'SR',
    comment: 'Bistabile a set dominante: Q1 = S1 OR (NOT R AND Q1).',
    inputs: ['S1', 'R'],
    output: 'Q1',
    statics: [],
    body: 'A #Q1\nAN #R\nO #S1\n= #Q1',
  },
  {
    name: 'RS',
    comment: 'Bistabile a reset dominante: Q1 = NOT R1 AND (S OR Q1).',
    inputs: ['S', 'R1'],
    output: 'Q1',
    statics: [],
    body: 'A(\nO #S\nO #Q1\n)\nAN #R1\n= #Q1',
  },
];

/** Primo numero di FC e FB della libreria: un campo libero, si rinumera all'inserimento. */
export const IEC_FIRST_NUMBER = 500;
export const IEC_LIBRARY_NAME = 'Libreria standard IEC';

function seqIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function item(group: string, block: CodeBlock, comment: string): LibraryItem {
  block.header = { ...block.header, comment, author: 'BaaPort', family: 'IEC', version: '1.0' };
  return {
    id: `iec-${block.name}`,
    name: block.name,
    group,
    comment,
    blocks: [block],
    udts: [],
    tagTables: [],
    watchTables: [],
  };
}

/** La libreria standard IEC, costruita ogni volta (chi la mostra la congela). */
export function iecStandardLibrary(): Library {
  const items: LibraryItem[] = [];
  let fc = IEC_FIRST_NUMBER;
  for (const f of FUNCTIONS) {
    for (const t of NUMS) {
      const name = `${f.name}_${t}`;
      const newId = seqIds(`iec-${name}`);
      const b = createCodeBlock({ kind: 'FC', number: fc++, name, language: 'AWL', newId });
      b.interface.input = f
        .inputs(t)
        .map(([n, type]): Member => ({ id: newId(), name: n, type, comment: '' }));
      b.interface.returnType = TYPE[t];
      b.networks[0]!.source = f.body(t);
      items.push(item('Selezione', b, f.comment));
    }
  }
  let fb = IEC_FIRST_NUMBER;
  for (const f of FBS) {
    const newId = seqIds(`iec-${f.name}`);
    const b = createCodeBlock({ kind: 'FB', number: fb++, name: f.name, language: 'AWL', newId });
    const bool = (n: string): Member => ({ id: newId(), name: n, type: 'Bool', comment: '' });
    b.interface.input = f.inputs.map(bool);
    b.interface.output = [bool(f.output)];
    b.interface.static = f.statics.map(bool);
    b.networks[0]!.source = f.body;
    items.push(item('Fronti e bistabili', b, f.comment));
  }
  return { items, groups: ['Selezione', 'Fronti e bistabili'] };
}
