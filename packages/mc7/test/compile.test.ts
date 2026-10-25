import {
  formatNetwork,
  type AwlBlockInfo,
  type AwlContext,
  type AwlSymbolInfo,
} from '@baaportal/awl';
import { parseBlockFile } from '@baaportal/s7comm';
import { sameName, type DataType, type TypedMember } from '@baaportal/s7-types';
import { describe, expect, it } from 'vitest';
import {
  CALL_FORMS,
  blockChecksum,
  compileBlock,
  dataLayout,
  decodeBlock,
  encodeBlock,
  readBlockFile,
  readSsb,
  type CompileInput,
  type Mc7Diagnostic,
} from '../src';
import {
  callSpans,
  calledBlocks,
  emptySections,
  firstDiff,
  hex,
  interfaceInput,
  networkBytes,
  relabelRawJumps,
  replaceCalls,
  selfContext,
  toAwlIface,
  type Sections,
} from './compileHelpers';
import { realBlocks } from './realBlocks';

// ---------------------------------------------------------------------------------------------
// Contesto di prova

const el = (name: string): DataType => ({ kind: 'elementary', name }) as DataType;
const par = (name: string): DataType => ({ kind: 'parameter', name }) as DataType;
const m = (name: string, type: DataType): TypedMember => ({ name, type });
const arr = (lo: number, hi: number, element: DataType): DataType => ({
  kind: 'array',
  dims: [{ lo, hi }],
  element,
});
const struct = (...members: TypedMember[]): DataType => ({ kind: 'struct', members });
const named = (name: string): DataType => ({ kind: 'named', name });

const nastro = emptySections({
  in: [m('Vel', el('Int')), m('Abil', el('Bool'))],
  out: [m('Ok', el('Bool'))],
  stat: [m('Cnt', el('Int'))],
});
const ctu = emptySections({
  in: [m('CU', el('Bool')), m('R', el('Bool')), m('PV', el('Int'))],
  out: [m('Q', el('Bool')), m('CV', el('Int'))],
});

const BLOCKS: AwlBlockInfo[] = [
  {
    name: 'Calcola',
    kind: 'FC',
    number: 1,
    iface: toAwlIface(emptySections({ in: [m('A', el('Int'))], out: [m('R', el('Int'))] })),
  },
  { name: 'Nastro', kind: 'FB', number: 2, iface: toAwlIface(nastro) },
  { name: 'Nastro_DB', kind: 'IDB', number: 3, instanceOf: 'Nastro' },
  {
    name: 'Dati',
    kind: 'DB',
    number: 1,
    dbMembers: [
      m('Asse', struct(m('Pos', el('Real')))),
      m('Cnt', el('Int')),
      m('Flag', el('Bool')),
      m('Vet', arr(0, 3, el('Int'))),
    ],
  },
  {
    name: 'BLKMOV',
    kind: 'SFC',
    number: 20,
    iface: toAwlIface(
      emptySections({
        in: [m('SRCBLK', par('Any'))],
        out: [m('DSTBLK', par('Any'))],
        ret: [m('RET_VAL', el('Int'))],
      }),
    ),
  },
  { name: 'CTU', kind: 'SFB', number: 0, iface: toAwlIface(ctu) },
  {
    name: 'Tutti',
    kind: 'FC',
    number: 11,
    iface: toAwlIface(
      emptySections({
        in: [
          m('a', el('Bool')),
          m('t', par('Timer')),
          m('blk', par('Block_DB')),
          m('any', par('Any')),
          m('p', par('Pointer')),
        ],
        out: [m('o', el('Int'))],
        inOut: [m('io', el('DInt'))],
        ret: [m('RET_VAL', el('Int'))],
      }),
    ),
  },
  { name: 'Prova', kind: 'FC', number: 10 },
  { name: 'Linea', kind: 'FB', number: 10 },
  { name: 'Main', kind: 'OB', number: 1 },
  { name: 'Vuota', kind: 'FC', number: 12, iface: toAwlIface(emptySections()) },
  {
    name: 'SoloRet',
    kind: 'FC',
    number: 5,
    iface: toAwlIface(emptySections({ ret: [m('RET_VAL', el('Int'))] })),
  },
  {
    name: 'TIME_TCK',
    kind: 'SFC',
    number: 64,
    iface: toAwlIface(emptySections({ ret: [m('RET_VAL', el('Time'))] })),
  },
];

const SYMBOLS: AwlSymbolInfo[] = [
  { name: 'Avvio', kind: 'tag', type: el('Bool'), address: '%I0.0' },
  { name: 'Motore', kind: 'tag', type: el('Bool'), address: 'Q 4.1' },
  { name: 'Velocità', kind: 'tag', type: el('Int'), address: '%MW10' },
  { name: 'Totale', kind: 'tag', type: el('DInt'), address: 'MD20' },
  { name: 'Ritardo', kind: 'tag', type: par('Timer'), address: 'T 5' },
  { name: 'MAXV', kind: 'constant', type: el('Int'), value: '100' },
];

function makeCtx(kind: 'OB' | 'FB' | 'FC', s: Sections): AwlContext {
  return {
    owner: { kind, iface: toAwlIface(s) },
    symbol: (name) => SYMBOLS.find((x) => sameName(x.name, name)),
    block: (ref) =>
      'name' in ref
        ? BLOCKS.find((b) => sameName(b.name, ref.name))
        : BLOCKS.find((b) => b.kind === ref.kind && b.number === ref.number),
    resolve: (name) => {
      const s = sameName(name, 'Nastro') ? nastro : sameName(name, 'CTU') ? ctu : undefined;
      return s
        ? { kind: 'fb', sections: { input: s.in, output: s.out, inOut: s.inOut, static: s.stat } }
        : null;
    },
    allSymbols: () => SYMBOLS,
    allBlocks: () => BLOCKS,
  };
}

const NOW = new Date(2026, 9, 20, 10, 30, 15, 250);
const HEADER = { author: 'Diego', family: 'Prove', name: 'Blocco', version: '0.1' };
const compiled: { name: string; file: Uint8Array }[] = [];

function compile(
  input: Omit<CompileInput, 'now' | 'header' | 'knowHowProtected'> & Partial<CompileInput>,
) {
  const r = compileBlock({ now: NOW, header: HEADER, knowHowProtected: false, ...input });
  if (r.file) compiled.push({ name: `${input.kind}${input.number}`, file: r.file });
  return r;
}
const errors = (d: Mc7Diagnostic[]) => d.filter((x) => x.severity === 'error');
const warnings = (d: Mc7Diagnostic[]) => d.filter((x) => x.severity === 'warning');

/**
 * Sorgente con i simboli sostituiti → AWL assoluto canonico, come lo stampa il decodificatore:
 * gli accessi qualificati `%DBn.x` diventano `OPN %DBn` + accesso; le etichette si rinominano con
 * `labels` (il decodificatore le numera `M001`, `M002`… in ordine di destinazione nel blocco).
 */
function resolvedAwl(
  source: string,
  subs: [string, string][],
  labels: Record<string, string> = {},
): string {
  let s = source;
  for (const [from, to] of [...subs].sort((a, b) => b[0].length - a[0].length)) {
    s = s.split(from).join(to);
  }
  for (const [from, to] of Object.entries(labels)) {
    s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  s = s
    .split('\n')
    .map((line) =>
      line.replace(
        /^((?:\w+:)?)\t(\S+) %DB(\d+)\.(DB\w+);/,
        (_, l: string, ins: string, db: string, rest: string) =>
          `${l}\tOPN %DB${db};\n\t${ins} %${rest};`,
      ),
    )
    .join('\n');
  return formatNetwork(s, 'international');
}

/** Istruzioni strutturali di una CALL espansa (testo decodificato): BLD, CDB, TAR2, LAR2, UC. */
function skeleton(text: string): string[] {
  return text
    .split('\n')
    .flatMap((l) => {
      const t = /\/\/ MC7 testo: (\S+)/.exec(l);
      if (t) return [t[1]!];
      if (/^\s*\/\//.test(l)) return [];
      const m = /^(?:\w+:)?\t(\S+)/.exec(l);
      return m ? [m[1]!] : [];
    })
    .filter((id) => ['BLD', 'CDB', 'TAR2', 'LAR2', 'UC'].includes(id));
}

const types = (s: Sections): [string, DataType][] =>
  (['in', 'out', 'inOut', 'stat', 'temp', 'ret'] as const).flatMap((sec) =>
    s[sec].map((x): [string, DataType] => [sec, x.type]),
  );

// ---------------------------------------------------------------------------------------------

describe('compilatore dei blocchi del progetto (Task 7)', () => {
  const fcSections = emptySections({
    in: [m('Start', el('Bool')), m('Valore', el('Int'))],
    out: [m('Fatto', el('Bool'))],
    inOut: [m('Acc', el('DInt'))],
    temp: [m('Tmp', el('Word')), m('Flag', el('Bool')), m('Vett', arr(1, 3, el('Int')))],
  });
  const fcNetworks = [
    '\tA "Avvio";\n\tA #Start;\n\t= #Flag;\n\tA #Flag;\n\t= #Fatto;',
    '\tL #Valore;\n\tT #Tmp;\n\tL "Velocità";\n\t+I;\n\tT "Dati".Cnt;\n\tL "Dati".DBW4;\n\tT #Vett[2];\n\tL #Acc;\n\tL L#1;\n\t+D;\n\tT #Acc;',
    '\tA "Motore";\n\tJC fine;\n\tL "MAXV";\n\tT MW 30;\nfine:\tNOP 0;',
  ];
  const fcInput = {
    kind: 'FC' as const,
    number: 10,
    sections: fcSections,
    initials: {},
    networks: fcNetworks,
    ctx: makeCtx('FC', fcSections),
  };

  it('FC senza CALL compilato: decodeBlock dà lo stesso AWL (forma canonica) e la stessa interfaccia', () => {
    const r = compile(fcInput);
    expect(r.diagnostics).toEqual([]);
    const b = decodeBlock(r.file!);
    expect(b.exact).toBe(true);
    expect(b.kind).toBe('FC');
    expect(b.number).toBe(10);
    expect(b.language).toBe(1);
    // Simboli → assoluti; parametri di FC → formali #PARn (indice IN, OUT, IN_OUT, mc7 §2.2.6);
    // TEMP: Tmp LW0, Flag L2.0, Vett[1..3] da LW4; "Dati": Asse 0, Cnt 4.
    const subs: [string, string][] = [
      ['"Avvio"', '%I0.0'],
      ['"Motore"', '%Q4.1'],
      ['"Velocità"', '%MW10'],
      ['"Dati".Cnt', '%DB1.DBW4'],
      ['"Dati".DBW4', '%DB1.DBW4'],
      ['"MAXV"', '100'],
      ['MW 30', '%MW30'],
      ['#Start', '#PAR0'],
      ['#Valore', '#PAR1'],
      ['#Fatto', '#PAR2'],
      ['#Acc', '#PAR3'],
      ['#Tmp', '%LW0'],
      ['#Flag', '%L2.0'],
      ['#Vett[2]', '%LW6'],
    ];
    expect(b.networks).toEqual(fcNetworks.map((n) => resolvedAwl(n, subs, { fine: 'M001' })));
    const iface = readSsb(readBlockFile(r.file!).ssb, 'FC');
    const shape = (t: DataType | { kind: 'raw' }): unknown =>
      t.kind === 'array' ? { dims: t.dims } : t;
    expect(iface.elements.map((e) => [e.section, shape(e.type)])).toEqual(
      types(fcSections).map(([sec, t]) => [sec, shape(t)]),
    );
    expect(iface.elements[6]!.children![0]!.type).toEqual(el('Int'));
    expect(readBlockFile(r.file!).header.localDataLength).toBe(10);
  });

  it('OB1 con simboli, temporizzatore e salti tra le reti', () => {
    const temps = emptySections({
      temp: [
        m('OB1_EV_CLASS', el('Byte')),
        m('OB1_SCAN_1', el('Byte')),
        m('OB1_PRIORITY', el('Byte')),
        m('OB1_OB_NUMBR', el('Byte')),
        m('OB1_RESERVED_1', el('Byte')),
        m('OB1_RESERVED_2', el('Byte')),
        m('OB1_PREV_CYCLE', el('Int')),
        m('OB1_MIN_CYCLE', el('Int')),
        m('OB1_MAX_CYCLE', el('Int')),
        m('OB1_DATE_TIME', { kind: 'dateAndTime' }),
      ],
    });
    const nets = [
      '\tA "Avvio";\n\tJCN m1;\n\tL #OB1_PREV_CYCLE;\n\tT "Velocità";\n\tSET;\n\t= "Motore";\nm1:\tA "Ritardo";\n\tL S5T#2S;\n\tSD "Ritardo";',
      '\tL "Totale";\n\tL L#10;\n\t>D;\n\tJC m2;\n\tJU m3;\nm2:\tCLR;\n\t= "Motore";\n\tJU m1;\nm3:\tNOP 0;',
    ];
    const r = compile({
      kind: 'OB',
      number: 1,
      sections: temps,
      initials: {},
      networks: nets,
      ctx: makeCtx('OB', temps),
    });
    expect(r.diagnostics).toEqual([]);
    const b = decodeBlock(r.file!);
    expect(b.exact).toBe(true);
    const subs: [string, string][] = [
      ['"Avvio"', '%I0.0'],
      ['"Motore"', '%Q4.1'],
      ['"Velocità"', '%MW10'],
      ['"Totale"', '%MD20'],
      ['"Ritardo"', '%T5'],
      ['#OB1_PREV_CYCLE', '%LW6'],
    ];
    const labels = { m1: 'M001', m2: 'M002', m3: 'M003' };
    expect(b.networks![0]).toBe(resolvedAwl(nets[0]!, subs, labels));
    // Il salto all'indietro verso la rete 1 (JU m1) è un'etichetta anche nella decodifica
    // (le etichette valgono in tutto il blocco).
    expect(b.networks![1]).toBe(resolvedAwl(nets[1]!, subs, labels));
    const f = readBlockFile(r.file!);
    expect(f.header.localDataLength).toBe(20);
    expect(f.add.jumps).toHaveLength(4);
  });

  it('etichetta automatica _001 (KOP): salto in avanti compilato', () => {
    const s = emptySections({});
    const r = compile({
      kind: 'FC',
      number: 11,
      sections: s,
      initials: {},
      networks: ['A I 0.0\nJNB _001\nL MW 10\nT MW 12\n_001: NOP 0'],
      ctx: makeCtx('FC', s),
    });
    expect(errors(r.diagnostics)).toEqual([]);
    expect(r.file).toBeDefined();
    expect(decodeBlock(r.file!).exact).toBe(true);
  });
  it('FB con multi-istanza e CALL di FC: equivalente ai blocchi reali dello stesso schema', () => {
    const s = emptySections({
      in: [m('Start', el('Bool')), m('Vel', el('Int'))],
      out: [m('Fatto', el('Bool')), m('Ris', el('Int'))],
      stat: [m('Conta', el('DInt')), m('Sub', named('Nastro')), m('Pos', el('Real'))],
      temp: [m('Tmp', el('Int'))],
    });
    const nets = [
      '\tA #Start;\n\t= #Fatto;\n\tL #Vel;\n\tT #Sub.Vel;\n\tL #Conta;\n\tL L#1;\n\t+D;\n\tT #Conta;',
      '\tA #Start;\n\tCALL "Calcola" (A := 1, R := #Tmp);',
      '\tCALL "Calcola" (A := #Vel, R := #Ris);',
      '\tA #Start;\n\tCALL #Sub (Vel := 5, Abil := TRUE, Ok => #Fatto);',
    ];
    const r = compile({
      kind: 'FB',
      number: 10,
      sections: s,
      initials: { Vel: '3', Pos: '1.5' },
      networks: nets,
      ctx: makeCtx('FB', s),
    });
    expect(errors(r.diagnostics)).toEqual([]);
    // Rete 2: forme viste in FB80 (FC da FB con dati d'istanza), FC1 (costante) e FC100
    // (temporaneo per puntatore): nessun avviso. Reti 3 e 4: forme senza esempio reale.
    expect(warnings(r.diagnostics).map((d) => [d.code, d.network])).toEqual([
      ['CALL_NON_VERIFICATO', 3],
      ['CALL_NON_VERIFICATO', 4],
    ]);
    expect(warnings(r.diagnostics)[0]!.message).toMatch(/istanza/);
    const f = readBlockFile(r.file!);
    expect(f.header.flags).toBe(0x05); // multi-istanza: bit 2 come FB80 e FB3004 (mc7 §1.2 ⚠️)
    const b = decodeBlock(r.file!);
    expect(b.exact).toBe(true);
    // Istanza: Start 0.0, Vel 2, Fatto 4.0, Ris 6, Conta 8, Sub 12 (Vel 12, Abil 14.0, Ok 16.0, Cnt 18), Pos 20.
    // Accessi con AR2 come FB41/FB80 (mc7 §2.2.6). TEMP: Tmp LW0; base delle CALL: 2.
    expect(b.networks![0]).toBe(
      formatNetwork(
        '\tA %DIX[AR2,P#0.0];\n\t= %DIX[AR2,P#4.0];\n\tL %DIW[AR2,P#2.0];\n\tT %DIW[AR2,P#12.0];\n\tL %DID[AR2,P#8.0];\n\tL L#1;\n\t+D;\n\tT %DID[AR2,P#8.0];',
        'international',
      ),
    );
    // Come FB80 rete 2: BLD 1; = L; TAR2 LD; copie; UC FC + puntatori P#V; LAR2 LD; BLD 2.
    expect(b.networks![1]).toBe(
      [
        '\tA %DIX[AR2,P#0.0];',
        '\tBLD 1;',
        '\t= %L6.0;',
        '\tTAR2 %LD2;',
        '\tL 1;',
        '\tT %LW7;',
        '\t// MC7 grezzo: 3d 01 70 0b 00 06 87 00 00 38 87 00 00 00',
        '\t// MC7 testo: UC %FC1',
        '\tLAR2 %LD2;',
        '\tBLD 2;',
      ].join('\n'),
    );
    // Prima istruzione della rete: nessun salvataggio del RLO (come FB101).
    expect(b.networks![2]).toBe(
      [
        '\tBLD 1;',
        '\tTAR2 %LD2;',
        '\tL %DIW[AR2,P#2.0];',
        '\tT %LW6;',
        '\t// MC7 grezzo: 3d 01 70 0b 00 06 87 00 00 30 87 00 00 40',
        '\t// MC7 testo: UC %FC1',
        '\tLAR2 %LD2;',
        '\tL %LW8;',
        '\tT %DIW[AR2,P#6.0];',
        '\tBLD 2;',
      ].join('\n'),
    );
    expect(b.networks![3]).toBe(
      [
        '\tA %DIX[AR2,P#0.0];',
        '\tBLD 14;',
        '\t= %L6.0;',
        '\tTAR2 %LD2;',
        '\tL 5;',
        '\tT %DIW[AR2,P#12.0];',
        '\tSET;',
        '\t= %DIX[AR2,P#14.0];',
        '\tL %LD2;',
        '\tL P#12.0;',
        '\t+D;',
        '\tLAR2;',
        '\tUC %FB2;',
        '\tLAR2 %LD2;',
        '\tA %DIX[AR2,P#16.0];',
        '\t= %DIX[AR2,P#4.0];',
        '\tBLD 15;',
      ].join('\n'),
    );
    expect(f.header.localDataLength).toBe(10);
  });

  it("CALL di FB con DB di istanza da un OB: schema dell'OB1 reale", () => {
    const temps = emptySections({ temp: [m('T0', arr(0, 19, el('Byte')))] });
    const r = compile({
      kind: 'OB',
      number: 1,
      sections: temps,
      initials: {},
      networks: [
        '\tA "Avvio";\n\tCALL "Nastro", "Nastro_DB" (Vel := "Velocità", Abil := TRUE, Ok => "Motore");',
      ],
      ctx: makeCtx('OB', temps),
    });
    expect(errors(r.diagnostics)).toEqual([]);
    const text = decodeBlock(r.file!).networks![0]!;
    expect(text).toBe(
      [
        '\tA %I0.0;',
        '\tBLD 3;',
        '\t= %L24.0;',
        '\tCDB;',
        '\tOPN %DI3;',
        '\tTAR2 %LD20;',
        '\tL %MW10;',
        '\tT %DIW0;',
        '\tSET;',
        '\t= %DIX2.0;',
        '\tLAR2 P#DBX 0.0;',
        '\tUC %FB2;',
        '\tLAR2 %LD20;',
        '\tA %DIX4.0;',
        '\t= %Q4.1;',
        '\tCDB;',
        '\tBLD 4;',
      ].join('\n'),
    );
    expect(readBlockFile(r.file!).header.localDataLength).toBe(26);
    const ob1 = realBlocks().find((x) => x.name.startsWith('OB1 (gymgit/tia_s300_downloadOb1'));
    if (ob1) {
      const real = decodeBlock(ob1.bytes).networks![0]!;
      const span = real.slice(real.indexOf('\tBLD 3;'), real.indexOf('\tBLD 4;') + 8);
      expect(skeleton(text)).toEqual(skeleton(span));
    }
  });

  it('CALL di FC con ogni classe di parametro: lista IN, RET_VAL, OUT, IN_OUT e avviso', () => {
    const temps = emptySections({ temp: [m('Tmp', el('DInt'))] });
    const r = compile({
      kind: 'OB',
      number: 1,
      sections: temps,
      initials: {},
      networks: [
        '\tA "Avvio";\n\tCALL "Tutti" (a := "Avvio", t := T 5, blk := DB 1, any := "Dati".Vet, p := P#M 10.0, o := "Dati".Cnt, io := #Tmp, RET_VAL := MW 40);',
      ],
      ctx: makeCtx('OB', temps),
    });
    expect(errors(r.diagnostics)).toEqual([]);
    expect(warnings(r.diagnostics).map((d) => d.params?.['forms'])).toEqual([
      'FC:I/Q/M, FC:TIMER, FC:BLOCK, FC:ANY-variabile, FC:POINTER-costante, FC:OUT:DB',
    ]);
    // base 4 (Tmp); RLO L4.0; ANY LW5…LD11; POINTER LW15, LD17; copia di o LW21 → dati locali 24
    expect(decodeBlock(r.file!).networks![0]).toBe(
      [
        '\tA %I0.0;',
        '\tBLD 1;',
        '\t= %L4.0;',
        '\tL W#16#1005;',
        '\tT %LW5;',
        '\tL 4;',
        '\tT %LW7;',
        '\tL 1;',
        '\tT %LW9;',
        '\tL P#DBX 8.0;',
        '\tT %LD11;',
        '\tL 0;',
        '\tT %LW15;',
        '\tL P#M 10.0;',
        '\tT %LD17;',
        // a P#I0.0, t T5, blk DB1, any P#V5.0, p P#V15.0, RET_VAL P#M40.0, o P#V21.0, io P#V0.0
        '\t// MC7 grezzo: 3d 0b 70 0b 00 12 81 00 00 00 00 05 00 00 00 01 00 00 87 00 00 28 87 00 00 78 83 00 01 40 87 00 00 a8 87 00 00 00',
        '\t// MC7 testo: UC %FC11',
        '\tL %LW21;',
        '\tOPN %DB1;',
        '\tT %DBW4;',
        '\tBLD 2;',
      ].join('\n'),
    );
    expect(readBlockFile(r.file!).header.localDataLength).toBe(24);
    // L W#16#1005 dell'ANY con il byte di tipo 00 del compilatore, come in FC100 (mc7 §2.3)
    expect(hex(readBlockFile(r.file!).mc7.slice(8, 12))).toBe('30 00 10 05');
  });

  it("FC con RET_VAL e OUT: avviso sull'ordine dei parametri; FC con soli IN o con RET_VAL Void: nessun avviso", () => {
    const avviso = (d: Mc7Diagnostic[]) =>
      d.filter((x) => x.code === 'FC_ORDINE_PARAMETRI_NON_VERIFICATO');
    const nets = ['\tA "Avvio";\n\t= #Fatto;\n\tL #Valore;'];
    const conRet = emptySections({
      in: [m('Valore', el('Int'))],
      out: [m('Fatto', el('Bool'))],
      ret: [m('RET_VAL', el('Int'))],
    });
    const conOut = compile({
      kind: 'FC',
      number: 12,
      sections: conRet,
      initials: {},
      networks: nets,
      ctx: makeCtx('FC', conRet),
    });
    expect(errors(conOut.diagnostics)).toEqual([]);
    expect(conOut.file).toBeDefined();
    expect(avviso(conOut.diagnostics)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        network: 0,
        line: 0,
        message:
          'Ordine dei parametri della FC con RET_VAL verificato su un solo blocco reale: controllare i richiami.',
      }),
    ]);

    const soloIn = emptySections({
      in: [m('Valore', el('Int'))],
      ret: [m('RET_VAL', el('Int'))],
    });
    const r1 = compile({
      kind: 'FC',
      number: 13,
      sections: soloIn,
      initials: {},
      networks: ['\tL #Valore;'],
      ctx: makeCtx('FC', soloIn),
    });
    expect(r1.file).toBeDefined();
    expect(avviso(r1.diagnostics)).toEqual([]);

    const void_ = emptySections({ in: [m('Valore', el('Int'))], out: [m('Fatto', el('Bool'))] });
    const r2 = compile({
      kind: 'FC',
      number: 14,
      sections: void_,
      initials: {},
      networks: nets,
      ctx: makeCtx('FC', void_),
    });
    expect(r2.file).toBeDefined();
    expect(avviso(r2.diagnostics)).toEqual([]);
  });

  it('DB globale e DB di istanza: dati = layout dei valori iniziali', () => {
    const dbSections = emptySections({
      stat: [
        m('On', el('Bool')),
        m('Num', el('Int')),
        m('Kp', el('Real')),
        m('Nome', { kind: 'string', length: 4 }),
        m('Pt', struct(m('x', el('Int')), m('y', el('Bool')))),
        m('Tab', arr(0, 2, el('Int'))),
        m('Righe', arr(1, 2, struct(m('k', el('Byte')), m('w', el('Word'))))),
      ],
    });
    const r = compile({
      kind: 'DB',
      number: 5,
      sections: dbSections,
      initials: { On: 'TRUE', Num: '7', Kp: '1.5', Nome: "'ab'", 'Pt.x': '3', 'Righe.k': '16#0F' },
      networks: [],
      ctx: makeCtx('OB', emptySections()),
    });
    expect(r.diagnostics).toEqual([]);
    const b = decodeBlock(r.file!);
    expect(b.exact).toBe(true);
    expect(b.kind).toBe('DB');
    expect(b.language).toBe(5);
    const f = readBlockFile(r.file!);
    expect(f.header.localDataLength).toBe(0);
    expect(f.addRaw.length).toBe(0);
    const lay = dataLayout(b.iface);
    const at = (p: string) => lay.offsets.find((o) => o.path === p)!;
    expect(b.data!.length).toBe(lay.size);
    const expected = new Uint8Array(lay.size);
    expected[at('STAT0').byte] = 1 << at('STAT0').bit!;
    expected.set([0, 7], at('STAT1').byte);
    expected.set([0x3f, 0xc0, 0, 0], at('STAT2').byte);
    expected.set([4, 2, 0x61, 0x62], at('STAT3').byte);
    expected.set([0, 3], at('STAT4.STAT0').byte);
    const tab = at('STAT5');
    const righe = at('STAT6');
    const k = at('STAT6[1].STAT0');
    for (let i = 0; i < 2; i++) expected[k.byte + (i * righe.strideBits!) / 8] = 0x0f;
    expect(tab.byte).toBe(18);
    expect(hex(b.data!)).toBe(hex(expected));
    expect(f.footer.checksum).toBe(blockChecksum(0x0a, f.mc7));

    // DB di istanza: interfaccia dell'FB (genere 0a, numero dell'FB come DB1806, mc7 §1.9),
    // valori iniziali dell'FB nell'SSB, dati = iniziali dell'FB con quelli del DB sopra.
    const idb = compile({
      kind: 'IDB',
      number: 3,
      sections: emptySections(),
      initials: { Cnt: '4', Vel: '12' },
      networks: [],
      ctx: makeCtx('OB', emptySections()),
      instanceOf: {
        kind: 'FB',
        number: 2,
        sections: nastro,
        initials: { Vel: '10', Abil: 'TRUE' },
      },
    });
    expect(idb.diagnostics).toEqual([]);
    const ib = decodeBlock(idb.file!);
    expect(ib.exact).toBe(true);
    expect(ib.instanceOf).toEqual({ kind: 'FB', number: 2 });
    expect(hex(ib.iface.header.slice(0, 3))).toBe('0a 02 00');
    expect(ib.iface.elements.map((e) => (e.initial ? hex(e.initial) : '-'))).toEqual([
      '0a 00',
      '01',
      '-',
      '-',
    ]);
    // Vel 0, Abil 2.0, Ok 4.0, Cnt 6
    expect(hex(ib.data!)).toBe('00 0c 01 00 00 00 00 04');

    // DB di istanza di un SFB: il genere SSB non è documentato (mc7 §1.9). Senza l'intestazione
    // dell'SSB di un DB reale dello stesso SFB non si compila (mai un genere indovinato).
    const sfbInput = {
      kind: 'IDB' as const,
      number: 9,
      sections: emptySections(),
      initials: { PV: '5' },
      networks: [],
      ctx: makeCtx('OB', emptySections()),
    };
    const unknown = compile({ ...sfbInput, instanceOf: { kind: 'SFB', number: 0, sections: ctu } });
    expect(unknown.file).toBeUndefined();
    expect(errors(unknown.diagnostics).map((d) => [d.code, d.params?.['sfb']])).toEqual([
      ['LAYOUT_SFB_SCONOSCIUTO', 'SFB0'],
    ]);
    // Con l'intestazione di un DB reale (qui sintetica: genere 10, numero 0) si usa quella
    const sfb = compile({
      ...sfbInput,
      instanceOf: { kind: 'SFB', number: 0, sections: ctu, ssbHeader: Uint8Array.of(0x10, 0, 0) },
    });
    expect(sfb.diagnostics).toEqual([]);
    expect(readBlockFile(sfb.file!).ssb[0]).toBe(0x10);
    // CU 0.0, R 0.1, PV 2, Q 4.0, CV 6
    expect(hex(decodeBlock(sfb.file!).data!)).toBe('00 00 00 05 00 00 00 00');
  });

  it('codice con errori: nessun file, errori con segmento e riga', () => {
    const bad = compile({ ...fcInput, networks: ['\tA "Avvio";\n\tA "Sconosciuto";'] });
    expect(bad.file).toBeUndefined();
    expect(errors(bad.diagnostics).map((d) => [d.code, d.network, d.line])).toEqual([
      ['UNKNOWN_SYMBOL', 1, 2],
    ]);
    expect(bad.diagnostics[0]!.message).toMatch(/Rete 1, riga 2/);

    const ptr = compile({ ...fcInput, networks: ['\tA #Start;', '\tNOP 0;\n\tL P##Tmp;'] });
    expect(ptr.file).toBeUndefined();
    expect(errors(ptr.diagnostics).map((d) => [d.code, d.network, d.line])).toEqual([
      ['P_LOCAL_UNSUPPORTED', 2, 2],
    ]);
    expect(ptr.diagnostics[0]!.message).toMatch(/riga 2/);

    const long = compile({ ...fcInput, header: { ...HEADER, author: '123456789' } });
    expect(long.file).toBeUndefined();
    expect(errors(long.diagnostics).map((d) => [d.code, d.params?.['field']])).toEqual([
      ['HEADER_FIELD_TOO_LONG', 'author'],
    ]);
    const accent = compile({ ...fcInput, header: { ...HEADER, name: 'Città' } });
    expect(errors(accent.diagnostics).map((d) => d.code)).toEqual(['HEADER_FIELD_NOT_ASCII']);
    const version = compile({ ...fcInput, header: { ...HEADER, version: '16.0' } });
    expect(errors(version.diagnostics).map((d) => d.code)).toEqual(['HEADER_VERSION']);

    // Un avviso non impedisce il file
    const warn = compile({
      kind: 'FC',
      number: 10,
      sections: fcSections,
      initials: {},
      networks: ['\tCALL "Calcola" (A := "Velocità", R := "Velocità");'],
      ctx: makeCtx('FC', fcSections),
    });
    expect(errors(warn.diagnostics)).toEqual([]);
    expect(warnings(warn.diagnostics).map((d) => d.code)).toEqual(['CALL_NON_VERIFICATO']);
    expect(warn.file).toBeDefined();
  });

  it('UC/CC di un blocco con parametri: errore UC_BLOCCO_CON_PARAMETRI; senza parametri si compila', () => {
    const at = (source: string) =>
      compile({
        kind: 'FC',
        number: 10,
        sections: fcSections,
        initials: {},
        networks: [`\tA "Avvio";\n${source}`],
        ctx: makeCtx('FC', fcSections),
      });
    for (const [source, block] of [
      ['\tUC FC 1;', 'FC1'],
      ['\tCC FC 1;', 'FC1'],
      ['\tUC "Calcola";', 'FC1'],
      ['\tUC FB 2;', 'FB2'],
      ['\tCC SFC 20;', 'SFC20'],
      // il solo RET_VAL è un parametro: anche lui va nella lista dei puntatori
      ['\tUC FC 5;', 'FC5'],
      ['\tUC SFC 64;', 'SFC64'],
    ] as const) {
      const r = at(source);
      expect(r.file, source).toBeUndefined();
      expect(
        errors(r.diagnostics).map((d) => [d.code, d.network, d.line, d.params?.['block']]),
        source,
      ).toEqual([['UC_BLOCCO_CON_PARAMETRI', 1, 2, block]]);
    }
    // Interfaccia nota senza parametri: si compila, e la decodifica ridà le due chiamate
    const ok = at('\tUC FC 12;\n\tCC "Vuota";');
    expect(errors(ok.diagnostics)).toEqual([]);
    expect(decodeBlock(ok.file!).networks).toEqual(['\tA %I0.0;\n\tUC %FC12;\n\tCC %FC12;']);
  });

  it('regola F senza il ponte: una rete tenuta non fa scendere i dati locali; senza il valore originale nessuna rete li tiene', () => {
    // FC10 con un grande TEMP e la CALL di Calcola: senza risolutore la decodifica la lascia
    // espansa, col grezzo della lista dei puntatori
    const big = emptySections({ temp: [m('t', el('Int')), m('big', arr(0, 9, el('DInt')))] });
    const first = compile({
      kind: 'FC',
      number: 10,
      sections: big,
      initials: {},
      networks: ['\tCALL "Calcola" (A := 5, R := #t);', '\tL #t;\n\tT MW 0;'],
      ctx: makeCtx('FC', big),
    });
    expect(errors(first.diagnostics)).toEqual([]);
    expect(readBlockFile(first.file!).header.localDataLength).toBe(44);
    const d = decodeBlock(first.file!);
    expect(d.networks![0]).toMatch(/MC7 grezzo/);
    expect(d.meta.code!.localData).toBe(44);
    // Il TEMP grande non c'è più, le reti sono quelle originali, niente header originale
    const small = emptySections({ temp: [m('t', el('Int'))] });
    const again = (codeMeta: typeof d.meta.code) =>
      compileBlock({
        kind: 'FC',
        number: 10,
        knowHowProtected: false,
        header: HEADER,
        sections: small,
        initials: {},
        networks: d.networks!,
        ctx: makeCtx('FC', small),
        now: NOW,
        ...(codeMeta ? { codeMeta } : {}),
      });
    const kept = again(d.meta.code);
    expect(errors(kept.diagnostics)).toEqual([]);
    // La rete tenuta scrive ancora la copia in L oltre i nuovi TEMP: dati locali dell'originale
    expect(networkBytes(readBlockFile(kept.file!)).map((x) => hex(x))).toEqual(
      networkBytes(readBlockFile(first.file!)).map((x) => hex(x)),
    );
    expect(readBlockFile(kept.file!).header.localDataLength).toBe(44);
    // Senza i dati locali originali (metadati vecchi, niente header) nessuna rete tiene i byte
    const old = { ...d.meta.code! };
    delete old.localData;
    const none = again(old);
    expect(none.file).toBeUndefined();
    expect(errors(none.diagnostics).map((x) => [x.code, x.network, x.params?.['reason']])).toEqual([
      ['RAW_CONTESTO_CAMBIATO', 1, 'unknown'],
    ]);
  });

  it('header e footer: timestamp S7, campi ASCII, versione, know-how, checksum', () => {
    const r = compile({ ...fcInput, knowHowProtected: true });
    const f = readBlockFile(r.file!);
    const ms = ((10 * 60 + 30) * 60 + 15) * 1000 + 250;
    const days = (Date.UTC(2026, 9, 20) - Date.UTC(1984, 0, 1)) / 86_400_000;
    const ts = hex([ms >>> 24, (ms >> 16) & 255, (ms >> 8) & 255, ms & 255, days >> 8, days & 255]);
    expect(hex(f.header.codeTime)).toBe(ts);
    expect(hex(f.header.interfaceTime)).toBe(ts);
    expect(hex(f.header.raw.slice(0, 6))).toBe('70 70 01 01 01 0c');
    expect(f.header.knowHowProtected).toBe(true);
    expect(f.footer).toMatchObject({
      author: 'Diego',
      family: 'Prove',
      name: 'Blocco',
      version: '0.1',
    });
    expect(f.footer.checksum).toBe(blockChecksum(0x0c, f.mc7));
    expect(hex(f.footer.raw.slice(28))).toBe('00 00 00 00 00 00 00 00');
    // SSB: numero del blocco nelle FC/FB non protette, 0 negli OB e nei blocchi protetti (mc7 §1.4.1 ⚠️)
    expect(f.ssb[1]).toBe(0);
    const open = readBlockFile(compile(fcInput).file!);
    expect(open.ssb[1]! | (open.ssb[2]! << 8)).toBe(10);
  });

  it('readBlockFile di @baaportal/mc7 e parseBlockFile di @baaportal/s7comm accettano ogni file compilato', () => {
    expect(compiled.length).toBeGreaterThanOrEqual(8);
    for (const { name, file } of compiled) {
      expect(() => readBlockFile(file), name).not.toThrow();
      const p = parseBlockFile(file);
      expect(p.warnings, name).toEqual([]);
      expect(p.header.loadLength, name).toBe(file.length);
      expect(hex(encodeBlock(decodeBlock(file))), name).toBe(hex(file));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Blocchi reali ricompilati dal loro AWL decodificato

const fc = (number: number, input: TypedMember[]): AwlBlockInfo => ({
  name: `FC${number}`,
  kind: 'FC',
  number,
  iface: toAwlIface(emptySections({ in: input })),
});
const bytes = (n: number) => arr(0, n - 1, el('Byte'));

/** Sorgente CALL di ogni espansione reale (mc7 §2.5), in ordine, e i blocchi chiamati con parametri. */
const CALLS: Record<string, { sources: string[]; callees: AwlBlockInfo[] }> = {
  OB1: {
    sources: [
      'CALL FB 1, DB 2 (P1 := MD 12, P2 := MD 8, P3 := 80.0, P4 := 80.0, R1 => MD 16, R2 => MW 2, R3 => MD 20)',
      'CALL SFB 0, DB 1 (CU := L 20.0, PV := 1000, CV => MW 2)',
    ],
    callees: [
      {
        name: 'FB1',
        kind: 'FB',
        number: 1,
        // ingressi a DID10, 18, 48, 56 e uscite a DID72, DIW76, DID78 come nell'OB1 reale
        iface: toAwlIface(
          emptySections({
            in: [
              m('F0', bytes(10)),
              m('P1', el('DInt')),
              m('F1', bytes(4)),
              m('P2', el('Real')),
              m('F2', bytes(26)),
              m('P3', el('Real')),
              m('F3', bytes(4)),
              m('P4', el('Real')),
            ],
            out: [m('F4', bytes(12)), m('R1', el('DInt')), m('R2', el('Int')), m('R3', el('DInt'))],
          }),
        ),
      },
      { name: 'DB2', kind: 'IDB', number: 2, instanceOf: 'FB1' },
      { name: 'CTU', kind: 'SFB', number: 0, iface: toAwlIface(ctu) },
      { name: 'DB1', kind: 'IDB', number: 1, instanceOf: 'CTU' },
    ],
  },
  FB101: { sources: ['CALL FC 100 (IN0 := 1)'], callees: [fc(100, [m('IN0', el('Int'))])] },
  FC1: {
    sources: [
      'CALL FC 96 (IN0 := 1)',
      'CALL FC 96 (IN0 := 2)',
      'CALL FC 96 (IN0 := 3)',
      'CALL FC 96 (IN0 := 4)',
      'CALL FC 94 (IN0 := FALSE)',
      'CALL FC 97 (IN0 := FALSE)',
      'CALL FC 45',
      'CALL FC 16 (IN0 := L#400)',
      'CALL FC 21 (IN0 := L#240)',
    ],
    callees: [
      fc(96, [m('IN0', el('Int'))]),
      fc(94, [m('IN0', el('Bool'))]),
      fc(97, [m('IN0', el('Bool'))]),
      fc(16, [m('IN0', el('DInt'))]),
      fc(21, [m('IN0', el('DInt'))]),
    ],
  },
  FC100: {
    sources: [
      'CALL SFC 20 (SRCBLK := #TEMP24, RET_VAL := #TEMP23, DSTBLK := P#DB100.DBX 0.0 BYTE 400)',
      'CALL FC 91',
      'CALL FC 95 (IN0 := #TEMP7)',
      'CALL FC 94 (IN0 := TRUE)',
      'CALL FC 97 (IN0 := TRUE)',
      'CALL SFC 20 (SRCBLK := P#DB100.DBX 0.0 BYTE 880, RET_VAL := #TEMP23, DSTBLK := #TEMP24)',
    ],
    callees: [
      BLOCKS.find((b) => b.name === 'BLKMOV')!,
      fc(95, [m('IN0', el('Int'))]),
      fc(94, [m('IN0', el('Bool'))]),
      fc(97, [m('IN0', el('Bool'))]),
    ],
  },
  FC21: { sources: ['CALL FC 20', 'CALL FC 19'], callees: [] },
};

/** Timestamp di blocco (ms dalla mezzanotte, giorni dal 1984-01-01) → Date locale. */
function timeOf(b: Uint8Array): Date {
  const ms = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const days = (b[4]! << 8) | b[5]!;
  const h = Math.floor(ms / 3_600_000);
  return new Date(
    1984,
    0,
    1 + days,
    h,
    Math.floor(ms / 60_000) % 60,
    Math.floor(ms / 1000) % 60,
    ms % 1000,
  );
}

interface SelfResult {
  name: string;
  file?: Uint8Array;
  errors: Mc7Diagnostic[];
  warnings: Mc7Diagnostic[];
  identical: boolean;
  /** Sezioni diverse: byte dell'header (timestamp esclusi) e primo byte diverso delle altre. */
  parts: string[];
  localData: { real: number; compiled?: number };
  /** Reti senza CALL: indici (da 1) di quelle diverse. */
  plainDiffer: number[];
  plainTotal: number;
  calls: { network: number; same: boolean; real: string; ours?: string }[];
  jumps: number;
  indirect: number;
}

/** CompileInput di un blocco reale dal suo AWL decodificato (CALL sostituite dalle sorgenti). */
function selfInput(
  name: string,
  original: Uint8Array,
): { input: CompileInput; jumps: number; indirect: number } {
  const d = decodeBlock(original);
  const f = readBlockFile(original);
  const kind = d.kind as 'OB' | 'FB' | 'FC';
  const { sections, initials, fbTypes } = interfaceInput(d.iface, kind);
  const spec = CALLS[name.split(' ')[0]!] ?? { sources: [], callees: [] };
  const relabeled = relabelRawJumps(d.networks!, original);
  const nets = replaceCalls(relabeled.networks, spec.sources);
  const callees = [
    ...spec.callees,
    ...calledBlocks(nets).filter(
      (c) => !spec.callees.some((x) => x.kind === c.kind && x.number === c.number),
    ),
  ];
  return {
    input: {
      kind,
      number: d.number,
      knowHowProtected: d.knowHowProtected,
      header: d.header,
      sections,
      initials,
      networks: nets,
      ctx: selfContext(kind, sections, callees, fbTypes),
      now: timeOf(f.header.codeTime),
    },
    jumps: relabeled.jumps,
    indirect: relabeled.indirectCalls,
  };
}

function selfCompile(name: string, original: Uint8Array): SelfResult {
  const f = readBlockFile(original);
  const key = name.split(' ')[0]!;
  const self = selfInput(name, original);
  const r = compileBlock(self.input);
  const out: SelfResult = {
    name: key,
    errors: errors(r.diagnostics),
    warnings: warnings(r.diagnostics),
    identical: false,
    localData: { real: f.header.localDataLength },
    plainDiffer: [],
    plainTotal: 0,
    parts: [],
    calls: [],
    jumps: self.jumps,
    indirect: self.indirect,
  };
  if (!r.file) return out;
  out.file = r.file;
  const g = readBlockFile(r.file);
  out.identical = hex(r.file) === hex(original);
  out.localData.compiled = g.header.localDataLength;
  const head: number[] = [];
  for (let k = 0; k < 36; k++) {
    if ((k < 16 || k >= 28) && g.header.raw[k] !== f.header.raw[k]) head.push(k);
  }
  if (head.length) out.parts.push(`header byte ${head.join(',')}`);
  for (const [name, a, b] of [
    ['MC7', g.mc7, f.mc7],
    ['SSB', g.ssb, f.ssb],
    ['ADD', g.addRaw, f.addRaw],
    ['footer', g.footer.raw, f.footer.raw],
  ] as const) {
    const k = firstDiff(a, b);
    if (k >= 0)
      out.parts.push(
        `${name} da byte ${k}${a.length !== b.length ? ` (${a.length}/${b.length} byte)` : ''}`,
      );
  }
  const realSpans = callSpans(original);
  const ourSpans = callSpans(r.file);
  const realNets = networkBytes(f);
  const ourNets = networkBytes(g);
  const withCall = new Set(realSpans.map((s) => s.network));
  realNets.forEach((n, k) => {
    if (withCall.has(k + 1)) return;
    out.plainTotal++;
    if (hex(n) !== hex(ourNets[k] ?? [])) out.plainDiffer.push(k + 1);
  });
  realSpans.forEach((s, i) => {
    const o = ourSpans[i];
    out.calls.push({
      network: s.network,
      same: !!o && hex(o.bytes) === hex(s.bytes),
      real: hex(s.bytes),
      ...(o ? { ours: hex(o.bytes) } : {}),
    });
  });
  return out;
}

describe('blocchi reali ricompilati dal loro AWL decodificato (misura onesta del compilatore)', () => {
  const code = realBlocks().filter((b) => [0x08, 0x0c, 0x0e].includes(b.bytes[5]!));
  const results = code.map((b) => selfCompile(b.name, b.bytes));
  const report = results.map((r) => {
    const calls = r.calls.length
      ? `, CALL ${r.calls.filter((c) => c.same).length}/${r.calls.length} al byte`
      : '';
    const state = !r.file
      ? `NON COMPILATO: ${r.errors.map((e) => `${e.code} r${e.network}:${e.line}`).join(', ')}`
      : r.identical
        ? 'identico'
        : `diverso, timestamp esclusi: ${r.parts.join('; ') || 'nessuna differenza (solo il timestamp dell’interfaccia)'}`;
    return `${r.name}: ${state}; dati locali ${r.localData.compiled}/${r.localData.real}; reti senza CALL diverse ${r.plainDiffer.length}/${r.plainTotal}${calls}`;
  });
  console.log(`[compile] ricompilazione dei blocchi reali\n  ${report.join('\n  ')}`);
  for (const r of results) {
    for (const c of r.calls.filter((x) => !x.same)) {
      console.log(
        `[compile] ${r.name} rete ${c.network}: CALL diversa\n    reale ${c.real}\n    nostra ${c.ours}`,
      );
    }
  }

  it('ogni blocco reale di codice si compila, si decodifica e si ricodifica identico', () => {
    if (code.length < 10) console.warn(`[compile] blocchi di codice reali: ${code.length}/12`);
    for (const r of results) {
      expect(r.errors, r.name).toEqual([]);
      const b = decodeBlock(r.file!);
      expect(b.exact, r.name).toBe(true);
      expect(hex(encodeBlock(b)), r.name).toBe(hex(r.file!));
      expect(parseBlockFile(r.file!).warnings, r.name).toEqual([]);
    }
    // Le 20 CALL riprodotte al byte usano solo forme della tabella: l'unico avviso è la CALL FB
    // dell'OB1 TIA (forma «FB» senza esempio riprodotto al byte).
    const warned = results.flatMap((r) =>
      r.warnings.map((w) => `${r.name}:${w.network}:${w.code}:${w.params?.['forms']}`),
    );
    if (code.length >= 10) expect(warned).toEqual(['OB1:1:CALL_NON_VERIFICATO:FB']);
  });

  it('ogni rete senza CALL è identica al byte alla rete originale', () => {
    for (const r of results) {
      // FC100 rete 7: `UC FC [LW 16]` non ha sintassi AWL nel parser, sostituito da `UC FC 256`.
      const expected = r.indirect > 0 ? [7] : [];
      expect(r.plainDiffer, r.name).toEqual(expected);
    }
  });

  it('CALL reali (mc7 §2.5): espansioni riprodotte al byte', ({ skip }) => {
    const calls = results.flatMap((r) => r.calls.map((c) => ({ ...c, block: r.name })));
    if (code.length < 10) return skip();
    expect(calls).toHaveLength(20);
    const same = calls.filter((c) => c.same).length;
    console.log(`[compile] CALL reali riprodotte al byte: ${same}/${calls.length}`);
    // L'unica diversa è la CALL FB dell'OB1 TIA: base dei temporanei per rete (LD20/L24.0) e
    // costante REAL 80.0 caricata col tipo DINT (mc7 §2.3).
    expect(calls.filter((c) => !c.same).map((c) => `${c.block}:${c.network}`)).toEqual(['OB1:1']);
    // Le forme verificate della tabella hanno ciascuna un esempio reale riprodotto al byte.
    for (const form of CALL_FORMS) expect(form.evidence.length, form.key).toBeGreaterThan(0);
  });

  it('fuzz: 600 modifiche casuali ai sorgenti; mai INTERNAL, o un file decodificabile o errori senza file', ({
    skip,
  }) => {
    if (code.length === 0) return skip();
    let seed = 20261020;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
    const inputs = code.map((b) => selfInput(b.name, b.bytes).input);
    const pool = [
      ...new Set(inputs.flatMap((x) => x.networks.flatMap((n) => n.split('\n')))),
      '\tA "Sconosciuto";',
      '\tL P##TEMP0;',
      '\tCALL FC 999;',
      '\tCALL FC 96 (IN0 := MW 2);',
      '\tL L#70000;',
      '\tJU ZZZ1;',
      '\tT %DBW[AR2,P#9000.0];',
    ];
    let files = 0;
    let failed = 0;
    for (let k = 0; k < 600; k++) {
      const base = pick(inputs);
      const nets = [...base.networks];
      const n = Math.floor(rand() * nets.length);
      const lines = nets[n] === '' ? [] : nets[n]!.split('\n');
      const at = Math.floor(rand() * (lines.length + 1));
      const op = Math.floor(rand() * 3);
      if (op === 0 && lines.length) lines.splice(Math.min(at, lines.length - 1), 1);
      else if (op === 1) lines.splice(at, 0, pick(pool));
      else if (lines.length) lines[Math.min(at, lines.length - 1)] = pick(pool);
      nets[n] = lines.join('\n');
      const r = compileBlock({ ...base, networks: nets });
      expect(r.diagnostics.filter((d) => d.code === 'INTERNAL')).toEqual([]);
      if (r.file) {
        files++;
        expect(decodeBlock(r.file).exact).toBe(true);
      } else {
        failed++;
        expect(errors(r.diagnostics).length).toBeGreaterThan(0);
      }
    }
    console.log(`[compile] fuzz: ${files} file, ${failed} con errori`);
  });

  it('dati locali (mc7 §1.2, §6.3): valore calcolato = header dei blocchi reali', () => {
    const rows = results.map((r) => `${r.name} ${r.localData.compiled}/${r.localData.real}`);
    console.log(`[compile] dati locali calcolati/reali: ${rows.join(', ')}`);
    for (const r of results) expect(r.localData.compiled, r.name).toBe(r.localData.real);
  });
});
