import { describe, expect, it } from 'vitest';
import { formatType, parseType, type TypedMember } from '@baaportal/s7-types';
import { SYSTEM_BLOCKS, findSystemBlock, type SystemBlock } from '../src';

const sig = (b: SystemBlock) => {
  const list = (ms: TypedMember[]) => ms.map((m) => `${m.name}:${formatType(m.type)}`);
  return { input: list(b.input), output: list(b.output) };
};
const all = (b: SystemBlock): TypedMember[] => [
  ...b.input,
  ...b.output,
  ...b.inOut,
  ...(b.static ?? []),
];

describe('catalogo SFC/SFB', () => {
  it('SFB 4 TON e SFC 1 READ_CLK con le interfacce attese', () => {
    expect(findSystemBlock({ kind: 'SFB', number: 4 })!.name).toBe('TON');
    expect(sig(findSystemBlock({ name: 'TON' })!)).toEqual({
      input: ['IN:Bool', 'PT:Time'],
      output: ['Q:Bool', 'ET:Time'],
    });
    expect(findSystemBlock({ name: 'READ_CLK' })!.returnType).toBe('Int');
  });

  it('SFC 20 BLKMOV: SRCBLK in, DSTBLK out, RET_VAL Int', () => {
    const b = findSystemBlock({ kind: 'SFC', number: 20 })!;
    expect(b.name).toBe('BLKMOV');
    expect(sig(b)).toEqual({ input: ['SRCBLK:Any'], output: ['DSTBLK:Any'] });
    expect(b.returnType).toBe('Int');
  });

  it('numeri e nomi unici per tipo, nomi senza ambiguita tra SFC e SFB', () => {
    for (const kind of ['SFC', 'SFB'] as const) {
      const of = SYSTEM_BLOCKS.filter((b) => b.kind === kind);
      expect(of.length).toBeGreaterThan(0);
      expect(new Set(of.map((b) => b.number)).size).toBe(of.length);
    }
    const names = SYSTEM_BLOCKS.map((b) => b.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('ogni voce ha parametri o e esplicitamente senza, i nomi sono unici, RET_VAL e valido', () => {
    const PARAMETERLESS = ['SFC41', 'SFC42', 'SFC43', 'SFC46', 'SFC64'];
    for (const b of SYSTEM_BLOCKS) {
      expect(b.source.trim(), b.name).not.toBe('');
      const params = all(b);
      if (PARAMETERLESS.includes(`${b.kind}${b.number}`)) {
        expect(params, b.name).toEqual([]);
      } else {
        expect(params.length, b.name).toBeGreaterThan(0);
      }
      const names = params.map((m) => m.name.toLowerCase());
      expect(new Set(names).size, b.name).toBe(names.length);
      if (b.kind === 'SFB') expect(b.returnType, b.name).toBeUndefined();
      if (b.returnType !== undefined) {
        const r = parseType(b.returnType);
        expect(r.ok, `${b.name} RET_VAL`).toBe(true);
        expect(r.ok && r.type.kind !== 'void', b.name).toBe(true);
      }
      // Le SFC hanno RET_VAL tranne WAIT, RE_TRIGR e STP.
      if (b.kind === 'SFC' && !['SFC43', 'SFC46', 'SFC47'].includes(`SFC${b.number}`)) {
        expect(b.returnType, b.name).toBeDefined();
      }
    }
  });

  it('interfacce fissate: RDSYSST, FILL, CREAT_DB, TIME_TCK', () => {
    const rdsysst = findSystemBlock({ kind: 'SFC', number: 51 })!;
    expect(rdsysst.name).toBe('RDSYSST');
    expect(sig(rdsysst)).toEqual({
      input: ['REQ:Bool', 'SSL_ID:Word', 'INDEX:Word'],
      output: ['BUSY:Bool', 'SSL_HEADER:Struct', 'DR:Any'],
    });
    expect(rdsysst.returnType).toBe('Int');
    const fill = findSystemBlock({ kind: 'SFC', number: 21 })!;
    expect(fill.name).toBe('FILL');
    expect(sig(fill)).toEqual({ input: ['BVAL:Any'], output: ['BLK:Any'] });
    expect(fill.returnType).toBe('Int');
    const creat = findSystemBlock({ kind: 'SFC', number: 22 })!;
    expect(creat.name).toBe('CREAT_DB');
    expect(sig(creat)).toEqual({
      input: ['LOW_LIMIT:Word', 'UP_LIMIT:Word', 'COUNT:Word'],
      output: ['DB_NUMBER:Word'],
    });
    const tick = findSystemBlock({ kind: 'SFC', number: 64 })!;
    expect(tick.name).toBe('TIME_TCK');
    expect(sig(tick)).toEqual({ input: [], output: [] });
    expect(tick.returnType).toBe('Time');
  });

  it('interfacce fissate: RDREC, WRREC, CONT_C', () => {
    const rd = findSystemBlock({ kind: 'SFB', number: 52 })!;
    expect(rd.name).toBe('RDREC');
    expect(sig(rd)).toEqual({
      input: ['REQ:Bool', 'ID:DWord', 'INDEX:Int', 'MLEN:Int'],
      output: ['VALID:Bool', 'BUSY:Bool', 'ERROR:Bool', 'STATUS:DWord', 'LEN:Int'],
    });
    expect(rd.inOut.map((m) => `${m.name}:${formatType(m.type)}`)).toEqual(['RECORD:Any']);
    const wr = findSystemBlock({ kind: 'SFB', number: 53 })!;
    expect(wr.name).toBe('WRREC');
    expect(sig(wr)).toEqual({
      input: ['REQ:Bool', 'ID:DWord', 'INDEX:Int', 'LEN:Int'],
      output: ['DONE:Bool', 'BUSY:Bool', 'ERROR:Bool', 'STATUS:DWord'],
    });
    expect(wr.inOut.map((m) => `${m.name}:${formatType(m.type)}`)).toEqual(['RECORD:Any']);
    const c = sig(findSystemBlock({ kind: 'SFB', number: 41 })!);
    expect(c.input).toEqual(
      expect.arrayContaining([
        'COM_RST:Bool',
        'CYCLE:Time',
        'SP_INT:Real',
        'PV_PER:Word',
        'GAIN:Real',
      ]),
    );
    expect(c.output).toEqual(
      expect.arrayContaining(['LMN:Real', 'LMN_PER:Word', 'QLMN_HLM:Bool', 'ER:Real']),
    );
  });

  it('SFB 32 DRUM: EVENT1..16, OUT0..15 e dati statici documentati', () => {
    const d = findSystemBlock({ kind: 'SFB', number: 32 })!;
    const s = sig(d);
    expect(s.input).toContain('EVENT16:Bool');
    expect(s.output).toContain('OUT0:Bool');
    expect(s.output).toContain('OUT15:Bool');
    expect(s.output).not.toContain('OUT16:Bool');
    expect(d.static!.map((m) => `${m.name}:${formatType(m.type)}`)).toContain(
      'S_PRESET:Array[1..16] of Word',
    );
  });

  it('ricerca per nome senza distinguere maiuscole, per numero esatta', () => {
    expect(findSystemBlock({ name: 'ton' })).toBe(findSystemBlock({ kind: 'SFB', number: 4 }));
    expect(findSystemBlock({ kind: 'SFC', number: 4 })!.name).toBe('READ_RTM');
    expect(findSystemBlock({ kind: 'SFB', number: 20 })).toBeUndefined();
    expect(findSystemBlock({ name: 'Nonexistent' })).toBeUndefined();
    expect(findSystemBlock({ name: '__proto__' })).toBeUndefined();
    expect(findSystemBlock({ name: 'constructor' })).toBeUndefined();
  });

  it('SFB 0-5 sono i contatori e i temporizzatori IEC', () => {
    const names = [0, 1, 2, 3, 4, 5].map((n) => findSystemBlock({ kind: 'SFB', number: n })?.name);
    expect(names).toEqual(['CTU', 'CTD', 'CTUD', 'TP', 'TON', 'TOF']);
  });
});
