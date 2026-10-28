import { describe, expect, it } from 'vitest';
import {
  effectivePrerelease,
  errorText,
  isNewer,
  parseUpdatePrefs,
  shouldReport,
} from '../../src/main/update/updatePolicy';

describe('effectivePrerelease', () => {
  it('segue la build quando la casella non è impostata', () => {
    expect(effectivePrerelease(true, null)).toBe(true);
    expect(effectivePrerelease(false, null)).toBe(false);
  });
  it('la casella ha la precedenza', () => {
    expect(effectivePrerelease(false, true)).toBe(true);
    expect(effectivePrerelease(true, false)).toBe(false);
  });
});

describe('isNewer', () => {
  it('confronta le versioni', () => {
    expect(isNewer('0.12.1', '0.12.0')).toBe(true);
    expect(isNewer('0.12.0', '0.12.0')).toBe(false);
    expect(isNewer('0.11.0', '0.12.0')).toBe(false);
    expect(isNewer('v0.13', '0.12.0')).toBe(false);
    expect(isNewer('1.0.0-rc.1', '0.14.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewer('0.14.0', '1.0.0-rc.1')).toBe(false);
  });
});

describe('parseUpdatePrefs', () => {
  it('accetta la forma giusta', () => {
    expect(parseUpdatePrefs({ checkOnStartup: true, prerelease: null })).toEqual({
      checkOnStartup: true,
      prerelease: null,
    });
    expect(parseUpdatePrefs({ checkOnStartup: false, prerelease: true })).toEqual({
      checkOnStartup: false,
      prerelease: true,
    });
  });
  it('rifiuta campi mancanti o di tipo sbagliato', () => {
    for (const bad of [
      null,
      'x',
      {},
      { checkOnStartup: true },
      { prerelease: null },
      { checkOnStartup: 'si', prerelease: null },
      { checkOnStartup: true, prerelease: 1 },
    ]) {
      expect(typeof parseUpdatePrefs(bad)).toBe('string');
    }
  });
});

describe('shouldReport', () => {
  it('none ed error solo a mano', () => {
    expect(shouldReport('none', true)).toBe(true);
    expect(shouldReport('none', false)).toBe(false);
    expect(shouldReport('error', true)).toBe(true);
    expect(shouldReport('error', false)).toBe(false);
  });
});

describe('errorText', () => {
  it('rete assente', () => {
    expect(errorText({ code: 'ENOTFOUND' })).toMatch(/rete|connession/i);
    expect(errorText(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/rete|connession/i);
  });
  it('limiti di GitHub', () => {
    expect(errorText(new Error('HTTP 403 rate limit'))).toBe(
      'GitHub ha limitato le richieste: riprova più tardi',
    );
    expect(errorText({ statusCode: 429 })).toBe(
      'GitHub ha limitato le richieste: riprova più tardi',
    );
  });
  it('file di aggiornamento mancante', () => {
    expect(errorText({ statusCode: 404 })).toBe('La release non ha il file di aggiornamento');
    expect(errorText(new Error('Cannot find latest.yml in the latest release artifacts'))).toBe(
      'La release non ha il file di aggiornamento',
    );
  });
  it('sha512 diverso', () => {
    expect(errorText(new Error('sha512 checksum mismatch, expected a, got b'))).toMatch(
      /verific|integrit|corrott/i,
    );
  });
  it('altro', () => {
    expect(errorText(new Error('boom'))).toContain('boom');
    expect(errorText(undefined)).toMatch(/errore/i);
  });
});
