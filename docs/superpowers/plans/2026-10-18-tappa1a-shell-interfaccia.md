# Piano 1A — Shell e interfaccia: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un'app desktop BaaPortal installabile su Windows e macOS, che mostra la Vista portale e la Vista progetto con tutti i 13 elementi di TIA Portal e sa creare, salvare, aprire e chiudere un progetto `.baap`.

**Architecture:** Monorepo npm workspaces con tre pacchetti:

- `@baaportal/project`: modello di progetto e file `.baap`, TypeScript puro;
- `@baaportal/ui`: interfaccia React, testabile in jsdom, che parla col sistema solo tramite l'interfaccia `BaaBridge`;
- `@baaportal/desktop`: Electron, cioè processo principale, preload che espone `window.baa` e renderer che monta `@baaportal/ui`.

Menu, barra degli strumenti e scorciatoie leggono tutti da un unico registro di comandi.

**Tech Stack:** Node 22, TypeScript (strict), Electron (ultima stabile), electron-vite, electron-builder, React 19, Zustand, react-resizable-panels, i18next + react-i18next, fflate, zod, Vitest + @testing-library/react + jsdom, Playwright (`_electron`), ESLint (typescript-eslint), Prettier, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md` (§5, §6, §8.1, §8.2, §8.5, §8.6, §9 tappa 1). Piano generale: `docs/superpowers/plans/2026-10-18-baaportal-roadmap.md`.

## Global Constraints

- Piattaforme: Windows 10/11 x64; macOS 13+ (Apple Silicon e Intel).
- "Interfaccia in italiano, con i termini della versione italiana di TIA Portal." Tutti i testi stanno in `it.json`/`en.json`, nessuna stringa visibile scritta nel codice.
- I **nomi** di elementi e comandi sono quelli di TIA Portal in italiano (spec §8). Le **frasi** più lunghe (descrizioni, messaggi, aiuti) si scrivono con parole nostre e non si copiano da TIA Portal.
- "Nessun codice, icona, immagine, testo o file copiato da prodotti Siemens." Ogni icona è un SVG disegnato da zero in questo repository.
- "Nessun marchio Siemens nel nome, nel logo o nell'installatore di BaaPortal."
- Formato `.baap`: "un file zip con dentro file di testo/JSON leggibili".
- Installatori non firmati con Developer ID / certificato Windows. Su macOS solo firma ad-hoc (`identity: "-"`), necessaria per avviare l'app su Apple Silicon.
- Scorciatoie: `Mod` = Ctrl su Windows, ⌘ su macOS.
- Electron sicuro: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Il renderer accede al sistema solo tramite `window.baa`.
- Le versioni delle dipendenze sono le ultime stabili al momento dell'installazione, poi fissate da `package-lock.json`.

## Review Focus

1. **Nomi e percorsi con caratteri non ASCII e spazi**: un progetto "Pressa àèìòù 日本" in una cartella con spazi si salva e si riapre identico. Nomi non validi per Windows (`CON`, `a/b`, punto finale) vengono rifiutati con un messaggio chiaro _prima_ di scrivere. Test: Task 1 e Task 7.
2. **File `.baap` danneggiato, troncato o di una versione più recente**: messaggio chiaro in italiano, l'app resta utilizzabile e il progetto già aperto non viene toccato. Test: Task 1 e Task 3.
3. **Modifiche non salvate quando si chiude la finestra, si apre un altro progetto o si esce con ⌘Q**: domanda Sì/No/Annulla; con "Annulla" non cambia nulla. Test: Task 3 e Task 7.
4. **Salvataggio fallito** (cartella in sola lettura, disco pieno, file bloccato da un altro programma su Windows): messaggio d'errore, il progetto resta "modificato" e il file originale resta intatto grazie alla scrittura atomica. Test: Task 2 e Task 3.
5. **Doppio clic su un `.baap` con BaaPortal già aperto**: si porta in primo piano la finestra esistente e si apre quel progetto, chiedendo prima se salvare le modifiche. Non parte una seconda istanza. Test: Task 3 e Task 7.

---

## Struttura dei file

```
package.json                         workspaces, script globali
tsconfig.base.json
vitest.config.ts                     test.projects = packages/*, apps/desktop
eslint.config.js
.prettierrc
.gitignore
.nvmrc                               22
packages/project/
  src/index.ts
  src/model.ts                       Project, ProjectMeta, createProject, FORMAT_VERSION
  src/names.ts                       validateProjectName
  src/baapFile.ts                    writeBaap, readBaap, BaapFormatError
  test/model.test.ts  test/names.test.ts  test/baapFile.test.ts
packages/ui/
  src/index.ts                       export App, AppProps, BaaBridge, RecentEntry
  src/bridge.ts                      interfaccia BaaBridge
  src/i18n/index.ts  src/i18n/it.json  src/i18n/en.json
  src/theme/tokens.css  src/theme/global.css
  src/icons/                         un componente SVG per icona
  src/state/store.ts                 store Zustand (vanilla) + tipi
  src/state/AppContext.tsx           provider di store, bridge e servizio
  src/services/projectService.ts
  src/commands/commands.ts           registro comandi
  src/commands/useShortcuts.ts
  src/App.tsx
  src/portal/PortalView.tsx  src/portal/PortalList.tsx  src/portal/ActionList.tsx
  src/portal/selection/OpenProjectPane.tsx  NewProjectPane.tsx  FirstStepsPane.tsx
  src/portal/selection/InstalledSoftwarePane.tsx  LanguagePane.tsx  ClosePane.tsx
  src/project/ProjectView.tsx  MenuBar.tsx  Toolbar.tsx  PanelLayout.tsx
  src/project/EditorBar.tsx  StatusBar.tsx  layoutStorage.ts
  src/project/navigation/treeModel.ts  ProjectTree.tsx  ReferenceProjects.tsx  DetailsView.tsx
  src/project/inspector/Inspector.tsx  ProjectProperties.tsx  InfoMessages.tsx
  src/project/taskcards/TaskCards.tsx
  test/setup.ts  test/fakeBridge.ts  test/*.test.tsx
apps/desktop/
  electron.vite.config.ts  electron-builder.yml  playwright.config.ts
  build/icon.svg  scripts/build-icon.mjs
  src/main/index.ts  src/main/ipc.ts  src/main/recentProjects.ts  src/main/fsAtomic.ts
  src/preload/index.ts
  src/renderer/index.html  src/renderer/main.tsx
  test/recentProjects.test.ts  test/fsAtomic.test.ts
  e2e/helpers.ts  e2e/smoke.spec.ts  e2e/project-flow.spec.ts  e2e/single-instance.spec.ts
.github/workflows/ci.yml
```

---

### Task 1: Toolchain del monorepo e pacchetto `@baaportal/project`

**Files:**

- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.nvmrc`
- Create: `packages/project/package.json`, `packages/project/tsconfig.json`, `packages/project/src/{index,model,names,baapFile}.ts`
- Test: `packages/project/test/{model,names,baapFile}.test.ts`

**Interfaces:**

- Consumes: niente.
- Produces:

  ```ts
  export const FORMAT_VERSION = 1;
  export interface ProjectMeta {
    name: string;
    author: string;
    comment: string;
    createdAt: string;
    modifiedAt: string;
  } // date ISO 8601 UTC
  export interface Project {
    formatVersion: 1;
    meta: ProjectMeta;
  }
  export function createProject(
    input: { name: string; author: string; comment: string },
    now: Date,
  ): Project;
  export type NameCheck =
    | { ok: true }
    | {
        ok: false;
        reason: 'EMPTY' | 'TOO_LONG' | 'INVALID_CHARS' | 'RESERVED' | 'TRAILING_DOT_OR_SPACE';
      };
  export function validateProjectName(name: string): NameCheck;
  export type BaapErrorCode =
    'NOT_ZIP' | 'MISSING_MANIFEST' | 'INVALID_JSON' | 'INVALID_SCHEMA' | 'NEWER_FORMAT';
  export class BaapFormatError extends Error {
    readonly code: BaapErrorCode;
  }
  export function writeBaap(project: Project, opts: { appVersion: string }): Uint8Array;
  export function readBaap(bytes: Uint8Array): Project; // lancia BaapFormatError
  ```

  Contenuto dello zip: `baaportal.json` = `{ "format": "baaportal-project", "formatVersion": 1, "savedWith": "BaaPortal <appVersion>" }` e `project.json` = `{ "formatVersion": 1, "meta": {…} }`. JSON con indentazione di 2 spazi e UTF-8.

- [ ] **Step 1: Prepara la toolchain**

  - `package.json` radice: `"private": true`, `"workspaces": ["packages/*", "apps/*"]`, `"engines": { "node": ">=22" }`, `"type": "module"`.
  - Script: `"test": "vitest run"`, `"typecheck": "tsc -b"`, `"lint": "eslint ."`, `"format": "prettier --write ."`.
  - `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, `jsx: "react-jsx"`.
  - Ogni pacchetto ha `"exports": { ".": "./src/index.ts" }`, quindi viene consumato come sorgente TS.
  - `vitest.config.ts` con `test.projects: ['packages/*', 'apps/desktop']`.
  - `.gitignore`: `node_modules`, `out`, `dist`, `coverage`, `test-results`, `playwright-report`.

  Dipendenze di `@baaportal/project`: `fflate`, `zod`.

- [ ] **Step 2: Scrivi i test che falliscono**

  ```ts
  // model.test.ts
  const now = new Date('2026-10-18T10:00:00.000Z');
  it('createProject imposta i metadati', () => {
    expect(createProject({ name: 'Linea 3', author: 'Mario', comment: '' }, now)).toEqual({
      formatVersion: 1,
      meta: {
        name: 'Linea 3',
        author: 'Mario',
        comment: '',
        createdAt: '2026-10-18T10:00:00.000Z',
        modifiedAt: '2026-10-18T10:00:00.000Z',
      },
    });
  });

  // names.test.ts
  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['a'.repeat(129), 'TOO_LONG'],
    ['Linea/3', 'INVALID_CHARS'],
    ['a\\b', 'INVALID_CHARS'],
    ['a:b', 'INVALID_CHARS'],
    ['a*b', 'INVALID_CHARS'],
    ['a?b', 'INVALID_CHARS'],
    ['a"b', 'INVALID_CHARS'],
    ['a<b', 'INVALID_CHARS'],
    ['a|b', 'INVALID_CHARS'],
    ['a\u0007b', 'INVALID_CHARS'],
    ['CON', 'RESERVED'],
    ['nul', 'RESERVED'],
    ['COM1', 'RESERVED'],
    ['lpt9', 'RESERVED'],
    ['Linea 3.', 'TRAILING_DOT_OR_SPACE'],
    ['Linea 3 ', 'TRAILING_DOT_OR_SPACE'],
  ])('validateProjectName(%j) → %s', (name, reason) => {
    expect(validateProjectName(name)).toEqual({ ok: false, reason });
  });
  it.each(['Linea 3', 'Pressa àèìòù 日本', 'a'.repeat(128), 'CONSOLE'])(
    'validateProjectName(%j) ok',
    (name) => {
      expect(validateProjectName(name)).toEqual({ ok: true });
    },
  );

  // baapFile.test.ts
  it('andata e ritorno conserva tutto, anche caratteri non ASCII e a capo', () => {
    const p = createProject(
      { name: 'Pressa àèìòù 日本', author: 'Zoë', comment: 'riga1\nriga2' },
      now,
    );
    expect(readBaap(writeBaap(p, { appVersion: '0.1.0' }))).toEqual(p);
  });
  it('lo zip contiene manifest e progetto leggibili', () => {
    const files = unzipSync(
      writeBaap(createProject({ name: 'X', author: '', comment: '' }, now), {
        appVersion: '0.1.0',
      }),
    );
    expect(Object.keys(files).sort()).toEqual(['baaportal.json', 'project.json']);
    expect(JSON.parse(strFromU8(files['baaportal.json']!))).toEqual({
      format: 'baaportal-project',
      formatVersion: 1,
      savedWith: 'BaaPortal 0.1.0',
    });
  });
  it.each([
    ['NOT_ZIP', strToU8('ciao')],
    ['NOT_ZIP', new Uint8Array(0)],
    ['MISSING_MANIFEST', zipSync({ 'project.json': strToU8('{}') })],
    ['INVALID_JSON', zipSync({ 'baaportal.json': strToU8('{'), 'project.json': strToU8('{}') })],
    [
      'INVALID_SCHEMA',
      zipSync({
        'baaportal.json': manifest(1),
        'project.json': strToU8('{"formatVersion":1,"meta":{}}'),
      }),
    ],
    ['NEWER_FORMAT', zipSync({ 'baaportal.json': manifest(2), 'project.json': strToU8('{}') })],
    ['NOT_ZIP', truncatedValidBaap()], // primi 60% dei byte di un .baap valido
  ])('readBaap rifiuta con %s', (code, bytes) => {
    expect(catchError(() => readBaap(bytes))).toMatchObject({ name: 'BaapFormatError', code });
  });
  ```

  `manifest(v)`, `truncatedValidBaap()` e `catchError(fn)` (restituisce l'errore lanciato, oppure `undefined`) sono helper locali al file di test.

- [ ] **Step 3: Esegui e verifica che falliscano**

  Run: `npx vitest run packages/project`
  Expected: FAIL, i moduli non esistono ancora.

- [ ] **Step 4: Implementa `model.ts`, `names.ts`, `baapFile.ts`**

  - `readBaap`: `unzipSync` dentro un try (errore → `NOT_ZIP`), poi manifest assente → `MISSING_MANIFEST`, poi `JSON.parse` (errore → `INVALID_JSON`), poi `formatVersion > FORMAT_VERSION` → `NEWER_FORMAT`, poi validazione zod di `project.json` → `INVALID_SCHEMA`.
  - Lo schema zod usa `.strict()` su `meta`.

- [ ] **Step 5: Esegui i test, il typecheck e il lint**

  Run: `npx vitest run packages/project && npm run typecheck && npm run lint`
  Expected: tutti PASS, 0 errori.

- [ ] **Step 6: Commit**

  ```bash
  git add package.json package-lock.json tsconfig.base.json vitest.config.ts eslint.config.js .prettierrc .gitignore .nvmrc packages/project
  git commit -m "feat(project): modello di progetto e file .baap"
  ```

---

### Task 2: App Electron (`@baaportal/desktop`) con bridge verso il sistema

**Files:**

- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/src/main/{index,ipc,recentProjects,fsAtomic}.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/{index.html,main.tsx}`
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/src/{index.ts,bridge.ts,App.tsx}` (App per ora è un segnaposto)
- Test: `apps/desktop/test/{recentProjects,fsAtomic}.test.ts`, `apps/desktop/e2e/{helpers.ts,smoke.spec.ts}`

**Interfaces:**

- Consumes: niente.
- Produces, in `packages/ui/src/bridge.ts`:
  ```ts
  export interface RecentEntry {
    path: string;
    name: string;
    lastOpened: string;
    exists: boolean;
  }
  export interface ConfirmTexts {
    title: string;
    message: string;
    yes: string;
    no: string;
    cancel: string;
  }
  export interface BaaBridge {
    platform: 'win32' | 'darwin' | 'linux';
    appVersion(): Promise<string>;
    defaultProjectDir(): Promise<string>; // <Documenti>/BaaPortal
    showOpenProjectDialog(): Promise<string | null>; // filtro *.baap
    showSaveProjectDialog(suggestedName: string): Promise<string | null>;
    showSelectFolderDialog(): Promise<string | null>;
    readFile(path: string): Promise<Uint8Array>;
    writeFileAtomic(path: string, data: Uint8Array): Promise<void>; // crea le cartelle mancanti
    fileExists(path: string): Promise<boolean>;
    recentList(): Promise<RecentEntry[]>; // exists ricalcolato a ogni chiamata
    recentAdd(path: string, name: string): Promise<RecentEntry[]>;
    recentRemove(path: string): Promise<RecentEntry[]>;
    setWindowTitle(title: string): void;
    confirmUnsaved(texts: ConfirmTexts): Promise<'save' | 'discard' | 'cancel'>; // finestra nativa
    showError(title: string, message: string): Promise<void>; // finestra nativa
    onOpenFileRequest(cb: (path: string) => void): () => void; // associazione file / seconda istanza
    onCloseRequest(cb: () => void): () => void;
    closeWindowConfirmed(): void;
    rendererReady(): void; // sblocca le richieste di apertura in coda
  }
  ```
  `writeFileAtomic` rifiuta con un `Error` che ha `code` (`EACCES`, `EPERM`, `EBUSY`, `ENOSPC`, `ENOENT`, …) intatto.
- Produces, in `apps/desktop/src/main/recentProjects.ts` (logica pura, tipi `{ path; name; lastOpened }`):
  - `addRecent(list, path, name, now: Date, platform): StoredRecent[]`: in cima, senza doppioni, massimo 10;
  - `removeRecent(list, path, platform): StoredRecent[]`;
  - `samePath(a, b, platform): boolean`: senza distinzione maiuscole/minuscole su `win32` e `darwin`, con distinzione su `linux`.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // recentProjects.test.ts
  it('il più recente va in cima e senza doppioni', () => {
    let l = addRecent([], '/a/x.baap', 'x', t(1), 'darwin');
    l = addRecent(l, '/a/y.baap', 'y', t(2), 'darwin');
    l = addRecent(l, '/a/X.baap', 'x', t(3), 'darwin');
    expect(l.map((e) => e.path)).toEqual(['/a/X.baap', '/a/y.baap']);
  });
  it('massimo 10 voci', () => {
    /* 12 add → length 10, la prima aggiunta è sparita */
  });
  it('su win32 C:\\A\\x.baap e c:\\a\\X.baap sono lo stesso file', () => {
    expect(samePath('C:\\A\\x.baap', 'c:\\a\\X.baap', 'win32')).toBe(true);
  });
  it('su linux i percorsi distinguono maiuscole', () => {
    expect(samePath('/a/x.baap', '/a/X.baap', 'linux')).toBe(false);
  });

  // fsAtomic.test.ts (cartella temporanea reale)
  it('scrive e sostituisce un file esistente', async () => {
    /* write 'uno', write 'due' → read 'due' */
  });
  it('crea le cartelle mancanti', async () => {
    /* path tmp/a/b/c.baap */
  });
  it('se la scrittura fallisce, il file originale resta intatto e non resta il .tmp', async () => {
    // file originale 'uno'; cartella resa in sola lettura (chmod 0o555, test saltato su win32)
    await expect(writeFileAtomic(p, bytes('due'))).rejects.toHaveProperty('code');
    expect(read(p)).toBe('uno');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  // e2e/smoke.spec.ts
  test("l'app si avvia con titolo BaaPortal e bridge disponibile", async () => {
    const { app, page } = await launchApp(); // helpers.ts
    expect(await page.title()).toBe('BaaPortal');
    expect(await page.evaluate(() => typeof window.baa.readFile)).toBe('function');
    await app.close();
  });
  ```

  `helpers.ts`: `launchApp({ args?: string[] })`. Avvia `_electron.launch({ args: ['out/main/index.js', ...args], env: { ...process.env, BAA_USER_DATA: <cartella tmp nuova> } })` e restituisce `{ app, page: await app.firstWindow(), userData }`.

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run apps/desktop`
  Expected: FAIL, i moduli mancano.

- [ ] **Step 3: Implementa main, preload e renderer**

  - **`index.ts`**:
    - se `BAA_USER_DATA` è impostata, chiama `app.setPath('userData', …)` **prima** di `ready`;
    - `requestSingleInstanceLock()`; se il lock fallisce, `app.quit()`;
    - una `BrowserWindow` 1400×900, minimo 1024×700, `title: 'BaaPortal'`;
    - `win.on('close')` chiama `preventDefault()` e invia `app:close-requested`, a meno che `allowClose` sia vero; `closeWindowConfirmed` imposta `allowClose = true` e chiude la finestra;
    - `window-all-closed` → `app.quit()` su tutte le piattaforme;
    - i percorsi `.baap` arrivano da `process.argv`, `second-instance` (che porta anche in primo piano la finestra) e `open-file` (macOS). Vanno in coda fino a `rendererReady`, poi si inviano come `app:open-file`.
  - **`ipc.ts`**: un `ipcMain.handle` per ogni metodo del bridge. I dialoghi vanno chiamati come `dialog.showOpenDialog(...)` sull'oggetto modulo, **non** destrutturati, così i test e2e possono sostituirli con `app.evaluate`. I recenti stanno in `<userData>/recent.json`.
  - **`confirmUnsaved`**: `dialog.showMessageBox(win, { type: 'warning', buttons: [yes, no, cancel], defaultId: 0, cancelId: 2 })`, con risposta 0 → `save`, 1 → `discard`, 2 → `cancel`.
  - **`fsAtomic.ts`**: `mkdir -p` della cartella, poi scrittura su `<path>.tmp-<pid>-<n>` e `rename`. In caso di errore cancella il tmp e rilancia l'errore originale.
  - **`preload/index.ts`**: `contextBridge.exposeInMainWorld('baa', bridge)` con `ipcRenderer.invoke`/`on`, con un tipo che soddisfa `BaaBridge`.
  - **`renderer/main.tsx`**: monta `<App bridge={window.baa} />`.
  - Script di `apps/desktop`: `"dev": "electron-vite dev"`, `"build": "electron-vite build"`, `"e2e": "npm run build && playwright test"`.

- [ ] **Step 4: Esegui i test**

  Run: `npx vitest run apps/desktop && npm run e2e -w @baaportal/desktop -- smoke`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop packages/ui package.json package-lock.json
  git commit -m "feat(desktop): app Electron con bridge, recenti e scrittura atomica"
  ```

---

### Task 3: Fondamenta dell'interfaccia: testi, tema, store, servizio progetto, comandi

**Files:**

- Create: `packages/ui/src/i18n/{index.ts,it.json,en.json}`, `packages/ui/src/theme/{tokens.css,global.css}`
- Create: `packages/ui/src/state/{store.ts,AppContext.tsx}`, `packages/ui/src/services/projectService.ts`, `packages/ui/src/commands/{commands.ts,useShortcuts.ts}`, `packages/ui/src/icons/index.tsx`
- Modify: `packages/ui/src/App.tsx` (provider, i18n, tema; la vista vera arriva nel Task 4)
- Test: `packages/ui/test/{setup.ts,fakeBridge.ts,i18n.test.ts,projectService.test.ts,commands.test.ts}`

**Interfaces:**

- Consumes: `Project`, `ProjectMeta`, `createProject`, `writeBaap`, `readBaap`, `BaapFormatError`, `validateProjectName` (Task 1); `BaaBridge` (Task 2).
- Produces, in `store.ts`:
  ```ts
  export type View = 'portal' | 'project';
  export type PortalId = 'start' | 'devices' | 'plc' | 'online';
  export type StartAction =
    'open' | 'new' | 'migrate' | 'close' | 'firstSteps' | 'installed' | 'help' | 'language';
  export type TreeNodeId =
    | 'project'
    | 'add-device'
    | 'devices-networks'
    | 'common-data'
    | 'doc-settings'
    | 'languages'
    | 'online-access';
  export interface OpenDoc {
    project: Project;
    filePath: string;
    dirty: boolean;
  }
  export interface InfoMessage {
    id: number;
    time: string;
    severity: 'info' | 'warning' | 'error';
    textKey: string;
    params?: Record<string, string>;
  }
  export interface PanelState {
    open: boolean;
    pinned: boolean;
    size: number;
  } // size in % del gruppo
  export type PanelName = 'navigation' | 'details' | 'inspector' | 'taskCards';
  export type TaskCardId = 'instructions' | 'test' | 'tasks' | 'libraries';
  export interface AppState {
    view: View;
    portal: PortalId;
    startAction: StartAction;
    doc: OpenDoc | null;
    selection: TreeNodeId | null;
    messages: InfoMessage[];
    status: { textKey: string; params?: Record<string, string> } | null;
    panels: Record<PanelName, PanelState>;
    referenceProjectsOpen: boolean;
    taskCard: TaskCardId;
    setView(v: View): void;
    setPortal(p: PortalId): void;
    setStartAction(a: StartAction): void;
    setDoc(d: OpenDoc | null): void;
    updateMeta(patch: Partial<Pick<ProjectMeta, 'author' | 'comment'>>): void; // imposta dirty
    select(id: TreeNodeId | null): void;
    pushMessage(m: Omit<InfoMessage, 'id' | 'time'>): void; // aggiorna anche status
    setPanel(name: PanelName, patch: Partial<PanelState>): void;
    setReferenceProjectsOpen(o: boolean): void;
    setTaskCard(t: TaskCardId): void;
  }
  export function createAppStore(now?: () => Date): StoreApi<AppState>; // zustand/vanilla
  ```
- Produces, in `projectService.ts`:
  ```ts
  export type CreateResult =
    { ok: true } | { ok: false; error: 'EXISTS' | 'WRITE_FAILED' | 'CANCELED' };
  export interface ProjectService {
    createNew(input: {
      name: string;
      dir: string;
      author: string;
      comment: string;
    }): Promise<CreateResult>; // scrive subito <dir>/<name>.baap
    openFromDialog(): Promise<boolean>;
    open(path: string): Promise<boolean>;
    save(): Promise<boolean>; // imposta meta.modifiedAt = now() prima di scrivere
    saveAs(): Promise<boolean>;
    close(): Promise<boolean>; // true se chiuso o se non c'era niente aperto
    handleCloseRequest(): Promise<void>; // chiama bridge.closeWindowConfirmed() se si può chiudere
  }
  export function createProjectService(deps: {
    store: StoreApi<AppState>;
    bridge: BaaBridge;
    t: TFunction;
    appVersion: string;
    now?: () => Date;
  }): ProjectService;
  ```
  Regole:
  - Ogni azione che sostituisce o chiude il documento passa prima da `ensureCanDiscard()`. Se il documento è modificato, chiama `bridge.confirmUnsaved`: `save` salva (se il salvataggio fallisce, interrompe), `discard` prosegue, `cancel` interrompe e restituisce `false`.
  - Il titolo della finestra si sincronizza con una sottoscrizione allo store: `'BaaPortal - ' + filePath`, oppure `'BaaPortal'` se non c'è un progetto aperto.
  - Dopo `createNew`/`open`/`save` riusciti: `bridge.recentAdd`, poi `pushMessage` con le chiavi `messages.created`/`messages.opened`/`messages.saved` e `{ name }`.
  - Il servizio registra `bridge.onOpenFileRequest(open)` e `bridge.onCloseRequest(handleCloseRequest)`, poi chiama `bridge.rendererReady()`.
- Produces, in `commands.ts`:

  ```ts
  export type CommandId =
    | 'project.new'
    | 'project.open'
    | 'project.close'
    | 'project.save'
    | 'project.saveAs'
    | 'project.archive'
    | 'project.retrieve'
    | 'project.print'
    | 'project.printPreview'
    | 'project.exit'
    | 'edit.undo'
    | 'edit.redo'
    | 'edit.cut'
    | 'edit.copy'
    | 'edit.paste'
    | 'edit.delete'
    | 'edit.rename'
    | 'edit.findReplace'
    | 'edit.selectAll'
    | 'edit.compile'
    | 'view.navigation'
    | 'view.details'
    | 'view.inspector'
    | 'view.taskCards'
    | 'view.portal'
    | 'insert.device'
    | 'insert.block'
    | 'online.goOnline'
    | 'online.goOffline'
    | 'online.simulation'
    | 'online.download'
    | 'online.upload'
    | 'online.accessibleDevices'
    | 'online.startCpu'
    | 'online.stopCpu'
    | 'online.diagnostics'
    | 'options.settings'
    | 'tools.crossReferences'
    | 'tools.callStructure'
    | 'window.splitVertical'
    | 'window.splitHorizontal'
    | 'window.closeAllEditors'
    | 'help.show'
    | 'help.about';
  export interface Command {
    id: CommandId;
    labelKey: string;
    icon?: IconName;
    shortcut?: string;
    isEnabled(s: AppState): boolean;
    isChecked?(s: AppState): boolean;
    run(ctx: CommandContext): void | Promise<void>;
  }
  export interface CommandContext {
    store: StoreApi<AppState>;
    service: ProjectService;
    bridge: BaaBridge;
  }
  export const commands: Record<CommandId, Command>;
  export function matchShortcut(
    e: KeyboardEvent,
    shortcut: string,
    platform: BaaBridge['platform'],
  ): boolean; // 'Mod+Shift+S'
  ```

  Comandi attivi in 1A:
  - `project.new`: vista portale, Avvio, `new`. Scorciatoia `Mod+N`;
  - `project.open` (`Mod+O`), `project.close`, `project.save` (`Mod+S`), `project.saveAs` (`Mod+Shift+S`), `project.exit`;
  - `view.*`, che mostrano/nascondono i pannelli o tornano alla vista portale;
  - `help.about`: vista portale, Avvio, `installed`.

  Tutti gli altri hanno `isEnabled = () => false`. `project.save`, `project.saveAs` e `project.close` sono attivi solo con un documento aperto.

- Produces, in `icons/index.tsx`:

  ```ts
  export type IconName =
    | 'portalStart'
    | 'portalDevices'
    | 'portalPlc'
    | 'portalOnline'
    | 'actionOpen'
    | 'actionNew'
    | 'actionMigrate'
    | 'actionClose'
    | 'actionFirstSteps'
    | 'actionInstalled'
    | 'actionHelp'
    | 'actionLanguage'
    | 'new'
    | 'open'
    | 'save'
    | 'print'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'delete'
    | 'undo'
    | 'redo'
    | 'compile'
    | 'download'
    | 'upload'
    | 'simulation'
    | 'goOnline'
    | 'goOffline'
    | 'accessibleDevices'
    | 'startCpu'
    | 'stopCpu'
    | 'splitWorkArea'
    | 'search'
    | 'treeProject'
    | 'treeAddDevice'
    | 'treeDevicesNetworks'
    | 'treeCommonData'
    | 'treeDocSettings'
    | 'treeLanguages'
    | 'treeOnlineAccess';
  export function registerIcon(name: IconName, svg: FC<{ size: number }>): void;
  export function Icon(props: { name: IconName; size?: 16 | 32 }): JSX.Element; // icona non ancora registrata → riquadro vuoto della stessa misura
  ```

  I Task 4, 5 e 6 disegnano e registrano le icone.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  // i18n.test.ts
  it('it.json ed en.json hanno esattamente le stesse chiavi', () => {
    expect(flatKeys(en)).toEqual(flatKeys(it));
  });
  it('nessun valore vuoto', () => {
    expect(flatValues(it).filter((v) => v.trim() === '')).toEqual([]);
  });

  // projectService.test.ts  (FakeBridge: file system in memoria, risposte di confirmUnsaved in coda, registra le chiamate)
  it('createNew scrive <dir>/<name>.baap, apre il documento e lo aggiunge ai recenti', async () => {
    expect(
      await svc.createNew({ name: 'Linea 3', dir: '/doc/BaaPortal', author: 'M', comment: '' }),
    ).toEqual({ ok: true });
    expect(bridge.files.has('/doc/BaaPortal/Linea 3.baap')).toBe(true);
    expect(store.getState().doc).toMatchObject({
      filePath: '/doc/BaaPortal/Linea 3.baap',
      dirty: false,
    });
    expect(bridge.title).toBe('BaaPortal - /doc/BaaPortal/Linea 3.baap');
    expect(bridge.recent[0]?.name).toBe('Linea 3');
  });
  it('createNew non sovrascrive un progetto esistente', async () => {
    /* file già presente → { ok:false, error:'EXISTS' }, file invariato */
  });
  it("open di un file danneggiato mostra l'errore e lascia aperto il progetto corrente", async () => {
    await openValid('/a.baap');
    bridge.files.set('/rotto.baap', strToU8('xx'));
    expect(await svc.open('/rotto.baap')).toBe(false);
    expect(bridge.errors[0]?.message).toBe(t('errors.baap.NOT_ZIP'));
    expect(store.getState().doc?.filePath).toBe('/a.baap');
  });
  it('open di un file più recente usa errors.baap.NEWER_FORMAT', async () => {
    /* … */
  });
  it.each([
    ['cancel', false, '/a.baap'],
    ['discard', true, '/b.baap'],
  ])(
    'con modifiche non salvate e risposta %s, open restituisce %s',
    async (answer, result, finalPath) => {
      await openValid('/a.baap');
      store.getState().updateMeta({ author: 'X' });
      bridge.confirmAnswers.push(answer);
      expect(await svc.open('/b.baap')).toBe(result);
      expect(store.getState().doc?.filePath).toBe(finalPath);
    },
  );
  it('con risposta save salva prima e poi apre', async () => {
    /* /a.baap riletto ha author 'X'; doc = /b.baap */
  });
  it("salvataggio fallito: messaggio d'errore, resta dirty, il file su disco non cambia", async () => {
    await openValid('/a.baap');
    store.getState().updateMeta({ author: 'X' });
    bridge.failNextWrite('EACCES');
    expect(await svc.save()).toBe(false);
    expect(store.getState().doc?.dirty).toBe(true);
    expect(readBaap(bridge.files.get('/a.baap')!).meta.author).not.toBe('X');
    expect(bridge.errors).toHaveLength(1);
  });
  it('save aggiorna modifiedAt e azzera dirty', async () => {
    /* now() = 2026-10-18T11:00Z → meta.modifiedAt */
  });
  it('saveAs cambia percorso e titolo; annullato non cambia nulla', async () => {
    /* … */
  });
  it('richiesta di chiusura con modifiche e Annulla: la finestra non si chiude', async () => {
    await openValid('/a.baap');
    store.getState().updateMeta({ comment: 'c' });
    bridge.confirmAnswers.push('cancel');
    await bridge.emitCloseRequest();
    expect(bridge.closeConfirmed).toBe(false);
  });
  it('richiesta di apertura dal sistema con modifiche non salvate chiede prima di sostituire', async () => {
    await openValid('/a.baap');
    store.getState().updateMeta({ comment: 'c' });
    bridge.confirmAnswers.push('cancel');
    await bridge.emitOpenFile('/b.baap');
    expect(store.getState().doc?.filePath).toBe('/a.baap');
  });

  // commands.test.ts
  it.each([
    ['win32', { ctrlKey: true, key: 's' }, true],
    ['win32', { metaKey: true, key: 's' }, false],
    ['darwin', { metaKey: true, key: 's' }, true],
    ['darwin', { ctrlKey: true, key: 's' }, false],
  ])('%s: Mod+S con %o → %s', (platform, init, expected) => {
    expect(matchShortcut(new KeyboardEvent('keydown', init), 'Mod+S', platform)).toBe(expected);
  });
  it('Mod+Shift+S non scatta con Mod+S', () => {
    /* … */
  });
  it('salva è disattivato senza progetto e attivo con progetto aperto', () => {
    /* isEnabled */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run packages/ui`
  Expected: FAIL.

- [ ] **Step 3: Implementa i18n, tema, store, servizio e comandi**

  - **i18n**: lingua predefinita `it`, salvata in `localStorage['baa.lang']` (lettura e scrittura in try/catch). Messaggi d'errore: `errors.baap.<codice>`, `errors.write` con `{ path, code }`, `errors.exists`, `errors.read`. Testi della domanda: `confirm.unsaved.{title,message,yes,no,cancel}` con `{ name }`.
  - **`tokens.css`**: valori di partenza nostri, da rifinire sugli screenshot (spec §12):
    - `--baa-portal-bg-start:#2b3a42`, `--baa-portal-bg-end:#1d272d`
    - `--baa-accent:#00a3a3`, `--baa-accent-strong:#007f86`
    - `--baa-panel-bg:#e9edf0`, `--baa-panel-header:#d3dbe0`, `--baa-surface:#ffffff`, `--baa-border:#b7c3ca`
    - `--baa-text:#1b262c`, `--baa-text-muted:#5b6b74`, `--baa-selection:#cfe8ec`, `--baa-disabled:#9aa7ae`
    - `--baa-online:#f29100`
    - `--baa-font:"Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif`, `--baa-font-size:12px`, `--baa-row-height:20px`
  - **`useShortcuts`**: un listener `keydown` su `window` che scorre `commands` e lancia solo quelli attivi. Non scatta quando il focus è in un `input`/`textarea`, salvo per `Mod+S`.

- [ ] **Step 4: Esegui i test**

  Run: `npx vitest run packages/ui && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): store, servizio progetto, comandi, testi e tema"
  ```

---

### Task 4: Vista portale

**Files:**

- Create: `packages/ui/src/portal/{PortalView,PortalList,ActionList}.tsx`, `packages/ui/src/portal/selection/{OpenProjectPane,NewProjectPane,FirstStepsPane,InstalledSoftwarePane,LanguagePane,ClosePane}.tsx`
- Create: `packages/ui/src/icons/` con le icone dei portali e delle operazioni: `PortalStart`, `PortalDevices`, `PortalPlc`, `PortalOnline`, `ActionOpen`, `ActionNew`, `ActionMigrate`, `ActionClose`, `ActionFirstSteps`, `ActionInstalled`, `ActionHelp`, `ActionLanguage`. Tutte SVG 32×32 disegnate da noi, tratto `currentColor`.
- Modify: `packages/ui/src/App.tsx` (mostra `PortalView` se `view === 'portal'`)
- Test: `packages/ui/test/portalView.test.tsx`

**Interfaces:**

- Consumes: store, `ProjectService`, `BaaBridge`, `commands` (Task 3).
- Produces: `PortalView` (nessuna prop, legge dal contesto). Attributi `data-testid`: `portal-list`, `portal-<PortalId>`, `action-list`, `action-<StartAction>`, `selection-pane`, `link-project-view`, `open-project-info`.

Testi (spec §8.1), chiavi `portal.*`:

- portali: Avvio, Dispositivi e reti, Programmazione PLC, Online e diagnostica;
- operazioni di Avvio: Apri progetto esistente, Crea nuovo progetto, Migra progetto, Chiudi progetto, Primi passi, Software installato, Guida, Lingua dell'interfaccia utente;
- link: Vista progetto.

Campi di Crea nuovo progetto: Nome progetto, Percorso, Autore, Commento; pulsanti Sfoglia… e Crea.

Comportamento:

- Senza progetto aperto è attivo solo il portale Avvio; gli altri sono visibili ma disattivati.
- Con un progetto aperto, gli altri portali mostrano solo l'operazione "Apri la vista progetto" più le loro operazioni disattivate. Quelle disattivate in 1A sono: Dispositivi e reti → Aggiungi nuovo dispositivo; Programmazione PLC → Aggiungi nuovo blocco; Online e diagnostica → Dispositivi accessibili.
- "Migra progetto" e "Guida" sono disattivati in 1A.
- **Crea nuovo progetto**:
  - nome predefinito `Progetto1`, oppure `Progetto2`… se `<dir>/ProgettoN.baap` esiste già;
  - percorso predefinito `bridge.defaultProjectDir()`;
  - autore predefinito: l'ultimo usato, in `localStorage['baa.lastAuthor']`;
  - l'errore di `validateProjectName` compare sotto il campo (chiavi `errors.name.<reason>`) e "Crea" resta disattivato;
  - dopo `ok: true` l'operazione selezionata diventa `firstSteps`;
  - con `EXISTS` compare l'errore sotto il campo Nome.
- **Apri progetto esistente**:
  - tabella dei recenti con colonne Progetto, Percorso, Ultimo accesso;
  - doppio clic su una riga apre il progetto;
  - una voce con `exists: false` appare in grigio con l'indicazione "(non trovato)"; al doppio clic compare un messaggio e la voce si toglie con `recentRemove`;
  - il pulsante "Sfoglia…" chiama `service.openFromDialog()`;
  - dopo un'apertura riuscita l'operazione diventa `firstSteps`.
- **Primi passi** (solo con progetto aperto): tre riquadri. "Configura un dispositivo" porta al portale `devices`; "Scrivi programma PLC" porta al portale `plc`; "Apri la vista progetto" porta a `view = 'project'`.
- **Software installato**: elenco con BaaPortal `<appVersion>` e i pacchetti `@baaportal/*` con versione.
- **Lingua dell'interfaccia utente**: due opzioni, Italiano e English; il cambio è immediato.
- **Chiudi progetto**: chiama `service.close()`.
- In basso: link "Vista progetto", sempre attivo, e `open-project-info` con "Progetto aperto: <percorso>" se c'è un progetto.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('senza progetto solo Avvio è attivo', () => {
    renderApp();
    expect(screen.getByTestId('portal-start')).toBeEnabled();
    for (const p of ['devices', 'plc', 'online'])
      expect(screen.getByTestId(`portal-${p}`)).toBeDisabled();
  });
  it("Avvio elenca le operazioni nell'ordine della spec", () => {
    expect(
      within(screen.getByTestId('action-list'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Apri progetto esistente',
      'Crea nuovo progetto',
      'Migra progetto',
      'Chiudi progetto',
      'Primi passi',
      'Software installato',
      'Guida',
      "Lingua dell'interfaccia utente",
    ]);
  });
  it("Crea nuovo progetto: nome non valido mostra l'errore e disattiva Crea", async () => {
    await user.click(screen.getByTestId('action-new'));
    await user.clear(screen.getByLabelText('Nome progetto'));
    await user.type(screen.getByLabelText('Nome progetto'), 'CON');
    expect(screen.getByText(t('errors.name.RESERVED'))).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crea' })).toBeDisabled();
  });
  it('Crea nuovo progetto propone Progetto2 se Progetto1 esiste', async () => {
    /* bridge.files ha /doc/BaaPortal/Progetto1.baap */
  });
  it('Crea → Primi passi → Apri la vista progetto', async () => {
    /* … view === 'project' */
  });
  it('recente non trovato: messaggio e rimozione dalla lista', async () => {
    /* exists:false → recentRemove chiamato */
  });
  it('cambio lingua in English traduce i portali', async () => {
    /* 'Start', 'Devices & networks' … */
  });
  it('Software installato mostra la versione', async () => {
    /* 'BaaPortal 0.1.0' */
  });
  it('il link Vista progetto passa alla vista progetto anche senza progetto', async () => {
    /* … */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run packages/ui/test/portalView.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implementa i componenti**

  Struttura a tre colonne:
  - portali a sinistra: sfondo `--baa-portal-bg-*`, voce selezionata con barra `--baa-accent`;
  - operazioni al centro;
  - finestra di selezione a destra, su `--baa-surface`.

  Il link "Vista progetto" sta in basso a sinistra, le informazioni sul progetto in basso.

- [ ] **Step 4: Esegui i test**

  Run: `npx vitest run packages/ui`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): vista portale"
  ```

---

### Task 5: Vista progetto: barra dei menu, barra degli strumenti, pannelli, barra degli editor, barra di stato

**Files:**

- Create: `packages/ui/src/project/{ProjectView,MenuBar,Toolbar,PanelLayout,EditorBar,StatusBar}.tsx`, `packages/ui/src/project/layoutStorage.ts`
- Create: icone della barra degli strumenti in `packages/ui/src/icons/` (16×16, una per comando con `icon`)
- Modify: `packages/ui/src/App.tsx` (mostra `ProjectView` se `view === 'project'`; monta `useShortcuts`)
- Test: `packages/ui/test/{projectView,layoutStorage}.test.tsx`

**Interfaces:**

- Consumes: store, `commands`, `matchShortcut` (Task 3).
- Produces:
  - `PanelLayout(props: { navigation: ReactNode; referenceProjects: ReactNode; details: ReactNode; workArea: ReactNode; inspector: ReactNode; taskCards: ReactNode })`. In questo task `ProjectView` gli passa contenuti segnaposto; il Task 6 li sostituisce con i componenti veri.
  - `data-testid` dei 13 elementi: `menu-bar`, `toolbar`, `panel-navigation`, `panel-reference-projects`, `panel-details`, `work-area`, `splitter-<nome>`, `panel-inspector`, `link-portal-view`, `editor-bar`, `status-bar`, `panel-task-cards`. La barra del titolo è nativa e si verifica con `bridge.setWindowTitle`.
  - In `layoutStorage.ts`:
    ```ts
    export const LAYOUT_KEY = 'baa.layout.v1';
    export function loadLayout(storage: Storage | null): Record<PanelName, PanelState>; // default se assente, corrotto o fuori intervallo
    export function saveLayout(
      storage: Storage | null,
      panels: Record<PanelName, PanelState>,
    ): void; // try/catch
    export const DEFAULT_PANELS: Record<PanelName, PanelState>; // navigation 20, details 25 (della colonna sinistra), inspector 30 (della colonna centrale), taskCards 22; tutti open:true, pinned:true
    ```

Contenuto della barra dei menu: voci in ordine, con le chiavi da `commands`; `—` indica un separatore.

- **Progetto**: Nuovo…, Apri…, Progetti recenti ▸ (sottomenu dagli ultimi 10, con il nome del progetto), —, Chiudi, Salva, Salva con nome…, —, Archivia…, Ritira archivio…, —, Stampa…, Anteprima di stampa…, —, Esci
- **Modifica**: Annulla, Ripeti, —, Taglia, Copia, Incolla, Elimina, Rinomina, —, Trova e sostituisci…, Seleziona tutto, —, Compila
- **Visualizza**: Navigazione del progetto, Vista dettagli, Finestra di ispezione, Task card (tutte con spunta), —, Vista portale
- **Inserisci**: Nuovo dispositivo…, Nuovo blocco…
- **Online**: Collegamento online, Interrompi collegamento online, Simulazione, —, Carica nel dispositivo, Carica dal dispositivo…, —, Dispositivi accessibili…, Avvia CPU, Arresta CPU, —, Online e diagnostica
- **Opzioni**: Impostazioni
- **Strumenti**: Riferimenti incrociati, Struttura di richiamo
- **Finestra**: Dividi area di lavoro in verticale, Dividi area di lavoro in orizzontale, —, Chiudi tutti gli editor
- **Guida**: Visualizza la guida, Informazioni su BaaPortal

Barra degli strumenti (spec §8.2, punto 3), in ordine: Nuovo, Apri, Salva, Stampa | Taglia, Copia, Incolla, Elimina | Annulla, Ripeti | Compila, Carica nel dispositivo, Carica dal dispositivo, Avvia simulazione | Collegamento online, Interrompi collegamento online, Dispositivi accessibili, Avvia CPU, Arresta CPU | Dividi area di lavoro | campo Ricerca (disattivato in 1A).

Comportamento dei pannelli:

- Freccia sul divisore: pannello chiuso (`open:false`) ridotto a una barretta con il titolo in verticale; un clic lo riapre.
- Puntina nell'intestazione: `pinned:false` = nascondi automaticamente, cioè il pannello resta ridotto e si apre sopra l'area di lavoro al passaggio del mouse o al clic sulla barretta, poi si richiude quando il mouse esce.
- Il layout si salva a ogni modifica e si ricarica all'avvio.

Altri elementi:

- La barra degli editor è vuota in 1A; il link "Vista portale" sta alla sua sinistra.
- La barra di stato mostra `status` dallo store.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('ci sono tutti gli elementi della vista progetto', () => {
    renderApp({ view: 'project', withProject: true });
    for (const id of [
      'menu-bar',
      'toolbar',
      'panel-navigation',
      'panel-reference-projects',
      'panel-details',
      'work-area',
      'panel-inspector',
      'link-portal-view',
      'editor-bar',
      'status-bar',
      'panel-task-cards',
    ])
      expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^splitter-/).length).toBeGreaterThanOrEqual(4);
  });
  it("i menu sono nell'ordine di TIA Portal", () => {
    expect(
      within(screen.getByTestId('menu-bar'))
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual([
      'Progetto',
      'Modifica',
      'Visualizza',
      'Inserisci',
      'Online',
      'Opzioni',
      'Strumenti',
      'Finestra',
      'Guida',
    ]);
  });
  it('menu Progetto: Salva attivo con progetto, Archivia disattivato', async () => {
    /* aria-disabled */
  });
  it('Progetti recenti elenca i recenti e apre quello cliccato', async () => {
    /* service.open chiamato col percorso */
  });
  it('Mod+S salva (Ctrl su win32, ⌘ su darwin)', async () => {
    /* due render con platform diverso */
  });
  it('Visualizza → Finestra di ispezione nasconde e rimostra il pannello', async () => {
    /* … */
  });
  it("nascondi automaticamente: il pannello si apre al passaggio e si richiude all'uscita", async () => {
    /* … */
  });
  it('il link Vista portale torna alla vista portale', async () => {
    /* … */
  });
  it("la barra di stato mostra l'ultimo messaggio", async () => {
    /* pushMessage → testo visibile */
  });

  // layoutStorage.test.ts
  it.each([
    null,
    'non-json',
    '{"navigation":{"open":true,"pinned":true,"size":500}}',
    '{"navigation":{"open":"si"}}',
  ])('layout %j non valido → DEFAULT_PANELS', (raw) => {
    expect(loadLayout(fakeStorage(raw))).toEqual(DEFAULT_PANELS);
  });
  it('storage che lancia eccezioni → DEFAULT_PANELS, saveLayout non lancia', () => {
    /* getItem/setItem throw */
  });
  it('andata e ritorno di un layout valido', () => {
    /* … */
  });
  ```

  Un layout valido ha `size` tra 5 e 80 e tutti e quattro i pannelli; per ogni campo errato si torna ai valori predefiniti di quel pannello.

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run packages/ui/test/projectView.test.tsx packages/ui/test/layoutStorage.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implementa**

  - `PanelLayout` usa `react-resizable-panels` con tre gruppi:
    - orizzontale: sinistra | centro | destra;
    - verticale a sinistra: navigazione | progetti di riferimento | vista dettagli;
    - verticale al centro: area di lavoro | finestra di ispezione.
  - Il menu è un componente nostro, con tastiera: Alt/F10 apre il primo menu, frecce, Invio, Esc.
  - Su macOS resta un menu nativo minimo con le voci standard dell'app (BaaPortal → Informazioni, Esci; Modifica con taglia/copia/incolla per i campi di testo), che si imposta in `apps/desktop/src/main/index.ts`.

- [ ] **Step 4: Esegui i test**

  Run: `npx vitest run packages/ui`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui apps/desktop/src/main/index.ts
  git commit -m "feat(ui): vista progetto con menu, barra strumenti e pannelli"
  ```

---

### Task 6: Navigazione del progetto, vista dettagli, finestra di ispezione, task card

**Files:**

- Create: `packages/ui/src/project/navigation/{treeModel.ts,ProjectTree.tsx,ReferenceProjects.tsx,DetailsView.tsx}`
- Create: `packages/ui/src/project/inspector/{Inspector,ProjectProperties,InfoMessages}.tsx`, `packages/ui/src/project/taskcards/TaskCards.tsx`
- Create: icone dell'albero (16×16): `TreeProject`, `TreeAddDevice`, `TreeDevicesNetworks`, `TreeCommonData`, `TreeDocSettings`, `TreeLanguages`, `TreeOnlineAccess`
- Modify: `packages/ui/src/project/ProjectView.tsx` (riempie gli slot)
- Test: `packages/ui/test/{treeModel,projectTree,inspector,taskCards}.test.tsx`

**Interfaces:**

- Consumes: store (`selection`, `select`, `doc`, `updateMeta`, `messages`, `taskCard`, `setTaskCard`, `referenceProjectsOpen`) dal Task 3; slot di `ProjectView` dal Task 5.
- Produces, in `treeModel.ts`:

  ```ts
  export interface TreeNode {
    id: TreeNodeId;
    labelKey: string;
    label?: string;
    icon: IconName;
    enabled: boolean;
    children: TreeNode[];
  }
  export function buildTree(doc: OpenDoc | null): {
    project: TreeNode | null;
    onlineAccess: TreeNode;
  };
  ```

  Con un documento aperto l'albero è:
  - `project` (etichetta = nome del progetto), con figli:
    - `add-device` (Aggiungi nuovo dispositivo, `enabled:false` in 1A)
    - `devices-networks` (Dispositivi e reti)
    - `common-data` (Dati di base comuni)
    - `doc-settings` (Impostazioni della documentazione)
    - `languages` (Lingue e risorse)
  - `onlineAccess` (Accessi online), senza figli.

  Senza documento, `project` è `null` e l'albero mostra solo "Accessi online".

- Produces: `data-testid` `tree-node-<id>`, `details-row`, `inspector-tab-<properties|info|diagnostics>`, `info-subtab-<general|crossRefs|compile>`, `taskcard-tab-<TaskCardId>`.

Comportamento:

- **Albero**:
  - clic seleziona e doppio clic apre/chiude;
  - tastiera: ↑/↓ spostano, → apre o va al primo figlio, ← chiude o va al genitore;
  - è un `role="tree"` con `aria-expanded`/`aria-selected`;
  - il nodo selezionato usa `--baa-selection`.
- **Progetti di riferimento**: sezione richiudibile sotto l'albero, vuota in 1A, con il testo `navigation.referenceEmpty`.
- **Vista dettagli**: tabella con colonna Nome e una riga per ogni figlio del nodo selezionato; vuota se non ci sono figli.
- **Finestra di ispezione**, schede Proprietà, Informazioni, Diagnostica:
  - _Proprietà_ con `project` selezionato mostra:
    - in sola lettura: Nome, Percorso, Creato il, Ultima modifica (data e ora locali, formato `it-IT`);
    - modificabili: Autore e Commento (multiriga), che a ogni modifica chiamano `updateMeta` (`dirty: true`).
    - Con un altro nodo, "Nessuna proprietà disponibile".
  - _Informazioni_ ha le sottoschede Generale, Riferimenti incrociati, Compila. In Generale c'è una tabella con icona di gravità, Messaggio, Data, Ora, dalla più recente; le altre due sono vuote in 1A.
  - _Diagnostica_: vuota con testo segnaposto.
- **Task card**: schede verticali sul bordo destro (Istruzioni, Test, Task, Librerie). Ognuna mostra le sue sezioni richiudibili (spec §8.2, punto 13) con il testo segnaposto `taskcards.empty`.

- [ ] **Step 1: Scrivi i test che falliscono**

  ```ts
  it('buildTree senza documento ha solo Accessi online', () => {
    expect(buildTree(null).project).toBeNull();
  });
  it("buildTree con documento: figli nell'ordine della spec, Aggiungi nuovo dispositivo disattivato", () => {
    const { project } = buildTree(doc('Linea 3'));
    expect(project?.label).toBe('Linea 3');
    expect(project?.children.map((c) => c.id)).toEqual([
      'add-device',
      'devices-networks',
      'common-data',
      'doc-settings',
      'languages',
    ]);
    expect(project?.children[0]?.enabled).toBe(false);
  });
  it('tastiera: ↓ seleziona il nodo successivo, ← chiude il progetto', async () => {
    /* … */
  });
  it('Vista dettagli mostra i figli del nodo selezionato', async () => {
    /* 5 righe con project selezionato */
  });
  it('Proprietà: modificare Autore rende il progetto modificato', async () => {
    await user.click(screen.getByTestId('tree-node-project'));
    await user.type(screen.getByLabelText('Autore'), 'Z');
    expect(store.getState().doc?.dirty).toBe(true);
    expect(store.getState().doc?.project.meta.author.endsWith('Z')).toBe(true);
  });
  it('Nome e Percorso sono in sola lettura', () => {
    /* readonly */
  });
  it('Informazioni → Generale elenca i messaggi, il più recente in alto', async () => {
    /* due pushMessage */
  });
  it('task card: le quattro schede e le sezioni di Istruzioni', async () => {
    /* Preferiti, Istruzioni di base, Istruzioni avanzate, Comunicazione, Pacchetti opzionali */
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npx vitest run packages/ui/test/treeModel.test.tsx packages/ui/test/projectTree.test.tsx packages/ui/test/inspector.test.tsx packages/ui/test/taskCards.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implementa i componenti**

- [ ] **Step 4: Esegui tutti i test**

  Run: `npx vitest run && npm run typecheck && npm run lint`
  Expected: PASS, 0 errori.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui
  git commit -m "feat(ui): navigazione progetto, vista dettagli, finestra di ispezione, task card"
  ```

---

### Task 7: Installatori, associazione `.baap`, CI e test end-to-end

**Files:**

- Create: `apps/desktop/electron-builder.yml`, `apps/desktop/build/icon.svg`, `apps/desktop/scripts/build-icon.mjs`
- Create: `apps/desktop/e2e/{project-flow,single-instance}.spec.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `apps/desktop/package.json` (script `icon`, `dist`), `package.json` radice (script `e2e`, `dist`)

**Interfaces:**

- Consumes: tutta l'app (Task 2–6), `launchApp` (Task 2).
- Produces: `npm run dist`, che genera gli installatori in `apps/desktop/dist/`.

Configurazione:

- **Logo**: `icon.svg` è il logo BaaPortal disegnato da noi, una "B" stilizzata su un quadrato arrotondato `--baa-accent`, senza alcun richiamo a marchi Siemens. `build-icon.mjs` lo converte in `build/icon.png` 1024×1024 con `@resvg/resvg-js`; electron-builder ne ricava `.icns` e `.ico`.
- **electron-builder**:
  - `appId: it.baaportal.app`, `productName: BaaPortal`;
  - `fileAssociations: [{ ext: baap, name: Progetto BaaPortal, role: Editor }]`;
  - `win.target: nsis` (x64), con `nsis.oneClick: false` e `allowToChangeInstallationDirectory: true`;
  - `mac.target: dmg` per `arm64` e `x64`, con `mac.identity: "-"` e `mac.category: public.app-category.developer-tools`;
  - `publish: never`.
- **CI** (`ci.yml`): su push e pull request; matrice `windows-latest`, `macos-latest`; Node 22. Passi:
  1. `npm ci`
  2. `npm run typecheck`
  3. `npm run lint`
  4. `npm test`
  5. `npm run e2e`
  6. `npm run dist`
  7. upload artifact degli installatori

- [ ] **Step 1: Scrivi i test e2e che falliscono**

  Prima di ogni test, i dialoghi nativi si sostituiscono nel processo principale, così le risposte sono pilotate dal test:

  ```ts
  await app.evaluate(({ dialog }, p) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, null);
  ```

  ```ts
  // project-flow.spec.ts
  test('crea, modifica, salva, chiude e riapre dai recenti, con nome non ASCII in cartella con spazi', async () => {
    const dir = join(tmp, 'cartella con spazi');
    // Avvio → Crea nuovo progetto: Nome 'Pressa àè 日本', Percorso dir → Crea → Apri la vista progetto
    // seleziona il progetto nell'albero, Autore 'Collaudo', Mod+S
    // Progetto → Chiudi; Avvio → Apri progetto esistente → doppio clic sulla prima riga
    // Proprietà: Autore === 'Collaudo'; titolo finestra === `BaaPortal - ${join(dir, 'Pressa àè 日本.baap')}`
  });
  test("chiusura finestra con modifiche e Annulla: l'app resta aperta", async () => {
    // showMessageBox → response 2 (Annulla); page.close() tentato via app.evaluate(w => BrowserWindow.getAllWindows()[0].close())
    // la finestra esiste ancora e il progetto è ancora modificato
  });
  test("file .baap danneggiato: messaggio d'errore e app utilizzabile", async () => {
    /* scrive 'xx' in rotto.baap, lo apre via argv */
  });

  // single-instance.spec.ts
  test("aprire un .baap con l'app già aperta lo apre nella finestra esistente", async () => {
    const { app, userData } = await launchApp();
    // seconda istanza: spawn di electron con stesso BAA_USER_DATA e args [main, progetto.baap]
    // la seconda istanza esce da sola; la prima mostra il titolo `BaaPortal - <progetto.baap>`
  });
  ```

- [ ] **Step 2: Esegui e verifica che falliscano**

  Run: `npm run e2e`
  Expected: la logica sta nei Task 2–6, quindi alcuni test possono già passare; questi test servono a fissare il comportamento. Ogni test che fallisce si corregge in questo task, prima di andare avanti.

- [ ] **Step 3: Implementa configurazione, icona e workflow**

- [ ] **Step 4: Verifica tutto**

  Run: `npm test && npm run e2e && npm run dist`
  Expected:
  - test PASS;
  - su macOS: `apps/desktop/dist/BaaPortal-<versione>-arm64.dmg` e `-x64.dmg`, e `codesign --verify --deep --strict "apps/desktop/dist/mac-arm64/BaaPortal.app"` termina con codice 0;
  - su Windows: `apps/desktop/dist/BaaPortal Setup <versione>.exe`.

- [ ] **Step 5: Collaudo manuale su Windows e macOS** (lista di controllo, spec §10)

  - [ ] L'installatore si avvia (macOS 13–14: tasto destro → Apri; macOS 15+: Impostazioni di Sistema → Privacy e sicurezza → "Apri comunque", oppure `xattr -dr com.apple.quarantine /Applications/BaaPortal.app`; un dmg costruito in locale non è in quarantena; Windows: "Esegui comunque") e l'app si apre sulla Vista portale.
  - [ ] Un progetto creato si trova come `.baap` nella cartella scelta, e il doppio clic sul file apre BaaPortal con quel progetto.
  - [ ] Tutti gli elementi di spec §8.1 e §8.2 sono visibili; pannelli, divisori e puntine funzionano; il layout si ricorda al riavvio.
  - [ ] Italiano ↔ English funziona e la scelta si ricorda.
  - [ ] Ctrl+S (Windows) e ⌘S (macOS) salvano.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/desktop .github package.json package-lock.json
  git commit -m "feat(desktop): installatori Windows/macOS, associazione .baap, CI ed e2e"
  ```
