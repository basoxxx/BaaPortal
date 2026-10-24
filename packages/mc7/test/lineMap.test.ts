import type { AwlBlockInfo, AwlContext } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { compileBlock, decodeBlock, readBlockFile, type LineMapEntry } from '../src';

const IFACE = {
  input: [],
  output: [],
  inOut: [],
  static: [],
  temp: [],
  returnType: { kind: 'void' },
};
const INFOS = [{ name: 'FC2', kind: 'FC', number: 2, iface: IFACE }] as unknown as AwlBlockInfo[];

const ctx = {
  owner: { kind: 'FC', iface: IFACE },
  symbol: () => undefined,
  block: (r: { name: string } | { kind: string; number: number }) =>
    'name' in r
      ? INFOS.find((x) => x.name === r.name)
      : INFOS.find((x) => x.kind === r.kind && x.number === r.number),
  resolve: () => null,
  allSymbols: () => [],
  allBlocks: () => INFOS,
} as unknown as AwlContext;

function compile(networks: string[], codeMeta?: Parameters<typeof compileBlock>[0]['codeMeta']) {
  return compileBlock({
    ...(codeMeta ? { codeMeta } : {}),
    kind: 'FC',
    number: 1,
    now: new Date(2026, 9, 20),
    header: { author: 'T', family: 'Prove', name: 'Blocco', version: '0.1' },
    knowHowProtected: false,
    sections: { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] },
    initials: {},
    networks,
    ctx,
  });
}

describe('tabella delle righe', () => {
  // riga 0 commento, 1 vuota, 2 istruzione, 3 CALL, 4 etichetta+istruzione
  const NET0 = '// commento\n\n\tA M 0.0;\n\tCALL FC 2;\nfine:\tNOP 0;';
  const NET1 = '\tL 5;\n\tT MW 10;';

  it('lines di una rete con commento, etichetta, CALL espansa', () => {
    const r = compile([NET0, NET1]);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const lines = r.lines!;
    expect(lines).toBeDefined();
    const of0 = lines.filter((l) => l.network === 0);
    // A M 0.0 sulla riga 2; la CALL espansa (più istruzioni) sulla riga 3; NOP sulla riga 4
    expect(of0[0]).toMatchObject({ offset: 0, line: 2 });
    const call = of0.filter((l) => l.line === 3);
    expect(call.length).toBeGreaterThan(1);
    expect(of0.at(-1)!.line).toBe(4);
    expect(lines.filter((l) => l.network === 1).map((l) => l.line)).toEqual([0, 1]);
  });

  it('ogni byte del codice appartiene a una voce', () => {
    const r = compile([NET0, NET1]);
    const f = readBlockFile(r.file!);
    const lines = r.lines!;
    let pos = 0;
    for (const l of lines) {
      expect(l.offset).toBe(pos);
      expect(l.length).toBeGreaterThan(0);
      pos += l.length;
    }
    // il resto è la coda del codice (BE), senza riga
    expect(f.mc7.length - pos).toBe(2);
  });

  /** Le voci coprono il codice senza buchi né sovrapposizioni, rete per rete come l'ADD. */
  function expectTiling(r: ReturnType<typeof compile>, lines: LineMapEntry[]): void {
    const f = readBlockFile(r.file!);
    let pos = 0;
    for (const l of lines) {
      expect(l.offset).toBe(pos);
      pos += l.length;
    }
    expect(pos).toBe(f.add.networks.reduce((a, n) => a + n, 0));
    f.add.networks.forEach((n, k) => {
      expect(lines.filter((l) => l.network === k).reduce((a, l) => a + l.length, 0)).toBe(n);
    });
  }

  it('blocco importato (codeMeta) con una rete modificata: la mappa copre il codice', () => {
    const first = compile([NET0, NET1]);
    const d = decodeBlock(first.file!);
    const nets = [...d.networks!];
    nets[0] = `// modificata\n\n${nets[0]!}\n\tNOP 0;`;
    const r = compile(nets, d.meta.code);
    expect(r.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const lines = r.lines!;
    expectTiling(r, lines);
    const count = (k: number) => nets[k]!.split('\n').length;
    for (const l of lines) expect(l.line).toBeLessThan(count(l.network));
    // l'istruzione aggiunta in coda alla rete 0 è sull'ultima riga
    expect(lines.filter((l) => l.network === 0).at(-1)!.line).toBe(count(0) - 1);
  });

  it('salti J e JL tra reti: ogni salto ha la sua riga e la mappa copre il codice', () => {
    const net0 = '\tL MB 0;\n\tJL lst;\n\tJU a;\n\tJU b;\nlst:\tJU a;';
    const net1 = '// destinazioni\na:\tNOP 0;\nb:\tNOP 0;';
    const r = compile([net0, net1]);
    expect(r.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const lines = r.lines!;
    expectTiling(r, lines);
    expect(lines.filter((l) => l.network === 0).map((l) => l.line)).toEqual([0, 1, 2, 3, 4]);
    expect(lines.filter((l) => l.network === 1).map((l) => l.line)).toEqual([1, 2]);
  });
});
