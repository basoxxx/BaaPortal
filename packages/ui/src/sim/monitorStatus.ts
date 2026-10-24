import { findDevice } from '@baaportal/project';
import type { MonitorRequest } from '@baaportal/sim';
import { contextHashOf, hashOf } from '../project/compile/compileActions';
import type { AppState, MonitorReason } from '../state/store';

/** Un blocco di codice (OB, FB, FC) del PLC simulato, aperto in un editor visibile. */
export interface ActiveBlock extends MonitorRequest {
  deviceId: string;
  blockId: string;
}

/** Il blocco di codice dell'editor attivo (di uno dei riquadri visibili), se è del PLC simulato. */
export function activeCodeBlock(s: AppState): ActiveBlock | undefined {
  const { sim, doc, workArea: wa } = s;
  if (sim.phase !== 'on' || !sim.deviceId || !doc) return undefined;
  const shown = wa.split === 'none' ? [wa.panes[0]] : wa.panes;
  for (const key of shown) {
    const ed = key ? wa.editors.find((e) => e.key === key) : undefined;
    if (!ed || ed.kind !== 'block' || ed.deviceId !== sim.deviceId) continue;
    const found = blockOf(s, ed.deviceId, ed.objectId);
    if (found) return found;
  }
  return undefined;
}

function blockOf(s: AppState, deviceId: string, blockId: string): ActiveBlock | undefined {
  const dev = s.doc && findDevice(s.doc.project, deviceId);
  const b = dev?.blocks.find((x) => x.id === blockId);
  if (!b || (b.kind !== 'OB' && b.kind !== 'FB' && b.kind !== 'FC')) return undefined;
  return { deviceId, blockId, kind: b.kind, number: b.number };
}

/** L'editor del blocco osservato è ancora visibile (cambiare blocco o chiuderlo ferma l'osservazione). */
export function monitorStillShown(s: AppState, deviceId: string, blockId: string): boolean {
  const a = activeCodeBlock(s);
  return a?.deviceId === deviceId && a.blockId === blockId;
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
