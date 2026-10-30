import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  addHmiScreen,
  createHmiObject,
  createHmiScreen,
  findDevice,
  type HmiObject,
} from '@baaportal/project';
import { focusOpenRuntime } from '../../src/editors/hmi/HmiRuntime';
import type { PlcHmiArmResult, PlcHmiStuckEntry } from '../../src/online/plcTypes';
import { renderApp } from '../renderApp';
import { PLC, setupOnline } from '../online/downloadHelpers';

let n = 0;
const id = () => `o${++n}`;
function obj(kind: HmiObject['kind'], patch: Partial<HmiObject>): HmiObject {
  return { ...createHmiObject(kind, 0, 0, id), ...patch };
}

/** Online con una schermata: lampada Q 4.0, campo MW 10 con immissione, quattro pulsanti. */
async function openOnline() {
  const { app } = await setupOnline([]);
  act(() => {
    app.store.getState().edit('t', (p) => {
      const sc = createHmiScreen('Main', () => 'sc1');
      sc.objects.push(
        obj('lamp', { id: 'lamp', text: 'Motore', tag: 'Q 4.0' }),
        obj('ioField', { id: 'io', text: 'Velocità', tag: 'MW 10', format: 'INT', input: true }),
        obj('button', { id: 'set', text: 'Avvio', tag: 'M 0.1', action: 'set' }),
        obj('button', { id: 'jog', text: 'Avanti', tag: 'M 0.2', action: 'jog' }),
        obj('button', { id: 'wr', text: 'Cento', tag: 'MW 12', action: 'write', value: '100' }),
        obj('button', { id: 'tg', text: 'Commuta', tag: 'Q 4.0', action: 'toggle' }),
      );
      addHmiScreen(findDevice(p, PLC)!, sc);
    });
    app.store.getState().openEditor({ kind: 'hmiScreen', deviceId: PLC, objectId: 'sc1' });
  });
  await screen.findByTestId('hmi-canvas');
  // Q 4.0 a 1, MW 10 = 42, i bit dei pulsanti a 0
  app.bridge.plcReadWatchImpl = (items) => ({
    ok: true,
    values: items.map((t) =>
      t.area === 'Q'
        ? { bytes: Uint8Array.of(1) }
        : t.size === 'W'
          ? { bytes: Uint8Array.of(0, 42) }
          : { bytes: Uint8Array.of(0) },
    ),
  });
  return app;
}

const rt = () => within(screen.getByTestId('hmi-runtime'));

describe('runtime HMI sul PLC', () => {
  it('sola lettura (predefinito): valori dal giro di letture, nessuna scrittura', async () => {
    const app = await openOnline();
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    expect(app.bridge.plcHmiArmCalls).toBe(0);
    expect(rt().getByTestId('hmi-runtime-mode')).toHaveTextContent('PLC: sola lettura');
    await waitFor(() => expect(rt().getByRole('img', { name: 'Motore ON' })).toBeInTheDocument());
    expect(rt().getByLabelText('Velocità')).toHaveTextContent('42');
    // un solo giro con le variabili della schermata, ognuna una volta (Q 4.0 è di due oggetti)
    expect(app.bridge.plcReadWatchCalls[0]).toEqual([
      { area: 'Q', byte: 4, bit: 0, size: 'X' },
      { area: 'M', byte: 10, size: 'W' },
      { area: 'M', byte: 0, bit: 1, size: 'X' },
      { area: 'M', byte: 0, bit: 2, size: 'X' },
      { area: 'M', byte: 12, size: 'W' },
    ]);
    const avvio = rt().getByRole('button', { name: 'Avvio' });
    expect(avvio).toBeDisabled();
    fireEvent.pointerDown(avvio, { button: 0 });
    fireEvent.keyDown(avvio, { key: 'Enter' });
    expect(app.bridge.plcHmiWriteCalls).toEqual([]);
    await app.user.click(rt().getByRole('button', { name: 'Chiudi runtime' }));
    expect(screen.queryByTestId('hmi-runtime')).toBeNull();
    expect(app.bridge.plcHmiDisarmCalls).toBe(0);
  });

  it('scritture consentite: una conferma, poi pulsanti e campo scrivono i byte giusti', async () => {
    const app = await openOnline();
    await app.user.click(screen.getByLabelText('Consenti scritture nella CPU'));
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    expect(app.bridge.plcHmiArmCalls).toBe(1);
    expect(rt().getByTestId('hmi-runtime-mode')).toHaveTextContent('PLC: scritture consentite');
    await waitFor(() => expect(rt().getByRole('img', { name: 'Motore ON' })).toBeInTheDocument());
    const writes = () =>
      app.bridge.plcHmiWriteCalls.map((c) => c.map((w) => [w.target, [...w.data]]));

    fireEvent.pointerDown(rt().getByRole('button', { name: 'Avvio' }), { button: 0 });
    fireEvent.pointerUp(rt().getByRole('button', { name: 'Avvio' }));
    // a impulsi: 1 alla pressione, 0 al rilascio, nell'ordine
    const jog = rt().getByRole('button', { name: 'Avanti' });
    fireEvent.pointerDown(jog, { button: 0 });
    fireEvent.pointerUp(jog);
    fireEvent.pointerDown(rt().getByRole('button', { name: 'Cento' }), { button: 0 });
    // commuta parte dal valore letto (Q 4.0 = 1) → 0
    fireEvent.pointerDown(rt().getByRole('button', { name: 'Commuta' }), { button: 0 });
    const io = rt().getByLabelText('Velocità');
    await app.user.click(io);
    await app.user.clear(io);
    await app.user.type(io, '-7{Enter}');
    await waitFor(() => expect(app.bridge.plcHmiWriteCalls).toHaveLength(6));
    expect(writes()).toEqual([
      [[{ area: 'M', byte: 0, bit: 1, size: 'X' }, [1]]],
      [[{ area: 'M', byte: 0, bit: 2, size: 'X' }, [1]]],
      [[{ area: 'M', byte: 0, bit: 2, size: 'X' }, [0]]],
      [[{ area: 'M', byte: 12, size: 'W' }, [0, 100]]],
      [[{ area: 'Q', byte: 4, bit: 0, size: 'X' }, [0]]],
      [[{ area: 'M', byte: 10, size: 'W' }, [0xff, 0xf9]]],
    ]);
    // valore non valido: nessuna scrittura, un messaggio
    await app.user.click(io);
    await app.user.clear(io);
    await app.user.type(io, '99999{Enter}');
    expect(rt().getByTestId('hmi-runtime-status')).toHaveTextContent('Valore non valido');
    expect(app.bridge.plcHmiWriteCalls).toHaveLength(6);
    // un rifiuto del processo principale si vede nella barra
    app.bridge.plcHmiWriteResults.push({ ok: false, error: 'Scritture HMI non confermate' });
    fireEvent.pointerDown(rt().getByRole('button', { name: 'Avvio' }), { button: 0 });
    await waitFor(() =>
      expect(rt().getByTestId('hmi-runtime-status')).toHaveTextContent(
        'Scrittura non riuscita: Scritture HMI non confermate',
      ),
    );
  });

  it('chiudere con un pulsante a impulsi premuto scrive prima lo 0, poi revoca la conferma', async () => {
    const app = await openOnline();
    await app.user.click(screen.getByLabelText('Consenti scritture nella CPU'));
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    fireEvent.pointerDown(rt().getByRole('button', { name: 'Avanti' }), { button: 0 });
    fireEvent.keyDown(screen.getByTestId('hmi-runtime'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('hmi-runtime')).toBeNull());
    expect(app.bridge.plcHmiWriteCalls.map((c) => [...c[0]!.data])).toEqual([[1], [0]]);
    expect(app.bridge.plcHmiWriteJog).toEqual([true, undefined]);
    expect(app.bridge.plcHmiWriteTokens).toEqual(['tok', 'tok']);
    await waitFor(() => expect(app.bridge.plcHmiDisarmTokens).toEqual(['tok']));
  });

  it('conferma annullata: il runtime non parte', async () => {
    const app = await openOnline();
    app.bridge.plcHmiArmResult = { ok: false, cancelled: true };
    await app.user.click(screen.getByLabelText('Consenti scritture nella CPU'));
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    expect(app.bridge.plcHmiArmCalls).toBe(1);
    expect(screen.queryByTestId('hmi-runtime')).toBeNull();
  });

  it('pulsanti di navigazione: la nuova schermata legge le sue variabili', async () => {
    const app = await openOnline();
    act(() => {
      app.store.getState().edit('t', (p) => {
        const dev = findDevice(p, PLC)!;
        const two = createHmiScreen('Due', () => 'sc2');
        two.objects.push(obj('lamp', { id: 'l2', text: 'Altro', tag: 'M 5.0' }));
        addHmiScreen(dev, two);
        dev.hmi!.screens[0]!.objects.push(obj('screenButton', { text: 'Vai', screen: 'sc2' }));
      });
    });
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    await app.user.click(rt().getByRole('button', { name: 'Vai' }));
    await waitFor(() =>
      expect(app.bridge.plcReadWatchCalls.at(-1)).toEqual([
        { area: 'M', byte: 5, bit: 0, size: 'X' },
      ]),
    );
    expect(rt().getByRole('img', { name: 'Altro OFF' })).toBeInTheDocument();
  });
});

describe('runtime HMI: rilascio dei pulsanti a impulsi', () => {
  async function writing() {
    const app = await openOnline();
    await app.user.click(screen.getByLabelText('Consenti scritture nella CPU'));
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    return app;
  }
  const FAIL = { ok: false, error: 'Collegamento non riuscito' } as const;
  const data = (app: Awaited<ReturnType<typeof writing>>) =>
    app.bridge.plcHmiWriteCalls.map((c) => [...c[0]!.data]);

  it('un rilascio non riuscito si ritenta: al secondo tentativo lo 0 è scritto, nessun avviso', async () => {
    const app = await writing();
    const jog = rt().getByRole('button', { name: 'Avanti' });
    app.bridge.plcHmiWriteResults.push({ ok: true, results: [{ ok: true }] }, FAIL);
    fireEvent.pointerDown(jog, { button: 0 });
    fireEvent.pointerUp(jog);
    await waitFor(() => expect(data(app)).toEqual([[1], [0], [0]]));
    await waitFor(() => expect(rt().getByTestId('hmi-runtime-status')).toHaveTextContent(''));
    expect(rt().queryByTestId('hmi-runtime-stuck')).toBeNull();
  });

  it("rilascio mai riuscito: avviso fisso con l'indirizzo finché uno 0 non va a buon fine", async () => {
    const app = await writing();
    const jog = rt().getByRole('button', { name: 'Avanti' });
    app.bridge.plcHmiWriteResults.push({ ok: true, results: [{ ok: true }] }, FAIL, FAIL, FAIL);
    fireEvent.pointerDown(jog, { button: 0 });
    fireEvent.pointerUp(jog);
    const stuck = await rt().findByTestId('hmi-runtime-stuck');
    expect(stuck).toHaveTextContent('Uscita a impulsi forse rimasta a 1: M 0.2');
    expect(data(app)).toEqual([[1], [0], [0], [0]]);
    // altre scritture riuscite non lo tolgono
    fireEvent.pointerDown(rt().getByRole('button', { name: 'Avvio' }), { button: 0 });
    await waitFor(() => expect(app.bridge.plcHmiWriteCalls).toHaveLength(5));
    expect(rt().getByTestId('hmi-runtime-stuck')).toBeInTheDocument();
    // un nuovo rilascio riuscito sì
    fireEvent.pointerDown(jog, { button: 0 });
    fireEvent.pointerUp(jog);
    await waitFor(() => expect(rt().queryByTestId('hmi-runtime-stuck')).toBeNull());
  });

  it.each([
    ['cattura del puntatore persa', (el: HTMLElement) => fireEvent.lostPointerCapture(el)],
    ['puntatore annullato', (el: HTMLElement) => fireEvent.pointerCancel(el)],
    ['finestra senza focus', () => fireEvent.blur(window)],
    [
      'finestra nascosta',
      () => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        fireEvent(document, new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
      },
    ],
  ])('%s: il pulsante premuto si rilascia', async (_name, lose) => {
    const app = await writing();
    const jog = rt().getByRole('button', { name: 'Avanti' });
    fireEvent.pointerDown(jog, { button: 0 });
    lose(jog);
    await waitFor(() => expect(data(app)).toEqual([[1], [0]]));
  });

  it('campo di immissione: Invio senza aver scritto nulla non riscrive il valore letto', async () => {
    const app = await writing();
    const io = rt().getByLabelText('Velocità');
    await waitFor(() => expect(io).toHaveValue('42'));
    await app.user.click(io);
    await app.user.keyboard('{Enter}');
    expect(app.bridge.plcHmiWriteCalls).toEqual([]);
    await app.user.type(io, '3{Enter}'); // 42 e un 3 in coda: 423
    await waitFor(() => expect(data(app)).toEqual([[0x01, 0xa7]]));
  });

  it("un solo runtime nell'app: un secondo avvio porta in primo piano quello aperto", async () => {
    await writing();
    const close = rt().getByRole('button', { name: 'Chiudi runtime' });
    close.blur();
    expect(focusOpenRuntime()).toBe(true);
    expect(close).toHaveFocus();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId('hmi-runtime')).toBeNull());
    expect(focusOpenRuntime()).toBe(false);
  });
});

describe('runtime HMI: permessi, pause e impulsi forse rimasti a 1', () => {
  it('editor chiuso durante la conferma: il permesso arrivato dopo si revoca subito', async () => {
    const app = await openOnline();
    let answer!: (r: PlcHmiArmResult) => void;
    app.bridge.plcHmiArm = () => new Promise<PlcHmiArmResult>((r) => (answer = r));
    await app.user.click(screen.getByLabelText('Consenti scritture nella CPU'));
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    act(() => {
      const st = app.store.getState();
      st.closeEditor(st.workArea.panes[0]!);
    });
    await waitFor(() => expect(screen.queryByTestId('hmi-canvas')).toBeNull());
    await act(async () => answer({ ok: true, token: 'tardi' }));
    await waitFor(() => expect(app.bridge.plcHmiDisarmTokens).toEqual(['tardi']));
    expect(screen.queryByTestId('hmi-runtime')).toBeNull();
  });

  it('porta MPI usata da altri: «valori in pausa» finché la lettura non riprende', async () => {
    const app = await openOnline();
    const live = app.bridge.plcReadWatchImpl;
    app.bridge.plcReadWatchImpl = () => ({ ok: false, error: 'porta occupata', paused: true });
    await app.user.click(screen.getByRole('button', { name: 'Avvia runtime HMI' }));
    await waitFor(() =>
      expect(rt().getByTestId('hmi-runtime-paused')).toHaveTextContent('Valori in pausa'),
    );
    app.bridge.plcReadWatchImpl = live;
    await waitFor(() => expect(rt().getByTestId('hmi-runtime-paused')).toBeEmptyDOMElement());
    expect(rt().getByRole('img', { name: 'Motore ON' })).toBeInTheDocument();
  });

  const ENTRY: PlcHmiStuckEntry = {
    key: 'k1',
    address: 'M0.2',
    cpu: 'CPU 315-2 PN/DP (192.0.2.1)',
    at: '2026-10-30T10:00:00.000Z',
  };

  it('avviso degli impulsi rimasti dalla sessione precedente: resta finché non si conferma', async () => {
    const app = await renderApp({ configure: (b) => (b.plcHmiStuckList = [ENTRY]) });
    const notice = await screen.findByTestId('hmi-stuck-notice');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('forse rimasti a 1');
    expect(notice).toHaveTextContent('M0.2 (CPU CPU 315-2 PN/DP (192.0.2.1)');
    await app.user.click(within(notice).getByRole('button', { name: 'Ho controllato' }));
    expect(screen.queryByTestId('hmi-stuck-notice')).toBeNull();
    expect(app.bridge.plcHmiStuckAcks).toEqual([['k1']]);
  });

  it('un rilascio fallito nel processo principale arriva subito come avviso', async () => {
    const app = await renderApp();
    expect(screen.queryByTestId('hmi-stuck-notice')).toBeNull();
    act(() => app.bridge.emitPlcHmiStuck([ENTRY]));
    expect(await screen.findByTestId('hmi-stuck-notice')).toHaveTextContent('M0.2');
    act(() => app.bridge.emitPlcHmiStuck([])); // uno 0 riuscito lo toglie
    expect(screen.queryByTestId('hmi-stuck-notice')).toBeNull();
  });
});
