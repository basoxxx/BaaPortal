import { findDevice } from '@baaportal/project';
import type { MonitorRequest } from '@baaportal/sim';
import { contextHashOf, hashOf } from '../project/compile/compileActions';
import type { AppState, MonitorReason } from '../state/store';

/** Un blocco di codice (OB, FB, FC) del PLC simulato, aperto in un editor visibile. */
export interface ActiveBlock extends MonitorRequest {
  deviceId: string;
  blockId: string;
}

/** I blocchi di codice degli editor attivi dei riquadri visibili, prima quello del riquadro con il fuoco. */
export function visibleCodeBlocks(s: AppState): ActiveBlock[] {
  const { sim, doc, workArea: wa } = s;
  if (sim.phase !== 'on' || !sim.deviceId || !doc) return [];
  const order: (0 | 1)[] = wa.split === 'none' ? [0] : wa.focusedPane === 0 ? [0, 1] : [1, 0];
  const out: ActiveBlock[] = [];
  for (const i of order) {
    const key = wa.panes[i];
    const ed = key ? wa.editors.find((e) => e.key === key) : undefined;
    if (!ed || ed.kind !== 'block' || ed.deviceId !== sim.deviceId) continue;
    const found = codeBlockOf(s, ed.deviceId, ed.objectId);
    if (found) out.push(found);
  }
  return out;
}

/** Il blocco di codice del riquadro con il fuoco (altrimenti del primo riquadro visibile che ne ha uno). */
export const activeCodeBlock = (s: AppState): ActiveBlock | undefined => visibleCodeBlocks(s)[0];

export function codeBlockOf(
  s: AppState,
  deviceId: string,
  blockId: string,
): ActiveBlock | undefined {
  const dev = s.doc && findDevice(s.doc.project, deviceId);
  const b = dev?.blocks.find((x) => x.id === blockId);
  if (!b || (b.kind !== 'OB' && b.kind !== 'FB' && b.kind !== 'FC')) return undefined;
  return { deviceId, blockId, kind: b.kind, number: b.number };
}

/** L'editor del blocco osservato è ancora visibile in un riquadro (cambiare blocco o chiuderlo ferma l'osservazione). */
export function monitorStillShown(s: AppState, deviceId: string, blockId: string): boolean {
  return visibleCodeBlocks(s).some((a) => a.deviceId === deviceId && a.blockId === blockId);
}

/**
 * Se il blocco si può osservare: caricato nel simulatore, con l'impronta di adesso (contenuto e
 * contesto) sia nel simulatore sia nella compilazione, e con la mappa delle righe (un blocco
 * importato non modificato non ce l'ha). Il testo non ancora confermato nell'editor è a parte (`edited`).
 */
export function monitorReasonOf(s: AppState, deviceId: string, blockId: string): MonitorReason {
  const dev = s.doc && findDevice(s.doc.project, deviceId);
  const b = dev?.blocks.find((x) => x.id === blockId);
  if (!dev || !b) return 'notLoaded';
  const loaded = s.sim.loaded[blockId];
  if (loaded === undefined) return 'notLoaded';
  const now = hashOf(b, contextHashOf(dev));
  if (loaded !== now || s.compile.hashes[blockId] !== now) return 'stale';
  return s.compile.lines[blockId] ? 'ok' : 'noLines';
}
