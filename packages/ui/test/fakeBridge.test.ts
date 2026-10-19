import { describe, expect, it } from 'vitest';
import { FakeBridge } from './fakeBridge';

describe('FakeBridge: dialoghi di file generici', () => {
  const filters = [{ name: 'Sorgenti AWL', extensions: ['awl'] }];

  it('consuma una risposta per chiamata e registra le opzioni', async () => {
    const b = new FakeBridge();
    b.openFileResults.push(['/a.awl', '/b.awl']);
    b.saveFileResults.push('/c.awl');
    expect(await b.showOpenFileDialog({ filters, multi: true })).toEqual(['/a.awl', '/b.awl']);
    expect(await b.showSaveFileDialog({ defaultName: 'c.awl', filters })).toBe('/c.awl');
    expect(b.openFileCalls).toEqual([{ filters, multi: true }]);
    expect(b.saveFileCalls).toEqual([{ defaultName: 'c.awl', filters }]);
  });

  it('a coda vuota restituisce [] e null', async () => {
    const b = new FakeBridge();
    expect(await b.showOpenFileDialog({ filters })).toEqual([]);
    expect(await b.showSaveFileDialog({ defaultName: 'x.awl', filters })).toBeNull();
    expect(b.openFileCalls).toHaveLength(1);
  });
});
