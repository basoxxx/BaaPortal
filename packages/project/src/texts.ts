// Testi di progetto multilingua (tappa 7D). Il campo del modello tiene il testo della lingua di
// modifica; le altre lingue stanno in `Project.texts`, per chiave `dispositivo/oggetto/campo`
// (gli id sono unici nel dispositivo). I file senza testi si aprono come prima.
import type { Member, PlcDevice, Project, ProjectLanguages } from './model';

export type TextField = 'title' | 'comment' | 'text';

export interface TextEntry {
  key: string;
  deviceId: string;
  /** Percorso leggibile dell'oggetto (senza il PLC). */
  object: string;
  field: TextField;
  /** Testo nella lingua di modifica. */
  source: string;
}

const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const isLanguageTag = (s: string): boolean => s.length <= 20 && TAG.test(s);
export const MAX_LANGUAGES = 20;
/** Lunghezza massima di una traduzione: oltre, il file del progetto non si riaprirebbe. */
export const MAX_TRANSLATION_LENGTH = 100_000;

export const textKey = (deviceId: string, ownerId: string, field: TextField): string =>
  `${deviceId}/${ownerId}/${field}`;

/** Lingue del progetto: quella di modifica per prima. */
export const projectLanguageList = (p: Pick<Project, 'languages'>): string[] =>
  p.languages ? [p.languages.editing, ...p.languages.others] : [];

/** La lingua mostrata, se è una traduzione (altra da quella di modifica e dichiarata). */
export function displayLanguage(p: Pick<Project, 'languages'>): string | null {
  const l = p.languages;
  return l?.display && l.display !== l.editing && l.others.includes(l.display) ? l.display : null;
}

/** Testo da mostrare: la traduzione nella lingua scelta, altrimenti quello della lingua di modifica. */
export function shownText(
  p: Pick<Project, 'languages' | 'texts'>,
  deviceId: string,
  ownerId: string,
  field: TextField,
  original: string,
): string {
  const lang = displayLanguage(p);
  if (!lang || !p.texts) return original;
  const key = textKey(deviceId, ownerId, field);
  const map = Object.hasOwn(p.texts, key) ? p.texts[key] : undefined;
  const v = map && Object.hasOwn(map, lang) ? map[lang] : undefined;
  return v ? v : original;
}

function memberEntries(
  dev: PlcDevice,
  scope: string,
  ms: Member[],
  prefix: string,
  out: TextEntry[],
): void {
  for (const m of ms) {
    const path = prefix ? `${prefix}.${m.name}` : m.name;
    if (m.comment)
      out.push({
        key: textKey(dev.id, m.id, 'comment'),
        deviceId: dev.id,
        object: `${scope} › ${path}`,
        field: 'comment',
        source: m.comment,
      });
    if (m.members) memberEntries(dev, scope, m.members, path, out);
  }
}

/** Tutti i testi traducibili dei PLC (solo quelli non vuoti), in ordine di albero. */
export function listTextEntries(p: Pick<Project, 'devices'>): TextEntry[] {
  const out: TextEntry[] = [];
  for (const dev of p.devices) {
    const add = (ownerId: string, object: string, field: TextField, source: string) => {
      if (source)
        out.push({ key: textKey(dev.id, ownerId, field), deviceId: dev.id, object, field, source });
    };
    for (const b of dev.blocks) {
      const scope = `${b.kind}${b.number}${b.name ? ` ${b.name}` : ''}`;
      add(b.id, scope, 'title', b.header.title);
      add(b.id, scope, 'comment', b.header.comment);
      if (b.kind === 'DB') memberEntries(dev, scope, b.members, '', out);
      else if (b.kind !== 'IDB') {
        const i = b.interface;
        for (const list of [i.input, i.output, i.inOut, i.static, i.temp])
          memberEntries(dev, scope, list, '', out);
        b.networks.forEach((n, k) => {
          add(n.id, `${scope} › N${k + 1}`, 'title', n.title);
          add(n.id, `${scope} › N${k + 1}`, 'comment', n.comment);
        });
      }
    }
    for (const u of dev.udts) {
      const scope = `UDT${u.number} ${u.name}`;
      add(u.id, scope, 'title', u.title);
      add(u.id, scope, 'comment', u.comment);
      memberEntries(dev, scope, u.members, '', out);
    }
    for (const t of dev.tagTables) {
      for (const g of t.tags) add(g.id, `${t.name} › ${g.name}`, 'comment', g.comment);
      for (const c of t.constants) add(c.id, `${t.name} › ${c.name}`, 'comment', c.comment);
    }
    for (const s of dev.hmi?.screens ?? [])
      for (const o of s.objects) add(o.id, `${s.name} › ${o.kind}`, 'text', o.text);
  }
  return out;
}

/** Scrive (o toglie, se il testo è vuoto) la traduzione di una chiave. Modifica `p` sul posto. */
export function setTranslation(
  p: Project,
  key: string,
  lang: string,
  text: string,
  /** Il testo di modifica di adesso: si ricorda per segnare la traduzione «da rivedere» se poi cambia. */
  source?: string,
): boolean {
  if (text.length > MAX_TRANSLATION_LENGTH) return false;
  if (text !== '' && source !== undefined) (p.textSources ??= {})[key] = source;
  const texts = (p.texts ??= {});
  const map = Object.hasOwn(texts, key) ? texts[key]! : (texts[key] = {});
  if (text === '') {
    delete map[lang];
    if (Object.keys(map).length === 0) {
      delete texts[key];
      if (p.textSources) delete p.textSources[key];
    }
  } else map[lang] = text;
  if (Object.keys(texts).length === 0) delete p.texts;
  if (p.textSources && Object.keys(p.textSources).length === 0) delete p.textSources;
  return true;
}

/** Le chiavi con una traduzione il cui testo di modifica è cambiato dopo l'ultima traduzione. */
export function staleTranslations(
  p: Pick<Project, 'devices' | 'texts' | 'textSources'>,
): Set<string> {
  const out = new Set<string>();
  if (!p.textSources || !p.texts) return out;
  for (const e of listTextEntries(p)) {
    const was = p.textSources[e.key];
    if (was !== undefined && was !== e.source && p.texts[e.key]) out.add(e.key);
  }
  return out;
}

/** Segna la traduzione della chiave come rivista rispetto al testo di modifica di adesso. */
export function markReviewed(p: Project, key: string, source: string): void {
  if (p.texts?.[key]) (p.textSources ??= {})[key] = source;
}

export interface TranslationInput {
  key: string;
  lang: string;
  text: string;
}

/**
 * Applica traduzioni importate: solo chiavi esistenti, lingue dichiarate e testi entro
 * MAX_TRANSLATION_LENGTH (gli altri sono scartati); i testi vuoti non cambiano nulla.
 */
export function applyTranslations(
  p: Project,
  inputs: readonly TranslationInput[],
): { applied: number; skipped: number } {
  const sources = new Map(listTextEntries(p).map((e) => [e.key, e.source]));
  const keys = new Set(sources.keys());
  const langs = new Set(p.languages?.others ?? []);
  let applied = 0;
  let skipped = 0;
  for (const i of inputs) {
    if (i.text === '') continue;
    if (
      keys.has(i.key) &&
      langs.has(i.lang) &&
      setTranslation(p, i.key, i.lang, i.text, sources.get(i.key))
    )
      applied++;
    else skipped++;
  }
  return { applied, skipped };
}

/** Imposta le lingue (false se non valide): toglie le traduzioni delle lingue tolte. Modifica `p` sul posto. */
export function setLanguages(p: Project, next: ProjectLanguages): boolean {
  const all = [next.editing, ...next.others];
  if (
    all.length > MAX_LANGUAGES ||
    !all.every(isLanguageTag) ||
    new Set(all).size !== all.length ||
    (next.display !== undefined && !all.includes(next.display))
  )
    return false;
  p.languages = {
    editing: next.editing,
    others: [...next.others],
    ...(next.display && next.display !== next.editing ? { display: next.display } : {}),
  };
  if (p.texts) {
    const keep = new Set(next.others);
    for (const key of Object.keys(p.texts)) {
      const map = p.texts[key]!;
      for (const l of Object.keys(map)) if (!keep.has(l)) delete map[l];
      if (Object.keys(map).length === 0) delete p.texts[key];
    }
    if (Object.keys(p.texts).length === 0) delete p.texts;
  }
  return true;
}

/** Le traduzioni delle sole chiavi ancora presenti nel progetto (per scrivere il file). */
export function liveTexts(p: Project): Project['texts'] {
  if (!p.texts) return undefined;
  const keys = new Set(listTextEntries(p).map((e) => e.key));
  const out = Object.fromEntries(Object.entries(p.texts).filter(([k]) => keys.has(k)));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Come `liveTexts`, per i testi di modifica ricordati. */
export function liveTextSources(p: Project): Project['textSources'] {
  if (!p.textSources || !p.texts) return undefined;
  const live = liveTexts(p);
  const out = Object.fromEntries(Object.entries(p.textSources).filter(([k]) => live && k in live));
  return Object.keys(out).length > 0 ? out : undefined;
}
