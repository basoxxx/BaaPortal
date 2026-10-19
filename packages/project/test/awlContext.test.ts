import { checkBlockCode } from '@baaportal/awl';
import { findCpu } from '@baaportal/catalog';
import { describe, expect, it } from 'vitest';
import {
  addSource,
  createAwlContext,
  deleteSource,
  findSource,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice } from './fixtures';

const ob1 = (d: PlcDevice) => d.blocks[0] as CodeBlock;

describe('createAwlContext', () => {
  const d = makeDevice();
  const ctx = createAwlContext(d, ob1(d).id, cpu315pn);

  it('simboli: tag e costanti del dispositivo', () => {
    expect(ctx.symbol('start')).toMatchObject({
      kind: 'tag',
      type: { kind: 'elementary', name: 'Bool' },
    });
    expect(ctx.symbol('Max')).toMatchObject({ kind: 'constant' });
    expect(ctx.symbol('Inesistente')).toBeUndefined();
    expect(ctx.allSymbols().map((s) => s.name)).toEqual(['Start', 'Stop', 'Max']);
  });

  it('blocchi: prima quelli del progetto, poi SFC e SFB del catalogo', () => {
    const all = ctx.allBlocks();
    const own = d.blocks.length;
    expect(all.slice(0, own).map((b) => b.name)).toEqual(d.blocks.map((b) => b.name));
    expect(all.slice(own).every((b) => b.kind === 'SFC' || b.kind === 'SFB')).toBe(true);
    expect(all.length - own).toBe(77 + 29);
    expect(ctx.block({ name: 'nastro' })).toMatchObject({ kind: 'FB', number: 1 });
    expect(ctx.block({ kind: 'DB', number: 1 })).toMatchObject({ name: 'Dati' });
    expect(ctx.block({ kind: 'IDB', number: 2 })).toMatchObject({
      name: 'Nastro_DB',
      instanceOf: 'Nastro',
    });
    expect(ctx.block({ name: 'READ_CLK' })).toMatchObject({ kind: 'SFC', number: 1 });
    expect(ctx.block({ kind: 'SFB', number: 4 })).toMatchObject({ name: 'TON' });
  });

  it('un nome del progetto vince su quello del catalogo', () => {
    const e = makeDevice();
    ob1(e).name = 'RDSYSST';
    const c = createAwlContext(e, ob1(e).id, undefined);
    expect(c.block({ name: 'RDSYSST' })).toMatchObject({ kind: 'OB' });
  });

  it('i locali dell OB1 sono le informazioni di avvio in Temp', () => {
    expect(ctx.owner.kind).toBe('OB');
    const names = ctx.owner.iface.temp.map((m) => m.name);
    expect(names).toContain('OB1_SCAN_1');
    expect(names.length).toBeGreaterThan(5);
  });

  it('interfaccia di un FB, DB globale e tipi con nome', () => {
    const nastro = ctx.block({ name: 'Nastro' })!;
    expect(nastro.iface!.static.map((m) => m.name)).toEqual(['Ax']);
    expect(ctx.block({ name: 'Dati' })!.dbMembers!.map((m) => m.name)).toEqual(['A']);
    expect(ctx.resolve('Asse')).toMatchObject({ kind: 'udt' });
    expect(ctx.resolve('Nastro')).toMatchObject({ kind: 'fb' });
    expect(ctx.resolve('TON')).toMatchObject({ kind: 'fb' });
  });

  it('proprietario FB, FC e non di codice', () => {
    const fb = d.blocks.find((b) => b.name === 'Linea')!;
    expect(createAwlContext(d, fb.id, undefined).owner.kind).toBe('FB');
    const db = d.blocks.find((b) => b.kind === 'DB')!;
    const empty = createAwlContext(d, db.id, undefined);
    expect(empty.owner).toMatchObject({ kind: 'OB' });
    expect(empty.owner.iface.temp).toEqual([]);
    expect(createAwlContext(d, 'non-esiste', undefined).owner.kind).toBe('OB');
  });

  it('limiti dalla CPU; assenti senza CPU', () => {
    const l = cpu315pn.limits;
    expect(ctx.limits).toEqual({
      timers: l.timers,
      counters: l.counters,
      mBytes: l.mBytes,
      inputBytes: l.inputBytes,
      outputBytes: l.outputBytes,
    });
    expect(createAwlContext(d, ob1(d).id, undefined).limits).toBeUndefined();
    expect(findCpu(d.cpu.typeId)).toBeDefined();
  });

  it('RDSYSST porta gli alias SZL e il controllo li accetta', () => {
    const info = ctx.block({ name: 'RDSYSST' })!;
    expect(info.paramAliases).toEqual({ SZL_ID: 'SSL_ID', SZL_HEADER: 'SSL_HEADER' });
    const e = makeDevice();
    const o = ob1(e);
    o.interface.temp.push({
      id: 'h',
      name: 'Hdr',
      type: 'Struct',
      comment: '',
      members: [{ id: 'h1', name: 'LEN', type: 'Int', comment: '' }],
    });
    const c = createAwlContext(e, o.id, cpu315pn);
    const call = (a: string, b: string) =>
      `CALL "RDSYSST"\n(REQ := M 0.0, ${a} := W#16#1C, INDEX := W#16#0, RET_VAL := MW 4, BUSY := M 0.1, ${b} := #Hdr, DR := P#M 10.0 BYTE 8)`;
    expect(checkBlockCode([call('SZL_ID', 'SZL_HEADER')], c, 'international')).toEqual([]);
    expect(checkBlockCode([call('SSL_ID', 'SSL_HEADER')], c, 'international')).toEqual([]);
  });
});

describe('aiuti per le sorgenti', () => {
  it('aggiungere, trovare, eliminare', () => {
    const d = makeDevice();
    const a = addSource(d, 'A.awl', 'x');
    const b = addSource(d, 'a.awl', 'y');
    expect(b.name).toBe('a_1.awl');
    expect(findSource(d, a.id)).toBe(a);
    deleteSource(d, a.id);
    expect(d.sources.map((s) => s.name)).toEqual(['a_1.awl']);
    deleteSource(d, 'inesistente');
    expect(d.sources).toHaveLength(1);
  });
});
