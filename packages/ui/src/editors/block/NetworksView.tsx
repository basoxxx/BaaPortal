import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkBlockCode, completeAt, type AwlDiagnostic, type Mnemonic } from '@baaportal/awl';
import { findCpu } from '@baaportal/catalog';
import { current } from 'immer';
import { emptyNetwork, networkStatus, type LadNetwork } from '@baaportal/ladfbd';
import { sclLineStatus } from '@baaportal/scl';
import {
  createAwlContext,
  findDevice,
  isGraphic,
  kopCallParams,
  kopSources,
  tempEnd,
  type CodeBlock,
  type Network,
  type PlcDevice,
} from '@baaportal/project';
import { CommitInput, CommitTextarea } from '../../components/CommitField';
import { ContextMenu } from '../../components/ContextMenu';
import { AwlEditor, type AwlEditorHandle } from '../awl/AwlEditor';
import { SclEditor } from '../scl/SclEditor';
import { sclComplete, sclProblems } from '../scl/sclExtensions';
import type { SclMonitor } from '../scl/sclMonitor';
import { sourceCodec } from '../source/sourceExtensions';
import { displayText } from '../awl/awlExtensions';
import { monitorLinesByNetwork, monitorLinesFromPlc } from '../awl/monitorExtension';
import { plcMonitorFor } from '../../online/plcMonitor';
import { offsetOfLineCol } from '../../project/navigation/sourceActions';
import { FupNetworkView } from '../fbd/FupNetworkView';
import { LadNetworkEditor } from '../lad/LadNetworkEditor';
import { setLadActive } from '../lad/ladActive';
import type { LadMonitor } from '../lad/ladMonitor';
import { callInstanceOf } from './callInstance';
import { convertAwl, convertToAwl } from './convertAwl';
import { hasRawLines, isLockedImport, lockedBannerKey } from './readOnlyImport';
import { useMnemonic } from '../awl/mnemonicPreference';
import { useShownTexts } from '../../state/shownText';
import { useAppStore, useServices } from '../../state/AppContext';

const newId = () => globalThis.crypto.randomUUID();
const CHECK_DELAY_MS = 250;
const NO_DIAGNOSTICS: AwlDiagnostic[] = [];
const shown = displayText;
const NO_MESSAGES = new Map<string, string[]>();

/** Testo non ancora confermato di un segmento, valido finché sorgente e mnemonica sono quelli da cui parte. */
interface Draft {
  base: string;
  mnemonic: Mnemonic;
  text: string;
}

interface Props {
  deviceId: string;
  blockId: string;
}

export function NetworksView({ deviceId, blockId }: Props) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const block = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, deviceId) : undefined;
    const b = dev?.blocks.find((x) => x.id === blockId);
    return b && b.kind !== 'DB' && b.kind !== 'IDB' ? b : undefined;
  });
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const [mnemonic] = useMnemonic();
  const isAwl = block?.language === 'AWL';
  const isKop = block ? isGraphic(block.language) : false;
  const isScl = block?.language === 'SCL';
  const isFup = block?.language === 'FUP';
  // Il contesto del controllo si rifà a ogni revisione del dispositivo, non a ogni tasto.
  const awlCtx = useMemo(
    () =>
      dev && (isAwl || isKop) ? createAwlContext(dev, blockId, findCpu(dev.cpu.typeId)) : null,
    [dev, blockId, isAwl, isKop],
  );
  // SCL: errori del traduttore e del controllo AWL sul testo mostrato, alla riga SCL; completamento.
  const scl = useMemo(() => {
    if (!block || !dev || !isScl) return undefined;
    const ctx = createAwlContext(dev, blockId, findCpu(dev.cpu.typeId));
    const end = tempEnd(block, dev);
    return {
      check: (text: string) =>
        sclProblems(text, ctx, end, (d) => t(`awl.diag.${d.code}`, d.params ?? {})),
      complete: (offset: number, text: string) => sclComplete(text, offset, ctx),
    };
  }, [block, dev, blockId, isScl, t]);
  // Segmenti KOP: la sorgente generata di ognuno, con le righe per elemento e le diagnostiche.
  const kop = useMemo(
    () => (block && dev && (isKop || isScl) ? kopSources(block, dev) : null),
    [block, dev, isKop, isScl],
  );
  const callParams = useMemo(
    () => (block && dev && isKop ? kopCallParams(block, dev) : undefined),
    [block, dev, isKop],
  );
  // La rete vuota di un segmento senza `lad` resta la stessa finché non si modifica (poi diventa sua).
  const placeholders = useRef(new Map<string, LadNetwork>());
  const placeholder = (id: string): LadNetwork => {
    let net = placeholders.current.get(id);
    if (!net) placeholders.current.set(id, (net = emptyNetwork(newId)));
    return net;
  };
  const [awlShown, setAwlShown] = useState<ReadonlySet<string>>(new Set());
  // Osservazione (simulatore): i valori valgono solo se disponibile e senza testo non confermato.
  const mon = useAppStore((s) =>
    s.sim.monitor?.blockId === blockId && s.sim.monitor.deviceId === deviceId
      ? s.sim.monitor
      : null,
  );
  const monSteps = useAppStore((s) => s.sim.monitorSteps);
  const monHex = useAppStore((s) => s.sim.monitorHex);
  const lineMap = useAppStore((s) => s.compile.lines[blockId]);
  const monLines = useMemo(
    () =>
      mon && mon.reason === 'ok' && !mon.edited && monSteps && lineMap
        ? monitorLinesByNetwork(lineMap, monSteps, monHex)
        : null,
    [mon, monSteps, monHex, lineMap],
  );
  // Osservazione sulla CPU: stessi valori, dalla CPU invece che dal simulatore.
  const plcMon = useAppStore((s) =>
    s.online.monitor?.blockId === blockId && s.online.monitor.deviceId === deviceId
      ? s.online.monitor
      : null,
  );
  const plcLines = useAppStore((s) => s.online.monitorLines);
  const plcUnsure = useAppStore((s) => s.online.monitorLinesUnsure === true);
  const plcShown = !!plcMon && (plcMon.reason === 'ok' || plcMon.reason === 'waiting');
  const plcLinesShown = useMemo(
    () => (plcShown && plcLines && lineMap ? monitorLinesFromPlc(lineMap, plcLines, monHex) : null),
    [plcShown, plcLines, lineMap, monHex],
  );
  const monShown = plcLinesShown ?? monLines;
  // Osservazione dei segmenti grafici: lo stato per riga dell'AWL generato, sugli elementi. Si
  // ricalcola solo quando cambiano i dati osservati o il grafico, così ogni segmento riceve lo
  // stesso oggetto tra un render e l'altro. Online contano solo le reti nella finestra (le altre
  // non hanno celle).
  const blockNets = block?.networks;
  const ladMonitors = useMemo(
    () =>
      blockNets?.map((n, i): LadMonitor | undefined => {
        const m = monShown?.get(i);
        const r = kop?.[i];
        if (!m || !r || !n.lad) return undefined;
        const nullUnknown = plcLinesShown !== null && plcUnsure;
        return { status: networkStatus(n.lad, r.lines, m.cells, { nullUnknown }), hex: m.hex };
      }),
    [blockNets, monShown, kop, plcLinesShown, plcUnsure],
  );
  // Osservazione di un blocco SCL (un solo testo, segmento 0): i valori per riga SCL.
  const sclLines = kop?.[0]?.scl?.lines;
  const sclMonitor = useMemo((): SclMonitor | null => {
    const m = monShown?.get(0);
    if (!isScl || !m || !sclLines) return null;
    const nullUnknown = plcLinesShown !== null && plcUnsure;
    return { status: sclLineStatus(sclLines, m.cells, { nullUnknown }), hex: m.hex };
  }, [isScl, monShown, sclLines, plcLinesShown, plcUnsure]);
  const [sclView, setSclView] = useState<[number, number] | null>(null);
  const onSclVisible = useCallback((a: number, b: number) => setSclView([a, b]), []);
  const drafts = useRef(new Map<string, Draft>());
  /** Il testo non confermato sospende l'osservazione finché c'è (poi vale il confronto delle impronte). */
  const markEdited = useCallback(() => {
    const m = store.getState().sim.monitor;
    const edited = drafts.current.size > 0;
    plcMonitorFor(store, bridge).setEdited(blockId, edited);
    if (m && m.blockId === blockId && m.deviceId === deviceId && m.edited !== edited)
      store.getState().setSim({ monitor: { ...m, edited } });
  }, [store, bridge, blockId, deviceId]);
  // Se all'accensione c'è già una bozza, l'osservazione parte sospesa.
  const monitored = mon !== null || plcMon !== null;
  useEffect(() => {
    if (monitored) markEdited();
  }, [monitored, markEdited]);
  // Con l'osservazione sulla CPU, le reti visibili decidono la finestra delle righe osservate.
  const root = useRef<HTMLDivElement>(null);
  const plcOn = plcMon !== null;
  const netCount = block?.networks.length ?? 0;
  useEffect(() => {
    if (!plcOn || isScl) return;
    const ctrl = plcMonitorFor(store, bridge);
    const all = Array.from({ length: netCount }, (_, i) => i);
    const els = root.current?.querySelectorAll<HTMLElement>('[data-net]');
    if (typeof IntersectionObserver === 'undefined' || !els) {
      ctrl.setVisible(blockId, all);
      return;
    }
    const seen = new Set<number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset['net']);
        if (e.isIntersecting) seen.add(n);
        else seen.delete(n);
      }
      ctrl.setVisible(
        blockId,
        [...seen].sort((a, b) => a - b),
      );
    });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [plcOn, isScl, netCount, store, bridge, blockId]);
  // SCL: la finestra parte dalla prima riga AWL delle righe SCL visibili.
  useEffect(() => {
    if (!plcOn || !isScl) return;
    const ctrl = plcMonitorFor(store, bridge);
    if (!sclView || !sclLines) return ctrl.setVisible(blockId, [0]);
    const [a, b] = sclView;
    const own = sclLines.filter((l) => l.sclLine >= a && l.sclLine <= b).map((l) => l.line);
    if (own.length === 0) ctrl.setVisible(blockId, []);
    else ctrl.setVisible(blockId, [0], { network: 0, line: Math.min(...own) });
  }, [plcOn, isScl, sclView, sclLines, store, bridge, blockId]);
  const handles = useRef(new Map<string, AwlEditorHandle>());
  const tx = useShownTexts();
  // Le diagnostiche di ogni segmento: un segmento che non cambia tiene lo stesso array, e il suo editor non ricalcola.
  // Chiavi per id del segmento: se un segmento viene inserito o tolto, i problemi restano ai loro segmenti.
  const [byNetwork, setByNetwork] = useState<Record<string, AwlDiagnostic[]>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: Element } | null>(
    null,
  );

  const edit = useCallback(
    (labelKey: string, recipe: (block: CodeBlock, dev: PlcDevice) => void) =>
      store.getState().edit(labelKey, (p) => {
        const dev = findDevice(p, deviceId);
        const b = dev?.blocks.find((x) => x.id === blockId);
        // Un blocco importato non ricodificabile non si modifica.
        if (dev && b && b.kind !== 'DB' && b.kind !== 'IDB' && !isLockedImport(b)) recipe(b, dev);
      }),
    [store, deviceId, blockId],
  );
  /** Le etichette automatiche sono per blocco: ogni modifica ai segmenti riscrive la sorgente di tutti. */
  const refreshKopSources = (b: CodeBlock, d: PlcDevice) => {
    const sources = kopSources(current(b), d);
    b.networks.forEach((x, i) => {
      x.source = sources[i]?.source ?? x.source;
    });
  };
  const editNetwork = (id: string, field: 'title' | 'comment' | 'source', value: string) =>
    edit('history.editNetwork', (b) => {
      const n = b.networks.find((x) => x.id === id);
      if (n) n[field] = value;
    });
  /** Una modifica del grafico riscrive la sorgente di tutti i segmenti (le etichette sono per blocco). */
  const editLad = (id: string, next: LadNetwork, labelKey: string) =>
    edit(labelKey, (b, d) => {
      const n = b.networks.find((x) => x.id === id);
      if (!n) return;
      n.lad = next;
      refreshKopSources(b, d);
    });
  // Stesso cambio del comando block.switchLanguage, ma sul blocco di questa vista (non del riquadro con il fuoco).
  const switchLanguage = () =>
    edit('history.switchLanguage', (b) => {
      b.language = b.language === 'KOP' ? 'FUP' : 'KOP';
    });
  const insert = () =>
    edit('history.addNetwork', (b, d) => {
      const fresh: Network = { id: newId(), title: '', comment: '', source: '' };
      if (isGraphic(b.language)) fresh.lad = emptyNetwork(newId);
      const at = b.networks.findIndex((x) => x.id === focusedId);
      b.networks.splice(at < 0 ? b.networks.length : at + 1, 0, fresh);
      if (isGraphic(b.language)) refreshKopSources(b, d);
    });
  const remove = (id: string) =>
    edit('history.deleteNetwork', (b, d) => {
      if (b.networks.length <= 1) return;
      b.networks = b.networks.filter((x) => x.id !== id);
      if (isGraphic(b.language)) refreshKopSources(b, d);
    });

  const networks = block?.networks;
  /** I testi mostrati di tutti i segmenti, con la bozza al posto del testo salvato. */
  const textsShown = (override?: { index: number; text: string }): string[] =>
    (networks ?? []).map((n, i) => {
      if (override && override.index === i) return override.text;
      if (kop) return shown(kop[i]?.source ?? n.source, mnemonic);
      const d = drafts.current.get(n.id);
      return d && d.base === n.source && d.mnemonic === mnemonic
        ? d.text
        : shown(n.source, mnemonic);
    });
  // Il controllo gira 250 ms dopo l'ultima modifica; le bozze stanno in un ref, quindi scrivere non ridisegna i segmenti.
  const latest = useRef({ awlCtx, networks, mnemonic, textsShown });
  useEffect(() => {
    latest.current = { awlCtx, networks, mnemonic, textsShown };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleCheck = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const l = latest.current;
      const nets = l.networks ?? [];
      const next: Record<string, AwlDiagnostic[]> = {};
      for (const n of nets) next[n.id] = [];
      if (l.awlCtx && l.networks) {
        for (const d of checkBlockCode(l.textsShown(), l.awlCtx, l.mnemonic))
          next[nets[d.network]?.id ?? '']?.push(d);
      }
      setByNetwork((prev) => {
        const merged: Record<string, AwlDiagnostic[]> = {};
        for (const [id, arr] of Object.entries(next)) {
          const old = prev[id];
          merged[id] = old && JSON.stringify(old) === JSON.stringify(arr) ? old : arr;
        }
        const keys = Object.keys(merged);
        const same =
          keys.length === Object.keys(prev).length && keys.every((id) => merged[id] === prev[id]);
        return same ? prev : merged;
      });
    }, CHECK_DELAY_MS);
  }, []);
  useEffect(() => {
    scheduleCheck();
  }, [awlCtx, networks, mnemonic, kop, scheduleCheck]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Un clic su un messaggio di compilazione porta il cursore a rete e riga (come i Problemi).
  const reveal = useAppStore((s) => s.compileReveal);
  useEffect(() => {
    if (!reveal || reveal.blockId !== blockId || reveal.deviceId !== deviceId || !block) return;
    const n = reveal.network > 0 ? block.networks[reveal.network - 1] : undefined;
    const handle = n && handles.current.get(n.id);
    if (reveal.elemId) {
      // Elemento del grafico KOP/FUP: lo stesso clic e fuoco dell'utente lo selezionano.
      const el = root.current?.querySelector<HTMLElement>(
        `[data-lad-id="${reveal.elemId}"],[data-fup-id="${reveal.elemId}"]`,
      );
      el?.click();
      el?.focus();
      el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } else if (handle && reveal.range) handle.selectRange(reveal.range.from, reveal.range.to);
    else if (handle) handle.focusAt(offsetOfLineCol(handle.getText(), Math.max(reveal.line, 1), 1));
    store.getState().clearCompileReveal(reveal.n);
  }, [reveal, block, blockId, deviceId, store]);

  // Problemi di un blocco KOP: le diagnostiche del grafico e quelle dell'AWL generato, che
  // tornano sull'elemento che ha prodotto la riga.
  const kopMessages = useMemo(
    () =>
      (networks ?? []).map((n, i) => {
        const byElem = new Map<string, string[]>();
        const loose: string[] = [];
        const res = kop?.[i];
        if (!res) return { byElem, loose };
        const add = (elemId: string | undefined, msg: string) => {
          if (elemId === undefined) loose.push(msg);
          else byElem.set(elemId, [...(byElem.get(elemId) ?? []), msg]);
        };
        for (const d of res.diagnostics) add(d.elemId, t(`lad.diag.${d.code}`, d.params ?? {}));
        for (const d of byNetwork[n.id] ?? NO_DIAGNOSTICS) {
          const line = d.range.from.line;
          const owner = res.lines.filter((l) => l.line <= line).at(-1);
          add(owner?.elemId, t(`awl.diag.${d.code}`, d.params ?? {}));
        }
        return { byElem, loose };
      }),
    [networks, kop, byNetwork, t],
  );
  if (!block) return null;
  const locked = isLockedImport(block);
  const editHeader = (field: 'title' | 'comment', value: string) =>
    edit('history.editBlockHeader', (b) => {
      b.header[field] = value;
    });
  const only = block.networks.length <= 1;
  // I problemi nell'ordine attuale dei segmenti; la posizione è quella di adesso, non quella del controllo.
  const problems = block.networks.flatMap((n, i) =>
    (byNetwork[n.id] ?? NO_DIAGNOSTICS).map((d) => ({ d, id: n.id, pos: i + 1 })),
  );
  const kopProblems = kopMessages.flatMap((m, i) =>
    [
      ...[...m.byElem].flatMap(([elemId, ms]) => ms.map((message) => ({ elemId, message }))),
      ...m.loose.map((message) => ({ elemId: undefined, message })),
    ].map(({ elemId, message }) => ({ pos: i + 1, message, elemId })),
  );
  /** Voce del menu di un segmento AWL di un blocco KOP/FUP: lo converte in grafico. */
  const convertItem = (id: string) => {
    const at = block.networks.findIndex((x) => x.id === id);
    const n = block.networks[at];
    return {
      id: 'convert',
      label: t('block.convertNetwork'),
      disabled: locked || !n || !!n.lad || n.source.trim() === '',
      run: () => convertAwl(store, deviceId, blockId, at),
    };
  };
  /** Voce del menu di un segmento grafico: diventa un segmento AWL modificabile. */
  const toAwlItem = (id: string) => {
    const at = block.networks.findIndex((x) => x.id === id);
    return {
      id: 'convertToAwl',
      label: t('block.convertNetworkToAwl'),
      disabled: locked || !block.networks[at]?.lad,
      run: () => convertToAwl(store, deviceId, blockId, at),
    };
  };
  const onDraft = (n: Network, text: string) => {
    if (text === shown(n.source, mnemonic)) drafts.current.delete(n.id);
    else drafts.current.set(n.id, { base: n.source, mnemonic, text });
    markEdited();
    scheduleCheck();
  };
  const commitCode = (id: string, stored: string) => {
    drafts.current.delete(id);
    edit('history.editNetworkCode', (b) => {
      const n = b.networks.find((x) => x.id === id);
      if (n) n.source = stored;
    });
    markEdited();
  };
  return (
    <div className="baa-block-networks" ref={root}>
      {locked ? (
        <p className="baa-readonly-banner" role="note" data-testid="readonly-banner">
          {t(lockedBannerKey(block))}
        </p>
      ) : null}
      {tx.lang ? (
        <p className="baa-readonly-banner" role="note" data-testid="texts-banner">
          {t('texts.viewBanner', { lang: tx.lang })}
        </p>
      ) : null}
      <div className="baa-block-header">
        <label>
          <span>{t('block.title')}</span>
          <CommitInput
            value={tx.shown(deviceId, block.id, 'title', block.header.title)}
            readOnly={locked || tx.lang !== null}
            aria-label={t('block.title')}
            onCommit={(v) => editHeader('title', v)}
          />
        </label>
        <label>
          <span>{t('block.comment')}</span>
          <CommitTextarea
            value={tx.shown(deviceId, block.id, 'comment', block.header.comment)}
            readOnly={locked || tx.lang !== null}
            rows={2}
            aria-label={t('block.comment')}
            onCommit={(v) => editHeader('comment', v)}
          />
        </label>
      </div>
      <h4 className="baa-block-networks-title">{t('block.networks')}</h4>
      {isKop ? (
        <button type="button" className="baa-panel-btn" disabled={locked} onClick={switchLanguage}>
          {t(isFup ? 'block.toKop' : 'block.toFup')}
        </button>
      ) : null}
      {block.networks.map((n, i) => (
        <section
          key={n.id}
          className="baa-network"
          aria-label={t('block.network', { n: i + 1 })}
          data-net={i}
          onFocus={() => setFocusedId(n.id)}
        >
          <header className="baa-network-head">
            <strong>{t('block.network', { n: i + 1 })}</strong>
            <CommitInput
              value={tx.shown(deviceId, n.id, 'title', n.title)}
              readOnly={locked || tx.lang !== null}
              aria-label={`${t('block.networkTitle')} ${i + 1}`}
              onCommit={(v) => editNetwork(n.id, 'title', v)}
            />
            <button
              type="button"
              className="baa-panel-btn"
              aria-label={`${t('block.networkMenu')} ${i + 1}`}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ id: n.id, x: r.left, y: r.bottom, anchor: e.currentTarget });
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </header>
          <CommitTextarea
            value={tx.shown(deviceId, n.id, 'comment', n.comment)}
            readOnly={locked || tx.lang !== null}
            rows={1}
            aria-label={`${t('block.networkComment')} ${i + 1}`}
            onCommit={(v) => editNetwork(n.id, 'comment', v)}
          />
          {isAwl && hasRawLines(n.source) ? (
            <p className="baa-raw-hint" data-testid="raw-hint">
              {t('block.rawHint')}
            </p>
          ) : null}
          {isKop ? (
            n.lad || n.source === '' ? (
              <>
                {isFup ? (
                  <FupNetworkView
                    net={n.lad ?? placeholder(n.id)}
                    diagnostics={kopMessages[i]?.byElem ?? NO_MESSAGES}
                    readOnly={locked}
                    onChange={(next, key) => editLad(n.id, next, key)}
                    callParams={callParams}
                    onActive={(api, on) => setLadActive(api, on, { deviceId, blockId })}
                    callOfDrop={(raw) => callInstanceOf(dev, raw)}
                    monitor={ladMonitors?.[i]}
                  />
                ) : (
                  <LadNetworkEditor
                    net={n.lad ?? placeholder(n.id)}
                    index={i}
                    diagnostics={kopMessages[i]?.byElem ?? NO_MESSAGES}
                    readOnly={locked}
                    onChange={(next, key) => editLad(n.id, next, key)}
                    callParams={callParams}
                    onActive={(api, on) => setLadActive(api, on, { deviceId, blockId })}
                    callOfDrop={(raw) => callInstanceOf(dev, raw)}
                    monitor={ladMonitors?.[i]}
                  />
                )}
                <button
                  type="button"
                  className="baa-panel-btn"
                  aria-pressed={awlShown.has(n.id)}
                  onClick={() =>
                    setAwlShown((cur) => {
                      const next = new Set(cur);
                      if (!next.delete(n.id)) next.add(n.id);
                      return next;
                    })
                  }
                >
                  {t(awlShown.has(n.id) ? 'block.hideAwl' : 'block.showAwl')}
                </button>
              </>
            ) : (
              <p className="baa-raw-hint" data-testid="kop-awl-hint">
                {t('block.kopAwlOnly')}
              </p>
            )
          ) : null}
          {isKop && (awlShown.has(n.id) || (!n.lad && n.source !== '')) ? (
            <div className="baa-network-source">
              <AwlEditor
                value={kop?.[i]?.source ?? n.source}
                readOnly
                mnemonic={mnemonic}
                aria-label={`${t('block.source')} ${i + 1}`}
                diagnostics={byNetwork[n.id] ?? NO_DIAGNOSTICS}
                monitor={monShown?.get(i) ?? null}
                complete={(offset) => ({ from: offset, options: [] })}
                onCommit={() => {}}
              />
            </div>
          ) : null}
          {isAwl ? (
            <div className="baa-network-source">
              <AwlEditor
                value={n.source}
                readOnly={locked}
                mnemonic={mnemonic}
                aria-label={`${t('block.source')} ${i + 1}`}
                diagnostics={byNetwork[n.id] ?? NO_DIAGNOSTICS}
                monitor={monShown?.get(i) ?? null}
                complete={(offset, text) =>
                  awlCtx
                    ? completeAt(textsShown({ index: i, text }), i, offset, awlCtx, mnemonic)
                    : { from: offset, options: [] }
                }
                onChange={(text) => onDraft(n, text)}
                onCommit={(stored) => commitCode(n.id, stored)}
                ref={(h) => {
                  if (h) handles.current.set(n.id, h);
                  else handles.current.delete(n.id);
                }}
              />
            </div>
          ) : isKop ? null : (
            <div className="baa-network-source" title={t('block.sourceHint')}>
              <SclEditor
                value={n.source}
                readOnly={locked}
                aria-label={`${t('block.source')} ${i + 1}`}
                // Il testo SCL è solo nel segmento 0 (vedi kopSources).
                {...(scl && i === 0 ? scl : {})}
                onCommit={(v) => {
                  drafts.current.delete(n.id);
                  editNetwork(n.id, 'source', v);
                  markEdited();
                }}
                onChange={(text) => {
                  // come in AWL: il testo non confermato sospende l'osservazione
                  if (text === sourceCodec.toShown(n.source)) drafts.current.delete(n.id);
                  else drafts.current.set(n.id, { base: n.source, mnemonic, text });
                  markEdited();
                }}
                {...(i === 0 ? { monitor: sclMonitor } : {})}
                {...(i === 0 && plcOn ? { onVisibleLines: onSclVisible } : {})}
                ref={(h) => {
                  if (h) handles.current.set(n.id, h);
                  else handles.current.delete(n.id);
                }}
              />
            </div>
          )}
        </section>
      ))}
      {isAwl ? (
        <section className="baa-awl-problems-panel" aria-label={t('block.awlProblems')}>
          <h4 className="baa-block-networks-title">{t('block.awlProblems')}</h4>
          {problems.length === 0 ? (
            <p className="baa-prop-note">{t('block.awlNoProblems')}</p>
          ) : null}
          <ul
            className="baa-awl-problems"
            aria-label={t('block.awlProblems')}
            hidden={problems.length === 0}
          >
            {problems.map(({ d, id, pos }, k) => (
              <li key={k}>
                <button
                  type="button"
                  className={`is-${d.severity}`}
                  onClick={() => handles.current.get(id)?.focusAt(d.range.from.offset)}
                >
                  {t('block.awlProblemRow', {
                    n: pos,
                    line: d.range.from.line + 1,
                    message: t(`awl.diag.${d.code}`, d.params ?? {}),
                  })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {isKop ? (
        <section className="baa-awl-problems-panel" aria-label={t('block.awlProblems')}>
          <h4 className="baa-block-networks-title">{t('block.awlProblems')}</h4>
          {kopProblems.length === 0 ? (
            <p className="baa-prop-note">{t('block.awlNoProblems')}</p>
          ) : null}
          <ul
            className="baa-awl-problems"
            aria-label={t('block.awlProblems')}
            hidden={kopProblems.length === 0}
          >
            {kopProblems.map((p, k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() =>
                    store.getState().openBlockAt({
                      deviceId,
                      blockId,
                      network: p.pos,
                      line: 1,
                      ...(p.elemId ? { elemId: p.elemId } : {}),
                    })
                  }
                >
                  {t('lad.problemRow', { pos: p.pos, message: p.message })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {isScl ? null : (
        <button type="button" className="baa-block-insert" onClick={insert} disabled={locked}>
          {t('block.insertNetwork')}
        </button>
      )}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          label={t('block.networkMenu')}
          items={[
            ...(isKop ? [convertItem(menu.id), toAwlItem(menu.id)] : []),
            {
              id: 'delete',
              label: t('block.deleteNetwork'),
              disabled: only || locked,
              run: () => remove(menu.id),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
