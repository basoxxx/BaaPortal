import { checkBlockCode } from '@baaportal/awl';
import {
  compileBlock,
  dataLayout,
  decodeBlock,
  readBlockFile,
  readSsb,
  type CompileInput,
  type Mc7Diagnostic,
} from '@baaportal/mc7';
import type { DataType, FbSections, TypedMember } from '@baaportal/s7-types';
import { collect, kitZip, memoryTransportPair, readKitZip } from '@baaportal/s7comm';
import { FakeCpu, serve } from '@baaportal/s7-server';
import { describe, expect, it } from 'vitest';
import { callSpans } from '../../mc7/test/compileHelpers';
import { realBlocks } from '../../mc7/test/realBlocks';
import {
  applyImport,
  blockFromMc7,
  blockToMc7File,
  calleeResolver,
  compileDevice,
  createAwlContext,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createUdt,
  mc7FidelityOf,
  planImport,
  readBaap,
  renameWithReferences,
  writeBaap,
  type Block,
  type BlockInterface,
  type CodeBlock,
  type GlobalDb,
  type Member,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, makeProject, now, seq } from './fixtures';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function bareDevice(newId = seq('d')): PlcDevice {
  const d = createPlcDevice({
    cpu: cpu315pn,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Tabella' },
    newId,
  });
  d.blocks = [];
  return d;
}

/**
 * I blocchi chiamati con UC/CC/CALL nelle righe di codice che non sono fra i file: vuoti, come nel
 * progetto reale, compilati e importati **nello stesso lotto** (regola S: un blocco del progetto
 * che non viene dall'importazione è estraneo e le reti che lo usano si ricompilano). Non si creano
 * per i chiamati dei soli grezzi (`// MC7 testo: UC …`): una FC vuota contro una lista di
 * puntatori non vuota è incoerente col lotto, e quelle reti non si modificano comunque.
 */
function stubsFor(files: Uint8Array[]): Uint8Array[] {
  const have = new Set<string>();
  for (const f of files) {
    const h = readBlockFile(f).header;
    if (h.kind === 'FC' || h.kind === 'FB') have.add(`${h.kind}${h.number}`);
  }
  const out: Uint8Array[] = [];
  for (const f of files) {
    for (const n of decodeBlock(f).networks ?? []) {
      const code = n
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      for (const m of code.matchAll(/\b(?:UC|CC|CALL)\s+%?(FC|FB)\s*(\d+)/g)) {
        const key = `${m[1]}${m[2]}`;
        if (have.has(key)) continue;
        have.add(key);
        const stub = createCodeBlock({
          kind: m[1] as 'FC' | 'FB',
          number: Number(m[2]),
          name: key,
          language: 'AWL',
          newId: seq(`s${key}`),
        });
        const d = bareDevice(seq(`d${key}`));
        d.blocks.push(stub);
        out.push(blockToMc7File(stub, d, cpu315pn, now).file!);
      }
    }
  }
  return out;
}

const importable = realBlocks().filter((b) => {
  try {
    readBlockFile(b.bytes);
    decodeBlock(b.bytes);
    return true;
  } catch {
    return false;
  }
});

describe('blocchi reali: importazione ed esportazione', () => {
  it('ogni blocco importato e non modificato si esporta con i byte originali; controllo AWL senza errori di forma', ({
    skip,
  }) => {
    const rows: string[] = [];
    let identical = 0;
    for (const real of importable) {
      const device = bareDevice();
      const plan = planImport(device, [real.bytes]);
      expect(plan.skipped, real.name).toEqual([]);
      expect(plan.create, real.name).toHaveLength(1);
      applyImport(device, plan);
      const block = device.blocks[0]!;
      const out = blockToMc7File(block, device, cpu315pn, now);
      expect(out.diagnostics, real.name).toEqual([]);
      const same = out.file !== undefined && hex(out.file) === hex(real.bytes);
      expect(same, real.name).toBe(true);
      if (same) identical++;
      let check = '';
      if (block.kind !== 'DB' && block.kind !== 'IDB') {
        const ctx = createAwlContext(device, block.id, cpu315pn);
        const d = checkBlockCode(
          block.networks.map((n) => n.source),
          ctx,
          'international',
        );
        const bad = d.filter((x) => ['SYNTAX', 'UNKNOWN_LOCAL', 'UNKNOWN_LABEL'].includes(x.code));
        expect(
          bad.map((x) => `${x.code}@${x.network}:${x.range.from.line}`),
          real.name,
        ).toEqual([]);
        check = ` AWL: ${d.length} avvisi/errori (${[...new Set(d.map((x) => x.code))].join(',')})`;
      }
      rows.push(
        `${real.name} -> ${block.kind}${block.number} ${block.mc7!.exact ? 'esatto' : `SOLA LETTURA (${plan.warnings.join('; ')})`}${check}`,
      );
    }
    console.log(`[mc7Bridge] ${identical}/${importable.length} identici\n  ${rows.join('\n  ')}`);
    expect(identical).toBe(importable.length);
    // corpus incompleto (blocchi o catture non scaricati): le verifiche sopra valgono, il test è saltato
    if (importable.length < 12) return skip();
  });
});

describe('importazione', () => {
  const ob1 = importable.find((b) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name));

  it.skipIf(!ob1)(
    'importare un OB1 che esiste: replace, nessuna modifica prima di applyImport',
    () => {
      const device = createPlcDevice({
        cpu: cpu315pn,
        orderNumber: 'x',
        firmware: 'V3.2',
        name: 'PLC_1',
        texts: { defaultTagTable: 'T' },
        newId: seq('e'),
      });
      device.groups.blocks.push('G');
      const existing = device.blocks[0]!;
      existing.group = 'G';
      const before = JSON.stringify(device);
      const plan = planImport(device, [ob1!.bytes]);
      expect(JSON.stringify(device)).toBe(before);
      expect(plan.create).toEqual([]);
      expect(plan.replace).toHaveLength(1);
      expect(plan.replace[0]!.existing).toBe(existing);
      applyImport(device, plan);
      expect(device.blocks).toHaveLength(1);
      const now1 = device.blocks[0] as CodeBlock;
      expect(now1.id).toBe(existing.id);
      expect(now1.name).toBe('Main');
      expect(now1.group).toBe('G');
      expect(now1.language).toBe('AWL');
      expect(now1.networks.length).toBeGreaterThan(1);
      expect(now1.mc7).toBeDefined();
    },
  );

  it.skipIf(!ob1)(
    'modifica di una rete di OB1 importato: compila e la decodifica restituisce il testo modificato',
    () => {
      const device = bareDevice();
      applyImport(device, planImport(device, [ob1!.bytes]));
      // le interfacce note all'importazione (qui il solo catalogo: la CALL SFB 0 si ricostruisce)
      const resolve = calleeResolver({ ...device, blocks: [...device.blocks] });
      const b = device.blocks[0] as CodeBlock;
      expect(b.networks[1]!.source).toContain('CALL %SFB0, %DB1');
      const unchanged = blockToMc7File(b, device, cpu315pn, now);
      expect(hex(unchanged.file!)).toBe(hex(ob1!.bytes));
      const i = b.networks.findIndex((n) => n.source.includes('R %M0.0'));
      expect(i).toBeGreaterThanOrEqual(0);
      // OB1 chiama l'FB 1 (non nel file): il compilatore ne ha bisogno nel progetto.
      device.blocks.push(
        createCodeBlock({ kind: 'FB', number: 1, name: 'FB1', language: 'AWL', newId: seq('f') }),
      );
      b.networks[i]!.source = b.networks[i]!.source.replace('R %M0.0', 'S %M0.0');
      const out = blockToMc7File(b, device, cpu315pn, now);
      expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(out.file).toBeDefined();
      expect(hex(out.file!)).not.toBe(hex(ob1!.bytes));
      const back = decodeBlock(out.file!, { resolveCallee: resolve });
      expect(back.networks).toEqual(b.networks.map((n) => n.source));
      expect(back.networks![i]).toContain('S %M0.0');
    },
  );

  it.skipIf(importable.length === 0)(
    'salva e riapri il progetto: mc7 sopravvive e l esportazione resta identica',
    () => {
      const p = makeProject();
      const d = p.devices[0]!;
      d.blocks = [];
      applyImport(
        d,
        planImport(
          d,
          importable.slice(0, 6).map((b) => b.bytes),
        ),
      );
      // file o, per i blocchi incoerenti con un altro del lotto (regola F), i codici degli errori
      const out = (dev: PlcDevice) =>
        dev.blocks.map((b) => {
          const r = blockToMc7File(b, dev, cpu315pn, now);
          return r.file ? hex(r.file) : r.diagnostics.map((x) => x.code).join();
        });
      const files = out(d);
      const again = readBaap(writeBaap(p, { appVersion: 'x' }));
      const d2 = again.devices[0]!;
      expect(d2.blocks.map((b) => b.mc7)).toEqual(d.blocks.map((b) => b.mc7));
      expect(out(d2)).toEqual(files);
      expect(d2.blocks.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!importable.some((b) => b.bytes[5] === 0x0a))(
    'SDB e file illeggibili: saltati con un motivo',
    () => {
      const db = importable.find((b) => b.bytes[5] === 0x0a)!;
      const sdb = db.bytes.slice();
      sdb[5] = 0x0b;
      const files: Uint8Array[] = [new Uint8Array([1, 2, 3]), sdb];
      const device = bareDevice();
      const plan = planImport(device, files);
      expect(plan.create).toEqual([]);
      expect(plan.skipped).toHaveLength(files.length);
      for (const s of plan.skipped) expect(s.reason.length).toBeGreaterThan(5);
    },
  );

  it('DB di istanza senza FB: DB globale con avviso; con l FB: IDB dell FB', () => {
    const src = makeDevice(seq('s'));
    // FB Linea (AWL) + IDB della Linea compilati nel dispositivo sorgente
    const linea = src.blocks.find((b) => b.name === 'Linea') as CodeBlock;
    linea.number = 10;
    src.blocks.push({
      ...createInstanceDb({ number: 11, name: 'Linea_DB', instanceOf: 'Linea', newId: seq('q') }),
    });
    const fbFile = blockToMc7File(linea, src, cpu315pn, now);
    const idb = src.blocks.find((b) => b.name === 'Linea_DB')!;
    const idbFile = blockToMc7File(idb, src, cpu315pn, now);
    expect(fbFile.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(idbFile.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const lonely = bareDevice();
    const p1 = planImport(lonely, [idbFile.file!]);
    expect(p1.create[0]!.kind).toBe('DB');
    expect(p1.warnings.join('\n')).toContain('FB 10 non presente: importato come DB globale');

    const both = bareDevice();
    const p2 = planImport(both, [idbFile.file!, fbFile.file!]);
    applyImport(both, p2);
    const i = both.blocks.find((b) => b.kind === 'IDB')!;
    expect(i.kind === 'IDB' && i.instanceOf).toBe('FB10');
    expect(both.blocks.find((b) => b.kind === 'FB')!.name).toBe('FB10');
    // il FB importato ha la multi-istanza di un FB assente (Nastro): tipo FB<n>
    expect(hex(blockToMc7File(i, both, cpu315pn, now).file!)).toBe(hex(idbFile.file!));
  });

  it.skipIf(!ob1)(
    'blockFromMc7: un blocco alla volta, nomi generati e nessun cambiamento al dispositivo',
    () => {
      const device = bareDevice();
      const before = JSON.stringify(device);
      const r = blockFromMc7(device, ob1!.bytes, seq('n'));
      expect(JSON.stringify(device)).toBe(before);
      expect(r.block.kind).toBe('OB');
      expect(r.block.name).toBe('OB1');
    },
  );
});

describe('compileDevice', () => {
  const ok = (r: { diagnostics: { severity: string }[] }): boolean =>
    !r.diagnostics.some((d) => d.severity === 'error');

  it('un blocco con errori non impedisce agli altri di compilare; SCL e FUP compilano', () => {
    const newId = seq('c');
    const d = bareDevice(newId);
    const good = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL', newId });
    good.networks[0]!.source = 'L 1;\nT MW 0;';
    const bad = createCodeBlock({ kind: 'FC', number: 2, name: 'Rotta', language: 'AWL', newId });
    bad.networks[0]!.source = 'XYZ 1;';
    const scl = createCodeBlock({ kind: 'FB', number: 4, name: 'Testo', language: 'SCL', newId });
    const db = createGlobalDb({ number: 5, name: 'Dati', newId });
    db.members.push({ id: newId(), name: 'V', type: 'Int', initial: '7', comment: '' });
    d.blocks.push(good, bad, scl, db);
    const { results } = compileDevice(d, cpu315pn, undefined, now);
    expect(results.map((r) => r.blockId)).toEqual(d.blocks.map((b) => b.id));
    const by = (id: string) => results.find((r) => r.blockId === id)!;
    expect(ok(by(good.id)) && by(good.id).file).toBeTruthy();
    expect(by(bad.id).file).toBeUndefined();
    expect(by(bad.id).diagnostics.some((x) => x.severity === 'error')).toBe(true);
    expect(by(scl.id).file).toBeTruthy();
    expect(by(scl.id).diagnostics.map((x) => x.code)).not.toContain('LINGUAGGIO_NON_COMPILABILE');
    expect(by(db.id).file).toBeTruthy();
    const f = readBlockFile(by(db.id).file!);
    expect(f.mc7[0]).toBe(0);
    expect(f.mc7[1]).toBe(7);
    // only
    expect(compileDevice(d, cpu315pn, [good.id], now).results).toHaveLength(1);
  });

  it('dispositivo con UDT, multi-istanza e IDB: compila FB, DB con UDT e IDB', () => {
    const d = makeDevice(seq('m'));
    const { results } = compileDevice(d, cpu315pn, undefined, now);
    const byName = (n: string) => results[d.blocks.findIndex((b) => b.name === n)]!;
    expect(byName('Nastro').diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(byName('Linea').diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(byName('Linea').file).toBeTruthy();
    expect(byName('Dati').diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(byName('Dati').file).toBeTruthy();
    expect(byName('Nastro_DB').file).toBeTruthy();
  });

  it.skipIf(!importable.some((b) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name)))(
    'blocco importato non ricodificabile: invariato dà i byte originali, modificato dà errore',
    () => {
      const real = importable.find((b) => /^OB1 \(.*tia_s300_downloadOb1/.test(b.name))!;
      const d = bareDevice();
      applyImport(d, planImport(d, [real.bytes]));
      const b = d.blocks[0] as CodeBlock;
      b.mc7!.exact = false;
      const same = compileDevice(d, cpu315pn, undefined, now).results[0]!;
      expect(hex(same.file!)).toBe(hex(real.bytes));
      b.networks[0]!.source += '\nNOP 0;';
      const changed = compileDevice(d, cpu315pn, undefined, now).results[0]!;
      expect(changed.file).toBeUndefined();
      expect(changed.diagnostics.map((x) => x.code)).toContain(
        'BLOCCO_IMPORTATO_NON_RICODIFICABILE',
      );
    },
  );
});

describe('kit del finto PLC', () => {
  it('importa lo zip del kit prodotto dal finto PLC: blocchi AWL e DB nel dispositivo', async () => {
    const src = makeDevice(seq('k'));
    const newId = seq('kk');
    const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL', newId });
    ob.networks[0]!.source = 'L 1;\nT MW 0;';
    const linea = src.blocks.find((b) => b.name === 'Linea') as CodeBlock;
    linea.number = 10;
    const idb = createInstanceDb({ number: 11, name: 'Linea_DB', instanceOf: 'Linea', newId });
    const dati = src.blocks.find((b) => b.name === 'Dati')!;
    dati.number = 12;
    src.blocks.push(ob, idb);
    const exported = [ob, linea, idb, dati];
    const cpu = new FakeCpu();
    for (const b of exported) {
      const r = blockToMc7File(b, src, cpu315pn, now);
      expect(r.file, b.name).toBeDefined();
      cpu.addBlock(r.file!);
    }
    const r = await collect(
      {
        host: 'fake',
        includeBlocks: true,
        minIntervalMs: 0,
        reconnectDelayMs: 0,
        timeoutMs: 2000,
        transport: async () => {
          const [a, b] = memoryTransportPair();
          serve(cpu, b);
          return a;
        },
      },
      () => undefined,
    );
    const kit = readKitZip(kitZip(r));
    expect(Object.keys(kit.blocks).sort()).toEqual(['DB11', 'DB12', 'FB10', 'OB1']);
    const dst = bareDevice();
    const plan = planImport(dst, Object.values(kit.blocks));
    expect(plan.skipped).toEqual([]);
    applyImport(dst, plan);
    const kinds = dst.blocks.map((b: Block) => `${b.kind}${b.number}`).sort();
    expect(kinds).toEqual(['DB12', 'FB10', 'IDB11', 'OB1']);
    const fb = dst.blocks.find((b) => b.kind === 'FB') as CodeBlock;
    expect(fb.language).toBe('AWL');
    const i = dst.blocks.find((b) => b.kind === 'IDB')!;
    expect(i.kind === 'IDB' && i.instanceOf).toBe(fb.name);
    const out = dst.blocks.map((b) => hex(blockToMc7File(b, dst, cpu315pn, now).file!));
    const orig = Object.values(kit.blocks).map(hex);
    expect([...out].sort()).toEqual([...orig].sort());
  });
});

describe('modifica rete per rete dei blocchi importati', () => {
  const find = (n: string) => importable.find((b) => b.name === n)!;
  const has = (n: string): boolean => importable.some((b) => b.name === n);
  const hasRaw = (t: string): boolean => /\/\/\s*MC7 grezzo:/.test(t);
  const norm = (t: string): string => t.replace(/#\w+/g, '#').replace(/\s+/g, ' ').trim();

  /** I blocchi chiamati non sono nel file: entrano vuoti nello stesso lotto (`stubsFor`). */
  function load(real: { bytes: Uint8Array }): {
    device: PlcDevice;
    block: CodeBlock;
    resolve: ReturnType<typeof calleeResolver>;
  } {
    const device = bareDevice();
    applyImport(device, planImport(device, [real.bytes, ...stubsFor([real.bytes])]));
    // le interfacce note all'importazione
    const resolve = calleeResolver({ ...device, blocks: [...device.blocks] });
    const block = device.blocks.find((b) => b.mc7?.original === hex(real.bytes)) as CodeBlock;
    return { device, block, resolve };
  }

  function netBytes(file: Uint8Array): string[] {
    const f = readBlockFile(file);
    let o = 0;
    return f.add.networks.map((n) => {
      const s = hex(f.mc7.subarray(o, o + n));
      o += n;
      return s;
    });
  }

  function editEach(name: string): { edited: number; tried: number } {
    const real = find(name);
    const { device, block, resolve } = load(real);
    const orig = decodeBlock(real.bytes, { resolveCallee: resolve });
    const origNets = netBytes(real.bytes);
    expect(block.mc7!.exact, name).toBe(true);
    let edited = 0;
    let tried = 0;
    block.networks.forEach((n, k) => {
      if (hasRaw(n.source) || n.source.trim() === '') return;
      tried++;
      const before = n.source;
      n.source = `${before}\n\tNOP 0;`;
      const r = blockToMc7File(block, device, undefined, now);
      n.source = before;
      if (!r.file) return;
      edited++;
      const back = decodeBlock(r.file, { resolveCallee: resolve });
      expect(norm(back.networks![k]!), `${name} rete ${k + 1}`).toBe(norm(`${before}\n\tNOP 0;`));
      const bytes = netBytes(r.file);
      block.networks.forEach((_, j) => {
        if (j === k) return;
        expect(back.networks![j], `${name} testo rete ${j + 1}`).toBe(orig.networks![j]);
        expect(bytes[j], `${name} byte rete ${j + 1}`).toBe(origNets[j]);
      });
    });
    return { edited, tried };
  }

  for (const name of ['FC1', 'FC100']) {
    it.skipIf(!has(name))(
      `${name}: una rete senza grezzi si modifica; le altre restano identiche (grezzi compresi)`,
      () => {
        const r = editEach(name);
        console.log(`[mc7Bridge] ${name}: ${r.edited}/${r.tried} reti modificabili`);
        expect(r.edited).toBeGreaterThan(0);
      },
    );
  }

  it.skipIf(!has('FC21') || !has('FC100'))(
    'FC con parametri formali: le reti invariate con #nome tornano a #PARn e ai byte esatti',
    () => {
      let compared = 0;
      for (const name of ['FC21', 'FC100']) {
        const real = find(name);
        const { device, block } = load(real);
        const withFormal = block.networks.filter((n) => /#(IN|OUT|IN_OUT)\d+\b/.test(n.source));
        expect(withFormal.length, name).toBeGreaterThan(0);
        expect(
          block.networks.some((n) => /#PAR\d/.test(n.source)),
          name,
        ).toBe(false);
        // una modifica fuori dalle reti con formali: tutte le reti invariate tengono i byte
        const last = block.networks.findIndex((n) => !hasRaw(n.source) && !/#\w/.test(n.source));
        if (last < 0) continue;
        block.networks[last]!.source += '\n\tNOP 0;';
        const r = blockToMc7File(block, device, undefined, now);
        if (!r.file) continue;
        const a = netBytes(r.file);
        const o = netBytes(real.bytes);
        block.networks.forEach((n, j) => {
          if (j !== last && /#(IN|OUT|IN_OUT)\d+\b/.test(n.source)) {
            expect(a[j], name).toBe(o[j]);
            compared++;
          }
        });
      }
      expect(compared).toBeGreaterThan(0);
    },
  );

  it.skipIf(!has('FC1'))(
    'FC1: modificare una rete che contiene un grezzo dà RAW_IN_CHANGED_NETWORK e nessun file',
    () => {
      const real = find('FC1');
      const { device, block } = load(real);
      const k = block.networks.findIndex((n) => hasRaw(n.source));
      expect(k).toBeGreaterThanOrEqual(0);
      block.networks[k]!.source += '\n\tNOP 0;';
      const r = blockToMc7File(block, device, undefined, now);
      expect(r.file).toBeUndefined();
      expect(r.diagnostics.map((d) => d.code)).toContain('RAW_IN_CHANGED_NETWORK');
    },
  );

  it('i blocchi con grezzi restano modificabili (exact) salvo i casi non gestibili rete per rete', () => {
    let editable = 0;
    let code = 0;
    for (const real of importable) {
      const device = bareDevice();
      applyImport(device, planImport(device, [real.bytes]));
      const b = device.blocks[0]!;
      if (b.kind === 'DB' || b.kind === 'IDB') continue;
      code++;
      if (b.mc7!.exact) editable++;
    }
    console.log(`[mc7Bridge] blocchi di codice modificabili rete per rete: ${editable}/${code}`);
    expect(editable).toBe(code);
  });
});

describe('CALL ricostruite all importazione (Task 8b)', () => {
  const hasRaw = (t: string): boolean => /\/\/\s*MC7 grezzo:/.test(t);
  const hasCall = (t: string): boolean => /^(?:\w+:)?\tCALL\b/m.test(t);
  const errors = (d: Mc7Diagnostic[]) => d.filter((x) => x.severity === 'error');

  /**
   * Tutti i blocchi reali in un lotto; il risolutore è quello dell'importazione. Con `stubs` i
   * chiamati che non sono fra i file entrano vuoti nello stesso lotto (`stubsFor`).
   */
  function batch(stubs = false): {
    device: PlcDevice;
    plan: ReturnType<typeof planImport>;
    resolve: ReturnType<typeof calleeResolver>;
  } {
    const device = bareDevice();
    const files = importable.map((b) => b.bytes);
    const plan = planImport(device, stubs ? [...files, ...stubsFor(files)] : files);
    applyImport(device, plan);
    return { device, plan, resolve: calleeResolver({ ...device, blocks: [...device.blocks] }) };
  }

  /** Il blocco del dispositivo importato da questo file (i doppioni dello stesso numero sono saltati). */
  const importedFrom = (device: PlcDevice, bytes: Uint8Array): CodeBlock | undefined =>
    device.blocks.find(
      (b): b is CodeBlock => b.kind !== 'DB' && b.kind !== 'IDB' && b.mc7?.original === hex(bytes),
    );

  it('lotto di tutti i blocchi reali: le reti che avevano il grezzo di una CALL ora si modificano', () => {
    const { device } = batch(true);
    const rows: string[] = [];
    let held = 0;
    let rebuilt = 0;
    let editable = 0;
    for (const real of importable) {
      const block = importedFrom(device, real.bytes);
      const plain = decodeBlock(real.bytes);
      if (!block || !plain.networks) continue;
      plain.networks.forEach((t, k) => {
        if (!hasRaw(t)) return;
        held++;
        const source = block.networks[k]!.source;
        if (hasRaw(source)) return; // chiamato sconosciuto o UC FC [mem]: resta grezzo
        rebuilt++;
        expect(hasCall(source), `${block.name} rete ${k + 1}`).toBe(true);
        block.networks[k]!.source = `${source}\n\tNOP 0;`;
        const r = blockToMc7File(block, device, undefined, now);
        block.networks[k]!.source = source;
        expect(errors(r.diagnostics), `${block.name} rete ${k + 1}`).toEqual([]);
        if (r.file) editable++;
        rows.push(`${block.name} rete ${k + 1}`);
      });
    }
    console.log(
      `[mc7Bridge] reti con grezzi ${held}, ora con CALL e modificabili: ${rows.join(', ')}`,
    );
    if (importable.length >= 23) {
      // FB101 rete 3 (FC 100 del lotto), FC100 reti 2 e 9 (SFC 20 del catalogo)
      expect({ rebuilt, editable }).toEqual({ rebuilt: 3, editable: 3 });
    } else expect(rebuilt).toBe(editable);
  });

  it('rete con una CALL ricostruita modificata altrove: i byte della CALL restano e la modifica torna nella decodifica', () => {
    const { device, resolve } = batch(true);
    const edits: { name: string; at: number; edit: (s: string) => string }[] = [
      // FC100 rete 2: L 400 prima della CALL SFC 20 (l'ANY costruito a mano con AR1)
      { name: 'FC100', at: 1, edit: (s) => s.replace('\tL 400;', '\tL 401;') },
      // FB101 rete 3: solo la CALL FC 100; un'istruzione dopo
      { name: 'FB101', at: 2, edit: (s) => `${s}\n\tNOP 0;` },
    ];
    let done = 0;
    for (const e of edits) {
      const real = importable.find((b) => b.name === e.name);
      if (!real) continue;
      const block = importedFrom(device, real.bytes)!;
      const net = block.networks[e.at]!;
      expect(hasCall(net.source), e.name).toBe(true);
      const edited = e.edit(net.source);
      expect(edited).not.toBe(net.source);
      net.source = edited;
      const r = blockToMc7File(block, device, undefined, now);
      expect(errors(r.diagnostics), e.name).toEqual([]);
      const back = decodeBlock(r.file!, { resolveCallee: resolve });
      // nel testo importato #PARn ha i nomi generati
      const formals = block.interface.input.map((x) => x.name);
      const named = (t: string) =>
        t.replace(/#PAR(\d+)\b/g, (w, n: string) => `#${formals[Number(n)] ?? w}`);
      expect(back.networks!.map(named)).toEqual(block.networks.map((n) => n.source));
      const spansOf = (f: Uint8Array) =>
        callSpans(f)
          .filter((s) => s.network === e.at + 1)
          .map((s) => hex(s.bytes));
      expect(spansOf(r.file!).length, e.name).toBeGreaterThan(0);
      expect(spansOf(r.file!), e.name).toEqual(spansOf(real.bytes));
      done++;
    }
    if (importable.length >= 23) expect(done).toBe(2);
  });

  it('FC che passa i propri parametri a una FC del progetto: nomi generati, modifica e byte della CALL', () => {
    const newId = seq('w');
    const src = bareDevice(newId);
    const somma = createCodeBlock({
      kind: 'FC',
      number: 11,
      name: 'Somma',
      language: 'AWL',
      newId,
    });
    somma.interface.input.push({ id: newId(), name: 'a', type: 'Int', comment: '' });
    somma.interface.output.push({ id: newId(), name: 'o', type: 'Int', comment: '' });
    somma.interface.inOut.push({ id: newId(), name: 'acc', type: 'DInt', comment: '' });
    somma.interface.returnType = 'Int';
    const usa = createCodeBlock({ kind: 'FC', number: 12, name: 'Usa', language: 'AWL', newId });
    usa.interface.input.push({ id: newId(), name: 'x', type: 'Int', comment: '' });
    usa.interface.output.push({ id: newId(), name: 'y', type: 'Int', comment: '' });
    usa.interface.inOut.push({ id: newId(), name: 'tot', type: 'DInt', comment: '' });
    usa.interface.returnType = 'Int';
    usa.networks[0]!.source =
      'A %M0.0;\nCALL "Somma" (a := #x, RET_VAL => #RET_VAL, o => #y, acc := #tot);';
    src.blocks.push(somma, usa);
    const compiled = blockToMc7File(usa, src, cpu315pn, now);
    expect(errors(compiled.diagnostics)).toEqual([]);

    // Importazione in un progetto che ha la FC 11: la CALL torna coi nomi generati di Usa
    const dst = bareDevice(seq('v'));
    dst.blocks.push({ ...somma });
    const plan = planImport(dst, [compiled.file!]);
    applyImport(dst, plan);
    const resolve = calleeResolver({ ...dst, blocks: [...dst.blocks] });
    const b = dst.blocks.find((x) => x.kind === 'FC' && x.number === 12) as CodeBlock;
    expect(b.networks[0]!.source).toContain('CALL %FC11');
    for (const part of [
      'a       := #IN0',
      'RET_VAL => #RET_VAL',
      'o       => #OUT0',
      'acc     := #IN_OUT0',
    ]) {
      expect(b.networks[0]!.source).toContain(part);
    }
    // invariato: byte originali; modificato altrove: la CALL torna agli stessi byte
    expect(hex(blockToMc7File(b, dst, cpu315pn, now).file!)).toBe(hex(compiled.file!));
    b.networks[0]!.source = b.networks[0]!.source.replace('A %M0.0', 'AN %M0.0');
    const out = blockToMc7File(b, dst, cpu315pn, now);
    expect(errors(out.diagnostics)).toEqual([]);
    expect(callSpans(out.file!).map((x) => hex(x.bytes))).toEqual(
      callSpans(compiled.file!).map((x) => hex(x.bytes)),
    );
    const back = decodeBlock(out.file!, { resolveCallee: resolve });
    const names = ['IN0', 'RET_VAL', 'OUT0', 'IN_OUT0'];
    expect(
      back.networks![0]!.replace(/#PAR(\d+)\b/g, (_, n: string) => `#${names[Number(n)]}`),
    ).toBe(b.networks[0]!.source);
  });

  it('salva e riapri dopo il lotto: le reti con CALL ricostruite tengono i byte quando si modifica un altra rete', ({
    skip,
  }) => {
    const p = makeProject();
    const d = p.devices[0]!;
    const files = importable.map((b) => b.bytes);
    d.blocks = [];
    applyImport(d, planImport(d, [...files, ...stubsFor(files)]));
    const again = readBaap(writeBaap(p, { appVersion: 'x' }));
    const d2 = again.devices[0]!;
    const real = importable.find((b) => b.name === 'FC100');
    if (!real) return skip();
    const fc100 = importedFrom(d2, real.bytes)!;
    // Le due CALL SFC 20 (reti 2 e 9) e, coi chiamati vuoti nel progetto già all'importazione,
    // la CALL senza parametri a uno di loro nella rete 2.
    expect(Object.keys(fc100.mc7!.code!.calls ?? {})).toEqual(['1:11', '1:12', '8:27']);
    const k = fc100.networks.findIndex(
      (n) => !hasRaw(n.source) && !hasCall(n.source) && !/#\w/.test(n.source),
    );
    expect(k).toBeGreaterThanOrEqual(0);
    fc100.networks[k]!.source += '\n\tNOP 0;';
    const out = blockToMc7File(fc100, d2, undefined, now);
    expect(errors(out.diagnostics)).toEqual([]);
    expect(callSpans(out.file!).map((x) => hex(x.bytes))).toEqual(
      callSpans(real.bytes).map((x) => hex(x.bytes)),
    );
  });

  it('esportazione senza modifiche dopo il lotto: identica per ogni blocco coerente col lotto', () => {
    const { device, plan } = batch();
    // Il corpus mescola progetti diversi. Due blocchi non valgono nel contesto del lotto: l'OB1 di
    // TIA usa DB1 come istanza di SFB 0, ma il DB1 del lotto è un DB globale di un'altra cattura;
    // FC1 passa un puntatore a FC 21, che nel lotto ha tre parametri.
    const incoherent = plan.notes.filter((n) => n.code === 'IMPORT_CONTESTO_INCOERENTE');
    if (importable.length >= 23) {
      expect(incoherent.map((n) => `${n.block}:${n.params?.['dep']}`).sort()).toEqual([
        'FC1:FC21',
        'OB1:DB1',
      ]);
    }
    const flagged = new Set(incoherent.map((n) => n.block));
    let same = 0;
    for (const b of device.blocks) {
      const out = blockToMc7File(b, device, cpu315pn, now);
      if (flagged.has(b.name)) {
        // modificato: si ricompila dal testo e i suoi controlli lo fermano
        expect(out.file, b.name).toBeUndefined();
        continue;
      }
      expect(out.diagnostics, b.name).toEqual([]);
      expect(hex(out.file!), b.name).toBe(b.mc7!.original);
      same++;
    }
    // i file saltati sono solo doppioni dello stesso tipo e numero
    for (const s of plan.skipped) expect(s.reason).toMatch(/presente più volte/);
    expect(same + flagged.size + plan.skipped.length).toBe(importable.length);
  });
});

describe('nomi, sostituzioni e applyImport', () => {
  function sourceFile(kind: 'FB' | 'DB' | 'IDB', number: number): Uint8Array {
    const newId = seq('z');
    const d = bareDevice(newId);
    const fb = createCodeBlock({ kind: 'FB', number: 5, name: 'Sorgente', language: 'AWL', newId });
    fb.interface.input.push({ id: newId(), name: 'A', type: 'Int', comment: '' });
    d.blocks.push(fb);
    const b: Block =
      kind === 'FB'
        ? { ...fb, number }
        : kind === 'DB'
          ? { ...createGlobalDb({ number, name: 'G', newId }) }
          : createInstanceDb({ number, name: 'I', instanceOf: 'Sorgente', newId });
    if (b.kind === 'DB') b.members.push({ id: newId(), name: 'V', type: 'Int', comment: '' });
    d.blocks.push(b);
    const r = blockToMc7File(b, d, cpu315pn, now);
    expect(r.file).toBeDefined();
    return r.file!;
  }

  it('un nome già usato da un altro oggetto: il blocco importato prende un nome libero', () => {
    const file = sourceFile('FB', 5);
    const d = bareDevice();
    d.tagTables[0]!.tags.push({
      id: 't1',
      name: 'FB5',
      type: 'Bool',
      address: '%M0.0',
      hmi: false,
      comment: '',
    });
    const other = createCodeBlock({ kind: 'FC', number: 9, name: 'FB5_1', language: 'AWL' });
    d.blocks.push(other);
    const plan = planImport(d, [file]);
    expect(plan.replace).toEqual([]);
    expect(plan.create[0]!.name).toBe('FB5_2');
  });

  it('stesso tipo e numero con un altro nome: replace e il nome esistente resta', () => {
    const file = sourceFile('FB', 5);
    const d = bareDevice();
    const ex = createCodeBlock({ kind: 'FB', number: 5, name: 'FB5', language: 'AWL' });
    ex.name = 'Motore';
    ex.group = 'G';
    d.blocks.push(ex);
    const plan = planImport(d, [file]);
    expect(plan.replace).toHaveLength(1);
    applyImport(d, plan);
    expect(d.blocks.map((b) => [b.id, b.name, b.group])).toEqual([[ex.id, 'Motore', 'G']]);
  });

  it('DB e IDB con lo stesso numero sono lo stesso posto: replace misto', () => {
    const d = bareDevice();
    const fbFile = sourceFile('FB', 5);
    const idbFile = sourceFile('IDB', 7);
    const dbFile = sourceFile('DB', 7);
    const g = createGlobalDb({ number: 7, name: 'Globale', newId: seq('g') });
    g.group = 'Q';
    d.blocks.push(g);
    const p1 = planImport(d, [idbFile, fbFile]);
    expect(p1.replace).toHaveLength(1);
    expect(p1.replace[0]!.incoming.kind).toBe('IDB');
    applyImport(d, p1);
    const idb = d.blocks.find((b) => b.number === 7)!;
    expect([idb.id, idb.name, idb.group, idb.kind]).toEqual([g.id, 'Globale', 'Q', 'IDB']);
    const p2 = planImport(d, [dbFile]);
    expect(p2.replace).toHaveLength(1);
    applyImport(d, p2);
    expect(d.blocks.find((b) => b.number === 7)!.kind).toBe('DB');
    expect(d.blocks.filter((b) => b.number === 7)).toHaveLength(1);
  });

  it('applyImport con un existing che non c è più lancia invece di aggiungere', () => {
    const file = sourceFile('FB', 5);
    const d = bareDevice();
    const ex = createCodeBlock({ kind: 'FB', number: 5, name: 'FB5', language: 'AWL' });
    d.blocks.push(ex);
    const plan = planImport(d, [file]);
    d.blocks = [];
    expect(() => applyImport(d, plan)).toThrow();
    expect(d.blocks).toEqual([]);
  });
});

describe('regola F: la fedeltà per rete richiede un contesto dei byte invariato', () => {
  const newId = seq('rf');
  const errorsOf = (d: Mc7Diagnostic[]) => d.filter((x) => x.severity === 'error');
  const codesOf = (d: Mc7Diagnostic[]) => d.map((x) => x.code);
  const member = (name: string, type: string, initial?: string): Member => ({
    id: newId(),
    name,
    type,
    comment: '',
    ...(initial !== undefined ? { initial } : {}),
  });
  const net = (source: string) => ({ id: newId(), title: '', comment: '', source });

  function code(
    kind: 'OB' | 'FB' | 'FC',
    number: number,
    name: string,
    networks: string[],
    iface: Partial<BlockInterface> = {},
  ): CodeBlock {
    const b = createCodeBlock({ kind, number, name, language: 'AWL', newId });
    Object.assign(b.interface, iface);
    b.networks = networks.map(net);
    return b;
  }
  /** FC20 "Somma": A (IN) → Q (OUT). */
  const somma = () =>
    code('FC', 20, 'Somma', ['L #A;\nT #Q;'], {
      input: [member('A', 'Int')],
      output: [member('Q', 'Int')],
    });

  /** I file che l'amico compila nel suo progetto. */
  function compiled(blocks: Block[]): Uint8Array[] {
    const d = bareDevice(newId);
    d.blocks.push(...blocks);
    return blocks.map((b) => {
      const r = blockToMc7File(b, d, cpu315pn, now);
      expect(errorsOf(r.diagnostics), b.name).toEqual([]);
      return r.file!;
    });
  }
  function imported(files: Uint8Array[], into: PlcDevice = bareDevice(newId)): PlcDevice {
    const plan = planImport(into, files, newId);
    expect(plan.skipped).toEqual([]);
    applyImport(into, plan);
    return into;
  }
  const find = (d: PlcDevice, tag: string): Block =>
    d.blocks.find((b) => `${b.kind}${b.number}` === tag)!;
  const exp = (d: PlcDevice, tag: string, at = now) =>
    blockToMc7File(find(d, tag), d, cpu315pn, at);
  /** Il codice decodificato senza risolutore: le CALL espanse, coi grezzi delle liste dei puntatori. */
  const text = (file: Uint8Array): string[] => decodeBlock(file).networks!;
  function networkHex(file: Uint8Array): string[] {
    const f = readBlockFile(file);
    let o = 0;
    return f.add.networks.map((n) => {
      const x = hex(f.mc7.subarray(o, o + n));
      o += n;
      return x;
    });
  }

  // FB10 "Motore" (In1; Cnt = 0, Spd = 5), il suo DB 11 e l'OB1 che lo chiama
  const motore = () =>
    code('FB', 10, 'Motore', ['L #In1;\nL #Spd;\n+I;\nT #Cnt;'], {
      input: [member('In1', 'Int')],
      static: [member('Cnt', 'Int', '0'), member('Spd', 'Int', '5')],
    });
  /** FB, IDB col valore attuale di Spd = 99 (16#63) e OB1, compilati dall'amico e importati. */
  function motorProgram() {
    const fb = motore();
    const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
    const ob = code('OB', 1, 'Main', ['CALL "Motore", "Motore_DB" (In1 := 7);']);
    const [fF, fI, fO] = compiled([fb, idb, ob]);
    const actual = fI!.slice();
    actual[36 + 5] = 0x63;
    const d = imported([fF!, actual, fO!]);
    return { d, fF: fF!, fI: actual, fO: fO!, fb: find(d, 'FB10') as CodeBlock };
  }

  it('p1: rinominare FB, ingresso e statica con i riferimenti non modifica nulla; il DB di istanza tiene i valori attuali', () => {
    const { d, fF, fI, fO, fb } = motorProgram();
    const ref = (m: Member) =>
      ({
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: fb.id,
        memberId: m.id,
      }) as const;
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: fb.id }, 'Motore2');
    renameWithReferences(d, ref(fb.interface.input[0]!), 'Ingresso');
    renameWithReferences(d, ref(fb.interface.static[1]!), 'Velocita');
    // I riferimenti sono cambiati davvero: DB di istanza e parametro della CALL dell'OB1
    const idb = find(d, 'IDB11');
    expect(idb.kind === 'IDB' && idb.instanceOf).toBe('Motore2');
    expect((find(d, 'OB1') as CodeBlock).networks[0]!.source).toContain('Ingresso := 7');
    for (const [tag, file] of [
      ['FB10', fF],
      ['IDB11', fI],
      ['OB1', fO],
    ] as const) {
      const r = exp(d, tag);
      expect(r.diagnostics, tag).toEqual([]);
      expect(hex(r.file!), tag).toBe(hex(file));
    }
    expect(hex(readBlockFile(exp(d, 'IDB11').file!).mc7)).toBe('000000000063');
  });

  it('p1: un ingresso nuovo in testa all FB importato rigenera il DB di istanza (avviso) e ricompila la CALL al nuovo offset', () => {
    const { d, fO, fb } = motorProgram();
    fb.interface.input.unshift(member('Nuovo', 'Int'));
    const ri = exp(d, 'IDB11');
    expect(codesOf(ri.diagnostics)).toEqual(['VALORI_ATTUALI_PERSI']);
    // Nuovo 0, IN0 2, STAT0 4, STAT1 6 = 5: valori iniziali, il 99 non c'è più
    expect(hex(readBlockFile(ri.file!).mc7)).toBe('0000000000000005');
    const ro = exp(d, 'OB1');
    expect(errorsOf(ro.diagnostics)).toEqual([]);
    expect(text(fO)[0]).toContain('T %DIW0;');
    expect(text(ro.file!)[0]).toContain('T %DIW2;');
  });

  it('p2 (regola S): FB e FC scritti nel progetto sono estranei: OB1 si ricompila dal testo, il DB di istanza è bloccato', () => {
    const ob = code('OB', 1, 'Main', [
      'CALL "Motore", "Motore_DB" (In1 := 7);',
      'CALL "Somma" (A := MW 10, Q := MW 12);',
    ]);
    const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
    const [, , fI, fO] = compiled([motore(), somma(), idb, ob]);
    // Il progetto dell'utente ha gli stessi FB e FC, scritti a mano; importa OB1 e DB 11.
    const d = bareDevice(newId);
    const myFb = motore();
    const myFc = somma();
    d.blocks.push(myFb, myFc);
    const { notes } = importNoting([fI!, fO!], d, 'DIPENDENZA_ESTRANEA');
    // Nulla prova che FB 10 e FC 20 del progetto siano quelli per cui l'amico ha compilato
    expect(notes.sort()).toEqual(['DB11:FB10', 'OB1:FB10', 'OB1:FC20']);
    const results = () => {
      const { results } = compileDevice(d, cpu315pn, undefined, now);
      const at = (tag: string) => results.find((r) => r.blockId === find(d, tag).id)!;
      return { ob1: at('OB1'), idb: at('IDB11') };
    };
    let r = results();
    // OB1 si ricompila dalle CALL ricostruite contro i blocchi del progetto: stessi byte delle reti
    expect(errorsOf(r.ob1.diagnostics)).toEqual([]);
    expect(networkHex(r.ob1.file!)).toEqual(networkHex(fO!));
    // Il DB di istanza non si rigenera da un FB estraneo: bloccato, errore che nomina l'FB
    expect(r.idb.file).toBeUndefined();
    expect(r.idb.diagnostics.map((x) => [x.code, x.params?.['fb']])).toEqual([
      ['IDB_INCOERENTE', 'FB10'],
    ]);

    // L'FB cambia: la CALL si ricompila al nuovo offset
    myFb.interface.input.unshift(member('Abil', 'Int'));
    r = results();
    expect(errorsOf(r.ob1.diagnostics)).toEqual([]);
    expect(text(r.ob1.file!)[0]).toContain('T %DIW2;');
    expect(networkHex(r.ob1.file!)[1]).toBe(networkHex(fO!)[1]);
    expect(networkHex(r.ob1.file!)[0]).not.toBe(networkHex(fO!)[0]);

    // Anche la FC ha un ingresso in più: la CALL senza quel parametro è un errore
    myFc.interface.input.unshift(member('B', 'Int'));
    r = results();
    expect(r.ob1.file).toBeUndefined();
    expect(codesOf(errorsOf(r.ob1.diagnostics))).toContain('CALL_PARAM_MISSING');
  });

  // FC1 con un TEMP e una CALL della FC 20 in mezzo
  const main = (temp: Member[] = [member('t1', 'Int')], second = 'L #t1;\nT MW 0;') =>
    code('FC', 1, 'Main', ['L 1;\nT MW 2;', 'CALL "Somma" (A := 5, Q := #t1);', second], { temp });

  it('p3: un TEMP nuovo: la rete della CALL invariata si ricompila e non sovrascrive il temporaneo nuovo', () => {
    const files = compiled([somma(), main()]);
    const d = imported(files);
    const b = find(d, 'FC1') as CodeBlock;
    expect(b.networks[1]!.source).toContain('CALL %FC20');
    expect(text(files[1]!)[1]).toContain('T %LW2;'); // prima: la copia di A in LW2
    b.interface.temp.push(member('t2', 'Int'));
    b.networks[0]!.source = 'L 42;\nT #t2;';
    b.networks[2]!.source += '\nL #t2;\nT MW 4;';
    const r = exp(d, 'FC1');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const t = text(r.file!);
    expect(t[0]).toContain('T %LW2;'); // t2
    expect(t[1]).toContain('T %LW4;'); // la copia di A dopo i TEMP
    expect(t[1]).not.toContain('T %LW2;');
    expect(t[1]).toContain('87 00 00 20'); // puntatore a L 4.0
    expect(readBlockFile(r.file!).header.localDataLength).toBe(6);
  });

  it('p4: una STAT nuova in testa all FB importato: la CALL invariata legge e scrive ai nuovi offset', () => {
    const fb = code('FB', 10, 'Motore', ['CALL "Somma" (A := #Cnt, Q := #Spd);'], {
      static: [member('Cnt', 'Int'), member('Spd', 'Int')],
    });
    const files = compiled([somma(), fb]);
    const d = imported(files);
    const b = find(d, 'FB10') as CodeBlock;
    expect(b.networks[0]!.source).toContain('#STAT0');
    expect(text(files[1]!)[0]).toContain('L %DIW[AR2,P#0.0];');
    b.interface.static.unshift(member('Nuovo', 'Int'));
    const r = exp(d, 'FB10');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const t = text(r.file!)[0]!;
    expect(t).toContain('L %DIW[AR2,P#2.0];');
    expect(t).toContain('T %DIW[AR2,P#4.0];');
    expect(t).not.toContain('P#0.0];');
  });

  it('ACCESSO_ASSOLUTO_ISTANZA: layout dell FB cambiato e accessi assoluti all area d istanza nel testo', () => {
    const { d, fb } = motorProgram();
    // il testo importato accede all'istanza in modo assoluto
    expect(fb.networks[0]!.source).toMatch(/%DI[BWD]?\[AR2,P#/);
    // invariato: nessun avviso
    expect(exp(d, 'FB10').diagnostics).toEqual([]);
    // un membro nuovo in testa: le reti si ricompilano com'è scritto, con l'avviso
    fb.interface.static.unshift(member('Nuovo', 'Int'));
    const r = exp(d, 'FB10');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(r.file).toBeDefined();
    const w = r.diagnostics.filter((x) => x.code === 'ACCESSO_ASSOLUTO_ISTANZA');
    expect(w.map((x) => [x.severity, x.network, x.line])).toEqual([['warning', 1, 1]]);
    expect(w[0]!.message).toContain("l'interfaccia è cambiata");
    // solo il layout proprio conta: una rete cambiata, ma con layout invariato, non dà avvisi
    const { d: d2, fb: fb2 } = motorProgram();
    fb2.networks[0]!.source += '\nNOP 0;';
    expect(exp(d2, 'FB10').diagnostics.map((x) => x.code)).toEqual([]);
  });

  it('p6: un TEMP inutilizzato tolto: dati locali ricalcolati, la CALL usa i temporanei nuovi', () => {
    const fc = code('FC', 1, 'Main', ['CALL "Somma" (A := 5, Q := #t1);', 'L #t1;\nT MW 0;'], {
      temp: [member('t1', 'Int'), member('big', 'Array[0..9] of DInt')],
    });
    const files = compiled([somma(), fc]);
    expect(readBlockFile(files[1]!).header.localDataLength).toBe(44);
    const d = imported(files);
    const b = find(d, 'FC1') as CodeBlock;
    b.interface.temp.splice(1, 1);
    const r = exp(d, 'FC1');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(readBlockFile(r.file!).header.localDataLength).toBe(4);
    const t = text(r.file!)[0]!;
    expect(t).toContain('T %LW2;');
    expect(t).toContain('87 00 00 10'); // puntatore a L 2.0
    expect(t).not.toContain('LW42');
  });

  it('p9: FC importata coi parametri: reti aggiunte o cambiate, commenti, rinomina dei parametri', () => {
    const fc = somma();
    fc.networks.push(net('L #A;\nT MW 0;'));
    const [f] = compiled([fc]);
    const orig = networkHex(f!);
    const fresh = () => {
      const d = imported([f!]);
      return { d, b: find(d, 'FC20') as CodeBlock };
    };
    const ref = (d: PlcDevice, b: CodeBlock, m: Member) =>
      ({
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: b.id,
        memberId: m.id,
      }) as const;
    {
      // una rete in più: le due originali tengono i byte (prima: UNKNOWN_LOCAL PAR0)
      const { d, b } = fresh();
      b.networks.push(net('NOP 0;'));
      const r = exp(d, 'FC20');
      expect(errorsOf(r.diagnostics)).toEqual([]);
      expect(networkHex(r.file!).slice(0, 2)).toEqual(orig);
      expect(networkHex(r.file!)).toHaveLength(3);
    }
    {
      // solo la rete 2 cambia: la rete 1 tiene i byte
      const { d, b } = fresh();
      b.networks[1]!.source = 'L #IN0;\nT MW 2;';
      const r = exp(d, 'FC20');
      expect(errorsOf(r.diagnostics)).toEqual([]);
      expect(networkHex(r.file!)[0]).toBe(orig[0]);
      expect(text(r.file!)[1]).toContain('T %MW2;');
    }
    {
      // solo commenti: il blocco non è modificato
      const { d, b } = fresh();
      b.networks[0]!.source = `// nota\n${b.networks[0]!.source} // fine`;
      const r = exp(d, 'FC20');
      expect(r.diagnostics).toEqual([]);
      expect(hex(r.file!)).toBe(hex(f!));
    }
    {
      // rinomina di un parametro coi riferimenti: il blocco non è modificato
      const { d, b } = fresh();
      renameWithReferences(d, ref(d, b, b.interface.input[0]!), 'Velocita');
      expect(b.networks[0]!.source).toContain('#Velocita');
      const r = exp(d, 'FC20');
      expect(r.diagnostics).toEqual([]);
      expect(hex(r.file!)).toBe(hex(f!));
    }
    {
      // nomi nuovi uguali ai formali scambiati (#PAR0 è il primo parametro) e una rete in più:
      // le reti invariate usano il testo originale coi formali dei metadati, byte esatti
      const { d, b } = fresh();
      renameWithReferences(d, ref(d, b, b.interface.input[0]!), 'PAR1');
      renameWithReferences(d, ref(d, b, b.interface.output[0]!), 'PAR0');
      b.networks.push(net('NOP 0;'));
      const r = exp(d, 'FC20');
      expect(errorsOf(r.diagnostics)).toEqual([]);
      expect(networkHex(r.file!).slice(0, 2)).toEqual(orig);
    }
  });

  it('M1: un commento in una rete con istruzioni grezze la lascia invariata', () => {
    const files = compiled([somma(), main()]);
    // Importata da sola: la FC 20 non c'è, la CALL resta espansa col grezzo della lista dei puntatori
    const d = imported([files[1]!]);
    const b = find(d, 'FC1') as CodeBlock;
    expect(b.networks[1]!.source).toMatch(/MC7 grezzo/);
    b.networks[1]!.source = `// somma\n${b.networks[1]!.source.replace('BLD 1;', 'BLD 1; // apre')}`;
    const r = exp(d, 'FC1');
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.file!)).toBe(hex(files[1]!));
    // Con un'altra rete cambiata la rete commentata tiene i suoi byte
    b.networks[2]!.source += '\nNOP 0;';
    const r2 = exp(d, 'FC1');
    expect(errorsOf(r2.diagnostics)).toEqual([]);
    expect(networkHex(r2.file!)[1]).toBe(networkHex(files[1]!)[1]);
  });

  it('RAW_CONTESTO_CAMBIATO: grezzi in una rete invariata con interfaccia o chiamato cambiati', () => {
    const files = compiled([somma(), main()]);
    const why = (r: { diagnostics: Mc7Diagnostic[] }) =>
      errorsOf(r.diagnostics).map((x) => [
        x.code,
        x.network,
        x.params?.['reason'],
        x.params?.['callee'],
      ]);
    {
      const d = imported([files[1]!]);
      (find(d, 'FC1') as CodeBlock).interface.temp.push(member('t2', 'Int'));
      const r = exp(d, 'FC1');
      expect(r.file).toBeUndefined();
      expect(why(r)).toEqual([['RAW_CONTESTO_CAMBIATO', 2, 'interface', undefined]]);
    }
    {
      // la FC 20 assente all'importazione e aggiunta dopo: il blocco non è più quello originale
      const d = imported([files[1]!]);
      d.blocks.push(somma());
      const r = exp(d, 'FC1');
      expect(r.file).toBeUndefined();
      expect(why(r)).toEqual([['RAW_CONTESTO_CAMBIATO', 2, 'callee', 'FC20']]);
    }
    {
      // un nuovo accesso assoluto all'area L oltre la base dei temporanei delle CALL
      const d = imported([files[1]!]);
      (find(d, 'FC1') as CodeBlock).networks[2]!.source = 'L 9;\nT LW 10;';
      const r = exp(d, 'FC1');
      expect(why(r)).toEqual([['RAW_CONTESTO_CAMBIATO', 2, 'localData', undefined]]);
    }
  });

  it('dati locali: un accesso assoluto oltre la base delle CALL ricompila anche la CALL invariata', () => {
    const files = compiled([somma(), main()]);
    const d = imported(files);
    const b = find(d, 'FC1') as CodeBlock;
    b.networks[2]!.source = `L 9;\nT LW 10;\nL #${b.interface.temp[0]!.name};\nT MW 0;`;
    const r = exp(d, 'FC1');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const t = text(r.file!)[1]!;
    expect(t).toContain('T %LW12;'); // la copia di A dopo LW10
    expect(t).not.toContain('T %LW2;');
  });

  it('metadati senza impronte (versione di sviluppo): il blocco conta come modificato', () => {
    const files = compiled([somma(), main()]);
    {
      const d = imported([files[1]!]);
      delete find(d, 'FC1').mc7!.fidelity;
      const r = exp(d, 'FC1');
      expect(r.file).toBeUndefined();
      expect(errorsOf(r.diagnostics).map((x) => [x.code, x.params?.['reason']])).toEqual([
        ['RAW_CONTESTO_CAMBIATO', 'unknown'],
      ]);
    }
    {
      const d = imported([files[0]!]);
      const later = new Date('2026-10-19T08:00:00.000Z');
      expect(hex(exp(d, 'FC20', later).file!)).toBe(hex(files[0]!));
      delete find(d, 'FC20').mc7!.fidelity;
      const r = exp(d, 'FC20', later);
      expect(r.diagnostics).toEqual([]);
      // ricompilato: il tempo del codice è quello nuovo
      expect(hex(readBlockFile(r.file!).header.codeTime)).not.toBe(
        hex(readBlockFile(files[0]!).header.codeTime),
      );
      // impronte senza la forma giusta (progetto modificato a mano): come assenti, nessun INTERNAL
      find(d, 'FC20').mc7!.fidelity = { block: 'x', networks: 3 } as never;
      expect(hex(exp(d, 'FC20', later).file!)).toBe(hex(r.file!));
    }
  });

  it('DB globale: rinominare un membro generato non lo modifica; un valore iniziale nuovo sì (avviso)', () => {
    const db = createGlobalDb({ number: 5, name: 'Dati', newId });
    db.members.push(member('A', 'Int', '3'), member('B', 'Real', '1.5'));
    const [f] = compiled([db]);
    const actual = f!.slice();
    actual[36 + 1] = 9; // valore attuale di A
    const d = imported([actual]);
    const g = find(d, 'DB5') as GlobalDb;
    renameWithReferences(
      d,
      {
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: g.id,
        memberId: g.members[0]!.id,
      },
      'Livello',
    );
    const r = exp(d, 'DB5');
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.file!)).toBe(hex(actual));
    g.members[1]!.initial = '2.5';
    const r2 = exp(d, 'DB5');
    expect(codesOf(r2.diagnostics)).toEqual(['VALORI_ATTUALI_PERSI']);
    expect(readBlockFile(r2.file!).mc7[1]).toBe(3);
  });
  it('know-how (spec): il blocco protetto si importa solo come interfaccia, bloccato; si esporta con i byte originali', () => {
    const fb = code('FB', 30, 'Segreto', ['L #In1;\nL MW 777;\n+I;\nT #Cnt;'], {
      input: [member('In1', 'Int')],
      static: [member('Cnt', 'Int', '0')],
    });
    fb.knowHowProtected = true;
    const [file] = compiled([fb]);
    expect(readBlockFile(file!).header.knowHowProtected).toBe(true);
    // decodeBlock: nessun codice, interfaccia sì, byte originali
    const dec = decodeBlock(file!);
    expect(dec.networks).toBeUndefined();
    expect(dec.meta.code).toBeUndefined();
    expect(dec.iface.elements).toHaveLength(2);
    expect(dec.exact).toBe(true);

    const dev = bareDevice(newId);
    const plan = planImport(dev, [file!], newId);
    expect(plan.skipped).toEqual([]);
    expect(plan.notes.map((n) => [n.block, n.code])).toEqual([
      ['FB30', 'BLOCCO_PROTETTO_KNOW_HOW'],
    ]);
    applyImport(dev, plan);
    const b = find(dev, 'FB30') as CodeBlock;
    expect(b.knowHowProtected).toBe(true);
    // interfaccia: i membri; codice: nessuna rete con testo
    expect(b.interface.input).toHaveLength(1);
    expect(b.interface.static).toHaveLength(1);
    expect(b.networks.map((n) => n.source)).toEqual(['']);
    // bloccato (sola lettura) e senza il codice in nessuna forma decodificata
    expect(b.mc7!.knowHowLocked).toBe(true);
    expect(b.mc7!.exact).toBe(false);
    expect(b.mc7!.code).toBeUndefined();
    const json = JSON.stringify(b);
    expect(json).not.toContain('777');
    expect(json).not.toMatch(/MW/);
    // l'esportazione restituisce i byte originali, anche dopo aver rinominato il blocco
    expect(hex(exp(dev, 'FB30').file!)).toBe(hex(file!));
    b.name = 'Altro';
    expect(hex(exp(dev, 'FB30').file!)).toBe(hex(file!));
    // salva e riapri
    const proj = makeProject();
    proj.devices[0] = dev;
    const again = readBaap(writeBaap(proj, { appVersion: 'x' })).devices[0]!;
    const b2 = again.blocks.find((x) => x.number === 30) as CodeBlock;
    expect(b2.mc7!.knowHowLocked).toBe(true);
    expect(hex(blockToMc7File(b2, again, cpu315pn, now).file!)).toBe(hex(file!));
  });

  it('DB con SSB di genere 0x10: importato in sola lettura, senza membri, coi byte originali', () => {
    const db = createGlobalDb({ number: 9, name: 'Dati', newId });
    db.members.push(member('A', 'Int', '3'));
    const [file] = compiled([db]);
    const f = readBlockFile(file!);
    const bytes = file!.slice();
    bytes[36 + f.mc7.length] = 0x10; // genere dell'SSB
    expect(decodeBlock(bytes).exact).toBe(true);
    const dev = bareDevice(newId);
    const plan = planImport(dev, [bytes], newId);
    expect(plan.skipped).toEqual([]);
    expect(plan.notes.map((n) => [n.block, n.code, n.params?.['genre']])).toEqual([
      ['DB9', 'DB_GENERE_NON_GESTITO', '0x10'],
    ]);
    applyImport(dev, plan);
    const g = find(dev, 'DB9') as GlobalDb;
    expect(g.members).toEqual([]);
    expect(g.mc7!.exact).toBe(false);
    expect(hex(exp(dev, 'DB9').file!)).toBe(hex(bytes));
  });
  // --- A3: i byte importati devono valere nel contesto del progetto -----------------------------

  /** Importa e restituisce dispositivo e note `IMPORT_CONTESTO_INCOERENTE` (`<blocco>:<dipendenza>`). */
  function importNoting(
    files: Uint8Array[],
    into: PlcDevice,
    code: string = 'IMPORT_CONTESTO_INCOERENTE',
  ) {
    const plan = planImport(into, files, newId);
    expect(plan.skipped).toEqual([]);
    applyImport(into, plan);
    const notes = plan.notes
      .filter((n) => n.code === code)
      .map((n) => `${n.block}:${n.params?.['dep']}`);
    return { d: into, notes };
  }

  it('regola S: DB di istanza senza il suo FB nel lotto è bloccato; col suo FB nel lotto vale, anche se l FB è cambiato no', () => {
    const fb = (input: Member[]) =>
      code('FB', 10, 'Motore', ['L #In1;\nT #Cnt;'], { input, static: [member('Cnt', 'Int')] });
    const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
    const [fF, fI] = compiled([fb([member('In1', 'Int')]), idb]);
    // Nel progetto un FB 10 scritto a mano, diverso o uguale: estraneo in entrambi i casi
    for (const input of [[member('Abil', 'Int'), member('In1', 'Int')], [member('In1', 'Int')]]) {
      const into = bareDevice(newId);
      into.blocks.push(fb(input));
      const { d, notes } = importNoting([fI!], into, 'DIPENDENZA_ESTRANEA');
      expect(notes).toEqual(['DB11:FB10']);
      const idbIn = find(d, 'IDB11');
      expect(idbIn.mc7!.exact).toBe(false);
      expect(idbIn.mc7!.original).toBe(hex(fI!));
      const r = exp(d, 'IDB11');
      expect(r.file).toBeUndefined();
      expect(r.diagnostics.map((x) => [x.code, x.params?.['fb']])).toEqual([
        ['IDB_INCOERENTE', 'FB10'],
      ]);
      // instanceOf cambiato: il messaggio nomina l'FB di adesso
      into.blocks.push(code('FB', 12, 'Altro', ['NOP 0;']));
      const i2 = find(d, 'IDB11');
      if (i2.kind === 'IDB') i2.instanceOf = 'Altro';
      expect(exp(d, 'IDB11').diagnostics.map((x) => x.params?.['fb'])).toEqual(['FB12']);
    }
    // FB e DB dello stesso lotto: fidati, identici
    const ok = importNoting([fF!, fI!], bareDevice(newId));
    expect(ok.notes).toEqual([]);
    expect(hex(exp(ok.d, 'IDB11').file!)).toBe(hex(fI!));
    // Stesso lotto ma l'FB è cambiato dopo il DB (conflitto di data e ora): incoerente, bloccato
    const [fF2] = compiled([fb([member('Abil', 'Int'), member('In1', 'Int')])]);
    const bad = importNoting([fF2!, fI!], bareDevice(newId));
    expect(bad.notes).toEqual(['DB11:FB10']);
    expect(find(bad.d, 'IDB11').mc7!.exact).toBe(false);
    expect(exp(bad.d, 'IDB11').diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
  });

  it('regola S: un chiamato del progetto è estraneo (INT contro DINT): la rete si ricompila dal testo, onestamente', () => {
    const fc20 = (input: Member[]) =>
      code('FC', 20, 'Somma', ['NOP 0;'], { input, output: [member('Q', 'Int')] });
    const ob = code('OB', 1, 'Main', ['CALL "Somma" (A := MW 10, Q := MW 12);']);
    // L'amico: FC 20 con A INT, OB1 passa MW 10
    const [fC, fO] = compiled([fc20([member('A', 'Int')]), ob]);
    const into = (input: Member[]) => {
      const dev = bareDevice(newId);
      dev.blocks.push(fc20(input));
      return importNoting([fO!], dev, 'DIPENDENZA_ESTRANEA');
    };
    const later = new Date('2026-10-19T08:00:00.000Z');
    // La FC del progetto ha A DINT: la CALL si ricostruisce coi suoi tipi (A := MD 10), stessi
    // byte; ma nulla lo prova, quindi OB1 non tiene i byte originali e si ricompila da quel testo
    {
      const { d, notes } = into([member('A', 'DInt')]);
      expect(notes).toEqual(['OB1:FC20']);
      const src = (find(d, 'OB1') as CodeBlock).networks[0]!.source;
      expect(src).toContain('A := %MD10');
      const r = exp(d, 'OB1', later);
      expect(errorsOf(r.diagnostics)).toEqual([]);
      expect(hex(readBlockFile(r.file!).header.codeTime)).not.toBe(
        hex(readBlockFile(fO!).header.codeTime),
      );
    }
    // Tre parametri: la CALL non si ricostruisce, il grezzo resta e non vale
    {
      const { d, notes } = into([member('A', 'Int'), member('B', 'Int')]);
      expect(notes).toEqual(['OB1:FC20']);
      expect((find(d, 'OB1') as CodeBlock).networks[0]!.source).toMatch(/MC7 grezzo/);
      const r = exp(d, 'OB1');
      expect(r.file).toBeUndefined();
      expect(
        errorsOf(r.diagnostics).map((x) => [x.code, x.params?.['reason'], x.params?.['callee']]),
      ).toEqual([['RAW_CONTESTO_CAMBIATO', 'foreign', 'FC20']]);
    }
    // La FC nello stesso lotto: fidata, identica; con tre parametri nel lotto: incoerente
    expect(hex(exp(importNoting([fC!, fO!], bareDevice(newId)).d, 'OB1').file!)).toBe(hex(fO!));
    const [fC3] = compiled([fc20([member('A', 'Int'), member('B', 'Int')])]);
    expect(importNoting([fC3!, fO!], bareDevice(newId)).notes).toEqual(['OB1:FC20']);
  });

  it('regola S: multi-istanza di un FB del progetto estranea (layout e SSB rifatti); nel lotto vale, se discorde è incoerente', () => {
    const inner = (statics: Member[]) =>
      code('FB', 10, 'Dentro', ['L #a;\nT MW 0;'], {
        input: [member('a', 'Int')],
        static: statics,
      });
    const outer = code('FB', 20, 'Fuori', ['CALL #m1 (a := 1);\nL #k2;\nT MW 2;'], {
      static: [member('m1', '"Dentro"'), member('k2', 'Int')],
    });
    const [fIn, fO] = compiled([inner([member('b', 'Int')]), outer]);
    const ssbOf = (f: Uint8Array) => hex(readBlockFile(f).ssb);
    // FB 10 scritto nel progetto (con un DINT in più, o uguale): estraneo
    for (const statics of [[member('b', 'Int'), member('c', 'DInt')], [member('b', 'Int')]]) {
      const dev = bareDevice(newId);
      dev.blocks.push(inner(statics));
      const { d, notes } = importNoting([fO!], dev, 'DIPENDENZA_ESTRANEA');
      expect(notes).toEqual(['FB20:FB10']);
      const later = new Date('2026-10-19T08:00:00.000Z');
      const r = exp(d, 'FB20', later);
      expect(r.file).toBeDefined();
      // ricompilato (tempo del codice nuovo), con l'SSB dal modello e l'FB 10 del progetto
      expect(hex(readBlockFile(r.file!).header.codeTime)).not.toBe(
        hex(readBlockFile(fO!).header.codeTime),
      );
      if (statics.length === 2) expect(ssbOf(r.file!)).not.toBe(ssbOf(fO!));
    }
    // FB 10 nello stesso lotto: fidato, identico
    const ok = importNoting([fIn!, fO!], bareDevice(newId));
    expect(ok.notes).toEqual([]);
    expect(hex(exp(ok.d, 'FB20').file!)).toBe(hex(fO!));
    // Nel lotto un FB 10 più nuovo di FB 20: incoerente
    const [fIn2] = compiled([inner([member('b', 'Int'), member('c', 'DInt')])]);
    const bad = importNoting([fIn2!, fO!], bareDevice(newId));
    expect(bad.notes).toEqual(['FB20:FB10']);
    expect(hex(exp(bad.d, 'FB20').file!)).not.toBe(hex(fO!));
  });

  it('A3: il DB di istanza di una CALL è una dipendenza (istanza di un altro FB, cancellato, rinumerato)', () => {
    const fb12 = () =>
      code('FB', 12, 'Altro', ['NOP 0;'], { input: [member('x', 'Int'), member('y', 'Int')] });
    const fresh = () => {
      const { d } = motorProgram();
      d.blocks.push(fb12());
      return d;
    };
    const origOb = (d: PlcDevice) => find(d, 'OB1').mc7!.original;
    {
      const d = fresh();
      expect(hex(exp(d, 'OB1').file!)).toBe(origOb(d));
      const idb = find(d, 'IDB11');
      if (idb.kind === 'IDB') idb.instanceOf = 'Altro';
      const r = exp(d, 'OB1');
      expect(r.file === undefined || hex(r.file) !== origOb(d)).toBe(true);
      expect(codesOf(errorsOf(r.diagnostics))).toContain('CALL_INSTANCE_WRONG');
    }
    {
      const d = fresh();
      d.blocks = d.blocks.filter((b) => b.kind !== 'IDB');
      const r = exp(d, 'OB1');
      expect(r.file === undefined || hex(r.file) !== origOb(d)).toBe(true);
    }
    {
      const d = fresh();
      find(d, 'IDB11').number = 12;
      const r = exp(d, 'OB1');
      expect(r.file === undefined || hex(r.file) !== origOb(d)).toBe(true);
    }
    // All'importazione: il DB 11 del progetto è un DB globale, l'OB1 lo usa come istanza
    {
      const fb = motore();
      const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
      const ob = code('OB', 1, 'Main', ['CALL "Motore", "Motore_DB" (In1 := 7);']);
      const [, , fO] = compiled([fb, idb, ob]);
      const dev = bareDevice(newId);
      dev.blocks.push(motore(), createGlobalDb({ number: 11, name: 'Dati', newId }));
      const { d, notes } = importNoting([fO!], dev, 'DIPENDENZA_ESTRANEA');
      expect(notes.sort()).toEqual(['OB1:DB11', 'OB1:FB10']);
      const r = exp(d, 'OB1');
      expect(r.file).toBeUndefined();
      expect(codesOf(errorsOf(r.diagnostics))).toContain('CALL_INSTANCE_WRONG');
    }
  });

  it('A3: i membri interni di un percorso (#s.b) contano per posizione nel tipo risolto', () => {
    const fc = code('FC', 7, 'Strutture', ['L #s.b;\nT MW 0;'], {
      temp: [
        {
          ...member('s', 'Struct'),
          members: [member('a', 'Int'), member('b', 'Int')],
        },
      ],
    });
    const d = bareDevice(newId);
    d.blocks.push(fc);
    const hash = () => mc7FidelityOf(fc, d).networks[0];
    const before = hash();
    const s0 = fc.interface.temp[0]!;
    const ref = (m: Member) =>
      ({
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: fc.id,
        memberId: m.id,
      }) as const;
    // nomi scambiati coi riferimenti: #s.b diventa #s.a ma è sempre il secondo membro
    renameWithReferences(d, ref(s0.members![0]!), 'z');
    renameWithReferences(d, ref(s0.members![1]!), 'a');
    expect(fc.networks[0]!.source).toContain('#s.a');
    expect(hash()).toBe(before);
    // un altro membro: proiezione diversa
    fc.networks[0]!.source = 'L #s.z;\nT MW 0;';
    expect(hash()).not.toBe(before);
  });

  // --- A4/A5: mai un layout o un significato dei puntatori che non si possa verificare ---------

  it('regola S: nessuna euristica sui tipi dei puntatori: FC del lotto con un UDT e READ_CLK (DT) si esportano identici', () => {
    // FC 30 del lotto con un IN_OUT di tipo UDT (nell'SSB una STRUCT); la chiamata grezza ha un
    // puntatore come il suo unico parametro: si conta, non si indovina il formato
    const friend = bareDevice(newId);
    friend.udts.push({
      ...createUdt({ name: 'Udt1', number: 1, newId }),
      members: [member('a', 'Int'), member('b', 'Real')],
    });
    const f30 = code('FC', 30, 'F', ['NOP 0;'], { inOut: [member('u', '"Udt1"')] });
    friend.blocks.push(f30);
    const fF = blockToMc7File(f30, friend, cpu315pn, now).file!;
    const other = bareDevice(newId);
    const f30int = code('FC', 30, 'F', ['NOP 0;'], { input: [member('p', 'Int')] });
    const ob = code('OB', 1, 'Main', ['CALL "F" (p := MW 10);']);
    other.blocks.push(f30int, ob);
    const fO = blockToMc7File(ob, other, cpu315pn, now).file!;
    const a = importNoting([fF, fO], bareDevice(newId));
    expect(a.notes).toEqual([]);
    expect((find(a.d, 'OB1') as CodeBlock).networks[0]!.source).toMatch(/MC7 grezzo/);
    expect(hex(exp(a.d, 'OB1').file!)).toBe(hex(fO));
    // SFC 1 READ_CLK: RET_VAL e CDT (DT) nella lista dei puntatori, grezza; firmware: fidata
    const raw = '\t// MC7 grezzo: fb 74 00 01 70 0b 00 06 87 00 00 00 87 00 00 10';
    const dev = bareDevice(newId);
    const main = code('OB', 1, 'Main', [raw]);
    dev.blocks.push(main);
    const r = compileBlock({
      kind: 'OB',
      number: 1,
      knowHowProtected: false,
      header: { author: '', family: '', name: '', version: '0.1' },
      sections: { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] },
      initials: {},
      networks: [raw],
      ctx: createAwlContext(dev, main.id, cpu315pn),
      now,
      codeMeta: {
        raws: [{ network: 0, offset: 0, bytes: raw.split(': ')[1]! }],
        constantTypes: {},
        networkTexts: [raw],
        localData: 10,
      },
    });
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const b = importNoting([r.file!], bareDevice(newId));
    expect(b.notes).toEqual([]);
    expect(hex(exp(b.d, 'OB1').file!)).toBe(hex(r.file!));
  });

  it('regola S: doppione identico di un blocco del progetto: resta com è e vale come fidato', () => {
    const { d, fF, fI } = motorProgram();
    const fb = find(d, 'FB10') as CodeBlock;
    // l'utente rinomina un membro generato: il blocco non è modificato (regola F)
    renameWithReferences(
      d,
      {
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: fb.id,
        memberId: fb.interface.input[0]!.id,
      },
      'Ingresso',
    );
    // Un nuovo OB2 che chiama l'FB 10, importato insieme a una copia identica dell'FB 10
    const friend = bareDevice(newId);
    const fb10 = motore();
    const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
    const ob2 = code('OB', 2, 'Altro', ['CALL "Motore", "Motore_DB" (In1 := 8);']);
    friend.blocks.push(fb10, idb, ob2);
    const fO2 = blockToMc7File(ob2, friend, cpu315pn, now).file!;
    const plan = planImport(d, [fF, fI, fO2], newId);
    // FB 10 e DB 11 del progetto restano (coi nomi dell'utente), i doppioni si saltano
    expect(plan.skipped.map((x) => x.reason)).toEqual([
      'FB10: già nel progetto con gli stessi byte',
      'DB11: già nel progetto con gli stessi byte',
    ]);
    applyImport(d, plan);
    expect((find(d, 'FB10') as CodeBlock).interface.input[0]!.name).toBe('Ingresso');
    expect(
      plan.notes.filter((n) => n.code === 'DIPENDENZA_ESTRANEA').map((n) => n.params?.['dep']),
    ).toEqual([]);
    expect(hex(exp(d, 'OB2').file!)).toBe(hex(fO2));
  });

  // TON "reale" sintetico, non dal catalogo: i parametri documentati più due statiche interne.
  const el = (name: string): DataType => ({ kind: 'elementary', name }) as DataType;
  const realTon: FbSections = {
    input: [
      { name: 'IN', type: el('Bool') },
      { name: 'PT', type: el('Time') },
    ],
    output: [
      { name: 'Q', type: el('Bool') },
      { name: 'ET', type: el('Time') },
    ],
    inOut: [],
    static: [
      { name: 'x1', type: el('DWord') },
      { name: 'x2', type: el('Word') },
    ],
  };
  const sectionsOfFb = (s: FbSections) => ({
    in: s.input,
    out: s.output,
    inOut: s.inOut,
    stat: s.static,
    temp: [],
    ret: [],
  });
  /** Compila col nostro compilatore come farebbe STEP 7 con la struttura reale del TON. */
  function realFile(
    dev: PlcDevice,
    b: Block,
    over: Partial<CompileInput> & Pick<CompileInput, 'sections'>,
    ton: FbSections = realTon,
  ): Uint8Array {
    const ctx = createAwlContext(dev, b.id, cpu315pn);
    const base = ctx.resolve;
    ctx.resolve = (n) => (n.toLowerCase() === 'ton' ? { kind: 'fb', sections: ton } : base(n));
    const r = compileBlock({
      kind: b.kind,
      number: b.number,
      knowHowProtected: false,
      header: { author: '', family: '', name: '', version: '0.1' },
      initials: {},
      networks: b.kind === 'DB' || b.kind === 'IDB' ? [] : b.networks.map((n) => n.source),
      ctx,
      now,
      ...over,
    });
    expect(errorsOf(r.diagnostics), b.name).toEqual([]);
    return r.file!;
  }
  /** Il kit dell'amico: FB 20 {t: TON, k: INT} e il suo DB 20, con la struttura reale del TON. */
  function tonKit() {
    const dev = bareDevice(newId);
    const fb = code('FB', 20, 'Tempo', ['A #t.Q;\n= M 1.0;', 'L #k;\nT MW 0;'], {
      static: [member('t', '"TON"'), member('k', 'Int')],
    });
    const idb = createInstanceDb({ number: 20, name: 'Tempo_DB', instanceOf: 'Tempo', newId });
    dev.blocks.push(fb, idb);
    const stat = [
      { name: 't', type: { kind: 'named', name: 'TON' } as DataType },
      { name: 'k', type: el('Int') },
    ];
    const sections = { in: [], out: [], inOut: [], stat, temp: [], ret: [] };
    const fF = realFile(dev, fb, { sections });
    const fI = realFile(dev, idb, {
      sections: sectionsOfFb({ input: [], output: [], inOut: [], static: [] }),
      instanceOf: { kind: 'FB', number: 20, sections },
    });
    return { fF, fI };
  }

  it('A4: un kit coerente con una multi-istanza di SFB non è incoerente; la struttura reale vale per le modifiche', () => {
    const { fF, fI } = tonKit();
    // 6 + 6 di parametri, 6 di statiche interne del TON reale, poi k: 20 byte (il catalogo: 14)
    expect(readBlockFile(fI).mc7).toHaveLength(20);
    const { d, notes } = importNoting([fF, fI], bareDevice(newId));
    expect(notes).toEqual([]);
    expect(hex(exp(d, 'FB20').file!)).toBe(hex(fF));
    expect(hex(exp(d, 'IDB20').file!)).toBe(hex(fI));
    // Una rete nuova che usa k: l'offset viene dalla struttura reale (18), non dal catalogo (12)
    const fb = find(d, 'FB20') as CodeBlock;
    fb.networks.push(net(`L #${fb.interface.static[1]!.name};\nT MW 2;`));
    const r = exp(d, 'FB20');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(text(r.file!)[2]).toContain('L %DIW[AR2,P#18.0];');
    // FB scritto dall'utente con la stessa multi-istanza (e uno che contiene FB 20): struttura reale
    const mine = code('FB', 30, 'Mio', ['L #z;\nT MW 4;'], {
      static: [member('t', '"TON"'), member('z', 'Int')],
    });
    const nested = code('FB', 31, 'Dentro', ['L #z;\nT MW 6;'], {
      static: [member('m', `"${fb.name}"`), member('z', 'Int')],
    });
    d.blocks.push(mine, nested);
    expect(text(exp(d, 'FB30').file!)[0]).toContain('L %DIW[AR2,P#18.0];');
    expect(text(exp(d, 'FB31').file!)[0]).toContain('L %DIW[AR2,P#20.0];');
    // Un DB di istanza del TON: la struttura c'è, il genere dell'SSB no → errore
    d.blocks.push(createInstanceDb({ number: 6, name: 'T_DB', instanceOf: 'TON', newId }));
    const r6 = exp(d, 'IDB6');
    expect(r6.file).toBeUndefined();
    expect(r6.diagnostics.map((x) => [x.code, x.params?.['sfb']])).toEqual([
      ['LAYOUT_SFB_SCONOSCIUTO', 'SFB4'],
    ]);
  });

  it('A4: senza una struttura reale del SFB un layout che lo contiene è un errore; il DB di un FB scritto a mano è estraneo', () => {
    const dev = bareDevice(newId);
    const fb = code('FB', 30, 'Mio', ['L #z;\nT MW 4;'], {
      static: [member('t', '"TON"'), member('z', 'Int')],
    });
    const outer = code('FB', 31, 'Fuori', ['NOP 0;'], { static: [member('m', '"Mio"')] });
    dev.blocks.push(
      fb,
      outer,
      createInstanceDb({ number: 30, name: 'Mio_DB', instanceOf: 'Mio', newId }),
      createInstanceDb({ number: 6, name: 'T_DB', instanceOf: 'TON', newId }),
    );
    for (const tag of ['FB30', 'FB31', 'IDB30', 'IDB6']) {
      const r = exp(dev, tag);
      expect(r.file, tag).toBeUndefined();
      expect(codesOf(errorsOf(r.diagnostics)), tag).toContain('LAYOUT_SFB_SCONOSCIUTO');
    }
    // Il DB 20 dell'amico in un progetto con un FB 20 scritto a mano: estraneo, bloccato
    const { fI } = tonKit();
    const hand = bareDevice(newId);
    hand.blocks.push(
      code('FB', 20, 'Tempo', ['NOP 0;'], { static: [member('t', '"TON"'), member('k', 'Int')] }),
    );
    const { d, notes } = importNoting([fI], hand, 'DIPENDENZA_ESTRANEA');
    expect(notes).toEqual(['DB20:FB20']);
    expect(exp(d, 'IDB20').diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
  });

  /** L'amico: DB 5 di istanza del TON (SSB di genere 10, struttura reale) e l'OB1 che lo usa. */
  function tonDbKit(initials: Record<string, string> = {}) {
    const friend = bareDevice(newId);
    const t5 = createInstanceDb({ number: 5, name: 'T_DB', instanceOf: 'TON', newId });
    const ob = code('OB', 1, 'Main', ['CALL "TON", "T_DB" (IN := M 0.0, PT := T#1S);', 'NOP 0;']);
    friend.blocks.push(t5, ob);
    const fO = blockToMc7File(ob, friend, cpu315pn, now).file!;
    const f5 = realFile(friend, t5, {
      sections: sectionsOfFb({ input: [], output: [], inOut: [], static: [] }),
      instanceOf: {
        kind: 'SFB',
        number: 4,
        sections: sectionsOfFb(realTon),
        initials,
        ssbHeader: Uint8Array.of(0x10, 4, 0),
      },
    });
    return { fO, f5 };
  }

  it('A4/A5: il DB reale di un SFB usato da una CALL del lotto diventa sua istanza e dà struttura e genere ai DB nuovi', () => {
    const { fO, f5 } = tonDbKit();
    const { d } = importNoting([fO, f5], bareDevice(newId));
    expect((find(d, 'OB1') as CodeBlock).networks[0]!.source).toContain('CALL %SFB4, %DB5');
    // DB 5 è ora un DB di istanza del TON (coi suoi byte): modificare la rete della CALL non dà
    // più un falso CALL_INSTANCE_WRONG
    const db5 = find(d, 'IDB5');
    expect(db5.kind === 'IDB' && db5.instanceOf).toBe('TON');
    expect(hex(exp(d, 'IDB5').file!)).toBe(hex(f5));
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO));
    const ob1 = find(d, 'OB1') as CodeBlock;
    ob1.networks[1]!.source = 'NOP 0;\nNOP 0;';
    const edited = exp(d, 'OB1');
    expect(errorsOf(edited.diagnostics)).toEqual([]);
    expect(networkHex(edited.file!)[0]).toBe(networkHex(fO)[0]);
    ob1.networks[0]!.source += '\nNOP 0;';
    expect(errorsOf(exp(d, 'OB1').diagnostics)).toEqual([]);
    // Un DB di istanza nuovo del TON: genere 10 e 18 byte come il DB reale
    d.blocks.push(createInstanceDb({ number: 6, name: 'Nuovo', instanceOf: 'TON', newId }));
    const r = exp(d, 'IDB6');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const f = readBlockFile(r.file!);
    expect(f.ssb[0]).toBe(0x10);
    expect(f.mc7).toHaveLength(18);
    expect(hex(f.ssb)).toBe(hex(readBlockFile(f5).ssb));
  });

  it('A5: un DB di istanza nuovo da un campione porta i valori iniziali delle sue statiche (informazione)', () => {
    const { fO, f5 } = tonDbKit({ x1: 'DW#16#1234ABCD', x2: 'W#16#BEEF' });
    const { d } = importNoting([fO, f5], bareDevice(newId));
    d.blocks.push(createInstanceDb({ number: 6, name: 'Nuovo', instanceOf: 'TON', newId }));
    const r = exp(d, 'IDB6');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(r.diagnostics.map((x) => [x.severity, x.code, x.params?.['sample']])).toEqual([
      ['info', 'VALORI_INIZIALI_DA_CAMPIONE', 'DB5'],
    ]);
    // x1 a 12, x2 a 16: i valori del campione, non zero
    expect(hex(readBlockFile(r.file!).mc7.subarray(12, 18))).toBe('1234abcdbeef');
  });

  it('A5: DB 5 cancellato o sostituito (DB globale, istanza di TP): la rete della CALL SFB 4, DB 5 si ricompila', () => {
    const { fO, f5 } = tonDbKit();
    const fresh = () => importNoting([fO, f5], bareDevice(newId)).d;
    {
      const d = fresh();
      d.blocks = d.blocks.filter((b) => b.number !== 5);
      const r = exp(d, 'OB1');
      expect(r.file).toBeUndefined();
    }
    {
      const d = fresh();
      d.blocks = d.blocks.filter((b) => b.number !== 5);
      const g = createGlobalDb({ number: 5, name: 'T_DB', newId });
      g.members.push(member('w', 'Int'));
      d.blocks.push(g);
      expect(codesOf(errorsOf(exp(d, 'OB1').diagnostics))).toContain('CALL_INSTANCE_WRONG');
    }
    {
      const d = fresh();
      d.blocks = d.blocks.filter((b) => b.number !== 5);
      d.blocks.push(createInstanceDb({ number: 5, name: 'T_DB', instanceOf: 'TP', newId }));
      expect(codesOf(errorsOf(exp(d, 'OB1').diagnostics))).toContain('CALL_INSTANCE_WRONG');
    }
  });

  it('A5: esempi discordanti di uno stesso SFB (kit A e kit B): sconosciuto, anche attraverso un FB annidato', () => {
    // Kit A: FB 20 {t: TON, k} e FB 30 {m: FB 20, z}, compilati con il TON reale A
    const devA = bareDevice(newId);
    const fb20 = code('FB', 20, 'Tempo', ['L #k;\nT MW 0;'], {
      static: [member('t', '"TON"'), member('k', 'Int')],
    });
    const fb30 = code('FB', 30, 'Fuori', ['L #z;\nT MW 2;'], {
      static: [member('m', '"Tempo"'), member('z', 'Int')],
    });
    devA.blocks.push(fb20, fb30);
    const named = (n: string): DataType => ({ kind: 'named', name: n }) as DataType;
    const sec = (stat: TypedMember[]) => ({ in: [], out: [], inOut: [], stat, temp: [], ret: [] });
    const f20 = realFile(devA, fb20, {
      sections: sec([
        { name: 't', type: named('TON') },
        { name: 'k', type: el('Int') },
      ]),
    });
    const ctxA = createAwlContext(devA, fb30.id, cpu315pn);
    const f30 = realFile(devA, fb30, {
      sections: sec([
        { name: 'm', type: named('Tempo') },
        { name: 'z', type: el('Int') },
      ]),
      ctx: {
        ...ctxA,
        resolve: (n) =>
          n.toLowerCase() === 'ton'
            ? { kind: 'fb', sections: realTon }
            : n.toLowerCase() === 'tempo'
              ? {
                  kind: 'fb',
                  sections: {
                    input: [],
                    output: [],
                    inOut: [],
                    static: [
                      { name: 't', type: named('TON') },
                      { name: 'k', type: el('Int') },
                    ],
                  },
                }
              : ctxA.resolve(n),
      },
    });
    // Kit B: FB 21 {t: TON} con un TON di forma diversa (una statica in meno)
    const devB = bareDevice(newId);
    const fb21 = code('FB', 21, 'Altro', ['NOP 0;'], { static: [member('t', '"TON"')] });
    devB.blocks.push(fb21);
    const tonB: FbSections = { ...realTon, static: [{ name: 'x1', type: el('DWord') }] };
    const f21 = realFile(devB, fb21, { sections: sec([{ name: 't', type: named('TON') }]) }, tonB);

    const d = importNoting([f20, f30], bareDevice(newId)).d;
    importNoting([f21], d);
    // Senza modifiche ognuno si esporta identico
    for (const [tag, f] of [
      ['FB20', f20],
      ['FB30', f30],
      ['FB21', f21],
    ] as const) {
      expect(hex(exp(d, tag).file!), tag).toBe(hex(f));
    }
    // FB 20 e FB 21 modificati: la loro multi-istanza diretta ha la struttura del proprio SSB
    for (const tag of ['FB20', 'FB21']) {
      const b = find(d, tag) as CodeBlock;
      b.networks.push(net('NOP 0;'));
      expect(errorsOf(exp(d, tag).diagnostics), tag).toEqual([]);
    }
    // FB 30 modificato: il TON annidato in FB 20 passa dalla tabella, dove gli esempi discordano
    const b30 = find(d, 'FB30') as CodeBlock;
    b30.networks.push(net('NOP 0;'));
    const r = exp(d, 'FB30');
    expect(r.file).toBeUndefined();
    expect(r.diagnostics.map((x) => [x.code, x.params?.['sfb'], x.params?.['reason']])).toEqual([
      ['LAYOUT_SFB_SCONOSCIUTO', 'SFB4', 'conflict'],
    ]);
  });

  it('A5: multi-istanza dentro un ARRAY o una STRUCT: DICHIARAZIONE_NON_AMMESSA', () => {
    const dev = bareDevice(newId);
    const inner = code('FB', 10, 'Dentro', ['NOP 0;'], { input: [member('a', 'Int')] });
    const arr = code('FB', 11, 'Vettore', ['NOP 0;'], {
      static: [member('v', 'Array[0..1] of "Dentro"')],
    });
    const st = code('FB', 12, 'Struttura', ['NOP 0;'], {
      static: [{ ...member('s', 'Struct'), members: [member('m', '"Dentro"')] }],
    });
    const ton = code('FB', 13, 'Tempi', ['NOP 0;'], {
      static: [member('v', 'Array[0..1] of "TON"')],
    });
    dev.blocks.push(inner, arr, st, ton);
    for (const [tag, name] of [
      ['FB11', 'v'],
      ['FB12', 's.m'],
      ['FB13', 'v'],
    ] as const) {
      const r = exp(dev, tag);
      expect(r.file, tag).toBeUndefined();
      expect(
        r.diagnostics.map((x) => [x.code, x.params?.['name']]),
        tag,
      ).toEqual([['DICHIARAZIONE_NON_AMMESSA', name]]);
    }
    // la multi-istanza diretta si compila
    const ok = code('FB', 14, 'Diretta', ['NOP 0;'], { static: [member('m', '"Dentro"')] });
    dev.blocks.push(ok);
    expect(errorsOf(exp(dev, 'FB14').diagnostics)).toEqual([]);
  });

  it('A4: un DB di istanza di SFB col genere 0a importato in un progetto con un FB di quel numero è bloccato', () => {
    const dev = bareDevice(newId);
    const t5 = createInstanceDb({ number: 5, name: 'T_DB', instanceOf: 'TON', newId });
    dev.blocks.push(t5);
    // come lo scriveva BaaPortal prima: genere 0a e numero 4, che la lettura prende per FB 4
    const f5 = realFile(dev, t5, {
      sections: sectionsOfFb({ input: [], output: [], inOut: [], static: [] }),
      instanceOf: {
        kind: 'SFB',
        number: 4,
        sections: sectionsOfFb(realTon),
        ssbHeader: Uint8Array.of(0x0a, 4, 0),
      },
    });
    const into = bareDevice(newId);
    into.blocks.push(code('FB', 4, 'Quattro', ['NOP 0;'], { input: [member('a', 'Int')] }));
    const { d, notes } = importNoting([f5], into, 'DIPENDENZA_ESTRANEA');
    expect(notes).toEqual(['DB5:FB4']);
    expect(find(d, 'IDB5').mc7!.exact).toBe(false);
    const r = exp(d, 'IDB5');
    expect(r.file).toBeUndefined();
    expect(r.diagnostics.map((x) => [x.code, x.params?.['fb']])).toEqual([
      ['IDB_INCOERENTE', 'FB4'],
    ]);
  });

  it('A4: una CALL ricostruita con l interfaccia di un blocco del progetto dà una nota informativa', () => {
    const friendFb = code('FB', 10, 'Motore', ['NOP 0;'], { input: [member('In1', 'Int')] });
    const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
    const ob = code('OB', 1, 'Main', ['CALL "Motore", "Motore_DB" (In1 := 7);']);
    const [fF, , fO] = compiled([friendFb, idb, ob]);
    const rebuilt = (plan: ReturnType<typeof planImport>) =>
      plan.notes
        .filter((n) => n.code === 'CALL_RICOSTRUITA_CON_PROGETTO')
        .map((n) => `${n.block}:${n.params?.['callee']}`);
    // FB 10 del progetto con un ingresso in più: stessi byte, parametro Abil al posto di In1
    const dev = bareDevice(newId);
    dev.blocks.push(
      code('FB', 10, 'Motore', ['NOP 0;'], {
        input: [member('Abil', 'Int'), member('In1', 'Int')],
      }),
    );
    const plan = planImport(dev, [fO!], newId);
    expect(rebuilt(plan)).toEqual(['OB1:FB10']);
    expect(plan.create[0]!.kind === 'OB' && plan.create[0]!.networks[0]!.source).toContain(
      'Abil := 7',
    );
    // Col chiamato nello stesso lotto: nessuna nota
    expect(rebuilt(planImport(bareDevice(newId), [fF!, fO!], newId))).toEqual([]);
  });
  it('A4: la ricostruzione delle CALL usa la struttura reale della multi-istanza, non quella del catalogo', () => {
    // TON reale con due WORD interne: x1 sta a 12, dove col catalogo (12 byte) starebbe k
    const ton: FbSections = {
      ...realTon,
      static: [
        { name: 'x1', type: el('Word') },
        { name: 'x2', type: el('Word') },
      ],
    };
    const dev = bareDevice(newId);
    const f = code('FC', 21, 'F', ['NOP 0;'], { input: [member('p', 'Word')] });
    const fb = code('FB', 20, 'Tempo', ['CALL "F" (p := #t.x1);'], {
      static: [member('t', '"TON"'), member('k', 'Word')],
    });
    dev.blocks.push(f, fb);
    const stat = [
      { name: 't', type: { kind: 'named', name: 'TON' } as DataType },
      { name: 'k', type: el('Word') },
    ];
    const fF = blockToMc7File(f, dev, cpu315pn, now).file!;
    const fT = realFile(
      dev,
      fb,
      { sections: { in: [], out: [], inOut: [], stat, temp: [], ret: [] } },
      ton,
    );
    const { d } = importNoting([fF, fT], bareDevice(newId));
    const t = find(d, 'FB20') as CodeBlock;
    const kName = t.interface.static[1]!.name;
    // Il parametro legge l'interno del TON, non k (col catalogo la CALL diventava `p := #k`, e
    // ricompilata con la struttura reale avrebbe letto un altro dato): il testo resta in assoluto
    expect(t.networks[0]!.source).toContain('%DIW[AR2,P#12.0]');
    expect(t.networks[0]!.source).not.toContain(`#${kName}`);
    expect(hex(exp(d, 'FB20').file!)).toBe(hex(fT));
  });
  // --- A6: sfiducia fino al punto fisso; ricaricare lo stesso PLC ----------------------------

  /** Kit: FB 20 {a}, FB 30 {n: FB 20, z}, FB 40 {m: FB 30, w}, DB 30, DB 40 e OB1 che li chiama. */
  function chainKit(fb20: Member[] = [member('a', 'Int')]) {
    const f20 = code('FB', 20, 'Due', ['L #a;\nT MW 0;'], { static: fb20 });
    const f30 = code('FB', 30, 'Tre', ['CALL #n;', 'L #z;\nT MW 2;'], {
      static: [member('n', '"Due"'), member('z', 'Int')],
    });
    const f40 = code('FB', 40, 'Quattro', ['CALL #m;', 'L #w;\nT MW 4;'], {
      static: [member('m', '"Tre"'), member('w', 'Int')],
    });
    const db30 = createInstanceDb({ number: 30, name: 'Tre_DB', instanceOf: 'Tre', newId });
    const db40 = createInstanceDb({ number: 40, name: 'Q_DB', instanceOf: 'Quattro', newId });
    const ob = code('OB', 1, 'Main', ['CALL "Tre", "Tre_DB";', 'CALL "Quattro", "Q_DB";']);
    const [F20, F30, F40, I30, I40, O1] = compiled([f20, f30, f40, db30, db40, ob]);
    return { F20: F20!, F30: F30!, F40: F40!, I30: I30!, I40: I40!, O1: O1! };
  }
  const findN5 = (d: PlcDevice) =>
    d.blocks.find((b) => (b.kind === 'DB' || b.kind === 'IDB') && b.number === 5)!;
  const notesOf = (plan: ReturnType<typeof planImport>, code: string) =>
    plan.notes.filter((n) => n.code === code).map((n) => `${n.block}:${n.params?.['dep']}`);
  const sizeOf = (f: Uint8Array) => dataLayout(readSsb(readBlockFile(f).ssb, 'FB')).size;

  it('A6 S1: FB del lotto rifatto per una multi-istanza estranea: i suoi DB si bloccano, chi lo contiene si rifà (tre livelli)', () => {
    const k = chainKit();
    const d = bareDevice(newId);
    // FB 20 scritto a mano nel progetto, diverso: {a: INT, b: DINT}
    d.blocks.push(
      code('FB', 20, 'Due', ['NOP 0;'], { static: [member('a', 'Int'), member('b', 'DInt')] }),
    );
    const plan = planImport(d, [k.F30, k.F40, k.I30, k.I40, k.O1], newId);
    applyImport(d, plan);
    expect(notesOf(plan, 'DIPENDENZA_ESTRANEA')).toEqual(['FB30:FB20']);
    expect(notesOf(plan, 'DIPENDENZA_RIFATTA').sort()).toEqual([
      'DB30:FB30',
      'DB40:FB40',
      'FB40:FB30',
      'OB1:FB30',
      'OB1:FB40',
    ]);
    // FB 30 rifatto con l'FB 20 del progetto (6 byte per n, z a 6); FB 40 di conseguenza (w a 8)
    expect(sizeOf(k.F30)).toBe(4);
    expect(sizeOf(exp(d, 'FB30').file!)).toBe(8);
    const r40 = exp(d, 'FB40');
    expect(sizeOf(r40.file!)).toBe(10);
    // il testo importato di FB 40 accede in assoluto a w: lo si dice
    expect(codesOf(r40.diagnostics)).toContain('ACCESSO_ASSOLUTO_ISTANZA');
    // I DB di istanza non si esportano più coi byte originali: bloccati, con la causa
    for (const tag of ['IDB30', 'IDB40']) {
      const r = exp(d, tag);
      expect(r.file, tag).toBeUndefined();
      expect(
        r.diagnostics.map((x) => x.code),
        tag,
      ).toEqual(['IDB_INCOERENTE']);
      expect(r.diagnostics[0]!.message, tag).toContain("FB20 non viene dall'importazione");
      expect(find(d, tag).mc7!.exact, tag).toBe(false);
    }
  });

  it('A6 S1c: FB 20 più nuovo nello stesso lotto: FB 30 incoerente, la sfiducia arriva a FB 40, DB 30, DB 40 e OB1', () => {
    const k = chainKit();
    const newer = chainKit([member('a', 'Int'), member('b', 'DInt')]);
    const d = bareDevice(newId);
    const plan = planImport(d, [newer.F20, k.F30, k.F40, k.I30, k.I40, k.O1], newId);
    applyImport(d, plan);
    expect(notesOf(plan, 'IMPORT_CONTESTO_INCOERENTE')).toEqual(['FB30:FB20']);
    expect(notesOf(plan, 'DIPENDENZA_RIFATTA').sort()).toEqual([
      'DB30:FB30',
      'DB40:FB40',
      'FB40:FB30',
      'OB1:FB30',
      'OB1:FB40',
    ]);
    expect(hex(exp(d, 'FB20').file!)).toBe(hex(newer.F20));
    expect(sizeOf(exp(d, 'FB30').file!)).toBe(8);
    expect(sizeOf(exp(d, 'FB40').file!)).toBe(10);
    for (const tag of ['IDB30', 'IDB40']) {
      expect(
        exp(d, tag).diagnostics.map((x) => x.code),
        tag,
      ).toEqual(['IDB_INCOERENTE']);
    }
    // Lo stesso kit coerente: nessuna nota, tutto identico
    const ok = bareDevice(newId);
    const p2 = planImport(ok, [k.F20, k.F30, k.F40, k.I30, k.I40, k.O1], newId);
    applyImport(ok, p2);
    expect(p2.notes).toEqual([]);
    for (const [tag, f] of [
      ['FB30', k.F30],
      ['FB40', k.F40],
      ['IDB30', k.I30],
      ['IDB40', k.I40],
      ['OB1', k.O1],
    ] as const) {
      expect(hex(exp(ok, tag).file!), tag).toBe(hex(f));
    }
  });

  /** Valori attuali cambiati in un DB: un byte dei dati. */
  function patchData(f: Uint8Array, at: number, v: number): Uint8Array {
    const out = Uint8Array.from(f);
    out[36 + at] = v;
    expect(hex(readBlockFile(out).mc7)).not.toBe(hex(readBlockFile(f).mc7));
    return out;
  }

  it('A6: ricaricare lo stesso PLC con valori attuali cambiati: DB 5 resta istanza del TON e OB1 resta identico', () => {
    const { fO, f5 } = tonDbKit();
    const d = bareDevice(newId);
    const first = planImport(d, [fO, f5], newId);
    applyImport(d, first);
    // la nota del genere sconosciuto non c'è più: DB 5 è un DB di istanza del TON, con la prova
    expect(first.notes).toEqual([]);
    expect(find(d, 'IDB5').mc7!.sfbInstance).toMatchObject({ sfb: 4, ssbNumber: 4 });
    // Seconda lettura dal PLC: OB1 uguale, DB 5 con valori attuali diversi. OB1 si salta e resta
    // com'è (A8); i suoi byte passano i controlli del lotto con DB 5 nuovo: coerenti, le impronte
    // non cambiano
    const f5b = patchData(f5, 6, 1);
    const plan = planImport(d, [fO, f5b], newId);
    expect(plan.skipped.map((x) => x.reason)).toEqual([
      'OB1: già nel progetto con gli stessi byte',
    ]);
    expect(plan.replace.map((r) => r.existing.number)).toEqual([5]);
    expect(plan.refresh).toEqual([]);
    expect(plan.notes).toEqual([]);
    applyImport(d, plan);
    const db5 = find(d, 'IDB5');
    expect(db5.kind === 'IDB' && db5.instanceOf).toBe('TON');
    expect(hex(exp(d, 'IDB5').file!)).toBe(hex(f5b));
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO));
    const ob1 = find(d, 'OB1') as CodeBlock;
    ob1.networks[0]!.source = ob1.networks[0]!.source.replace('T#1S', 'T#2S');
    expect(errorsOf(exp(d, 'OB1').diagnostics)).toEqual([]);
    // DB 5 da solo, di nuovo: sostituisce un DB già dimostrato istanza del TON, stessa forma
    const f5c = patchData(f5, 6, 2);
    const p3 = planImport(d, [f5c], newId);
    expect(p3.notes).toEqual([]);
    applyImport(d, p3);
    expect(find(d, 'IDB5').kind).toBe('IDB');
    expect(hex(exp(d, 'IDB5').file!)).toBe(hex(f5c));
    d.blocks.push(createInstanceDb({ number: 6, name: 'Nuovo', instanceOf: 'TON', newId }));
    expect(errorsOf(exp(d, 'IDB6').diagnostics)).toEqual([]);
  });

  it('A6 S3b: OB1 cambiato e DB 5 identico (si salta): la prova di DB 5 resta, i DB nuovi del TON si compilano', () => {
    const friend = bareDevice(newId);
    const t5 = createInstanceDb({ number: 5, name: 'T_DB', instanceOf: 'TON', newId });
    const ob = code('OB', 1, 'Main', ['CALL "TON", "T_DB" (IN := M 0.0, PT := T#1S);', 'NOP 0;']);
    friend.blocks.push(t5, ob);
    const { fO, f5 } = tonDbKit();
    const d = importNoting([fO, f5], bareDevice(newId)).d;
    const ob2 = code('OB', 1, 'Main', [
      'CALL "TON", "T_DB" (IN := M 0.0, PT := T#1S);',
      'L 1;\nT MW 50;',
    ]);
    friend.blocks.splice(friend.blocks.indexOf(ob), 1, ob2);
    const fO2 = blockToMc7File(ob2, friend, cpu315pn, now).file!;
    const plan = planImport(d, [fO2, f5], newId);
    expect(plan.skipped.map((x) => x.reason)).toEqual([
      'DB5: già nel progetto con gli stessi byte',
    ]);
    applyImport(d, plan);
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO2));
    const o = find(d, 'OB1') as CodeBlock;
    o.networks[0]!.source = o.networks[0]!.source.replace('T#1S', 'T#2S');
    expect(errorsOf(exp(d, 'OB1').diagnostics)).toEqual([]);
    d.blocks.push(createInstanceDb({ number: 6, name: 'Nuovo', instanceOf: 'TON', newId }));
    expect(errorsOf(exp(d, 'IDB6').diagnostics)).toEqual([]);
    // salva e riapri: prova e lotto restano
    const proj = makeProject();
    proj.devices[0] = d;
    const again = readBaap(writeBaap(proj, { appVersion: 'x' })).devices[0]!;
    expect(find(again, 'IDB5').mc7!.sfbInstance).toMatchObject({ sfb: 4 });
    expect(errorsOf(exp(again, 'IDB6').diagnostics)).toEqual([]);
  });

  it('A6: un DB di istanza da solo vale se il suo FB viene da un import precedente non modificato e ha lo stesso layout', () => {
    const { fF, fI } = motorProgram();
    const d = importNoting([fF], bareDevice(newId)).d;
    // DB 11 da solo (valori attuali aggiornati): FB 10 è dell'import di prima, non modificato
    const fIb = patchData(fI, 2, 7);
    const ok = importNoting([fIb], d, 'DIPENDENZA_ESTRANEA');
    expect(ok.notes).toEqual([]);
    expect(hex(exp(d, 'IDB11').file!)).toBe(hex(fIb));
    // FB 10 con una rete in più: il layout è lo stesso, la prova vale ancora (A9)
    const fb = find(d, 'FB10') as CodeBlock;
    fb.networks.push(net('NOP 0;'));
    const fIc = patchData(fI, 2, 6);
    expect(importNoting([fIc], d, 'DIPENDENZA_ESTRANEA').notes).toEqual([]);
    expect(hex(exp(d, 'IDB11').file!)).toBe(hex(fIc));
    // FB 10 con un'altra interfaccia dopo il suo import: estraneo, il DB si blocca e il messaggio
    // dice con chi reimportarlo
    fb.interface.static.push(member('extra', 'Int'));
    const bad = importNoting([patchData(fI, 2, 8)], d, 'DIPENDENZA_ESTRANEA');
    expect(bad.notes).toEqual(['DB11:FB10']);
    const r = exp(d, 'IDB11');
    expect(r.diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
    expect(r.diagnostics[0]!.message).toContain('reimportarlo insieme a FB10');
    // le chiamate (liste dei puntatori) non valgono tra importazioni diverse
    const f20 = code('FC', 20, 'Somma', ['NOP 0;'], {
      input: [member('A', 'Int')],
      output: [member('Q', 'Int')],
    });
    const [fC, fO] = compiled([
      f20,
      code('OB', 1, 'Main', ['CALL "Somma" (A := MW 10, Q := MW 12);']),
    ]);
    const d2 = importNoting([fC!], bareDevice(newId)).d;
    expect(importNoting([fO!], d2, 'DIPENDENZA_ESTRANEA').notes).toEqual(['OB1:FC20']);
  });

  it('A6: CALL FB n, DB m del lotto: il DB deve avere il genere 0a dei DB di istanza di FB', () => {
    const dev = bareDevice(newId);
    const fb = motore();
    const idb = createInstanceDb({ number: 11, name: 'Motore_DB', instanceOf: 'Motore', newId });
    const ob = code('OB', 1, 'Main', ['CALL "Motore", "Motore_DB" (In1 := 7);']);
    dev.blocks.push(fb, idb, ob);
    const [fF, , fO] = compiled([fb, idb, ob]);
    // DB 11 con genere 10 e numero 10 nell'SSB: il numero torna, il genere no
    const s = sectionsOfFb({
      input: [{ name: 'In1', type: el('Int') }],
      output: [],
      inOut: [],
      static: [
        { name: 'Cnt', type: el('Int') },
        { name: 'Spd', type: el('Int') },
      ],
    });
    const fI = realFile(dev, idb, {
      sections: sectionsOfFb({ input: [], output: [], inOut: [], static: [] }),
      instanceOf: { kind: 'SFB', number: 10, sections: s, ssbHeader: Uint8Array.of(0x10, 10, 0) },
    });
    expect(importNoting([fF!, fI, fO!], bareDevice(newId)).notes).toEqual(['OB1:DB11']);
  });
  // --- A7: le dipendenze si giudicano sul dispositivo come sarà dopo l'importazione ----------

  const rifatte = (plan: ReturnType<typeof planImport>) =>
    plan.notes
      .filter((n) => n.code === 'DIPENDENZA_RIFATTA')
      .map((n) => `${n.block}:${n.params?.['dep']}:${n.params?.['cause']}`);

  it('A7 X1: DB di istanza da solo mentre il lotto cambia l FB annidato del suo FB: bloccato, con la causa vera', () => {
    const k = chainKit();
    const newer = chainKit([member('a', 'Int'), member('b', 'DInt')]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [k.F20, k.F30, k.I30, k.O1], newId));
    expect(hex(exp(d, 'IDB30').file!)).toBe(hex(k.I30));
    // nuovo FB 20 {a, b: DINT} e DB 30 coi valori attuali aggiornati; FB 30 resta quello di prima
    const plan = planImport(d, [newer.F20, patchData(k.I30, 2, 9)], newId);
    applyImport(d, plan);
    expect(notesOf(plan, 'DIPENDENZA_ESTRANEA')).toEqual([]);
    expect(rifatte(plan)).toEqual(['DB30:FB30:perché FB20 cambia con questa importazione']);
    expect(plan.notes.find((n) => n.code === 'DIPENDENZA_RIFATTA')!.params).toEqual({
      dep: 'FB30',
      cause: 'perché FB20 cambia con questa importazione',
      context: 'import',
      src: 'FB20',
      via: 'FB30',
    });
    // FB 30 si ricompila con l'FB 20 nuovo (8 byte); DB 30 non si esporta coi suoi 4 byte
    expect(sizeOf(exp(d, 'FB30').file!)).toBe(8);
    const r = exp(d, 'IDB30');
    expect(r.file).toBeUndefined();
    expect(r.diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
    // la causa anche nei parametri del testo tradotto (A8)
    expect(r.diagnostics[0]!.params).toEqual({
      fb: 'FB30',
      context: 'rebuilt_changed',
      src: 'FB20',
      via: 'FB30',
    });
    expect(r.diagnostics[0]!.message).toContain('(perché FB20 è cambiato)');
  });

  it('A8 X1b: un FB identico resta com è anche se il lotto cambia ciò da cui dipende; i suoi byte passano i controlli del lotto', () => {
    const k = chainKit();
    const newer = chainKit([member('a', 'Int'), member('b', 'DInt')]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [k.F20, k.F30, k.I30, k.O1], newId));
    const fb30 = find(d, 'FB30') as CodeBlock;
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: fb30.id }, 'Linea');
    fb30.networks[1]!.comment = 'uscita';
    const plan = planImport(d, [newer.F20, k.F30, patchData(k.I30, 2, 9)], newId);
    // FB 30 non torna con FB 20 nuovo: non si salta, se ne aggiornano solo i metadati (A9: contati
    // a parte)
    expect(plan.skipped).toEqual([]);
    expect(plan.replace.map((r) => r.existing.name)).toEqual(['FB20', 'DB30']);
    expect(plan.refresh.map((r) => r.existing.name)).toEqual(['Linea']);
    applyImport(d, plan);
    const after = find(d, 'FB30') as CodeBlock;
    expect([after.id, after.name, after.networks[1]!.comment]).toEqual([
      fb30.id,
      'Linea',
      'uscita',
    ]);
    expect(after.mc7!.fidelity!.deps['FB20']).toBe('incoerente');
    expect(notesOf(plan, 'IMPORT_CONTESTO_INCOERENTE')).toEqual(['Linea:FB20']);
    expect(rifatte(plan)).toEqual(['DB30:FB30:FB20 non torna con lo stesso lotto']);
    expect(sizeOf(exp(d, 'FB30').file!)).toBe(8);
    const r = exp(d, 'IDB30');
    expect(r.diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
    expect(r.diagnostics[0]!.params).toEqual({
      fb: 'FB30',
      context: 'rebuilt_incoherent',
      src: 'FB20',
    });
    // tutto il PLC ricaricato, cambiato solo FB 20: FB 30, DB 30 e OB1 identici restano, coi
    // controlli del lotto: DB 30 si blocca, le reti di OB1 con FB 30 si ricompilano
    const d2 = bareDevice(newId);
    applyImport(d2, planImport(d2, [k.F20, k.F30, k.I30, k.O1], newId));
    const p2 = planImport(d2, [newer.F20, k.F30, k.I30, k.O1], newId);
    expect(p2.skipped).toEqual([]);
    expect(p2.replace.map((r) => r.existing.name)).toEqual(['FB20']);
    expect(p2.refresh.map((r) => r.existing.name)).toEqual(['FB30', 'DB30', 'OB1']);
    applyImport(d2, p2);
    expect(notesOf(p2, 'IMPORT_CONTESTO_INCOERENTE')).toEqual(['FB30:FB20']);
    expect(notesOf(p2, 'DIPENDENZA_RIFATTA')).toEqual(['DB30:FB30', 'OB1:FB30']);
    expect(exp(d2, 'IDB30').diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
    expect(find(d2, 'IDB30').mc7!.exact).toBe(false);
    expect(sizeOf(exp(d2, 'FB30').file!)).toBe(8);
  });

  it('A7 X1c: FB del lotto con la multi-istanza di un FB di prima che il lotto rifà: anche lui si rifà', () => {
    const k = chainKit();
    const newer = chainKit([member('a', 'Int'), member('b', 'DInt')]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [k.F20, k.F30, k.I30, k.O1], newId));
    const plan = planImport(d, [newer.F20, k.F40, k.I40], newId);
    applyImport(d, plan);
    expect(rifatte(plan)).toEqual([
      'FB40:FB30:perché FB20 cambia con questa importazione',
      'DB40:FB40:FB30 si rifà perché FB20 cambia con questa importazione',
    ]);
    // a rifarsi è FB 30, non FB 40 di cui parla la nota: il testo tradotto lo dice (A8)
    expect(plan.notes.find((n) => n.block === 'DB40')!.params).toMatchObject({
      dep: 'FB40',
      context: 'import_via',
      src: 'FB20',
      via: 'FB30',
    });
    expect(exp(d, 'IDB40').diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
    expect(sizeOf(k.F40)).toBe(6);
    expect(sizeOf(exp(d, 'FB40').file!)).toBe(10);
  });

  it('A7 X2: FB rifatto alla sua importazione, poi il suo DB da solo: la nota dice la causa prima', () => {
    const k = chainKit();
    const d = bareDevice(newId);
    d.blocks.push(
      code('FB', 20, 'Due', ['NOP 0;'], { static: [member('a', 'Int'), member('b', 'DInt')] }),
    );
    applyImport(d, planImport(d, [k.F30, k.O1], newId));
    const plan = planImport(d, [patchData(k.I30, 2, 9)], newId);
    applyImport(d, plan);
    expect(notesOf(plan, 'DIPENDENZA_ESTRANEA')).toEqual([]);
    expect(rifatte(plan)).toEqual(["DB30:FB30:FB20 non viene dall'importazione"]);
    expect(exp(d, 'IDB30').diagnostics.map((x) => x.code)).toEqual(['IDB_INCOERENTE']);
    // il controllo: DB 30 da solo con FB 30 e FB 20 invariati da prima vale ancora
    const d2 = bareDevice(newId);
    applyImport(d2, planImport(d2, [k.F20, k.F30, k.I30, k.O1], newId));
    const i30b = patchData(k.I30, 2, 9);
    const ok = planImport(d2, [i30b], newId);
    applyImport(d2, ok);
    expect(ok.notes).toEqual([]);
    expect(hex(exp(d2, 'IDB30').file!)).toBe(hex(i30b));
  });

  it('A7: un DB già dimostrato istanza di SFB, sostituito da uno di genere diverso, perde la prova', () => {
    const { fO, f5 } = tonDbKit();
    const d = importNoting([fO, f5], bareDevice(newId)).d;
    expect(find(d, 'IDB5').kind).toBe('IDB');
    // DB 5 col genere 0a e il numero 4: non è più lo stesso genere del DB dimostrato
    const t5 = createInstanceDb({ number: 5, name: 'T_DB', instanceOf: 'TON', newId });
    const dev = bareDevice(newId);
    dev.blocks.push(t5);
    const f5a = realFile(dev, t5, {
      sections: sectionsOfFb({ input: [], output: [], inOut: [], static: [] }),
      instanceOf: {
        kind: 'SFB',
        number: 4,
        sections: sectionsOfFb(realTon),
        ssbHeader: Uint8Array.of(0x0a, 4, 0),
      },
    });
    applyImport(d, planImport(d, [f5a], newId));
    expect(findN5(d).kind).toBe('DB');
    expect(findN5(d).mc7!.sfbInstance).toBeUndefined();
  });

  it('A7: un DB identico non ancora dimostrato che il lotto dimostra istanza di SFB si converte sul posto', () => {
    const { fO, f5 } = tonDbKit();
    const d = bareDevice(newId);
    // prima DB 5 da solo: nessuna CALL lo dimostra, resta un DB in sola lettura
    applyImport(d, planImport(d, [f5], newId));
    expect(findN5(d).kind).toBe('DB');
    const id5 = findN5(d).id;
    // poi OB1 con DB 5 identico: DB 5 diventa DB di istanza del TON, stesso id e stessi byte
    const plan = planImport(d, [fO, f5], newId);
    expect(plan.skipped).toEqual([]);
    applyImport(d, plan);
    const db5 = findN5(d);
    expect([db5.kind, db5.id, db5.kind === 'IDB' && db5.instanceOf]).toEqual(['IDB', id5, 'TON']);
    expect(db5.mc7!.sfbInstance).toMatchObject({ sfb: 4 });
    expect(hex(exp(d, 'IDB5').file!)).toBe(hex(f5));
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO));
  });

  // --- A8: un doppione identico resta com'è, coi controlli del lotto sui suoi byte -----------

  it('A8: ricaricare lo stesso PLC coi DB cambiati non cancella nomi e commenti dell utente in OB1', () => {
    const { fO, f5 } = tonDbKit();
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [fO, f5], newId));
    const ob1 = find(d, 'OB1') as CodeBlock;
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: ob1.id }, 'Ciclo');
    ob1.networks[0]!.title = 'Temporizzatore';
    ob1.networks[0]!.comment = 'avvio del ciclo';
    ob1.networks[0]!.source = `// nota dell'utente\n${ob1.networks[0]!.source}`;
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO));
    const before = JSON.stringify(ob1);
    const plan = planImport(d, [fO, patchData(f5, 6, 1)], newId);
    expect(plan.skipped.map((x) => x.reason)).toEqual([
      'Ciclo: già nel progetto con gli stessi byte',
    ]);
    expect(plan.replace.map((r) => r.existing.number)).toEqual([5]);
    expect(plan.refresh).toEqual([]);
    applyImport(d, plan);
    const after = find(d, 'OB1') as CodeBlock;
    expect(after).toBe(ob1);
    expect(JSON.stringify(after)).toBe(before);
    expect([after.name, after.networks[0]!.title, after.networks[0]!.comment]).toEqual([
      'Ciclo',
      'Temporizzatore',
      'avvio del ciclo',
    ]);
    expect(after.networks[0]!.source).toContain("// nota dell'utente");
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO));
  });

  const sommaFc = (types: string[]) =>
    code('FC', 20, 'Somma', ['NOP 0;'], {
      input: types.slice(1).map((t, i) => member(`A${i}`, t)),
      output: [member('Q', types[0]!)],
    });

  it('A8: un doppione identico con una dipendenza del lotto cambiata ma coerente resta fidato (impronte aggiornate)', () => {
    const [fC, fO] = compiled([
      sommaFc(['Int', 'Int']),
      code('OB', 1, 'Main', ['CALL "Somma" (A0 := MW 10, Q := MW 12);']),
    ]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [fC!, fO!], newId));
    const ob1 = find(d, 'OB1') as CodeBlock;
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: ob1.id }, 'Ciclo');
    // FC 20 con un altro tipo e lo stesso numero di parametri: i byte di OB1 tornano e si leggono
    // con le stesse CALL (puntatori)
    const [fC2] = compiled([sommaFc(['Int', 'DInt'])]);
    const plan = planImport(d, [fC2!, fO!], newId);
    expect(plan.skipped).toEqual([]);
    expect(plan.replace.map((r) => r.existing.name)).toEqual(['FC20']);
    expect(plan.notes).toEqual([]);
    expect(plan.refresh.map((r) => r.existing.name)).toEqual(['Ciclo']);
    applyImport(d, plan);
    const after = find(d, 'OB1') as CodeBlock;
    expect([after.id, after.name]).toEqual([ob1.id, 'Ciclo']);
    const r = exp(d, 'OB1');
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.file!)).toBe(hex(fO!));
  });

  it('A9: un doppione identico che il lotto fa leggere in un altro modo (CALL, grezzi) si reimporta, con la causa', () => {
    // CALL con una costante: L 5, T LW 20 e la UC; con A0 DINT non è più una CALL ricostruibile
    const [fC, fO] = compiled([
      sommaFc(['Int', 'Int']),
      code('OB', 1, 'Main', ['CALL "Somma" (A0 := 5, Q := MW 12);\nNOP 0;']),
    ]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [fC!, fO!], newId));
    const ob1 = find(d, 'OB1') as CodeBlock;
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: ob1.id }, 'Ciclo');
    expect(ob1.networks[0]!.source).toContain('CALL');
    const [fC2] = compiled([sommaFc(['Int', 'DInt'])]);
    const plan = planImport(d, [fC2!, fO!], newId);
    expect(plan.skipped).toEqual([]);
    expect(plan.refresh).toEqual([]);
    expect(plan.replace.map((r) => r.existing.name)).toEqual(['FC20', 'Ciclo']);
    expect(plan.notes.map((n) => `${n.block}:${n.code}:${n.params?.['dep']}`)).toEqual([
      'Ciclo:DOPPIONE_RILETTO:FC20',
    ]);
    applyImport(d, plan);
    // il modello è quello dei byte con FC 20 nuovo: un grezzo, non la CALL di prima
    const after = find(d, 'OB1') as CodeBlock;
    expect(after.name).toBe('Ciclo');
    expect(after.networks[0]!.source).not.toContain('CALL');
    expect(after.networks[0]!.source).toContain('// MC7 grezzo');
    expect(hex(exp(d, 'OB1').file!)).toBe(hex(fO!));
    // una modifica non legata alla CALL nella stessa rete: niente L L#5 / T LD 20 silenzioso
    after.networks[0]!.source = after.networks[0]!.source.replace('NOP 0', 'NOP 1');
    expect(codesOf(exp(d, 'OB1').diagnostics)).toEqual(['RAW_IN_CHANGED_NETWORK']);
    // FC 20 con un parametro in più: la lista dei puntatori non è più una CALL, idem
    const d3 = bareDevice(newId);
    const [fC1, fO1] = compiled([
      sommaFc(['Int', 'Int']),
      code('OB', 1, 'Main', ['CALL "Somma" (A0 := MW 10, Q := MW 12);']),
    ]);
    applyImport(d3, planImport(d3, [fC1!, fO1!], newId));
    const [fC3] = compiled([sommaFc(['Int', 'Int', 'Int'])]);
    const p3 = planImport(d3, [fC3!, fO1!], newId);
    expect(p3.replace.map((r) => r.existing.name)).toEqual(['FC20', 'OB1']);
    expect(p3.notes.map((n) => `${n.block}:${n.code}:${n.params?.['dep']}`).sort()).toEqual([
      'OB1:DOPPIONE_RILETTO:FC20',
      'OB1:IMPORT_CONTESTO_INCOERENTE:FC20',
    ]);
  });

  it('A9: DB coi valori attuali cambiati e lo stesso SSB: nomi, commenti e titolo dell utente restano', () => {
    const db = createGlobalDb({ number: 3, name: 'Dati', newId });
    db.members.push(member('A', 'Int', '3'), member('B', 'Int', '4'));
    const k = chainKit();
    const [f] = compiled([db]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [f!, k.F20, k.F30, k.I30], newId));
    const g = find(d, 'DB3') as GlobalDb;
    const ref = { kind: 'member', deviceId: d.id, ownerKind: 'block', ownerId: g.id } as const;
    renameWithReferences(d, { ...ref, memberId: g.members[1]!.id }, 'pezzi');
    g.members[1]!.comment = 'contatore pezzi';
    g.header.title = 'Dati linea';
    const i30 = find(d, 'IDB30');
    i30.header.title = 'Istanza linea';
    i30.header.comment = 'valori del turno';
    expect(hex(exp(d, 'DB3').file!)).toBe(hex(f!));
    // seconda lettura dal PLC: valori attuali diversi, stessa interfaccia
    const f2 = patchData(f!, 2, 9);
    const i30b = patchData(k.I30, 2, 7);
    const plan = planImport(d, [f2, i30b], newId);
    expect(plan.replace.map((r) => r.existing.name)).toEqual(['DB3', 'DB30']);
    applyImport(d, plan);
    const after = find(d, 'DB3') as GlobalDb;
    expect([
      after.id,
      after.members[1]!.name,
      after.members[1]!.comment,
      after.header.title,
    ]).toEqual([g.id, 'pezzi', 'contatore pezzi', 'Dati linea']);
    expect(hex(exp(d, 'DB3').file!)).toBe(hex(f2));
    const a30 = find(d, 'IDB30');
    expect([a30.header.title, a30.header.comment]).toEqual(['Istanza linea', 'valori del turno']);
    expect(hex(exp(d, 'IDB30').file!)).toBe(hex(i30b));
    // con un'interfaccia diversa (un membro in più) il modello è quello nuovo
    db.members.push(member('C', 'Int'));
    const [f3] = compiled([db]);
    applyImport(d, planImport(d, [f3!], newId));
    const fresh = find(d, 'DB3') as GlobalDb;
    expect(fresh.members.map((m) => m.name)).toHaveLength(3);
    expect(fresh.members[1]!.name).not.toBe('pezzi');
    expect(hex(exp(d, 'DB3').file!)).toBe(hex(f3!));
  });

  it('A9: un DB di istanza importato prima del suo FB diventa sul posto suo DB di istanza col kit', () => {
    const k = chainKit();
    const d = bareDevice(newId);
    // DB 30 da solo: FB 30 non c'è, DB globale in sola lettura
    applyImport(d, planImport(d, [k.I30], newId));
    const db30 = find(d, 'DB30');
    expect(db30.mc7!.exact).toBe(false);
    db30.header.title = 'Linea';
    // poi il kit con DB 30 identico: diventa DB di istanza di FB 30, stesso id e stessi byte
    const plan = planImport(d, [k.F20, k.F30, k.I30, k.O1], newId);
    expect(plan.skipped).toEqual([]);
    expect(plan.replace).toEqual([]);
    expect(
      plan.refresh.map((r) => `${r.existing.kind}${r.existing.number}>${r.incoming.kind}`),
    ).toEqual(['DB30>IDB']);
    expect(plan.notes).toEqual([]);
    applyImport(d, plan);
    const i30 = find(d, 'IDB30');
    expect([
      i30.id,
      i30.kind === 'IDB' && i30.instanceOf,
      i30.header.title,
      i30.mc7!.exact,
    ]).toEqual([db30.id, 'FB30', 'Linea', true]);
    for (const [tag, f] of [
      ['IDB30', k.I30],
      ['OB1', k.O1],
      ['FB30', k.F30],
    ] as const) {
      expect(hex(exp(d, tag).file!), tag).toBe(hex(f));
    }
    // OB1 modificato: la CALL con DB 30 si compila (prima: CALL_INSTANCE_WRONG)
    const ob1 = find(d, 'OB1') as CodeBlock;
    ob1.networks[0]!.source += '\nNOP 0;';
    expect(errorsOf(exp(d, 'OB1').diagnostics)).toEqual([]);
  });

  it('A9: la prova tra importazioni guarda solo il layout dell FB: un chiamato delle sue reti che cambia non blocca il suo DB', () => {
    const fc5 = code('FC', 5, 'Cinque', ['L #A;\nT MW 8;'], { input: [member('A', 'Int')] });
    const f10 = code('FB', 10, 'Dieci', ['CALL "Cinque" (A := #z);', 'L 5;\nT #z;'], {
      static: [member('z', 'Int', '7')],
    });
    const db11 = createInstanceDb({ number: 11, name: 'Dieci_DB', instanceOf: 'Dieci', newId });
    const ob = code('OB', 1, 'Main', ['CALL "Dieci", "Dieci_DB";']);
    const [F5, F10, I11, O1] = compiled([fc5, f10, db11, ob]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [F5!, F10!, I11!, O1!], newId));
    // FC 5 con un'altra interfaccia e DB 11 coi valori attuali nuovi: il layout di FB 10 non cambia
    const [F5b] = compiled([code('FC', 5, 'Cinque', ['NOP 0;'], { input: [member('A', 'DInt')] })]);
    const I11b = patchData(I11!, 0, 9);
    const plan = planImport(d, [F5b!, I11b], newId);
    applyImport(d, plan);
    expect(plan.notes).toEqual([]);
    const r = exp(d, 'IDB11');
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.file!)).toBe(hex(I11b));
  });

  // --- A10 ---------------------------------------------------------------------------------

  it('A10: DB ricaricato protetto know-how con lo stesso SSB: il modello tenuto prende la protezione dai byte', () => {
    const db = createGlobalDb({ number: 1, name: 'Dati', newId });
    db.members.push(member('A', 'Int', '3'), member('B', 'Int', '4'));
    const [f] = compiled([db]);
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [f!], newId));
    const g = find(d, 'DB1') as GlobalDb;
    renameWithReferences(
      d,
      {
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: g.id,
        memberId: g.members[1]!.id,
      },
      'pezzi',
    );
    expect(g.knowHowProtected).toBe(false);
    // lo stesso DB, ora protetto: stesso SSB, intestazione diversa
    db.knowHowProtected = true;
    const [fp] = compiled([db]);
    expect(readBlockFile(fp!).header.knowHowProtected).toBe(true);
    expect(hex(readBlockFile(fp!).ssb)).toBe(hex(readBlockFile(f!).ssb));
    applyImport(d, planImport(d, [fp!], newId));
    const after = find(d, 'DB1') as GlobalDb;
    // la casella della protezione si blocca per un blocco importato protetto (mc7 e la protezione)
    expect([after.members[1]!.name, after.knowHowProtected, after.mc7 !== undefined]).toEqual([
      'pezzi',
      true,
      true,
    ]);
    expect(hex(exp(d, 'DB1').file!)).toBe(hex(fp!));
    // ricompilato dopo una modifica: la protezione resta
    after.members[0]!.initial = '5';
    const r = exp(d, 'DB1');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(readBlockFile(r.file!).header.knowHowProtected).toBe(true);
  });

  it('A10: un grezzo di prima che col lotto diventa una CALL non reimporta il doppione: il commento resta', () => {
    const [fC, fO] = compiled([
      sommaFc(['Int', 'Int']),
      code('OB', 1, 'Main', ['CALL "Somma" (A0 := MW 10, Q := MW 12);', 'NOP 0;']),
    ]);
    // OB1 da solo: FC 20 non c'è, la chiamata è un grezzo
    const d = bareDevice(newId);
    applyImport(d, planImport(d, [fO!], newId));
    const ob1 = find(d, 'OB1') as CodeBlock;
    expect(ob1.networks[0]!.source).toContain('// MC7 grezzo');
    ob1.networks[0]!.comment = 'chiama la somma';
    ob1.header.comment = 'ciclo';
    // poi FC 20 con OB1 identico: con FC 20 il grezzo sarebbe una CALL, OB1 resta com'è
    const plan = planImport(d, [fC!, fO!], newId);
    expect(plan.notes.filter((n) => n.code === 'DOPPIONE_RILETTO')).toEqual([]);
    expect(plan.replace).toEqual([]);
    applyImport(d, plan);
    const after = find(d, 'OB1') as CodeBlock;
    expect([after.id, after.networks[0]!.comment, after.header.comment]).toEqual([
      ob1.id,
      'chiama la somma',
      'ciclo',
    ]);
    expect(after.networks[0]!.source).toContain('// MC7 grezzo');
    const r = exp(d, 'OB1');
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(hex(r.file!)).toBe(hex(fO!));
  });

  it('A10: un DB importato prima del suo FB che col lotto sarebbe bloccato non si converte: resta il DB coi suoi byte', () => {
    const k = chainKit();
    // A: FB 30 con un altro layout nel lotto, DB 30 identico
    const dA = bareDevice(newId);
    applyImport(dA, planImport(dA, [k.I30], newId));
    const f20 = code('FB', 20, 'Due', ['L #a;\nT MW 0;'], { static: [member('a', 'Int')] });
    const f30b = code('FB', 30, 'Tre', ['CALL #n;', 'L #z;\nT MW 2;'], {
      static: [member('n', '"Due"'), member('z', 'Int'), member('y', 'Int')],
    });
    const [, F30b] = compiled([f20, f30b]);
    const pA = planImport(dA, [k.F20, F30b!, k.I30], newId);
    // resta un DB globale: un doppione come gli altri (FB 20 ora c'è e il layout del membro n si
    // risolve: se ne aggiornano le impronte), non un DB di istanza
    expect(pA.refresh.map((r) => `${r.existing.name}>${r.incoming.kind}`)).toEqual(['DB30>DB']);
    expect(pA.notes.map((n) => `${n.block}:${n.code}:${JSON.stringify(n.params)}`)).toEqual([
      'DB30:DB_NON_CONVERTITO:{"fb":"FB30","context":"incoherent"}',
    ]);
    applyImport(dA, pA);
    const a30 = find(dA, 'DB30');
    expect([a30.kind, a30.mc7!.exact]).toEqual(['DB', false]);
    const rA = exp(dA, 'DB30');
    expect(rA.diagnostics).toEqual([]);
    expect(hex(rA.file!)).toBe(hex(k.I30));
    // B: FB 30 del lotto con la multi-istanza di un FB 20 del progetto che non viene dal lotto
    const dB = bareDevice(newId);
    dB.blocks.push(code('FB', 20, 'Due', ['NOP 0;'], { static: [member('a', 'Int')] }));
    applyImport(dB, planImport(dB, [k.I30], newId));
    const pB = planImport(dB, [k.F30, k.I30], newId);
    expect(pB.refresh).toEqual([]);
    expect(pB.skipped.map((x) => x.reason)).toEqual(['DB30: già nel progetto con gli stessi byte']);
    expect(pB.notes.filter((n) => n.block === 'DB30').map((n) => [n.code, n.params])).toEqual([
      ['DB_NON_CONVERTITO', { fb: 'FB30', context: 'rebuilt_foreign', src: 'FB20' }],
    ]);
    applyImport(dB, pB);
    const b30 = find(dB, 'DB30');
    expect(b30.kind).toBe('DB');
    const rB = exp(dB, 'DB30');
    expect(rB.diagnostics).toEqual([]);
    expect(hex(rB.file!)).toBe(hex(k.I30));
  });
});
