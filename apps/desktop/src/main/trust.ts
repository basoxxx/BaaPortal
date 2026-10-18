import { fileURLToPath } from 'node:url';
import type { Platform } from './recentProjects';

/** Verifica che pagine e frame siano quelli dell'app: l'unico contenuto autorizzato a usare i canali IPC. */
export interface TrustOptions {
  /** URL file:// della pagina del renderer in produzione. */
  indexFileUrl: string;
  /** URL del dev server (solo in sviluppo). */
  devUrl?: string | undefined;
  platform: Platform;
}

/** Percorso su disco di un URL file://, o null se non è un file valido per la piattaforma. */
function localPath(url: URL, platform: Platform): string | null {
  try {
    return fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return null;
  }
}

export function isTrustedUrl(url: string, opts: TrustOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (opts.devUrl) {
    try {
      return parsed.origin === new URL(opts.devUrl).origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== 'file:') return false;
  // Si confrontano i percorsi decodificati, non le stringhe: Chromium e Node scrivono in modo diverso
  // lettera di unità e caratteri speciali (spazi, accenti, ^ { } [ ]) degli URL file://.
  const page = localPath(parsed, opts.platform);
  const index = localPath(new URL(opts.indexFileUrl), opts.platform);
  if (page === null || index === null) return false;
  return opts.platform === 'win32' ? page.toLowerCase() === index.toLowerCase() : page === index;
}

export interface FrameLike {
  url: string;
  parent: FrameLike | null;
}

export function isTrustedFrame(frame: FrameLike | null | undefined, opts: TrustOptions): boolean {
  return !!frame && frame.parent === null && isTrustedUrl(frame.url, opts);
}
