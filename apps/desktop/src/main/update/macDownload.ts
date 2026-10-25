import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface MacFile {
  url: string;
  sha512: string;
  size?: number;
}

export interface MacWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface MacFs {
  mkdir(dir: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  createWriter(path: string): MacWriter;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface MacDownloadDeps {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  downloadsDir: string;
  fs: MacFs;
  /** sha512 in base64 di un file già presente. */
  sha512Of(path: string): Promise<string>;
}

/** L'annullamento non è un errore: il servizio lo traduce in `cancelled`. */
export class DownloadCancelled extends Error {
  constructor() {
    super('Scaricamento annullato');
  }
}

const RELEASES = 'https://github.com/basoxxx/BaaPortal/releases/download/';
const DEFAULT_MAX = 1024 * 1024 * 1024;
const MAX_COPIES = 20;

/** `arm64` sotto Rosetta (il processo gira come x64 su un Mac Apple), altrimenti l'architettura reale. */
export function macArch(processArch: string, underTranslation: boolean): 'arm64' | 'x64' | null {
  if (underTranslation) return 'arm64';
  return processArch === 'arm64' || processArch === 'x64' ? processArch : null;
}

/** L'unico DMG dell'architettura, con un nome di file semplice. */
export function pickMacFile(
  files: MacFile[],
  version: string,
  arch: string,
): { url: string; sha512: string; size: number | undefined } | string {
  const none = `Nessun installatore per questo Mac (${arch}) nella versione ${version}`;
  const hits = files.filter((f) => f.url.endsWith(`-${arch}.dmg`));
  if (hits.length !== 1) return none;
  const f = hits[0]!;
  if (/[/\\]/.test(f.url) || f.url.includes('..'))
    return 'Nome del file di aggiornamento non valido';
  return { url: f.url, sha512: f.sha512, size: f.size };
}

/** Scarica il DMG in `Download`, verifica lo sha512 e restituisce il percorso (o quello già presente). */
export async function downloadDmg(
  d: MacDownloadDeps,
  file: { url: string; sha512: string; size?: number | undefined },
  version: string,
  arch: string,
  onProgress: (transferred: number, total: number) => void,
  signal: AbortSignal,
): Promise<{ path: string; reused: boolean }> {
  await d.fs.mkdir(d.downloadsDir);
  const base = `BaaPortal-${version}-${arch}`;
  let target = '';
  for (let i = 0; i <= MAX_COPIES; i++) {
    const candidate = join(d.downloadsDir, i === 0 ? `${base}.dmg` : `${base} (${i}).dmg`);
    if (!(await d.fs.exists(candidate))) {
      target = candidate;
      break;
    }
    // Un file con lo sha512 giusto si riusa; uno diverso non si tocca.
    if ((await d.sha512Of(candidate)) === file.sha512) return { path: candidate, reused: true };
  }
  if (!target) throw new Error('Troppe copie dello stesso file in Download');

  const part = `${target}.part`;
  const total = file.size ?? DEFAULT_MAX;
  const writer = d.fs.createWriter(part);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await writer.close().catch(() => undefined);
    }
  };
  try {
    if (signal.aborted) throw new DownloadCancelled();
    let res: Response;
    try {
      res = await d.fetch(`${RELEASES}v${version}/${file.url}`, { signal });
    } catch (e) {
      if (signal.aborted) throw new DownloadCancelled();
      throw e;
    }
    if (res.status !== 200 || !res.body) {
      throw new Error(`Scaricamento non riuscito (HTTP ${res.status})`);
    }
    const hash = createHash('sha512');
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadCancelled();
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal.aborted) throw new DownloadCancelled();
        throw e;
      }
      if (chunk.done) break;
      got += chunk.value.length;
      if (got > total) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Il file scaricato è più grande del previsto');
      }
      hash.update(chunk.value);
      await writer.write(chunk.value);
      onProgress(got, total);
    }
    await close();
    if (hash.digest('base64') !== file.sha512) {
      throw new Error('Il file scaricato non corrisponde: non è stato aperto');
    }
    await d.fs.rename(part, target);
    return { path: target, reused: false };
  } catch (e) {
    await close();
    await d.fs.remove(part).catch(() => undefined);
    throw e;
  }
}

/** Implementazione vera su disco. */
export const nodeMacFs: MacFs = {
  mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  exists: (p) =>
    access(p).then(
      () => true,
      () => false,
    ),
  createWriter: (p) => {
    const s = createWriteStream(p);
    const failed = new Promise<never>((_, rej) => s.once('error', rej));
    failed.catch(() => undefined);
    return {
      write: (c) =>
        Promise.race([
          new Promise<void>((res) => {
            if (s.write(c)) res();
            else s.once('drain', res);
          }),
          failed,
        ]),
      close: () => new Promise<void>((res) => s.end(() => res())),
    };
  },
  rename,
  remove: (p) => rm(p, { force: true }),
};

export function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha512');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('base64')));
  });
}
