import { DEFAULT_PANELS, type PanelName, type PanelState } from '../state/store';

export { DEFAULT_PANELS };

export const LAYOUT_KEY = 'baa.layout.v1';

const NAMES = Object.keys(DEFAULT_PANELS) as PanelName[];
const MIN_SIZE = 5;
const MAX_SIZE = 80;

function validPanel(v: unknown): v is PanelState {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p['open'] === 'boolean' &&
    typeof p['pinned'] === 'boolean' &&
    typeof p['size'] === 'number' &&
    p['size'] >= MIN_SIZE &&
    p['size'] <= MAX_SIZE
  );
}

/** Layout salvato; per ogni pannello con campi mancanti o fuori intervallo valgono i valori predefiniti. */
export function loadLayout(storage: Storage | null): Record<PanelName, PanelState> {
  let parsed: unknown;
  try {
    const raw = storage?.getItem(LAYOUT_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const src = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return Object.fromEntries(
    NAMES.map((n) => [n, validPanel(src[n]) ? { ...(src[n] as PanelState) } : { ...DEFAULT_PANELS[n] }]),
  ) as Record<PanelName, PanelState>;
}

export function saveLayout(storage: Storage | null, panels: Record<PanelName, PanelState>): void {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify(panels));
  } catch {
    /* spazio esaurito o storage non disponibile: il layout non viene ricordato */
  }
}
