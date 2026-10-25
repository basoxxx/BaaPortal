import type { StoreApi } from 'zustand/vanilla';
import { findDevice, findSource, type ObjectRef } from '@baaportal/project';
import { flushDetachedEdits, flushPendingEdits } from '../flushPendingEdits';
import { currentMnemonic } from '../editors/awl/mnemonicPreference';
import type { AppState } from '../state/store';
import { findInProject } from './findInProject';
import { replaceInProject } from './replaceInProject';
import type { FindOptions, Hit } from './types';

type Store = StoreApi<AppState>;

/** L'oggetto aperto nell'editor attivo (riquadro con il focus), se c'è. */
export function activeObjectRef(s: AppState): ObjectRef | null {
  const key = s.workArea.panes[s.workArea.focusedPane];
  const e = s.workArea.editors.find((x) => x.key === key);
  if (!e) return null;
  if (e.kind === 'allTags') return { kind: 'device', deviceId: e.deviceId };
  return { kind: e.kind === 'compare' ? 'block' : e.kind, deviceId: e.deviceId, id: e.objectId };
}

function optionsOf(s: AppState): FindOptions | null {
  const f = s.find;
  let scope: FindOptions['scope'] = { kind: 'project' };
  if (f.scope === 'active') {
    const ref = activeObjectRef(s);
    if (!ref) return null;
    scope = { kind: 'object', ref };
  }
  return {
    query: f.query,
    matchCase: f.matchCase,
    wholeWord: f.wholeWord,
    regex: f.regex,
    mnemonic: currentMnemonic(),
    scope,
  };
}

/** Cerca con le impostazioni correnti e salva l'esito (sul progetto di adesso). */
export function runFind(store: Store, selected: number | null = null): void {
  // Le finestre separate hanno un focus proprio: le loro bozze si confermano, il campo Trova resta com'è.
  flushDetachedEdits();
  const s = store.getState();
  if (!s.doc) return;
  const options = optionsOf(s);
  if (!options) return;
  const r = findInProject(s.doc.project, options);
  if (Array.isArray(r)) {
    s.patchFind({
      outcome: { kind: 'hits', hits: r, project: s.doc.project, options },
      selected: r.length > 0 ? Math.min(selected ?? 0, r.length - 1) : null,
    });
  } else {
    s.patchFind({ outcome: { kind: 'error', detail: r.detail }, selected: null });
  }
}

/** Apre la task card Trova e sostituisci e chiede il focus su un campo, col testo selezionato dentro. */
export function requestFind(store: Store, field: 'find' | 'replace', win: Window = window): void {
  const s = store.getState();
  const sel = win.getSelection()?.toString() ?? '';
  if (sel !== '' && !/[\r\n]/.test(sel) && sel.length <= 200) s.patchFind({ query: sel });
  s.setTaskCard('tasks');
  s.setPanel('taskCards', { open: true });
  s.setFindRequest({ field });
}

/** Dalla casella Ricerca della barra: cerca `text` in tutto il progetto. */
export function searchFromToolbar(store: Store, text: string): void {
  const s = store.getState();
  s.patchFind({ query: text, scope: 'project' });
  s.setTaskCard('tasks');
  s.setPanel('taskCards', { open: true });
  runFind(store);
}

const sameSpot = (a: Hit, b: Hit): boolean =>
  JSON.stringify(a.loc) === JSON.stringify(b.loc) && a.match === b.match;

/**
 * Sostituisce `only` (o tutti i risultati) in una sola modifica e racconta l'esito in Informazioni.
 * Lavora solo su risultati non scaduti: i loro offset sono quelli del progetto attuale.
 */
export function replaceHits(store: Store, only?: Hit[]): void {
  // Una bozza non confermata cambia il progetto: prima si conferma, poi si guarda se i risultati valgono.
  flushPendingEdits();
  const s = store.getState();
  const out = s.find.outcome;
  if (!s.doc || out?.kind !== 'hits' || out.project !== s.doc.project) return;
  if (out.options.mnemonic !== currentMnemonic()) return;
  const result = replaceInProject(s.doc.project, out.options, s.find.replacement, only ?? out.hits);
  if (result.replaced > 0) {
    s.edit('history.replace', (draft) => {
      // Solo i dispositivi toccati: la cronologia non tiene copie del resto.
      draft.devices.forEach((d, i) => {
        const next = result.project.devices[i]!;
        if (JSON.stringify(next) !== JSON.stringify(d)) draft.devices[i] = next;
      });
    });
  }
  s.pushMessage({
    severity: 'info',
    textKey: 'messages.replaced',
    params: { replaced: String(result.replaced), skipped: String(result.skipped) },
  });
  const prev = out.hits;
  const idx = only && only.length === 1 ? prev.indexOf(only[0]!) : 0;
  runFind(store, idx);
  // Se il testo sostituito contiene ancora la ricerca, il risultato nuovo è lo stesso punto: si va oltre.
  const after = store.getState().find;
  if (only && after.outcome?.kind === 'hits' && after.selected !== null) {
    const cur = after.outcome.hits[after.selected];
    // Un risultato saltato (o ancora lì dopo la sostituzione) non resta selezionato.
    if (
      cur &&
      (result.replaced === 0 || sameSpot(cur, only[0]!)) &&
      after.selected + 1 < after.outcome.hits.length
    )
      store.getState().patchFind({ selected: after.selected + 1 });
  }
}

/** Porta l'editor sul risultato: seleziona il testo, o la riga della variabile. */
export function openHit(store: Store, hit: Hit): void {
  const s = store.getState();
  const doc = s.doc;
  if (!doc) return;
  const l = hit.loc;
  if (l.kind === 'tag') {
    s.openEditor({ kind: 'tagTable', deviceId: l.deviceId, objectId: l.tableId });
    s.revealTag({ deviceId: l.deviceId, tableId: l.tableId, tagId: l.tagId });
    return;
  }
  if (l.kind === 'source') {
    const src = findSource(findDevice(doc.project, l.deviceId)!, l.sourceId);
    const raw = src?.text ?? '';
    // L'editor mostra il testo con a capo LF: gli offset si portano lì.
    const shownAt = (at: number): number =>
      raw.slice(0, raw[at - 1] === '\r' && raw[at] === '\n' ? at - 1 : at).replace(/\r\n?/g, '\n')
        .length;
    const before = raw.slice(0, l.from).replace(/\r\n?/g, '\n');
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    s.openSourceAt({
      deviceId: l.deviceId,
      sourceId: l.sourceId,
      line,
      col,
      range: { from: shownAt(l.from), to: shownAt(l.to) },
    });
    return;
  }
  const network = 'networkIndex' in l && l.networkIndex !== undefined ? l.networkIndex + 1 : 0;
  s.openBlockAt({
    deviceId: l.deviceId,
    blockId: l.blockId,
    network,
    line: 1,
    ...(l.kind === 'network' ? { range: { from: l.from, to: l.to } } : {}),
  });
}
