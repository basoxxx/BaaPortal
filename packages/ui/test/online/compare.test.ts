import { describe, expect, it } from 'vitest';
import { buildBlockFile } from '@baaportal/s7comm';
import { compareBlocks, type CompareProjectBlock } from '../../src/online/compare';
import type { OnlineBlock } from '../../src/online/plcTypes';

/** File compilato finto: contano solo checksum (footer) e lunghezza MC7 (intestazione). */
function file(
  type: 'OB' | 'FB' | 'FC' | 'DB',
  number: number,
  mc7Length: number,
  checksum: number,
) {
  return buildBlockFile(
    {
      type,
      number,
      language: 1,
      flags: 0,
      security: 0,
      codeTime: undefined,
      interfaceTime: undefined,
      codeTimeRaw: new Uint8Array(6),
      interfaceTimeRaw: new Uint8Array(6),
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length,
    },
    new Uint8Array(mc7Length),
    { author: 'A', family: 'F', name: 'N', version: '0.1', checksum },
  );
}

const online = (
  type: OnlineBlock['type'],
  number: number,
  mc7Length: number,
  checksum: number,
): OnlineBlock => ({ type, number, loadLength: mc7Length + 72, mc7Length, checksum });

const blk = (
  id: string,
  type: CompareProjectBlock['type'],
  number: number,
  f?: Uint8Array,
): CompareProjectBlock => ({ id, type, number, ...(f ? { file: f } : {}) });

describe('compareBlocks', () => {
  it('uguale: stesso checksum e stessa lunghezza MC7', () => {
    const rows = compareBlocks(
      [blk('a', 'FC', 1, file('FC', 1, 10, 0x1234))],
      [online('FC', 1, 10, 0x1234)],
    );
    expect(rows).toEqual([{ type: 'FC', number: 1, blockId: 'a', state: 'same' }]);
  });

  it('diverso per checksum', () => {
    const rows = compareBlocks(
      [blk('a', 'FC', 1, file('FC', 1, 10, 0x1234))],
      [online('FC', 1, 10, 0x9999)],
    );
    expect(rows[0]?.state).toBe('different');
  });

  it('diverso per lunghezza MC7, anche a checksum uguale', () => {
    const rows = compareBlocks(
      [blk('a', 'OB', 1, file('OB', 1, 10, 0x1234))],
      [online('OB', 1, 12, 0x1234)],
    );
    expect(rows[0]?.state).toBe('different');
  });

  it('solo nel progetto', () => {
    const rows = compareBlocks([blk('a', 'DB', 5, file('DB', 5, 8, 1))], []);
    expect(rows).toEqual([{ type: 'DB', number: 5, blockId: 'a', state: 'offlineOnly' }]);
  });

  it('solo nella CPU', () => {
    const rows = compareBlocks([], [online('FB', 3, 20, 7)]);
    expect(rows).toEqual([{ type: 'FB', number: 3, state: 'onlineOnly' }]);
  });

  it('non compilato, qualunque cosa abbia la CPU', () => {
    const rows = compareBlocks(
      [blk('a', 'FC', 1), blk('b', 'FC', 2), blk('c', 'FC', 3, new Uint8Array(3))],
      [online('FC', 1, 10, 1)],
    );
    expect(rows.map((r) => r.state)).toEqual(['notCompiled', 'notCompiled', 'notCompiled']);
    expect(rows.some((r) => r.state === 'onlineOnly')).toBe(false);
  });

  it('SFC, SFB e SDB sono esclusi', () => {
    const rows = compareBlocks(
      [],
      [
        online('SFC', 20, 1, 1),
        online('SFB', 4, 1, 1),
        online('SDB', 0, 1, 1),
        online('OB', 1, 1, 1),
      ],
    );
    expect(rows).toEqual([{ type: 'OB', number: 1, state: 'onlineOnly' }]);
  });

  it('i tipi non si confondono: FC1 e FB1 sono blocchi diversi', () => {
    const rows = compareBlocks([blk('a', 'FC', 1, file('FC', 1, 4, 5))], [online('FB', 1, 4, 5)]);
    expect(rows.map((r) => r.state)).toEqual(['offlineOnly', 'onlineOnly']);
  });
});
