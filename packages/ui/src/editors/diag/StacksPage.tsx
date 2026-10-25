import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { stwBits } from '@baaportal/s7comm';
import { useServices } from '../../state/AppContext';
import { useSettings } from '../../settings/settings';
import { formatS7Time, hexNum } from '../../online/diagFormat';
import type {
  BStackView,
  Decoded,
  IStackView,
  LStackView,
  PlcStacksResult,
} from '../../online/plcTypes';

type Ok = Extract<PlcStacksResult, { ok: true }>;
type Ref = { blockType?: string; typeCode: number; number: number };

const refName = (r: Ref): string => `${r.blockType ?? hexNum(r.typeCode, 4)} ${r.number}`;
const dbName = (r: { type: number; number: number }): string =>
  `${r.type ? 'DB' : '-'} ${r.number}`;
const time = (v: { time?: Parameters<typeof formatS7Time>[0]; rawTime?: string }): string =>
  v.time ? formatS7Time(v.time) : (v.rawTime ?? '');

/** Byte in esadecimale, 16 per riga. */
function hexRows(h: string): string {
  const bytes = h.match(/../g) ?? [];
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) rows.push(bytes.slice(i, i + 16).join(' '));
  return rows.join('\n').toUpperCase();
}

function Unrecognized({ r, t }: { r: { why: string; hex: string }; t: TFunction }) {
  return (
    <div data-testid="stack-unrecognized">
      <p className="baa-diag-note is-error">
        {t('diag.stacks.unrecognized')}: {r.why}
      </p>
      {r.hex ? <pre className="baa-diag-hex">{hexRows(r.hex)}</pre> : null}
    </div>
  );
}

function BStack({ r, t }: { r: Decoded<BStackView>; t: TFunction }) {
  if (!r.ok) return <Unrecognized r={r} t={t} />;
  return (
    <table className="baa-diag-table" data-testid="stack-bstack">
      <thead>
        <tr>
          <th>{t('diag.stacks.entry')}</th>
          <th>{t('diag.stacks.block')}</th>
          <th>{t('diag.stacks.returnAddress')}</th>
          <th>{t('diag.stacks.db1')}</th>
          <th>{t('diag.stacks.db2')}</th>
          <th>{t('diag.stacks.priority')}</th>
          <th>{t('diag.stacks.time')}</th>
        </tr>
      </thead>
      <tbody>
        {r.value.entries.map((e, i) => (
          <tr key={i}>
            <td>{i}</td>
            <td>{refName(e)}</td>
            <td>{hexNum(e.returnAddress, 4)}</td>
            <td>{dbName(e.db1)}</td>
            <td>{dbName(e.db2)}</td>
            <td>{e.ob ? e.ob.priority : ''}</td>
            <td>{e.ob ? time(e.ob) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UStack({ r, t }: { r: Decoded<IStackView>; t: TFunction }) {
  if (!r.ok) return <Unrecognized r={r} t={t} />;
  const v = r.value;
  const bits = stwBits(v.stw);
  const row = (label: string, value: string) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  return (
    <dl className="baa-diag-dl" data-testid="stack-ustack">
      {row(
        t('diag.stacks.interrupted'),
        `${refName(v.interrupted)} @ ${hexNum(v.interrupted.address, 4)}`,
      )}
      {row(t('diag.stacks.resume'), `${refName(v.resume)} @ ${hexNum(v.resume.address, 4)}`)}
      {row(t('diag.stacks.accu1'), hexNum(v.accu1, 8))}
      {row(t('diag.stacks.accu2'), hexNum(v.accu2, 8))}
      {row(t('diag.stacks.ar1'), hexNum(v.ar1, 8))}
      {row(t('diag.stacks.ar2'), hexNum(v.ar2, 8))}
      {row(
        t('diag.stacks.stw'),
        (Object.entries(bits) as [string, number][])
          .map(([k, b]) => `${k.toUpperCase()}=${b}`)
          .join(' '),
      )}
      {row(t('diag.stacks.db1'), dbName(v.db1))}
      {row(t('diag.stacks.db2'), dbName(v.db2))}
      {row(t('diag.stacks.obStart'), (v.obStartInfo.match(/../g) ?? []).join(' ').toUpperCase())}
      {row(t('diag.stacks.time'), time(v))}
    </dl>
  );
}

function LStack({ r, t }: { r: Decoded<LStackView>; t: TFunction }) {
  if (!r.ok) return <Unrecognized r={r} t={t} />;
  return (
    <pre className="baa-diag-hex" data-testid="stack-lstack">
      {hexRows(r.value.local)}
    </pre>
  );
}

/** Pagina «Stack di chiamata (sperimentale)»: si legge solo col pulsante, mai a intervalli. */
export function StacksPage({ mode }: { mode: string | undefined }) {
  const { t } = useTranslation();
  const { bridge } = useServices();
  const [settings] = useSettings();
  const experimental = settings.online.experimental;
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PlcStacksResult | null>(null);
  const [sel, setSel] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const stopped = mode === 'STOP' || mode === 'HOLD';

  const read = async () => {
    setBusy(true);
    let r: PlcStacksResult;
    try {
      r = await bridge.plcReadStacks(experimental);
    } catch (e) {
      r = { ok: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    if (!alive.current) return;
    setBusy(false);
    setSel(0);
    setRes(r);
  };

  return (
    <div data-testid="diag-stacks">
      <p className="baa-diag-note" data-testid="stacks-note">
        {t('diag.stacks.note')}
      </p>
      {!experimental ? (
        <p className="baa-diag-note" data-testid="stacks-off">
          {t('diag.stacks.off')}
        </p>
      ) : (
        <>
          {!stopped ? (
            <p className="baa-diag-note" data-testid="stacks-run-only">
              {t('diag.stacks.runOnly')}
            </p>
          ) : null}
          <button
            type="button"
            disabled={!stopped || busy}
            onClick={() => void read()}
            data-testid="stacks-read"
          >
            {busy ? t('diag.stacks.reading') : t('diag.stacks.read')}
          </button>
          {res && !res.ok ? (
            <p className="baa-diag-note is-error" role="alert" data-testid="stacks-error">
              {res.reason === 'error'
                ? t('diag.stacks.reason.error', { message: res.error })
                : t(`diag.stacks.reason.${res.reason}`)}
            </p>
          ) : null}
          {res?.ok ? <Result res={res} sel={sel} onSel={setSel} t={t} /> : null}
        </>
      )}
    </div>
  );
}

function Result({
  res,
  sel,
  onSel,
  t,
}: {
  res: Ok;
  sel: number;
  onSel(i: number): void;
  t: TFunction;
}) {
  const chosen = res.lstack.find((l) => l.depth === sel);
  return (
    <>
      <h4>{t('diag.stacks.bstack')}</h4>
      <BStack r={res.bstack} t={t} />
      <h4>{t('diag.stacks.ustack')}</h4>
      <UStack r={res.ustack} t={t} />
      <h4>{t('diag.stacks.lstack')}</h4>
      <label>
        {t('diag.stacks.entry')}{' '}
        <select
          value={sel}
          onChange={(e) => onSel(Number(e.target.value))}
          data-testid="stacks-entry"
        >
          {res.lstack.map((l) => (
            <option key={l.depth} value={l.depth}>
              {l.depth}
            </option>
          ))}
        </select>
      </label>
      {chosen ? <LStack r={chosen.value} t={t} /> : null}
    </>
  );
}
