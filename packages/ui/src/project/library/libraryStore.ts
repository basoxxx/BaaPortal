import { createStore, useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import {
  emptyLibrary,
  iecStandardLibrary,
  LibraryFileError,
  readBaaplib,
  uniqueName,
  writeBaaplib,
  type Library,
  type LibraryItem,
} from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import type { BaaBridge } from '../../bridge';
import { t } from '../../i18n';
import type { AppState } from '../../state/store';

/** Una libreria mostrata nel pannello: quella del progetto, una globale aperta o la standard IEC. */
export interface LibraryView {
  key: string;
  title: string;
  library: Readonly<Library>;
  editable: boolean;
}

export interface GlobalLibrary {
  key: string;
  path: string;
  library: Library;
  /** Aperta per la modifica: altrimenti è in sola lettura. */
  editing: boolean;
  dirty: boolean;
}

interface LibraryState {
  globals: GlobalLibrary[];
}

const libStore = createStore<LibraryState>(() => ({ globals: [] }));
let counter = 0;

export const IEC_KEY = 'iec';
export const PROJECT_KEY = 'project';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
let iec: Library | null = null;
export const iecLibrary = (): Library => (iec ??= deepFreeze(iecStandardLibrary()));

export const useGlobalLibraries = (): GlobalLibrary[] => useStore(libStore, (s) => s.globals);

/** Solo per i test: chiude tutte le librerie globali. */
export function resetLibraries(): void {
  libStore.setState({ globals: [] });
}

const baseName = (path: string) =>
  path
    .split(/[\\/]/)
    .pop()!
    .replace(/\.baaplib$/i, '');
export const globalTitle = (g: GlobalLibrary) => baseName(g.path);

const FILTER = () => [{ name: t('library.fileFilter'), extensions: ['baaplib'] }];

function patchGlobal(key: string, patch: (g: GlobalLibrary) => Partial<GlobalLibrary>): void {
  libStore.setState((s) => ({
    globals: s.globals.map((g) => (g.key === key ? { ...g, ...patch(g) } : g)),
  }));
}

function fileErrorText(e: unknown): string {
  return e instanceof LibraryFileError ? t(`library.fileError.${e.code}`) : String(e);
}

/** «Apri libreria globale»: la libreria si apre in sola lettura; lo stesso file non si apre due volte. */
export async function openGlobalLibrary(bridge: BaaBridge, path?: string): Promise<void> {
  const chosen = path ?? (await bridge.showOpenFileDialog({ filters: FILTER() }))[0];
  if (!chosen || libStore.getState().globals.some((g) => g.path === chosen)) return;
  let library: Library;
  try {
    library = readBaaplib(await bridge.readFile(chosen));
  } catch (e) {
    await bridge.showError(
      t('errors.title'),
      t('library.openFailed', { detail: fileErrorText(e) }),
    );
    return;
  }
  if (libStore.getState().globals.some((g) => g.path === chosen)) return;
  const g: GlobalLibrary = {
    key: `lib${++counter}`,
    path: chosen,
    library,
    editing: false,
    dirty: false,
  };
  libStore.setState((s) => ({ globals: [...s.globals, g] }));
}

/** «Nuova libreria globale»: si sceglie il file, si scrive vuota e si apre per la modifica. */
export async function newGlobalLibrary(bridge: BaaBridge): Promise<void> {
  const path = await bridge.showSaveFileDialog({
    defaultName: `${t('library.defaultName')}.baaplib`,
    filters: FILTER(),
  });
  if (!path) return;
  const library = emptyLibrary();
  try {
    await bridge.writeFileAtomic(
      path,
      writeBaaplib(library, { appVersion: await bridge.appVersion() }),
    );
  } catch (e) {
    await bridge.showError(t('errors.title'), t('library.saveFailed', { detail: String(e) }));
    return;
  }
  libStore.setState((s) => ({
    globals: [
      ...s.globals.filter((g) => g.path !== path),
      { key: `lib${++counter}`, path, library, editing: true, dirty: false },
    ],
  }));
}

export async function saveGlobalLibrary(bridge: BaaBridge, key: string): Promise<boolean> {
  const g = libStore.getState().globals.find((x) => x.key === key);
  if (!g) return false;
  try {
    await bridge.writeFileAtomic(
      g.path,
      writeBaaplib(g.library, { appVersion: await bridge.appVersion() }),
    );
  } catch (e) {
    await bridge.showError(t('errors.title'), t('library.saveFailed', { detail: String(e) }));
    return false;
  }
  // Le modifiche fatte mentre si scriveva restano da salvare.
  patchGlobal(key, (x) => ({ dirty: x.library !== g.library }));
  return true;
}

export const setGlobalEditing = (key: string, editing: boolean) =>
  patchGlobal(key, () => ({ editing }));

/** Chiude la libreria; con modifiche non salvate chiede prima. */
export async function closeGlobalLibrary(bridge: BaaBridge, key: string): Promise<void> {
  const g = libStore.getState().globals.find((x) => x.key === key);
  if (!g) return;
  if (g.dirty) {
    const yes = await bridge.askQuestion({
      title: t('library.closeTitle'),
      message: t('library.closeUnsaved', { name: globalTitle(g) }),
      yes: t('objects.yes'),
      no: t('objects.no'),
      defaultNo: true,
    });
    if (!yes) return;
  }
  libStore.setState((s) => ({ globals: s.globals.filter((x) => x.key !== key) }));
}

/**
 * Modifica una libreria: quella del progetto passa per `edit` (annulla e salvataggio del progetto),
 * una globale aperta per la modifica cambia in memoria e resta da salvare. Le altre non cambiano.
 */
export function mutateLibrary(
  store: StoreApi<AppState>,
  key: string,
  labelKey: string,
  recipe: (lib: Library) => void,
): void {
  if (key === PROJECT_KEY) {
    store.getState().edit(labelKey, (p) => {
      p.library ??= emptyLibrary();
      recipe(p.library);
    });
    return;
  }
  const g = libStore.getState().globals.find((x) => x.key === key);
  if (!g?.editing) return;
  const library = structuredClone(g.library);
  recipe(library);
  patchGlobal(key, () => ({ library, dirty: true }));
}

// ---- operazioni sulla libreria (dentro `mutateLibrary`) ---------------------------------------

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const lastOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const inside = (group: string, path: string) => group === path || group.startsWith(`${path}/`);

/** Tutte le cartelle, compresi gli antenati e quelle dei modelli. */
export function folderPaths(lib: Readonly<Library>): Set<string> {
  const out = new Set<string>();
  for (const path of [...lib.groups, ...lib.items.map((i) => i.group)]) {
    for (let p = path; p !== ''; p = parentOf(p)) out.add(p);
  }
  return out;
}

export function addFolder(lib: Library, parent: string): string {
  const siblings = [...folderPaths(lib)].filter((g) => parentOf(g) === parent).map(lastOf);
  const name = uniqueName(t('library.newFolder'), siblings);
  const path = parent === '' ? name : `${parent}/${name}`;
  lib.groups.push(path);
  return path;
}

export function checkFolderName(lib: Readonly<Library>, path: string, name: string) {
  if (name.trim() === '' || name.includes('/')) return 'INVALID' as const;
  const siblings = [...folderPaths(lib)].filter(
    (g) => g !== path && parentOf(g) === parentOf(path),
  );
  return siblings.some((g) => sameName(lastOf(g), name)) ? ('DUPLICATE' as const) : null;
}

export function renameFolder(lib: Library, path: string, name: string): void {
  const renamed = parentOf(path) === '' ? name : `${parentOf(path)}/${name}`;
  const rebase = (g: string) => (inside(g, path) ? renamed + g.slice(path.length) : g);
  lib.groups = lib.groups.map(rebase);
  for (const i of lib.items) i.group = rebase(i.group);
}

export function checkItemName(lib: Readonly<Library>, id: string, name: string) {
  if (name.trim() === '') return 'INVALID' as const;
  const self = lib.items.find((i) => i.id === id);
  return lib.items.some((i) => i.id !== id && i.group === self?.group && sameName(i.name, name))
    ? ('DUPLICATE' as const)
    : null;
}

export function renameItem(lib: Library, id: string, name: string): void {
  const item = lib.items.find((i) => i.id === id);
  if (item) item.name = name;
}

export function deleteEntries(lib: Library, itemIds: string[], folders: string[]): void {
  const gone = (g: string) => folders.some((f) => inside(g, f));
  lib.groups = lib.groups.filter((g) => !gone(g));
  lib.items = lib.items.filter((i) => !itemIds.includes(i.id) && !gone(i.group));
}

export function moveItems(lib: Library, itemIds: string[], folder: string): void {
  for (const i of lib.items) if (itemIds.includes(i.id)) i.group = folder;
}

/** Aggiunge il modello con un nome unico nella sua cartella. */
export function addItem(lib: Library, item: LibraryItem): void {
  const siblings = lib.items.filter((i) => i.group === item.group).map((i) => i.name);
  lib.items.push({ ...item, name: uniqueName(item.name, siblings) });
}
