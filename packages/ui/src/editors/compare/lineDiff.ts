/** Chiave di confronto: spazi, «;» finale e maiuscole non contano (il testo decodificato li normalizza). */
const normLine = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*$/, '')
    .trim()
    .toUpperCase();

/** Una riga del confronto affiancato: `left` è il progetto, `right` la CPU. */
export interface DiffRow {
  kind: 'same' | 'changed' | 'missing' | 'added';
  left?: string;
  right?: string;
}

/**
 * Differenze riga per riga (sottosequenza comune più lunga, senza dipendenze). Una serie di righe
 * tolte seguita da una di righe aggiunte si affianca come «diverse»; il resto è «solo progetto»
 * (`missing`) o «solo CPU» (`added`).
 */
export function lineDiff(a: string[], b: string[]): DiffRow[] {
  const ka = a.map(normLine);
  const kb = b.map(normLine);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        ka[i] === kb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffRow[] = [];
  let del: string[] = [];
  let add: string[] = [];
  const flush = () => {
    const k = Math.min(del.length, add.length);
    for (let x = 0; x < k; x++) out.push({ kind: 'changed', left: del[x]!, right: add[x]! });
    for (let x = k; x < del.length; x++) out.push({ kind: 'missing', left: del[x]! });
    for (let x = k; x < add.length; x++) out.push({ kind: 'added', right: add[x]! });
    del = [];
    add = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) {
      flush();
      out.push({ kind: 'same', left: a[i]!, right: b[j]! });
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      del.push(a[i++]!);
    } else {
      add.push(b[j++]!);
    }
  }
  flush();
  return out;
}

export interface NetworkText {
  title: string;
  lines: string[];
}

export interface NetworkDiff {
  index: number;
  /** Titolo di ciascun lato; assente se la rete manca da quel lato. */
  leftTitle?: string;
  rightTitle?: string;
  rows: DiffRow[];
  /** `both`: la rete c'è da entrambi i lati; altrimenti il lato che ce l'ha. */
  presence: 'both' | 'left' | 'right';
  different: boolean;
}

/** Reti allineate per posizione: quelle in più su un lato sono tutte «solo progetto» o «solo CPU». */
export function diffNetworks(left: NetworkText[], right: NetworkText[]): NetworkDiff[] {
  const out: NetworkDiff[] = [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) {
    const l = left[index];
    const r = right[index];
    const rows = lineDiff(l?.lines ?? [], r?.lines ?? []);
    out.push({
      index,
      ...(l ? { leftTitle: l.title } : {}),
      ...(r ? { rightTitle: r.title } : {}),
      rows,
      presence: l && r ? 'both' : l ? 'left' : 'right',
      different: !l || !r || rows.some((x) => x.kind !== 'same'),
    });
  }
  return out;
}

/** Dump esadecimale: 16 byte per riga, con l'offset. */
export function hexDump(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const chunk = [...bytes.subarray(o, o + 16)].map((b) => b.toString(16).padStart(2, '0'));
    lines.push(`${o.toString(16).padStart(6, '0')}  ${chunk.join(' ')}`);
  }
  return lines;
}
