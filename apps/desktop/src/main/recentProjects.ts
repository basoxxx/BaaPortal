export interface StoredRecent {
  path: string;
  name: string;
  lastOpened: string;
}

export type Platform = 'win32' | 'darwin' | 'linux';

export const MAX_RECENT = 10;

export function samePath(a: string, b: string, platform: Platform): boolean {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

export function removeRecent(
  list: StoredRecent[],
  path: string,
  platform: Platform,
): StoredRecent[] {
  return list.filter((e) => !samePath(e.path, path, platform));
}

export function addRecent(
  list: StoredRecent[],
  path: string,
  name: string,
  now: Date,
  platform: Platform,
): StoredRecent[] {
  const entry: StoredRecent = { path, name, lastOpened: now.toISOString() };
  return [entry, ...removeRecent(list, path, platform)].slice(0, MAX_RECENT);
}
