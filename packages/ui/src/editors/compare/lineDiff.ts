/**
 * Chiave di confronto di una riga AWL. Nel codice (fuori da `'...'`, `"..."` e dai commenti `//`)
 * spazi, maiuscole e il «%» davanti a un indirizzo assoluto (`%MW10` e `MW10`) non contano, e un solo «;» finale nemmeno (il testo decodificato lo aggiunge);
 * i testi tra apici e i commenti si confrontano esattamente.
 */
export function normLine(line: string): string {
  const parts: { code: boolean; text: string }[] = [];
  let code = '';
  const flush = () => {
    if (code) parts.push({ code: true, text: code });
    code = '';
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      const stop = end < 0 ? line.length : end + 1;
      flush();
      parts.push({ code: false, text: line.slice(i, stop) });
      i = stop;
    } else if (c === '/' && line[i + 1] === '/') {
      flush();
      parts.push({ code: false, text: line.slice(i).replace(/\s+$/, '') });
      i = line.length;
    } else {
      code += c;
      i++;
    }
  }
  flush();
  // Un solo «;» finale del codice (prima di un eventuale commento) e gli spazi di coda.
  let last = -1;
  for (let k = parts.length - 1; k >= 0; k--) {
    if (parts[k]!.code) {
      last = k;
      break;
    }
  }
  const lastIsTail = last === parts.length - 1 || parts[last + 1]!.text.startsWith('//');
  return parts
    .map((p, k) => {
      if (!p.code) return p.text;
      let t = p.text
        .replace(/%(?=[A-Z]{1,3}\d)/gi, '')
        .replace(/\s+/g, ' ')
        .toUpperCase();
      if (k === last && lastIsTail) t = t.replace(/\s+$/, '').replace(/;$/, '');
      if (k === last) t = t.replace(/\s+$/, '');
      return t;
    })
    .join('')
    .trim();
}

/** Oltre questo numero di celle (dopo aver tolto prefisso e suffisso comuni) il confronto è per posizione. */
export const MAX_LCS_CELLS = 4_000_000;

/** Una riga del confronto affiancato: `left` è il progetto, `right` la CPU. */
export interface DiffRow {
  kind: 'same' | 'changed' | 'missing' | 'added';
  left?: string;
  right?: string;
}

/**
 * Differenze riga per riga (sottosequenza comune più lunga, senza dipendenze), dopo aver tolto
 * prefisso e suffisso comuni. Una serie di righe tolte seguita da una di righe aggiunte si
 * affianca come «diverse»; il resto è «solo progetto» (`missing`) o «solo CPU» (`added`). Se la
 * parte rimasta è troppo grande, le righe si confrontano per posizione (`approximate`).
 */
export function lineDiffEx(a: string[], b: string[]): { rows: DiffRow[]; approximate: boolean } {
  const ka = a.map(normLine);
  const kb = b.map(normLine);
  let lo = 0;
  while (lo < a.length && lo < b.length && ka[lo] === kb[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && ka[ea - 1] === kb[eb - 1]) {
    ea--;
    eb--;
  }
  const rows: DiffRow[] = [];
  const same = (i: number, j: number) => rows.push({ kind: 'same', left: a[i]!, right: b[j]! });
  for (let i = 0; i < lo; i++) same(i, i);
  const n = ea - lo;
  const m = eb - lo;
  let approximate = false;
  let del: string[] = [];
  let add: string[] = [];
  const flush = () => {
    const k = Math.min(del.length, add.length);
    for (let x = 0; x < k; x++) rows.push({ kind: 'changed', left: del[x]!, right: add[x]! });
    for (let x = k; x < del.length; x++) rows.push({ kind: 'missing', left: del[x]! });
    for (let x = k; x < add.length; x++) rows.push({ kind: 'added', right: add[x]! });
    del = [];
    add = [];
  };
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    approximate = true;
    for (let x = 0; x < Math.max(n, m); x++) {
      const i = lo + x;
      if (x < n && x < m) {
        if (ka[i] === kb[i]) {
          flush();
          same(i, i);
        } else {
          del.push(a[i]!);
          add.push(b[i]!);
        }
      } else if (x < n) del.push(a[i]!);
      else add.push(b[i]!);
    }
    flush();
  } else {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          ka[lo + i] === kb[lo + j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ka[lo + i] === kb[lo + j]) {
        flush();
        same(lo + i, lo + j);
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
        del.push(a[lo + i++]!);
      } else {
        add.push(b[lo + j++]!);
      }
    }
    flush();
  }
  for (let k = 0; k < a.length - ea; k++) same(ea + k, eb + k);
  return { rows, approximate };
}

export const lineDiff = (a: string[], b: string[]): DiffRow[] => lineDiffEx(a, b).rows;

export interface NetworkText {
  title: string;
  /** Commento della rete; assente dove non si conosce (il compilato della CPU non lo contiene). */
  comment?: string;
  lines: string[];
}

/** Una differenza di titolo o di commento: si mostra, ma non entra nel verdetto del checksum. */
export interface TextDiff {
  left: string;
  right: string;
}

export interface NetworkDiff {
  /** Posizione nell'elenco allineato. */
  index: number;
  /** Numero (da 1) della rete in ciascun lato; assente se la rete manca da quel lato. */
  leftNo?: number;
  rightNo?: number;
  /** Titolo di ciascun lato; assente se la rete manca da quel lato. */
  leftTitle?: string;
  rightTitle?: string;
  rows: DiffRow[];
  /** Il blocco è troppo grande per l'allineamento fine: righe confrontate per posizione. */
  approximate: boolean;
  /** `both`: la rete c'è da entrambi i lati; altrimenti il lato che ce l'ha. */
  presence: 'both' | 'left' | 'right';
  different: boolean;
  titleDiff?: TextDiff;
  commentDiff?: TextDiff;
}

/** Chiave di una rete: le sue righe normalizzate, senza righe vuote. */
const networkKey = (n: NetworkText): string =>
  n.lines
    .map(normLine)
    .filter((l) => l !== '')
    .join('\n');

/**
 * Allinea le reti con la sottosequenza comune più lunga sul contenuto. Tra due reti uguali, le
 * tolte e le aggiunte si affiancano due a due (rete modificata) e il resto è «solo progetto» o
 * «solo CPU». Troppe reti: per posizione.
 */
function alignNetworks(a: string[], b: string[]): [number | null, number | null][] {
  const n = a.length;
  const m = b.length;
  const out: [number | null, number | null][] = [];
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (let x = 0; x < Math.max(n, m); x++) out.push([x < n ? x : null, x < m ? x : null]);
    return out;
  }
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  let del: number[] = [];
  let add: number[] = [];
  const flush = () => {
    const k = Math.max(del.length, add.length);
    for (let x = 0; x < k; x++) out.push([del[x] ?? null, add[x] ?? null]);
    del = [];
    add = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      out.push([i++, j++]);
    } else if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) del.push(i++);
    else add.push(j++);
  }
  flush();
  return out;
}

/** Titolo o commento diversi: solo se entrambi i lati li hanno (la CPU non conserva né l'uno né l'altro). */
const textDiff = (l: string | undefined, r: string | undefined): TextDiff | undefined =>
  l && r && l !== r ? { left: l, right: r } : undefined;

/**
 * Reti allineate per contenuto (LCS): quelle inserite o tolte sono «solo progetto» o «solo CPU»,
 * quelle modificate si affiancano con le righe diverse. Titoli e commenti sono differenze a parte.
 */
export function diffNetworks(left: NetworkText[], right: NetworkText[]): NetworkDiff[] {
  const pairs = alignNetworks(left.map(networkKey), right.map(networkKey));
  return pairs.map(([i, j], index) => {
    const l = i === null ? undefined : left[i];
    const r = j === null ? undefined : right[j];
    const { rows, approximate } = lineDiffEx(l?.lines ?? [], r?.lines ?? []);
    const titleDiff = l && r ? textDiff(l.title, r.title) : undefined;
    const commentDiff = l && r ? textDiff(l.comment, r.comment) : undefined;
    return {
      index,
      ...(i !== null ? { leftNo: i + 1, leftTitle: l!.title } : {}),
      ...(j !== null ? { rightNo: j + 1, rightTitle: r!.title } : {}),
      rows,
      approximate,
      presence: l && r ? 'both' : l ? 'left' : 'right',
      different: !l || !r || rows.some((x) => x.kind !== 'same') || !!titleDiff || !!commentDiff,
      ...(titleDiff ? { titleDiff } : {}),
      ...(commentDiff ? { commentDiff } : {}),
    };
  });
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
