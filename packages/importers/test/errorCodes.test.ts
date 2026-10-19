import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARSE_ERROR_CODES } from '@baaportal/awl';
import {
  SOURCE_AWL_ERROR_CODES,
  SOURCE_ERROR_CODES,
  SOURCE_STRUCTURE_ERROR_CODES,
} from '../src/index';

describe('codici di errore delle sorgenti', () => {
  it("l'elenco esportato contiene ogni codice emesso dal lettore", () => {
    const dir = join(__dirname, '../src/awlSource');
    const used = new Set<string>();
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/\.error\([^;]*?'([A-Z][A-Z_]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(8);
    for (const code of used) expect(SOURCE_STRUCTURE_ERROR_CODES, code).toContain(code);
    expect(new Set(SOURCE_ERROR_CODES).size).toBe(SOURCE_ERROR_CODES.length);
  });

  it('i codici del codice AWL sono quelli del parser (stesso elenco, non una copia)', () => {
    expect(SOURCE_AWL_ERROR_CODES).toBe(PARSE_ERROR_CODES);
    for (const code of PARSE_ERROR_CODES) expect(SOURCE_ERROR_CODES).toContain(code);
  });
});
