import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { completeOperand } from '@baaportal/awl';
import { findCpu } from '@baaportal/catalog';
import {
  HMI_FORMATS,
  HMI_GRID,
  HMI_MAX_SIZE,
  HMI_OBJECT_KINDS,
  HMI_SCREEN_SIZES,
  createAwlContext,
  createHmiObject,
  findDevice,
  findHmiScreen,
  watchResolverFor,
  type HmiButtonAction,
  type HmiFormat,
  type HmiObject,
  type HmiObjectKind,
  type HmiScreen,
  type PlcDevice,
} from '@baaportal/project';
import { CheckField, NumberField, TextField } from '../../project/inspector/properties/fields';
import { copyToClipboard, peekClipboardPayload, readClipboard } from '../../services/clipboard';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditAction } from '../../state/store';
import { useEditTarget } from '../../state/useEditTarget';
import type { EditorRef } from '../../state/workArea';
import { bindObject } from './hmiBinding';
import { HmiObjectView } from './HmiObjectView';
import { focusOpenRuntime, HmiRuntime, whileArming, type HmiRuntimeMode } from './HmiRuntime';
import './hmi.css';

const DRAG_KIND = 'application/x-baa-hmi-kind';
const ACTIONS: readonly HmiButtonAction[] = ['set', 'reset', 'toggle', 'write', 'jog'];
const newId = () => globalThis.crypto.randomUUID();
const snap = (v: number, free: boolean) =>
  free ? Math.round(v) : Math.round(v / HMI_GRID) * HMI_GRID;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

interface Drag {
  mode: 'move' | 'resize';
  ids: string[];
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

/** Posizione e dimensioni di un oggetto durante il trascinamento (non ancora nel modello). */
function preview(o: HmiObject, sc: HmiScreen, d: Drag | null, free: boolean): HmiObject {
  if (!d || !d.ids.includes(o.id)) return o;
  if (d.mode === 'move') {
    return {
      ...o,
      x: clamp(snap(o.x + d.dx, free), 0, Math.max(0, sc.width - o.w)),
      y: clamp(snap(o.y + d.dy, free), 0, Math.max(0, sc.height - o.h)),
    };
  }
  return {
    ...o,
    w: clamp(snap(o.w + d.dx, free), HMI_GRID, HMI_MAX_SIZE),
    h: clamp(snap(o.h + d.dy, free), HMI_GRID, HMI_MAX_SIZE),
  };
}

/** Editor «Schermata HMI»: tavolozza, area della schermata con griglia, proprietà e avvio del runtime. */
export function HmiScreenEditor({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const { deviceId, objectId: screenId } = editor;
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const screen = dev && findHmiScreen(dev, screenId);
  const simOn = useAppStore((s) => s.sim.phase === 'on' && s.sim.deviceId === deviceId);
  const plcOn = useAppStore((s) => s.online.status === 'on' && s.online.deviceId === deviceId);
  const source = simOn ? 'sim' : plcOn ? 'plc' : null;
  const [selected, setSelected] = useState<string[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [free, setFree] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [runtime, setRuntime] = useState<HmiRuntimeMode | null>(null);
  const [notice, setNotice] = useState('');
  // Dopo una copia «Incolla» diventa disponibile: gli appunti non sono nello store.
  const [, setCopies] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const writeId = useId();

  const existing = useMemo(() => new Set(screen?.objects.map((o) => o.id)), [screen]);
  const sel = selected.filter((id) => existing.has(id));
  const one = sel.length === 1 ? screen?.objects.find((o) => o.id === sel[0]) : undefined;

  const edit = (labelKey: string, fn: (sc: HmiScreen, d: PlcDevice) => void) =>
    store.getState().edit(labelKey, (p) => {
      const d = findDevice(p, deviceId);
      const sc = d && findHmiScreen(d, screenId);
      if (d && sc) fn(sc, d);
    });
  const editObjects = (labelKey: string, ids: string[], fn: (o: HmiObject) => void) =>
    edit(labelKey, (sc) => {
      for (const o of sc.objects) if (ids.includes(o.id)) fn(o);
    });

  const insert = (kind: HmiObjectKind, x = HMI_GRID * 2, y = HMI_GRID * 2) => {
    const o = createHmiObject(kind, x, y, newId);
    o.text = kind === 'lamp' || kind === 'bar' ? '' : t(`hmi.kind.${kind}`);
    edit('history.hmiAdd', (sc) => {
      o.x = clamp(o.x, 0, Math.max(0, sc.width - o.w));
      o.y = clamp(o.y, 0, Math.max(0, sc.height - o.h));
      sc.objects.push(o);
    });
    setSelected([o.id]);
    canvasRef.current?.focus();
  };

  const removeSelected = () => {
    if (sel.length === 0) return;
    edit('history.hmiDelete', (sc) => {
      sc.objects = sc.objects.filter((o) => !sel.includes(o.id));
    });
    setSelected([]);
  };
  const copySelected = () => {
    const picked = (screen?.objects ?? []).filter((o) => sel.includes(o.id));
    if (picked.length === 0) return;
    copyToClipboard(bridge, picked.map((o) => o.text || t(`hmi.kind.${o.kind}`)).join('\n'), {
      kind: 'hmiObjects',
      objects: structuredClone(picked),
    });
    setCopies((n) => n + 1);
  };
  const paste = async () => {
    const { payload } = await readClipboard(bridge);
    if (payload?.kind !== 'hmiObjects') return;
    const fresh = payload.objects.map((o) => ({
      ...structuredClone(o),
      id: newId(),
      x: o.x + HMI_GRID,
      y: o.y + HMI_GRID,
    }));
    edit('history.hmiPaste', (sc) => {
      // La destinazione di un pulsante di navigazione vale solo nello stesso PLC.
      for (const o of fresh) {
        if (o.screen !== undefined && !findHmiScreen(dev!, o.screen)) delete o.screen;
        o.x = clamp(o.x, 0, Math.max(0, sc.width - o.w));
        o.y = clamp(o.y, 0, Math.max(0, sc.height - o.h));
      }
      sc.objects.push(...fresh);
    });
    setSelected(fresh.map((o) => o.id));
  };

  const can: Partial<Record<EditAction, boolean>> = {
    copy: sel.length > 0,
    cut: sel.length > 0,
    delete: sel.length > 0,
    paste: peekClipboardPayload()?.kind === 'hmiObjects',
    selectAll: (screen?.objects.length ?? 0) > 0,
  };
  const focus = useEditTarget(store, `hmi:${editor.key}`, canvasRef, can, async (a) => {
    if (a === 'copy') copySelected();
    else if (a === 'cut') {
      copySelected();
      removeSelected();
    } else if (a === 'delete') removeSelected();
    else if (a === 'paste') await paste();
    else if (a === 'selectAll') setSelected(screen?.objects.map((o) => o.id) ?? []);
  });

  const resolve = useMemo(
    () => (dev ? watchResolverFor(dev, findCpu(dev.cpu.typeId)) : null),
    [dev],
  );

  if (!dev || !screen) return null;

  const onObjectDown = (e: PointerEvent, id: string, mode: Drag['mode']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    canvasRef.current?.focus();
    let ids = sel;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      ids = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
      setSelected(ids);
      return;
    }
    if (!sel.includes(id)) ids = [id];
    setSelected(ids);
    setDrag({
      mode,
      ids: mode === 'resize' ? [id] : ids,
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      dy: 0,
    });
    canvasRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    setFree(e.altKey);
    setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 });
  };
  const onUp = (e: PointerEvent) => {
    const d = drag;
    if (!d) return;
    setDrag(null);
    if (d.dx === 0 && d.dy === 0) return;
    const freeNow = e.altKey;
    edit(d.mode === 'move' ? 'history.hmiMove' : 'history.hmiResize', (sc) => {
      for (const o of sc.objects) {
        if (!d.ids.includes(o.id)) continue;
        const p = preview(o, sc, d, freeNow);
        o.x = p.x;
        o.y = p.y;
        o.w = p.w;
        o.h = p.h;
      }
    });
  };

  // Frecce: spostano la selezione di un passo di griglia (Alt: 1 px); con Maiusc ridimensionano.
  const onKeyDown = (e: KeyboardEvent) => {
    const dir: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = dir[e.key];
    if (d && sel.length > 0) {
      e.preventDefault();
      const step = e.altKey ? 1 : HMI_GRID;
      const resize = e.shiftKey;
      edit(resize ? 'history.hmiResize' : 'history.hmiMove', (sc) => {
        for (const o of sc.objects) {
          if (!sel.includes(o.id)) continue;
          if (resize) {
            o.w = clamp(o.w + d[0] * step, 1, HMI_MAX_SIZE);
            o.h = clamp(o.h + d[1] * step, 1, HMI_MAX_SIZE);
          } else {
            o.x = clamp(o.x + d[0] * step, 0, Math.max(0, sc.width - o.w));
            o.y = clamp(o.y + d[1] * step, 0, Math.max(0, sc.height - o.h));
          }
        }
      });
    } else if (e.key === 'Escape') setSelected([]);
  };

  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData(DRAG_KIND) as HmiObjectKind;
    if (!HMI_OBJECT_KINDS.includes(kind)) return;
    e.preventDefault();
    const r = canvasRef.current!.getBoundingClientRect();
    insert(kind, snap(e.clientX - r.left, e.altKey), snap(e.clientY - r.top, e.altKey));
  };

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = async () => {
    setNotice('');
    if (!source) return;
    // Un runtime alla volta nell'app: il secondo avvio porta in primo piano il primo.
    if (focusOpenRuntime()) {
      setNotice(t('hmi.runtimeOpen'));
      return;
    }
    let token: string | undefined;
    if (source === 'plc' && allowWrite) {
      // La conferma è nativa, nel processo principale: il token vale finché il runtime resta aperto.
      const r = await whileArming(() => bridge.plcHmiArm());
      // Editor chiuso durante la conferma: nessun runtime userà il permesso, si revoca subito.
      if (!mounted.current) {
        if (r.ok) void bridge.plcHmiDisarm(r.token);
        return;
      }
      if (!r.ok) {
        if (!('cancelled' in r)) setNotice(r.error);
        return;
      }
      token = r.token;
    }
    setRuntime({ source, canWrite: source === 'sim' || allowWrite, token });
  };

  return (
    <div
      ref={rootRef}
      className="baa-editor-body baa-hmi"
      data-testid={`editor-body-${editor.key}`}
    >
      <div className="baa-hmi-bar" role="toolbar" aria-label={t('hmi.toolbox')}>
        {HMI_OBJECT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="baa-panel-btn"
            draggable
            data-testid={`hmi-tool-${k}`}
            onDragStart={(e) => e.dataTransfer.setData(DRAG_KIND, k)}
            onClick={() => insert(k)}
          >
            {t(`hmi.kind.${k}`)}
          </button>
        ))}
        <span className="baa-hmi-sep" />
        <label>
          <input
            type="checkbox"
            id={writeId}
            checked={allowWrite}
            disabled={source !== 'plc'}
            onChange={(e) => setAllowWrite(e.target.checked)}
          />{' '}
          {t('hmi.allowWrite')}
        </label>
        <button
          type="button"
          className="baa-panel-btn"
          disabled={!source}
          title={source ? undefined : t('hmi.noSource')}
          onClick={() => void start()}
        >
          {t('hmi.startRuntime')}
        </button>
        <span className="baa-hmi-notice" role="status">
          {notice || (source ? '' : t('hmi.noSource'))}
        </span>
      </div>
      <div className="baa-hmi-main">
        <div className="baa-hmi-scroll">
          <div
            ref={canvasRef}
            className="baa-hmi-canvas"
            role="listbox"
            aria-multiselectable="true"
            aria-label={t('hmi.canvas', { name: screen.name })}
            tabIndex={0}
            data-testid="hmi-canvas"
            style={{ width: screen.width, height: screen.height, background: screen.background }}
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => {
              if (e.button === 0 && !e.shiftKey) setSelected([]);
            }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_KIND)) e.preventDefault();
            }}
            onDrop={onDrop}
          >
            {screen.objects.map((o) => {
              const shown = preview(o, screen, drag, free);
              const isSel = sel.includes(o.id);
              return (
                <div
                  key={o.id}
                  role="option"
                  aria-selected={isSel}
                  aria-label={`${t(`hmi.kind.${o.kind}`)} ${o.text || o.tag || ''}`.trim()}
                  data-testid={`hmi-obj-${o.id}`}
                  className={`baa-hmi-obj${isSel ? ' is-selected' : ''}`}
                  style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }}
                  onPointerDown={(e) => onObjectDown(e, o.id, 'move')}
                >
                  <HmiObjectView o={o} screens={dev.hmi?.screens ?? []} />
                  {isSel && sel.length === 1 ? (
                    <span
                      className="baa-hmi-handle"
                      data-testid="hmi-resize"
                      aria-hidden="true"
                      onPointerDown={(e) => onObjectDown(e, o.id, 'resize')}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <section className="baa-hmi-props" aria-label={t('hmi.properties')} data-testid="hmi-props">
          <h4>{t('hmi.properties')}</h4>
          {one ? (
            <ObjectProps
              key={one.id}
              o={one}
              dev={dev}
              screens={dev.hmi?.screens ?? []}
              problem={(() => {
                const b = resolve && bindObject(resolve, one);
                return b && !b.ok ? t(`hmi.err.${b.code}`) : null;
              })()}
              onChange={(fn) => editObjects('history.hmiEdit', [one.id], fn)}
              onDelete={removeSelected}
            />
          ) : sel.length > 1 ? (
            <p className="baa-placeholder">{t('hmi.manySelected', { count: sel.length })}</p>
          ) : (
            <ScreenProps sc={screen} onChange={(fn) => edit('history.hmiEdit', fn)} />
          )}
        </section>
      </div>
      {runtime && rootRef.current
        ? createPortal(
            <HmiRuntime
              deviceId={deviceId}
              screenId={screenId}
              mode={runtime}
              onClose={() => setRuntime(null)}
            />,
            rootRef.current.ownerDocument.body,
          )
        : null}
    </div>
  );
}

function ScreenProps(p: { sc: HmiScreen; onChange(fn: (sc: HmiScreen) => void): void }) {
  const { t } = useTranslation();
  const sizeId = useId();
  const bgId = useId();
  const preset = HMI_SCREEN_SIZES.findIndex(
    (s) => s.width === p.sc.width && s.height === p.sc.height,
  );
  const range = (n: number) => (n < 100 || n > HMI_MAX_SIZE ? t('hmi.sizeRange') : null);
  return (
    <div className="baa-props">
      <label htmlFor={sizeId}>{t('hmi.size')}</label>
      <select
        id={sizeId}
        value={preset < 0 ? '' : String(preset)}
        onChange={(e) => {
          const s = HMI_SCREEN_SIZES[Number(e.target.value)];
          if (s) p.onChange((sc) => Object.assign(sc, s));
        }}
      >
        {preset < 0 ? <option value="">{t('hmi.customSize')}</option> : null}
        {HMI_SCREEN_SIZES.map((s, i) => (
          <option key={i} value={i}>
            {s.width} × {s.height}
          </option>
        ))}
      </select>
      <NumberField
        label={t('hmi.width')}
        value={p.sc.width}
        validate={range}
        onCommit={(n) => p.onChange((sc) => void (sc.width = n))}
      />
      <NumberField
        label={t('hmi.height')}
        value={p.sc.height}
        validate={range}
        onCommit={(n) => p.onChange((sc) => void (sc.height = n))}
      />
      <label htmlFor={bgId}>{t('hmi.background')}</label>
      <input
        id={bgId}
        type="color"
        value={p.sc.background}
        onChange={(e) => p.onChange((sc) => void (sc.background = e.target.value))}
      />
    </div>
  );
}

function ObjectProps(p: {
  o: HmiObject;
  dev: PlcDevice;
  screens: HmiScreen[];
  problem: string | null;
  onChange(fn: (o: HmiObject) => void): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const { o } = p;
  const ids = { format: useId(), action: useId(), screen: useId(), on: useId(), off: useId() };
  const pos = (key: 'x' | 'y' | 'w' | 'h', label: string) => (
    <NumberField
      label={label}
      value={o[key]}
      validate={(n) =>
        n < (key === 'x' || key === 'y' ? 0 : 1) || n > HMI_MAX_SIZE ? t('hmi.sizeRange') : null
      }
      onCommit={(n) => p.onChange((x) => void (x[key] = n))}
    />
  );
  const num = (key: 'min' | 'max', label: string) => (
    <TextField
      label={label}
      value={String(o[key] ?? 0)}
      validate={(v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? null : t('hmi.number'))}
      onCommit={(v) => p.onChange((x) => void (x[key] = Number(v)))}
    />
  );
  const hasTag = o.kind !== 'text' && o.kind !== 'screenButton';
  return (
    <div className="baa-props">
      <TextField label={t('hmi.kindLabel')} value={t(`hmi.kind.${o.kind}`)} disabled />
      {o.kind !== 'bar' ? (
        <TextField
          label={t('hmi.text')}
          value={o.text}
          onCommit={(v) => p.onChange((x) => void (x.text = v))}
        />
      ) : null}
      {hasTag ? (
        <TagField
          dev={p.dev}
          value={o.tag ?? ''}
          problem={p.problem}
          onCommit={(v) => p.onChange((x) => void (x.tag = v.trim()))}
        />
      ) : null}
      {o.kind === 'ioField' ? (
        <>
          <label htmlFor={ids.format}>{t('hmi.format')}</label>
          <select
            id={ids.format}
            value={o.format ?? 'INT'}
            onChange={(e) => p.onChange((x) => void (x.format = e.target.value as HmiFormat))}
          >
            {HMI_FORMATS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <CheckField
            label={t('hmi.input')}
            checked={o.input === true}
            onChange={(v) => p.onChange((x) => void (x.input = v))}
          />
        </>
      ) : null}
      {o.kind === 'button' ? (
        <>
          <label htmlFor={ids.action}>{t('hmi.action')}</label>
          <select
            id={ids.action}
            value={o.action ?? 'set'}
            onChange={(e) => p.onChange((x) => void (x.action = e.target.value as HmiButtonAction))}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`hmi.actions.${a}`)}
              </option>
            ))}
          </select>
          {o.action === 'write' ? (
            <TextField
              label={t('hmi.value')}
              value={o.value ?? ''}
              onCommit={(v) => p.onChange((x) => void (x.value = v.trim()))}
            />
          ) : null}
        </>
      ) : null}
      {o.kind === 'lamp' ? (
        <>
          <label htmlFor={ids.on}>{t('hmi.onColor')}</label>
          <input
            id={ids.on}
            type="color"
            value={o.onColor ?? '#2ecc40'}
            onChange={(e) => p.onChange((x) => void (x.onColor = e.target.value))}
          />
          <label htmlFor={ids.off}>{t('hmi.offColor')}</label>
          <input
            id={ids.off}
            type="color"
            value={o.offColor ?? '#555555'}
            onChange={(e) => p.onChange((x) => void (x.offColor = e.target.value))}
          />
        </>
      ) : null}
      {o.kind === 'bar' ? (
        <>
          {num('min', t('hmi.min'))}
          {num('max', t('hmi.max'))}
        </>
      ) : null}
      {o.kind === 'screenButton' ? (
        <>
          <label htmlFor={ids.screen}>{t('hmi.target')}</label>
          <select
            id={ids.screen}
            value={o.screen ?? ''}
            onChange={(e) =>
              p.onChange((x) => {
                if (e.target.value) x.screen = e.target.value;
                else delete x.screen;
              })
            }
          >
            <option value="">{t('hmi.noTarget')}</option>
            {p.screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {pos('x', 'X')}
      {pos('y', 'Y')}
      {pos('w', t('hmi.width'))}
      {pos('h', t('hmi.height'))}
      <span />
      <button type="button" onClick={p.onDelete} data-testid="hmi-delete">
        {t('hmi.delete')}
      </button>
    </div>
  );
}

/** Variabile con completamento: gli stessi simboli e membri di DB dell'editor AWL. */
function TagField(p: {
  dev: PlcDevice;
  value: string;
  problem: string | null;
  onCommit(v: string): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? p.value;
  const ctx = useMemo(() => createAwlContext(p.dev, '', findCpu(p.dev.cpu.typeId)), [p.dev]);
  const options = useMemo(() => {
    if (draft === null) return [];
    const r = completeOperand(ctx, text, 0);
    return r.options.slice(0, 50).map((o) => text.slice(0, r.from) + o.apply);
  }, [ctx, text, draft]);
  const commit = () => {
    if (draft !== null && draft !== p.value) p.onCommit(draft);
    setDraft(null);
  };
  return (
    <>
      <label htmlFor={id}>{t('hmi.tag')}</label>
      <input
        id={id}
        list={`${id}-list`}
        value={text}
        aria-invalid={p.problem ? true : undefined}
        aria-describedby={p.problem ? `${id}-diag` : undefined}
        onFocus={() => setDraft(p.value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') setDraft(p.value);
        }}
      />
      <datalist id={`${id}-list`}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {p.problem ? (
        <span id={`${id}-diag`} className="baa-field-error">
          {p.problem}
        </span>
      ) : null}
    </>
  );
}
