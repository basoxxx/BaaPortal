import { useSyncExternalStore } from 'react';
import type { BaaBridge } from '../bridge';
import { getSettings, subscribeSettings } from '../settings/settings';
import type { UpdateEvent, UpdateInfoView } from './updateTypes';

/** Ciò che l'avviso mostra. */
export type Notice =
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'macReady'; version: string }
  | { kind: 'none'; version: string }
  | { kind: 'error'; message: string };

export interface UpdateUiState {
  info: UpdateInfoView | null;
  notice: Notice | null;
  /** Riga in più sotto il testo (es. attesa di un'operazione sul PLC). */
  message: string | null;
}

const NONE_MS = 5000;
const EMPTY: UpdateUiState = { info: null, notice: null, message: null };

let state: UpdateUiState = EMPTY;
let bridge: BaaBridge | null = null;
let knownVersion: string | null = null;
let noneTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(p: Partial<UpdateUiState>): void {
  state = { ...state, ...p };
  for (const l of [...listeners]) l();
}

export const getUpdateState = (): UpdateUiState => state;

export function useUpdateState(): UpdateUiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

function clearNoneTimer(): void {
  if (noneTimer) clearTimeout(noneTimer);
  noneTimer = null;
}

function applyEvent(e: UpdateEvent): void {
  clearNoneTimer();
  switch (e.type) {
    case 'checking':
      return;
    case 'none':
      set({ notice: { kind: 'none', version: state.info?.current ?? '' }, message: null });
      noneTimer = setTimeout(() => {
        if (state.notice?.kind === 'none') set({ notice: null });
      }, NONE_MS);
      return;
    case 'available':
      knownVersion = e.version;
      set({ notice: { kind: 'available', version: e.version }, message: null });
      return;
    case 'progress':
      set({
        notice: {
          kind: 'downloading',
          version: knownVersion ?? '',
          transferred: e.transferred,
          total: e.total,
        },
        message: null,
      });
      return;
    case 'downloaded':
      knownVersion = e.version;
      set({ notice: { kind: 'downloaded', version: e.version }, message: null });
      return;
    case 'macReady':
      knownVersion = e.version;
      set({ notice: { kind: 'macReady', version: e.version }, message: null });
      return;
    case 'error':
      set({ notice: { kind: 'error', message: e.message }, message: null });
      return;
    case 'cancelled':
      set({
        notice: knownVersion ? { kind: 'available', version: knownVersion } : null,
        message: null,
      });
  }
}

/** Avvio: legge le informazioni, ricostruisce l'avviso, manda le impostazioni al main e ascolta. */
export function startUpdates(b: BaaBridge): () => void {
  bridge = b;
  state = EMPTY;
  knownVersion = null;
  let disposed = false;
  const unsubscribeEvents = b.onUpdateEvent((e) => {
    if (!disposed) applyEvent(e);
  });
  let lastSent = '';
  const sendPrefs = () => {
    const u = getSettings().updates;
    const key = JSON.stringify(u);
    if (key === lastSent) return;
    lastSent = key;
    void b.updateSetPrefs(u).catch(() => undefined);
  };
  const unsubscribeSettings = subscribeSettings(sendPrefs);
  void (async () => {
    try {
      const info = await b.updateInfo();
      if (disposed) return;
      set({ info });
      const last = await b.updateState();
      if (!disposed && last && !state.notice) applyEvent(last);
    } catch {
      /* senza informazioni gli aggiornamenti restano spenti */
    }
    if (!disposed) sendPrefs();
  })();
  return () => {
    disposed = true;
    unsubscribeEvents();
    unsubscribeSettings();
    clearNoneTimer();
    bridge = null;
    state = EMPTY;
  };
}

/** Controllo a mano (Guida e Software installato). */
export function checkNow(): void {
  void bridge?.updateCheck();
}
export function download(): void {
  void bridge?.updateDownload();
}
export function cancelDownload(): void {
  void bridge?.updateCancelDownload();
}
export function later(): void {
  const n = state.notice;
  if (n?.kind === 'available') void bridge?.updateLater(n.version);
  dismiss();
}
export function openNotes(version: string): void {
  void bridge?.updateOpenNotes(version);
}
export function showInFolder(): void {
  void bridge?.updateShowInFolder();
}
export function dismiss(): void {
  clearNoneTimer();
  set({ notice: null, message: null });
}
export function setMessage(message: string | null): void {
  set({ message });
}

/** «Riavvia e aggiorna»: PLC libero, poi domanda di salvataggio e chiusura online, poi installa. */
export async function installNow(
  prepare: () => Promise<boolean>,
  messages: { busy: string; notReady: string },
): Promise<void> {
  const b = bridge;
  if (!b) return;
  const can = await b.updateCanInstall();
  if (!can.ok) {
    set({ message: can.reason === 'busy' ? messages.busy : messages.notReady });
    return;
  }
  if (!(await prepare())) return;
  const r = await b.updateInstall();
  if (r && !r.ok) set({ message: r.reason === 'busy' ? messages.busy : messages.notReady });
}
