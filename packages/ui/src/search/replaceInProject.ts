import { mapOperands } from '@baaportal/ladfbd';
import {
  kopSources,
  type Block,
  type CodeBlock,
  type KopOperandRef,
  type PlcDevice,
  type Project,
} from '@baaportal/project';
import { lineEndingOf, storedText } from '../editors/awl/awlExtensions';
import { scanProject, type Match } from './findInProject';
import type { FindOptions, Hit, HitLocation } from './types';

const key = (h: Hit): string => {
  const l: HitLocation = h.loc;
  const parts: unknown[] = [l.kind, l.from, l.to, h.match];
  if ('deviceId' in l) parts.push(l.deviceId);
  if ('blockId' in l) parts.push(l.blockId, 'networkIndex' in l ? l.networkIndex : '');
  if ('sourceId' in l) parts.push(l.sourceId);
  if ('tableId' in l) parts.push(l.field, l.tableId, l.tagId);
  return JSON.stringify(parts);
};

const nameKey = (s: string): string => s.normalize('NFC').toLowerCase();

/** Applica le sostituzioni (dall'ultima alla prima: gli offset restano validi). */
function applyAll(text: string, ms: { loc: HitLocation; to: string }[]): string {
  let out = text;
  for (const m of [...ms].sort((a, b) => b.loc.from - a.loc.from)) {
    out = out.slice(0, m.loc.from) + m.to + out.slice(m.loc.to);
  }
  return out;
}

const symbols = (d: PlcDevice): string[] => [
  ...d.tagTables.flatMap((t) => [...t.tags.map((x) => x.name), ...t.constants.map((c) => c.name)]),
  ...d.blocks.map((b) => b.name),
  ...d.udts.map((u) => u.name),
];

/**
 * Sostituzione pura: restituisce un progetto nuovo e non muta l'ingresso. `replaced` conta i risultati
 * sostituiti, `skipped` quelli non modificabili (protetti, MC7 grezzo), quelli di `only` non più
 * validi e i rinomi di variabile che duplicherebbero un nome.
 */
export function replaceInProject(
  p: Project,
  o: FindOptions,
  replacement: string,
  only?: Hit[],
): { project: Project; replaced: number; skipped: number } {
  const scanned = scanProject(p, o);
  if (!Array.isArray(scanned)) return { project: p, replaced: 0, skipped: 0 };
  const wanted = only && new Set(only.map((h) => key(h)));
  // Un hit di `only` che non è più una corrispondenza (testo cambiato) è obsoleto: saltato.
  let skipped = 0;
  if (wanted) {
    const live = new Set(scanned.map((m) => key(m.hit)));
    for (const k of wanted) if (!live.has(k)) skipped++;
  }
  const chosen: Match[] = wanted ? scanned.filter((m) => wanted.has(key(m.hit))) : scanned;
  const todo = chosen.filter((m) => m.hit.editable);
  skipped += chosen.length - todo.length;
  if (todo.length === 0) return { project: p, replaced: 0, skipped };

  const project = structuredClone(p);
  const dev = (id: string) => project.devices.find((d) => d.id === id)!;
  const blk = (l: { deviceId: string; blockId: string }): Block =>
    dev(l.deviceId).blocks.find((b) => b.id === l.blockId)!;
  const mnemonic = o.mnemonic === 'de' ? 'german' : 'international';

  // Raggruppa per campo di testo da riscrivere.
  const groups = new Map<
    string,
    { loc: HitLocation; to: string; text: string; kop?: KopOperandRef }[]
  >();
  const push = (g: string, loc: HitLocation, m: Match) => {
    const list = groups.get(g) ?? [];
    list.push({ loc, to: m.replacement(replacement), text: m.text, kop: m.kop });
    groups.set(g, list);
  };
  for (const m of todo) {
    const l = m.hit.loc;
    if (l.kind === 'tag') push(`tag|${l.deviceId}|${l.tableId}|${l.tagId}|${l.field}`, l, m);
    else if (l.kind === 'source') push(`src|${l.deviceId}|${l.sourceId}`, l, m);
    else if (l.kind === 'network' && m.kop)
      push(`kop|${l.deviceId}|${l.blockId}|${l.networkIndex}`, l, m);
    else
      push(
        `${l.kind}|${l.deviceId}|${l.blockId}|${'networkIndex' in l ? l.networkIndex : ''}`,
        l,
        m,
      );
  }

  let replaced = 0;
  const taken = new Map<string, Set<string>>();
  for (const list of groups.values()) {
    const l = list[0]!.loc;
    const count = list.length;
    switch (l.kind) {
      case 'tag': {
        const d = dev(l.deviceId);
        const tag = d.tagTables
          .find((t) => t.id === l.tableId)!
          .tags.find((t) => t.id === l.tagId)!;
        const next = applyAll(tag[l.field], list);
        if (l.field === 'name') {
          // Il nome resta unico nella CPU; altrimenti il rinomino è saltato.
          let set = taken.get(d.id);
          if (!set) taken.set(d.id, (set = new Set(symbols(d).map(nameKey))));
          const free = nameKey(next) === nameKey(tag.name) || !set.has(nameKey(next));
          if (next === '' || !free) {
            skipped += count;
            continue;
          }
          set.delete(nameKey(tag.name));
          set.add(nameKey(next));
        }
        tag[l.field] = next;
        break;
      }
      case 'source': {
        const s = dev(l.deviceId).sources.find((x) => x.id === l.sourceId)!;
        s.text = applyAll(s.text, list);
        break;
      }
      case 'network': {
        if (list[0]!.kop) {
          // Un operando del grafico non può avere a capo: i risultati con a capo si saltano.
          const ok = list.filter((x) => !/[\r\n]/.test(x.to));
          skipped += list.length - ok.length;
          if (ok.length === 0) continue;
          const b = blk(l) as CodeBlock;
          const n = b.networks[l.networkIndex]!;
          const per = new Map<string, typeof ok>();
          for (const x of ok) {
            const k = `${x.kop!.elemId}|${x.kop!.field}`;
            per.set(k, [...(per.get(k) ?? []), x]);
          }
          n.lad = mapOperands(n.lad!, (value, _role, at) => {
            const hits = per.get(`${at.id}|${at.field}`);
            if (!hits) return value;
            let out = value;
            for (const x of [...hits].sort((a, c) => c.kop!.from - a.kop!.from)) {
              out = out.slice(0, x.kop!.from) + x.to + out.slice(x.kop!.to);
            }
            return out;
          });
          // La sorgente generata segue il grafico (come dopo ogni modifica dell'editor).
          const sources = kopSources(b, dev(l.deviceId));
          b.networks.forEach((x, i) => {
            x.source = sources[i]?.source ?? x.source;
          });
          replaced += ok.length;
          continue;
        }
        const n = (blk(l) as Extract<Block, { networks: unknown }>).networks[l.networkIndex]!;
        n.source = storedText(applyAll(list[0]!.text, list), mnemonic, lineEndingOf(n.source));
        break;
      }
      case 'networkTitle':
      case 'networkComment': {
        const n = (blk(l) as Extract<Block, { networks: unknown }>).networks[l.networkIndex!]!;
        const f = l.kind === 'networkTitle' ? 'title' : 'comment';
        n[f] = applyAll(n[f], list);
        break;
      }
      case 'blockTitle':
        blk(l).header.title = applyAll(blk(l).header.title, list);
        break;
      case 'blockComment':
        blk(l).header.comment = applyAll(blk(l).header.comment, list);
        break;
    }
    replaced += count;
  }
  return { project, replaced, skipped };
}
