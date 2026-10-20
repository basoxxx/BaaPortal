import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { AwlContext } from '@baaportal/awl';
import { compileBlock, type CompileInput } from '@baaportal/mc7';
import { kitZip, readKitZip, type KitResult } from '@baaportal/s7comm';
import { collectTcp } from '@baaportal/s7comm/node';
import { createCodeBlock } from '@baaportal/project';
import {
  addBlock,
  expect,
  firstDeviceId,
  launchAppWithRetry,
  mod,
  removeDir,
  stubFileDialogs,
  stubMessageBox,
  test,
  writeFixtureProject,
} from './helpers';

test.setTimeout(60_000);

const here = dirname(fileURLToPath(import.meta.url));
const s7bench = resolve(here, '../../s7bench');

let tmp = '';
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-mc7-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

/** Su Windows uccide l'intero albero; altrove basta il segnale. */
function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (process.platform === 'win32' && p.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F']);
  } else {
    p.kill('SIGKILL');
  }
}

/** Avvia il finto PLC con i blocchi della cartella; risolve con la porta. */
function startFinto(dir: string): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/main.ts', 'finto', '--porta', '0', '--blocchi', dir],
    { cwd: s7bench, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((ok, ko) => {
    let buf = '';
    const timer = setTimeout(() => ko(new Error(`finto non ha stampato la porta: ${buf}`)), 20_000);
    proc.stdout!.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      const m = /^porta (\d+)\r?\n/.exec(buf);
      if (m) {
        clearTimeout(timer);
        ok({ proc, port: Number(m[1]) });
      }
    });
    proc.stderr!.on('data', (b: Buffer) => (buf += b.toString('utf8')));
    proc.once('exit', () => ko(new Error(`finto uscito: ${buf}`)));
  });
}

const noCtx = (kind: 'OB' | 'FB' | 'FC'): AwlContext => ({
  owner: {
    kind,
    iface: {
      input: [],
      output: [],
      inOut: [],
      static: [],
      temp: [],
      returnType: { kind: 'void' },
    },
  },
  symbol: () => undefined,
  block: () => undefined,
  resolve: () => null,
  allSymbols: () => [],
  allBlocks: () => [],
});

/** Un blocco MC7 costruito qui con il compilatore (nessun blocco reale di terzi nel repository). */
function blk(
  kind: 'OB' | 'FC' | 'DB',
  number: number,
  networks: string[],
  stat: CompileInput['sections']['stat'] = [],
): Uint8Array {
  const r = compileBlock({
    kind,
    number,
    knowHowProtected: false,
    header: { author: 'PROVA', family: 'E2E', name: `${kind}${number}`, version: '1.0' },
    sections: { in: [], out: [], inOut: [], stat, temp: [], ret: [] },
    initials: {},
    networks,
    ctx: noCtx(kind === 'DB' ? 'FC' : kind),
    now: new Date(2024, 0, 15, 10, 30, 0),
  });
  if (!r.file) throw new Error(`blocco di prova non compilato: ${JSON.stringify(r.diagnostics)}`);
  return r.file;
}

const treeNode = (page: Page, text: string) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: text }).first();
const network = (page: Page, n: number) => page.getByRole('region', { name: `Segmento ${n}` });
const cm = (page: Page, n: number) => network(page, n).locator('.cm-content');
const rows = (page: Page) => page.getByTestId('compile-row');

async function openProject(file: string) {
  const l = await launchAppWithRetry({ args: [file] });
  await l.page.getByTestId('link-project-view').click();
  await expect(l.page.getByTestId('menu-bar')).toBeVisible();
  return l;
}

async function setCode(page: Page, n: number, text: string): Promise<void> {
  await cm(page, n).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(text);
  await page.getByRole('heading', { name: 'Segmenti' }).click();
}

async function compileMenu(page: Page, node: string, item: string): Promise<void> {
  await treeNode(page, node).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

const CHANGES = 'Compila → Software (solo modifiche)';
const FULL = 'Compila → Software (compilazione completa)';

test('kit del finto PLC: i blocchi si importano e si esportano identici', async () => {
  const blocks = join(tmp, 'blocchi');
  mkdirSync(blocks);
  const fc1 = blk('FC', 1, ['NOP 0\nBE']);
  const ob1 = blk('OB', 1, ['NOP 0\nBE']);
  const db5 = blk('DB', 5, [], [{ name: 'Valore', type: { kind: 'elementary', name: 'Int' } }]);
  writeFileSync(join(blocks, 'FC1.blk'), fc1);
  writeFileSync(join(blocks, 'OB1.blk'), ob1);
  writeFileSync(join(blocks, 'DB5.blk'), db5);
  const { proc, port } = await startFinto(blocks);
  let zipPath = '';
  try {
    const result: KitResult = await collectTcp(
      { host: '127.0.0.1', port, rack: 0, slot: 2, timeoutMs: 10_000, includeBlocks: true },
      () => undefined,
      new AbortController().signal,
      'e2e',
    );
    zipPath = join(tmp, 'kit.zip');
    writeFileSync(zipPath, kitZip(result));
  } finally {
    killTree(proc);
  }
  const kit = readKitZip(new Uint8Array(readFileSync(zipPath)));
  expect(Object.keys(kit.blocks).sort()).toEqual(['DB5', 'FC1', 'OB1']);
  const original = Buffer.from(kit.blocks['FC1']!);

  const file = join(tmp, 'kit.baap');
  writeFixtureProject(file, (dev) => {
    dev.blocks = [];
  });
  const { app, page } = await openProject(file);
  await stubFileDialogs(app, { open: [zipPath] });
  await stubMessageBox(app, 0);
  await treeNode(page, 'Blocchi di programma').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Importa blocchi (.blk o raccolta del kit)…' }).click();

  await expect(treeNode(page, '[FC1]')).toBeVisible({ timeout: 30_000 });
  await expect(treeNode(page, '[OB1]')).toBeVisible();
  await expect(treeNode(page, '[DB5]')).toBeVisible();

  const out = join(tmp, 'FC1-esportato.blk');
  await stubFileDialogs(app, { save: out });
  await treeNode(page, '[FC1]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Esporta blocco compilato (.blk)…' }).click();
  await expect
    .poll(() => (existsSync(out) ? readFileSync(out).equals(original) : false), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('data-status', 'ok');
});

test('FC scritto nel programma: compila, errore apposta, il clic porta al segmento', async () => {
  const file = join(tmp, 'fc.baap');
  writeFixtureProject(file, (dev) => {
    dev.blocks = [];
  });
  const { page } = await openProject(file);
  const dev = await firstDeviceId(page);
  await addBlock(page, dev, { kind: 'FC', name: 'Prova' });
  await treeNode(page, 'Prova [FC').dblclick();
  await expect(network(page, 1)).toBeVisible();
  await setCode(page, 1, 'NOP 0');

  await compileMenu(page, 'Blocchi di programma', FULL);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('data-block', 'Prova');
  await expect(rows(page).first()).toHaveAttribute('data-status', 'ok');
  await expect(rows(page).first()).toContainText('✓');

  await setCode(page, 1, 'L "Inesistente"');
  await compileMenu(page, 'Blocchi di programma', FULL);
  await expect(rows(page).first()).toHaveAttribute('data-status', 'error');
  await expect(rows(page).first()).toContainText('✗');
  const msg = page.getByTestId('compile-message').first();
  await expect(msg).toBeVisible();
  await expect(msg).toContainText('Inesistente');
  await expect(msg).toContainText('Rete 1');

  // Si sposta il focus altrove, poi il clic sul messaggio riporta all'editor del segmento.
  await page.getByRole('heading', { name: 'Segmenti' }).click();
  await expect(cm(page, 1)).not.toBeFocused();
  await msg.click();
  await expect(cm(page, 1)).toBeFocused();
});

test('compila solo modifiche: un blocco; cambia un tag e li ricompila entrambi', async () => {
  const file = join(tmp, 'solo.baap');
  writeFixtureProject(file, (dev) => {
    dev.blocks = [
      createCodeBlock({ kind: 'FC', number: 1, name: 'Uno', language: 'AWL' }),
      createCodeBlock({ kind: 'FC', number: 2, name: 'Due', language: 'AWL' }),
    ];
    dev.tagTables[0]!.tags.push({
      id: crypto.randomUUID(),
      name: 'Pulsante',
      type: 'Bool',
      address: '%I0.0',
      hmi: true,
      comment: '',
    });
  });
  const { page } = await openProject(file);

  await compileMenu(page, 'Blocchi di programma', FULL);
  await expect(rows(page)).toHaveCount(2);

  // Modifica solo "Due": la compilazione delle sole modifiche la ricompila e basta.
  await treeNode(page, 'Due [FC').dblclick();
  await expect(network(page, 1)).toBeVisible();
  await setCode(page, 1, 'A "Pulsante"\n= %Q0.0');
  await compileMenu(page, 'Blocchi di programma', CHANGES);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('data-block', 'Due');
  await expect(rows(page).first()).toHaveAttribute('data-status', 'ok');

  // Cambia l'indirizzo del tag: cambia il contesto e tutti i blocchi si ricompilano.
  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  const cell = page
    .getByRole('grid')
    .locator('[data-row-key]:not([data-row-key*="add:"])')
    .first()
    .locator('[data-col-id="address"]');
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill('%I0.1');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await compileMenu(page, 'Blocchi di programma', CHANGES);
  await expect(rows(page)).toHaveCount(2);
});
