import { describe, expect, it } from 'vitest';
import { isTrustedFrame, isTrustedUrl } from '../src/main/trust';

const opts = { indexFileUrl: 'file:///app/out/renderer/index.html' };
const dev = { ...opts, devUrl: 'http://localhost:5173/' };

describe('isTrustedUrl', () => {
  it("accetta la pagina dell'app in produzione, anche con hash o query", () => {
    expect(isTrustedUrl('file:///app/out/renderer/index.html', opts)).toBe(true);
    expect(isTrustedUrl('file:///app/out/renderer/index.html#x?y=1', opts)).toBe(true);
  });
  it('rifiuta altri file, altri siti e URL non validi', () => {
    for (const u of [
      'file:///etc/hosts',
      'file:///tmp/evil.html',
      'https://example.com/',
      'about:blank',
      'boh',
    ])
      expect(isTrustedUrl(u, opts)).toBe(false);
  });
  it('in sviluppo accetta solo la stessa origine del dev server', () => {
    expect(isTrustedUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isTrustedUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isTrustedUrl('http://localhost:9999/', dev)).toBe(false);
    expect(isTrustedUrl('file:///etc/hosts', dev)).toBe(false);
  });
});

describe('isTrustedFrame', () => {
  const top = { url: 'file:///app/out/renderer/index.html', parent: null };
  it("accetta il frame principale della pagina dell'app", () => {
    expect(isTrustedFrame(top, opts)).toBe(true);
  });
  it('rifiuta frame nulli, annidati o con URL estraneo', () => {
    expect(isTrustedFrame(null, opts)).toBe(false);
    expect(isTrustedFrame({ url: top.url, parent: top }, opts)).toBe(false);
    expect(isTrustedFrame({ url: 'file:///x.html', parent: null }, opts)).toBe(false);
  });
});
