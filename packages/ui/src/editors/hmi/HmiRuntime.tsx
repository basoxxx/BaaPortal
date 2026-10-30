import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { findCpu } from '@baaportal/catalog';
import {
  findDevice,
  findHmiScreen,
  watchResolverFor,
  type HmiObject,
  type WatchTarget,
} from '@baaportal/project';
import type { WatchValue } from '../../sim/protocol';
import { useAppStore, useServices } from '../../state/AppContext';
import {
  bindObject,
  bitOf,
  inputData,
  numberOf,
  pressData,
  releaseData,
  targetKey,
  valueText,
  type HmiBinding,
} from './hmiBinding';
import { plcHmiLink, simHmiLink } from './hmiLinks';

export interface HmiRuntimeMode {
  source: 'sim' | 'plc';
  /** Pulsanti e campi di immissione scrivono (online solo dopo la conferma nel processo principale). */
  canWrite: boolean;
}

type Ok = Extract<HmiBinding, { ok: true }>;

/**
 * Runtime HMI a tutta finestra: le schermate del PLC con i valori letti in un solo giro (le
 * variabili della schermata mostrata) e le scritture una dopo l'altra, nell'ordine dei gesti.
 */
export function HmiRuntime(p: {
  deviceId: string;
  screenId: string;
  mode: HmiRuntimeMode;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const { source, canWrite } = p.mode;
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, p.deviceId) : undefined));
  const [current, setCurrent] = useState(p.screenId);
  const screen = dev && findHmiScreen(dev, current);
  const link = useMemo(
    () => (source === 'plc' ? plcHmiLink(store, bridge) : simHmiLink(store, p.deviceId)),
    [source, store, bridge, p.deviceId],
  );
  const st = useSyncExternalStore(link.subscribe, link.getState);
  const [message, setMessage] = useState('');
  const [lost, setLost] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const bindings = useMemo(() => {
    const out = new Map<string, HmiBinding | null>();
    if (!dev || !screen) return out;
    const resolve = watchResolverFor(dev, findCpu(dev.cpu.typeId));
    for (const o of screen.objects) out.set(o.id, bindObject(resolve, o, source));
    return out;
  }, [dev, screen, source]);

  // Un solo piano di lettura: le variabili della schermata mostrata, ciascuna una volta.
  useEffect(() => {
    const plan = new Map<string, WatchTarget>();
    for (const b of bindings.values()) if (b?.ok) plan.set(targetKey(b.target), b.target);
    link.setPlan([...plan.keys()], [...plan.values()]);
  }, [link, bindings]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (st.running) wasRunning.current = true;
    else if (wasRunning.current) setLost(true);
  }, [st.running]);
  // A tutta finestra: il resto dell'app non prende né focus né clic finché il runtime è aperto.
  useEffect(() => {
    const self = rootRef.current;
    const others = [...(self?.ownerDocument.body.children ?? [])].filter(
      (el): el is HTMLElement => el !== self && !(el as HTMLElement).inert,
    );
    for (const el of others) el.inert = true;
    closeRef.current?.focus();
    return () => {
      for (const el of others) el.inert = false;
    };
  }, []);

  // Le scritture vanno in fila: il rilascio di un pulsante a impulsi non sorpassa la pressione.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const write = (target: WatchTarget, data: Uint8Array): Promise<void> => {
    queue.current = queue.current.then(async () => {
      const err = await link.write(target, data);
      setMessage(err ? t('hmi.runtime.writeFailed', { message: err }) : '');
    });
    return queue.current;
  };
  /** Pulsanti a impulsi tenuti premuti: si rilasciano anche alla chiusura. */
  const held = useRef(new Map<string, WatchTarget>());
  const release = (id: string) => {
    const target = held.current.get(id);
    if (!target) return;
    held.current.delete(id);
    void write(target, Uint8Array.of(0));
  };
  // Alla fine (anche se l'editor si chiude senza «Chiudi runtime»): impulsi rilasciati, poi il
  // permesso di scrittura revocato nel processo principale.
  const armed = source === 'plc' && canWrite;
  const stopAll = useRef<() => void>(() => undefined);
  stopAll.current = () => {
    for (const id of [...held.current.keys()]) release(id);
    void queue.current.then(() => {
      link.stop();
      if (armed) void bridge.plcHmiDisarm();
    });
  };
  useEffect(() => {
    link.start();
    if (!link.getState().running) setLost(true);
    return () => stopAll.current();
  }, [link]);
  const close = async () => {
    for (const id of [...held.current.keys()]) release(id);
    await queue.current;
    p.onClose();
  };

  const valueOf = (b: Ok): WatchValue | undefined => st.values?.[targetKey(b.target)];
  const press = (o: HmiObject, b: Ok) => {
    if (!canWrite || held.current.has(o.id)) return;
    const d = pressData(o, b, valueOf(b));
    if (!d.ok) {
      setMessage(t(`hmi.err.${d.code}`, { defaultValue: t('hmi.runtime.badValue') }));
      return;
    }
    if (releaseData(o)) held.current.set(o.id, b.target);
    void write(b.target, d.data);
  };

  const modeText =
    source === 'sim'
      ? t('hmi.runtime.sim')
      : canWrite
        ? t('hmi.runtime.plcWrite')
        : t('hmi.runtime.plcRead');

  return (
    <div
      ref={rootRef}
      className="baa-hmi-runtime"
      role="dialog"
      aria-modal="true"
      aria-label={t('hmi.runtime.title', { name: screen?.name ?? '' })}
      data-testid="hmi-runtime"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          void close();
        }
      }}
    >
      <div className="baa-hmi-runtime-bar">
        <strong>{screen?.name}</strong>
        <span data-testid="hmi-runtime-mode">{modeText}</span>
        <span role="status" data-testid="hmi-runtime-status">
          {lost ? t('hmi.runtime.lost') : message}
        </span>
        <button ref={closeRef} type="button" className="baa-panel-btn" onClick={() => void close()}>
          {t('hmi.runtime.close')}
        </button>
      </div>
      <div className="baa-hmi-runtime-body">
        {screen ? (
          <div
            className="baa-hmi-canvas is-runtime"
            style={{ width: screen.width, height: screen.height, background: screen.background }}
          >
            {screen.objects.map((o) => (
              <div
                key={o.id}
                className="baa-hmi-obj"
                style={{ left: o.x, top: o.y, width: o.w, height: o.h }}
              >
                <RuntimeObject
                  o={o}
                  b={bindings.get(o.id) ?? null}
                  value={(() => {
                    const b = bindings.get(o.id);
                    return b?.ok ? valueOf(b) : undefined;
                  })()}
                  canWrite={canWrite}
                  onPress={press}
                  onRelease={release}
                  onInput={(b, text) => {
                    const d = inputData(b, text);
                    if (!d.ok) setMessage(t('hmi.runtime.badValue'));
                    else void write(b.target, d.data);
                  }}
                  onNavigate={(id) => {
                    if (dev && findHmiScreen(dev, id)) setCurrent(id);
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <p>{t('hmi.runtime.noScreen')}</p>
        )}
      </div>
    </div>
  );
}

function RuntimeObject(p: {
  o: HmiObject;
  b: HmiBinding | null;
  value: WatchValue | undefined;
  canWrite: boolean;
  onPress(o: HmiObject, b: Ok): void;
  onRelease(id: string): void;
  onInput(b: Ok, text: string): void;
  onNavigate(id: string): void;
}) {
  const { t } = useTranslation();
  const { o, b, value } = p;
  const [draft, setDraft] = useState<string | null>(null);
  const bad = b && !b.ok ? t(`hmi.err.${b.code}`) : value && 'error' in value ? value.error : null;
  switch (o.kind) {
    case 'text':
      return <span className="baa-hmi-text">{o.text}</span>;
    case 'screenButton':
      return (
        <button
          type="button"
          className="baa-hmi-button"
          disabled={!o.screen}
          onClick={() => o.screen && p.onNavigate(o.screen)}
        >
          {o.text}
        </button>
      );
    case 'button': {
      const ok = b?.ok ? b : null;
      const enabled = p.canWrite && !!ok;
      return (
        <button
          type="button"
          className="baa-hmi-button"
          disabled={!enabled}
          title={bad ?? (p.canWrite ? undefined : t('hmi.runtime.readOnly'))}
          onPointerDown={(e) => {
            if (e.button !== 0 || !ok) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            p.onPress(o, ok);
          }}
          onPointerUp={() => p.onRelease(o.id)}
          onPointerCancel={() => p.onRelease(o.id)}
          onBlur={() => p.onRelease(o.id)}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && ok) {
              e.preventDefault();
              p.onPress(o, ok);
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') p.onRelease(o.id);
          }}
        >
          {o.text}
        </button>
      );
    }
    case 'lamp': {
      const on = bitOf(value);
      return (
        <span
          className="baa-hmi-lamp-wrap"
          role="img"
          aria-label={`${o.text || o.tag || ''} ${bad ? bad : on ? 'ON' : 'OFF'}`.trim()}
          data-state={on ? 'on' : 'off'}
          title={bad ?? undefined}
        >
          <span
            className={`baa-hmi-lamp${bad ? ' is-error' : ''}`}
            style={{ background: on ? o.onColor : o.offColor }}
          />
          {o.text ? <span className="baa-hmi-text">{o.text}</span> : null}
        </span>
      );
    }
    case 'bar': {
      const n = b?.ok ? numberOf(b, value) : undefined;
      const min = o.min ?? 0;
      const max = o.max ?? 100;
      const frac =
        n === undefined || max === min ? 0 : Math.min(1, Math.max(0, (n - min) / (max - min)));
      const pct = `${frac * 100}%`;
      return (
        <span
          className={`baa-hmi-bar-frame${bad ? ' is-error' : ''}`}
          role="meter"
          aria-label={o.tag}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={n}
          title={bad ?? (n === undefined ? undefined : String(n))}
        >
          <span
            className="baa-hmi-bar-fill"
            style={o.h >= o.w ? { height: pct } : { width: pct }}
          />
        </span>
      );
    }
    case 'ioField': {
      const ok = b?.ok ? b : null;
      const v = ok ? valueText(ok, value) : undefined;
      const text = v && 'text' in v ? v.text : bad ? '#####' : '';
      if (o.input && p.canWrite && ok) {
        return (
          <input
            className="baa-hmi-io is-input"
            aria-label={o.text || o.tag}
            value={draft ?? text}
            onFocus={() => setDraft(text)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft !== null) {
                e.preventDefault();
                p.onInput(ok, draft);
                setDraft(null);
                e.currentTarget.blur();
              } else if (e.key === 'Escape' && draft !== null) {
                e.stopPropagation();
                setDraft(null);
                e.currentTarget.blur();
              }
            }}
          />
        );
      }
      return (
        <output
          className={`baa-hmi-io${bad ? ' is-error' : ''}`}
          aria-label={o.text || o.tag}
          title={bad ?? undefined}
        >
          {text}
        </output>
      );
    }
  }
}
