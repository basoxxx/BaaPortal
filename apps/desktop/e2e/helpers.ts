import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

export async function launchApp(opts: { args?: string[] } = {}): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'baa-userdata-'));
  const app = await _electron.launch({
    args: ['out/main/index.js', ...(opts.args ?? [])],
    env: { ...process.env, BAA_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  return { app, page, userData };
}
