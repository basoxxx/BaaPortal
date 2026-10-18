import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, readBaap, writeBaap } from '@baaportal/project';
import { t } from '../src/i18n';
import { initI18n } from '../src/i18n';
import { createProjectService, type ProjectService } from '../src/services/projectService';
import {
  RECOVERY_INTERVAL_MS,
  createRecoveryService,
  recoveryKey,
  type RecoveryService,
} from '../src/services/recoveryService';
import { createAppStore } from '../src/state/store';
import { FakeBridge } from './fakeBridge';

const NOW = new Date('2026-10-18T11:00:00Z');
const PATH = '/doc/P.baap';
let bridge: FakeBridge;
let store: ReturnType<typeof createAppStore>;
let svc: ProjectService;
let rec: RecoveryService;

function project(name = 'P') {
  return createProject({ name, author: 'A', comment: '' }, new Date('2026-01-01T00:00:00Z'));
}
function openDoc(path = PATH, name = 'P') {
  store.getState().setDoc({
    project: project(name),
    filePath: path,
    dirty: false,
    revision: 0,
    savedRevision: 0,
  });
}
function edit(comment: string) {
  expect(
    store.getState().edit('x', (d) => {
      d.meta.comment = comment;
    }),
  ).toBe(true);
}
const tick = (ms = RECOVERY_INTERVAL_MS) => vi.advanceTimersByTimeAsync(ms);

beforeEach(async () => {
  await initI18n('it');
  vi.useFakeTimers();
  bridge = new FakeBridge();
  store = createAppStore(() => NOW);
  svc = createProjectService({
    store,
    bridge,
    t,
    appVersion: '0.1.0',
    now: () => NOW,
    beforeWindowClose: () => rec.clear(store.getState().doc?.filePath ?? ''),
  });
  rec = createRecoveryService({
    store,
    bridge,
    t,
    appVersion: '0.1.0',
    service: svc,
    now: () => NOW,
  });
});

afterEach(() => {
  rec.dispose();
  svc.dispose();
  vi.useRealTimers();
});

describe('recoveryKey', () => {
  it('stabile, senza caratteri vietati e senza distinguere maiuscole', () => {
    expect(recoveryKey('C:\\P\\A.baap')).toMatch(/^p-[0-9a-f]{8}$/);
    expect(recoveryKey('c:\\p\\a.baap')).toBe(recoveryKey('C:\\P\\A.baap'));
    expect(recoveryKey('/a.baap')).not.toBe(recoveryKey('/b.baap'));
  });
});

describe('recoveryService - scrittura periodica', () => {
  it('scrive una copia solo se modificato e cambiato', async () => {
    openDoc();
    await tick();
    expect(bridge.recovery.size).toBe(0); // non modificato
    edit('uno');
    await tick();
    expect(bridge.recovery.size).toBe(1);
    const entry = bridge.recovery.get(recoveryKey(PATH))!;
    expect(entry.info).toEqual({
      originalPath: PATH,
      projectName: 'P',
      savedAt: NOW.toISOString(),
    });
    expect(readBaap(entry.data).meta.comment).toBe('uno');
    // senza nuove modifiche nessuna nuova scrittura
    const spy = vi.spyOn(bridge, 'recoveryWrite');
    await tick();
    await tick();
    expect(spy).not.toHaveBeenCalled();
    edit('due');
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readBaap(bridge.recovery.get(recoveryKey(PATH))!.data).meta.comment).toBe('due');
  });

  it("usa l'intervallo di testOverrides e si ferma con dispose", async () => {
    rec.dispose();
    bridge.testOverridesValue = { recoveryIntervalMs: 100 };
    rec = createRecoveryService({ store, bridge, t, appVersion: '0.1.0', service: svc });
    openDoc();
    edit('uno');
    await tick(150);
    expect(bridge.recovery.size).toBe(1);
    bridge.recovery.clear();
    rec.dispose();
    edit('due');
    await tick(1000);
    expect(bridge.recovery.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('un errore di scrittura è un avviso una sola volta e non lancia', async () => {
    vi.spyOn(bridge, 'recoveryWrite').mockRejectedValue(new Error('boom'));
    openDoc();
    edit('uno');
    await tick();
    edit('due');
    await tick();
    const warnings = store.getState().messages.filter((m) => m.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.textKey).toBe('messages.recoveryWriteFailed');
  });
});

describe('recoveryService - pulizia', () => {
  it('un salvataggio riuscito cancella la copia', async () => {
    openDoc();
    edit('uno');
    await tick();
    expect(bridge.recovery.size).toBe(1);
    expect(await svc.save()).toBe(true);
    expect(bridge.recovery.size).toBe(0);
  });

  it('chiudere il documento cancella la copia', async () => {
    openDoc();
    edit('uno');
    await tick();
    bridge.confirmAnswers.push('discard');
    expect(await svc.close()).toBe(true);
    expect(bridge.recovery.size).toBe(0);
  });

  it('Salva con nome cancella la copia del vecchio percorso', async () => {
    openDoc();
    edit('uno');
    await tick();
    bridge.saveDialogResults.push('/doc/Nuovo.baap');
    expect(await svc.saveAs()).toBe(true);
    expect(bridge.recovery.size).toBe(0);
    edit('due');
    await tick();
    expect([...bridge.recovery.keys()]).toEqual([recoveryKey('/doc/Nuovo.baap')]);
  });

  it('uscita con "Non salvare" cancella la copia prima di chiudere la finestra', async () => {
    openDoc();
    edit('uno');
    await tick();
    expect(bridge.recovery.size).toBe(1);
    bridge.confirmAnswers.push('discard');
    await svc.handleCloseRequest();
    expect(bridge.recovery.size).toBe(0);
    expect(bridge.closeConfirmed).toBe(true);
  });

  it('uscita annullata mantiene la copia', async () => {
    openDoc();
    edit('uno');
    await tick();
    bridge.confirmAnswers.push('cancel');
    await svc.handleCloseRequest();
    expect(bridge.recovery.size).toBe(1);
    expect(bridge.closeConfirmed).toBe(false);
  });

  it('un errore di cancellazione è ignorato', async () => {
    openDoc();
    edit('uno');
    await tick();
    vi.spyOn(bridge, 'recoveryDelete').mockRejectedValue(new Error('boom'));
    await expect(svc.save()).resolves.toBe(true);
  });
});

describe("recoveryService - all'avvio", () => {
  function seed(name = 'Linea', path = '/doc/Linea.baap') {
    const p = project(name);
    bridge.recovery.set(recoveryKey(path), {
      data: writeBaap(p, { appVersion: '0.1.0' }),
      info: { originalPath: path, projectName: name, savedAt: '2026-10-18T10:30:00.000Z' },
    });
  }

  it('Recupera apre il documento modificato con il percorso originale e cancella la voce', async () => {
    vi.useRealTimers();
    seed();
    bridge.questionAnswers.push(true);
    await rec.offerRecovery();
    expect(bridge.questions).toHaveLength(1);
    expect(bridge.questions[0]).toMatchObject({ yes: 'Recupera', no: 'Elimina' });
    expect(bridge.questions[0]?.message).toContain('«Linea»');
    expect(bridge.questions[0]?.message).toContain('BaaPortal non è stato chiuso correttamente');
    const doc = store.getState().doc;
    expect(doc).toMatchObject({ filePath: '/doc/Linea.baap', dirty: true });
    expect(doc?.project.meta.name).toBe('Linea');
    expect(bridge.recovery.size).toBe(0);
    expect(store.getState().messages.some((m) => m.textKey === 'messages.recovered')).toBe(true);
  });

  it('Elimina cancella la voce senza aprire', async () => {
    vi.useRealTimers();
    seed();
    bridge.questionAnswers.push(false);
    await rec.offerRecovery();
    expect(store.getState().doc).toBeNull();
    expect(bridge.recovery.size).toBe(0);
  });

  it('recupero illeggibile: messaggio ed eliminazione', async () => {
    vi.useRealTimers();
    seed();
    bridge.recovery.get(recoveryKey('/doc/Linea.baap'))!.data = new Uint8Array([1, 2, 3]);
    await rec.offerRecovery();
    expect(store.getState().doc).toBeNull();
    expect(bridge.errors).toHaveLength(1);
    expect(bridge.errors[0]?.message).toContain('progetto BaaPortal');
    expect(bridge.recovery.size).toBe(0);
  });

  it("se l'utente annulla lo scarto del documento aperto la voce resta", async () => {
    vi.useRealTimers();
    seed();
    openDoc('/doc/Altro.baap', 'Altro');
    edit('x');
    bridge.confirmAnswers.push('cancel');
    await rec.offerRecovery();
    expect(store.getState().doc?.filePath).toBe('/doc/Altro.baap');
    expect(bridge.recovery.has(recoveryKey('/doc/Linea.baap'))).toBe(true);
  });

  it('più voci sono trattate in sequenza', async () => {
    vi.useRealTimers();
    seed('A', '/doc/A.baap');
    seed('B', '/doc/B.baap');
    bridge.questionAnswers.push(false, false);
    await rec.offerRecovery();
    expect(bridge.questions).toHaveLength(2);
    expect(bridge.recovery.size).toBe(0);
  });
});
