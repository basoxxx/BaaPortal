// Canale di build: solo la stringa esatta 'false' (release stabile) toglie il flag di prova.
export function prereleaseBuild(v: string | undefined): boolean {
  return v !== 'false';
}
