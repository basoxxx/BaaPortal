import { formatNetwork, type AwlBlockInfo } from '@baaportal/awl';
import { findSystemBlock } from '@baaportal/catalog';
import { parseType, type DataType, type TypedMember } from '@baaportal/s7-types';
import { describe, expect, it } from 'vitest';
import {
  compileBlock,
  decodeBlock,
  decodeCode,
  encodeBlock,
  readBlockFile,
  readSsb,
  sectionsFromSsb,
  type CalleeInterface,
  type CompileInput,
  type Mc7Block,
} from '../src';
import {
  callSpans,
  calledBlocks,
  emptySections,
  hex,
  interfaceInput,
  networkBytes,
  selfContext,
  toAwlIface,
  type Sections,
} from './compileHelpers';
import { realBlocks, type RealBlock } from './realBlocks';

/**
 * Task 8b: le CALL si ricostruiscono nella decodifica (UC + lista dei puntatori, o la sequenza
 * BLD … BLD espansa) quando l'interfaccia del chiamato è nota, e solo se l'espansione del
 * compilatore ridà i byte originali.
 */

type Kind = 'FC' | 'FB' | 'SFC' | 'SFB';
type Resolve = (kind: Kind, number: number) => CalleeInterface | undefined;

const codeBlocks = realBlocks().flatMap((b) => {
  const f = readBlockFile(b.bytes);
  const k = f.header.kind;
  return k === 'OB' || k === 'FB' || k === 'FC' ? [{ b, f }] : [];
});
const shortName = (b: RealBlock): string => b.name.split(' ')[0]!;

function catalog(kind: 'SFC' | 'SFB', number: number): CalleeInterface | undefined {
  const s = findSystemBlock({ kind, number });
  if (!s) return undefined;
  const ret = s.returnType === undefined ? undefined : parseType(s.returnType);
  return {
    sections: emptySections({
      in: s.input,
      out: s.output,
      inOut: s.inOut,
      stat: s.static ?? [],
      ret: ret?.ok ? [{ name: 'RET_VAL', type: ret.type }] : [],
    }),
  };
}

/** Interfacce decodificate degli altri blocchi reali (FC, FB) e catalogo (SFC, SFB). */
function fromOthers(self: RealBlock): Resolve {
  const map = new Map<string, CalleeInterface>();
  for (const { b, f } of codeBlocks) {
    const k = f.header.kind;
    if (b === self || (k !== 'FC' && k !== 'FB')) continue;
    const key = `${k}${f.header.number}`;
    if (map.has(key)) continue;
    try {
      map.set(key, { sections: sectionsFromSsb(readSsb(f.ssb, k)).sections });
    } catch {
      /* interfaccia con tipi grezzi: chiamato sconosciuto */
    }
  }
  return (kind, n) =>
    kind === 'SFC' || kind === 'SFB' ? catalog(kind, n) : map.get(`${kind}${n}`);
}

const el = (name: string): DataType => ({ kind: 'elementary', name }) as DataType;
const m = (name: string, type: DataType): TypedMember => ({ name, type });
const bytes = (n: number): DataType => ({
  kind: 'array',
  dims: [{ lo: 0, hi: n - 1 }],
  element: el('Byte'),
});
const fc = (...ins: string[]): CalleeInterface => ({
  sections: emptySections({ in: ins.map((t, i) => m(`IN${i}`, el(t))) }),
});

/** Interfacce dedotte dai punti di chiamata reali (come i sorgenti CALL del Task 7). */
const DEDUCED: Record<string, CalleeInterface> = {
  FC96: fc('Int'),
  FC94: fc('Bool'),
  FC97: fc('Bool'),
  FC16: fc('DInt'),
  FC21: fc('DInt'),
  FC45: fc(),
  FC95: fc('Int'),
  FC91: fc(),
  FC13: fc('DInt', 'DInt', 'DInt', 'DInt', 'DInt'),
  FC100: fc('Int'),
  FC20: fc(),
  FC19: fc(),
  // ingressi a DID10, 18, 48, 56 e uscite a DID72, DIW76, DID78 come nell'OB1 reale
  FB1: {
    sections: emptySections({
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
  },
};
const deduced: Resolve = (kind, n) =>
  kind === 'SFC' || kind === 'SFB' ? catalog(kind, n) : DEDUCED[`${kind}${n}`];

const CALL_LINE = /^(?:\w+:)?\tCALL\b/gm;
const HAS_CALL = /^(?:\w+:)?\tCALL\b/m;
const callsOf = (d: Mc7Block): number =>
  (d.networks ?? []).join('\n').match(CALL_LINE)?.length ?? 0;
const rawsOf = (d: Mc7Block): number => d.meta.code?.raws.length ?? 0;

/**
 * Ricompila il blocco decodificato con la rete `k` forzata nel percorso di compilazione normale
 * (metadati della rete diversi dal testo): controllo AWL, simboli, espansione delle CALL. Le altre
 * reti restano invariate. Restituisce i byte di ogni rete o le diagnostiche.
 */
function recompile(d: Mc7Block, resolve: Resolve, k: number): string[] | string {
  const kind = d.kind as 'OB' | 'FB' | 'FC';
  const { sections, initials, fbTypes } = interfaceInput(d.iface, kind);
  const nets = d.networks!;
  const infos: AwlBlockInfo[] = [];
  for (const t of nets) {
    for (const c of t.matchAll(/\tCALL %(FC|FB|SFC|SFB)(\d+)(?:, %DB(\d+))?/g)) {
      const ck = c[1] as Kind;
      const ci = resolve(ck, Number(c[2]))!;
      const name = `${ck}${c[2]}`;
      infos.push({ name, kind: ck, number: Number(c[2]), iface: toAwlIface(ci.sections) });
      if (c[3])
        infos.push({ name: `DB${c[3]}`, kind: 'IDB', number: Number(c[3]), instanceOf: name });
    }
  }
  const meta = d.meta.code!;
  const input: CompileInput = {
    kind,
    number: d.number,
    knowHowProtected: d.knowHowProtected,
    header: d.header,
    sections: sections as Sections,
    initials,
    networks: nets,
    ctx: selfContext(kind, sections, [...infos, ...calledBlocks(nets)], fbTypes),
    now: new Date(2026, 0, 1),
    codeMeta: {
      ...meta,
      networkTexts: meta.networkTexts.map((t, j) => (j === k ? `${t}\n\t// forzata` : t)),
    },
  };
  const r = compileBlock(input);
  if (!r.file) return r.diagnostics.map((x) => `${x.code}: ${x.message}`).join('\n');
  return networkBytes(readBlockFile(r.file)).map((b) => hex(b));
}

interface Outcome {
  calls: number;
  raws: number;
  rawsBefore: number;
}

/** Decodifica con `resolve` e tutte le verifiche: giro esatto, byte delle CALL, ricompilazione. */
function check(b: RealBlock, resolve: Resolve): Outcome {
  const plain = decodeBlock(b.bytes);
  const d = decodeBlock(b.bytes, { resolveCallee: resolve });
  expect(d.exact, b.name).toBe(true);
  expect(hex(encodeBlock(d)), `${b.name}: giro del blocco intero`).toBe(hex(b.bytes));
  // Senza grezzi in più, e le CALL ricostruite tengono esattamente i byte di un'espansione reale
  const spans = callSpans(b.bytes).map((s) => `${s.network - 1}:${hex(s.bytes)}`);
  const stored = Object.entries(d.meta.code?.calls ?? {}).map(
    ([key, h]) => `${key.split(':')[0]}:${h}`,
  );
  for (const s of stored)
    expect(spans, `${b.name}: CALL ricostruita = espansione reale`).toContain(s);
  expect(stored).toHaveLength(callsOf(d));
  // Ogni rete con una CALL ricostruita, ricompilata dal testo, ridà gli stessi byte
  const original = networkBytes(readBlockFile(b.bytes)).map((x) => hex(x));
  d.networks!.forEach((t, k) => {
    if (!HAS_CALL.test(t)) return;
    const r = recompile(d, resolve, k);
    expect(typeof r === 'string' ? r : r[k], `${b.name} rete ${k + 1} ricompilata`).toBe(
      original[k],
    );
  });
  return { calls: callsOf(d), raws: rawsOf(d), rawsBefore: rawsOf(plain) };
}

describe('CALL ricostruite nella decodifica (Task 8b)', () => {
  it('interfacce degli altri blocchi reali e del catalogo: 3 grezzi su 16 diventano CALL, più la CALL SFB 0 di OB1', () => {
    if (codeBlocks.length < 10) console.warn(`[callRebuild] solo ${codeBlocks.length} blocchi`);
    const rows: string[] = [];
    const calls: Record<string, number> = {};
    let raws = 0;
    let rawsBefore = 0;
    for (const { b } of codeBlocks) {
      const o = check(b, fromOthers(b));
      if (o.calls) calls[shortName(b)] = o.calls;
      raws += o.raws;
      rawsBefore += o.rawsBefore;
      rows.push(`${b.name}: CALL ${o.calls}, grezzi ${o.rawsBefore} → ${o.raws}`);
    }
    console.log(`[callRebuild] altri blocchi + catalogo\n  ${rows.join('\n  ')}`);
    if (codeBlocks.length >= 10) {
      // FB101 → FC100 (reale); FC100 → SFC 20 ×2 (catalogo); OB1 TIA → SFB 0 (catalogo, già espansa)
      expect(calls).toEqual({ FB101: 1, FC100: 2, OB1: 1 });
      expect(rawsBefore).toBe(16);
      expect(raws).toBe(13);
    }
  });

  it('interfacce dedotte dai punti di chiamata: 14 grezzi su 16 diventano CALL; FB 1 di OB1 resta espansa', () => {
    const rows: string[] = [];
    const calls: Record<string, number> = {};
    let raws = 0;
    for (const { b } of codeBlocks) {
      const o = check(b, deduced);
      if (o.calls) calls[shortName(b)] = o.calls;
      raws += o.raws;
      rows.push(`${b.name}: CALL ${o.calls}, grezzi ${o.rawsBefore} → ${o.raws}`);
    }
    console.log(`[callRebuild] interfacce dedotte\n  ${rows.join('\n  ')}`);
    if (codeBlocks.length >= 10) {
      expect(calls).toEqual({ FC1: 9, FC21: 2, FC100: 6, FB101: 1, OB1: 1 });
      // restano i due UC FC [LW 16] di FC100 (numero indiretto: nessuna CALL in AWL)
      expect(raws).toBe(2);
      const ob1 = codeBlocks.find(({ b }) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name))!;
      const d = decodeBlock(ob1.b.bytes, { resolveCallee: deduced });
      // TIA calcola la base dei temporanei per rete (LD20), il compilatore per blocco (LD21)
      expect(d.networks![0]).toContain('\tUC %FB1;');
      expect(d.networks![1]).toContain('CALL %SFB0, %DB1');
    }
  });

  it('testo delle CALL ricostruite: costanti, temporanei per nome, ANY costante, DB qualificati', ({
    skip,
  }) => {
    const find = (n: string) => codeBlocks.find(({ b }) => b.name === n);
    const fb101 = find('FB101');
    const fc100 = find('FC100');
    if (!fb101 || !fc100) return skip();
    const a = decodeBlock(fb101.b.bytes, { resolveCallee: deduced });
    expect(a.networks![2]).toBe(formatNetwork('\tCALL %FC100 (IN0 := 1);', 'international'));
    const c = decodeBlock(fc100.b.bytes, { resolveCallee: deduced });
    expect(c.networks![1]).toContain(
      formatNetwork(
        '\tCALL %SFC20 (SRCBLK := #TEMP24, RET_VAL => %LW34, DSTBLK => P#DB100.DBX 0.0 BYTE 400);',
        'international',
      ),
    );
    expect(c.networks![1]).toContain(formatNetwork('\tCALL %FC91;', 'international'));
    expect(c.networks![5]).toContain(
      formatNetwork('\tCALL %FC95 (IN0 := %LW22);', 'international'),
    );
    expect(c.networks![5]).toContain(formatNetwork('\tCALL %FC94 (IN0 := TRUE);', 'international'));
  });

  it('chiamato sconosciuto o interfaccia diversa: nulla cambia', () => {
    for (const { b, f } of codeBlocks) {
      const plain = decodeCode(f.mc7, f.add);
      const none = decodeBlock(b.bytes, { resolveCallee: () => undefined });
      expect(none.networks, b.name).toEqual(plain.networks);
      // decodeBlock aggiunge i dati locali dell'header (regola F, compile.ts)
      expect(none.meta.code, b.name).toEqual({
        ...plain.meta,
        localData: f.header.localDataLength,
      });
      // un risolutore che lancia vale "chiamato sconosciuto": il blocco resta esatto
      const broken = decodeBlock(b.bytes, {
        resolveCallee: () => {
          throw new Error('rotto');
        },
      });
      expect(broken.exact, b.name).toBe(true);
      expect(broken.networks, b.name).toEqual(plain.networks);
    }
    // FC1 chiama FC 21 con un DINT: l'FC21 reale ha tre parametri, la lista ha un puntatore
    const fc1 = codeBlocks.find(({ b }) => b.name === 'FC1');
    if (!fc1) return;
    const d = decodeBlock(fc1.b.bytes, { resolveCallee: fromOthers(fc1.b) });
    expect(d.networks!.join('\n')).not.toMatch(HAS_CALL);
  });
});

// ---------------------------------------------------------------------------------------------
// Blocchi compilati dal progetto: CALL di FB con DB, multi-istanza, ogni classe di parametro di FC

const par = (name: string): DataType => ({ kind: 'parameter', name }) as DataType;
const nastro = emptySections({
  in: [m('Vel', el('Int')), m('Abil', el('Bool'))],
  out: [m('Ok', el('Bool'))],
  inOut: [m('Conta', el('DInt'))],
  stat: [m('Cnt', el('Int'))],
});
const tutti = emptySections({
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
});
const synth: Resolve = (kind, n) =>
  kind === 'FB' && n === 2
    ? { sections: nastro }
    : kind === 'FC' && n === 11
      ? { sections: tutti }
      : undefined;

describe('CALL compilate dal progetto e ricostruite', () => {
  const owner = emptySections({
    in: [m('Start', el('Bool'))],
    stat: [m('Sub', { kind: 'named', name: 'FB2' }), m('Tot', el('Int'))],
    temp: [m('Tmp', el('DInt'))],
  });
  const blocks: AwlBlockInfo[] = [
    { name: 'FB2', kind: 'FB', number: 2, iface: toAwlIface(nastro) },
    { name: 'DB3', kind: 'IDB', number: 3, instanceOf: 'FB2' },
    { name: 'FC11', kind: 'FC', number: 11, iface: toAwlIface(tutti) },
    { name: 'DB1', kind: 'DB', number: 1, dbMembers: [m('X', bytes(20))] },
  ];
  const fbTypes = new Map<string, Sections>([['FB2', nastro]]);
  const sources = [
    '\tA %M0.0;\n\tCALL %FB2, %DB3 (Vel := %MW10, Abil := TRUE, Ok => %Q4.1, Conta := %MD20);',
    '\tA %M0.1;\n\tCALL #Sub (Vel := 5, Abil := %M1.0, Ok => %M1.1);',
    '\tCALL %FC11 (a := %I0.0, t := %T5, blk := %DB1, any := P#DB1.DBX 8.0 INT 4, p := P#M 10.0, RET_VAL => %MW40, o => %DB1.DBW4, io := %LD0);',
    '\tA %M0.2;\n\tCALL %FC11 (a := FALSE, t := %T6, blk := %DB1, any := P#M 0.0 BYTE 2, p := P#DB1.DBX 2.0, RET_VAL => %LW4, o => %MW2, io := %DB1.DBD8);',
    // dati d'istanza del chiamante: tornano coi nomi generati (Start = IN0, Tot = STAT1)
    '\tA %M0.3;\n\tCALL %FC11 (a := #Start, t := %T7, blk := %DB1, any := P#M 4.0 BYTE 1, p := P#M 0.0, RET_VAL => %MW50, o => #Tot, io := %MD60);',
  ];
  const r = compileBlock({
    kind: 'FB',
    number: 10,
    knowHowProtected: false,
    header: { author: 'Diego', family: 'Prove', name: 'Linea', version: '0.1' },
    sections: owner,
    initials: {},
    networks: sources,
    ctx: selfContext('FB', owner, blocks, fbTypes),
    now: new Date(2026, 9, 20, 10, 30),
  });

  it('decodifica con le interfacce: ogni CALL torna come nel sorgente (multi-istanza col nome generato)', () => {
    expect(r.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const d = decodeBlock(r.file!, { resolveCallee: synth });
    expect(d.exact).toBe(true);
    expect(hex(encodeBlock(d))).toBe(hex(r.file!));
    const expected = sources.map((s) =>
      s.replace('#Sub', '#STAT0').replace('#Start', '#IN0').replace('#Tot', '#STAT1'),
    );
    // A %M0.0 / A %M0.1 / A %M0.2 restano come sono; le CALL tornano con lo stesso testo canonico
    expect(d.networks).toEqual(expected.map((s) => formatNetwork(s, 'international')));
    expect(d.meta.code!.raws).toEqual([]);
    // Senza interfacce resta la forma espansa (con grezzi per le liste dei puntatori)
    const plain = decodeBlock(r.file!);
    expect(plain.networks!.join('\n')).not.toMatch(HAS_CALL);
    expect(plain.meta.code!.raws).toHaveLength(3);
  });

  it('FC che passa i propri parametri formali: tornano come #PARn (IN, RET_VAL, OUT, IN_OUT)', () => {
    const fcSections = emptySections({
      in: [m('x', el('Bool')), m('n', el('Int'))],
      out: [m('y', el('Int'))],
      inOut: [m('acc', el('DInt'))],
      ret: [m('RET_VAL', el('Int'))],
    });
    const nets = [
      '\tA %M0.0;\n\tCALL %FC11 (a := #x, t := %T1, blk := %DB1, any := P#M 0.0 BYTE 1, p := P#M 0.0, RET_VAL => #RET_VAL, o => #y, io := #acc);',
    ];
    const f = compileBlock({
      kind: 'FC',
      number: 12,
      knowHowProtected: false,
      header: { author: 'Diego', family: 'Prove', name: 'Usa', version: '0.1' },
      sections: fcSections,
      initials: {},
      networks: nets,
      ctx: selfContext('FC', fcSections, blocks, fbTypes),
      now: new Date(2026, 9, 20, 10, 30),
    });
    expect(f.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const d = decodeBlock(f.file!, { resolveCallee: synth });
    expect(hex(encodeBlock(d))).toBe(hex(f.file!));
    // posizioni nella lista dei puntatori: x 0, n 1, RET_VAL 2, y 3, acc 4
    expect(d.networks).toEqual([
      formatNetwork(
        nets[0]!
          .replace('#x', '#PAR0')
          .replace('#RET_VAL', '#PAR2')
          .replace('#y', '#PAR3')
          .replace('#acc', '#PAR4'),
        'international',
      ),
    ]);
  });

  it('una rete con CALL ricostruita, modificata altrove, ricompila la CALL agli stessi byte', () => {
    const d = decodeBlock(r.file!, { resolveCallee: synth });
    const nets = [...d.networks!];
    nets[0] = nets[0]!.replace('A %M0.0', 'AN %M0.0');
    nets[3] = `${nets[3]}\n\tNOP 0;`;
    const again = compileBlock({
      kind: 'FB',
      number: 10,
      knowHowProtected: false,
      header: { author: 'Diego', family: 'Prove', name: 'Linea', version: '0.1' },
      sections: owner,
      initials: {},
      networks: nets,
      ctx: selfContext('FB', owner, blocks, fbTypes),
      now: new Date(2026, 9, 20, 10, 30),
      codeMeta: d.meta.code!,
    });
    expect(again.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const back = decodeBlock(again.file!, { resolveCallee: synth });
    expect(back.networks).toEqual(nets.map((t) => formatNetwork(t, 'international')));
    const before = callSpans(r.file!).map((s) => hex(s.bytes));
    const after = callSpans(again.file!).map((s) => hex(s.bytes));
    expect(after).toEqual(before);
  });
});
