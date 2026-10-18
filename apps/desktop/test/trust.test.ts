import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTrustedFrame, isTrustedUrl } from '../src/main/trust';

const opts = { indexFileUrl: 'file:///app/out/renderer/index.html', platform: 'darwin' as const };
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
      'file://host/app/out/renderer/index.html',
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

describe('isTrustedUrl su Windows', () => {
  // Installazione per utente in una cartella con spazi, accenti e caratteri che Chromium e Node
  // codificano in modo diverso; l'URL della pagina lo calcola il processo principale con pathToFileURL.
  const index =
    "C:\\Users\\Niccolò D'Amico\\Programmi {ditta}^[1]\\BaaPortal\\resources\\app.asar\\out\\renderer\\index.html";
  const win = {
    indexFileUrl: pathToFileURL(index, { windows: true }).href,
    platform: 'win32' as const,
  };
  const rest =
    "/Users/Niccol%C3%B2%20D'Amico/Programmi%20%7Bditta%7D%5E%5B1%5D/BaaPortal/resources/app.asar/out/renderer/index.html";

  it("accetta la pagina dell'app con lettera di unità e codifica diverse", () => {
    for (const u of [
      win.indexFileUrl,
      `file:///C:${rest}`,
      `file:///c:${rest}`,
      `file:///C:${rest.replace('%C3%B2', '%c3%b2').replace('BaaPortal', 'BAAPORTAL')}#/x`,
      "file:///C:/Users/Niccolò D'Amico/Programmi {ditta}^[1]/BaaPortal/resources/app.asar/out/renderer/index.html",
    ])
      expect(isTrustedUrl(u, win), u).toBe(true);
  });
  it('rifiuta altri file, altre unità e separatori codificati', () => {
    for (const u of [
      'file:///C:/Windows/evil.html',
      `file:///D:${rest}`,
      `file:///C:${rest.replace('index.html', 'altro.html')}`,
      'file:///C:/Users/x/..%5C..%5Cevil.html',
      'file:///etc/hosts',
    ])
      expect(isTrustedUrl(u, win), u).toBe(false);
  });
  it('installazione su cartella di rete (UNC)', () => {
    const unc = {
      indexFileUrl: pathToFileURL('\\\\server\\share\\BaaPortal\\out\\renderer\\index.html', {
        windows: true,
      }).href,
      platform: 'win32' as const,
    };
    expect(isTrustedUrl('file://server/share/BaaPortal/out/renderer/index.html', unc)).toBe(true);
    expect(isTrustedUrl('file://SERVER/share/BaaPortal/out/renderer/index.html', unc)).toBe(true);
    expect(isTrustedUrl('file://altro/share/BaaPortal/out/renderer/index.html', unc)).toBe(false);
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
