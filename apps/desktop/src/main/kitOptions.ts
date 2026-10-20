import type { KitStartOptions } from '@baaportal/ui';

// Gli argomenti arrivano dal renderer via IPC: stesse regole della finestra, ricontrollate qui.
function validHost(host: unknown): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return false;
  if (host.startsWith('.') || host.startsWith('-') || host.endsWith('.') || host.includes('..'))
    return false;
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }
  return true;
}

function intIn(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`${name} non valido: deve essere un intero tra ${min} e ${max}`);
  return v;
}

export function parseKitOptions(v: unknown): KitStartOptions {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new RangeError('Opzioni della raccolta non valide');
  const o = v as Record<string, unknown>;
  if (!validHost(o['host']))
    throw new RangeError('Indirizzo non valido: serve un IPv4 oppure un nome host');
  const port = intIn(o['port'], 1, 65535, 'Porta');
  const rack = intIn(o['rack'], 0, 7, 'Rack');
  const slot = intIn(o['slot'], 0, 31, 'Slot');
  const ct = o['connectionType'];
  if (ct !== 'pg' && ct !== 'op' && ct !== 'basic')
    throw new RangeError('Tipo di connessione non valido');
  if (typeof o['includeBlocks'] !== 'boolean')
    throw new RangeError('includeBlocks deve essere vero o falso');
  return {
    host: o['host'],
    port,
    rack,
    slot,
    connectionType: ct,
    includeBlocks: o['includeBlocks'],
  };
}

/** `raccolta-<numero di articolo o 'cpu'>-<AAAAMMGG-HHMM>.zip`, con i caratteri non adatti a un nome file ripuliti. */
export function kitFileName(orderNumber: string | undefined, when: Date): string {
  const clean = (orderNumber ?? '')
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
  return `raccolta-${clean || 'cpu'}-${stamp}.zip`;
}
