import { act } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readBaap, readBaapz, writeBaapz } from '@baaportal/project';
import { joinPath } from '../src/services/projectService';
import { PROJECT_PATH, renderApp, type RenderedApp } from './renderApp';

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

const dirty = (app: RenderedApp) =>
  act(() => {
    app.store.getState().edit('history.addRow', (p) => {
      p.meta.comment = 'modificato';
    });
  });
const commentOf = (b: Uint8Array) => readBaap(b).meta.comment;

describe('Archivia: modifiche non salvate', () => {
  it(
    'annulla → nessun dialogo, nessuna scrittura',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      dirty(app);
      app.bridge.confirmAnswers.push('cancel');
      await act(async () => void (await app.service.archive()));
      expect(app.bridge.saveFileCalls).toHaveLength(0);
    },
    T,
  );

  it(
    'non salvare → archivia la versione su disco',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      dirty(app);
      app.bridge.confirmAnswers.push('discard');
      app.bridge.saveFileResults.push('/out/x.baapz');
      await act(async () => void (await app.service.archive()));
      const { baap } = readBaapz(app.bridge.files.get('/out/x.baapz')!);
      expect(commentOf(baap)).toBe('');
      expect(baap).toEqual(app.bridge.files.get(PROJECT_PATH));
    },
    T,
  );

  it(
    'salva → archivia la versione salvata',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      dirty(app);
      app.bridge.confirmAnswers.push('save');
      app.bridge.saveFileResults.push('/out/x.baapz');
      await act(async () => void (await app.service.archive()));
      const { baap } = readBaapz(app.bridge.files.get('/out/x.baapz')!);
      expect(commentOf(baap)).toBe('modificato');
    },
    T,
  );

  it(
    'nome senza estensione e file già presente: chiede conferma, no → invariato',
    async () => {
      const app = await renderApp({ withProject: true, view: 'project' });
      const old = strToU8('vecchio');
      app.bridge.files.set('/out/x.baapz', old);
      app.bridge.saveFileResults.push('/out/x');
      app.bridge.questionAnswers.push(false);
      await act(async () => void (await app.service.archive()));
      expect(app.bridge.questions).toHaveLength(1);
      expect(app.bridge.files.get('/out/x.baapz')).toBe(old);
    },
    T,
  );
});

describe('Ritira: casi aggiuntivi', () => {
  async function ready() {
    const app = await renderApp({ withProject: true, view: 'project' });
    app.bridge.files.set(ARCH, await archiveBytes(app));
    app.bridge.openFileResults.push([ARCH]);
    return app;
  }

  it(
    'cartella annullata → nessuna scrittura né errori',
    async () => {
      const app = await ready();
      const before = app.bridge.files.size;
      await act(async () => void (await app.service.retrieve()));
      expect(app.bridge.files.size).toBe(before);
      expect(app.bridge.errors).toEqual([]);
    },
    T,
  );

  it(
    'sovrascrittura confermata → file sostituito e progetto aperto',
    async () => {
      const app = await ready();
      app.bridge.files.set(`${DEST}/Linea 3.baap`, strToU8('vecchio'));
      app.bridge.folderResults.push(DEST);
      app.bridge.questionAnswers.push(true);
      await act(async () => void (await app.service.retrieve()));
      expect(readBaap(app.bridge.files.get(`${DEST}/Linea 3.baap`)!).meta.name).toBe('Linea 3');
      expect(app.store.getState().doc!.filePath).toBe(`${DEST}/Linea 3.baap`);
    },
    T,
  );

  it(
    'scrittura fallita → destinazione invariata, errore, documento invariato',
    async () => {
      const app = await ready();
      const old = strToU8('vecchio');
      app.bridge.files.set(`${DEST}/Linea 3.baap`, old);
      app.bridge.folderResults.push(DEST);
      app.bridge.questionAnswers.push(true);
      app.bridge.failNextWrite('EACCES');
      await act(async () => void (await app.service.retrieve()));
      expect(app.bridge.files.get(`${DEST}/Linea 3.baap`)).toBe(old);
      expect(app.bridge.errors.at(-1)!.message).toContain('EACCES');
      expect(app.store.getState().doc!.filePath).toBe(PROJECT_PATH);
    },
    T,
  );

  it(
    'modifiche non salvate: annulla → niente scritto',
    async () => {
      const app = await ready();
      app.bridge.folderResults.push(DEST);
      dirty(app);
      app.bridge.confirmAnswers.push('cancel');
      await act(async () => void (await app.service.retrieve()));
      expect(app.bridge.files.has(`${DEST}/Linea 3.baap`)).toBe(false);
      expect(app.store.getState().doc!.filePath).toBe(PROJECT_PATH);
    },
    T,
  );

  it(
    'modifiche non salvate: non salvare → progetto ritirato aperto, originale invariato',
    async () => {
      const app = await ready();
      app.bridge.folderResults.push(DEST);
      dirty(app);
      app.bridge.confirmAnswers.push('discard');
      await act(async () => void (await app.service.retrieve()));
      expect(app.store.getState().doc!.filePath).toBe(`${DEST}/Linea 3.baap`);
      expect(commentOf(app.bridge.files.get(PROJECT_PATH)!)).toBe('');
      expect(app.bridge.confirmTexts).toHaveLength(1);
    },
    T,
  );

  it(
    'modifiche non salvate: salva → originale salvato, poi ritira',
    async () => {
      const app = await ready();
      app.bridge.folderResults.push(DEST);
      dirty(app);
      app.bridge.confirmAnswers.push('save');
      await act(async () => void (await app.service.retrieve()));
      expect(commentOf(app.bridge.files.get(PROJECT_PATH)!)).toBe('modificato');
      expect(app.store.getState().doc!.filePath).toBe(`${DEST}/Linea 3.baap`);
    },
    T,
  );
});

describe('joinPath', () => {
  it("cartella Windows 'C:\\dir' → separatore backslash", () => {
    expect(joinPath('C:\\dir', 'a.baap')).toBe('C:\\dir\\a.baap');
    expect(joinPath('C:\\dir\\', 'a.baap')).toBe('C:\\dir\\a.baap');
  });
});
