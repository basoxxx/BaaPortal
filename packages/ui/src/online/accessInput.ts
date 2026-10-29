import type { PlcAccess } from '@baaportal/project';

const OCTET = /^(0|[1-9]\d{0,2})$/;

/** Esito della lettura di un indirizzo scritto a mano: `error` è una chiave i18n. */
export type AccessInput = { host: string; port?: number } | { error: string };

/**
 * Legge un indirizzo manuale: solo IPv4, con porta facoltativa (`192.0.2.10`, `127.0.0.1:10102`).
 * Rifiuta ottetti oltre 255, spazi interni e nomi host.
 */
export function parseAccessInput(text: string): AccessInput {
  const s = text.trim();
  if (s === '') return { error: 'accessDevices.errEmpty' };
  if (/\s/.test(s)) return { error: 'accessDevices.errSpaces' };
  const [hostPart, portPart, ...extra] = s.split(':');
  if (extra.length > 0 || hostPart === undefined) return { error: 'accessDevices.errFormat' };
  const octets = hostPart.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d+$/.test(o))) {
    return { error: 'accessDevices.errNotIpv4' };
  }
  if (octets.some((o) => o.length > 1 && o.startsWith('0'))) {
    return { error: 'accessDevices.errLeadingZero' };
  }
  if (!octets.every((o) => OCTET.test(o) && Number(o) <= 255)) {
    return { error: 'accessDevices.errOctet' };
  }
  if (portPart === undefined) return { host: hostPart };
  if (!/^\d{1,5}$/.test(portPart) || Number(portPart) < 1 || Number(portPart) > 65535) {
    return { error: 'accessDevices.errPort' };
  }
  return { host: hostPart, port: Number(portPart) };
}

/** TSAP remoto in esadecimale a due byte (`03.02` → 0x0302); `null` se il formato non è valido. */
export function parseTsap(text: string): number | null {
  const m = /^([0-9a-fA-F]{2})\.([0-9a-fA-F]{2})$/.exec(text.trim());
  return m ? (parseInt(m[1]!, 16) << 8) | parseInt(m[2]!, 16) : null;
}

/** Dove sta la CPU, nei messaggi: l'host, oppure porta seriale e indirizzo MPI. */
export function accessWhere(a: PlcAccess): string {
  return a.link?.kind === 'mpi' ? `${a.link.port}, MPI ${a.link.cpuAddress}` : a.host;
}
