import { describe, expect, it } from 'vitest';
import { createProject } from '@baaportal/project';
import { createAppStore, DEFAULT_PANELS } from '../src/state/store';

describe('store', () => {
  it('parte dalla vista portale con i pannelli predefiniti', () => {
    const s = createAppStore().getState();
    expect(s.view).toBe('portal');
    expect(s.panels).toEqual(DEFAULT_PANELS);
    expect(s.doc).toBeNull();
  });
  it('updateMeta imposta dirty e pushMessage aggiorna lo stato', () => {
    const store = createAppStore(() => new Date('2026-10-18T09:05:00'));
    store.getState().setDoc({
      project: createProject({ name: 'P', author: '', comment: '' }, new Date()),
      filePath: '/p',
      dirty: false,
    });
    store.getState().updateMeta({ author: 'Z' });
    expect(store.getState().doc).toMatchObject({ dirty: true, project: { meta: { author: 'Z' } } });
    store
      .getState()
      .pushMessage({ severity: 'info', textKey: 'messages.saved', params: { name: 'P' } });
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().status).toEqual({ textKey: 'messages.saved', params: { name: 'P' } });
  });
});
