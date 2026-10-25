import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/settings/settings';

describe('impostazioni online', () => {
  it('experimental assente → false', () => {
    expect(normalizeSettings({}).online.experimental).toBe(false);
    expect(normalizeSettings(null).online).toEqual({ experimental: false });
    expect(DEFAULT_SETTINGS.online.experimental).toBe(false);
  });

  it('valore non booleano → false', () => {
    for (const v of ['true', 1, {}, null, []]) {
      expect(normalizeSettings({ online: { experimental: v } }).online.experimental).toBe(false);
    }
  });

  it('true resta true', () => {
    expect(normalizeSettings({ online: { experimental: true } }).online.experimental).toBe(true);
  });
});
