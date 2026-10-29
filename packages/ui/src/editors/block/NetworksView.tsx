import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkBlockCode, completeAt, type AwlDiagnostic, type Mnemonic } from '@baaportal/awl';
import { findCpu } from '@baaportal/catalog';
import { current } from 'immer';
import { emptyNetwork, type LadNetwork } from '@baaportal/ladfbd';
import {
  createAwlContext,
  findDevice,
  isGraphic,
  kopCallParams,
  kopSources,
  type CodeBlock,
  type Network,
  type PlcDevice,
} from '@baaportal/project';
import { CommitInput, CommitTextarea } from '../../components/CommitField';
import { ContextMenu } from '../../components/ContextMenu';
import { AwlEditor, type AwlEditorHandle } from '../awl/AwlEditor';
import { CommittedEditor } from '../awl/CommittedEditor';
import { sourceCodec } from '../source/sourceExtensions';
import { displayText } from '../awl/awlExtensions';
import { monitorLinesByNetwork, monitorLinesFromPlc } from '../awl/monitorExtension';
import { plcMonitorFor } from '../../online/plcMonitor';
import { offsetOfLineCol } from '../../project/navigation/sourceActions';
import { FupNetworkView } from '../fbd/FupNetworkView';
import { LadNetworkEditor } from '../lad/LadNetworkEditor';
import { setLadActive } from '../lad/ladActive';
import { callInstanceOf } from './callInstance';
import { convertAwl } from './convertAwl';
import { hasRawLines, isLockedImport, lockedBannerKey } from './readOnlyImport';
import { useMnemonic } from '../awl/mnemonicPreference';
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
  const plcLinesShown =
    plcMon && (plcMon.reason === 'ok' || plcMon.reason === 'waiting') && plcLines && lineMap
      ? monitorLinesFromPlc(lineMap, plcLines, monHex)
      : null;
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
    if (!plcOn) return;
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
  }, [plcOn, netCount, store, bridge, blockId]);
  const handles = useRef(new Map<string, AwlEditorHandle>());
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
      <div className="baa-block-header">
        <label>
          <span>{t('block.title')}</span>
          <CommitInput
            value={block.header.title}
            readOnly={locked}
            aria-label={t('block.title')}
            onCommit={(v) => editHeader('title', v)}
          />
        </label>
        <label>
          <span>{t('block.comment')}</span>
          <CommitTextarea
            value={block.header.comment}
            readOnly={locked}
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
              value={n.title}
              readOnly={locked}
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
            value={n.comment}
            readOnly={locked}
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
                monitor={(plcLinesShown ?? monLines)?.get(i) ?? null}
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
                monitor={(plcLinesShown ?? monLines)?.get(i) ?? null}
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
              <CommittedEditor
                value={n.source}
                codec={sourceCodec}
                readOnly={locked}
                aria-label={`${t('block.source')} ${i + 1}`}
                onCommit={(v) => editNetwork(n.id, 'source', v)}
              />
              <ul className="baa-awl-problems" aria-label={t('block.sclProblems')}>
                {(kop?.[i]?.scl?.diagnostics ?? []).map((d, k) => (
                  <li key={k} className="is-error">
                    {t('block.sclProblemRow', { line: d.line, message: d.message })}
                  </li>
                ))}
              </ul>
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
            ...(isKop ? [convertItem(menu.id)] : []),
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
