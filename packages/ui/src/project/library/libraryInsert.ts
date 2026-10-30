import type { CpuType } from '@baaportal/catalog';
import {
  renameWithReferences,
  symbolNames,
  createNamer,
  type LibraryItem,
  type NewId,
  type ObjectRef,
  type PlcDevice,
} from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import type { ClipboardItem } from '../../services/clipboard';
import { deleteObjects, isStandardTable, pasteObjects } from '../objectActions';

/** Cosa fare di un oggetto del modello che si scontra con il PLC. */
export type Resolution = 'rename' | 'renumber' | 'replace' | 'skip';

export interface Conflict {
  /** Id dell'oggetto nel modello. */
  id: string;
  kind: 'block' | 'udt' | 'tagTable' | 'watchTable';
  name: string;
  /** `FB500`, `UDT3`; vuoto per le tabelle. */
  label: string;
  nameTaken: boolean;
  numberTaken: boolean;
  options: Resolution[];
}

const family = (k: string) => (k === 'IDB' ? 'DB' : k);

/** Gli oggetti del PLC che un oggetto del modello sostituirebbe: stesso nome o stesso numero. */
function clashes(
  dev: PlcDevice,
  kind: Conflict['kind'],
  o: { name: string; number?: number; kind?: string },
) {
  if (kind === 'tagTable') {
    return dev.tagTables.filter((t, i) => i > 0 && sameName(t.name, o.name)).map((t) => t.id);
  }
  if (kind === 'watchTable') {
    return dev.watchTables.filter((w) => sameName(w.name, o.name)).map((w) => w.id);
  }
  const named = [...dev.blocks, ...dev.udts].filter((x) => sameName(x.name, o.name));
  const numbered =
    kind === 'udt'
      ? dev.udts.filter((u) => u.number === o.number)
      : dev.blocks.filter((b) => family(b.kind) === family(o.kind!) && b.number === o.number);
  return [...new Set([...named, ...numbered].map((x) => x.id))];
}

/** Gli scontri di nome e numero tra il modello e il PLC, con le scelte possibili per ciascuno. */
export function findConflicts(dev: PlcDevice, item: LibraryItem): Conflict[] {
  const symbols = symbolNames(dev);
  const taken = (name: string, list: string[]) => list.some((n) => sameName(n, name));
  const out: Conflict[] = [];
  const push = (c: Omit<Conflict, 'options'>, replaceable: boolean) => {
    if (!c.nameTaken && !c.numberTaken) return;
    out.push({
      ...c,
      options: [
        'rename',
        ...(c.numberTaken && !c.nameTaken ? (['renumber'] as const) : []),
        ...(replaceable ? (['replace'] as const) : []),
        'skip',
      ],
    });
  };
  // Un nome preso da un tag o da una costante non si sostituisce: resta solo la rinomina.
  const byObject = (name: string) =>
    [...dev.blocks, ...dev.udts].some((x) => sameName(x.name, name)) || !taken(name, symbols);
  for (const u of item.udts) {
    const numberTaken = dev.udts.some((x) => x.number === u.number);
    push(
      {
        id: u.id,
        kind: 'udt',
        name: u.name,
        label: `UDT${u.number}`,
        nameTaken: taken(u.name, symbols),
        numberTaken,
      },
      byObject(u.name),
    );
  }
  for (const b of item.blocks) {
    const numberTaken = dev.blocks.some(
      (x) => family(x.kind) === family(b.kind) && x.number === b.number,
    );
    push(
      {
        id: b.id,
        kind: 'block',
        name: b.name,
        label: `${family(b.kind)}${b.number}`,
        nameTaken: taken(b.name, symbols),
        numberTaken,
      },
      byObject(b.name),
    );
  }
  for (const t of item.tagTables) {
    // Anche un tag con un nome preso è uno scontro: la copia lo rinomina.
    const nameTaken =
      taken(
        t.name,
        dev.tagTables.map((x) => x.name),
      ) || [...t.tags, ...t.constants].some((x) => taken(x.name, symbols));
    push(
      { id: t.id, kind: 'tagTable', name: t.name, label: '', nameTaken, numberTaken: false },
      clashes(dev, 'tagTable', t).length > 0,
    );
  }
  for (const w of item.watchTables) {
    const nameTaken = taken(
      w.name,
      dev.watchTables.map((x) => x.name),
    );
    push(
      { id: w.id, kind: 'watchTable', name: w.name, label: '', nameTaken, numberTaken: false },
      nameTaken,
    );
  }
  return out;
}

/** La scelta proposta: rinumerare se si scontra solo il numero, altrimenti rinominare. */
export const defaultResolution = (c: Conflict): Resolution =>
  c.options.includes('renumber') ? 'renumber' : 'rename';

/**
 * Inserisce il modello nel PLC (da usare dentro `edit`). Le rinomine si fanno prima su una copia del
 * modello, così i riferimenti interni (CALL, tipi, DB di istanza) seguono il nuovo nome; poi la
 * copia passa per lo stesso incolla degli appunti, che rinumera i numeri presi. Restituisce gli
 * oggetti creati e quanti non avevano un numero libero.
 */
export function insertLibraryItem(
  dev: PlcDevice,
  item: LibraryItem,
  choices: ReadonlyMap<string, Resolution>,
  cpu: CpuType | undefined,
  newId: NewId,
): { created: ObjectRef[]; skipped: number } {
  const scratch: PlcDevice = {
    ...dev,
    id: 'library',
    blocks: structuredClone(item.blocks),
    udts: structuredClone(item.udts),
    tagTables: structuredClone(item.tagTables),
    watchTables: structuredClone(item.watchTables),
    sources: [],
  };
  const conflicts = new Map(findConflicts(dev, item).map((c) => [c.id, c]));
  const choice = (id: string) => {
    const c = conflicts.get(id);
    const r = c && (choices.get(id) ?? defaultResolution(c));
    return c && r && c.options.includes(r) ? r : null;
  };
  const namer = createNamer([...symbolNames(dev), ...symbolNames(scratch)]);
  const skip = new Set<string>();
  const replace: ObjectRef[] = [];
  const objects = [
    ...scratch.udts.map((o) => ({ kind: 'udt' as const, o })),
    ...scratch.blocks.map((o) => ({ kind: 'block' as const, o })),
  ];
  for (const { kind, o } of objects) {
    const r = choice(o.id);
    if (r === 'skip') skip.add(o.id);
    else if (r === 'rename') {
      renameWithReferences(scratch, { kind, deviceId: scratch.id, id: o.id }, namer(o.name));
    } else if (r === 'replace') {
      for (const id of clashes(dev, kind, o)) {
        replace.push({
          kind: dev.udts.some((u) => u.id === id) ? 'udt' : 'block',
          deviceId: dev.id,
          id,
        });
      }
    }
  }
  const watchNamer = createNamer(dev.watchTables.map((w) => w.name));
  for (const t of scratch.tagTables) {
    const r = choice(t.id);
    if (r === 'skip') skip.add(t.id);
    // La tabella standard non si sostituisce: resta la copia rinominata.
    if (r === 'replace') {
      for (const id of clashes(dev, 'tagTable', t)) {
        if (!isStandardTable(dev, id)) replace.push({ kind: 'tagTable', deviceId: dev.id, id });
      }
    }
  }
  deleteObjects(dev, replace);
  const created: ObjectRef[] = [];
  for (const w of scratch.watchTables) {
    const r = choice(w.id);
    if (r === 'skip') continue;
    if (r === 'replace') dev.watchTables = dev.watchTables.filter((x) => !sameName(x.name, w.name));
    const copy = {
      ...w,
      id: newId(),
      name: watchNamer(w.name),
      rows: w.rows.map((x) => ({ ...x, id: newId() })),
    };
    dev.watchTables.push(copy);
    created.push({ kind: 'watchTable', deviceId: dev.id, id: copy.id });
  }
  const items: ClipboardItem[] = [
    ...scratch.udts.filter((u) => !skip.has(u.id)).map((udt) => ({ type: 'udt' as const, udt })),
    ...scratch.blocks
      .filter((b) => !skip.has(b.id))
      .map((block) => ({ type: 'block' as const, block })),
    ...scratch.tagTables
      .filter((t) => !skip.has(t.id))
      .map((table) => ({ type: 'tagTable' as const, table })),
  ];
  const pasted = pasteObjects(
    dev,
    { kind: 'objects', deviceId: scratch.id, items },
    '',
    cpu,
    newId,
  );
  return { created: [...pasted, ...created], skipped: items.length - pasted.length };
}
