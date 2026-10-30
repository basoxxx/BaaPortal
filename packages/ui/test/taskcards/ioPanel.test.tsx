import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { findDevice } from '@baaportal/project';
import { simControllerFor } from '../../src/sim/simController';
import { renderApp } from '../renderApp';

const PLC = 'id1';

async function setup(patch: Record<string, unknown> = {}, tags: [string, string][] = []) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  const dev = findDevice(app.store.getState().doc!.project, PLC)!;
  dev.tagTables[0]!.tags.push(
    ...tags.map(([name, address], i) => ({
      id: `tg${i}`,
      name,
      type: 'Bool',
      address,
      hmi: false,
      comment: '',
    })),
  );
  act(() => app.store.getState().setTaskCard('test'));
  act(() =>
    app.store.getState().setSim({
      phase: 'on',
      deviceId: PLC,
      mode: 'RUN',
      inputs: new Uint8Array(8),
      outputs: new Uint8Array(8),
      ...patch,
    }),
  );
  const c = simControllerFor(app.store);
  const setInputs = vi.spyOn(c, 'setInputs').mockResolvedValue();
  const interrupt = vi.spyOn(c, 'interrupt').mockResolvedValue();
  return { app, setInputs, interrupt };
}

describe('pannello I/O del simulatore', () => {
  it('senza simulazione invita ad avviarla', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    act(() => app.store.getState().setTaskCard('test'));
    expect(screen.queryByTestId('io-fault')).toBeNull();
    expect(screen.getAllByText('Avvia la simulazione per usare il pannello')).toHaveLength(3);
  });

  it('mostra i byte dei tag in I e Q, con il simbolo; il clic commuta il bit', async () => {
    const { app, setInputs } = await setup(
      { inputs: Uint8Array.of(0, 0b0000_0100, 0, 0, 0, 0, 0, 0) },
      [
        ['Start', 'I 1.0'],
        ['Motore', 'Q 4.3'],
        ['Parola', 'IW 2'],
        ['Merker', 'M 0.0'],
      ],
    );
    expect(screen.getByTestId('in-bit-1-0')).toHaveAccessibleName('I 1.0 (Start)');
    expect(screen.getByTestId('in-bit-1-2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('in-bit-2-0')).toBeInTheDocument();
    expect(screen.getByTestId('in-bit-3-7')).toBeInTheDocument(); // IW 2 copre i byte 2 e 3
    expect(screen.queryByTestId('in-bit-0-0')).toBeNull();
    expect(screen.getByTestId('out-bit-4-3')).toHaveAccessibleName('Q 4.3 (Motore): 0');
    expect(screen.queryByTestId('out-bit-0-0')).toBeNull(); // M non conta
    await app.user.click(screen.getByTestId('in-bit-1-0'));
    expect(setInputs).toHaveBeenCalledWith(1, Uint8Array.of(0b0000_0101));
    await app.user.click(screen.getByTestId('in-bit-1-2'));
    expect(setInputs).toHaveBeenLastCalledWith(1, Uint8Array.of(0));
  });

  it('le uscite sono in sola lettura e seguono la notifica', async () => {
    const { app, setInputs } = await setup(
      { outputs: Uint8Array.of(0, 0, 0, 0, 0b1000, 0, 0, 0) },
      [['Motore', 'Q 4.3']],
    );
    const bit = screen.getByTestId('out-bit-4-3');
    expect(bit).toHaveAttribute('data-on', 'true');
    expect(bit.tagName).not.toBe('BUTTON');
    await app.user.click(bit);
    expect(setInputs).not.toHaveBeenCalled();
    act(() => app.store.getState().setSim({ outputs: new Uint8Array(8) }));
    expect(screen.getByTestId('out-bit-4-3')).toHaveAttribute('data-on', 'false');
  });

  it('+ byte aggiunge un byte alla sessione; valori non validi sono rifiutati', async () => {
    const { app } = await setup();
    expect(screen.queryByTestId('in-bit-5-0')).toBeNull();
    await app.user.type(screen.getByTestId('io-add-inputs'), '5');
    await app.user.click(screen.getByTestId('io-add-inputs-btn'));
    expect(screen.getByTestId('in-bit-5-7')).toBeInTheDocument();
    expect(app.store.getState().sim.ioExtra.inputs).toEqual([5]);
    await app.user.type(screen.getByTestId('io-add-outputs'), '99');
    await app.user.click(screen.getByTestId('io-add-outputs-btn'));
    expect(screen.getByText('Byte non valido o fuori area.')).toBeInTheDocument();
    expect(app.store.getState().sim.ioExtra.outputs).toEqual([]);
  });

  it('PIW: scrive INT big-endian, anche negativo', async () => {
    const { app, setInputs } = await setup();
    const addr = screen.getByTestId('piw-address');
    const val = screen.getByTestId('piw-value');
    await app.user.clear(addr);
    await app.user.type(addr, 'PIW 2');
    await app.user.clear(val);
    await app.user.type(val, '-2');
    await app.user.click(screen.getByTestId('piw-write'));
    expect(setInputs).toHaveBeenLastCalledWith(2, Uint8Array.of(0xff, 0xfe));
    await app.user.clear(val);
    await app.user.type(val, '258');
    await app.user.click(screen.getByTestId('piw-write'));
    expect(setInputs).toHaveBeenLastCalledWith(2, Uint8Array.of(1, 2));
  });

  it.each([
    ['PIW 2', '32768', 'Valore non valido'],
    ['PIW 2', 'abc', 'Valore non valido'],
    ['PIB 2', '1', 'Indirizzo non valido'],
    ['PIW 7', '1', 'Indirizzo fuori dall'],
  ])('PIW %s = %s è rifiutato', async (a, v, msg) => {
    const { app, setInputs } = await setup();
    await app.user.clear(screen.getByTestId('piw-address'));
    await app.user.type(screen.getByTestId('piw-address'), a);
    await app.user.clear(screen.getByTestId('piw-value'));
    await app.user.type(screen.getByTestId('piw-value'), v);
    await app.user.click(screen.getByTestId('piw-write'));
    expect(screen.getByRole('alert')).toHaveTextContent(msg);
    expect(setInputs).not.toHaveBeenCalled();
  });

  it('Simula guasto: OB82 e OB86 con l indirizzo del modulo; solo in RUN', async () => {
    const { app, interrupt } = await setup();
    await app.user.clear(screen.getByTestId('fault-address'));
    await app.user.type(screen.getByTestId('fault-address'), '256');
    await app.user.click(screen.getByTestId('fault-ob82'));
    await app.user.click(screen.getByTestId('fault-ob86'));
    expect(interrupt).toHaveBeenNthCalledWith(1, 82, 256);
    expect(interrupt).toHaveBeenNthCalledWith(2, 86, 256);
    await app.user.clear(screen.getByTestId('fault-address'));
    await app.user.type(screen.getByTestId('fault-address'), '70000');
    await app.user.click(screen.getByTestId('fault-ob82'));
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Indirizzo non valido');
    act(() => app.store.getState().setSim({ mode: 'STOP' }));
    expect(screen.getByTestId('fault-ob82')).toBeDisabled();
    expect(screen.getByTestId('fault-ob86')).toBeDisabled();
  });

  it('Forzamento: aggiunge una voce, la sostituisce, termina; LED FRCE dalla tabella', async () => {
    const { app } = await setup();
    const setForce = vi.spyOn(simControllerFor(app.store), 'setForce').mockResolvedValue();
    await app.user.type(screen.getByTestId('force-address'), 'MW 10');
    await app.user.clear(screen.getByTestId('force-value'));
    await app.user.type(screen.getByTestId('force-value'), '-2');
    await app.user.click(screen.getByTestId('force-add'));
    expect(setForce).toHaveBeenCalledWith([
      { area: 'M', byte: 10, size: 'W', data: Uint8Array.of(0xff, 0xfe) },
    ]);
    await app.user.clear(screen.getByTestId('force-address'));
    await app.user.type(screen.getByTestId('force-address'), 'PIW 0');
    await app.user.click(screen.getByTestId('force-add'));
    expect(screen.getByRole('alert')).toHaveTextContent('si forzano solo I, Q e M');
    act(() =>
      app.store.getState().setSim({
        forces: [{ area: 'Q', byte: 4, bit: 1, size: 'X', data: Uint8Array.of(1) }],
      }),
    );
    expect(screen.getByTestId('force-row-Q 4.1')).toHaveTextContent('Q 4.1 = 1');
    expect(screen.getByTestId('plc-force-warning')).toBeInTheDocument();
    await app.user.click(screen.getByTestId('force-clear'));
    expect(setForce).toHaveBeenLastCalledWith([]);
  });
});
