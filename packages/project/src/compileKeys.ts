// Chiavi di compilazione per blocco: da cosa dipende il file MC7 di un blocco, oltre a sé stesso.
import { interfaceHashOf, sourceHashOf } from './mc7Bridge';
import type { Block, Member, PlcDevice } from './model';

/** Hash di 53 bit (cyrb53) del testo. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const memberKey = (m: Member): unknown => [
  m.name,
  m.type,
  m.initial ?? null,
  m.overrides ?? null,
  (m.members ?? []).map(memberKey),
];

const nameKey = (s: string): string => s.normalize('NFC').toLowerCase();
const blockKey = (kind: string, n: number) =>
  `#${kind === 'IDB' || kind === 'DI' ? 'db' : kind.toLowerCase()}${n}`;

/**
 * Le parole di un testo che possono nominare una variabile, una costante, un UDT o un blocco: il
 * testo intero, i nomi tra virgolette, gli identificatori, le parole fra separatori e i riferimenti
 * assoluti (`FC 10`, `DB5.DBW2`, `UDT 3`, `DI 4`). Prudente: una parola in più costa solo una
 * ricompilazione in più.
 */
function addWords(s: string, out: Set<string>): void {
  out.add(nameKey(s.trim()));
  for (const m of s.matchAll(/"([^"]*)"/g)) out.add(nameKey(m[1]!));
  for (const m of s.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) out.add(nameKey(m[0]));
  for (const w of s.split(/[\s"',;:()[\]{}=<>+*/]+/)) if (w) out.add(nameKey(w));
  for (const m of s.matchAll(/(OB|FC|FB|DB|DI|UDT)\s*(\d+)/gi))
    out.add(blockKey(m[1]!.toUpperCase(), Number(m[2])));
}

/** Tutte le stringhe di un valore (non le chiavi `id`, non i metadati MC7 importati). */
function walk(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') addWords(v, out);
  else if (Array.isArray(v)) for (const x of v) walk(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) if (k !== 'id' && k !== 'mc7') walk(x, out);
  }
}

/** Il progetto è immutabile (immer): una modifica cambia l'oggetto, quindi le cache per oggetto valgono. */
const wordsCache = new WeakMap<object, Set<string>>();
/** Le parole della parte pubblica di un blocco (interfaccia, membri, FB di istanza). */
const publicCache = new WeakMap<object, Set<string>>();
function wordsOf(o: object, part: unknown, cache = wordsCache): Set<string> {
  let got = cache.get(o);
  if (!got) {
    got = new Set();
    walk(part, got);
    cache.set(o, got);
  }
  return got;
}

const dataCache = new WeakMap<object, string>();
function dataOf(o: object, make: () => unknown): string {
  let got = dataCache.get(o);
  if (got === undefined) {
    got = hashText(JSON.stringify(make()));
    dataCache.set(o, got);
  }
  return got;
}

interface Entity {
  /** Ciò che il compilatore ne legge (impronta). */
  data: string;
  /** I nomi con cui lo si richiama. */
  names: string[];
  /** Le parole della sua parte pubblica: tipi, indirizzi, interfaccia (dipendenze a catena). */
  words: Set<string>;
}

const blockData = (b: Block) =>
  dataOf(b, () => ['B', b.kind, b.number, b.name, interfaceHashOf(b)]);
const blockPublic = (b: Block): unknown =>
  b.kind === 'DB'
    ? b.members
    : b.kind === 'IDB'
      ? [b.instanceOf, b.overrides]
      : [b.interface, b.language];

function entitiesOf(dev: PlcDevice): Entity[] {
  const out: Entity[] = [];
  for (const t of dev.tagTables) {
    for (const x of t.tags)
      out.push({
        data: dataOf(x, () => ['T', x.name, x.type, x.address]),
        names: [nameKey(x.name)],
        words: wordsOf(x, [x.type, x.address]),
      });
    for (const x of t.constants)
      out.push({
        data: dataOf(x, () => ['K', x.name, x.type, x.value]),
        names: [nameKey(x.name)],
        words: wordsOf(x, [x.type, x.value]),
      });
  }
  for (const u of dev.udts)
    out.push({
      data: dataOf(u, () => ['U', u.name, u.number, u.members.map(memberKey)]),
      names: [nameKey(u.name), blockKey('UDT', u.number)],
      words: wordsOf(u, u.members),
    });
  for (const b of dev.blocks)
    out.push({
      data: blockData(b),
      names: [nameKey(b.name), blockKey(b.kind, b.number)],
      words: wordsOf(b, blockPublic(b), publicCache),
    });
  return out;
}

/** I metadati MC7 importati: le strutture reali degli SFB si imparano da tutti i blocchi importati. */
const mc7Cache = new WeakMap<object, string>();
function importedOf(dev: PlcDevice): string {
  return hashText(
    JSON.stringify(
      dev.blocks
        .filter((b) => b.mc7)
        .map((b) => {
          let h = mc7Cache.get(b.mc7!);
          if (h === undefined) mc7Cache.set(b.mc7!, (h = hashText(JSON.stringify(b.mc7))));
          return [b.kind, b.number, b.name, b.kind === 'IDB' ? b.instanceOf : null, h];
        }),
    ),
  );
}

const keysCache = new WeakMap<PlcDevice, (b: Block) => string>();

/**
 * Chiave delle dipendenze di compilazione di ogni blocco del dispositivo: CPU, metadati importati
 * e, delle variabili, costanti, UDT e degli altri blocchi (nome, tipo, numero, interfaccia), solo
 * quelli che il blocco può nominare, a catena (un UDT dentro un UDT, l'FB di un DB di istanza, una
 * multi-istanza). Un blocco importato dipende da tutto il contesto, come prima: le sue regole di
 * fedeltà guardano le dipendenze per numero dentro i byte originali.
 */
export function compileKeysOf(dev: PlcDevice): (b: Block) => string {
  const kept = keysCache.get(dev);
  if (kept) return kept;
  const entities = entitiesOf(dev);
  const byName = new Map<string, number[]>();
  entities.forEach((e, i) => {
    for (const n of e.names) {
      const list = byName.get(n);
      if (list) list.push(i);
      else byName.set(n, [i]);
    }
  });
  const head = [dev.cpu.typeId, importedOf(dev)];
  // contesto intero (variabili, costanti, UDT, interfacce di tutti i blocchi) per i blocchi importati
  let whole: string[] | undefined;
  const memo = new Map<string, string>();
  const keyOf = (b: Block): string => {
    const got = memo.get(b.id);
    if (got !== undefined) return got;
    let key: string;
    if (b.mc7) key = hashText(JSON.stringify([...head, (whole ??= entities.map((e) => e.data))]));
    else {
      const seen = new Set<number>();
      const queue = [wordsOf(b, b), new Set([nameKey(b.name), blockKey(b.kind, b.number)])];
      while (queue.length > 0) {
        for (const w of queue.pop()!) {
          for (const i of byName.get(w) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            queue.push(entities[i]!.words);
          }
        }
      }
      const deps = [...seen].sort((x, y) => x - y).map((i) => entities[i]!.data);
      key = hashText(JSON.stringify([...head, b.name, deps]));
    }
    memo.set(b.id, key);
    return key;
  };
  keysCache.set(dev, keyOf);
  return keyOf;
}

/** Chiave di compilazione di un blocco: contenuto (reti, interfaccia, intestazione) e dipendenze. */
export const compileKeyOf = (b: Block, keys: (b: Block) => string): string =>
  `${sourceHashOf(b)}:${interfaceHashOf(b)}:${keys(b)}`;
