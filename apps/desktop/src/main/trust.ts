/** Verifica che pagine e frame siano quelli dell'app: l'unico contenuto autorizzato a usare i canali IPC. */
export interface TrustOptions {
  /** URL file:// della pagina del renderer in produzione. */
  indexFileUrl: string;
  /** URL del dev server (solo in sviluppo). */
  devUrl?: string | undefined;
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
  const index = new URL(opts.indexFileUrl);
  return parsed.protocol === 'file:' && parsed.pathname === index.pathname;
}

export interface FrameLike {
  url: string;
  parent: FrameLike | null;
}

export function isTrustedFrame(frame: FrameLike | null | undefined, opts: TrustOptions): boolean {
  return !!frame && frame.parent === null && isTrustedUrl(frame.url, opts);
}
