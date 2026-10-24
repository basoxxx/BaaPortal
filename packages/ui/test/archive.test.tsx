import { act } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readBaap, readBaapz, writeBaapz } from '@baaportal/project';
import { PROJECT_PATH, renderApp } from './renderApp';

const T = 30_000;
const ARCH = '/arch/linea.baapz';
const DEST = '/dest';
const stamp = /^Linea 3_\d{8}_\d{4}\.baapz$/;

async function archiveBytes(app: Awaited<ReturnType<typeof renderApp>>) {
  return writeBaapz(app.store.getState().doc!.project, {
    appVersion: '0.1.0',
    projectFileName: 'Linea 3.baap',
  });
}

describe('Archivia', () => {
  it(
    'Archivia scrive un .baapz col nome proposto <nome>_<data>.baapz',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      app.bridge.saveFileResults.push('/out/x.baapz');
      await act(async () => void (await app.service.archive()));
      const call = app.bridge.saveFileCalls.at(-1)!;
      expect(call.defaultName).toMatch(stamp);
      const written = app.bridge.files.get('/out/x.baapz')!;
      expect(readBaapz(written).manifest.projectFileName).toBe('Linea 3.baap');
      expect(app.bridge.errors).toEqual([]);
    },
    T,
  );

  it(
    'Archivia annullato dal dialogo: nessuna scrittura',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      const before = app.bridge.files.size;
      await act(async () => void (await app.service.archive()));
      expect(app.bridge.files.size).toBe(before);
    },
    T,
  );
});

describe('Ritira archivio', () => {
  it(
    'Ritira su file esistente: annulla la conferma → nessuna scrittura',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      const bytes = await archiveBytes(app);
      app.bridge.files.set(ARCH, bytes);
      const existing = strToU8('vecchio');
      app.bridge.files.set(`${DEST}/Linea 3.baap`, existing);
      app.bridge.openFileResults.push([ARCH]);
      app.bridge.folderResults.push(DEST);
      app.bridge.questionAnswers.push(false);
      await act(async () => void (await app.service.retrieve()));
      expect(app.bridge.questions).toHaveLength(1);
      expect(app.bridge.files.get(`${DEST}/Linea 3.baap`)).toBe(existing);
    },
    T,
  );

  it(
    'Ritira apre il progetto e lo aggiunge ai recenti',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      app.bridge.files.set(ARCH, await archiveBytes(app));
      app.bridge.openFileResults.push([ARCH]);
      app.bridge.folderResults.push(DEST);
      await act(async () => void (await app.service.retrieve()));
      const path = `${DEST}/Linea 3.baap`;
      expect(readBaap(app.bridge.files.get(path)!).meta.name).toBe('Linea 3');
      expect(app.store.getState().doc!.filePath).toBe(path);
      expect(app.bridge.recent[0]!.path).toBe(path);
      expect(app.bridge.questions).toHaveLength(0);
    },
    T,
  );

  it(
    'archivio rotto → messaggio con codice, nessun file scritto',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      app.bridge.files.set(ARCH, zipSync({ 'a.txt': strToU8('x') }));
      app.bridge.openFileResults.push([ARCH]);
      app.bridge.folderResults.push(DEST);
      const before = [...app.bridge.files.keys()].sort();
      await act(async () => void (await app.service.retrieve()));
      expect(app.bridge.errors.at(-1)!.message).toContain('MANIFESTO_MANCANTE');
      expect([...app.bridge.files.keys()].sort()).toEqual(before);
      expect(app.store.getState().doc!.filePath).toBe(PROJECT_PATH);
    },
    T,
  );
});
