import { describe, expect, it } from 'vitest';
import { createWatchRow, type WatchFormat } from '@baaportal/project';
import {
  addressText,
  formatValue,
  parseCommand,
  planCommand,
  resolveRows,
  statusOf,
  watchPlan,
  type RowInfo,
} from '../../src/editors/watch/watchRows';

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (r: ReturnType<typeof formatValue>) => ('text' in r ? r.text : `!${r.error.key}`);

describe('formato dei valori di stato', () => {
  it.each([
    ['BOOL', 'X', [1], 'TRUE'],
    ['BOOL', 'X', [0], 'FALSE'],
    ['DEC', 'W', [0xff, 0xfb], '-5'],
    ['DEC', 'B', [200], '200'],
    ['DEC', 'D', [0xff, 0xff, 0xff, 0xff], '-1'],
    ['HEX', 'W', [0, 0xab], '16#00AB'],
    ['HEX', 'D', [0, 1, 2, 3], '16#00010203'],
    ['BIN', 'B', [0b10100101], '2#1010_0101'],
    ['CHAR', 'B', [65], "'A'"],
    ['CHAR', 'B', [7], "'\\x07'"],
    ['FLOAT', 'D', [0x3f, 0x80, 0, 0], '1'],
    ['FLOAT', 'D', [0x3d, 0xcc, 0xcc, 0xcd], '0.1'],
    ['S5TIME', 'W', [0x21, 0x23], 'S5T#2M3S'],
    ['S5TIME', 'W', [0x00, 0x00], 'S5T#0MS'],
    ['TIME', 'D', [0, 0, 0x0b, 0xb8], 'T#3S'],
    ['TIME', 'D', [0xff, 0xff, 0xf4, 0x48], 'T#-3S'],
    ['BCD', 'W', [0x01, 0x23], '123'],
    ['BCD', 'W', [0, 0], '0'],
  ] as [WatchFormat, 'X' | 'B' | 'W' | 'D', number[], string][])(
    '%s %s %j → %s',
    (f, size, b, out) => {
      expect(text(formatValue(Uint8Array.from(b), f, size))).toBe(out);
    },
  );

  it('segno: tipo senza segno, con segno, non noto', () => {
    expect(text(formatValue(bytes(0xff, 0xfb), 'DEC', 'W', 'unsigned'))).toBe('65531');
    expect(text(formatValue(bytes(0xff, 0xfb), 'DEC', 'W', 'signed'))).toBe('-5');
    expect(text(formatValue(bytes(0xff), 'DEC', 'B', 'any'))).toBe('255');
  });

  it('BCD non valido e formato che non si addice alla dimensione', () => {
    expect(text(formatValue(bytes(0x01, 0x2a), 'BCD', 'W'))).toBe('!BCD');
    expect(text(formatValue(bytes(0x0f, 0x23), 'S5TIME', 'W'))).toBe('!BCD');
    expect(text(formatValue(bytes(1), 'FLOAT', 'X'))).toBe('!FORMAT');
    expect(text(formatValue(bytes(1), 'DEC', 'W'))).toBe('!LENGTH');
  });
});

describe('validazione del valore di comando', () => {
  const ok = (
    t: string,
    f: WatchFormat,
    size: 'X' | 'B' | 'W' | 'D',
    sign?: 'signed' | 'unsigned' | 'any',
  ) => {
    const r = parseCommand(t, f, size, sign);
    return r.ok ? hex(r.data) : `!${r.error.key}`;
  };

  it('BOOL: TRUE, FALSE, 1, 0', () => {
    expect(ok('true', 'BOOL', 'X')).toBe('01');
    expect(ok(' 1 ', 'BOOL', 'X')).toBe('01');
    expect(ok('FALSE', 'BOOL', 'X')).toBe('00');
    expect(ok('0', 'BOOL', 'X')).toBe('00');
    expect(ok('2', 'BOOL', 'X')).toBe('!BOOL');
  });

  it('DEC: intervalli per dimensione e segno', () => {
    expect(ok('-5', 'DEC', 'W', 'signed')).toBe('fffb');
    expect(ok('32767', 'DEC', 'W', 'signed')).toBe('7fff');
    expect(ok('32768', 'DEC', 'W', 'signed')).toBe('!RANGE');
    expect(ok('65535', 'DEC', 'W', 'unsigned')).toBe('ffff');
    expect(ok('-1', 'DEC', 'W', 'unsigned')).toBe('!RANGE');
    expect(ok('65535', 'DEC', 'W', 'any')).toBe('ffff'); // indirizzo nudo: il segno non è noto
    expect(ok('-32768', 'DEC', 'W', 'any')).toBe('8000');
    expect(ok('255', 'DEC', 'B', 'unsigned')).toBe('ff');
    expect(ok('256', 'DEC', 'B', 'unsigned')).toBe('!RANGE');
    expect(ok('-2147483648', 'DEC', 'D', 'signed')).toBe('80000000');
    expect(ok('2147483648', 'DEC', 'D', 'signed')).toBe('!RANGE');
    expect(ok('1.5', 'DEC', 'W')).toBe('!SYNTAX');
    expect(ok('', 'DEC', 'W')).toBe('!SYNTAX');
  });

  it('HEX con 16# e BIN con 2#', () => {
    expect(ok('16#FF', 'HEX', 'W')).toBe('00ff');
    expect(ok('ff', 'HEX', 'B')).toBe('ff');
    expect(ok('16#100', 'HEX', 'B')).toBe('!RANGE');
    expect(ok('16#G', 'HEX', 'B')).toBe('!SYNTAX');
    expect(ok('2#1010_0101', 'BIN', 'B')).toBe('a5');
    expect(ok('2#1_0000_0000', 'BIN', 'B')).toBe('!RANGE');
    expect(ok('2#12', 'BIN', 'B')).toBe('!SYNTAX');
  });

  it('CHAR, FLOAT', () => {
    expect(ok("'A'", 'CHAR', 'B')).toBe('41');
    expect(ok('A', 'CHAR', 'B')).toBe('41');
    expect(ok('AB', 'CHAR', 'B')).toBe('!SYNTAX');
    expect(ok('€', 'CHAR', 'B')).toBe('!RANGE');
    expect(ok('1', 'FLOAT', 'D')).toBe('3f800000');
    expect(ok('-2.5e1', 'FLOAT', 'D')).toBe('c1c80000');
    expect(ok('abc', 'FLOAT', 'D')).toBe('!SYNTAX');
    expect(ok('1e40', 'FLOAT', 'D')).toBe('!RANGE');
  });

  it('S5TIME: base e valore scelti, intervallo, sintassi', () => {
    expect(ok('S5T#1S', 'S5TIME', 'W')).toBe('0100'); // 100 x 10 ms
    expect(ok('S5T#2M3S', 'S5TIME', 'W')).toBe('2123'); // 123 x 1s
    expect(ok('s5t#10MS', 'S5TIME', 'W')).toBe('0001');
    expect(ok('S5T#0MS', 'S5TIME', 'W')).toBe('0000');
    expect(ok('S5T#2H46M30S', 'S5TIME', 'W')).toBe('3999');
    expect(ok('S5T#2H46M40S', 'S5TIME', 'W')).toBe('!RANGE');
    expect(ok('S5T#5MS', 'S5TIME', 'W')).toBe('!S5_RESOLUTION'); // sotto i 10 ms
    expect(ok('S5T#10S10MS', 'S5TIME', 'W')).toBe('!S5_RESOLUTION'); // 1001 x 10 ms, non multiplo di 100 ms
    expect(ok('S5T#1S2H', 'S5TIME', 'W')).toBe('!SYNTAX'); // fuori ordine
    expect(ok('1S', 'S5TIME', 'W')).toBe('!SYNTAX');
  });

  it('TIME', () => {
    expect(ok('T#3S', 'TIME', 'D')).toBe('00000bb8');
    expect(ok('T#-3S', 'TIME', 'D')).toBe('fffff448');
    expect(ok('T#1D2H', 'TIME', 'D')).toBe('05943900');
    expect(ok('T#25D', 'TIME', 'D')).toBe('!RANGE');
    expect(ok('T#', 'TIME', 'D')).toBe('!SYNTAX');
    expect(ok('3S', 'TIME', 'D')).toBe('!SYNTAX');
  });

  it('BCD: solo cifre', () => {
    expect(ok('123', 'BCD', 'W')).toBe('0123');
    expect(ok('12345', 'BCD', 'W')).toBe('!RANGE');
    expect(ok('1a', 'BCD', 'W')).toBe('!SYNTAX');
  });

  it('formato che non si addice alla dimensione', () => {
    expect(ok('1.5', 'FLOAT', 'W')).toBe('!FORMAT');
    expect(ok('1', 'DEC', 'X')).toBe('!FORMAT');
  });
});

describe('piano di osservazione e di comando', () => {
  const target = { area: 'M' as const, byte: 10, size: 'W' as const };
  const good = (format: WatchFormat = 'DEC'): RowInfo => ({
    ok: true,
    target,
    format,
    sign: 'signed',
  });
  const rows = [
    { ...createWatchRow('a', 'DEC', () => 'a'), modify: '5' },
    { ...createWatchRow('b', 'DEC', () => 'b'), modify: 'zz' },
    { ...createWatchRow('c', 'FLOAT', () => 'c'), modify: '1' },
    { ...createWatchRow('d', 'DEC', () => 'd'), modify: '' },
    { ...createWatchRow('e', 'DEC', () => 'e'), modify: '1' },
    { ...createWatchRow('f', 'DEC', () => 'f'), modify: '1' },
  ];
  const infoOf = (r: { id: string }): RowInfo => {
    if (r.id === 'c') return { ...good('FLOAT'), formatError: { key: 'FORMAT' } };
    if (r.id === 'e') return { ok: false, error: { key: 'row.UNKNOWN' } };
    if (r.id === 'f')
      return {
        ok: true,
        target: { area: 'T', byte: 1, size: 'W' },
        format: 'S5TIME',
        sign: 'unsigned',
      };
    return good();
  };

  it('osserva le righe con operando e formato validi (T e C compresi)', () => {
    expect(watchPlan(rows, infoOf)).toEqual({
      rowIds: ['a', 'b', 'd', 'f'],
      items: [target, target, target, { area: 'T', byte: 1, size: 'W' }],
    });
  });

  it('comanda: scritture per le righe valide, un errore per le altre, niente per le righe senza comando', () => {
    const p = planCommand(rows, infoOf);
    expect(p.writes.map((w) => [w.rowId, hex(w.req.data)])).toEqual([['a', '0005']]);
    expect(p.writes[0]!.req).toMatchObject(target);
    expect(Object.fromEntries(Object.entries(p.errors).map(([k, v]) => [k, v.key]))).toEqual({
      b: 'SYNTAX',
      c: 'FORMAT',
      e: 'row.UNKNOWN',
      f: 'TC_WRITE',
    });
  });

  it('oltre 1000 righe osservabili le successive hanno un errore e la richiesta resta nel limite', () => {
    const many = Array.from({ length: 1003 }, (_, i) =>
      createWatchRow('MB0', 'HEX', () => `m${i}`),
    );
    const resolve = () => ({
      ok: true as const,
      target: { area: 'M' as const, byte: 0, size: 'B' as const },
      format: 'HEX' as const,
      sign: 'any' as const,
    });
    const infos = resolveRows(resolve, many);
    const plan = watchPlan(many, (r) => infos.get(r.id)!);
    expect(plan.items).toHaveLength(1000);
    const last = infos.get('m1002')!;
    expect(last.ok).toBe(false);
    expect(!last.ok && last.error.key).toBe('TOO_MANY');
    expect(infos.get('m999')!.ok).toBe(true);
  });

  it('stato: errore di riga, valore del simulatore, errore del simulatore', () => {
    expect(statusOf({ ok: false, error: { key: 'row.SYNTAX' } }, undefined)).toEqual({
      error: { key: 'row.SYNTAX' },
    });
    expect(statusOf(good(), undefined)).toBeUndefined();
    expect(statusOf(good(), { bytes: bytes(0, 7) })).toEqual({ text: '7' });
    expect(statusOf(good(), { error: 'DB9 non caricato' })).toEqual({
      error: { key: 'HOST', params: { message: 'DB9 non caricato' } },
    });
  });

  it('indirizzo in chiaro', () => {
    expect(addressText({ area: 'M', byte: 5, bit: 3, size: 'X' })).toBe('M 5.3');
    expect(addressText({ area: 'M', byte: 10, size: 'W' })).toBe('MW 10');
    expect(addressText({ area: 'DB', db: 1, byte: 4, size: 'W' })).toBe('DB1.DBW4');
    expect(addressText({ area: 'DB', db: 2, byte: 0, bit: 5, size: 'X' })).toBe('DB2.DBX0.5');
    expect(addressText({ area: 'T', byte: 5, size: 'W' })).toBe('T 5');
    expect(addressText({ area: 'PI', byte: 256, size: 'W' })).toBe('PIW 256');
  });
});
