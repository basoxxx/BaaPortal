import { INSTRUCTIONS } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { OPS } from '../src';
import { batteryFiles, runBatteryFile } from './batteryRunner';

/**
 * Unico id non eseguito dalla batteria: CALL, che nell'MC7 non è un'istruzione (la chiamata compilata
 * è UC o CC, con la lista dei puntatori che segue). Le chiamate di SFC e SFB sono UC/CC con operando.
 * Ogni altro id di INSTRUCTIONS deve essere eseguito da almeno un programma della batteria.
 */
export const NOT_IN_MC7: readonly string[] = ['CALL'];

describe('copertura delle istruzioni da parte della batteria', () => {
  const executedByBattery = async (): Promise<Set<string>> => {
    const all = new Set<string>();
    for (const f of batteryFiles())
      for (const id of (await runBatteryFile(f)).executed) all.add(id);
    return all;
  };

  it('ogni id di INSTRUCTIONS, tranne CALL, è eseguito dalla batteria', async () => {
    const executed = await executedByBattery();
    const missing = INSTRUCTIONS.map((i) => i.id).filter(
      (id) => !executed.has(id) && !NOT_IN_MC7.includes(id),
    );
    expect([...new Set(missing)]).toEqual([]);
  });

  it('l’elenco delle esclusioni è esistente e contiene solo CALL, che non ha gestore', () => {
    const ids = new Set(INSTRUCTIONS.map((i) => i.id));
    for (const id of NOT_IN_MC7) expect(ids.has(id), id).toBe(true);
    expect(NOT_IN_MC7).toEqual(['CALL']);
    expect(OPS['CALL']).toBeUndefined();
  });
});
