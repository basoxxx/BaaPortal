# Piano 3U — Aggiornamenti automatici — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per realizzare questo piano un task alla volta. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** chi ha installato una versione di prova (pre-release) vecchia riceve da solo l'ultima versione di prova, oppure una stabile se è più alta. L'utente:

- dopo l'avvio, e poi ogni 6 ore, viene avvisato «È disponibile BaaPortal X.Y.Z», con «Scarica», «Più tardi» e il link alle note di rilascio;
- controlla a mano da «Guida → Controlla aggiornamenti…» o da «Software installato» nel portale;
- su Windows scarica l'aggiornamento con l'avanzamento nella barra di stato e sceglie «Riavvia e aggiorna» o «Al prossimo avvio»;
- su macOS scarica il DMG giusto per il suo Mac nella cartella Download, controllato, e lo trova aperto nel Finder con le istruzioni per sostituire l'app;
- in Opzioni → Impostazioni sceglie se controllare all'avvio e se ricevere anche le versioni di prova.

**Architettura:**

- **Rilascio:** electron-builder scrive `latest.yml`, `latest-mac.yml` e i `.blockmap` accanto agli installatori (`publish: github`, ma con `--publish never`: carica la CI). `release.yml` li allega alla release. Il canale della build (prova o stabile) si decide in CI dal flag della release e diventa una costante del main.
- **Main:** un `UpdateService` unico, con dipendenze iniettabili (updater, piattaforma, stato del PLC, orologio, rete, file). Le regole pure stanno in `updatePolicy.ts`. electron-updater si carica solo nelle build pacchettizzate (`import()` dinamico), così sviluppo, test ed e2e non lo toccano mai.
- **Windows:** electron-updater con il provider GitHub fa controllo, scaricamento (differenziale con i `.blockmap`), verifica sha512 e installazione NSIS.
- **macOS:** lo stesso controllo di electron-updater legge `latest-mac.yml`, ma non scarica né installa (niente Squirrel.Mac, che vuole una firma vera). Il main scarica da sé il DMG dell'architettura giusta, verifica lo sha512 e lo apre.
- **Renderer:** un avviso fisso in basso a destra, presente sia nel portale sia nella vista progetto, più l'avanzamento nella barra di stato. Le impostazioni restano nel `localStorage` del renderer e il renderer le manda al main.

**Tecnologie:** TypeScript, Electron (main, IPC, `net`, `shell`), electron-updater 6, electron-builder 26, electron-vite 6 (`define`), React 19, zustand, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-18-baaportal-design.md`:

- non dice nulla degli aggiornamenti dell'app. La riga 399 («Aggiornamento firmware: No») riguarda il firmware della CPU, non l'app;
- riga 69: «La firma (Apple Developer ID, certificato Windows) si aggiunge se e quando la ditta vuole distribuirlo più largamente». Questo piano resta senza firma, e i limiti noti lo dicono.

Piano generale: nuova riga 3U, prima della 3D. La richiesta viene direttamente dall'utente: «aggiungi già gli aggiornamenti automatici in app, per chi avesse una versione pre release vecchia, che aggiorna all'ultima pre release o ad una versione stabile se disponibile».

## Global Constraints

- **Mai durante un lavoro sul PLC:**
  - l'installazione (Windows) si rifiuta finché è in corso una scrittura, un caricamento nel dispositivo, un caricamento dal dispositivo o un backup;
  - prima di installare si passa dalla domanda delle modifiche non salvate e si va offline in modo pulito, con la stessa chiusura dell'uscita normale;
  - l'app non si riavvia mai da sola.
- **Mai all'indietro:** `allowDowngrade` è `false`, e in più il main confronta le versioni con semver prima di avvisare. Una versione uguale o più bassa non si offre mai.
- **Nessun controllo nascosto fuori dalle regole:**
  - automatico solo nelle build pacchettizzate, circa 10 s dopo che il renderer ha mandato le impostazioni, poi ogni 6 h, e solo con «Controlla gli aggiornamenti all'avvio» attivo;
  - mai con `!app.isPackaged`, quindi mai in sviluppo, nei test né nelle e2e;
  - solo HTTPS verso `github.com` e i suoi indirizzi di download.
- **Errori:** offline, GitHub che non risponde o limita le richieste: silenziosi nei controlli automatici, mostrati solo in quelli a mano. Un errore di scaricamento si mostra sempre, perché l'utente ha premuto «Scarica».
- **Integrità:** su Windows lo sha512 di `latest.yml` (electron-updater). Su macOS lo sha512 di `latest-mac.yml`, controllato dal nostro codice prima di aprire il file. Non c'è una firma dell'editore, e lo dicono i limiti noti.
- **Nessun file a metà:** su macOS si scrive in un `.part` che si rinomina solo dopo il controllo dello sha512. Un errore o un annullamento lo cancellano.
- **Il renderer non sceglie URL né percorsi:** il link alle note di rilascio e l'URL del DMG li costruisce il main, da una versione semver valida e dal nome di file presente in `latest-mac.yml`.
- **Lingua e testi:**
  - italiano, con l'inglese dove l'interfaccia è tradotta;
  - le chiavi in `it.json` ed `en.json` sono uguali;
  - i nomi delle voci sono quelli di TIA dove esistono («Guida», «Impostazioni»).
- **Nessuna e2e contro GitHub:** le regole si provano con un updater finto e con una rete finta. La prova vera è sulla prima release dopo la 0.12.0.

## Review Focus

1. **Aggiornamento offerto o installato mentre si scrive nella CPU** (carica nel dispositivo, comando di variabili, ora, backup): «Riavvia e aggiorna» si rifiuta con il messaggio, nessuna domanda di salvataggio parte, l'app non si chiude. Al prossimo avvio con l'installazione all'uscita, l'uscita passa comunque dalla conferma del 3B. → test in Task 2 e Task 4.
2. **Build di prova a cui si offre una stabile più vecchia, o build stabile a cui si offre una di prova:** il canale viene dalla costante di build e dall'impostazione; una versione non più alta (semver) non dà mai l'avviso; una build stabile senza la casella attiva non vede mai una pre-release. → test in Task 1 e Task 2.
3. **Architettura sbagliata del Mac:** un Mac Apple Silicon riceve il DMG `-arm64`, un Mac Intel `-x64`, una build x64 sotto Rosetta riceve `-arm64`. Se `latest-mac.yml` non ha esattamente un DMG per quell'architettura, errore chiaro e nessuno scaricamento. Un `latest-mac.yml` con un'architettura sola fa fallire la release in CI. → test in Task 1 e Task 3.
4. **GitHub che limita le richieste (403/429), offline, proxy aziendale:** il controllo automatico tace e riprova al giro dopo (6 h); quello a mano mostra il messaggio. Nessun controllo parte mentre un altro è in corso, e un controllo a mano mentre ne gira uno automatico usa quel risultato. → test in Task 2.
5. **File scaricato a metà o alterato:** su Windows electron-updater verifica lo sha512 prima di installare. Su macOS il `.part` si cancella su errore, annullamento e sha512 diverso; un file finito si rinomina solo dopo la verifica; un DMG già presente con lo sha512 giusto si riusa, uno diverso non si tocca. → test in Task 3.

---

### Task 1: Configurazione di electron-builder, canale di build e pipeline di rilascio

**Files:**

- Modify:
  - `apps/desktop/package.json`: `electron-updater` (^6) fra le `dependencies`, che oggi non esistono. Restano devDependencies i pacchetti del monorepo, che electron-vite impacchetta nel bundle;
  - `package-lock.json`;
  - `apps/desktop/electron-builder.yml`: `publish: { provider: github, owner: basoxxx, repo: BaaPortal }`;
  - `apps/desktop/electron.vite.config.ts`: `main.define.__BAA_PRERELEASE_BUILD__`;
  - `apps/desktop/src/main/env.d.ts` (nuovo se manca): `declare const __BAA_PRERELEASE_BUILD__: boolean`;
  - `apps/desktop/vitest.config.ts`: lo stesso `define` (valore `true`), così i moduli del main si importano nei test;
  - `.github/workflows/release.yml`: canale di build, verifica dei file, upload di `latest*.yml` e `*.blockmap`;
  - `.github/workflows/ci.yml`: dopo `npm run dist`, lo stesso controllo dei file (senza upload alla release).
- Create:
  - `apps/desktop/scripts/check-dist.mjs`: controlla la cartella `dist` dopo `npm run dist` (vedi Regole);
  - `apps/desktop/src/main/update/buildChannel.ts`: `prereleaseBuild(envValue)`, la regola del canale, usata da `electron.vite.config.ts` e dai test.
- Test: `apps/desktop/test/update/releaseConfig.test.ts`, `apps/desktop/test/update/checkDist.test.ts`

**Interfaces:**

- `prereleaseBuild(v: string | undefined): boolean` → `false` solo per la stringa esatta `'false'`; tutto il resto (assente, vuoto, `'true'`, altro) → `true`.
- `checkDist(dir, platform: 'win32' | 'darwin', version) → string[]` (elenco degli errori, vuoto se va bene). Lo script lo chiama e termina con codice 1 se ci sono errori.

Regole:

- **Dipendenza vera:** electron-vite 6 esternalizza da solo le `dependencies` (`build.externalizeDeps`, predefinito `true`), quindi `electron-updater` resta un `import` nel bundle del main e electron-builder lo copia in `app.asar` con le sue dipendenze (`builder-util-runtime`, `semver`, `js-yaml`, `lazy-val`, `lodash.*`, `tiny-typed-emitter`, `fs-extra`). Con i workspace npm le dipendenze stanno nel `node_modules` della radice: electron-builder 26 le raccoglie lo stesso.
- **Controllo dell'app impacchettata (`check-dist.mjs`):**
  - con `@electron/asar` (già presente, dipendenza di electron-builder) elenca `app.asar` di ogni build (`dist/win-unpacked/resources/app.asar`, `dist/mac-arm64/BaaPortal.app/Contents/Resources/app.asar`, `dist/mac/BaaPortal.app/…`) e pretende `/node_modules/electron-updater/package.json` e `/node_modules/builder-util-runtime/package.json`;
  - pretende `resources/app-update.yml` con `owner: basoxxx` e `repo: BaaPortal`;
  - Windows: pretende `BaaPortal-Setup-<versione>.exe`, il suo `.blockmap` e `latest.yml` con `version: <versione>` e una voce `files` con quel nome, `sha512` e `size` uguali al file vero (lo script ricalcola lo sha512 in base64);
  - macOS: pretende i due DMG (`-arm64.dmg`, `-x64.dmg`), i loro `.blockmap` e **un solo** `latest-mac.yml` che li elenca entrambi in `files`, con sha512 e dimensione giusti.
- **Due architetture Mac in un file:** il job macOS costruisce già arm64 e x64 nella stessa chiamata di electron-builder, che scrive allora un solo `latest-mac.yml` con tutti i file della chiamata. Per primo, nell'esecuzione del task, si lancia `npm run dist` su un Mac e si guarda `dist/latest-mac.yml`:
  - se elenca i due DMG, basta il controllo di `check-dist.mjs`;
  - se electron-builder non scrive `latest-mac.yml` con il solo target `dmg`, si aggiunge il target `zip` (stesse due architetture) e il controllo pretende anche gli zip. Gli zip si caricano nella release ma l'app non li usa;
  - se le architetture finiscono in file separati, `check-dist.mjs` riceve `--merge-mac` e li unisce in uno (stessa `version`, `files` concatenati, `path` e `sha512` di primo livello dal file arm64), prima del controllo.
- **`--publish never` resta** in `npm run dist`: electron-builder scrive comunque i file di aggiornamento perché c'è una configurazione `publish`, ma non carica nulla. Il caricamento lo fa solo `release.yml`.
- **Canale di build:**
  - `release.yml` imposta `BAAPORTAL_PRERELEASE` prima di `npm run dist`:
    - con l'evento release: `${{ github.event.release.prerelease }}`;
    - a mano (`workflow_dispatch`): `gh release view "$TAG" --json isPrerelease -q .isPrerelease`;
  - `electron.vite.config.ts`: `define: { __BAA_PRERELEASE_BUILD__: JSON.stringify(prereleaseBuild(process.env.BAAPORTAL_PRERELEASE)) }`;
  - build locali, CI di ogni push e sviluppo contano come prova (`true`).
- **Upload in `release.yml`:** `files=(apps/desktop/dist/*.exe apps/desktop/dist/*.dmg apps/desktop/dist/latest*.yml apps/desktop/dist/*.blockmap)`, poi `node apps/desktop/scripts/check-dist.mjs` **prima** di `gh release upload`. Se il controllo fallisce non si carica nulla.
- **Le due piattaforme non si pestano:** Windows carica `latest.yml`, macOS `latest-mac.yml`; i nomi sono diversi e `--clobber` resta.
- **CI di ogni push:** dopo `npm run dist` gira lo stesso `check-dist.mjs`. Gli artefatti della CI aggiungono `latest*.yml`, così un errore della configurazione si vede prima del rilascio.

- [ ] **Step 1: Test**
  - `prereleaseBuild: 'false' → false; undefined, '', 'true', 'False' → true`
  - `electron-builder.yml ha publish github con owner basoxxx e repo BaaPortal` (letto con `js-yaml`)
  - `electron-builder.yml: artifactName Windows e Mac invariati (BaaPortal-Setup-${version}, ${productName}-${version}-${arch})`
  - `package.json del desktop: electron-updater in dependencies, nessun pacchetto @baaportal/* in dependencies`
  - `script dist: contiene --publish never`
  - `release.yml: imposta BAAPORTAL_PRERELEASE da github.event.release.prerelease e da gh release view`
  - `release.yml: carica *.exe, *.dmg, latest*.yml e *.blockmap, e lancia check-dist prima dell'upload`
  - `electron.vite.config.ts: define di __BAA_PRERELEASE_BUILD__`
  - `checkDist su una cartella finta Windows completa → nessun errore`
  - `checkDist: latest.yml con sha512 diverso dall'exe → errore`
  - `checkDist: latest-mac.yml con il solo DMG arm64 → errore «manca x64»`
  - `checkDist: manca app-update.yml o electron-updater in app.asar → errore` (asar finto creato con `@electron/asar` nel test)
  - `checkDist --merge-mac: due yml, uno per architettura → un file con entrambi`
- [ ] **Step 2:** `npm run dist` su macOS; `node apps/desktop/scripts/check-dist.mjs`; si annota nel commit quale dei tre casi di `latest-mac.yml` si è verificato.
- [ ] **Step 3–4:** `--project @baaportal/desktop`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 5: Commit** — `build(desktop): file di aggiornamento nella release e canale di build`

### Task 2: Servizio degli aggiornamenti nel main (regole e Windows)

**Files:**

- Create:
  - `apps/desktop/src/main/update/updatePolicy.ts`: regole pure;
  - `apps/desktop/src/main/update/updateService.ts`: stato, pianificazione, controllo, scaricamento e installazione;
  - `apps/desktop/src/main/update/updaterPort.ts`: l'interfaccia minima di electron-updater e `loadUpdater()` (import dinamico);
  - `apps/desktop/src/main/update/updateIpc.ts`: i canali `update:*`;
  - `apps/desktop/src/shared/updateTypes.ts`, riesportati da `packages/ui/src/update/updateTypes.ts` (stessi tipi, come `plcTypes.ts`).
- Modify:
  - `apps/desktop/src/main/plc/plcIpc.ts`: `registerPlc` restituisce anche `busy(): boolean` = scrittura in corso **o** caricamento dal dispositivo **o** backup; `UploadService` e `BackupService` aggiungono `active(): boolean`;
  - `apps/desktop/src/main/ipc.ts`: `registerIpc` restituisce `busy()` e registra `updateIpc`;
  - `apps/desktop/src/main/index.ts`: crea il servizio solo con `app.isPackaged`, e aggiunge l'uscita per aggiornamento (vedi Regole);
  - `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/rawBridge.ts`, `packages/ui/src/bridge.ts` (+ `createBridge` e `packages/ui/test/fakeBridge.ts`).
- Test: `apps/desktop/test/update/updatePolicy.test.ts`, `apps/desktop/test/update/updateService.test.ts`, `apps/desktop/test/plc/busy.test.ts`

**Interfaces:**

- `UpdatePrefs = { checkOnStartup: boolean; prerelease: boolean | null }` (`null` = segue la build).
- `UpdateInfoView = { enabled: boolean; prereleaseBuild: boolean; current: string; platform: 'win32' | 'darwin' | 'linux'; mode: 'install' | 'dmg' | 'none' }`. `enabled` è `false` con `!app.isPackaged`; `mode` è `install` su Windows, `dmg` su macOS, `none` altrove.
- `UpdateEvent`, da main a renderer su `update:event`:
  - `{ type: 'checking'; manual: boolean }`;
  - `{ type: 'none'; manual: boolean }` (inviato solo se `manual`);
  - `{ type: 'available'; version; manual: boolean }`;
  - `{ type: 'progress'; transferred; total }`;
  - `{ type: 'downloaded'; version }` (Windows);
  - `{ type: 'macReady'; version; path; reused: boolean }` (Task 3);
  - `{ type: 'error'; phase: 'check' | 'download' | 'install'; message; manual: boolean }`;
  - `{ type: 'cancelled' }`.
- Canali (tutti col controllo del frame fidato di `registerIpc`):
  - `update:info() → UpdateInfoView`;
  - `update:state() → UpdateEvent | null` (l'ultimo evento significativo, così l'avviso si ricostruisce dopo una ricarica del renderer);
  - `update:prefs(raw)` → `parseUpdatePrefs`, poi pianificazione;
  - `update:check() → void` (a mano; gli esiti arrivano come eventi);
  - `update:download() → void`; `update:cancelDownload() → void`;
  - `update:canInstall() → { ok: true } | { ok: false; reason: 'busy' | 'notReady' }`;
  - `update:install() → { ok: false; reason: 'busy' | 'notReady' } | never` (con successo l'app esce);
  - `update:later(version)`: non avvisa più per quella versione fino al prossimo avvio;
  - `update:openNotes(version)`: apre `https://github.com/basoxxx/BaaPortal/releases/tag/v<version>` con `shell.openExternal`, solo se `version` è semver valido.
- `updatePolicy.ts`:
  - `effectivePrerelease(build: boolean, pref: boolean | null): boolean` = `pref ?? build`;
  - `isNewer(remote: string, current: string): boolean` = `semver.valid(remote) && semver.gt(remote, current)`;
  - `parseUpdatePrefs(raw): UpdatePrefs | string`;
  - `shouldReport(kind: 'none' | 'error', manual: boolean): boolean` → solo con `manual`;
  - `errorText(err): string`: messaggi italiani brevi per rete assente, 403/429 di GitHub, 404 del file di aggiornamento («La release non ha il file di aggiornamento»), sha512 diverso, altro.
- `UpdaterPort` (sottoinsieme di `AppUpdater`): `allowPrerelease`, `allowDowngrade`, `autoDownload`, `autoInstallOnAppQuit`, `logger`, `checkForUpdates(): Promise<{ updateInfo: { version; files: { url; sha512; size? }[] } } | null>`, `downloadUpdate(token)`, `quitAndInstall(isSilent, isForceRunAfter)`, `on('download-progress' | 'update-downloaded' | 'error', cb)`; `CancellationToken` di `builder-util-runtime`.
- `UpdateService(deps)` con `deps = { updater: () => Promise<UpdaterPort>; platform; arch; prereleaseBuild; current; busy(); closeOnline(): Promise<void>; prepareQuit(): void; send(e: UpdateEvent); setTimeout/clearTimeout/now; macDownload? (Task 3) }`.

Regole:

- **Configurazione di electron-updater** a ogni controllo: `autoDownload = false`, `autoInstallOnAppQuit = (platform === 'win32')`, `allowDowngrade = false`, `allowPrerelease = effectivePrerelease(...)`. Su macOS non si chiama mai `downloadUpdate` né `quitAndInstall` (R5).
- **Import:** `loadUpdater()` fa `const m = await import('electron-updater'); return m.default.autoUpdater` (pacchetto CommonJS dentro un main ESM: niente import con nome). Si chiama solo nel servizio, che esiste solo con `app.isPackaged`.
- **Pianificazione:**
  - nessun controllo prima del primo `update:prefs` (il renderer lo manda all'avvio, dopo `rendererReady`);
  - con `checkOnStartup` il primo controllo parte 10 s dopo, poi ogni 6 h dalla fine del precedente;
  - spegnere l'impostazione toglie il temporizzatore; riaccenderla ne pianifica uno a 10 s;
  - cambiare `prerelease` non fa partire un controllo da solo;
  - un controllo alla volta: una richiesta (a mano o automatica) mentre uno è in corso aspetta quello, e un controllo a mano lo marca `manual`, così il suo esito si mostra;
  - durante uno scaricamento, o con un aggiornamento già scaricato, i controlli automatici non partono.
- **Esito del controllo:**
  - `isNewer(info.version, current)` falso → `none` (mostrato solo a mano), anche se electron-updater dice il contrario;
  - vero → `available`, salvo che quella versione sia stata rimandata con `update:later` e il controllo sia automatico;
  - l'evento non dice se la versione trovata è di prova: le nostre versioni non hanno suffisso e electron-updater non porta il flag della release. Il link alle note di rilascio lo mostra.
- **Errori:** `error` con `phase: 'check'` si manda solo se `manual`; altrimenti si scrive nel log del main e basta. `phase: 'download'` e `'install'` si mandano sempre.
- **Scaricamento (Windows):** `downloadUpdate(token)`; `download-progress` diventa `progress`, al massimo ogni 250 ms; `update-downloaded` → `downloaded`. `update:cancelDownload` annulla il token → `cancelled`.
- **Installazione (Windows):**
  1. `canInstall`: niente aggiornamento scaricato → `notReady`; `busy()` → `busy`;
  2. il renderer fa la sua parte (Task 4: modifiche non salvate, simulazione, offline nel renderer);
  3. `install`: si ricontrolla `busy()` (fra i due passi potrebbe essere partita una scrittura), poi `closeOnline()` con un limite di 1 s come all'uscita, poi `prepareQuit()` e `quitAndInstall(false, true)`;
  4. `prepareQuit()` in `index.ts` mette `allowClose = true` e `onlineClosed = true`, così né la chiusura della finestra né `before-quit` rimandano l'uscita mentre l'installatore NSIS è già partito.
- **«Al prossimo avvio»:** non fa nulla di più; con `autoInstallOnAppQuit` electron-updater installa all'uscita normale, che passa già dalla domanda di salvataggio e dalla conferma di interruzione del 3B.
- **Stato del PLC:** `busy()` copre `PlcWriteService.writing()` (carica nel dispositivo, comandi, ora, comando di variabili), `UploadService.active()` e `BackupService.active()`. La scansione e la diagnostica no: si chiudono con `closeOnline()`.

- [ ] **Step 1: Test** (updater finto, orologio finto)
  - `effectivePrerelease: build di prova + null → true; build stabile + null → false; build stabile + true → true; build di prova + false → false`
  - `isNewer: 0.12.1 > 0.12.0 sì; 0.12.0 = 0.12.0 no; 0.11.0 < 0.12.0 no; 'v0.13' non valido no`
  - `build di prova 0.12.0, l'updater riporta 0.11.0 → evento none, nessun available` (downgrade rifiutato)
  - `ogni controllo imposta allowDowngrade false e autoDownload false`
  - `build stabile senza la casella → allowPrerelease false; con la casella → true`
  - `prima di update:prefs nessun controllo; dopo, il primo a 10 s e il secondo 6 h dopo la fine del primo`
  - `checkOnStartup false → nessun controllo automatico; il controllo a mano funziona`
  - `errore di rete nel controllo automatico → nessun evento error; nel controllo a mano → error con il messaggio`
  - `403 di GitHub → «GitHub ha limitato le richieste: riprova più tardi»` (a mano)
  - `controllo a mano durante uno automatico → un solo checkForUpdates, esito mostrato`
  - `«Più tardi» per 0.12.1 → il controllo automatico dopo non avvisa; quello a mano sì`
  - `download: progresso e downloaded; annulla → cancelled`
  - `canInstall con una scrittura in corso → busy; con un backup in corso → busy; senza scaricamento → notReady`
  - `install: busy diventato vero fra canInstall e install → busy, nessun quitAndInstall`
  - `install: closeOnline poi prepareQuit poi quitAndInstall(false, true), in quest'ordine`
  - `install: closeOnline che non risponde → dopo 1 s si installa lo stesso`
  - `macOS: nessun downloadUpdate né quitAndInstall, autoInstallOnAppQuit false`
  - `openNotes con versione non semver → nessun openExternal`
  - `parseUpdatePrefs rifiuta campi mancanti o di tipo sbagliato`
  - `busy di registerPlc: vero durante download, uploadAll e backup del PLC di prova; falso dopo`
- [ ] **Step 2–4:** `--project @baaportal/desktop --project ui`, `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(desktop): servizio degli aggiornamenti con canale, controlli e installazione sicura`

### Task 3: macOS, scaricamento del DMG

**Files:**

- Create: `apps/desktop/src/main/update/macDownload.ts`
- Modify:
  - `updateService.ts`: su `darwin` «Scarica» usa `macDownload`;
  - `index.ts`: dipendenze vere (`net.fetch`, `app.getPath('downloads')`, `shell.openPath`, `app.runningUnderARM64Translation`).
- Test: `apps/desktop/test/update/macDownload.test.ts`

**Interfaces:**

- `macArch(processArch: string, underTranslation: boolean): 'arm64' | 'x64' | null` → `arm64` con la traduzione Rosetta attiva, altrimenti `process.arch` se è `arm64` o `x64`.
- `pickMacFile(files: { url; sha512; size? }[], version, arch) → { url; sha512; size } | string`: l'unica voce che finisce in `-<arch>.dmg` e il cui nome è un nome di file semplice (niente `/`, `\`, `..`).
- `downloadDmg(deps, file, version, onProgress, signal) → { path; reused: boolean }` con `deps = { fetch; downloadsDir; fs; sha512Of(path) }`.
- URL: `https://github.com/basoxxx/BaaPortal/releases/download/v<version>/<nome>`, costruito dal main.

Regole:

- **Controllo:** è lo stesso del Task 2 (`checkForUpdates` legge `latest-mac.yml`); `updateInfo.files` dà nomi, sha512 e dimensioni.
- **Scelta del file:** zero o più di un DMG per l'architettura → errore «Nessun installatore per questo Mac (‹arch›) nella versione X.Y.Z», niente rete.
- **Scaricamento:**
  - `net.fetch` (proxy di sistema, segue il reindirizzamento di GitHub verso il suo server dei file);
  - stato HTTP diverso da 200 → errore con il codice;
  - si scrive in `Download/BaaPortal-X.Y.Z-‹arch›.dmg.part`, a pezzi, con lo sha512 calcolato in corsa;
  - si ferma con errore se i byte superano la dimensione di `latest-mac.yml` (o 1 GB se manca);
  - alla fine: sha512 (base64) uguale → rinomina in `.dmg`; diverso → cancella il `.part` ed errore «Il file scaricato non corrisponde: non è stato aperto»;
  - errore, annullamento o chiusura dell'app → il `.part` si cancella.
- **File già presente:**
  - `BaaPortal-X.Y.Z-‹arch›.dmg` con lo sha512 giusto → si riusa senza scaricare (`reused: true`);
  - con uno sha512 diverso → non si tocca; si scrive `BaaPortal-X.Y.Z-‹arch› (1).dmg` (e così via, fino a 20).
- **Dopo:** `shell.openPath(path)`. Se fallisce, l'evento `macReady` porta comunque il percorso e l'avviso offre «Mostra nel Finder» (`shell.showItemInFolder`, sul percorso tenuto dal main).
- **Nessuna installazione:** il main non copia nulla in `/Applications` e non riavvia. L'avviso dice cosa fare (Task 4).
- **Nessuna quarantena aggiunta:** il file lo scrive l'app, quindi macOS non lo marca come scaricato da Internet. I limiti noti lo dicono (l'integrità resta lo sha512).

- [ ] **Step 1: Test** (rete e file finti, sha512 veri su byte sintetici)
  - `macArch: arm64 → arm64; x64 → x64; x64 sotto Rosetta → arm64; ia32 → null`
  - `pickMacFile: yml con arm64 e x64 → il file giusto per ciascuna`
  - `pickMacFile: solo arm64, Mac x64 → errore; due DMG x64 → errore; nome con ../ → errore`
  - `downloadDmg: byte giusti → .part rinominato in .dmg, progresso crescente fino al totale`
  - `downloadDmg: sha512 diverso → nessun .dmg, nessun .part, errore`
  - `downloadDmg: rete interrotta a metà → nessun .part, errore`
  - `downloadDmg: annullato → nessun .part, evento cancelled`
  - `downloadDmg: risposta 404 → errore con il codice, nessun file`
  - `downloadDmg: più byte della dimensione dichiarata → fermato, nessun file`
  - `downloadDmg: .dmg già presente con sha512 giusto → reused, nessuna richiesta`
  - `downloadDmg: .dmg già presente diverso → scritto « (1).dmg», l'altro intatto`
  - `servizio su darwin: Scarica → macDownload, poi openPath e macReady`
- [ ] **Step 2–4:** `--project @baaportal/desktop`.
- [ ] **Step 5: Commit** — `feat(desktop): aggiornamento su macOS con il DMG giusto, verificato e aperto`

### Task 4: Interfaccia (impostazioni, Guida, avviso, barra di stato)

**Files:**

- Create:
  - `packages/ui/src/update/updateController.ts`: stato dell'avviso in uno store piccolo (`useSyncExternalStore`, come `progress.ts`), invio delle impostazioni, azioni;
  - `packages/ui/src/update/UpdateNotice.tsx` e `update.css`: l'avviso;
- Modify:
  - `packages/ui/src/settings/settings.ts`: `updates: { checkOnStartup: boolean; prerelease: boolean | null }`, predefinito `{ true, null }`, in `normalizeSettings` e `mergeSettings`;
  - `packages/ui/src/dialogs/SettingsDialog.tsx`: sezione «Aggiornamenti»;
  - `packages/ui/src/commands/commands.ts`: `help.checkUpdates`, abilitato se `updateInfo.enabled`;
  - `packages/ui/src/project/menuModel.ts`: Guida = `['help.show', 'help.checkUpdates', 'sep', 'help.about']`;
  - `packages/ui/src/portal/selection/InstalledSoftwarePane.tsx`: pulsante «Controlla aggiornamenti» e canale della build;
  - `packages/ui/src/project/StatusBar.tsx`: avanzamento dello scaricamento;
  - `packages/ui/src/App.tsx`: `UpdateNotice` sopra entrambe le viste;
  - `packages/ui/src/services/projectService.ts`: `prepareForUpdate(): Promise<boolean>`;
  - `i18n` (`update.*`, `settings.updates.*`, `commands.help.checkUpdates`).
- Test: `packages/ui/test/updateNotice.test.tsx`, `packages/ui/test/settings.test.ts`, `packages/ui/test/settingsDialog.test.tsx`, `packages/ui/test/statusBar.test.tsx`, `packages/ui/test/commands.test.ts`, `packages/ui/test/projectService.test.ts`

Regole:

- **Impostazioni (Opzioni → Impostazioni, sezione «Aggiornamenti»):**
  - «Controlla gli aggiornamenti all'avvio» (casella, predefinita attiva). Vale per il controllo all'avvio e per quelli ogni 6 h;
  - «Ricevi anche le versioni di prova» (casella). Mostra `prerelease ?? updateInfo.prereleaseBuild`: attiva per una build di prova, spenta per una stabile. Toccarla salva un valore esplicito; «Ripristina» la riporta a `null`;
  - sotto, una riga in sola lettura: «Questa è una versione di prova» oppure «Questa è una versione stabile»;
  - con `updateInfo.enabled` falso (sviluppo) la sezione è visibile ma disattivata, con la nota «Gli aggiornamenti funzionano solo nell'app installata».
- **Invio al main:** all'avvio (dopo `rendererReady`) e a ogni cambio delle impostazioni, `updateSetPrefs(settings.updates)`. Il main non legge mai il `localStorage`.
- **Guida → «Controlla aggiornamenti…»:** il menu Guida esiste già (`help.show`, `help.about`). La voce sta fra le due, con un separatore prima di «Informazioni su BaaPortal». Nel portale, dove la barra dei menu non c'è, lo stesso comando è un pulsante in «Software installato». Il menu nativo di macOS non cambia.
- **Avviso (`UpdateNotice`):** riquadro in basso a destra, non modale, sopra portale e vista progetto, con `role="status"`. Stati:
  - **disponibile:** «È disponibile BaaPortal X.Y.Z», pulsanti «Scarica» e «Più tardi», link «Note di rilascio» (`updateOpenNotes`);
  - **in scaricamento:** barra con la percentuale e «Annulla»;
  - **scaricato (Windows):** «BaaPortal X.Y.Z è pronto», pulsanti «Riavvia e aggiorna» e «Al prossimo avvio»;
  - **pronto (macOS):** «Il file è aperto nel Finder. Chiudi BaaPortal, trascina BaaPortal nella cartella Applicazioni sostituendo quella vecchia, poi riaprilo.», pulsanti «Mostra nel Finder», «Chiudi BaaPortal» (il comando `project.exit`, con la sua domanda di salvataggio) e «OK»;
  - **nessun aggiornamento** (solo a mano): «BaaPortal X.Y.Z è aggiornato», sparisce dopo 5 s;
  - **errore:** il messaggio e «Chiudi»; un errore del controllo arriva solo se a mano (il main lo decide).
  - «Più tardi» e «Al prossimo avvio» chiudono l'avviso; il primo chiama `updateLater(version)`.
- **«Riavvia e aggiorna»:**
  1. `updateCanInstall()`: `busy` → messaggio nell'avviso «Aspetta la fine dell'operazione sul PLC (caricamento, scrittura o backup), poi riprova», e nient'altro;
  2. `projectService.prepareForUpdate()`: la stessa sequenza di `handleCloseRequest` senza `closeWindowConfirmed` (domanda delle modifiche non salvate; «Annulla» ferma tutto; poi `shutdownOnline`, `shutdownSimulation`, `beforeWindowClose`);
  3. `updateInstall()`: se torna `busy` o `notReady`, messaggio; altrimenti l'app esce.
- **Barra di stato:** durante lo scaricamento, «Download aggiornamento X.Y.Z» con la barra e «Annulla». Non usa `beginProgress` (una sola operazione alla volta), perché lo scaricamento può durare mentre l'utente carica nel PLC: è una voce a sé, a destra.
- **Ricarica del renderer:** all'avvio `updateState()` ricostruisce l'avviso (per esempio un aggiornamento già scaricato).

- [ ] **Step 1: Test** (bridge finto)
  - `settings: updates mancante o sbagliato → { checkOnStartup: true, prerelease: null }`
  - `settings: prerelease true/false/null conservato; 'sì' → null`
  - `dialogo: build di prova → casella versioni di prova attiva; build stabile → spenta; toccata e OK → valore salvato e updateSetPrefs chiamato`
  - `dialogo: Ripristina → prerelease null`
  - `dialogo: updateInfo.enabled false → caselle disattivate e nota`
  - `menu Guida: help.show, help.checkUpdates, separatore, help.about; Controlla aggiornamenti → updateCheck`
  - `avviso available: testo con la versione, Scarica → updateDownload, Più tardi → updateLater, Note di rilascio → updateOpenNotes`
  - `avviso: progress → percentuale; Annulla → updateCancelDownload`
  - `avviso downloaded: Riavvia e aggiorna con busy → messaggio, nessuna domanda di salvataggio, nessun updateInstall`
  - `avviso downloaded: con modifiche non salvate e Annulla nella domanda → nessun updateInstall`
  - `avviso downloaded: senza modifiche → offline, simulazione spenta, poi updateInstall`
  - `avviso macReady: istruzioni, Mostra nel Finder, Chiudi BaaPortal passa dalla domanda di salvataggio`
  - `avviso: none dopo il controllo a mano → «è aggiornato», sparisce dopo 5 s` (timer finto)
  - `barra di stato: durante il download la voce con la percentuale, anche con un'altra operazione in corso`
  - `portale, Software installato: pulsante Controlla aggiornamenti e «versione di prova»`
  - `en: testi dell'avviso in inglese; chiavi uguali in it ed en`
- [ ] **Step 2–4:** `--project ui --project @baaportal/desktop`, `npm run typecheck`, `npm run lint`, `npm run format:check`.
- [ ] **Step 5: Commit** — `feat(ui): avviso degli aggiornamenti, Guida → Controlla aggiornamenti e impostazioni`

### Task 5: Documenti, limiti noti, versione 0.12.0

**Files:**

- Create: `docs/uso/aggiornamenti.md`
- Modify:
  - `docs/limiti-noti.md`: sezione «Aggiornamenti (piano 3U)», prima di «Fuori dal codice, in sospeso per l'utente»;
  - il piano generale: riga 3U «Stato: fatto (v0.12.0)»;
  - `apps/desktop/package.json` 0.12.0 e `package-lock.json`.

**Guida d'uso (`docs/uso/aggiornamenti.md`)**, breve, come `online.md`:

1. Quando l'app controlla (10 s dopo l'avvio, ogni 6 ore, a mano da _Guida → Controlla aggiornamenti…_ o da _Software installato_).
2. Versioni di prova e stabili: cosa riceve una build di prova, cosa una stabile, la casella «Ricevi anche le versioni di prova». Mai versioni più vecchie.
3. Windows: Scarica, Riavvia e aggiorna o Al prossimo avvio; l'installazione non parte durante un lavoro sul PLC.
4. macOS: Scarica, il DMG nella cartella Download, chiudere l'app, trascinarla in Applicazioni sostituendo quella vecchia, riaprirla.
5. **Chi ha la 0.11.0 o una più vecchia:** deve installare la 0.12.0 a mano una volta, dalla pagina delle release. Da lì in poi gli aggiornamenti arrivano da soli.
6. Senza rete o con GitHub che non risponde, il controllo automatico tace.

**Limiti noti** (sezione «Aggiornamenti (piano 3U)»):

- le versioni fino alla 0.11.0 non si aggiornano da sole: le loro release non hanno `latest.yml` né `latest-mac.yml`. Va installata la 0.12.0 a mano una volta. Lo dicono anche le note di rilascio della 0.12.0;
- niente firma dell'editore: su Windows l'integrità è lo sha512 di `latest.yml`, preso dalla stessa release via HTTPS. Chi può modificare la release può anche modificare l'aggiornamento;
- macOS: niente aggiornamento automatico vero (niente Squirrel.Mac senza firma Developer ID). L'app scarica e verifica il DMG, ma l'utente sostituisce l'app a mano. Al primo avvio dopo la sostituzione, Gatekeeper può chiedere conferma come alla prima installazione;
- con le versioni di prova attive electron-updater prende la release **più recente** del feed di GitHub, non la più alta in assoluto. Il controllo semver evita sempre i ritorni indietro, ma se si pubblicasse una versione più bassa dopo una più alta, chi ha la più alta non la vede (giusto) e chi ha una più vecchia riceve quella più recente. Regola di rilascio: pubblicare le versioni in ordine crescente;
- Windows, installazione «per tutti gli utenti»: l'aggiornamento chiede i permessi di amministratore (UAC);
- GitHub limita le richieste senza account: dietro un indirizzo condiviso (rete aziendale) un controllo può fallire; quello automatico tace e riprova dopo 6 ore;
- un proxy che richiede l'autenticazione non è gestito;
- mai provato su una release vera fino alla prima release dopo la 0.12.0 (0.12.1 o 0.13.0): la prova va fatta su Windows e su un Mac per architettura;
- niente e2e contro GitHub: le regole sono provate con un updater finto.

**Note di rilascio della 0.12.0** (da scrivere nella release, non nel repo): la frase sulla 0.11.0 e precedenti, più «Da questa versione BaaPortal si aggiorna da sé».

**Collaudo:** `S7_CAPTURES_DIR=… npm test && npm run e2e && npm run typecheck && npm run lint && npm run format:check`, poi `npm run dist && node apps/desktop/scripts/check-dist.mjs` su macOS (e in CI su Windows).

- [ ] **Step 1–3:** documenti, versione, collaudo.
- [ ] **Step 4: Commit** — `docs: piano 3U — aggiornamenti automatici, versione 0.12.0`

---

## Decisioni prese in questo piano (Rulings)

- **R1. Libreria:** `electron-updater` con il provider GitHub (owner `basoxxx`, repo `BaaPortal`), su HTTPS, come vera dipendenza di `apps/desktop` (le altre restano devDependencies impacchettate da electron-vite). La presenza nell'app impacchettata la controlla `check-dist.mjs` in CI e nella release.
- **R2. Canale:** una build fatta da una pre-release di GitHub è «di prova» e guarda prove e stabili (`allowPrerelease = true`); una build da una release stabile guarda solo le stabili. Il flag entra nella build: `release.yml` passa `github.event.release.prerelease` (o `gh release view` a mano) in `BAAPORTAL_PRERELEASE`, electron-vite `define` lo trasforma in costante. Build locali e di sviluppo contano come prova. In Impostazioni «Ricevi anche le versioni di prova», attiva per le build di prova, spenta per le stabili, modificabile. Mai all'indietro (`allowDowngrade` false più il confronto semver).
- **R3. Quando:** circa 10 s dopo l'avvio, poi ogni 6 h, solo con l'app installata; a mano da «Guida → Controlla aggiornamenti…» (il menu Guida esiste già). Impostazione «Controlla gli aggiornamenti all'avvio», attiva. Mai con `!app.isPackaged` né nelle e2e. Errori silenziosi nei controlli automatici, mostrati in quelli a mano.
- **R4. Windows (NSIS, senza firma), aggiornamento vero:** avviso con «Scarica» e «Più tardi» e il link alle note; avanzamento nella barra di stato; poi «Riavvia e aggiorna» o «Al prossimo avvio» (`autoInstallOnAppQuit`). Mai riavvio da solo. Prima di installare: rifiuto durante scritture, caricamenti e backup; domanda delle modifiche non salvate; offline pulito. Integrità con lo sha512 di `latest.yml`; niente firma, nei limiti noti.
- **R5. macOS (firma ad-hoc, niente Squirrel):** niente `quitAndInstall`. Stesso controllo con `latest-mac.yml`, poi «Scarica» del DMG dell'architettura del Mac nella cartella Download con avanzamento, verifica dello sha512, `shell.openPath` e le istruzioni per trascinare BaaPortal in Applicazioni e riaprirlo. Limite documentato.
- **R6. Pipeline:** electron-builder produce `latest.yml`, `latest-mac.yml` e i `.blockmap` (`publish: github`, `--publish never`); `release.yml` carica `*.exe`, `*.dmg`, `latest*.yml`, `*.blockmap` dopo `check-dist.mjs`. Le due architetture Mac stanno in un solo `latest-mac.yml`, costruite nello stesso job; lo script lo pretende e, se serve, li unisce. Le release fino alla 0.11.0 non hanno i file: chi le usa installa la 0.12.0 a mano una volta (limiti noti e note di rilascio).
- **R7. Test:** regole del main con un updater finto (canale, ritorno indietro, PLC occupato e modifiche non salvate, architettura Mac e sha512, errori silenziosi o mostrati, impostazioni); avviso e impostazioni nel progetto ui; controllo della configurazione di rilascio con test e con lo script in CI. Nessuna e2e contro GitHub.
- **R8. Versione 0.12.0** e documenti: `docs/uso/aggiornamenti.md`, sezione «Aggiornamenti (piano 3U)» nei limiti noti, riga 3U nel piano generale prima della 3D.

Decisioni prese da me durante la stesura (modificabili):

- **R9. Le impostazioni restano nel renderer** (`localStorage`, come tutte le altre) e il renderer le manda al main a ogni avvio e a ogni cambio. Il primo controllo automatico aspetta il primo invio, così non parte mai contro la scelta dell'utente. _Se fosse sbagliato:_ un file `update.json` in `userData` letto dal main.
- **R10. `prerelease: boolean | null`:** `null` vuol dire «come la build», così una build stabile installata sopra una di prova torna da sola al canale stabile, salvo scelta esplicita dell'utente.
- **R11. La voce di menu sta in Guida**, fra «Visualizza la guida» e «Informazioni su BaaPortal». Nel portale, che non ha la barra dei menu, è un pulsante in «Software installato». Il menu nativo di macOS non cambia.
- **R12. L'avviso è un riquadro non modale in basso a destra**, presente in entrambe le viste, perché la barra di stato c'è solo nella vista progetto. La barra di stato mostra in più l'avanzamento, come voce separata da `beginProgress`, perché uno scaricamento non deve bloccare le operazioni sul PLC.
- **R13. «Più tardi» vale fino al prossimo avvio** e solo per quella versione: i controlli ogni 6 h non ripropongono la stessa, quelli a mano sì, e una versione più nuova sì.
- **R14. Anche il backup e il caricamento dal dispositivo bloccano l'installazione** (`busy()`), non solo le scritture: l'uscita li interromperebbe a metà. La scansione e la diagnostica no: si chiudono con l'offline.
- **R15. electron-updater si carica solo nell'app installata** (`import()` dinamico dentro il servizio). Sviluppo, test ed e2e non lo caricano mai e non toccano la rete.
- **R16. «Più recente» invece di «più alta»:** con le versioni di prova attive electron-updater prende l'ultima release pubblicata nel feed di GitHub. Il controllo semver impedisce i ritorni indietro; la regola di pubblicare in ordine crescente (già seguita) fa coincidere le due cose. _Se fosse sbagliato:_ si risolve noi la release più alta con l'API di GitHub (`/releases`, 60 richieste l'ora senza account) e si passa a electron-updater il provider `generic` sulla cartella di quella release.
- **R17. Su macOS si riusa il controllo di electron-updater** (`MacUpdater.checkForUpdates` con `autoDownload` falso, che non tocca Squirrel), così le regole del canale sono le stesse delle due piattaforme. Lo scaricamento è nostro, con `net.fetch` (proxy di sistema).
- **R18. Il DMG si scrive in Download** con il nome della release; uno già presente e verificato si riusa, uno diverso non si sovrascrive mai.
