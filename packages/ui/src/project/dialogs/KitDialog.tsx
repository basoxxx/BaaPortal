import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KitConnectionType, KitProgress, KitStartOptions, KitSummary } from '../../bridge';
import { Dialog } from '../../components/Dialog';
import { useServices } from '../../state/AppContext';

const TYPES: KitConnectionType[] = ['pg', 'op', 'basic'];

/** IPv4 puntato o nome host ([A-Za-z0-9.-], fino a 253 caratteri). Stesse regole del processo principale. */
export function isValidKitHost(host: string): boolean {
  if (host.length === 0 || host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(host)) return false;
  if (host.startsWith('.') || host.startsWith('-') || host.endsWith('.') || host.includes('..'))
    return false;
  // Solo cifre e punti: dev'essere un IPv4 vero, non un nome.
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }
  return true;
}

/** `192.168.000.010` diventa `192.168.0.10`; un nome host resta com'è. Presuppone `isValidKitHost`. */
export function canonicalKitHost(host: string): string {
  return /^[0-9.]+$/.test(host)
    ? host
        .split('.')
        .map((p) => String(Number(p)))
        .join('.')
    : host;
}

const PROTECTED_LEVEL = 2;

/**
 * CPU protetta da password: livello di protezione 2 o più letto dalla CPU, oppure tutti gli upload
 * dei blocchi elencati rifiutati con l'errore 0xD241 (funzione protetta da password).
 */
export function isKitCpuProtected(s: KitSummary): boolean {
  const level = s.protection?.validLevel ?? s.protection?.paramLevel ?? s.protection?.switchLevel;
  if (level !== undefined && level >= PROTECTED_LEVEL) return true;
  if (s.blocksListed === 0 || s.blocksUploaded > 0) return false;
  const denied = s.errors.filter(
    (e) => e.step.startsWith('upload ') && /0xd2\b.*0x41\b/i.test(e.message),
  );
  return denied.length >= s.blocksListed;
}

const intInRange = (v: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

type Stage = 'form' | 'running' | 'done';

export function KitDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { bridge } = useServices();
  const ids = { host: useId(), port: useId(), rack: useId(), slot: useId(), type: useId() };
  const [host, setHost] = useState('');
  const [port, setPort] = useState('102');
  const [rack, setRack] = useState('0');
  const [slot, setSlot] = useState('2');
  const [type, setType] = useState<KitConnectionType>('pg');
  const [includeBlocks, setIncludeBlocks] = useState(true);
  const [stage, setStage] = useState<Stage>('form');
  const [progress, setProgress] = useState<KitProgress | null>(null);
  const [summary, setSummary] = useState<KitSummary | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<Stage>('form');
  stageRef.current = stage;
  const confirmingRef = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const savedToRef = useRef<string | null>(null);
  savedToRef.current = savedTo;

  useEffect(() => {
    const off = bridge.onKitProgress((p) => setProgress(p));
    return () => {
      off();
      // Se la finestra sparisce durante la raccolta (p.es. l'app viene smontata) la raccolta si ferma.
      if (stageRef.current === 'running') bridge.cancelKit();
    };
  }, [bridge]);

  // Riaprendo la finestra con una raccolta finita e non salvata (tenuta dal processo principale) si
  // riparte dal suo riepilogo: i dati raccolti non devono perdersi per aver chiuso la finestra.
  useEffect(() => {
    let alive = true;
    void bridge
      .kitUnsavedSummary()
      .then((r) => {
        if (!alive || !r || stageRef.current !== 'form') return;
        setSummary(r);
        setSavedTo(null);
        setSaveError(null);
        setStage('done');
        stageRef.current = 'done';
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bridge]);

  // Nello stato finale il modulo sparisce e con lui il focus: lo si porta sul riepilogo, dentro la
  // finestra, così Esc arriva ancora al suo gestore (e la conferma di chiusura compare).
  useEffect(() => {
    if (stage === 'done') summaryRef.current?.focus();
  }, [stage]);

  const hostTrim = host.trim();
  const hostOk = isValidKitHost(hostTrim);
  const portN = intInRange(port, 1, 65535);
  const rackN = intInRange(rack, 0, 7);
  const slotN = intInRange(slot, 0, 31);
  const valid = hostOk && portN !== null && rackN !== null && slotN !== null;
  const running = stage === 'running';

  const start = async () => {
    if (!valid || stage !== 'form' || portN === null || rackN === null || slotN === null) return;
    const opts: KitStartOptions = {
      host: canonicalKitHost(hostTrim),
      port: portN,
      rack: rackN,
      slot: slotN,
      connectionType: type,
      includeBlocks,
    };
    setError(null);
    setProgress(null);
    setStage('running');
    stageRef.current = 'running';
    try {
      const r = await bridge.startKit(opts);
      if (r.ok) {
        setSummary(r.summary);
        setSavedTo(r.savedTo);
        setSaveError(r.saveError ?? null);
        setStage('done');
      } else {
        setError(t('kit.failed', { error: r.error }));
        setStage('form');
      }
    } catch (e) {
      setError(t('kit.failed', { error: e instanceof Error ? e.message : String(e) }));
      setStage('form');
    }
  };

  /** Salva; true se il file è stato scritto (false se annullato o in errore). */
  const save = async (): Promise<boolean> => {
    setError(null);
    try {
      const path = await bridge.saveKitResult();
      if (!path) return false;
      savedToRef.current = path;
      setSavedTo(path);
      setSaveError(null);
      return true;
    } catch (e) {
      setError(t('kit.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  };

  /**
   * Con la raccolta finita e non salvata, chiudere (o ricominciare) la perderebbe: si chiede conferma.
   * `then` è ciò che l'utente voleva fare (chiudere o tornare al modulo).
   */
  const leave = async (then: () => void) => {
    if (stageRef.current !== 'done' || savedToRef.current !== null) return then();
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      const answer = await bridge.confirmUnsaved({
        title: t('kit.confirmClose.title'),
        message: t('kit.confirmClose.message'),
        yes: t('kit.confirmClose.save'),
        no: t('kit.confirmClose.discard'),
        cancel: t('kit.confirmClose.cancel'),
      });
      if (answer === 'cancel') return;
      if (answer === 'save' && !(await save())) return;
      then();
    } finally {
      confirmingRef.current = false;
    }
  };
  const requestClose = () => {
    if (!running) void leave(onClose);
  };
  const newRun = () =>
    void leave(() => {
      setSummary(null);
      setSavedTo(null);
      setSaveError(null);
      setError(null);
      setProgress(null);
      setStage('form');
      stageRef.current = 'form';
    });

  const footer = (
    <>
      {stage === 'form' ? (
        <button type="button" disabled={!valid} onClick={() => void start()}>
          {t('kit.start')}
        </button>
      ) : null}
      {running ? (
        <button type="button" onClick={() => bridge.cancelKit()}>
          {t('kit.stop')}
        </button>
      ) : null}
      {stage === 'done' && !savedTo ? (
        <button type="button" onClick={() => void save()}>
          {t('kit.save')}
        </button>
      ) : null}
      {stage === 'done' ? (
        <button type="button" onClick={newRun}>
          {t('kit.newRun')}
        </button>
      ) : null}
      {stage !== 'done' ? (
        <button type="button" disabled={running} onClick={onClose}>
          {t('kit.cancel')}
        </button>
      ) : (
        <button type="button" onClick={requestClose}>
          {t('kit.close')}
        </button>
      )}
    </>
  );

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    ok: boolean,
    err: string,
  ) => (
    <div className="baa-dialog-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={value}
        disabled={stage !== 'form'}
        aria-invalid={ok ? undefined : true}
        onChange={(e) => set(e.target.value)}
      />
      {ok ? null : (
        <span role="alert" className="baa-field-error">
          {err}
        </span>
      )}
    </div>
  );

  return (
    <Dialog
      title={t('kit.title')}
      onClose={requestClose}
      onOk={() => void start()}
      okDisabled={!valid || stage !== 'form'}
      footer={footer}
      testId="dialog-kit"
    >
      <div className="baa-dialog-form">
        <p>{t('kit.readOnly')}</p>
        {stage !== 'done' ? (
          <>
            <div className="baa-dialog-field">
              <label htmlFor={ids.host}>{t('kit.host')}</label>
              <input
                id={ids.host}
                type="text"
                value={host}
                disabled={stage !== 'form'}
                aria-invalid={hostTrim !== '' && !hostOk ? true : undefined}
                onChange={(e) => setHost(e.target.value)}
              />
              {hostTrim !== '' && !hostOk ? (
                <span role="alert" className="baa-field-error">
                  {t('kit.hostInvalid')}
                </span>
              ) : null}
            </div>
            <details>
              <summary>{t('kit.advanced')}</summary>
              <div className="baa-dialog-form">
                {field(
                  ids.port,
                  t('kit.port'),
                  port,
                  setPort,
                  portN !== null,
                  t('kit.portInvalid'),
                )}
                {field(
                  ids.rack,
                  t('kit.rack'),
                  rack,
                  setRack,
                  rackN !== null,
                  t('kit.rackInvalid'),
                )}
                {field(
                  ids.slot,
                  t('kit.slot'),
                  slot,
                  setSlot,
                  slotN !== null,
                  t('kit.slotInvalid'),
                )}
                <div className="baa-dialog-field">
                  <label htmlFor={ids.type}>{t('kit.connectionType')}</label>
                  <select
                    id={ids.type}
                    value={type}
                    disabled={stage !== 'form'}
                    onChange={(e) => setType(e.target.value as KitConnectionType)}
                  >
                    {TYPES.map((v) => (
                      <option key={v} value={v}>
                        {t(`kit.type.${v}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </details>
            <label className="baa-dialog-row">
              <input
                type="checkbox"
                checked={includeBlocks}
                disabled={stage !== 'form'}
                onChange={(e) => setIncludeBlocks(e.target.checked)}
              />
              {t('kit.includeBlocks')}
            </label>
          </>
        ) : null}
        {running ? (
          <div data-testid="kit-progress" role="status" aria-live="polite">
            {progress ? (
              <>
                <div>
                  {t(`kit.phase.${progress.phase}`)}
                  {progress.total > 0 ? ` ${progress.done} / ${progress.total}` : ''}
                </div>
                <div className="baa-dialog-fact">{progress.message}</div>
              </>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <span role="alert" className="baa-field-error">
            {error}
          </span>
        ) : null}
        {stage === 'done' && summary ? (
          <div data-testid="kit-summary" ref={summaryRef} tabIndex={-1}>
            <h3>{t('kit.summary')}</h3>
            {summary.host ? (
              <div>
                {t('kit.host')}: {summary.host}
              </div>
            ) : null}
            <div>
              {t('kit.cpu')}: {summary.identity?.moduleName ?? t('kit.unknown')}
            </div>
            <div>
              {t('kit.order')}: {summary.identity?.orderNumber || t('kit.unknown')}
            </div>
            <div>
              {t('kit.mode')}: {summary.mode ?? t('kit.unknown')}
            </div>
            <div>
              {t('kit.szlRead')}: {summary.szlRead}
            </div>
            <div>
              {t('kit.blocksListed')}: {summary.blocksListed}
            </div>
            <div>
              {t('kit.blocksUploaded')}: {summary.blocksUploaded}
            </div>
            {!summary.identity && summary.errors.length > 0 ? (
              <span role="alert" className="baa-field-error">
                {t('kit.noConnection')}
              </span>
            ) : null}
            {isKitCpuProtected(summary) ? (
              <span role="note" className="baa-field-error">
                {t('kit.protectedHint')}
              </span>
            ) : null}
            <details>
              <summary>{t('kit.errors', { count: summary.errors.length })}</summary>
              <ul>
                {summary.errors.map((e, i) => (
                  <li key={i}>
                    {e.step}: {e.message} ({e.code})
                  </li>
                ))}
              </ul>
            </details>
            <div data-testid="kit-saved">
              {savedTo
                ? t('kit.savedTo', { path: savedTo })
                : saveError
                  ? t('kit.autoSaveFailed', { error: saveError })
                  : t('kit.notSaved')}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
