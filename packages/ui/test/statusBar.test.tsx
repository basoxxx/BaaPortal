import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../src/commands/commands';
import { getProgress } from '../src/project/progress';
import { renderApp } from './renderApp';

// Un gancio sul compilatore di ogni blocco: il test osserva la barra e può premere Interrompi.
const hook = vi.hoisted(() => ({ onBlock: (n: number): void => void n, n: 0 }));
vi.mock('@baaportal/project', async (importOriginal) => {
  const real = await importOriginal<typeof import('@baaportal/project')>();
  return {
    ...real,
    blockToMc7File: (...a: Parameters<typeof real.blockToMc7File>) => {
      hook.onBlock(++hook.n);
      return real.blockToMc7File(...a);
    },
  };
});

const T = 30_000;
// La compilazione di 5 blocchi con la barra che si aggiorna supera il secondo di waitFor quando la
// macchina è carica (tutta la suite in parallelo): stesso esito su main, non è una regressione.
const W = { timeout: 10_000 };
const PLC = 'id1';

function fc(n: number): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: n, name: `FC${n}`, language: 'AWL' });
  b.networks[0]!.source = 'A %I0.0\n= %Q0.0';
  return b;
}

async function setup() {
  hook.n = 0;
  hook.onBlock = () => undefined;
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(fc(1), fc(2), fc(3), fc(4));
    });
  });
  return app; // OB1 + 4 FC = 5 blocchi
}

describe('statusBar', () => {
  it(
    'durante la compilazione di 5 blocchi la barra mostra 0/5 … 5/5 e Interrompi',
    async () => {
      const app = await setup();
      const seen: string[] = [];
      let buttonSeen = false;
      hook.onBlock = () => {
        const p = getProgress();
        seen.push(`${p?.done}/${p?.total}`);
        buttonSeen ||= screen.queryByRole('button', { name: 'Interrompi' }) !== null;
      };
      let atEnd = '';
      app.store.subscribe((s) => {
        if (s.compile.summary && !atEnd) atEnd = `${getProgress()?.done}/${getProgress()?.total}`;
      });
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(app.store.getState().compile.summary).not.toBeNull(), W);
      expect(seen).toEqual(['0/5', '1/5', '2/5', '3/5', '4/5']);
      expect(atEnd).toBe('5/5');
      expect(buttonSeen).toBe(true);
      await waitFor(() => expect(getProgress()).toBeNull(), W);
      expect(screen.queryByRole('button', { name: 'Interrompi' })).toBeNull();
      expect(screen.getByTestId('status-bar')).not.toHaveTextContent('Compilazione in corso');
    },
    T,
  );

  it(
    'Interrompi dopo 2 blocchi → 2 compilati, 3 da compilare, messaggio "Compilazione interrotta"',
    async () => {
      const app = await setup();
      hook.onBlock = (n) => {
        if (n === 2) act(() => getProgress()!.cancel!());
      };
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(screen.getByTestId('compile-interrupted')).toBeVisible(), W);
      expect(screen.getByTestId('compile-interrupted')).toHaveTextContent(
        'Compilazione interrotta',
      );
      expect(Object.keys(app.store.getState().compile.hashes)).toHaveLength(2);
      expect(screen.getAllByTestId('compile-row')).toHaveLength(2);
      await waitFor(() => expect(getProgress()).toBeNull(), W);
      expect(screen.getByTestId('status-bar')).toHaveTextContent('Compilazione interrotta');

      // Gli altri 3 sono ancora "da compilare": una compilazione "solo modifiche" li compila.
      hook.n = 0;
      hook.onBlock = () => undefined;
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(app.store.getState().compile.summary?.blocks).toBe(3), W);
      expect(Object.keys(app.store.getState().compile.hashes)).toHaveLength(5);
    },
    T,
  );

  it(
    'Ctrl+B avvia la compilazione',
    async () => {
      const app = await setup();
      await app.user.keyboard('{Control>}b{/Control}');
      await waitFor(() => expect(app.store.getState().compile.summary?.blocks).toBe(5), W);
    },
    T,
  );

  it(
    'durante la compilazione i comandi di compilazione sono disattivati e Ctrl+B non fa nulla',
    async () => {
      const app = await setup();
      let enabled: boolean[] = [];
      let starts = 0;
      hook.onBlock = (n) => {
        if (n === 1) {
          const s = app.store.getState();
          enabled = [
            commands['edit.compile'].isEnabled(s),
            commands['edit.compileFull'].isEnabled(s),
          ];
          const before = hook.n;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
          starts = hook.n - before;
        }
      };
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(app.store.getState().compile.summary).not.toBeNull(), W);
      expect(enabled).toEqual([false, false]);
      expect(starts).toBe(0);
      expect(app.store.getState().compile.summary?.blocks).toBe(5);
      await waitFor(() => expect(getProgress()).toBeNull(), W);
      expect(commands['edit.compile'].isEnabled(app.store.getState())).toBe(true);
    },
    T,
  );

  it(
    'se il progetto si chiude durante la compilazione, l esito si scarta',
    async () => {
      const app = await setup();
      hook.onBlock = (n) => {
        if (n === 2) act(() => app.store.getState().setDoc(null));
      };
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(getProgress()).toBeNull(), W);
      const c = app.store.getState().compile;
      expect(c.summary).toBeNull();
      expect(c.rows).toEqual([]);
      expect(Object.keys(c.hashes)).toHaveLength(0);
    },
    T,
  );

  it(
    'se il compilatore lancia a metà, restano gli esiti raccolti e compare l errore',
    async () => {
      const app = await setup();
      hook.onBlock = (n) => {
        if (n === 3) throw new Error('boom');
      };
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(getProgress()).toBeNull(), W);
      const st = app.store.getState();
      expect(st.compile.rows).toHaveLength(2);
      expect(Object.keys(st.compile.hashes)).toHaveLength(2);
      expect(st.messages.some((m) => m.textKey === 'messages.compileFailed')).toBe(true);
    },
    T,
  );

  it(
    'cede il turno all interfaccia solo dopo 16 ms (orologio simulato)',
    async () => {
      const app = await setup();
      let t = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => t);
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      hook.onBlock = () => {
        t += 10; // 10 ms per blocco: si cede ogni due blocchi
      };
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })));
      await waitFor(() => expect(app.store.getState().compile.summary).not.toBeNull(), W);
      const yields = timeouts.mock.calls.filter((c) => c[1] === 0).length;
      vi.restoreAllMocks();
      expect(yields).toBeGreaterThanOrEqual(2);
      expect(yields).toBeLessThanOrEqual(3);
    },
    T,
  );
});

describe('indicatore della simulazione', () => {
  it('compare solo con la simulazione accesa e mostra il modo della CPU', async () => {
    const app = await setup();
    expect(screen.queryByTestId('sim-indicator')).toBeNull();
    act(() => app.store.getState().setSim({ phase: 'on', deviceId: PLC, mode: 'STOP' }));
    expect(screen.getByTestId('sim-indicator')).toHaveTextContent('Simulazione: STOP');
    act(() => app.store.getState().setSim({ mode: 'RUN' }));
    expect(screen.getByTestId('sim-indicator')).toHaveTextContent('Simulazione: RUN');
  });
});
