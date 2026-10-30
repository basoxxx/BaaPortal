import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { HelpContent, HelpDialog } from '../src/help/HelpDialog';
import { parseMarkdown } from '../src/help/markdown';
import {
  HELP_PAGES,
  buildPage,
  contextPage,
  helpImage,
  linkTarget,
  searchHelp,
} from '../src/help/pages';
import { renderApp } from './renderApp';

const A = buildPage(
  'a',
  '# Pagina A\n\nTesto con **forte** e `codice`.\n\n## Avvio rapido\n\nvedi [B](b.md#dettagli) e [web](https://x.example/p)\n',
);
const B = buildPage(
  'b',
  '# Pagina B\n\n## Dettagli\n\n1. uno\n   - sotto\n2. due\n\n| x | y |\n|---|---|\n| 1 | 2 |\n',
);
const PAGES = [A, B];

describe('guida: markdown', () => {
  it('<script> e HTML nel markdown restano testo', () => {
    const page = buildPage(
      'x',
      '# T\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n- <b>a</b>\n',
    );
    const { container } = render(<HelpContent page={page} go={() => undefined} pages={[page]} />);
    expect(container.querySelector('script, img, b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<b>a</b>');
  });

  it('un collegamento esterno non diventa un <a>; javascript: neppure', () => {
    const page = buildPage('x', '[a](https://x.example) [b](javascript:alert(1)) [c](b.md)');
    const { container } = render(
      <HelpContent page={page} go={() => undefined} pages={[page, B]} />,
    );
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('#b');
  });

  it('riconosce titoli, elenchi annidati, tabelle, codice', () => {
    const blocks = parseMarkdown(
      '# T\n\n1. a\n   - b\n   - c\n2. d\n\n| h |\n|---|\n| v |\n\n```\n<x>\n```\n',
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'list', 'table', 'code']);
    const list = blocks[1]!;
    expect(list.t === 'list' && list.items[0]!.children[0]!.t).toBe('list');
  });

  it('tutte le pagine incluse nella build hanno titolo e contenuto, e i collegamenti si risolvono', () => {
    expect(HELP_PAGES.map((p) => p.slug)).toEqual(
      expect.arrayContaining(['kop', 'stampa', 'limiti-noti']),
    );
    for (const p of HELP_PAGES) {
      expect(p.blocks.length).toBeGreaterThan(0);
      expect(p.title).not.toBe('');
    }
    expect(linkTarget('../limiti-noti.md#x')).toEqual({ slug: 'limiti-noti', anchor: 'x' });
    expect(linkTarget('nonesiste.md')).toBeNull();
  });

  it('citazioni e immagini: la citazione si legge, l\u2019immagine fuori dalla cartella resta il suo testo', () => {
    const page = buildPage(
      'x',
      '# T\n\n> Nota importante\n> su due righe\n\n![logo](../../etc/x.png) ![web](https://x.example/a.png) ![assente](nessuna.png)\n',
    );
    expect(page.blocks.map((b) => b.t)).toEqual(['heading', 'quote', 'para']);
    const { container } = render(<HelpContent page={page} go={() => undefined} pages={[page]} />);
    expect(container.querySelector('blockquote')?.textContent).toContain('Nota importante su due');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('logo');
    expect(helpImage('../x.png')).toBeUndefined();
    expect(helpImage('https://x.example/a.png')).toBeUndefined();
  });

  it('pagina di contesto per editor e linguaggio', () => {
    expect(contextPage('block', 'AWL')).toBe('awl');
    expect(HELP_PAGES.some((p) => p.slug === 'awl')).toBe(true);
    expect(contextPage('block', 'KOP')).toBe('kop');
    expect(contextPage('block', 'SCL')).toBe('fup-scl');
    expect(contextPage('hmiScreen')).toBe('hmi');
    expect(contextPage('tagTable')).toBeUndefined();
  });
});

describe('guida: ricerca e navigazione', () => {
  it('cerca per parole, titolo prima', () => {
    expect(searchHelp('forte', PAGES).map((h) => h.slug)).toEqual(['a']);
    expect(searchHelp('pagina dettagli', PAGES).map((h) => h.slug)).toEqual(['b']);
    expect(searchHelp('   ', PAGES)).toEqual([]);
    expect(searchHelp('assente', PAGES)).toEqual([]);
  });

  it('indice, collegamento tra pagine e ricerca nella finestra', async () => {
    await initI18n('it');
    const user = userEvent.setup();
    render(<HelpDialog onClose={() => undefined} pages={PAGES} />);
    const body = screen.getByTestId('help-body');
    expect(within(body).getByRole('heading', { name: 'Pagina A' })).toBeInTheDocument();
    await user.click(within(body).getByRole('link', { name: 'B' }));
    expect(
      within(screen.getByTestId('help-body')).getByRole('heading', { name: 'Pagina B' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pagina A' }));
    await user.type(screen.getByRole('searchbox', { name: 'Cerca nella guida' }), 'forte');
    await user.click(
      within(screen.getByRole('list', { name: 'Risultati' })).getByRole('button', {
        name: 'Pagina A',
      }),
    );
    expect(screen.queryByRole('list', { name: 'Risultati' })).toBeNull();
  });

  it('F1 apre la guida alla pagina dell’editor in primo piano', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    app.store.getState().openDialog({ kind: 'help', page: 'kop' });
    const body = await screen.findByTestId('help-body');
    expect(within(body).getAllByRole('heading')[0]).toHaveTextContent(/KOP/i);
  });
});
