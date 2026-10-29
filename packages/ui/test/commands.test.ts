import { describe, expect, it } from 'vitest';
import { createCodeBlock, createProject, findDevice, type CodeBlock } from '@baaportal/project';
import { plc } from './blockFixtures';
import { commands, matchShortcut, type CommandContext } from '../src/commands/commands';
import { handleShortcutKeydown } from '../src/commands/useShortcuts';
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
      revision: 0,
      savedRevision: 0,
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

describe('annulla e ripeti', () => {
  function setup(platform: 'darwin' | 'win32') {
    const store = createAppStore();
    store.getState().setDoc({
      project: createProject({ name: 'P', author: 'Mario', comment: '' }, new Date()),
      filePath: '/p.baap',
      dirty: false,
      revision: 0,
      savedRevision: 0,
    });
    const ctx = { store, service: {} as never, bridge: { platform } as never } as CommandContext;
    const author = () => store.getState().doc!.project.meta.author;
    store.getState().edit('history.author', (p) => {
      p.meta.author = 'A';
    });
    return { store, ctx, author };
  }
  const key = (init: KeyboardEventInit & { key: string }, target?: Element) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (target) Object.defineProperty(e, 'target', { value: target });
    return e;
  };

  it("abilitati solo quando c'è qualcosa da annullare o ripetere", () => {
    const { store } = setup('win32');
    expect(commands['edit.undo'].isEnabled(store.getState())).toBe(true);
    expect(commands['edit.redo'].isEnabled(store.getState())).toBe(false);
    store.getState().undo();
    expect(commands['edit.undo'].isEnabled(store.getState())).toBe(false);
    expect(commands['edit.redo'].isEnabled(store.getState())).toBe(true);
  });

  it('su macOS Cmd+Z annulla, Cmd+Y e Cmd+Shift+Z ripetono', () => {
    const { ctx, author } = setup('darwin');
    expect(handleShortcutKeydown(key({ metaKey: true, key: 'z' }), ctx)).toBe(true);
    expect(author()).toBe('Mario');
    expect(handleShortcutKeydown(key({ metaKey: true, key: 'y' }), ctx)).toBe(true);
    expect(author()).toBe('A');
    handleShortcutKeydown(key({ metaKey: true, key: 'z' }), ctx);
    expect(handleShortcutKeydown(key({ metaKey: true, shiftKey: true, key: 'Z' }), ctx)).toBe(true);
    expect(author()).toBe('A');
  });

  it('dentro un campo di testo Cmd+Z non tocca il progetto', () => {
    const { store, ctx, author } = setup('darwin');
    const input = document.createElement('input');
    expect(handleShortcutKeydown(key({ metaKey: true, key: 'z' }, input), ctx)).toBe(false);
    expect(author()).toBe('A');
    expect(store.getState().history.past).toHaveLength(1);
  });

  it("dentro l'editor AWL (contenteditable) Mod+Z non tocca il progetto e Mod+S resta globale", () => {
    const { store, ctx, author } = setup('win32');
    let saved = 0;
    (ctx as { service: unknown }).service = {
      save: () => {
        saved++;
        return Promise.resolve();
      },
    };
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    expect(handleShortcutKeydown(key({ ctrlKey: true, key: 'z' }, editable), ctx)).toBe(false);
    expect(handleShortcutKeydown(key({ ctrlKey: true, key: 'y' }, editable), ctx)).toBe(false);
    expect(author()).toBe('A');
    expect(store.getState().history.past).toHaveLength(1);
    expect(handleShortcutKeydown(key({ ctrlKey: true, key: 's' }, editable), ctx)).toBe(true);
    expect(saved).toBe(1);
    editable.remove();
  });

  it('un tasto che si ripete non esegue il comando', () => {
    const { ctx, author } = setup('win32');
    expect(handleShortcutKeydown(key({ ctrlKey: true, key: 'z', repeat: true }), ctx)).toBe(false);
    expect(author()).toBe('A');
  });
});

describe('comandi Inserisci', () => {
  const doc = (devices: boolean) => {
    const project = createProject({ name: 'P', author: '', comment: '' }, new Date());
    if (devices) {
      for (const id of ['d1', 'd2']) {
        project.devices.push({
          id,
          name: id,
          cpu: { typeId: 'x', orderNumber: '', firmware: '' },
        } as never);
      }
    }
    return { project, filePath: '/p.baap', dirty: false, revision: 0, savedRevision: 0 };
  };
  const ctx = (store: ReturnType<typeof createAppStore>) =>
    ({ store }) as unknown as CommandContext;

  it('Nuovo dispositivo serve un progetto; Nuovo blocco serve almeno un PLC', () => {
    const store = createAppStore();
    expect(commands['insert.device'].isEnabled(store.getState())).toBe(false);
    expect(commands['insert.block'].isEnabled(store.getState())).toBe(false);
    store.getState().setDoc(doc(false));
    expect(commands['insert.device'].isEnabled(store.getState())).toBe(true);
    expect(commands['insert.block'].isEnabled(store.getState())).toBe(false);
    store.getState().setDoc(doc(true));
    expect(commands['insert.block'].isEnabled(store.getState())).toBe(true);
  });

  it('Nuovo blocco apre il dialogo sul PLC della selezione, altrimenti sul primo', () => {
    const store = createAppStore();
    store.getState().setDoc(doc(true));
    void commands['insert.block'].run(ctx(store));
    expect(store.getState().dialog).toEqual({ kind: 'addBlock', deviceId: 'd1' });
    store.getState().closeDialog();
    store.getState().select('plc:d2:blocks');
    void commands['insert.block'].run(ctx(store));
    expect(store.getState().dialog).toEqual({ kind: 'addBlock', deviceId: 'd2' });
    store.getState().closeDialog();
    void commands['insert.device'].run(ctx(store));
    expect(store.getState().dialog).toEqual({ kind: 'addDevice' });
    store.getState().setDoc(null);
    expect(store.getState().dialog).toBeNull();
  });
});

describe('scorciatoie online', () => {
  it('Ctrl+K collega, Ctrl+M interrompe, Ctrl+L carica', () => {
    expect(commands['online.goOnline'].shortcut).toBe('Mod+K');
    expect(commands['online.goOffline'].shortcut).toBe('Mod+M');
    expect(commands['online.download'].shortcut).toBe('Mod+L');
  });

  it('nessuna scorciatoia è ripetuta fra i comandi', () => {
    const all = Object.values(commands).flatMap((c) => [c.shortcut, ...(c.altShortcuts ?? [])]);
    const used = all.filter((s): s is string => !!s);
    expect(new Set(used).size).toBe(used.length);
  });

  it("Ctrl+L dentro l'editor AWL raggiunge il comando di carica (la conferma)", () => {
    const store = createAppStore();
    const ctx = {
      store,
      service: {} as never,
      bridge: { platform: 'win32' } as never,
    } as CommandContext;
    const cmd = commands['online.download'];
    const orig = { isEnabled: cmd.isEnabled, run: cmd.run };
    let runs = 0;
    cmd.isEnabled = () => true;
    cmd.run = () => {
      runs++;
    };
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const e = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'l',
    });
    Object.defineProperty(e, 'target', { value: editable });
    try {
      expect(handleShortcutKeydown(e, ctx)).toBe(true);
      expect(e.defaultPrevented).toBe(true);
      expect(runs).toBe(1);
    } finally {
      cmd.isEnabled = orig.isEnabled;
      cmd.run = orig.run;
    }
  });
});

describe('block.switchLanguage', () => {
  function setup(language: 'KOP' | 'FUP' | 'AWL' | 'SCL') {
    const store = createAppStore();
    const project = createProject({ name: 'P', author: '', comment: '' }, new Date());
    const dev = plc();
    const b = createCodeBlock({ kind: 'FC', number: 1, name: 'B', language });
    if (b.networks[0]) b.networks[0].lad = { root: { id: 'N', series: [], outs: [] } };
    dev.blocks.push(b);
    project.devices.push(dev);
    store.getState().setDoc({
      project,
      filePath: '/p.baap',
      dirty: false,
      revision: 0,
      savedRevision: 0,
    });
    store.getState().openEditor({ kind: 'block', deviceId: dev.id, objectId: b.id });
    const ctx = { store, service: {} as never, bridge: {} as never } as CommandContext;
    const cur = () =>
      findDevice(store.getState().doc!.project, dev.id)!.blocks.find(
        (x) => x.id === b.id,
      ) as CodeBlock;
    return { store, ctx, cur };
  }

  it('abilitato solo su un blocco KOP o FUP aperto', () => {
    const on = { KOP: true, FUP: true, AWL: false, SCL: false } as const;
    for (const lang of Object.keys(on) as (keyof typeof on)[])
      expect(commands['block.switchLanguage'].isEnabled(setup(lang).store.getState())).toBe(
        on[lang],
      );
    expect(commands['block.switchLanguage'].isEnabled(createAppStore().getState())).toBe(false);
  });

  it('KOP → FUP → KOP lascia i segmenti uguali; annulla e ripeti funzionano', () => {
    const { store, ctx, cur } = setup('KOP');
    const before = structuredClone(cur().networks);
    void commands['block.switchLanguage'].run(ctx);
    expect(cur().language).toBe('FUP');
    void commands['block.switchLanguage'].run(ctx);
    expect(cur().language).toBe('KOP');
    expect(cur().networks).toEqual(before);
    store.getState().undo();
    expect(cur().language).toBe('FUP');
    store.getState().redo();
    expect(cur().language).toBe('KOP');
  });
});
