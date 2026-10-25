import semver from 'semver';
import type { UpdatePrefs } from '../../shared/updateTypes';

/** La casella impostata vince; senza (`null`) si segue il canale della build. */
export function effectivePrerelease(build: boolean, pref: boolean | null): boolean {
  return pref ?? build;
}

/** Solo versioni semver valide e strettamente più nuove: mai un downgrade. */
export function isNewer(remote: string, current: string): boolean {
  return (
    semver.valid(remote) !== null && semver.valid(current) !== null && semver.gt(remote, current)
  );
}

export function parseUpdatePrefs(raw: unknown): UpdatePrefs | string {
  if (typeof raw !== 'object' || raw === null) return 'Impostazioni non valide';
  const r = raw as Record<string, unknown>;
  if (typeof r['checkOnStartup'] !== 'boolean')
    return "Impostazione «controlla all'avvio» non valida";
  const p = r['prerelease'];
  if (p !== null && typeof p !== 'boolean') return 'Impostazione «versioni di prova» non valida';
  return { checkOnStartup: r['checkOnStartup'], prerelease: p };
}

/** L'esito «nessun aggiornamento» e gli errori di controllo si mostrano solo a chi ha chiesto. */
export function shouldReport(_kind: 'none' | 'error', manual: boolean): boolean {
  return manual;
}

const RATE_LIMIT = 'GitHub ha limitato le richieste: riprova più tardi';
const NO_FILE = 'La release non ha il file di aggiornamento';

/** Messaggi italiani brevi per gli errori di electron-updater e della rete. */
export function errorText(err: unknown): string {
  const o = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const status = typeof o['statusCode'] === 'number' ? o['statusCode'] : 0;
  const code = typeof o['code'] === 'string' ? o['code'] : '';
  if (status === 403 || status === 429 || /\b(403|429)\b|rate limit/i.test(msg)) return RATE_LIMIT;
  if (status === 404 || /\b404\b|cannot find .*\.yml/i.test(msg)) return NO_FILE;
  if (/sha512|checksum/i.test(msg))
    return 'Il file scaricato non è integro (verifica non riuscita)';
  if (
    ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(
      code,
    ) ||
    /ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ETIMEDOUT|ECONN/i.test(
      msg,
    )
  ) {
    return 'Nessuna connessione di rete';
  }
  return msg ? `Errore: ${msg}` : 'Errore sconosciuto';
}
