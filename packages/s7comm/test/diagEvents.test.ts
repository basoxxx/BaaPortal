import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENTS, EVENT_CLASSES, decodeEventId, describeEvent } from '../src';

const DOC = readFileSync(
  fileURLToPath(new URL('../../../docs/protocollo/s7comm.md', import.meta.url)),
  'utf8',
);

/** Righe della tabella di §7.6.3: celle già senza backtick. */
function docRows(): string[][] {
  const a = DOC.indexOf('#### 7.6.3');
  const b = DOC.indexOf('#### 7.6.4');
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return DOC.slice(a, b)
    .split('\n')
    .filter((l) => /^\|\s*`0x/.test(l))
    .map((l) =>
      l
        .split('|')
        .map((c) => c.trim().replace(/`/g, ''))
        .filter((c) => c !== ''),
    );
}

describe('event ID (proto §7.6.2)', () => {
  it('decodeEventId: classe, numero e bit', () => {
    expect(decodeEventId(0x4302)).toEqual({
      cls: 4,
      number: 0x02,
      incoming: true,
      internal: false,
      external: false,
      inBuffer: true,
    });
    expect(decodeEventId(0x3d99)).toMatchObject({
      cls: 3,
      incoming: true,
      internal: true,
      external: true,
    });
  });

  it('describeEvent: esatto, invertito, maschera, utente, generico', () => {
    expect(describeEvent(0x4304, 'it')).toEqual({
      text: 'STOP dal PG o da SFB 20',
      source: 'exact',
    });
    const f = describeEvent(0x3963, 'it');
    expect(f.source).toBe('flipped');
    expect(f.text).toBe(`${EVENTS.get(0x3863)!.it} (entrante)`);
    expect(describeEvent(0x3863, 'it').source).toBe('exact');
    expect(describeEvent(0x3963, 'en').text).toBe(`${EVENTS.get(0x3863)!.en} (incoming)`);
    expect(describeEvent(0x8103, 'it')).toEqual({ text: 'errore di canale', source: 'masked' });
    expect(describeEvent(0xa123, 'it')).toEqual({ text: 'evento utente 0xA123', source: 'user' });
    expect(describeEvent(0xb001, 'en').source).toBe('user');
    const g = describeEvent(0x5f01, 'it');
    expect(g.source).toBe('generic');
    expect(g.text).toContain('eventi di esecuzione');
    expect(g.text).toContain('0x01');
    const g2 = describeEvent(0x3d99, 'it');
    expect(g2.source).toBe('generic');
    expect(g2.text).toContain('errori asincroni');
    expect(g2.text).toContain('entrante');
    expect(g2.text).toContain('errore interno ed esterno');
    expect(describeEvent(0x3099, 'it').text).not.toContain('errore');
    expect(describeEvent(0x3499, 'en').text).toContain('internal error');
    expect(describeEvent(0x3899, 'en').text).toContain('external error');
    expect(describeEvent(0xf001, 'it').source).toBe('generic');
    expect(describeEvent(0x9001, 'it').source).toBe('generic');
  });

  it('la tabella ha gli stessi ID di §7.6.3', () => {
    const docIds = new Set<number>();
    for (const row of docRows()) {
      if (row[0]!.includes('…')) {
        // la riga della classe 8 vale per 0x8000-0x8007
        for (let i = 0; i < 8; i++) docIds.add(0x8000 + i);
        continue;
      }
      for (const m of row[0]!.matchAll(/0x([0-9A-Fa-f]{4})/g)) docIds.add(parseInt(m[1]!, 16));
    }
    expect(docIds.size).toBeGreaterThan(100);
    expect([...EVENTS.keys()].sort((a, b) => a - b)).toEqual([...docIds].sort((a, b) => a - b));
  });

  it('gli stessi testi italiani per le righe a un ID', () => {
    let checked = 0;
    for (const row of docRows()) {
      const ids = [...row[0]!.matchAll(/0x([0-9A-Fa-f]{4})/g)];
      if (ids.length !== 1 || row[0]!.includes('…')) continue;
      const id = parseInt(ids[0]![1]!, 16);
      expect(EVENTS.get(id)?.it, `0x${id.toString(16)}`).toBe(row[1]);
      checked++;
    }
    expect(checked).toBeGreaterThan(90);
  });

  it('le righe a due ID hanno due voci, con uscente/entrante dove il testo è lo stesso', () => {
    expect(EVENTS.get(0x3821)!.it).toMatch(/\(uscente\)$/);
    expect(EVENTS.get(0x3921)!.it).toMatch(/\(entrante\)$/);
    expect(EVENTS.get(0x6981)!.it).toMatch(/\(entrante\)$/);
    expect(EVENTS.get(0x6881)!.it).toMatch(/\(uscente\)$/);
    expect(EVENTS.get(0x3821)!.en).toMatch(/\(outgoing\)$/);
  });

  it('ogni voce ha un testo inglese non vuoto; ogni classe ha un nome', () => {
    for (const [id, t] of EVENTS) {
      expect(t.en.trim(), `0x${id.toString(16)}`).not.toBe('');
      expect(t.it.trim()).not.toBe('');
    }
    for (let c = 1; c <= 15; c++) {
      expect(EVENT_CLASSES[c]?.it).toBeTruthy();
      expect(EVENT_CLASSES[c]?.en).toBeTruthy();
    }
  });
});
