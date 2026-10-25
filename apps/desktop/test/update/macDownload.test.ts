import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DownloadCancelled,
  downloadDmg,
  macArch,
  nodeMacFs,
  pickMacFile,
  sha512OfFile,
  type MacDownloadDeps,
} from '../../src/main/update/macDownload';

const sha = (b: Uint8Array) => createHash('sha512').update(b).digest('base64');
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);
const FILE = { url: 'BaaPortal-0.12.1-arm64.dmg', sha512: sha(BYTES), size: BYTES.length };

describe('macArch', () => {
  it("sceglie l'architettura", () => {
    expect(macArch('arm64', false)).toBe('arm64');
    expect(macArch('x64', false)).toBe('x64');
    expect(macArch('x64', true)).toBe('arm64');
    expect(macArch('ia32', false)).toBeNull();
  });
});

describe('pickMacFile', () => {
  const files = [
    { url: 'BaaPortal-0.12.1-arm64.dmg', sha512: 'a', size: 1 },
    { url: 'BaaPortal-0.12.1-x64.dmg', sha512: 'b', size: 2 },
  ];
  it('il file giusto per ciascuna', () => {
    expect(pickMacFile(files, '0.12.1', 'arm64')).toMatchObject({ sha512: 'a' });
    expect(pickMacFile(files, '0.12.1', 'x64')).toMatchObject({ sha512: 'b' });
  });
  it('errori', () => {
    expect(pickMacFile([files[0]!], '0.12.1', 'x64')).toBe(
      'Nessun installatore per questo Mac (x64) nella versione 0.12.1',
    );
    expect(
      pickMacFile([files[1]!, { ...files[1]!, url: 'altro-x64.dmg' }], '0.12.1', 'x64'),
    ).toMatch(/Nessun installatore/);
    expect(typeof pickMacFile([{ url: '../x-x64.dmg', sha512: 'c' }], '0.12.1', 'x64')).toBe(
      'string',
    );
  });
});

function respond(body: Uint8Array[], opts: { status?: number; fail?: boolean } = {}): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < body.length) c.enqueue(body[i++]!);
      else if (opts.fail) c.error(new Error('rete interrotta'));
      else c.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200 });
}

describe('downloadDmg', () => {
  let dir: string;
  let fetched: string[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'macdl-'));
    fetched = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const deps = (res: () => Response): MacDownloadDeps => ({
    fetch: async (url) => {
      fetched.push(url);
      return res();
    },
    downloadsDir: dir,
    fs: nodeMacFs,
    sha512Of: sha512OfFile,
  });
  const run = (d: MacDownloadDeps, f = FILE, signal = new AbortController().signal) => {
    const progress: number[] = [];
    const p = downloadDmg(d, f, '0.12.1', 'arm64', (t) => progress.push(t), signal);
    return { p, progress };
  };
  const chunks = () => [BYTES.slice(0, 400), BYTES.slice(400, 700), BYTES.slice(700)];

  it('byte giusti: .dmg, progresso crescente fino al totale, URL costruito dal main', async () => {
    const { p, progress } = run(deps(() => respond(chunks())));
    const r = await p;
    expect(r).toEqual({ path: join(dir, 'BaaPortal-0.12.1-arm64.dmg'), reused: false });
    expect(progress).toEqual([400, 700, 1000]);
    expect(fetched).toEqual([
      'https://github.com/basoxxx/BaaPortal/releases/download/v0.12.1/BaaPortal-0.12.1-arm64.dmg',
    ]);
    expect(await readdir(dir)).toEqual(['BaaPortal-0.12.1-arm64.dmg']);
  });

  it('sha512 diverso: nessun file, errore', async () => {
    const bad = BYTES.slice().reverse();
    await expect(run(deps(() => respond([bad]))).p).rejects.toThrow(
      'Il file scaricato non corrisponde: non è stato aperto',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('errore alla chiusura del file (disco pieno): errore, niente .dmg né .part', async () => {
    const d = deps(() => respond(chunks()));
    d.fs = {
      ...nodeMacFs,
      createWriter: (p) => {
        const w = nodeMacFs.createWriter(p);
        return {
          write: (c) => w.write(c),
          close: async () => {
            await w.close();
            throw new Error('disco pieno');
          },
        };
      },
    };
    await expect(run(d).p).rejects.toThrow('disco pieno');
    expect(await readdir(dir)).toEqual([]);
  });

  it('il file su disco diverso dai byte arrivati: non viene rinominato', async () => {
    const d = deps(() => respond(chunks()));
    d.sha512Of = async () => 'altro';
    await expect(run(d).p).rejects.toThrow('non corrisponde');
    expect(await readdir(dir)).toEqual([]);
  });

  it('rete interrotta a metà: nessun .part', async () => {
    await expect(run(deps(() => respond([BYTES.slice(0, 300)], { fail: true }))).p).rejects.toThrow(
      'rete interrotta',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('annullato: nessun .part, DownloadCancelled', async () => {
    const ac = new AbortController();
    const d = deps(() => respond(chunks()));
    const orig = d.fetch;
    d.fetch = async (u, i) => {
      const r = await orig(u, i);
      ac.abort();
      return r;
    };
    await expect(run(d, FILE, ac.signal).p).rejects.toBeInstanceOf(DownloadCancelled);
    expect(await readdir(dir)).toEqual([]);
  });

  it('404: errore con il codice, nessun file', async () => {
    await expect(run(deps(() => respond([], { status: 404 }))).p).rejects.toThrow('HTTP 404');
    expect(await readdir(dir)).toEqual([]);
  });

  it('più byte della dimensione dichiarata: fermato, nessun file', async () => {
    const big = new Uint8Array(2000);
    await expect(run(deps(() => respond([big]))).p).rejects.toThrow(/più grande/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('.dmg già presente con sha512 giusto: riusato, nessuna richiesta', async () => {
    await writeFile(join(dir, 'BaaPortal-0.12.1-arm64.dmg'), BYTES);
    const r = await run(deps(() => respond(chunks()))).p;
    expect(r.reused).toBe(true);
    expect(fetched).toEqual([]);
  });

  it(".dmg già presente diverso: scritto « (1).dmg», l'altro intatto", async () => {
    await writeFile(join(dir, 'BaaPortal-0.12.1-arm64.dmg'), 'altro');
    const r = await run(deps(() => respond(chunks()))).p;
    expect(r).toEqual({ path: join(dir, 'BaaPortal-0.12.1-arm64 (1).dmg'), reused: false });
    expect(await readFile(join(dir, 'BaaPortal-0.12.1-arm64.dmg'), 'utf8')).toBe('altro');
  });
});
