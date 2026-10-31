import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  applyTranslations,
  createProject,
  displayLanguage,
  listTextEntries,
  MAX_TRANSLATION_LENGTH,
  readBaap,
  setLanguages,
  setTranslation,
  staleTranslations,
  markReviewed,
  shownText,
  textKey,
  writeBaap,
  type Project,
} from '../src/index';
import { makeDevice, now } from './fixtures';

function sample(): Project {
  const p = createProject({ name: 'T', author: '', comment: '' }, now);
  const dev = makeDevice();
  const fb = dev.blocks.find((b) => b.kind === 'FB')!;
  if (fb.kind === 'FB') {
    fb.header.title = 'Nastro';
    fb.networks[0] = { ...fb.networks[0]!, title: 'Avvio', comment: 'Avvia il nastro' };
  }
  p.devices.push(dev);
  setLanguages(p, { editing: 'it-IT', others: ['en-US'], display: 'en-US' });
  return p;
}

const firstNet = (p: Project) => {
  const fb = p.devices[0]!.blocks.find((b) => b.kind === 'FB')!;
  if (fb.kind !== 'FB') throw new Error('FB');
  return fb.networks[0]!;
};

describe('testi di progetto', () => {
  it('elenca i testi non vuoti di blocchi, segmenti, variabili', () => {
    const es = listTextEntries(sample());
    const objs = es.map((e) => `${e.object}|${e.field}|${e.source}`);
    expect(objs).toContain('FB1 Nastro|title|Nastro');
    expect(objs).toContain('FB1 Nastro › N1|comment|Avvia il nastro');
    expect(objs.some((o) => o.endsWith('› Start|comment|ok'))).toBe(true);
    expect(es.every((e) => e.source !== '')).toBe(true);
  });

  it('mostra la traduzione e ricade sul testo di modifica', () => {
    const p = sample();
    const devId = p.devices[0]!.id;
    const net = firstNet(p);
    expect(shownText(p, devId, net.id, 'comment', net.comment)).toBe('Avvia il nastro');
    setTranslation(p, textKey(devId, net.id, 'comment'), 'en-US', 'Starts the belt');
    expect(shownText(p, devId, net.id, 'comment', net.comment)).toBe('Starts the belt');
    expect(shownText(p, devId, net.id, 'title', net.title)).toBe('Avvio');
    p.languages!.display = 'it-IT';
    expect(displayLanguage(p)).toBeNull();
    expect(shownText(p, devId, net.id, 'comment', net.comment)).toBe('Avvia il nastro');
  });

  it('andata e ritorno nel file; i testi di oggetti spariti non si scrivono', () => {
    const p = sample();
    const devId = p.devices[0]!.id;
    const net = firstNet(p);
    setTranslation(p, textKey(devId, net.id, 'comment'), 'en-US', 'Starts the belt');
    setTranslation(p, textKey(devId, 'sparito', 'comment'), 'en-US', 'x');
    const back = readBaap(writeBaap(p, { appVersion: '1' }));
    expect(back.languages).toEqual(p.languages);
    expect(back.texts).toEqual({
      [textKey(devId, net.id, 'comment')]: { 'en-US': 'Starts the belt' },
    });
  });

  it('un file senza lingue né testi si apre com’è e non ne scrive', () => {
    const p = createProject({ name: 'Vecchio', author: '', comment: '' }, now);
    const back = readBaap(writeBaap(p, { appVersion: '1' }));
    expect(back).toEqual(p);
    expect('languages' in back || 'texts' in back).toBe(false);
  });

  it('rifiuta lingue o testi malformati nel file', () => {
    const files = unzipSync(writeBaap(sample(), { appVersion: '1' }));
    const proj = JSON.parse(strFromU8(files['project.json']!));
    for (const bad of [
      { ...proj, languages: { editing: 'it', others: ['it'] } },
      { ...proj, languages: { editing: '__proto__', others: [] } },
      { ...proj, texts: { k: { '<b>': 'x' } } },
      { ...proj, texts: { k: { it: 5 } } },
    ]) {
      const z = zipSync({ ...files, 'project.json': strToU8(JSON.stringify(bad)) });
      expect(() => readBaap(z)).toThrow();
    }
  });

  it('una traduzione è «da rivedere» se il testo di modifica cambia dopo; si riscrive e si legge', () => {
    const p = sample();
    const e = listTextEntries(p).find((x) => x.source === 'Nastro')!;
    setTranslation(p, e.key, 'en-US', 'Belt', e.source);
    expect([...staleTranslations(p)]).toEqual([]);
    const fb = p.devices[0]!.blocks.find((b) => b.kind === 'FB')!;
    fb.header.title = 'Nastro 2';
    expect([...staleTranslations(p)]).toEqual([e.key]);
    const back = readBaap(writeBaap(p, { appVersion: '1' }));
    expect([...staleTranslations(back)]).toEqual([e.key]);
    markReviewed(p, e.key, 'Nastro 2');
    expect([...staleTranslations(p)]).toEqual([]);
    setTranslation(p, e.key, 'en-US', '');
    expect(p.textSources).toBeUndefined();
  });

  it('applyTranslations ignora chiavi e lingue sconosciute, e i vuoti', () => {
    const p = sample();
    const e = listTextEntries(p)[0]!;
    const r = applyTranslations(p, [
      { key: e.key, lang: 'en-US', text: 'Hello' },
      { key: e.key, lang: 'de-DE', text: 'Hallo' },
      { key: 'no/no/comment', lang: 'en-US', text: 'x' },
      { key: e.key, lang: 'en-US', text: '' },
    ]);
    expect(r).toEqual({ applied: 1, skipped: 2 });
    expect(p.texts![e.key]).toEqual({ 'en-US': 'Hello' });
  });

  it('un testo oltre il limite del file si scarta e il progetto si riapre', () => {
    const p = sample();
    const e = listTextEntries(p)[0]!;
    const long = 'x'.repeat(MAX_TRANSLATION_LENGTH + 1);
    expect(applyTranslations(p, [{ key: e.key, lang: 'en-US', text: long }])).toEqual({
      applied: 0,
      skipped: 1,
    });
    expect(setTranslation(p, e.key, 'en-US', long)).toBe(false);
    expect(p.texts).toBeUndefined();
    expect(setTranslation(p, e.key, 'en-US', 'x'.repeat(MAX_TRANSLATION_LENGTH))).toBe(true);
    expect(readBaap(writeBaap(p, { appVersion: 'x' })).texts?.[e.key]?.['en-US']).toHaveLength(
      MAX_TRANSLATION_LENGTH,
    );
  });

  it('setLanguages valida e toglie le traduzioni delle lingue tolte', () => {
    const p = sample();
    const e = listTextEntries(p)[0]!;
    setTranslation(p, e.key, 'en-US', 'Hello');
    expect(setLanguages(p, { editing: 'it-IT', others: ['it-IT'] })).toBe(false);
    expect(setLanguages(p, { editing: 'it-IT', others: ['x y'] })).toBe(false);
    expect(setLanguages(p, { editing: 'it-IT', others: ['de-DE'], display: 'de-DE' })).toBe(true);
    expect(p.texts).toBeUndefined();
    expect(p.languages!.display).toBe('de-DE');
  });
});
