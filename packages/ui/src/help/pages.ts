/// <reference types="vite/client" />
// Le pagine della guida: i documenti d'uso (docs/uso e i limiti noti), inclusi come testo nella build.
import type { EditorKind } from '../state/workArea';
import { inlineText, parseMarkdown, type Block } from './markdown';

export interface HelpPage {
  /** Nome del file senza estensione: `kop`, `limiti-noti`. */
  slug: string;
  title: string;
  blocks: Block[];
  /** Testo semplice in minuscolo per la ricerca. */
  plain: string;
}

const sources = import.meta.glob(['../../../../docs/uso/*.md', '../../../../docs/limiti-noti.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const blockText = (b: Block): string => {
  switch (b.t) {
    case 'quote':
      return b.blocks.map(blockText).join(' ');
    case 'heading':
    case 'para':
      return inlineText(b.inline);
    case 'code':
      return b.text;
    case 'rule':
      return '';
    case 'list':
      return b.items
        .map((it) => `${inlineText(it.inline)} ${it.children.map(blockText).join(' ')}`)
        .join(' ');
    case 'table':
      return [b.head, ...b.rows].map((r) => r.map(inlineText).join(' ')).join(' ');
  }
};

// Immagini della guida: solo file della cartella dei documenti d'uso, incluse nella build.
const images = import.meta.glob('../../../../docs/uso/**/*.{png,jpg,jpeg,gif,svg,webp}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** L'indirizzo di un'immagine della guida (percorso relativo semplice, mai `..`, schemi o `/`), se c'è. */
export function helpImage(src: string): string | undefined {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(src) || src.split('/').includes('..')) return undefined;
  return images[`../../../../docs/uso/${src}`];
}

export function buildPage(slug: string, markdown: string): HelpPage {
  const blocks = parseMarkdown(markdown);
  const h1 = blocks.find((b) => b.t === 'heading' && b.level === 1);
  return {
    slug,
    title: h1 && h1.t === 'heading' ? inlineText(h1.inline) : slug,
    blocks,
    plain: blocks.map(blockText).join('\n').toLowerCase(),
  };
}

export const HELP_PAGES: HelpPage[] = Object.entries(sources)
  .map(([path, text]) =>
    buildPage(path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''), text),
  )
  // I documenti d'uso in ordine di titolo; i limiti noti, il più lungo, per ultimi.
  .sort(
    (a, b) =>
      Number(a.slug === 'limiti-noti') - Number(b.slug === 'limiti-noti') ||
      a.title.localeCompare(b.title, 'it'),
  );

export const findHelpPage = (slug: string, pages: HelpPage[] = HELP_PAGES): HelpPage | undefined =>
  pages.find((p) => p.slug === slug);

/** Il nome di pagina di un collegamento relativo (`kop.md#x`, `../limiti-noti.md`), o null. */
export function linkTarget(
  href: string,
  pages: HelpPage[] = HELP_PAGES,
): { slug: string; anchor?: string } | null {
  const m = /^(?:[\w./-]*\/)?([\w-]+)\.md(?:#([\w-]+))?$/.exec(href);
  if (!m || !findHelpPage(m[1]!, pages)) return null;
  return { slug: m[1]!, ...(m[2] ? { anchor: m[2] } : {}) };
}

export interface HelpHit {
  slug: string;
  title: string;
  /** Una riga attorno alla prima occorrenza. */
  excerpt: string;
}

/** Pagine che contengono tutte le parole cercate (maiuscole indifferenti), titolo prima del testo. */
export function searchHelp(query: string, pages: HelpPage[] = HELP_PAGES): HelpHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits = pages.flatMap((p) => {
    if (!words.every((w) => p.plain.includes(w) || p.title.toLowerCase().includes(w))) return [];
    const at = p.plain.indexOf(words[0]!);
    const line =
      at < 0 ? '' : p.plain.slice(0, at).match(/[^\n]*$/)![0] + p.plain.slice(at).split('\n')[0]!;
    return [
      {
        hit: { slug: p.slug, title: p.title, excerpt: line.slice(0, 160) },
        inTitle: words.every((w) => p.title.toLowerCase().includes(w)),
      },
    ];
  });
  return hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle)).map((h) => h.hit);
}

const CONTEXT: Partial<Record<EditorKind, string>> = {
  hmiScreen: 'hmi',
  deviceView: 'dispositivi',
  crossRef: 'riferimenti',
  callStructure: 'riferimenti',
  assignment: 'riferimenti',
  resources: 'riferimenti',
  onlineDiag: 'online',
  watchTable: 'simulatore',
};

/** La pagina che spiega l'editor in primo piano; `block` dipende dal linguaggio del blocco. */
export function contextPage(kind: EditorKind | undefined, language?: string): string | undefined {
  if (kind === 'block')
    return language === 'KOP'
      ? 'kop'
      : language === 'FUP' || language === 'SCL'
        ? 'fup-scl'
        : 'awl';
  return kind ? CONTEXT[kind] : undefined;
}
