import { describe, expect, it } from 'vitest';
import { createProject, type Project } from '@baaportal/project';
import { HISTORY_LIMIT } from '../src/state/history';
import { createAppStore, DEFAULT_PANELS } from '../src/state/store';

describe('store', () => {
  it('parte dalla vista portale con i pannelli predefiniti', () => {
    const s = createAppStore().getState();
    expect(s.view).toBe('portal');
    expect(s.panels).toEqual(DEFAULT_PANELS);
    expect(s.doc).toBeNull();
  });
  it('edit imposta dirty e pushMessage aggiorna lo stato', () => {
    const store = createAppStore(() => new Date('2026-10-18T09:05:00'));
    store.getState().setDoc({
      project: createProject({ name: 'P', author: '', comment: '' }, new Date()),
      filePath: '/p',
      dirty: false,
      revision: 0,
      savedRevision: 0,
    });
    store.getState().edit('history.author', (p) => {
      p.meta.author = 'Z';
    });
    expect(store.getState().doc).toMatchObject({ dirty: true, project: { meta: { author: 'Z' } } });
    store
      .getState()
      .pushMessage({ severity: 'info', textKey: 'messages.saved', params: { name: 'P' } });
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().status).toEqual({ textKey: 'messages.saved', params: { name: 'P' } });
  });

  describe('cronologia e revisioni', () => {
    const open = () => {
      const store = createAppStore();
      const project = createProject({ name: 'P', author: 'Mario', comment: '' }, new Date(0));
      store
        .getState()
        .setDoc({ project, filePath: '/p.baap', dirty: false, revision: 0, savedRevision: 0 });
      return { store, project, get: () => store.getState() };
    };
    const setAuthor = (a: string) => (p: Project) => {
      p.meta.author = a;
    };

    it('edit, undo, redo e dirty seguono la revisione salvata', () => {
      const { store, project, get } = open();
      expect(get().edit('history.author', setAuthor('A'))).toBe(true);
      expect(get().doc!.dirty).toBe(true);
      expect(get().history.past[0]!.labelKey).toBe('history.author');
      store.getState().undo();
      expect(get().doc!.dirty).toBe(false);
      expect(get().doc!.project.meta.author).toBe(project.meta.author);
      store.getState().redo();
      expect(get().doc!.project.meta.author).toBe('A');
      expect(get().doc!.dirty).toBe(true);
    });

    it('salvare e poi annullare rimette "modificato"', () => {
      const { store, get } = open();
      store.getState().edit('history.author', setAuthor('A'));
      store.getState().markSaved({
        filePath: '/q.baap',
        revision: get().doc!.revision,
        modifiedAt: '2026-10-18T10:00:00.000Z',
      });
      expect(get().doc).toMatchObject({ dirty: false, filePath: '/q.baap' });
      expect(get().doc!.project.meta.modifiedAt).toBe('2026-10-18T10:00:00.000Z');
      expect(get().history.past).toHaveLength(1);
      store.getState().undo();
      expect(get().doc!.dirty).toBe(true);
      expect(get().doc!.project.meta.modifiedAt).toBe('2026-10-18T10:00:00.000Z');
      store.getState().redo();
      expect(get().doc!.dirty).toBe(false);
    });

    it('una ricetta che non cambia nulla non crea voci né revisioni', () => {
      const { store, get } = open();
      expect(store.getState().edit('x', () => {})).toBe(false);
      expect(get().history.past).toHaveLength(0);
      expect(get().doc!.revision).toBe(0);
    });

    it('senza documento edit restituisce false', () => {
      const store = createAppStore();
      expect(store.getState().edit('x', setAuthor('A'))).toBe(false);
    });

    it('un nuovo edit dopo undo svuota future e non riusa revisioni', () => {
      const { store, get } = open();
      store.getState().edit('a', setAuthor('A'));
      store.getState().edit('b', setAuthor('B'));
      store.getState().undo();
      expect(get().history.future).toHaveLength(1);
      store.getState().edit('c', setAuthor('C'));
      expect(get().history.future).toHaveLength(0);
      expect(get().doc!.revision).toBe(3);
    });

    it('limite di 100 voci: la più vecchia viene scartata', () => {
      const { store, get } = open();
      for (let i = 0; i < HISTORY_LIMIT + 1; i++)
        store.getState().edit(`k${i}`, setAuthor(`a${i}`));
      expect(get().history.past).toHaveLength(HISTORY_LIMIT);
      expect(get().history.past[0]!.labelKey).toBe('k1');
    });

    it('setDoc azzera la cronologia e riparte dalla revisione del documento', () => {
      const { store, project, get } = open();
      store.getState().edit('a', setAuthor('A'));
      store
        .getState()
        .setDoc({ project, filePath: '/r', dirty: false, revision: 1, savedRevision: 0 });
      expect(get().history).toEqual({ past: [], future: [] });
      expect(get().doc!.dirty).toBe(true);
      store.getState().edit('b', setAuthor('B'));
      expect(get().doc!.revision).toBe(2);
    });
  });
});
