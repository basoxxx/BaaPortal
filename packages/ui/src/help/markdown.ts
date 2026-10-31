// Markdown della guida → albero di nodi (mai HTML). Il sottoinsieme dei file di docs/uso:
// titoli, paragrafi, elenchi (anche annidati), codice, tabelle, grassetto, corsivo, codice in riga e
// collegamenti. L'albero lo disegna React con testi semplici: un `<script>` nel markdown resta testo.
// Citazioni (`>`) e immagini (`![alt](file)`) ci sono; HTML e note no.
// shortcut: niente HTML né note; se i documenti ne avranno bisogno, aggiungerli qui.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'image'; alt: string; src: string };

export interface ListItem {
  inline: Inline[];
  children: Block[];
}

export type Block =
  | { t: 'heading'; level: number; inline: Inline[]; id: string }
  | { t: 'para'; inline: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'code'; text: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'rule' };

/** Identificatore di un titolo, per i collegamenti con `#`: minuscole, parole unite da «-». */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', children: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      // «_» dentro una parola (snake_case) non è corsivo.
      if (c === '*' || !isWord(s[i - 1])) {
        let end = i + 1;
        for (; end < s.length; end++) {
          if (s[end] === '\\') end++;
          else if (s[end] === c && s[end - 1] !== ' ' && (c === '*' || !isWord(s[end + 1]))) break;
        }
        if (end < s.length && end > i + 1 && s[i + 1] !== ' ') {
          flush();
          out.push({ t: 'em', children: parseInline(s.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    if (c === '!' && s[i + 1] === '[') {
      const close = s.indexOf('](', i + 2);
      const end = close < 0 ? -1 : s.indexOf(')', close + 2);
      if (close > i && end > close) {
        flush();
        out.push({
          t: 'image',
          alt: s.slice(i + 2, close),
          src: s.slice(close + 2, end).trim(),
        });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = s.indexOf('](', i + 1);
      const end = close < 0 ? -1 : s.indexOf(')', close + 2);
      if (close > i && end > close) {
        flush();
        out.push({
          t: 'link',
          href: s.slice(close + 2, end).trim(),
          children: parseInline(s.slice(i + 1, close)),
        });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const MARKER = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes('-');
const cells = (l: string): string[] =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = MARKER.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = MARKER.exec(lines[i]!);
    if (!m || m[1]!.length !== indent) break;
    const text: string[] = [m[3]!];
    const children: Block[] = [];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === '') {
        // Riga vuota: l'elemento continua solo se la riga che segue è rientrata più del marcatore.
        const nextLine = lines.slice(i).find((x) => x.trim() !== '');
        if (nextLine !== undefined && indentOf(nextLine) > indent) {
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) <= indent) break;
      if (MARKER.test(l)) {
        const nested = parseList(lines, i);
        children.push(nested.block);
        i = nested.next;
      } else {
        text.push(l.trim());
        i++;
      }
    }
    items.push({ inline: parseInline(text.join(' ')), children });
  }
  return { block: { t: 'list', ordered, items }, next: i };
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slugify(h[2]!) || 'sezione';
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      blocks.push({
        t: 'heading',
        level: h[1]!.length,
        inline: parseInline(h[2]!),
        id: n === 0 ? base : `${base}-${n}`,
      });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s*> ?/, ''));
      blocks.push({ t: 'quote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'rule' });
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!))
        rows.push(cells(lines[i++]!).map(parseInline));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (MARKER.test(line)) {
      const r = parseList(lines, i);
      blocks.push(r.block);
      i = r.next;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*(```|#{1,6}\s|>)/.test(lines[i]!) &&
      !MARKER.test(lines[i]!) &&
      !(isTableRow(lines[i]!) && i + 1 < lines.length && isTableSep(lines[i + 1]!))
    )
      para.push(lines[i++]!.trim());
    blocks.push({ t: 'para', inline: parseInline(para.join(' ')) });
  }
  return blocks;
}

/** Il testo semplice di un blocco, per la ricerca. */
export function inlineText(xs: Inline[]): string {
  return xs
    .map((x) =>
      x.t === 'text' || x.t === 'code' ? x.text : x.t === 'image' ? x.alt : inlineText(x.children),
    )
    .join('');
}
