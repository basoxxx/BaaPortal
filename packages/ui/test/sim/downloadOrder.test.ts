import { describe, expect, it } from 'vitest';
import { downloadOrder } from '../../src/sim/downloadOrder';

describe('ordine di caricamento', () => {
  it('DB e DB di istanza, poi FC, FB e OB, per numero dentro ogni gruppo', () => {
    const items = [
      { kind: 'OB', number: 1 },
      { kind: 'FB', number: 2 },
      { kind: 'FC', number: 5 },
      { kind: 'IDB', number: 3 },
      { kind: 'OB', number: 35 },
      { kind: 'DB', number: 10 },
      { kind: 'FC', number: 1 },
      { kind: 'FB', number: 1 },
      { kind: 'DB', number: 2 },
    ];
    expect(downloadOrder(items).map((b) => `${b.kind}${b.number}`)).toEqual([
      'DB2',
      'IDB3',
      'DB10',
      'FC1',
      'FC5',
      'FB1',
      'FB2',
      'OB1',
      'OB35',
    ]);
  });
});
