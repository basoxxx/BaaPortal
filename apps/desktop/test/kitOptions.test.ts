import { describe, expect, it } from 'vitest';
import { kitFileName, parseKitOptions } from '../src/main/kitOptions';

const good = {
  host: '192.168.0.10',
  port: 102,
  rack: 0,
  slot: 2,
  connectionType: 'pg',
  includeBlocks: true,
};

describe('parseKitOptions', () => {
  it('accetta valori validi', () => {
    expect(parseKitOptions(good)).toEqual(good);
    expect(
      parseKitOptions({ ...good, host: 'plc-1.officina.local', connectionType: 'basic' }).host,
    ).toBe('plc-1.officina.local');
    expect(
      parseKitOptions({ ...good, port: 65535, rack: 7, slot: 31, includeBlocks: false }),
    ).toMatchObject({ port: 65535, rack: 7, slot: 31, includeBlocks: false });
  });
  it('porta a forma canonica gli IPv4 con zeri iniziali', () => {
    expect(parseKitOptions({ ...good, host: '192.168.000.010' }).host).toBe('192.168.0.10');
    expect(parseKitOptions({ ...good, host: '010.001.000.255' }).host).toBe('10.1.0.255');
    expect(parseKitOptions({ ...good, host: '000.000.000.000' }).host).toBe('0.0.0.0');
    // un nome host non si tocca, nemmeno se fatto di cifre e trattini
    expect(parseKitOptions({ ...good, host: 'plc-007.local' }).host).toBe('plc-007.local');
  });
  it.each([
    null,
    'x',
    [],
    { ...good, host: '' },
    { ...good, host: 5 },
    { ...good, host: '256.1.1.1' },
    { ...good, host: '1.2.3' },
    { ...good, host: '1.2.3.4.5' },
    { ...good, host: 'a b' },
    { ...good, host: 'host/../x' },
    { ...good, host: 'a:80' },
    { ...good, host: '-x' },
    { ...good, host: 'a..b' },
    { ...good, host: 'a'.repeat(254) },
    { ...good, port: 0 },
    { ...good, port: 65536 },
    { ...good, port: 102.5 },
    { ...good, port: '102' },
    { ...good, rack: 8 },
    { ...good, rack: -1 },
    { ...good, slot: 32 },
    { ...good, slot: NaN },
    { ...good, connectionType: 'x' },
    { ...good, connectionType: undefined },
    { ...good, includeBlocks: 'si' },
    { ...good, includeBlocks: undefined },
  ])('rifiuta %j con RangeError', (v) => {
    expect(() => parseKitOptions(v)).toThrow(RangeError);
  });
  it('accetta un host di 253 caratteri', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(host).toHaveLength(253);
    expect(parseKitOptions({ ...good, host }).host).toBe(host);
  });
});

describe('kitFileName', () => {
  it('usa numero di articolo e data, ripulendo i caratteri', () => {
    expect(kitFileName('6ES7 315-2EH14-0AB0', new Date(2026, 9, 20, 3, 7))).toBe(
      'raccolta-6ES7_315-2EH14-0AB0-20261020-0307.zip',
    );
    expect(kitFileName('a/b\\c:*?"<>|', new Date(2026, 0, 2, 13, 45))).toBe(
      'raccolta-a_b_c-20260102-1345.zip',
    );
  });
  it("senza numero di articolo usa 'cpu'", () => {
    expect(kitFileName(undefined, new Date(2026, 0, 2, 13, 45))).toBe(
      'raccolta-cpu-20260102-1345.zip',
    );
    expect(kitFileName('   ', new Date(2026, 0, 2, 13, 45))).toBe('raccolta-cpu-20260102-1345.zip');
  });
});
