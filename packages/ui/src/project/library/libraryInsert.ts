import type { CpuType } from '@baaportal/catalog';
import {
  callGraph,
  renameWithReferences,
  renumberInCode,
  symbolNames,
  createNamer,
  type LibraryItem,
  type NewId,
  type Block,
  type ObjectRef,
  type PlcDevice,
  type TagTable,
} from '@baaportal/project';
import { sameName } from '@baaportal/s7-types';
import type { ClipboardItem } from '../../services/clipboard';
import { blockNumber, deleteObjects, isStandardTable, pasteObjects } from '../objectActions';

/**
 * Cosa fare di un oggetto del modello che si scontra con il PLC. `useExisting`: un tag o una costante
 * del modello non entra e il codice usa quello del PLC.
 */
export type Resolution = 'rename' | 'renumber' | 'replace' | 'skip' | 'useExisting';

export interface Conflict {
  /** Id dell'oggetto nel modello. */
  id: string;
  kind: 'block' | 'udt' | 'tagTable' | 'watchTable' | 'tag' | 'constant';
  name: string;
  /** `FB500`, `UDT3`; vuoto per le tabelle, i tag e le costanti. */
  label: string;
  nameTaken: boolean;
  numberTaken: boolean;
  options: Resolution[];
  /** Con «sostituisci»: i blocchi del PLC che chiamano quelli sostituiti (`OB1 Main`). */
  callers: string[];
  /** Il codice del modello ha riferimenti ai blocchi che non si riscrivono con un numero nuovo. */
  indirect: boolean;
  /** I blocchi del modello che si riferiscono a questo col numero (`FB1 Motore`). */
  usedBy: string[];
  /** Tag e costanti: indirizzo (o valore) nel modello e, se c'è, del tag o costante del PLC. */
  symbol?: { at: string; existing?: string };
}

const family = (k: string) => (k === 'IDB' ? 'DB' : k);
const keyOf = (b: { kind: string; number: number }) => `${family(b.kind)}${b.number}`;
const labelOf = (b: { kind: string; number: number; name: string }) => `${keyOf(b)} ${b.name}`;
const sameInPlc = (dev: PlcDevice, b: { kind: string; name: string }) =>
  dev.blocks.find((x) => family(x.kind) === family(b.kind) && sameName(x.name, b.name));

/** Per ogni blocco del modello, i blocchi (`FC5`) a cui il suo codice si riferisce col numero. */
function numberRefs(dev: PlcDevice, item: LibraryItem): Map<string, Set<string>> {
  return new Map(
    item.blocks.map((b) => {
      const keys = new Set<string>();
      // Con `undefined` non si riscrive niente: si raccolgono solo i numeri.
      renumberInCode({ ...dev, blocks: [b], watchTables: [] }, (f, n) => {
        keys.add(`${f}${n}`);
        return undefined;
      });
      keys.delete(keyOf(b));
      return [b.id, keys];
    }),
  );
}

/**
 * I blocchi del modello che non entrano perché si riferiscono col numero a un blocco saltato che nel
 * PLC non ha un blocco con lo stesso nome (il numero punterebbe a un altro blocco), anche a catena:
 * id del blocco → il blocco saltato (`FC5 Helper`).
 */
export function skipCascade(
  dev: PlcDevice,
  item: LibraryItem,
  skipped: ReadonlySet<string>,
): Map<string, string> {
  const refs = numberRefs(dev, item);
  const out = new Map<string, string>();
  const dangling = (b: LibraryItem['blocks'][number]) =>
    (skipped.has(b.id) || out.has(b.id)) && !sameInPlc(dev, b);
  for (let changed = true; changed;) {
    changed = false;
    for (const gone of item.blocks.filter(dangling)) {
      for (const b of item.blocks) {
        if (skipped.has(b.id) || out.has(b.id) || !refs.get(b.id)!.has(keyOf(gone))) continue;
        out.set(b.id, labelOf(gone));
        changed = true;
      }
    }
  }
  return out;
}

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

/** Tag e costanti delle tabelle, con l'indirizzo (o il valore). */
const entries = (tables: TagTable[]) =>
  tables.flatMap((t) => [
    ...t.tags.map((x) => ({ kind: 'tag' as const, ...x, at: x.address })),
    ...t.constants.map((x) => ({ kind: 'constant' as const, ...x, at: x.value })),
  ]);

/** Gli scontri di nome e numero tra il modello e il PLC, con le scelte possibili per ciascuno. */
export function findConflicts(dev: PlcDevice, item: LibraryItem): Conflict[] {
  const symbols = symbolNames(dev);
  const taken = (name: string, list: string[]) => list.some((n) => sameName(n, name));
  const out: Conflict[] = [];
  const refs = numberRefs(dev, item);
  // Basta un riferimento indiretto in tutto il modello: non si sa a quale blocco punta.
  const indirect =
    renumberInCode({ ...dev, blocks: item.blocks, watchTables: [] }, () => undefined).length > 0;
  let graph: ReturnType<typeof callGraph> | undefined;
  const callersOf = (
    kind: Conflict['kind'],
    o: { name: string; number?: number; kind?: string },
  ) => {
    if (kind !== 'block') return [];
    graph ??= callGraph(dev);
    const ids = new Set(clashes(dev, kind, o));
    const gone = dev.blocks.filter((b) => ids.has(b.id)).map((b) => `${family(b.kind)}${b.number}`);
    const names = gone.flatMap((k) => graph!.callers.get(k) ?? []).map((e) => e.caller);
    return [...new Set(names)]
      .filter((k) => !gone.includes(k))
      .map((k) => `${k} ${graph!.blocks.get(k)?.name ?? ''}`.trim());
  };
  const push = (
    c: Omit<Conflict, 'options' | 'callers' | 'indirect' | 'usedBy'> & { usedBy?: string[] },
    replaceable: boolean,
    o: { name: string; number?: number; kind?: string } = c,
  ) => {
    if (!c.nameTaken && !c.numberTaken) return;
    out.push({
      ...c,
      callers: replaceable ? callersOf(c.kind, o) : [],
      indirect: indirect && c.kind === 'block' && c.numberTaken,
      usedBy: c.usedBy ?? [],
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
        label: keyOf(b),
        nameTaken: taken(b.name, symbols),
        numberTaken,
        usedBy: item.blocks.filter((x) => refs.get(x.id)!.has(keyOf(b))).map(labelOf),
      },
      byObject(b.name),
      b,
    );
  }
  for (const t of item.tagTables) {
    const nameTaken = taken(
      t.name,
      dev.tagTables.map((x) => x.name),
    );
    push(
      { id: t.id, kind: 'tagTable', name: t.name, label: '', nameTaken, numberTaken: false },
      clashes(dev, 'tagTable', t).length > 0,
    );
  }
  // Tag e costanti con un nome preso: si rinominano (il codice del modello segue), oppure il codice
  // usa quello del PLC, se è dello stesso genere e dello stesso tipo.
  const plcEntries = entries(dev.tagTables);
  for (const e of entries(item.tagTables)) {
    if (!taken(e.name, symbols)) continue;
    const same = plcEntries.find((y) => y.kind === e.kind && sameName(y.name, e.name));
    out.push({
      id: e.id,
      kind: e.kind,
      name: e.name,
      label: '',
      nameTaken: true,
      numberTaken: false,
      callers: [],
      indirect: false,
      usedBy: [],
      symbol: { at: e.at, ...(same ? { existing: same.at } : {}) },
      options: [
        'rename',
        ...(same && sameName(same.type, e.type) ? (['useExisting'] as const) : []),
      ],
    });
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

/**
 * La scelta proposta: rinumerare se si scontra solo il numero, altrimenti rinominare. Con riferimenti
 * indiretti nel codice un numero nuovo non è sicuro: si salta, ma non un blocco che il modello usa
 * col numero (saltarlo farebbe saltare anche chi lo usa).
 */
export const defaultResolution = (c: Conflict): Resolution =>
  c.indirect && c.usedBy.length === 0
    ? 'skip'
    : c.options.includes('renumber')
      ? 'renumber'
      : 'rename';

/**
 * Inserisce il modello nel PLC (da usare dentro `edit`). Rinomine e numeri nuovi si fanno prima su una
 * copia del modello, così i riferimenti interni (CALL per nome e per numero, tipi, DB di istanza,
 * tag) li seguono; poi la copia passa per lo stesso incolla degli appunti, che trova i numeri già
 * liberi. Restituisce gli oggetti creati e quanti non avevano un numero libero.
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
  for (const { o } of objects) if (choice(o.id) === 'skip') skip.add(o.id);
  for (const id of skipCascade(dev, item, skip).keys()) skip.add(id);
  for (const { kind, o } of objects) {
    const r = choice(o.id);
    if (skip.has(o.id)) continue;
    if (r === 'rename') {
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
  // Tag e costanti con un nome preso (dopo le sostituzioni), prima delle tabelle di controllo.
  const plcSymbols = symbolNames(dev);
  for (const t of scratch.tagTables) {
    if (skip.has(t.id)) continue;
    for (const kind of ['tag', 'constant'] as const) {
      const list: { id: string; name: string }[] = kind === 'tag' ? t.tags : t.constants;
      for (const x of [...list]) {
        if (!plcSymbols.some((n) => sameName(n, x.name))) continue;
        if (choice(x.id) === 'useExisting') list.splice(list.indexOf(x), 1);
        else {
          const ref = { kind, deviceId: scratch.id, tableId: t.id, id: x.id };
          renameWithReferences(scratch, ref, namer(x.name));
        }
      }
    }
  }
  // I numeri che l'incolla darà ai blocchi, decisi qui: i riferimenti per numero li seguono. Prima
  // quelli con il numero libero nel PLC, che lo tengono; poi gli altri prendono i numeri rimasti.
  const sim: PlcDevice = { ...dev, blocks: [...dev.blocks] };
  const numbers = new Map<string, number>(); // `FC1` del modello → numero nel PLC
  const placed = scratch.blocks.filter((b) => !skip.has(b.id));
  const keeps = (b: Block) => blockNumber(dev, b, cpu) === b.number;
  for (const b of scratch.blocks) {
    // Saltato: il codice usa il blocco del PLC con lo stesso nome, se c'è.
    const same = skip.has(b.id) && sameInPlc(dev, b);
    if (same) numbers.set(keyOf(b), same.number);
  }
  for (const b of [...placed.filter(keeps), ...placed.filter((x) => !keeps(x))]) {
    const n = blockNumber(sim, b, cpu);
    if (n === null) continue;
    numbers.set(keyOf(b), n);
    sim.blocks.push({ ...b, number: n });
  }
  renumberInCode(scratch, (f, n) => numbers.get(`${f}${n}`));
  for (const b of scratch.blocks) if (!skip.has(b.id)) b.number = numbers.get(keyOf(b)) ?? b.number;
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
