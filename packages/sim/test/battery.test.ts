import { describe, expect, it } from 'vitest';
import { batteryFiles, runBatteryFile } from './batteryRunner';

describe('batteria di programmi di prova', () => {
  const files = batteryFiles();

  it('ci sono i programmi di tutte le categorie', () => {
    expect(files).toHaveLength(25);
  });

  for (const file of files)
    it(file, async () => {
      const run = await runBatteryFile(file);
      expect(run.failures).toEqual([]);
    });
});
