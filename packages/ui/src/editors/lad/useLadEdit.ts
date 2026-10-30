// Modifiche alla rete comuni alle viste KOP e FUP: dove inserire, inserimenti, rami, cancellazione.
// Le due viste mappano i loro gesti su queste stesse operazioni, quindi generano lo stesso AWL.
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BOX_CATALOG,
  PALETTE,
  findElem,
  addOutput,
  closeBranchAfter,
  insertElem,
  openBranch,
  removeElem,
  updateElem,
} from '@baaportal/ladfbd';
import type { BoxKind, InsertPoint, LadElem, LadNetwork, LadOut } from '@baaportal/ladfbd';
import type { LadAction } from './ladKeys';
import type { CallParams } from './ladOps';
import {
  branchToClose,
  fieldPatch,
  fieldsOf,
  findNodeById,
  newBox,
  cloneFresh,
  nodeOfPoint,
  placeOf,
  rangeBetween,
} from './ladOps';

export const LAD_DRAG_TYPE = 'application/x-baaportal-lad';
/** Trascinamento di oggetti dall'albero del progetto (`beginDrag`), accettato per creare un CALL. */
export const TREE_DRAG_TYPE = 'application/x-baaportal';
const HISTORY_KEY = 'history.editLad';
/** Appunti interni di KOP e FUP: una serie contigua di elementi copiata o tagliata. */
let clipboard: LadElem[] = [];

export type LadSelection = { t: 'elem'; id: string } | { t: 'slot'; at: InsertPoint } | null;

/** Inserimento nella selezione dell'editor: lo usa la tavolozza delle istruzioni. */
export type LadInsertApi = {
  insertPalette: (paletteId: string) => void;
  insertBox: (kind: BoxKind) => void;
};

export type LadEditOpts = {
  net: LadNetwork;
  readOnly: boolean;
  onChange: (next: LadNetwork, labelKey: string) => void;
  newId: () => string;
  callParams?: CallParams;
  onActive?: (api: LadInsertApi, active: boolean) => void;
  callOfDrop?: (raw: string) => string | Promise<string | undefined> | undefined;
  /** Contenitore della vista: dopo una modifica il fuoco va all'elemento selezionato o a lui. */
  root: RefObject<HTMLElement | null>;
  /** Attributo `data-…` con l'id dell'elemento, per ritrovarlo nel DOM. */
  idAttr: string;
  /** Un campo di testo è aperto: il fuoco resta lì. */
  busy: boolean;
};

export function useLadEdit(o: LadEditOpts) {
  const { t } = useTranslation();
  const { net, readOnly, newId } = o;
  const [sel, setSelRaw] = useState<LadSelection>(null);
  /** Selezione multipla: l'ancora e gli id contigui della stessa serie (almeno due). */
  const [multi, setMulti] = useState<{ anchor: string; ids: string[] } | null>(null);
  const setSel = (s: LadSelection) => {
    setMulti(null);
    setSelRaw(s);
  };
  const [status, setStatus] = useState('');
  const wantFocus = useRef(false);
  const rootId = net.root.id;

  // Dopo un'azione da tastiera o dalla barra, il fuoco segue la selezione appena la rete è aggiornata.
  useEffect(() => {
    if (!wantFocus.current || o.busy) return;
    if (sel?.t !== 'elem') {
      wantFocus.current = false;
      o.root.current?.focus();
      return;
    }
    const el = o.root.current?.querySelector<HTMLElement>(`[${o.idAttr}="${sel.id}"]`);
    if (el) {
      wantFocus.current = false;
      el.focus();
    }
  });

  /** Dove inserire: dopo la selezione, nel punto scelto o in fondo alla serie principale. */
  function target(s: LadSelection = sel): { at: InsertPoint; nodeId: string } {
    if (s?.t === 'slot') return { at: s.at, nodeId: nodeOfPoint(net, s.at) ?? rootId };
    if (s?.t === 'elem') {
      const p = placeOf(net, s.id);
      if (p?.t === 'elem') return { at: p.at(p.index + 1), nodeId: p.nodeId };
      if (p?.t === 'out') {
        const len = findNodeById(net.root, p.nodeId)?.series.length ?? 0;
        return { at: { node: p.nodeId, index: len }, nodeId: p.nodeId };
      }
    }
    return { at: { node: rootId, index: net.root.series.length }, nodeId: rootId };
  }

  /** Esegue una modifica: una sola chiamata a `onChange`, oppure un messaggio se non è possibile. */
  function apply(make: () => LadNetwork, next?: LadSelection, failKey = 'lad.cannotDo') {
    let result: LadNetwork;
    try {
      result = make();
    } catch (err) {
      // Le operazioni di modifica segnalano le posizioni impossibili con un Error «Rete KOP: …».
      if (!(err instanceof Error) || !err.message.startsWith('Rete KOP')) console.error(err);
      setStatus(t(failKey));
      return false;
    }
    setStatus('');
    o.onChange(result, HISTORY_KEY);
    if (next !== undefined) setSel(next);
    wantFocus.current = true;
    return true;
  }

  function insertNew(elem: LadElem, at = target().at) {
    apply(() => insertElem(net, at, elem), { t: 'elem', id: elem.id });
  }

  /** Voce della tavolozza (`PALETTE`): un'uscita va a fine linea del nodo, il resto in serie. */
  function insertPalette(paletteId: string, at?: InsertPoint) {
    const entry = PALETTE.find((p) => p.id === paletteId);
    if (!entry || readOnly) return;
    const el = { id: newId(), ...structuredClone(entry.preset) };
    const tg = at ? { at, nodeId: nodeOfPoint(net, at) ?? rootId } : target();
    if (entry.where === 'out') {
      apply(() => addOutput(net, tg.nodeId, el as LadOut), { t: 'elem', id: el.id });
    } else insertNew(el as LadElem, tg.at);
  }

  function insertBox(kind: BoxKind, at?: InsertPoint) {
    if (!readOnly) insertNew(newBox(kind, newId()), at);
  }

  const insertApi = useRef<LadInsertApi>({ insertPalette, insertBox });
  insertApi.current = { insertPalette: (id) => insertPalette(id), insertBox: (k) => insertBox(k) };
  const stableApi = useRef<LadInsertApi>({
    insertPalette: (id) => insertApi.current.insertPalette(id),
    insertBox: (k) => insertApi.current.insertBox(k),
  });
  const onActiveRef = useRef(o.onActive);
  onActiveRef.current = o.onActive;
  useEffect(() => {
    const api = stableApi.current;
    return () => onActiveRef.current?.(api, false);
  }, []);

  function addContact(neg: boolean) {
    insertNew({ id: newId(), k: 'contact', neg, op: '' });
  }

  function addCoil() {
    const { nodeId } = target();
    const node = findNodeById(net.root, nodeId);
    const empty = node?.outs.find((x) => !('series' in x) && x.k === 'coil' && x.op === '');
    if (empty) {
      setSel({ t: 'elem', id: empty.id });
      wantFocus.current = true;
      setStatus('');
      return;
    }
    const out: LadOut = { id: newId(), k: 'coil', op: '' };
    apply(() => addOutput(net, nodeId, out), { t: 'elem', id: out.id });
  }

  function addTBranch() {
    const { nodeId } = target();
    const contact: LadElem = { id: newId(), k: 'contact', neg: false, op: '' };
    const coil: LadOut = { id: newId(), k: 'coil', op: '' };
    const node = { id: newId(), series: [contact], outs: [coil] };
    apply(() => addOutput(net, nodeId, node), { t: 'elem', id: contact.id });
  }

  function doOpenBranch() {
    if (sel?.t !== 'elem' || placeOf(net, sel.id)?.t !== 'elem') return;
    const id = sel.id;
    let last = '';
    const gen = () => (last = newId());
    if (apply(() => openBranch(net, id, gen))) setSel({ t: 'elem', id: last });
  }

  /** F9: chiude l'ultimo ramo aperto prima dell'elemento selezionato, ricavato dal modello. */
  function doCloseBranch() {
    const from = sel?.t === 'elem' ? branchToClose(net, sel.id) : undefined;
    if (sel?.t !== 'elem' || !from) {
      setStatus(t('lad.cannotClose'));
      return;
    }
    const to = sel.id;
    apply(() => closeBranchAfter(net, from, to, newId), undefined, 'lad.cannotClose');
  }

  /** Maiusc/Ctrl+clic o Maiusc+frecce: estende la selezione fino a `id`, nella stessa serie. */
  function extendTo(id: string) {
    const anchor = multi?.anchor ?? (sel?.t === 'elem' ? sel.id : undefined);
    const ids = anchor ? rangeBetween(net, anchor, id) : undefined;
    if (!anchor || !ids) {
      setStatus(t('lad.cannotExtend'));
      return false;
    }
    setStatus(ids.length > 1 ? t('lad.multiSelected', { n: ids.length }) : '');
    setSelRaw({ t: 'elem', id });
    setMulti(ids.length > 1 ? { anchor, ids } : null);
    wantFocus.current = true;
    return true;
  }

  /** Elementi su cui agiscono elimina, copia e taglia: la selezione multipla o l'elemento solo. */
  function picked(): string[] {
    if (multi) return multi.ids;
    return sel?.t === 'elem' && sel.id !== rootId ? [sel.id] : [];
  }

  function doDelete() {
    const ids = picked();
    if (ids.length === 0) return;
    apply(() => ids.reduce((n, id) => removeElem(n, id, newId), net), null);
  }

  function clip(kind: 'copy' | 'cut' | 'paste') {
    if (kind === 'paste') {
      if (readOnly || clipboard.length === 0) return;
      const at = target().at;
      const fresh = clipboard.map((e) => cloneFresh(e, newId));
      apply(
        () => fresh.reduce((n, e, i) => insertElem(n, { ...at, index: at.index + i }, e), net),
        { t: 'elem', id: fresh.at(-1)!.id },
      );
      return;
    }
    const ids = picked();
    if (ids.length === 0) return;
    // solo elementi di serie: un'uscita incollata in serie farebbe una rete non valida
    if (ids.some((id) => placeOf(net, id)?.t !== 'elem')) {
      setStatus(t('lad.cannotDo'));
      return;
    }
    clipboard = ids.map((id) => structuredClone(findElem(net, id) as LadElem));
    setStatus(t('lad.copied', { n: ids.length }));
    if (kind === 'cut' && !readOnly) doDelete();
  }

  /** Azioni di modifica dei tasti (`ladAction`); spostamento e modifica dell'operando sono della vista. */
  function run(a: LadAction) {
    if (readOnly) return;
    if (a === 'contactNo') addContact(false);
    else if (a === 'contactNc') addContact(true);
    else if (a === 'coil') addCoil();
    else if (a === 'tBranch') addTBranch();
    else if (a === 'openBranch') doOpenBranch();
    else if (a === 'closeBranch') doCloseBranch();
    else if (a === 'delete') doDelete();
  }

  /** Un blocco dall'albero diventa un box CALL con i pin del blocco chiamato. */
  function insertCall(instance: string, at: InsertPoint) {
    const box = newBox('CALL', newId());
    const fld = fieldsOf(box).find((f) => f.key === 'instance');
    const patch = fld ? fieldPatch(box, fld, instance, o.callParams) : { instance };
    apply(() => updateElem(insertElem(net, at, box), box.id, patch), { t: 'elem', id: box.id });
  }

  const accepts = (types: readonly string[]) =>
    !readOnly &&
    (types.includes(LAD_DRAG_TYPE) || (!!o.callOfDrop && types.includes(TREE_DRAG_TYPE)));

  /** Rilascio dalla tavolozza o dall'albero nel punto `at`; `true` se il rilascio è accettato. */
  function drop(dt: DataTransfer, at: InsertPoint): boolean {
    if (readOnly) return false;
    const raw = dt.getData(LAD_DRAG_TYPE);
    if (!raw) {
      const tree = dt.getData(TREE_DRAG_TYPE);
      const instance = tree ? o.callOfDrop?.(tree) : undefined;
      if (instance === undefined) return false;
      // un FB senza DB di istanza: il box entra solo dopo la risposta alla finestra
      if (typeof instance === 'string') insertCall(instance, at);
      else void instance.then((i) => i !== undefined && insertCall(i, at));
      return true;
    }
    let payload: { palette?: string; box?: BoxKind };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return true;
    }
    if (payload.box && payload.box in BOX_CATALOG) insertBox(payload.box, at);
    else if (payload.palette) insertPalette(payload.palette, at);
    return true;
  }

  return {
    sel,
    setSel,
    multi,
    extendTo,
    clip,
    status,
    setStatus,
    wantFocus,
    target,
    apply,
    insertBox,
    addContact,
    addCoil,
    addTBranch,
    doOpenBranch,
    doCloseBranch,
    run,
    accepts,
    drop,
    api: stableApi.current,
  };
}
