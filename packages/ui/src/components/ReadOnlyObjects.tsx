import { useTranslation } from 'react-i18next';
import type { Block, Member, TagTable, Udt } from '@baaportal/project';
import { FupNetworkView } from '../editors/fbd/FupNetworkView';
import { LadNetworkEditor } from '../editors/lad/LadNetworkEditor';

/** Oggetti da mostrare in sola lettura: di un modello di libreria o di un progetto di riferimento. */
export interface ReadOnlyObjects {
  blocks?: readonly Block[];
  udts?: readonly Udt[];
  tagTables?: readonly TagTable[];
}

const NO_DIAGNOSTICS = new Map<string, string[]>();
const noop = () => {};

function MemberTable({ members }: { members: readonly Member[] }) {
  return (
    <table className="baa-readonly-table">
      <tbody>
        {members.map((m) => (
          <tr key={m.id}>
            <td>{m.name}</td>
            <td>{m.type}</td>
            <td>{m.initial ?? ''}</td>
            <td>{m.comment}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlockView({ block }: { block: Block }) {
  const { t } = useTranslation();
  const title = `${block.kind === 'IDB' ? 'DB' : block.kind}${block.number} ${block.name}`;
  if (block.kind === 'DB')
    return (
      <section>
        <h4>{title}</h4>
        <MemberTable members={block.members} />
      </section>
    );
  if (block.kind === 'IDB')
    return (
      <section>
        <h4>{title}</h4>
        <p>{block.instanceOf}</p>
      </section>
    );
  const i = block.interface;
  const sections = [
    ['input', i.input],
    ['output', i.output],
    ['inOut', i.inOut],
    ['static', i.static],
    ['temp', i.temp],
  ] as const;
  return (
    <section data-testid={`readonly-block-${block.name}`}>
      <h4>{title}</h4>
      {sections.map(([k, list]) =>
        list.length > 0 ? (
          <div key={k}>
            <strong>{t(`readOnlyView.${k}`)}</strong>
            <MemberTable members={list} />
          </div>
        ) : null,
      )}
      {block.networks.map((n, idx) => (
        <div key={n.id} className="baa-network">
          <strong>
            {t('block.network', { n: idx + 1 })} {n.title}
          </strong>
          {n.comment ? <p>{n.comment}</p> : null}
          {block.language === 'KOP' && n.lad ? (
            <LadNetworkEditor
              net={n.lad}
              index={idx}
              diagnostics={NO_DIAGNOSTICS}
              readOnly
              onChange={noop}
            />
          ) : block.language === 'FUP' && n.lad ? (
            <FupNetworkView net={n.lad} diagnostics={NO_DIAGNOSTICS} readOnly onChange={noop} />
          ) : (
            <pre className="baa-library-source" tabIndex={0}>
              {n.source}
            </pre>
          )}
        </div>
      ))}
    </section>
  );
}

/** Blocchi (con i grafici KOP/FUP), UDT e tabelle dei tag, senza modifiche possibili. */
export function ReadOnlyObjects({ objects }: { objects: ReadOnlyObjects }) {
  return (
    <div className="baa-readonly-objects" aria-readonly="true">
      {(objects.udts ?? []).map((u) => (
        <section key={u.id}>
          <h4>
            UDT{u.number} {u.name}
          </h4>
          <MemberTable members={u.members} />
        </section>
      ))}
      {(objects.blocks ?? []).map((b) => (
        <BlockView key={b.id} block={b} />
      ))}
      {(objects.tagTables ?? []).map((tb) => (
        <section key={tb.id}>
          <h4>{tb.name}</h4>
          <table className="baa-readonly-table">
            <tbody>
              {tb.tags.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td>{x.type}</td>
                  <td>{x.address}</td>
                  <td>{x.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
