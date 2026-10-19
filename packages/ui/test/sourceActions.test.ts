import { describe, expect, it } from 'vitest';
import { SOURCE_ERROR_CODES } from '@baaportal/importers';
import { createProject, createSource } from '@baaportal/project';
import itJson from '../src/i18n/it.json';
import enJson from '../src/i18n/en.json';
import { checkRename } from '../src/project/navigation/objectCommands';
import { offsetOfLineCol, sourceErrorKey } from '../src/project/navigation/sourceActions';
import { systemBlocksOf } from '../src/project/navigation/systemBlocks';
import { ids } from '../src/project/navigation/treeIds';
import type { OpenDoc } from '../src/state/store';
import { fb, instanceDb, mem, plc } from './blockFixtures';

const get = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

describe('Blocchi di sistema richiamati', () => {
  it('CALL per nome e per numero, UC e CC, senza duplicati', () => {
    const d = plc();
    const f = fb('Nastro');
    f.networks = [
      { id: 'a', title: '', comment: '', source: 'CALL "TON", DB1\n  IN := M0.0' },
      { id: 'b', title: '', comment: '', source: 'CALL SFC 1\nUC "READ_CLK"\nCC SFC 20' },
      { id: 'c', title: '', comment: '', source: 'CALL "TON", DB1' },
    ];
    d.blocks.push(f);
    expect(systemBlocksOf(d).map((b) => `${b.kind}${b.number} ${b.name}`)).toEqual([
      'SFC20 BLKMOV',
      'SFC1 READ_CLK',
      'SFB4 TON',
    ]);
  });

  it('SFB come istanza (DB di istanza) e come membro Static, anche in un array o in una struct', () => {
    const d = plc();
    const f = fb('Nastro', {
      static: [
        mem('Ritardo', 'Array[1..2] of "TOF"'),
        mem('Gruppo', 'Struct', { members: [mem('Conta', '"CTU"')] }),
      ],
    });
    d.blocks.push(f, instanceDb('Dati', 'TON'));
    expect(systemBlocksOf(d).map((b) => b.name)).toEqual(['CTU', 'TOF', 'TON']);
  });

  it('un blocco del progetto con lo stesso nome ha la precedenza sul blocco di sistema', () => {
    const d = plc();
    const mine = fb('TON');
    const caller = fb('Altro');
    caller.networks = [{ id: 'a', title: '', comment: '', source: 'CALL "TON", DB1' }];
    d.blocks.push(mine, caller);
    expect(systemBlocksOf(d)).toEqual([]);
  });

  it("gli errori di sintassi non fermano l'elenco", () => {
    const d = plc();
    const f = fb('Nastro');
    f.networks = [{ id: 'a', title: '', comment: '', source: 'FOO 1\nCALL "TON", DB1' }];
    d.blocks.push(f);
    expect(systemBlocksOf(d).map((b) => b.name)).toEqual(['TON']);
  });
});

describe('Rinomina di una sorgente', () => {
  const doc = (names: string[]): OpenDoc => {
    const project = createProject(
      { name: 'P', author: '', comment: '' },
      new Date('2026-01-01T00:00:00Z'),
    );
    const d = plc();
    d.sources = names.map((n, i) => ({ ...createSource(n, ''), id: `s${i}` }));
    project.devices.push(d);
    return { project, filePath: '', dirty: false, revision: 0, savedRevision: 0 };
  };
  it("rifiuta un nome già usato da un'altra sorgente (senza distinguere le maiuscole)", () => {
    const dc = doc(['A.awl', 'B.awl']);
    const dev = dc.project.devices[0]!.id;
    expect(checkRename(dc, ids.source(dev, 's0'), 'b.AWL')).toBe('DUPLICATE');
    expect(checkRename(dc, ids.source(dev, 's0'), 'C.awl')).toBeNull();
    // Lo stesso nome della sorgente stessa (cambio di maiuscole) è lecito.
    expect(checkRename(dc, ids.source(dev, 's0'), 'a.awl')).toBeNull();
  });
  it('rifiuta nomi vuoti o con caratteri non ammessi in un nome di file', () => {
    const dc = doc(['A.awl']);
    const dev = dc.project.devices[0]!.id;
    for (const bad of ['', '  ', 'a/b.awl', 'a:b.awl', 'a?.awl'])
      expect(checkRename(dc, ids.source(dev, 's0'), bad)).toBe('INVALID');
  });
});

describe('Errori di sorgente', () => {
  it('ogni codice di errore ha un messaggio in italiano e in inglese', () => {
    expect(SOURCE_ERROR_CODES.length).toBeGreaterThan(10);
    for (const code of SOURCE_ERROR_CODES) {
      const key = sourceErrorKey(code);
      expect(get(itJson, key), `it ${key}`).toEqual(expect.any(String));
      expect(get(enJson, key), `en ${key}`).toEqual(expect.any(String));
    }
  });
});

describe('Posizione nel testo', () => {
  it('riga e colonna (da 1) diventano uno spostamento nel testo mostrato, con CRLF', () => {
    const text = 'ab\r\ncde\nf';
    expect(offsetOfLineCol(text, 1, 1)).toBe(0);
    expect(offsetOfLineCol(text, 2, 2)).toBe(3 + 1);
    expect(offsetOfLineCol(text, 3, 1)).toBe(3 + 4);
    // Oltre la fine: l'ultima posizione della riga o del testo.
    expect(offsetOfLineCol(text, 2, 99)).toBe(3 + 3);
    expect(offsetOfLineCol(text, 99, 1)).toBe(text.replace(/\r\n/g, '\n').length);
  });
});
