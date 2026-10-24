import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileBlock } from '@baaportal/mc7';
import type { AwlContext } from '@baaportal/awl';
import {
  OPS,
  SimCpu,
  connectToSim,
  stwToWord,
  type OpHandler,
  type Registers,
  type SimCpuOptions,
} from '../src';
import { EMPTY, buildFiles, el, instanceDbFile, m, named, type BlockSpec } from './programHelpers';

/**
 * Esecuzione dei programmi di prova in `test/battery/*.awl`: ogni file è compilato con mc7, caricato
 * in una CPU simulata con lo stesso percorso del PLC (downloadBlock), eseguito per un ciclo e
 * confrontato con i valori attesi scritti nel suo commento di testa.
 *
 * Formato di un file:
 *   // atteso: MW10=300, MD20=16#FF, STW=16#0006      (una o più righe)
 *   // imposta: MB0=5, M10.1=1                        (valori prima del ciclo)
 *   // errore: CODICE                                 (il ciclo deve fallire con questo codice)
 *   //@ block OB 1 | FC n | FB n                      (inizio di un blocco)
 *   //@ in|out|inout|stat|temp NOME TIPO              (interfaccia del blocco)
 *   //@ db N nome:Tipo nome:Tipo                      (DB globale)
 *   //@ idb N FBm                                     (DB di istanza di FBm)
 *   //@ network                                       (inizio di una nuova rete)
 */

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
};

const BATTERY_DIR = join(__dirname, 'battery');

export function batteryFiles(): string[] {
  return readdirSync(BATTERY_DIR)
    .filter((f) => f.endsWith('.awl'))
    .sort();
}

// --- strumentazione: quali id sono eseguiti e lo stato finale dell'OB ---------------------------

interface Probe {
  executed: Set<string>;
  regs: Registers | null;
}
let probe: Probe = { executed: new Set(), regs: null };
let instrumented = false;

function instrument(): void {
  if (instrumented) return;
  instrumented = true;
  for (const id of Object.keys(OPS)) {
    const orig: OpHandler = OPS[id]!;
    OPS[id] = (st, stmt) => {
      probe.executed.add(id);
      if (st.depth === 0) probe.regs = st.regs;
      return orig(st, stmt);
    };
  }
}

// --- lettura del file --------------------------------------------------------------------------

interface DbSpec {
  number: number;
  members: { name: string; type: string }[];
}
interface Parsed {
  expected: string[];
  setup: string[];
  error?: string;
  blocks: BlockSpec[];
  dbs: DbSpec[];
  idbs: { db: number; fb: number }[];
}

const memberType = (t: string) => (/^FB\d+$/i.test(t) ? named(t.toUpperCase()) : el(t));

export function parseProgram(text: string): Parsed {
  const out: Parsed = { expected: [], setup: [], blocks: [], dbs: [], idbs: [] };
  let cur: { spec: BlockSpec; nets: string[][] } | null = null;
  const finish = () => {
    if (cur) cur.spec.networks = cur.nets.map((n) => n.join('\n')).filter((n) => n.trim() !== '');
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let mt: RegExpMatchArray | null;
    if ((mt = line.match(/^\/\/\s*atteso:\s*(.*)$/))) out.expected.push(...items(mt[1]!));
    else if ((mt = line.match(/^\/\/\s*imposta:\s*(.*)$/))) out.setup.push(...items(mt[1]!));
    else if ((mt = line.match(/^\/\/\s*errore:\s*(\S+)/))) out.error = mt[1]!;
    else if ((mt = line.match(/^\/\/@\s*block\s+(OB|FB|FC)\s+(\d+)\s*$/))) {
      finish();
      const spec: BlockSpec = {
        kind: mt[1] as BlockSpec['kind'],
        number: Number(mt[2]),
        sections: { ...EMPTY, in: [], out: [], inOut: [], stat: [], temp: [] },
        networks: [],
      };
      out.blocks.push(spec);
      cur = { spec, nets: [[]] };
    } else if ((mt = line.match(/^\/\/@\s*(in|out|inout|stat|temp)\s+(\S+)\s+(\S+)\s*$/))) {
      if (!cur) throw new Error(`interfaccia fuori da un blocco: ${line}`);
      const key = mt[1] === 'inout' ? 'inOut' : (mt[1] as 'in' | 'out' | 'stat' | 'temp');
      cur.spec.sections![key].push(m(mt[2]!, memberType(mt[3]!)));
    } else if ((mt = line.match(/^\/\/@\s*db\s+(\d+)\s+(.*)$/))) {
      out.dbs.push({
        number: Number(mt[1]),
        members: mt[2]!
          .trim()
          .split(/\s+/)
          .map((x) => {
            const [name, type] = x.split(':');
            return { name: name!, type: type! };
          }),
      });
    } else if ((mt = line.match(/^\/\/@\s*idb\s+(\d+)\s+FB(\d+)\s*$/)))
      out.idbs.push({ db: Number(mt[1]), fb: Number(mt[2]) });
    else if (/^\/\/@\s*network\s*$/.test(line)) cur?.nets.push([]);
    else if (line.startsWith('//@')) throw new Error(`direttiva sconosciuta: ${line}`);
    else if (cur) cur.nets[cur.nets.length - 1]!.push(line);
  }
  finish();
  return out;
}

const items = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

// --- valori e posizioni ------------------------------------------------------------------------

function parseNumber(v: string, real: boolean): number {
  let mt: RegExpMatchArray | null;
  if (real) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, Number.parseFloat(v), false);
    return view.getUint32(0, false);
  }
  if ((mt = v.match(/^(-?)16#([0-9A-Fa-f_]+)$/)))
    return (mt[1] ? -1 : 1) * Number.parseInt(mt[2]!.replace(/_/g, ''), 16);
  if ((mt = v.match(/^2#([01_]+)$/))) return Number.parseInt(mt[1]!.replace(/_/g, ''), 2);
  if (/^-?\d+$/.test(v)) return Number(v);
  throw new Error(`valore non valido: ${v}`);
}

type Reader = (cpu: SimCpu, regs: Registers | null) => number;
interface Place {
  bits: number;
  real: boolean;
  read: Reader;
  write?: (cpu: SimCpu, v: number) => void;
}

const SIZES = { B: 1, W: 2, D: 4 } as const;

function bytesOf(area: Uint8Array, at: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + (area[at + i] ?? 0);
  return v;
}
function putBytes(area: Uint8Array, at: number, n: number, v: number): void {
  for (let i = n - 1; i >= 0; i--) {
    area[at + i] = v & 255;
    v = Math.floor(v / 256);
  }
}

const STW_BITS: Record<string, keyof Registers['stw']> = {
  FC: 'fc',
  RLO: 'rlo',
  STA: 'sta',
  OR: 'or',
  OS: 'os',
  OV: 'ov',
  CC0: 'cc0',
  CC1: 'cc1',
  BR: 'br',
};

function place(name: string): Place {
  let mt: RegExpMatchArray | null;
  const need = (r: Registers | null): Registers => {
    if (!r) throw new Error('nessun registro: l’OB non è stato eseguito');
    return r;
  };
  if (name === 'STW') return { bits: 16, real: false, read: (_c, r) => stwToWord(need(r).stw) };
  if ((mt = name.match(/^ACCU([12])(R?)$/)))
    return {
      bits: 32,
      real: mt[2] === 'R',
      read: (_c, r) => need(r)[mt![1] === '1' ? 'accu1' : 'accu2'] >>> 0,
    };
  if ((mt = name.match(/^AR([12])$/)))
    return {
      bits: 32,
      real: false,
      read: (_c, r) => need(r)[mt![1] === '1' ? 'ar1' : 'ar2'] >>> 0,
    };
  if (STW_BITS[name]) {
    const f = STW_BITS[name]!;
    return { bits: 1, real: false, read: (_c, r) => (need(r).stw[f] ? 1 : 0) };
  }
  const areaOf = (cpu: SimCpu, a: string, forWrite: boolean): Uint8Array =>
    a === 'M'
      ? cpu.memory.M
      : a === 'Q'
        ? cpu.memory.Q
        : forWrite
          ? cpu.memory.physIn
          : cpu.memory.I;
  if ((mt = name.match(/^([MQI])([BWD])(\d+)$/))) {
    const [a, n, at] = [mt[1]!, SIZES[mt[2] as 'B' | 'W' | 'D'], Number(mt[3])];
    return {
      bits: n * 8,
      real: false,
      read: (c) => bytesOf(areaOf(c, a, false), at, n),
      write: (c, v) => putBytes(areaOf(c, a, true), at, n, v),
    };
  }
  if ((mt = name.match(/^([MQI])R(\d+)$/))) {
    const [a, at] = [mt[1]!, Number(mt[2])];
    return {
      bits: 32,
      real: true,
      read: (c) => bytesOf(areaOf(c, a, false), at, 4),
      write: (c, v) => putBytes(areaOf(c, a, true), at, 4, v),
    };
  }
  if ((mt = name.match(/^([MQI])(\d+)\.([0-7])$/))) {
    const [a, at, bit] = [mt[1]!, Number(mt[2]), Number(mt[3])];
    return {
      bits: 1,
      real: false,
      read: (c) => (areaOf(c, a, false)[at]! >> bit) & 1,
      write: (c, v) => {
        const area = areaOf(c, a, true);
        area[at] = v ? area[at]! | (1 << bit) : area[at]! & ~(1 << bit);
      },
    };
  }
  if ((mt = name.match(/^DB(\d+)\.DB([BWD])(\d+)$/))) {
    const [db, n, at] = [Number(mt[1]), SIZES[mt[2] as 'B' | 'W' | 'D'], Number(mt[3])];
    return {
      bits: n * 8,
      real: false,
      read: (c) => bytesOf(c.memory.dbs.get(db)?.data ?? new Uint8Array(), at, n),
    };
  }
  if ((mt = name.match(/^DB(\d+)\.DBR(\d+)$/))) {
    const [db, at] = [Number(mt[1]), Number(mt[2])];
    return {
      bits: 32,
      real: true,
      read: (c) => bytesOf(c.memory.dbs.get(db)?.data ?? new Uint8Array(), at, 4),
    };
  }
  throw new Error(`posizione sconosciuta: ${name}`);
}

const mask = (v: number, bits: number): number =>
  bits === 32 ? v >>> 0 : (((v % 2 ** bits) + 2 ** bits) % 2 ** bits) >>> 0;

// --- esecuzione --------------------------------------------------------------------------------

function globalDbFile(d: DbSpec): Uint8Array {
  const stat = d.members.map((x) => m(x.name, memberType(x.type)));
  const iface = {
    input: [],
    output: [],
    inOut: [],
    static: stat,
    temp: [],
    returnType: { kind: 'void' as const },
  };
  const ctx = {
    owner: { kind: 'DB', iface },
    symbol: () => undefined,
    block: () => undefined,
    resolve: () => null,
    allSymbols: () => [],
    allBlocks: () => [],
  } as unknown as AwlContext;
  const r = compileBlock({
    kind: 'DB',
    number: d.number,
    now: new Date(2026, 9, 20),
    header: { author: 'T', family: 'Prove', name: 'Dati', version: '0.1' },
    knowHowProtected: false,
    sections: { ...EMPTY, stat },
    initials: {},
    networks: [],
    ctx,
  });
  if (!r.file) throw new Error(`DB${d.number}: ${r.diagnostics.map((x) => x.message).join('; ')}`);
  return r.file;
}

export interface BatteryRun {
  file: string;
  /** Differenze fra atteso e ottenuto (vuoto se il programma è passato). */
  failures: string[];
  /** Id delle istruzioni eseguite almeno una volta dal ciclo. */
  executed: Set<string>;
}

export async function runBatteryFile(file: string): Promise<BatteryRun> {
  instrument();
  const p = parseProgram(readFileSync(join(BATTERY_DIR, file), 'utf8'));
  const idbMap: Record<number, number> = {};
  for (const i of p.idbs) idbMap[i.db] = i.fb;
  const files = [
    ...buildFiles(p.blocks, idbMap),
    ...p.dbs.map(globalDbFile),
    ...p.idbs.map((i) => instanceDbFile(p.blocks, i.db, i.fb)),
  ];

  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
  const c = await connectToSim(cpu);
  const failures: string[] = [];
  probe = { executed: new Set(), regs: null };
  try {
    for (const f of files) await c.downloadBlock(f);
    await c.start();
    for (const s of p.setup) {
      const [name, value] = s.split('=').map((x) => x.trim()) as [string, string];
      const pl = place(name);
      if (!pl.write) throw new Error(`non scrivibile: ${name}`);
      pl.write(cpu, parseNumber(value, pl.real));
    }
    const result = cpu.cycle();
    if (p.error) {
      if (result.ok) failures.push(`atteso errore ${p.error}, il ciclo è riuscito`);
      else if (result.error?.code !== p.error)
        failures.push(`atteso errore ${p.error}, ottenuto ${result.error?.code}`);
    } else if (!result.ok) {
      failures.push(`ciclo fallito: ${result.error?.code} ${result.error?.detail ?? ''}`);
    }
    if (!p.error && result.ok) {
      for (const e of p.expected) {
        const [name, value] = e.split('=').map((x) => x.trim()) as [string, string];
        const pl = place(name);
        const want = mask(parseNumber(value, pl.real), pl.bits);
        const got = mask(pl.read(cpu, probe.regs), pl.bits);
        if (want !== got) {
          const show = (n: number) =>
            pl.bits === 1
              ? String(n)
              : `16#${n
                  .toString(16)
                  .toUpperCase()
                  .padStart(pl.bits / 4, '0')}`;
          failures.push(`${name}: atteso ${value} (${show(want)}), ottenuto ${show(got)}`);
        }
      }
    }
  } finally {
    await c.close();
  }
  return { file, failures, executed: probe.executed };
}
