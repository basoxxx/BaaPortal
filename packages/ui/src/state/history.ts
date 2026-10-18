import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import type { Project } from '@baaportal/project';

enablePatches();

export const HISTORY_LIMIT = 100;

export interface HistoryEntry {
  labelKey: string;
  patches: Patch[];
  inverse: Patch[];
  /** Revisione del documento prima e dopo la modifica. */
  before: number;
  after: number;
}

/** Applica la ricetta; null se non cambia nulla. */
export function recordEdit(
  project: Project,
  recipe: (draft: Project) => void,
): { next: Project; patches: Patch[]; inverse: Patch[] } | null {
  const [next, patches, inverse] = produceWithPatches(project, recipe);
  return patches.length === 0 ? null : { next, patches, inverse };
}

export function applyHistory(project: Project, patches: Patch[]): Project {
  return applyPatches(project, patches);
}

/** Aggiunge in coda e scarta le voci più vecchie oltre il limite. */
export function pushLimited(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}
