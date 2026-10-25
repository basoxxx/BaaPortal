import { networkInterfaces } from 'node:os';
import type { NetInterface } from '@baaportal/ui';

type NetworkInterfacesFn = () => ReturnType<typeof networkInterfaces>;

/** Le interfacce IPv4 non interne del PC (niente IPv6, niente loopback). Iniettabile nei test. */
export function listInterfaces(source: NetworkInterfacesFn = networkInterfaces): NetInterface[] {
  const out: NetInterface[] = [];
  for (const [name, list] of Object.entries(source())) {
    for (const a of list ?? []) {
      // `family` è una stringa nelle versioni recenti di Node, un numero in alcune precedenti.
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function toNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function toIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Gli host della sottorete, senza indirizzo di rete, broadcast e indirizzo locale, in ordine
 * crescente. Se sono più di `max` si prendono i `max` più vicini all'indirizzo locale. Indirizzo o
 * maschera non validi (anche maschera non contigua), /31 e /32 danno una lista vuota.
 */
export function hostsToScan(address: string, netmask: string, max = 1024): string[] {
  const local = toNumber(address);
  const mask = toNumber(netmask);
  if (local === null || mask === null || max <= 0) return [];
  const inverse = (~mask >>> 0) >>> 0;
  if (((inverse + 1) & inverse) !== 0 && inverse !== 0xffffffff) return []; // maschera non contigua
  const network = (local & mask) >>> 0;
  const broadcast = (network | inverse) >>> 0;
  const lo = network + 1;
  const hi = broadcast - 1;
  if (hi < lo) return []; // /31 e /32
  const found: number[] = [];
  // Si esce dall'indirizzo locale verso i due lati, alternando, finché ce ne sono o si arriva a max.
  for (let d = 1; found.length < max; d++) {
    const below = local - d;
    const above = local + d;
    const hasBelow = below >= lo;
    const hasAbove = above <= hi;
    if (!hasBelow && !hasAbove) break;
    if (hasBelow) found.push(below);
    if (hasAbove && found.length < max) found.push(above);
  }
  return found.sort((a, b) => a - b).map(toIp);
}
