import { formatNetwork, parseNetwork } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import {
  RAW_PLACEHOLDER,
  decodeCode,
  decodeInstruction,
  emptyAdd,
  encodeCode,
  readBlockFile,
  type DecodedCode,
  type Mc7Add,
} from '../src';
import { fromHex, hex, rebuild } from './decodeHelpers';
import { realBlocks } from './realBlocks';

const add = (networks: number[], jumps: number[] = [], rest: number[] = []): Mc7Add => ({
  networks,
  jumps,
  rest: Uint8Array.from(rest),
});

const formatted = (t: string): string => formatNetwork(t, 'international');

const parsesClean = (d: DecodedCode): void => {
  d.networks.forEach((t, k) => {
    const r = parseNetwork(t, 'international');
    expect(r.errors, `rete ${k}: ${t}`).toEqual([]);
    expect(t).not.toContain('\r');
  });
};

const roundTrip = (mc7: Uint8Array, a: Mc7Add, label = ''): DecodedCode => {
  const d = decodeCode(mc7, a);
  parsesClean(d);
  const r = rebuild(d);
  expect(hex(r.code), label).toBe(hex(mc7));
  expect(r.jumps, label).toEqual(a.jumps);
  return d;
};

const codeKinds = new Set(['OB', 'FC', 'FB', 'SFC', 'SFB']);
const codeBlocks = realBlocks()
  .map((b) => ({ b, f: readBlockFile(b.bytes) }))
  .filter(({ f }) => codeKinds.has(f.header.kind ?? '') && f.mc7.length > 0);

describe('OB1 reale (TIA, FUP): mc7 §5.2', () => {
  const ob1 = realBlocks().find((b) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name));
  it('reti e istruzioni come nell’appendice A, con le etichette generate', ({ skip }) => {
    if (!ob1) return skip();
    const f = readBlockFile(ob1.bytes);
    const d = decodeCode(f.mc7, f.add);
    const lines = (k: number): string[] => d.networks[k]!.split('\n');
    expect(d.networks).toHaveLength(5);
    // rete 1: 134 byte, tre JNB sulle etichette _016, _02a, _084 di §5.2
    expect(lines(0)).toEqual([
      '\tA(;',
      '\tA(;',
      '\tA %M0.1;',
      '\tJNB M001;', // 6 + 2*8 = 22
      '\tL %MW2;',
      '\tITD;',
      '\tT %MD4;',
      '\tSET;',
      '\tSAVE;',
      '\tCLR;',
      'M001:\tA BR;', // 22
      '\t);',
      '\tJNB M002;', // 42
      '\tL %MD4;',
      '\tDTR;',
      '\tT %MD8;',
      '\tSET;',
      '\tSAVE;',
      '\tCLR;',
      'M002:\tA BR;', // 42
      '\t);',
      '\tJNB M003;', // 132
      '\tBLD 3;',
      '\t= %L24.0;',
      '\tCDB;',
      '\tOPN %DI2;',
      '\tTAR2 %LD20;',
      '\tL %MD12;',
      '\tT %DID10;',
      '\tL %MD8;',
      '\tT %DID18;',
      '\tL L#1117782016;', // REAL 80.0 con byte di tipo DINT
      '\tT %DID48;',
      '\tL L#1117782016;',
      '\tT %DID56;',
      '\tLAR2 P#DBX 0.0;',
      '\tUC %FB1;',
      '\tLAR2 %LD20;',
      '\tL %DID72;',
      '\tT %MD16;',
      '\tL %DIW76;',
      '\tT %MW2;',
      '\tL %DID78;',
      '\tT %MD20;',
      '\tCDB;',
      '\tBLD 4;',
      'M003:\tNOP 0;', // 132
    ]);
    expect(lines(1)).toEqual([
      '\tA %M0.0;',
      '\t= %L20.0;',
      '\tBLD 103;',
      '\tBLD 9;',
      '\t= %L25.0;',
      '\tCDB;',
      '\tOPN %DI1;',
      '\tTAR2 %LD21;',
      '\tA %L20.0;',
      '\t= %DIX0.0;',
      '\tL 1000;',
      '\tT %DIW2;',
      '\tLAR2 P#DBX 0.0;',
      '\tUC %SFB0;',
      '\tLAR2 %LD21;',
      '\tL %DIW6;',
      '\tT %MW2;',
      '\tCDB;',
      '\tBLD 10;',
      '\tNOP 0;',
    ]);
    expect(lines(2)).toEqual(['\tA %M0.0;', '\tR %M0.0;']);
    expect(lines(3)).toEqual(['\tA %M120.0;', '\tA %M120.1;', '\tS %M120.2;']);
    expect(d.networks[4]).toBe(''); // rete vuota finale di TIA
    // nessun grezzo, nessun metadato: tutto è nel testo; il BE finale è la coda standard
    expect(d.meta).toEqual({
      raws: [],
      constantTypes: {},
      networkTexts: d.networks,
      networkLengths: f.add.networks,
    });
    parsesClean(d);
    expect(hex(rebuild(d).code)).toBe(hex(f.mc7));
  });
});

describe('blocchi di codice reali', () => {
  it('i 10 blocchi: 0 byte persi, tabella dei salti identica, salti su etichette valide', () => {
    if (codeBlocks.length < 10)
      console.warn(`[decode] solo ${codeBlocks.length} blocchi di codice`);
    const rows: string[] = [];
    let statements = 0;
    let rawTotal = 0;
    let pointerRaws = 0;
    let jumpRaws = 0;
    for (const { b, f } of codeBlocks) {
      const d = decodeCode(f.mc7, f.add);
      parsesClean(d);
      const r = rebuild(d);
      expect(hex(r.code), b.name).toBe(hex(f.mc7));
      expect(r.jumps, b.name).toEqual(f.add.jumps);
      expect(d.networks).toHaveLength(f.add.networks.length || 1);
      // ogni salto non grezzo cade su un'etichetta del blocco (anche di un'altra rete)
      const allDefined = new Set<string>();
      for (const t of d.networks) {
        for (const s of parseNetwork(t, 'international').statements) {
          if (s.label) allDefined.add(s.label.name);
        }
      }
      let labels = 0;
      let jumps = 0;
      let calls = 0;
      let n = 0;
      d.networks.forEach((t) => {
        const p = parseNetwork(t, 'international');
        const defined = new Set(p.statements.flatMap((s) => (s.label ? [s.label.name] : [])));
        labels += defined.size;
        for (const s of p.statements) {
          n++;
          if (s.operand?.kind === 'labelRef') {
            jumps++;
            expect(allDefined.has(s.operand.name), `${b.name}: ${s.operand.name}`).toBe(true);
          }
          if (
            s.instruction.def?.id === 'BLD' &&
            /^(1|3|7|9|14|16)$/.test(s.operand?.kind === 'constant' ? s.operand.text : '')
          )
            calls++;
        }
        for (const name of defined) expect(name).toMatch(/^M\d{3}$/);
      });
      // i grezzi sono solo quelli che il testo non può portare: liste di puntatori di UC/CC e
      // salti la cui destinazione non è un inizio di istruzione normale del blocco (nel mezzo di
      // un'istruzione, sul BE finale, fuori dal blocco o su un'istruzione a sua volta grezza)
      const bases: number[] = [];
      f.add.networks.reduce((a, len) => (bases.push(a), a + len), 0);
      const rawAt = new Set(d.meta.raws.map((r) => (bases[r.network] ?? 0) + r.offset));
      const plainStarts = new Set<number>();
      f.add.networks.forEach((len, k) => {
        for (let at = 0; at < len;) {
          const r = decodeInstruction(f.mc7.subarray(bases[k]!, bases[k]! + len), at);
          if (!rawAt.has(bases[k]! + at)) plainStarts.add(bases[k]! + at);
          at += Math.max(1, r.length);
        }
      });
      for (const raw of d.meta.raws) {
        const dec = decodeInstruction(fromHex(raw.bytes), 0);
        const stmt = 'stmt' in dec ? dec.stmt : undefined;
        if (stmt?.pointers !== undefined) {
          pointerRaws++;
          continue;
        }
        expect(stmt?.jumpTo, `${b.name}: grezzo inatteso ${raw.bytes}`).toBeDefined();
        const target = (bases[raw.network] ?? 0) + raw.offset + stmt!.jumpTo!;
        expect(plainStarts.has(target), `${b.name}: salto grezzo con bersaglio valido`).toBe(false);
        jumpRaws++;
      }
      statements += n;
      rawTotal += d.meta.raws.length;
      rows.push(
        `${b.name}: ${n} istruzioni, ${d.meta.raws.length} grezzi, ${labels} etichette, ` +
          `${jumps} salti, CALL espanse ${calls}/ricostruite 0`,
      );
    }
    console.log(
      `[decode] ${codeBlocks.length} blocchi, ${statements} istruzioni, ${rawTotal} grezzi\n  ${rows.join('\n  ')}`,
    );
    if (codeBlocks.length >= 10) {
      expect(codeBlocks).toHaveLength(10);
      // i salti tra reti di FC100 sono etichette: restano 16 grezzi (i blocchi protetti know-how
      // FB41 e FB80 non sono nel corpus). Qui si decodifica senza le interfacce dei chiamati; con
      // quelle i grezzi scendono (callRebuild.test.ts, Task 8b)
      expect(rawTotal).toBe(16);
      expect(pointerRaws + jumpRaws).toBe(16);
      expect({ pointerRaws, jumpRaws }).toEqual({ pointerRaws: 16, jumpRaws: 0 });
    }
  });

  // La rete tra salto e destinazione contiene un UC con puntatori (grezzo), quindi qui si
  // modifica la rete di destinazione (prima RAW_JUMP_ACROSS_CHANGED); la rete intermedia è nel
  // test sintetico qui sotto.
  it('FC100: modificare la rete di destinazione di un salto tra reti ora riesce', ({ skip }) => {
    let tried = 0;
    for (const name of ['FC100']) {
      const blk = codeBlocks.find(({ b }) => b.name === name);
      if (!blk) {
        console.warn(`[decode] ${name} assente`);
        continue;
      }
      const d = decodeCode(blk.f.mc7, blk.f.add);
      const parsed = d.networks.map((t) => parseNetwork(t, 'international'));
      const defs = parsed.map(
        (p) => new Set(p.statements.flatMap((s) => (s.label ? [s.label.name] : []))),
      );
      const hasRaw = new Set(d.meta.raws.map((r) => r.network));
      const rawBefore = d.meta.raws.length;
      parsed.forEach((p, k) => {
        for (const s of p.statements) {
          if (s.operand?.kind !== 'labelRef') continue;
          const label = s.operand.name;
          if (defs[k]!.has(label)) continue;
          const j = defs.findIndex((x) => x.has(label));
          expect(j, `${name}: etichetta ${label}`).toBeGreaterThanOrEqual(0);
          for (let m = Math.min(k, j); m <= Math.max(k, j); m++) {
            if (m === k || hasRaw.has(m) || d.networks[m] === '') continue;
            const nets = [...d.networks];
            nets[m] = `${nets[m]}\n\tA %M99.0;`;
            const r = encodeCode(nets, d.meta);
            expect(r.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
            const back = decodeCode(r.mc7, r.add);
            // tutte le reti tornano come sono (stesse etichette, salto e destinazione compresi)
            expect(back.networks).toEqual(nets.map(formatted));
            expect(back.meta.raws.length).toBe(rawBefore);
            tried++;
            return;
          }
        }
      });
    }
    if (!codeBlocks.some(({ b }) => b.name === 'FC100')) return skip();
    expect(tried).toBeGreaterThan(0);
  });

  it("FC100: l'ordine della tabella dei salti e FB101: il resto dell'ADD stanno nei metadati", ({
    skip,
  }) => {
    const fc100 = codeBlocks.find(({ b }) => b.name === 'FC100');
    const fb101 = codeBlocks.find(({ b }) => b.name === 'FB101');
    if (!fc100 || !fb101) return skip();
    const d = decodeCode(fc100.f.mc7, fc100.f.add);
    expect(d.meta.jumpOrder).toHaveLength(73);
    expect(d.meta.addJumps).toBeUndefined();
    const e = decodeCode(fb101.f.mc7, fb101.f.add);
    expect(e.meta.addRest).toBe('00 00 00 00 16 00 00 00 00 00 00 00');
    expect(e.meta.jumpOrder).toBeUndefined();
  });

  it('FC21: i parametri formali sono #PARn e il tipo originale è nei metadati', ({ skip }) => {
    const fc21 = codeBlocks.find(({ b }) => b.name === 'FC21');
    if (!fc21) return skip();
    const d = decodeCode(fc21.f.mc7, fc21.f.add);
    expect(d.networks.join('\n')).toMatch(/#PAR\d/);
    expect(Object.values(d.meta.formals ?? {}).sort()).toEqual(['Block_FB', 'Block_FC', 'Word']);
  });
});

describe('codice sintetico', () => {
  it('un opcode sconosciuto in mezzo a una rete: grezzo e il resto decodificato', () => {
    // A M0.0 ; fb ca 00 05 (4 byte, mai l'operando come istruzione) ; A M0.1 ; BE
    const code = fromHex('80 00 fb ca 00 05 81 00 65 00');
    const d = roundTrip(code, add([8]));
    expect(d.meta.raws).toEqual([{ network: 0, offset: 2, bytes: 'fb ca 00 05' }]);
    expect(d.networks[0]).toBe(`\tA %M0.0;\n\t${RAW_PLACEHOLDER}fb ca 00 05\n\tA %M0.1;`);
    expect(d.meta.tail).toBeUndefined(); // BE standard
  });

  it('opcode sconosciuti di ogni famiglia', () => {
    const cases = [
      'fb ca 00 05',
      'fb cb 12 34',
      'fb d9 00 02',
      'fb d1 00 02',
      'fb 3e 11 22',
      'fb 7d 12 34',
      '70 ff',
      'fe 3a 12 34',
      '0f 00',
      '68 ff',
      '60 ff',
      'ff 38 00 08',
    ];
    for (const c of cases) {
      const code = fromHex(`80 00 ${c} 81 00 65 00`);
      const d = roundTrip(code, add([code.length - 2]), c);
      expect(d.meta.raws.length, c).toBeGreaterThan(0);
      // le istruzioni attorno si decodificano
      expect(d.networks[0], c).toContain('A %M0.0;');
      expect(d.networks[0], c).toContain('A %M0.1;');
    }
  });

  it('salto nel mezzo di un’istruzione, fuori dal blocco o fuori rete: grezzo', () => {
    // JU +1 parola: nel mezzo di sé stesso; JU +0x100: fuori; A ; BE
    const a = roundTrip(fromHex('70 0b 00 01 70 0b 01 00 80 00 65 00'), add([8]));
    expect(a.meta.raws.map((r) => r.bytes)).toEqual(['70 0b 00 01', '70 0b 01 00']);
    expect(a.networks[0]).not.toMatch(/M\d/);
    // salto su un inizio di istruzione di un'altra rete: etichetta, non grezzo
    const b = roundTrip(fromHex('70 0b 00 03 80 00 80 00 65 00'), add([4, 2, 2]));
    expect(b.meta.raws).toEqual([]);
    expect(b.networks).toEqual(['\tJU M001;', '\tA %M0.0;', 'M001:\tA %M0.0;']);
    // salto alla fine dell'ultima rete (il BE): nessuna istruzione, resta grezzo
    const b2 = roundTrip(fromHex('70 0b 00 04 80 00 80 00 65 00'), add([4, 2, 2]));
    expect(b2.meta.raws).toHaveLength(1);
    // salto nel mezzo di un'istruzione di un'altra rete: resta grezzo
    const b3 = roundTrip(fromHex('70 0b 00 04 80 00 30 00 12 34 65 00'), add([4, 2, 4]));
    expect(b3.meta.raws).toHaveLength(1);
    // salto sul BE (fuori dalle reti)
    const c = roundTrip(fromHex('70 0b 00 02 65 00'), add([4]));
    expect(c.meta.raws).toHaveLength(1);
    // un salto verso un'istruzione che diventa grezza non ha dove mettere l'etichetta
    const d = roundTrip(fromHex('70 0b 00 02 fb ca 00 05 65 00'), add([8]));
    expect(d.meta.raws.map((r) => r.bytes)).toEqual(['70 0b 00 02', 'fb ca 00 05']);
  });

  it('rete modificata tra un salto tra reti e la sua destinazione: va bene, e si decodifica', () => {
    const code = fromHex('70 0b 00 03 80 00 81 00 65 00');
    const d = roundTrip(code, add([4, 2, 2]));
    expect(d.networks).toEqual(['\tJU M001;', '\tA %M0.0;', 'M001:\tA %M0.1;']);
    const nets = [d.networks[0]!, '\tA %M0.0;\n\tA %M0.5;', d.networks[2]!];
    const r = encodeCode(nets, d.meta);
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.mc7)).toBe(hex(fromHex('70 0b 00 04 80 00 85 00 81 00 65 00')));
    expect(decodeCode(r.mc7, r.add).networks).toEqual(nets);
  });

  it('etichette M001… in ordine di posizione su tutto il blocco; salti all’indietro; JL', () => {
    // rete 0: JU a 8 ; A ; A ; <8> NOP... ; rete 1: etichetta all'indietro
    const code = fromHex('70 0b 00 04 80 00 80 00 00 00 81 00 70 0b ff ff 65 00');
    const d = roundTrip(code, add([4 + 2 + 2 + 2, 2 + 4], [0, 6]));
    expect(d.networks[0]).toBe('\tJU M001;\n\tA %M0.0;\n\tA %M0.0;\nM001:\tNOP 0;');
    // 12..: rete 1 = A M0.1 ; JU -1 parola = a 12+... fuori (per sé stesso -2 byte): sul A
    expect(d.networks[1]).toBe('M002:\tA %M0.1;\n\tJU M002;'.replace('M002:\tA', 'M002:\tA'));
    // JL con due voci
    const jl = fromHex('70 09 00 02 70 0b 00 04 70 0b 00 02 80 00 65 00');
    const e = roundTrip(jl, add([14], [0, 2, 4]));
    expect(e.networks[0]).toBe('\tJL M001;\n\tJU M001;\n\tJU M001;\nM001:\tA %M0.0;');
  });

  it('una costante con byte di tipo che il testo non porta va in constantTypes', () => {
    const code = fromHex('30 00 12 34 30 07 12 34 38 03 00 00 00 05 65 00');
    const d = roundTrip(code, add([14]));
    expect(Object.keys(d.meta.constantTypes).length).toBeGreaterThan(0);
  });

  it('forma non canonica e UC con puntatori: grezzi con il testo migliore in commento', () => {
    // A M0.0 in forma lunga (00 60 ... no: 4 byte `00 01 00 00 00 00`?) e UC FC 96 con un puntatore
    const nonCanon = fromHex('7e 56 00 02 80 00'); // T DIW 2 + A (forma canonica, per confronto)
    roundTrip(nonCanon, add([6]));
    const uc = fromHex('3d 60 70 0b 00 04 87 00 00 08 80 00 65 00');
    const d = roundTrip(uc, add([12]));
    expect(d.meta.raws).toEqual([
      { network: 0, offset: 0, bytes: '3d 60 70 0b 00 04 87 00 00 08' },
    ]);
    expect(d.networks[0]).toBe(
      `\t${RAW_PLACEHOLDER}3d 60 70 0b 00 04 87 00 00 08\n\t// MC7 testo: UC FC96\n\tA %M0.0;`.replace(
        'UC FC96',
        'UC %FC96',
      ),
    );
    // senza puntatori il testo basta
    const d0 = roundTrip(fromHex('3d 60 70 0b 00 02 65 00'), add([6]));
    expect(d0.meta.raws).toEqual([]);
  });

  it('senza ADD (nessuna rete) tutto il codice è una rete; reti vuote restano vuote', () => {
    const code = fromHex('80 00 65 00');
    const d = decodeCode(code, emptyAdd());
    expect(d.networks).toEqual(['\tA %M0.0;\n\tBE;']);
    expect(d.meta.tail).toBe('');
    expect(hex(rebuild(d).code)).toBe(hex(code));
    const e = roundTrip(code, add([0, 2, 0]));
    expect(e.networks).toEqual(['', '\tA %M0.0;', '']);
    const none = decodeCode(new Uint8Array(0), emptyAdd());
    expect(none.networks).toEqual(['']);
  });

  it('coda diversa dal BE e reti più lunghe del codice', () => {
    const d = roundTrip(fromHex('80 00 12 34 56'), add([2]));
    expect(d.meta.tail).toBe('12 34 56');
    const e = roundTrip(fromHex('80 00 81 00'), add([100, 3]));
    expect(e.networks).toHaveLength(1);
  });

  it('un salto che l’ADD non elenca: addJumps conserva la tabella letterale', () => {
    const d = roundTrip(fromHex('70 0b 00 02 80 00 65 00'), add([6], [7, 9]));
    expect(d.meta.addJumps).toEqual([7, 9]);
    const e = roundTrip(fromHex('70 0b 00 02 80 00 65 00'), add([6], []));
    expect(e.meta.addJumps).toEqual([]);
  });

  it('il segnaposto grezzo è solo commento: parseNetwork lo accetta e non dà istruzioni', () => {
    const d = decodeCode(fromHex('fb ca 00 05 65 00'), add([4]));
    const r = parseNetwork(d.networks[0]!, 'international');
    expect(r.errors).toEqual([]);
    expect(r.statements).toHaveLength(0);
  });
});

describe('fuzz', () => {
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const PIECES = [
    '80 00',
    '81 78',
    'ba 00',
    'bf 00',
    '68 1d',
    '65 00',
    '00 00',
    '12 02',
    '1b 04',
    '30 03 03 e8',
    '38 03 42 a0 00 00',
    '7e 57 00 0a',
    'fb 7c',
    '10 03',
    'fe 6f 00 14',
    '3d 60 70 0b 00 04 87 00 00 08',
    '3d 61 70 0b 00 02',
    'fb 70 01 00 70 0b 00 02',
    'fb ca 00 05',
    'fb d9 00 02',
    'fb 60 00 04 70 0b 00 02',
    'fb c2 00 04',
    'fb d0 00 02 70 0b 00 02',
    '70 09 00 01',
    '70 08 ff fe',
    '70 ff',
    'ff 98 00 02',
    'ff 80 ff fe',
  ];

  it('2000 sezioni MC7 casuali con ADD casuali: nessun errore, byte identici', () => {
    const rand = rng(0xb44);
    const ri = (n: number): number => Math.floor(rand() * n);
    for (let i = 0; i < 2000; i++) {
      const bytes: number[] = [];
      const pieces = ri(40);
      for (let p = 0; p < pieces; p++) {
        const r = rand();
        if (r < 0.55) bytes.push(...fromHex(PIECES[ri(PIECES.length)]!));
        else if (r < 0.7) {
          // salto con spostamento casuale, spesso dentro il blocco
          const op = [0x0b, 0x08, 0x09][ri(3)]!;
          const j = ri(24) - 6;
          bytes.push(0x70, op, (j >> 8) & 255, j & 255);
        } else if (r < 0.8) {
          const j = ri(24) - 6;
          bytes.push(0xff, [0x98, 0x80, 0x90, 0xa8][ri(4)]!, (j >> 8) & 255, j & 255);
        } else for (let k = ri(5); k >= 0; k--) bytes.push(ri(256));
      }
      const mc7 = Uint8Array.from(bytes);
      const nets: number[] = [];
      let left = mc7.length + (rand() < 0.1 ? ri(10) : 0);
      const kind = ri(4);
      if (kind > 0) {
        while (left > 0 && nets.length < 8) {
          const n = ri(left + 1);
          nets.push(n);
          left -= n;
        }
      }
      const jumps = Array.from({ length: ri(6) }, () => ri(Math.max(1, mc7.length / 2 + 2)));
      const rest = Array.from({ length: rand() < 0.2 ? ri(5) : 0 }, () => ri(256));
      const a = add(nets, jumps, rest);
      let d: DecodedCode;
      try {
        d = decodeCode(mc7, a);
      } catch (e) {
        throw new Error(`#${i}: ${hex(mc7)} ${JSON.stringify(a)}: ${String(e)}`);
      }
      parsesClean(d);
      const r = rebuild(d);
      expect(hex(r.code), `#${i}`).toBe(hex(mc7));
      expect(r.jumps, `#${i}`).toEqual(jumps);
      expect(d.meta.addRest ?? '', `#${i}`).toBe(hex(rest));
    }
  });
});
