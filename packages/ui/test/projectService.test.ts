import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, readBaap, writeBaap } from '@baaportal/project';
import { strToU8 } from 'fflate';
import { t } from '../src/i18n';
import { createProjectService, type ProjectService } from '../src/services/projectService';
import { createAppStore } from '../src/state/store';
import { FakeBridge } from './fakeBridge';

const NOW = new Date('2026-10-18T11:00:00Z');
let bridge: FakeBridge;
let store: ReturnType<typeof createAppStore>;
let svc: ProjectService;

function bytes(name: string) {
  return writeBaap(createProject({ name, author: 'A', comment: '' }, new Date('2026-01-01T00:00:00Z')), { appVersion: '0.1.0' });
}
async function openValid(path: string) {
  bridge.files.set(path, bytes(path.replace(/^\//, '').replace('.baap', '')));
  expect(await svc.open(path)).toBe(true);
}

beforeEach(() => {
  bridge = new FakeBridge();
  store = createAppStore(() => NOW);
  svc = createProjectService({ store, bridge, t, appVersion: '0.1.0', now: () => NOW });
});

describe('projectService', () => {
  it('si registra sul bridge e chiama rendererReady', () => {
    expect(bridge.listenerCount).toBe(2);
    expect(bridge.readyCalls).toBe(1);
    svc.dispose();
    expect(bridge.listenerCount).toBe(0);
  });

  it('createNew scrive <dir>/<name>.baap, apre il documento e lo aggiunge ai recenti', async () => {
    expect(await svc.createNew({ name: 'Linea 3', dir: '/doc/BaaPortal', author: 'M', comment: '' })).toEqual({ ok: true });
    expect(bridge.files.has('/doc/BaaPortal/Linea 3.baap')).toBe(true);
    expect(store.getState().doc).toMatchObject({ filePath: '/doc/BaaPortal/Linea 3.baap', dirty: false });
    expect(bridge.title).toBe('BaaPortal - /doc/BaaPortal/Linea 3.baap');
    expect(bridge.recent[0]?.name).toBe('Linea 3');
    expect(store.getState().messages[0]?.textKey).toBe('messages.created');
  });

  it('createNew non sovrascrive un progetto esistente', async () => {
    const original = bytes('x');
    bridge.files.set('/d/P.baap', original);
    expect(await svc.createNew({ name: 'P', dir: '/d', author: '', comment: '' })).toEqual({ ok: false, error: 'EXISTS' });
    expect(bridge.files.get('/d/P.baap')).toBe(original);
    expect(bridge.errors[0]?.message).toBe(t('errors.exists', { path: '/d/P.baap' }));
  });

  it('createNew con scrittura fallita segnala WRITE_FAILED', async () => {
    bridge.failNextWrite('ENOSPC');
    expect(await svc.createNew({ name: 'P', dir: '/d', author: '', comment: '' })).toEqual({ ok: false, error: 'WRITE_FAILED' });
    expect(bridge.errors[0]?.message).toBe(t('errors.write', { path: '/d/P.baap', code: 'ENOSPC' }));
    expect(store.getState().doc).toBeNull();
  });

  it('open di un file danneggiato mostra l\'errore e lascia aperto il progetto corrente', async () => {
    await openValid('/a.baap');
    bridge.files.set('/rotto.baap', strToU8('xx'));
    expect(await svc.open('/rotto.baap')).toBe(false);
    expect(bridge.errors[0]?.message).toBe(t('errors.baap.NOT_ZIP'));
    expect(store.getState().doc?.filePath).toBe('/a.baap');
  });

  it('open di un file più recente usa errors.baap.NEWER_FORMAT', async () => {
    const { zipSync } = await import('fflate');
    bridge.files.set('/n.baap', zipSync({ 'baaportal.json': strToU8(JSON.stringify({ formatVersion: 99 })) }));
    expect(await svc.open('/n.baap')).toBe(false);
    expect(bridge.errors[0]?.message).toBe(t('errors.baap.NEWER_FORMAT'));
  });

  it('open di un file mancante usa errors.read', async () => {
    expect(await svc.open('/no.baap')).toBe(false);
    expect(bridge.errors[0]?.message).toBe(t('errors.read', { path: '/no.baap', code: 'ENOENT' }));
  });

  it.each([
    ['cancel', false, '/a.baap'],
    ['discard', true, '/b.baap'],
  ] as const)('con modifiche non salvate e risposta %s, open restituisce %s', async (answer, result, finalPath) => {
    await openValid('/a.baap');
    bridge.files.set('/b.baap', bytes('b'));
    store.getState().updateMeta({ author: 'X' });
    bridge.confirmAnswers.push(answer);
    expect(await svc.open('/b.baap')).toBe(result);
    expect(store.getState().doc?.filePath).toBe(finalPath);
  });

  it('con risposta save salva prima e poi apre', async () => {
    await openValid('/a.baap');
    bridge.files.set('/b.baap', bytes('b'));
    store.getState().updateMeta({ author: 'X' });
    bridge.confirmAnswers.push('save');
    expect(await svc.open('/b.baap')).toBe(true);
    expect(readBaap(bridge.files.get('/a.baap')!).meta.author).toBe('X');
    expect(store.getState().doc?.filePath).toBe('/b.baap');
  });

  it('con risposta save ma salvataggio fallito, interrompe', async () => {
    await openValid('/a.baap');
    bridge.files.set('/b.baap', bytes('b'));
    store.getState().updateMeta({ author: 'X' });
    bridge.confirmAnswers.push('save');
    bridge.failNextWrite('EBUSY');
    expect(await svc.open('/b.baap')).toBe(false);
    expect(store.getState().doc?.filePath).toBe('/a.baap');
  });

  it('salvataggio fallito: messaggio d\'errore, resta dirty, il file su disco non cambia', async () => {
    await openValid('/a.baap');
    store.getState().updateMeta({ author: 'X' });
    bridge.failNextWrite('EACCES');
    expect(await svc.save()).toBe(false);
    expect(store.getState().doc?.dirty).toBe(true);
    expect(readBaap(bridge.files.get('/a.baap')!).meta.author).not.toBe('X');
    expect(bridge.errors).toHaveLength(1);
    expect(bridge.errors[0]?.message).toBe(t('errors.write', { path: '/a.baap', code: 'EACCES' }));
  });

  it('save aggiorna modifiedAt e azzera dirty', async () => {
    await openValid('/a.baap');
    store.getState().updateMeta({ comment: 'c' });
    expect(await svc.save()).toBe(true);
    expect(readBaap(bridge.files.get('/a.baap')!).meta.modifiedAt).toBe(NOW.toISOString());
    expect(store.getState().doc?.dirty).toBe(false);
    expect(store.getState().messages.at(-1)?.textKey).toBe('messages.saved');
  });

  it('saveAs cambia percorso e titolo; annullato non cambia nulla', async () => {
    await openValid('/a.baap');
    bridge.saveDialogResults.push(null);
    expect(await svc.saveAs()).toBe(false);
    expect(store.getState().doc?.filePath).toBe('/a.baap');
    bridge.saveDialogResults.push('/c.baap');
    expect(await svc.saveAs()).toBe(true);
    expect(store.getState().doc?.filePath).toBe('/c.baap');
    expect(bridge.title).toBe('BaaPortal - /c.baap');
    expect(bridge.files.has('/c.baap')).toBe(true);
  });

  it('close senza modifiche chiude e ripristina il titolo; senza progetto restituisce true', async () => {
    expect(await svc.close()).toBe(true);
    await openValid('/a.baap');
    expect(await svc.close()).toBe(true);
    expect(store.getState().doc).toBeNull();
    expect(bridge.title).toBe('BaaPortal');
  });

  it('openFromDialog annullato restituisce false', async () => {
    bridge.openDialogResults.push(null);
    expect(await svc.openFromDialog()).toBe(false);
  });

  it('richiesta di chiusura senza modifiche chiude la finestra', async () => {
    await bridge.emitCloseRequest();
    expect(bridge.closeConfirmed).toBe(true);
  });

  it('richiesta di chiusura con modifiche e Annulla: la finestra non si chiude', async () => {
    await openValid('/a.baap');
    store.getState().updateMeta({ comment: 'c' });
    bridge.confirmAnswers.push('cancel');
    await bridge.emitCloseRequest();
    expect(bridge.closeConfirmed).toBe(false);
  });

  it('richiesta di apertura dal sistema con modifiche non salvate chiede prima di sostituire', async () => {
    await openValid('/a.baap');
    bridge.files.set('/b.baap', bytes('b'));
    store.getState().updateMeta({ comment: 'c' });
    bridge.confirmAnswers.push('cancel');
    await bridge.emitOpenFile('/b.baap');
    expect(store.getState().doc?.filePath).toBe('/a.baap');
  });
});
