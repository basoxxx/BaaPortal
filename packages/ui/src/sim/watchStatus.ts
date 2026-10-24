import type { AppState } from '../state/store';

/** Le tabelle di controllo degli editor attivi dei riquadri visibili del PLC simulato. */
export function visibleWatchTables(s: AppState): { deviceId: string; tableId: string }[] {
  const { sim, doc, workArea: wa } = s;
  if (sim.phase !== 'on' || !sim.deviceId || !doc) return [];
  const order: (0 | 1)[] = wa.split === 'none' ? [0] : wa.focusedPane === 0 ? [0, 1] : [1, 0];
  const out: { deviceId: string; tableId: string }[] = [];
  for (const i of order) {
    const key = wa.panes[i];
    const ed = key ? wa.editors.find((e) => e.key === key) : undefined;
    if (ed?.kind === 'watchTable' && ed.deviceId === sim.deviceId) {
      out.push({ deviceId: ed.deviceId, tableId: ed.objectId });
    }
  }
  return out;
}

/** La tabella è aperta in un riquadro visibile (chiuderla o passare ad altro ferma l'osservazione). */
export const watchStillShown = (s: AppState, deviceId: string, tableId: string): boolean =>
  visibleWatchTables(s).some((w) => w.deviceId === deviceId && w.tableId === tableId);
