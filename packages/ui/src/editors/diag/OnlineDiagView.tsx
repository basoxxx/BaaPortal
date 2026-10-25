import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { commands } from '../../commands/commands';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { DiagController, type DiagPage } from '../../online/diagController';
import {
  clockDiffSeconds,
  eventDetails,
  formatEventTime,
  formatS7Time,
  parseClockFields,
} from '../../online/diagFormat';
import type { DiagEventView, DiagValue, PlcDiagData } from '../../online/plcTypes';
import { StacksPage } from './StacksPage';
import './diag.css';

const DIAG_PAGES: DiagPage[] = ['general', 'buffer', 'cycle', 'memory'];

/** Mostra una parte: in attesa, non disponibile su questa CPU, errore, o il valore. */
function Part<T>({
  value,
  t,
  children,
}: {
  value: DiagValue<T> | undefined;
  t: TFunction;
  children: (v: T) => React.ReactNode;
}) {
  if (!value) return <p className="baa-diag-note">{t('onlineDiag.loading')}</p>;
  if (value.ok) return <>{children(value.value)}</>;
  if ('unavailable' in value) {
    return (
      <p className="baa-diag-note" data-testid="diag-unavailable">
        {t('onlineDiag.unavailable')}
      </p>
    );
  }
  return (
    <p className="baa-diag-note is-error" role="alert" data-testid="diag-part-error">
      {value.error}
    </p>
  );
}

/** Editor «Online e diagnostica»: pagine a sinistra, la pagina scelta a destra. */
export function OnlineDiagView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store, service, bridge } = useServices();
  const online = useAppStore((s) => s.online);
  const simOn = useAppStore((s) => s.sim.phase !== 'off');
  const connected = online.status === 'on' && online.deviceId === editor.deviceId;
  if (!connected) {
    return (
      <div className="baa-diag baa-diag-offline" data-testid="diag-view">
        <h3>{t('onlineDiag.needOnline')}</h3>
        {simOn ? (
          <p data-testid="diag-sim-hint">{t('onlineDiag.simHint')}</p>
        ) : (
          <button
            type="button"
            disabled={online.status === 'connecting'}
            onClick={() => void commands['online.goOnline'].run({ store, service, bridge })}
            data-testid="diag-go-online"
          >
            {t('onlineDiag.goOnline')}
          </button>
        )}
      </div>
    );
  }
  return <ConnectedDiag />;
}

function ConnectedDiag() {
  const { t, i18n } = useTranslation();
  const { store, bridge } = useServices();
  const ctrl = useMemo(() => new DiagController(store, bridge), [store, bridge]);
  const st = useSyncExternalStore(ctrl.subscribe, ctrl.getState);
  const [page, setPage] = useState<DiagPage>('general');
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    ctrl.start();
    return () => ctrl.stop();
  }, [ctrl]);

  const choose = (p: DiagPage) => {
    setPage(p);
    ctrl.setPage(p);
  };
  const freeze = (v: boolean) => {
    setFrozen(v);
    ctrl.setFrozen(v);
  };
  const lang = i18n.language.startsWith('en') ? 'en' : 'it';
  const d = st.data;

  return (
    <div className="baa-diag" data-testid="diag-view">
      <nav className="baa-diag-nav" aria-label={t('onlineDiag.pages')}>
        <h4>{t('onlineDiag.group.diagnostics')}</h4>
        {DIAG_PAGES.map((p) => (
          <button
            key={p}
            type="button"
            aria-current={page === p}
            onClick={() => choose(p)}
            data-testid={`diag-page-${p}`}
          >
            {t(`onlineDiag.page.${p}`)}
          </button>
        ))}
        <h4>{t('onlineDiag.group.functions')}</h4>
        <button
          type="button"
          aria-current={page === 'clock'}
          onClick={() => choose('clock')}
          data-testid="diag-page-clock"
        >
          {t('onlineDiag.page.clock')}
        </button>
        <button
          type="button"
          aria-current={page === 'stacks'}
          onClick={() => choose('stacks')}
          data-testid="diag-page-stacks"
        >
          {t('diag.stacks.page')}
        </button>
      </nav>
      <section className="baa-diag-page">
        <header className="baa-diag-head" data-testid="diag-head">
          <strong data-testid="diag-mode">{d.mode?.ok ? d.mode.value : '—'}</strong>
          {d.leds?.ok ? (
            <span className="baa-diag-leds">
              {d.leds.value.map((l) => (
                <span
                  key={l.id}
                  className="baa-diag-led"
                  data-on={l.on}
                  data-blink={l.blink}
                  data-testid={`diag-led-${l.name}`}
                >
                  {l.name}
                </span>
              ))}
            </span>
          ) : null}
        </header>
        {st.error ? (
          <p className="baa-diag-note is-error" role="alert" data-testid="diag-stopped">
            {t('onlineDiag.stopped', { message: st.error })}
          </p>
        ) : null}
        <h3>{page === 'stacks' ? t('diag.stacks.page') : t(`onlineDiag.page.${page}`)}</h3>
        {page === 'general' ? <General d={d} t={t} lang={lang} /> : null}
        {page === 'buffer' ? (
          <BufferPage d={d} t={t} lang={lang} frozen={frozen} onFreeze={freeze} />
        ) : null}
        {page === 'cycle' ? <CyclePage d={d} t={t} /> : null}
        {page === 'memory' ? <MemoryPage d={d} t={t} /> : null}
        {page === 'stacks' ? <StacksPage mode={d.mode?.ok ? d.mode.value : undefined} /> : null}
        {page === 'clock' ? <ClockPage d={d} t={t} readAt={st.readAt} ctrl={ctrl} /> : null}
      </section>
    </div>
  );
}

type PageProps = { d: Partial<PlcDiagData>; t: TFunction };

function General({ d, t, lang }: PageProps & { lang: 'it' | 'en' }) {
  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  const modeName = (c: string) => t(`onlineDiag.modeCode.${c}`);
  return (
    <dl className="baa-diag-dl" data-testid="diag-general">
      <Part value={d.identity} t={t}>
        {(id) => (
          <>
            {row(t('cpuPanel.module'), id.moduleName ?? '')}
            {row(t('cpuPanel.orderNumber'), id.orderNumber)}
            {row(t('onlineDiag.firmware'), id.firmware ?? '')}
            {row(t('onlineDiag.plantId'), id.plantId ?? '')}
            {row(t('onlineDiag.serial'), id.serial ?? '')}
          </>
        )}
      </Part>
      <dt>{t('onlineDiag.mmc')}</dt>
      <dd>
        <Part value={d.memory} t={t}>
          {(areas) => {
            const mmc = areas.find((a) => a.kind === 'loadMmc' && a.size > 0);
            return mmc ? t('onlineDiag.bytes', { value: mmc.size }) : t('onlineDiag.mmcAbsent');
          }}
        </Part>
      </dd>
      <dt>{t('onlineDiag.lastModeChange')}</dt>
      <dd>
        <Part value={d.lastModeChange} t={t}>
          {(ev) => {
            if (!ev) return t('onlineDiag.none');
            const det = eventDetails(ev, lang);
            return (
              <>
                {formatEventTime(ev)}{' '}
                {det.mode
                  ? t('onlineDiag.fromTo', {
                      from: modeName(det.mode.from),
                      to: modeName(det.mode.to),
                    })
                  : det.text}
              </>
            );
          }}
        </Part>
      </dd>
      {d.force?.ok && d.force.value ? (
        <>
          <dt>{t('diag.force.label')}</dt>
          <dd data-testid="diag-force">
            {t('diag.force.active')}
            <span className="baa-diag-note"> {t('diag.force.note')}</span>
          </dd>
        </>
      ) : null}
      <dt>{t('onlineDiag.protection')}</dt>
      <dd>
        <Part value={d.protection} t={t}>
          {(p) => (
            <>
              {p.validLevel ?? p.switchLevel ?? ''}
              {p.modeSwitch ? ` - ${t('onlineDiag.selector')}: ${p.modeSwitch}` : ''}
            </>
          )}
        </Part>
      </dd>
    </dl>
  );
}

function EventDetails({ ev, t, lang }: { ev: DiagEventView; t: TFunction; lang: 'it' | 'en' }) {
  const det = eventDetails(ev, lang);
  const modeName = (c: string) => t(`onlineDiag.modeCode.${c}`);
  const row = (label: string, value: string) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  return (
    <div className="baa-diag-details" data-testid="diag-details">
      <dl className="baa-diag-dl">
        {row(t('onlineDiag.eventId'), det.idHex)}
        {row(t('onlineDiag.event'), det.text)}
        {row(t('onlineDiag.class'), String(det.cls))}
        {row(
          t('onlineDiag.direction'),
          det.incoming ? t('onlineDiag.incoming') : t('onlineDiag.outgoing'),
        )}
        {row(t('onlineDiag.priority'), String(det.priority))}
        {row(t('onlineDiag.ob'), String(det.obNumber))}
        {det.mode
          ? row(
              t('onlineDiag.modeChange'),
              t('onlineDiag.fromTo', { from: modeName(det.mode.from), to: modeName(det.mode.to) }),
            )
          : null}
        {row('DatID', det.datId)}
        {row(t('onlineDiag.info1'), det.info1)}
        {row(t('onlineDiag.info2'), det.info2)}
      </dl>
      {det.generic ? (
        <p className="baa-diag-note" data-testid="diag-generic-note">
          {t('onlineDiag.genericNote')}
        </p>
      ) : null}
    </div>
  );
}

function BufferPage({
  d,
  t,
  lang,
  frozen,
  onFreeze,
}: PageProps & { lang: 'it' | 'en'; frozen: boolean; onFreeze(v: boolean): void }) {
  const [sel, setSel] = useState(0);
  return (
    <div data-testid="diag-buffer">
      <label className="baa-diag-freeze">
        <input
          type="checkbox"
          checked={frozen}
          onChange={(e) => onFreeze(e.target.checked)}
          data-testid="diag-freeze"
        />{' '}
        {t('onlineDiag.freeze')}
      </label>
      <Part value={d.buffer} t={t}>
        {(list) => (
          <>
            <table className="baa-diag-table">
              <thead>
                <tr>
                  <th>{t('onlineDiag.no')}</th>
                  <th>{t('onlineDiag.dateTime')}</th>
                  <th>{t('onlineDiag.event')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((ev, i) => (
                  <tr
                    key={i}
                    tabIndex={0}
                    aria-selected={sel === i}
                    onClick={() => setSel(i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setSel(i);
                    }}
                    data-testid={`diag-row-${i}`}
                  >
                    <td>{i + 1}</td>
                    <td>{formatEventTime(ev)}</td>
                    <td>{eventDetails(ev, lang).text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.length === 0 ? <p className="baa-diag-note">{t('onlineDiag.none')}</p> : null}
            {list[sel] ? <EventDetails ev={list[sel]} t={t} lang={lang} /> : null}
          </>
        )}
      </Part>
    </div>
  );
}

function CyclePage({ d, t }: PageProps) {
  return (
    <div data-testid="diag-cycle">
      <Part value={d.cycle} t={t}>
        {({ time, config }) => (
          <>
            <dl className="baa-diag-dl">
              <dt>{t('cpuPanel.last')}</dt>
              <dd data-testid="cycle-last">{t('cpuPanel.ms', { value: time.lastMs })}</dd>
              <dt>{t('cpuPanel.min')}</dt>
              <dd>{t('cpuPanel.ms', { value: time.minMs })}</dd>
              <dt>{t('cpuPanel.max')}</dt>
              <dd>{t('cpuPanel.ms', { value: time.maxMs })}</dd>
              <dt>{t('onlineDiag.watchdog')}</dt>
              <dd data-testid="cycle-watchdog">{t('cpuPanel.ms', { value: config.maxMs })}</dd>
            </dl>
            <progress
              className="baa-diag-bar"
              value={Math.min(time.lastMs, config.maxMs || time.lastMs)}
              max={config.maxMs || Math.max(1, time.lastMs)}
              aria-label={t('onlineDiag.page.cycle')}
            />
          </>
        )}
      </Part>
    </div>
  );
}

function MemoryPage({ d, t }: PageProps) {
  return (
    <div data-testid="diag-memory">
      <Part value={d.memory} t={t}>
        {(areas) => (
          <table className="baa-diag-table">
            <thead>
              <tr>
                <th>{t('onlineDiag.area')}</th>
                <th>{t('onlineDiag.total')}</th>
                <th>{t('onlineDiag.used')}</th>
                <th>{t('onlineDiag.free')}</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {areas.map((a) => (
                <tr key={a.index}>
                  <td>{t(`onlineDiag.memoryKind.${a.kind}`)}</td>
                  <td>{a.size}</td>
                  <td>{a.used}</td>
                  <td>{a.free}</td>
                  <td>{a.size > 0 ? Math.round((a.used / a.size) * 100) : 0} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Part>
    </div>
  );
}

function ClockPage({ d, t, readAt, ctrl }: PageProps & { readAt: number; ctrl: DiagController }) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [fieldError, setFieldError] = useState<{ field: string; text: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const report = async (req: Parameters<DiagController['setClock']>[0]) => {
    setMessage(null);
    const r = await ctrl.setClock(req);
    if (r.kind === 'error') setMessage(r.message);
  };
  const applyManual = () => {
    setMessage(null);
    const p = parseClockFields(date, time);
    if (!p.ok) {
      setFieldError({
        field: p.error.field,
        text: t(`onlineDiag.clockError.${p.error.field}.${p.error.key}`),
      });
      return;
    }
    setFieldError(null);
    void report({ source: 'manual', time: p.time });
  };
  const pc = new Date(readAt || 0);
  return (
    <div data-testid="diag-clock">
      <Part value={d.clock} t={t}>
        {(cpu) => (
          <dl className="baa-diag-dl">
            <dt>{t('onlineDiag.cpuTime')}</dt>
            <dd data-testid="clock-cpu">{formatS7Time(cpu)}</dd>
            <dt>{t('onlineDiag.pcTime')}</dt>
            <dd data-testid="clock-pc">{readAt ? formatS7Time(toFields(pc)) : ''}</dd>
            <dt>{t('onlineDiag.difference')}</dt>
            <dd data-testid="clock-diff">
              {readAt ? t('onlineDiag.seconds', { value: clockDiffSeconds(cpu, pc) }) : ''}
            </dd>
          </dl>
        )}
      </Part>
      <div className="baa-diag-set">
        <button
          type="button"
          onClick={() => void report({ source: 'pc' })}
          data-testid="clock-set-pc"
        >
          {t('onlineDiag.setToPc')}
        </button>
      </div>
      <div className="baa-diag-set">
        <label>
          {t('onlineDiag.date')}{' '}
          <input
            value={date}
            placeholder="AAAA-MM-GG"
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={fieldError?.field === 'date' ? true : undefined}
            data-testid="clock-date"
          />
        </label>
        <label>
          {t('onlineDiag.time')}{' '}
          <input
            value={time}
            placeholder="hh:mm:ss"
            onChange={(e) => setTime(e.target.value)}
            aria-invalid={fieldError?.field === 'time' ? true : undefined}
            data-testid="clock-time"
          />
        </label>
        <button type="button" onClick={applyManual} data-testid="clock-apply">
          {t('onlineDiag.apply')}
        </button>
      </div>
      <p className="baa-diag-note" data-testid="clock-format">
        {t('onlineDiag.clockFormat')}
      </p>
      {fieldError ? (
        <p className="baa-diag-note is-error" role="alert" data-testid="clock-field-error">
          {fieldError.text}
        </p>
      ) : null}
      {message ? (
        <p className="baa-diag-note is-error" role="alert" data-testid="clock-error">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function toFields(pc: Date) {
  return {
    year: pc.getFullYear(),
    month: pc.getMonth() + 1,
    day: pc.getDate(),
    hour: pc.getHours(),
    minute: pc.getMinutes(),
    second: pc.getSeconds(),
  };
}
