// Barra degli strumenti delle viste KOP e FUP: pulsanti con il loro tasto e menu dei box.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BOX_CATALOG } from '@baaportal/ladfbd';
import type { BoxGroup, BoxKind } from '@baaportal/ladfbd';
import './lad.css';

export type LadTool = { key: string; label: string; title: string; run: () => void };

const BOX_GROUPS = Object.values(BOX_CATALOG).reduce<Map<BoxGroup, BoxKind[]>>((m, d) => {
  m.set(d.group, [...(m.get(d.group) ?? []), d.kind]);
  return m;
}, new Map());

/** `done` si chiama dopo ogni pulsante, per riportare il fuoco sulla rete. */
export function LadToolbar({
  tools,
  readOnly,
  onBox,
  done,
}: {
  tools: LadTool[];
  readOnly: boolean;
  onBox: (kind: BoxKind) => void;
  done: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  return (
    <div className="baa-lad-toolbar" role="toolbar" aria-label={t('lad.toolbar')}>
      {tools.map((tool) => (
        <button
          key={tool.key}
          type="button"
          disabled={readOnly}
          title={tool.title}
          onClick={() => {
            tool.run();
            done();
          }}
        >
          {tool.label}
        </button>
      ))}
      <span className="baa-lad-menu-wrap">
        <button
          type="button"
          disabled={readOnly}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          {t('lad.tool.box')} ▾
        </button>
        {menu && (
          <div className="baa-lad-menu" role="menu" aria-label={t('lad.boxMenu')}>
            {[...BOX_GROUPS].map(([group, kinds]) => (
              <div key={group} role="group" aria-label={t(`lad.group.${group}`)}>
                <div className="baa-lad-menu-head">{t(`lad.group.${group}`)}</div>
                {kinds.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onBox(k);
                    }}
                  >
                    {t(`lad.box.${k}`)}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}
