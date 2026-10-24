import { INSTRUCTIONS } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { OPS } from '../src';
import { batteryFiles, runBatteryFile } from './batteryRunner';

/**
 * Istruzioni che la batteria non esegue perché il piano 2B le aggiunge:
 *  - contatori: CU, CD (categoria `counter`), del Task 2;
 *  - CALL, che nell'MC7 non esiste come istruzione (la chiamata compilata è UC o CC);
 *  - le chiamate di SFC e SFB (UC/CC con operando SFC o SFB), che sono operandi e non id a sé.
 * Ogni altro id di INSTRUCTIONS deve essere eseguito da almeno un programma della batteria.
 */
export const DEFERRED_2B: readonly string[] = ['CU', 'CD', 'CALL'];

describe('copertura delle istruzioni da parte della batteria', () => {
  const executedByBattery = async (): Promise<Set<string>> => {
    const all = new Set<string>();
    for (const f of batteryFiles())
      for (const id of (await runBatteryFile(f)).executed) all.add(id);
    return all;
  };

  it('ogni id di INSTRUCTIONS è eseguito dalla batteria o è in DEFERRED_2B', async () => {
    const executed = await executedByBattery();
    const missing = INSTRUCTIONS.map((i) => i.id).filter(
      (id) => !executed.has(id) && !DEFERRED_2B.includes(id),
    );
    expect([...new Set(missing)]).toEqual([]);
  });

  it('DEFERRED_2B contiene solo id esistenti, tutti i contatori, e nient’altro', () => {
    const ids = new Set(INSTRUCTIONS.map((i) => i.id));
    for (const id of DEFERRED_2B) expect(ids.has(id), id).toBe(true);
    const later = INSTRUCTIONS.filter((i) => i.category === 'counter');
    for (const i of later) expect(DEFERRED_2B, i.id).toContain(i.id);
    // Fuori dai contatori resta solo CALL.
    const extra = DEFERRED_2B.filter((id) => !later.some((i) => i.id === id));
    expect(extra).toEqual(['CALL']);
  });

  it('gli id rimandati danno NON_SIMULATA_2B; CALL non ha gestore perché non esiste in MC7', () => {
    // Quando il piano 2B aggiunge un gestore, l'id va tolto da DEFERRED_2B e coperto dalla batteria.
    expect(OPS['CALL']).toBeUndefined();
    for (const id of DEFERRED_2B.filter((x) => x !== 'CALL'))
      expect(() => OPS[id]!({} as never, { text: id } as never), id).toThrowError(
        expect.objectContaining({ code: 'NON_SIMULATA_2B' }) as never,
      );
  });
});
