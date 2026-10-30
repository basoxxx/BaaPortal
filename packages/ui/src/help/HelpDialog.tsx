import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../components/Dialog';
import type { Block, Inline } from './markdown';
import { HELP_PAGES, findHelpPage, linkTarget, searchHelp, type HelpPage } from './pages';
import './help.css';

type Go = (slug: string, anchor?: string) => void;

function Inlines({ xs, go, pages }: { xs: Inline[]; go: Go; pages: HelpPage[] }): ReactNode {
  return xs.map((x, i) => {
    switch (x.t) {
      case 'text':
        return <Fragment key={i}>{x.text}</Fragment>;
      case 'code':
        return <code key={i}>{x.text}</code>;
      case 'strong':
        return (
          <strong key={i}>
            <Inlines xs={x.children} go={go} pages={pages} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inlines xs={x.children} go={go} pages={pages} />
          </em>
        );
      case 'link': {
        const target = linkTarget(x.href, pages);
        const inner = <Inlines xs={x.children} go={go} pages={pages} />;
        // Solo i collegamenti tra pagine sono attivi: un indirizzo esterno non si apre da qui.
        return target ? (
          <a
            key={i}
            href={`#${target.slug}`}
            onClick={(e) => {
              e.preventDefault();
              go(target.slug, target.anchor);
            }}
          >
            {inner}
          </a>
        ) : (
          <span key={i} className="baa-help-ext">
            {inner}
          </span>
        );
      }
    }
  });
}

function Blocks({
  blocks,
  slug,
  go,
  pages,
}: {
  blocks: Block[];
  slug: string;
  go: Go;
  pages: HelpPage[];
}): ReactNode {
  const inl = (xs: Inline[]) => <Inlines xs={xs} go={go} pages={pages} />;
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'heading': {
        const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
        return (
          <H key={i} id={`${slug}--${b.id}`}>
            {inl(b.inline)}
          </H>
        );
      }
      case 'para':
        return <p key={i}>{inl(b.inline)}</p>;
      case 'code':
        return (
          <pre key={i}>
            <code>{b.text}</code>
          </pre>
        );
      case 'rule':
        return <hr key={i} />;
      case 'list': {
        const L = b.ordered ? 'ol' : 'ul';
        return (
          <L key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                {inl(it.inline)}
                <Blocks blocks={it.children} slug={slug} go={go} pages={pages} />
              </li>
            ))}
          </L>
        );
      }
      case 'table':
        return (
          <table key={i}>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inl(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inl(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
    }
  });
}

/** Il corpo di una pagina della guida (riusabile e provabile senza la finestra). */
export function HelpContent({
  page,
  go,
  pages = HELP_PAGES,
}: {
  page: HelpPage;
  go: Go;
  pages?: HelpPage[];
}) {
  return <Blocks blocks={page.blocks} slug={page.slug} go={go} pages={pages} />;
}

/** «Guida di BaaPortal»: indice, ricerca e pagine dei documenti d'uso. `page` apre una pagina precisa (F1 nell'editor). */
export function HelpDialog({
  onClose,
  page,
  pages = HELP_PAGES,
}: {
  onClose(): void;
  page?: string;
  pages?: HelpPage[];
}) {
  const { t } = useTranslation();
  const [nav, setNav] = useState<{ slug: string; anchor?: string; n: number }>({
    slug: (page && findHelpPage(page, pages)?.slug) || pages[0]?.slug || '',
    n: 0,
  });
  const [query, setQuery] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const current = findHelpPage(nav.slug, pages);
  const hits = useMemo(() => searchHelp(query, pages), [query, pages]);
  const go: Go = (slug, anchor) => {
    setNav((n) => ({ slug, ...(anchor ? { anchor } : {}), n: n.n + 1 }));
    setQuery('');
  };
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const target = nav.anchor ? body.querySelector(`[id="${nav.slug}--${nav.anchor}"]`) : null;
    if (target) target.scrollIntoView?.();
    else body.scrollTop = 0;
  }, [nav]);
  const outline = current?.blocks.filter((b) => b.t === 'heading' && b.level === 2) ?? [];

  return (
    <Dialog
      title={t('help.title')}
      onClose={onClose}
      onOk={() => undefined}
      testId="help-dialog"
      footer={
        <button type="button" data-testid="dialog-cancel" onClick={onClose}>
          {t('texts.close')}
        </button>
      }
    >
      <div className="baa-help">
        <nav className="baa-help-nav" aria-label={t('help.contents')}>
          <input
            type="search"
            value={query}
            placeholder={t('help.search')}
            aria-label={t('help.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() ? (
            <ul className="baa-help-hits" aria-label={t('help.results')}>
              {hits.length === 0 ? <li>{t('help.noResults')}</li> : null}
              {hits.map((h) => (
                <li key={h.slug}>
                  <button type="button" onClick={() => go(h.slug)}>
                    {h.title}
                  </button>
                  <small>{h.excerpt}</small>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="baa-help-toc">
              {pages.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    aria-current={p.slug === nav.slug ? 'page' : undefined}
                    onClick={() => go(p.slug)}
                  >
                    {p.title}
                  </button>
                  {p.slug === nav.slug && outline.length > 0 ? (
                    <ul>
                      {outline.map((h) =>
                        h.t === 'heading' ? (
                          <li key={h.id}>
                            <button type="button" onClick={() => go(p.slug, h.id)}>
                              <Inlines xs={h.inline} go={go} pages={pages} />
                            </button>
                          </li>
                        ) : null,
                      )}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </nav>
        <article className="baa-help-body" ref={bodyRef} data-testid="help-body">
          {current ? <HelpContent page={current} go={go} pages={pages} /> : null}
        </article>
      </div>
    </Dialog>
  );
}
