import { describe, expect, it } from 'vitest';
import {
  S7WriteClient,
  memoryTransportPair,
  parseBlockFile,
  type TransportFactory,
} from '@baaportal/s7comm';
import { compileBlock, type CompileInput } from '@baaportal/mc7';
import { FakeCpu, serve } from '../src';

type Sections = CompileInput['sections'];
const el = (name: string) => ({ kind: 'elementary', name }) as never;
const EMPTY: Sections = { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] };
const NOW = new Date(2026, 9, 20, 10, 30, 15, 250);
const HEADER = { author: 'Diego', family: 'Prove', name: 'Blocco', version: '0.1' };

/** Contesto AWL minimo: nessun simbolo, nessun altro blocco; solo indirizzi assoluti. */
function ctx(kind: 'OB' | 'FB' | 'FC', s: Sections): CompileInput['ctx'] {
  return {
    owner: {
      kind,
      iface: {
        input: s.in,
        output: s.out,
        inOut: s.inOut,
        static: s.stat,
        temp: s.temp,
        returnType: { kind: 'void' },
      },
    },
    symbol: () => undefined,
    block: () => undefined,
    resolve: () => null,
    allSymbols: () => [],
    allBlocks: () => [],
  } as CompileInput['ctx'];
}

function compile(input: Partial<CompileInput> & Pick<CompileInput, 'kind' | 'number'>): Uint8Array {
  const r = compileBlock({
    now: NOW,
    header: HEADER,
    knowHowProtected: false,
    sections: EMPTY,
    initials: {},
    networks: [],
    ctx: ctx(input.kind === 'DB' || input.kind === 'IDB' ? 'FC' : input.kind, EMPTY),
    ...input,
  });
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.file).toBeDefined();
  return r.file!;
}

async function connect(cpu: FakeCpu, proposedPdu?: number): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return S7WriteClient.connect({
    host: 'finto',
    transport,
    timeoutMs: 3000,
    ...(proposedPdu ? { proposedPdu } : {}),
  });
}

const NETWORK = '\tA %I0.0;\n\tAN %I0.1;\n\t= %Q0.0;';

describe('giro completo compilatore → finto PLC → ritorno (scopo del 1D-bis)', () => {
  it('un FC compilato con mc7, caricato con downloadBlock e riletto con upload, è identico byte per byte', async () => {
    const file = compile({
      kind: 'FC',
      number: 7,
      networks: Array.from({ length: 200 }, () => NETWORK), // abbastanza grande da servire più fette
    });
    expect(file.length).toBeGreaterThan(1500);
    const cpu = new FakeCpu();
    const c = await connect(cpu);
    expect(c.pduLength).toBe(240);
    await c.downloadBlock(file);
    const back = await c.upload('FC', 7);
    expect(back).toEqual(file);
    expect(parseBlockFile(back).header).toMatchObject({ type: 'FC', number: 7 });
    expect((await c.blockInfo('FC', 7)).mc7Length).toBe(parseBlockFile(file).header.mc7Length);
    await c.close();
  });

  it('con PDU diverse (240, 480, 960) e blocchi di tipi diversi il ritorno resta identico', async () => {
    const dbSections: Sections = {
      ...EMPTY,
      stat: [
        { name: 'On', type: el('Bool') },
        { name: 'Num', type: el('Int') },
        { name: 'Kp', type: el('Real') },
        {
          name: 'Tab',
          type: { kind: 'array', dims: [{ lo: 0, hi: 199 }], element: el('Int') } as never,
        },
      ],
    };
    const blocks = [
      compile({ kind: 'OB', number: 1, networks: [NETWORK, NETWORK] }),
      compile({ kind: 'FC', number: 3, networks: Array.from({ length: 40 }, () => NETWORK) }),
      compile({
        kind: 'DB',
        number: 5,
        sections: dbSections,
        initials: { On: 'TRUE', Num: '7', Kp: '1.5' },
        ctx: ctx('FC', dbSections),
      }),
    ];
    for (const pdu of [240, 480, 960]) {
      const cpu = new FakeCpu();
      const c = await connect(cpu, pdu);
      for (const f of blocks) await c.downloadBlock(f);
      for (const f of blocks) {
        const h = parseBlockFile(f).header;
        expect(await c.upload(h.type!, h.number), `${h.type}${h.number} pdu ${pdu}`).toEqual(f);
      }
      await c.close();
    }
  });
});
