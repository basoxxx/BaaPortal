import { useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { crossReferences, findDevice, type XrefOperand, type XrefUse } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { openUse, subscribeXrefRequest, xrefRequest } from './xrefActions';
import './xref.css';

/** Confronto del filtro: senza maiuscole, spazi, '%' e virgolette (`M 10.3` trova `%M10.3`). */
const norm = (s: string) => s.toLowerCase().replace(/[\s%"]/g, '');

/** Dove sta un punto d'uso: blocco, segmento e riga (SCL: solo la riga; KOP/FUP: il segmento). */
export function locationText(t: TFunction) {
  return (u: XrefUse): string =>
    u.language === 'SCL'
      ? t('xref.atScl', { block: u.block, line: u.line })
      : u.elemId
        ? t('xref.atGraphic', { block: u.block, network: u.network })
        : t('xref.atAwl', { block: u.block, network: u.network, line: u.line });
}

/** Editor «Riferimenti incrociati»: ogni operando del programma e dove si usa, con un filtro. */
export function CrossRefView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined));
  const all = useMemo(() => (dev ? crossReferences(dev) : []), [dev]);
  const req = useSyncExternalStore(subscribeXrefRequest, xrefRequest);
  // Il filtro scritto vale finché non arriva una richiesta nuova per questo dispositivo.
  const [typed, setTyped] = useState<{ n: number; text: string } | null>(null);
  const fresh = req.deviceId === editor.deviceId && (!typed || typed.n < req.n);
  const filter = fresh ? req.filter : (typed?.text ?? '');
  const [withOverlaps, setWithOverlaps] = useState(true);
  const location = locationText(t);

  const rows = useMemo(() => {
    const q = norm(filter);
    if (q === '') return all.map((op) => ({ op, uses: op.uses, overlapped: false }));
    const names = new Map(dev?.blocks.map((b) => [b.id, b.name]));
    // Un nome intero (FC1, "Dati") trova solo sé stesso e i suoi membri, non FC10 o "Dati2".
    const exact = [...all.flatMap((o) => [o.address, o.symbol]), ...names.values()].some(
      (x) => x !== undefined && norm(x) === q,
    );
    const hit = (s: string | undefined) => {
      if (s === undefined) return false;
      const v = norm(s);
      return exact ? v === q || v.startsWith(q + '.') : v.includes(q);
    };
    const byKey = new Map(all.map((o) => [o.key, o]));
    const out: { op: XrefOperand; uses: XrefUse[]; overlapped: boolean }[] = [];
    const extra = new Set<string>();
    for (const op of all) {
      if (hit(op.address) || hit(op.symbol)) {
        out.push({ op, uses: op.uses, overlapped: false });
        if (withOverlaps) op.overlaps.forEach((k) => extra.add(k));
        continue;
      }
      // Anche i punti d'uso dentro un blocco che corrisponde (FC1: chi lo chiama e cosa usa).
      const uses = op.uses.filter((u) => hit(u.block) || hit(names.get(u.blockId)));
      if (uses.length) out.push({ op, uses, overlapped: false });
    }
    const shown = new Set(out.map((r) => r.op.key));
    for (const k of extra) {
      const op = byKey.get(k);
      if (op && !shown.has(k)) out.push({ op, uses: op.uses, overlapped: true });
    }
    return out;
  }, [all, filter, withOverlaps, dev]);

  if (!dev) return null;
  const n = rows.reduce((a, r) => a + r.uses.length, 0);
  return (
    <div className="baa-xref" data-testid="xref-view">
      <div className="baa-xref-bar">
        <label>
          {t('xref.filter')}{' '}
          <input
            type="search"
            data-testid="xref-filter"
            value={filter}
            placeholder={t('xref.filterHint')}
            onChange={(e) => setTyped({ n: req.n, text: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={withOverlaps}
            onChange={(e) => setWithOverlaps(e.target.checked)}
          />{' '}
          {t('xref.withOverlaps')}
        </label>
        <span className="baa-xref-count" role="status">
          {t('xref.count', { operands: rows.length, uses: n })}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="baa-placeholder">{t(all.length ? 'xref.noMatch' : 'xref.empty')}</p>
      ) : (
        <table className="baa-xref-table" aria-label={t('xref.title')}>
          <thead>
            <tr>
              <th scope="col">{t('xref.operand')}</th>
              <th scope="col">{t('xref.symbol')}</th>
              <th scope="col">{t('xref.type')}</th>
              <th scope="col">{t('xref.location')}</th>
              <th scope="col">{t('xref.access')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap(({ op, uses, overlapped }) =>
              uses.map((u, i) => (
                <tr
                  key={`${op.key}|${i}`}
                  data-testid="xref-row"
                  data-operand={op.address}
                  className={i === 0 ? 'is-first' : undefined}
                >
                  <td>
                    {op.address}
                    {overlapped ? (
                      <span className="baa-xref-badge">{t('xref.overlapped')}</span>
                    ) : null}
                    {i === 0 && op.overlaps.length ? (
                      <span className="baa-xref-overlaps" title={t('xref.overlapsWith')}>
                        <span className="baa-sr-only">{t('xref.overlapsWith')} </span>↔{' '}
                        {op.overlaps.join(', ')}
                      </span>
                    ) : null}
                  </td>
                  <td>{op.symbol ?? ''}</td>
                  <td>{op.type ?? ''}</td>
                  <td>
                    <button
                      type="button"
                      className="baa-info-link"
                      data-testid="xref-goto"
                      title={t('xref.goTo')}
                      onClick={() => openUse(store, editor.deviceId, u)}
                    >
                      {location(u)}
                    </button>
                    {u.instance ? <span className="baa-xref-muted"> ({u.instance})</span> : null}
                  </td>
                  <td>
                    {t(`xref.accessKind.${u.access}`)}{' '}
                    <span className="baa-xref-muted">{u.instruction}</span>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
