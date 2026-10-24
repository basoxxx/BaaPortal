import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBlockFile, jsonlToFrames, readKitZip } from '@baaportal/s7comm';
import { COMMANDS, COMMAND_NAMES } from '../src/commands';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const SNAP7 = resolve(here, '../../../packages/s7comm/test/captures/cisagov/snap7.pcap');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Avvia la riga di comando come processo figlio (tsx), come la userebbe uno sviluppatore. */
function spawnCli(args: string[]): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const p = spawnCli(args);
    let stdout = '';
    let stderr = '';
    p.stdout!.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    p.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    p.once('error', fail);
    p.once('close', (code) => done({ code, stdout, stderr }));
  });
}

/** Su Windows uccide l'intero albero; altrove basta il segnale. */
function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (process.platform === 'win32' && p.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F']);
  } else {
    p.kill('SIGKILL');
  }
}

const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };
const MC7 = Uint8Array.from({ length: 40 }, (_, i) => (i * 7 + 3) & 0xff);
const DB5 = buildBlockFile(
  {
    type: 'DB',
    number: 5,
    language: 1,
    flags: 0x01,
    security: 0,
    codeTime: T0,
    interfaceTime: T0,
    ssbLength: 0,
    addLength: 0,
    localDataLength: 0,
    mc7Length: MC7.length,
  },
  MC7,
  { author: 'BAA', family: 'TEST', name: 'DB5', version: '1.1', checksum: 0x1234 },
);

let tmp: string;
let finto: ChildProcess;
let port: number;

const net = (cmd: string, ...rest: string[]): Promise<Run> =>
  run([cmd, '--host', '127.0.0.1', '--port', String(port), ...rest]);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 's7bench-'));
  const blocks = join(tmp, 'blocchi');
  mkdirSync(blocks);
  writeFileSync(join(blocks, 'DB5.blk'), DB5);
  finto = spawnCli(['finto', '--blocchi', blocks]);
  port = await new Promise<number>((ok, ko) => {
    let buf = '';
    const timer = setTimeout(() => ko(new Error(`finto non ha stampato la porta: ${buf}`)), 20_000);
    finto.stdout!.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      const m = /^porta (\d+)\r?\n/.exec(buf);
      if (m) {
        clearTimeout(timer);
        ok(Number(m[1]));
      }
    });
    finto.once('exit', () => ko(new Error(`finto uscito: ${buf}`)));
  });
});

afterAll(() => {
  if (finto) killTree(finto);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('s7bench', () => {
  it('la tabella dei comandi contiene esattamente quelli del banco di prova', () => {
    expect([...COMMAND_NAMES].sort()).toEqual(
      [
        'info',
        'szl',
        'leggi',
        'blocchi',
        'infoblocco',
        'carica',
        'ora',
        'raccogli',
        'finto',
        'decodifica',
        'scrivi',
        'carica-nel-dispositivo',
        'stop',
        'avvia',
      ].sort(),
    );
  });

  it('info contro il finto PLC stampa ordine, modo RUN e PDU 240', async () => {
    const r = await net('info');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('6ES7 315-2EH14-0AB0');
    expect(r.stdout).toMatch(/RUN/);
    expect(r.stdout).toMatch(/PDU\D+240/);
  });

  it('leggi M 0 0 32 dà un dump esadecimale di due righe', async () => {
    const r = await net('leggi', 'M', '0', '0', '32');
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(2);
  });

  it('szl 0x0011 elenca i record in esadecimale', async () => {
    const r = await net('szl', '0x0011');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/0x0011/);
  });

  it("blocchi dà i conteggi e blocchi DB l'elenco", async () => {
    const counts = await net('blocchi');
    expect(counts.code).toBe(0);
    expect(counts.stdout).toMatch(/DB\D+1\b/);
    const list = await net('blocchi', 'DB');
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/\b5\b/);
  });

  it('infoblocco DB 5 stampa le informazioni con le date ISO', async () => {
    const r = await net('infoblocco', 'DB', '5');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2020-05-17T10:20:30');
  });

  it("ora stampa l'orologio della CPU", async () => {
    const r = await net('ora');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('carica di un DB dà byte identici al file caricato nel finto PLC', async () => {
    const out = join(tmp, 'DB5.out');
    const r = await net('carica', 'DB', '5', '-o', out);
    expect(r.code).toBe(0);
    expect(Buffer.compare(readFileSync(out), Buffer.from(DB5))).toBe(0);
  });

  it('carica su un file esistente senza --sovrascrivi esce con 3, con --sovrascrivi riesce', async () => {
    const out = join(tmp, 'esiste.out');
    writeFileSync(out, 'x');
    const r = await net('carica', 'DB', '5', '-o', out);
    expect(r.code).toBe(3);
    expect(readFileSync(out, 'utf8')).toBe('x');
    const ok = await net('carica', 'DB', '5', '-o', out, '--sovrascrivi');
    expect(ok.code).toBe(0);
    expect(Buffer.compare(readFileSync(out), Buffer.from(DB5))).toBe(0);
  });

  it('raccogli su un file esistente senza --sovrascrivi esce con 3 senza toccarlo, con --sovrascrivi riesce', async () => {
    const zip = join(tmp, 'esiste.zip');
    writeFileSync(zip, 'x');
    const r = await net('raccogli', '-o', zip);
    expect(r.code).toBe(3);
    expect(readFileSync(zip, 'utf8')).toBe('x');
    const ok = await net('raccogli', '-o', zip, '--sovrascrivi');
    expect(ok.code).toBe(0);
    expect(readKitZip(new Uint8Array(readFileSync(zip))).summary.refusedCount).toBe(0);
  });

  it('--log scrive la cattura della connessione', async () => {
    const log = join(tmp, 'cattura.jsonl');
    const r = await net('ora', '--log', log);
    expect(r.code).toBe(0);
    expect(jsonlToFrames(readFileSync(log, 'utf8')).length).toBeGreaterThan(4);
  });

  it('raccogli produce uno zip leggibile con readKitZip, e decodifica lo elenca', async () => {
    const zip = join(tmp, 'kit.zip');
    const r = await net('raccogli', '-o', zip);
    expect(r.code).toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    const kit = readKitZip(new Uint8Array(readFileSync(zip)));
    expect(kit.summary.refusedCount).toBe(0);
    expect(Object.keys(kit.blocks)).toContain('DB5');
    const d = await run(['decodifica', zip]);
    expect(d.code).toBe(0);
    expect(d.stdout).toMatch(/setup/);
    expect(d.stdout).toMatch(/szl 0x0011\/0x0000/);
  });

  it('decodifica sulla cattura snap7.pcap elenca setup, SZL e caricamento', async () => {
    const d = await run(['decodifica', SNAP7]);
    expect(d.code).toBe(0);
    expect(d.stdout).toMatch(/\bsetup\b/);
    expect(d.stdout).toMatch(/\bszl\b/);
    expect(d.stdout).toMatch(/\bupload\b/);
    const hex = await run(['decodifica', SNAP7, '--hex']);
    expect(hex.stdout.length).toBeGreaterThan(d.stdout.length);
  });

  it('decodifica riconosce un .jsonl anche con altra estensione', async () => {
    const log = join(tmp, 'cattura.dat');
    expect((await net('ora', '--log', log)).code).toBe(0);
    const d = await run(['decodifica', log]);
    expect(d.code).toBe(0);
    expect(d.stdout).toMatch(/clock/);
  });

  it('porta chiusa → codice 1 e CONNECT_REFUSED; argomenti mancanti → 2', async () => {
    const refused = await run(['info', '--host', '127.0.0.1', '--port', '1']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('errore CONNECT_REFUSED');

    expect((await run(['info'])).code).toBe(2);
    expect((await run(['leggi', 'M', '0'])).code).toBe(2);
    expect((await run(['info', '--host', 'x', '--port', '70000'])).code).toBe(2);
    expect((await run(['info', '--host', 'x', '--slot', '32'])).code).toBe(2);
    expect((await run(['scrivi', '--host', 'x'])).code).toBe(2);
    expect((await run(['stop', '--host', 'x', 'extra'])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  it("--aiuto stampa l'uso e non crea file", async () => {
    const r = await run(['--aiuto']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('raccogli');
    expect(r.stdout).not.toMatch(/sola lettura, nessun comando di scrittura/);
    expect(r.stdout).toContain('--conferma');
    expect(r.stdout).toContain('--non-in-produzione');
    expect(existsSync(join(tmp, 'nulla'))).toBe(false);
  });

  it('finto termina in modo pulito con SIGTERM', async () => {
    const p = spawnCli(['finto', '--protezione', '3', '--modo', 'STOP']);
    const first = await new Promise<string>((ok) => {
      p.stdout!.once('data', (b: Buffer) => ok(b.toString('utf8')));
    });
    expect(first).toMatch(/^porta \d+\n/);
    const p2 = Number(/porta (\d+)/.exec(first)![1]);
    const info = await run(['info', '--host', '127.0.0.1', '--port', String(p2)]);
    expect(info.stdout).toMatch(/STOP/);
    const closed = new Promise<number | null>((ok) => p.once('close', (c) => ok(c)));
    if (process.platform === 'win32') killTree(p);
    else p.kill('SIGTERM');
    const code = await closed;
    if (process.platform !== 'win32') expect(code).toBe(0);
  });
});

const FC7 = buildBlockFile(
  {
    type: 'FC',
    number: 7,
    language: 1,
    flags: 0x01,
    security: 0,
    codeTime: T0,
    interfaceTime: T0,
    ssbLength: 0,
    addLength: 0,
    localDataLength: 0,
    mc7Length: MC7.length,
  },
  MC7,
  { author: 'BAA', family: 'TEST', name: 'FC7', version: '1.1', checksum: 0x1234 },
);

describe('s7bench: comandi di scrittura', () => {
  let wf: ChildProcess;
  let wport: number;
  const wnet = (cmd: string, ...rest: string[]): Promise<Run> =>
    run([cmd, '--host', '127.0.0.1', '--port', String(wport), ...rest]);
  const OK = ['--conferma', '--non-in-produzione'];

  beforeAll(async () => {
    wf = spawnCli(['finto']);
    wport = await new Promise<number>((ok, ko) => {
      let buf = '';
      const timer = setTimeout(() => ko(new Error(`finto: ${buf}`)), 20_000);
      wf.stdout!.on('data', (b: Buffer) => {
        buf += b.toString('utf8');
        const m = /^porta (\d+)\r?\n/.exec(buf);
        if (m) {
          clearTimeout(timer);
          ok(Number(m[1]));
        }
      });
      wf.once('exit', () => ko(new Error(`finto uscito: ${buf}`)));
    });
  });

  afterAll(() => {
    if (wf) killTree(wf);
  });

  it('scrivi senza --conferma → codice 2 e stampa il riepilogo (IP, ordine, modo), nessuna scrittura', async () => {
    const before = await wnet('leggi', 'M', '0', '10', '2');
    const r = await wnet('scrivi', 'M', '0', '10', 'abcd');
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('127.0.0.1');
    expect(r.stdout).toContain('6ES7 315-2EH14-0AB0');
    expect(r.stdout).toContain('RUN');
    expect(r.stdout).toMatch(/ab ?cd/i);
    expect((await wnet('leggi', 'M', '0', '10', '2')).stdout).toBe(before.stdout);
    // una sola delle due conferme non basta
    for (const flag of ['--conferma', '--non-in-produzione']) {
      const one = await wnet('scrivi', 'M', '0', '10', 'abcd', flag);
      expect(one.code).toBe(2);
    }
    expect((await wnet('leggi', 'M', '0', '10', '2')).stdout).toBe(before.stdout);
    // vale anche per stop, avvia e carica-nel-dispositivo
    expect((await wnet('stop')).code).toBe(2);
    expect((await wnet('stop', '--conferma')).code).toBe(2);
    expect((await wnet('avvia')).code).toBe(2);
    expect((await wnet('info')).stdout).toMatch(/RUN/);
  });

  it('scrivi con --conferma --non-in-produzione cambia MW10; una successiva leggi lo conferma', async () => {
    const r = await wnet('scrivi', 'M', '0', '10', 'abcd', ...OK);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('127.0.0.1');
    const back = await wnet('leggi', 'M', '0', '10', '2');
    expect(back.code).toBe(0);
    expect(back.stdout).toMatch(/ab cd/i);
  });

  it('scrivi con esadecimale o area non validi → codice 2', async () => {
    expect((await wnet('scrivi', 'M', '0', '10', 'abc', ...OK)).code).toBe(2);
    expect((await wnet('scrivi', 'X', '0', '10', 'ab', ...OK)).code).toBe(2);
  });

  it('stop con conferma porta il finto PLC in STOP (info lo mostra), avvia lo riporta in RUN', async () => {
    const s = await wnet('stop', ...OK);
    expect(s.code).toBe(0);
    expect((await wnet('info')).stdout).toMatch(/Modo\s+: STOP/);
    const a = await wnet('avvia', ...OK);
    expect(a.code).toBe(0);
    expect((await wnet('info')).stdout).toMatch(/Modo\s+: RUN/);
  });

  it('carica-nel-dispositivo di un .blk compilato → il blocco compare in blocchi', async () => {
    const file = join(tmp, 'FC7.blk');
    writeFileSync(file, FC7);
    const noConfirm = await wnet('carica-nel-dispositivo', file);
    expect(noConfirm.code).toBe(2);
    expect((await wnet('blocchi', 'FC')).stdout).not.toMatch(/\b7\b/);
    const r = await wnet('carica-nel-dispositivo', file, ...OK);
    expect(r.code).toBe(0);
    expect((await wnet('blocchi', 'FC')).stdout).toMatch(/\b7\b/);
    const bad = join(tmp, 'cattivo.blk');
    writeFileSync(bad, 'non un blocco');
    expect((await wnet('carica-nel-dispositivo', bad, ...OK)).code).toBe(3);
  });

  it('OGNI comando con writes:true esce con 2 senza --conferma/--non-in-produzione e non scrive', async () => {
    const blk = join(tmp, 'gate-FC7.blk');
    writeFileSync(blk, FC7);
    // argomenti validi per ciascun comando; un comando writes nuovo senza voce qui fa fallire il test
    const validArgs: Record<string, string[]> = {
      scrivi: ['M', '0', '20', 'abcd'],
      'carica-nel-dispositivo': [blk],
      stop: [],
      avvia: [],
    };
    const writers = COMMANDS.filter((c) => c.writes);
    expect(writers.length).toBeGreaterThan(0);
    for (const c of writers) {
      expect(validArgs[c.name], `argomenti di prova mancanti per ${c.name}`).toBeDefined();
    }
    const before = await wnet('leggi', 'M', '0', '20', '2');
    const blocksBefore = await wnet('blocchi', 'FC');
    for (const c of writers) {
      const args = validArgs[c.name]!;
      expect((await wnet(c.name, ...args)).code, c.name).toBe(2);
      for (const flag of ['--conferma', '--non-in-produzione']) {
        expect((await wnet(c.name, ...args, flag)).code, `${c.name} ${flag}`).toBe(2);
      }
    }
    expect((await wnet('leggi', 'M', '0', '20', '2')).stdout).toBe(before.stdout);
    expect((await wnet('blocchi', 'FC')).stdout).toBe(blocksBefore.stdout);
    expect((await wnet('info')).stdout).toMatch(/RUN/);
  });

  it('host irraggiungibile → codice 1 CONNECT_REFUSED', async () => {
    const r = await run([
      'scrivi',
      'M',
      '0',
      '0',
      '01',
      '--host',
      '127.0.0.1',
      '--port',
      '1',
      ...OK,
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('errore CONNECT_REFUSED');
  });
});
