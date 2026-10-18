import { describe, expect, it } from 'vitest';
import { createProject } from '@baaportal/project';
import { commands, matchShortcut } from '../src/commands/commands';
import { createAppStore } from '../src/state/store';

describe('matchShortcut', () => {
  it.each([
    ['win32', { ctrlKey: true, key: 's' }, true],
    ['win32', { metaKey: true, key: 's' }, false],
    ['darwin', { metaKey: true, key: 's' }, true],
    ['darwin', { ctrlKey: true, key: 's' }, false],
  ] as const)('%s: Mod+S con %o -> %s', (platform, init, expected) => {
    expect(matchShortcut(new KeyboardEvent('keydown', init), 'Mod+S', platform)).toBe(expected);
  });

  it('Mod+Shift+S non scatta con Mod+S e viceversa', () => {
    const plain = new KeyboardEvent('keydown', { ctrlKey: true, key: 's' });
    const shifted = new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'S' });
    expect(matchShortcut(plain, 'Mod+Shift+S', 'win32')).toBe(false);
    expect(matchShortcut(shifted, 'Mod+Shift+S', 'win32')).toBe(true);
    expect(matchShortcut(shifted, 'Mod+S', 'win32')).toBe(false);
  });
});

describe('comandi', () => {
  it('salva e chiudi sono disattivati senza progetto e attivi con progetto aperto', () => {
    const store = createAppStore();
    for (const id of ['project.save', 'project.saveAs', 'project.close'] as const) {
      expect(commands[id].isEnabled(store.getState())).toBe(false);
    }
    store.getState().setDoc({
      project: createProject({ name: 'P', author: '', comment: '' }, new Date()),
      filePath: '/p.baap',
      dirty: false,
    });
    for (const id of ['project.save', 'project.saveAs', 'project.close'] as const) {
      expect(commands[id].isEnabled(store.getState())).toBe(true);
    }
  });

  it('i comandi non ancora attivi sono disattivati', () => {
    const s = createAppStore().getState();
    expect(commands['edit.undo'].isEnabled(s)).toBe(false);
    expect(commands['online.goOnline'].isEnabled(s)).toBe(false);
  });

  it('project.new porta alla vista portale, Avvio, nuovo', async () => {
    const store = createAppStore();
    store.getState().setView('project');
    await commands['project.new'].run({ store, service: {} as never, bridge: {} as never });
    expect(store.getState()).toMatchObject({ view: 'portal', portal: 'start', startAction: 'new' });
  });

  it('view.navigation inverte lo stato del pannello e riporta lo stato spuntato', async () => {
    const store = createAppStore();
    const ctx = { store, service: {} as never, bridge: {} as never };
    expect(commands['view.navigation'].isChecked?.(store.getState())).toBe(true);
    await commands['view.navigation'].run(ctx);
    expect(store.getState().panels.navigation.open).toBe(false);
    expect(commands['view.navigation'].isChecked?.(store.getState())).toBe(false);
  });

  it('project.exit esegue handleCloseRequest', async () => {
    let called = 0;
    const service = {
      handleCloseRequest: async () => {
        called++;
      },
    } as never;
    await commands['project.exit'].run({ store: createAppStore(), service, bridge: {} as never });
    expect(called).toBe(1);
  });
});
