import { act, fireEvent, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createCodeBlock } from '@baaportal/project';
import { dev, openEditor } from './blockFixtures';

const T = 30_000;
const step = (offset: number, accu1: number) => ({
  offset,
  rlo: true,
  sta: true,
  stw: 0b110,
  accu1,
  accu2: 0,
  ar1: 0,
  db: 0,
  di: 0,
});

async function setup() {
  const f = createCodeBlock({ kind: 'FC', number: 9, name: 'Prova', language: 'AWL' });
  f.networks[0]!.source = 'L 42\nT MW 10\nNOP 0';
  const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
  const deviceId = dev(app).id;
  const s = app.store.getState();
  act(() => {
    s.setSim({
      phase: 'on',
      deviceId,
      loaded: {},
      monitor: { deviceId, blockId: f.id, reason: 'ok', edited: false },
      monitorSteps: [step(0, 42)],
      monitorHex: true,
    });
    app.store.setState((x) => ({
      compile: {
        ...x.compile,
        lines: {
          [f.id]: [
            { offset: 0, length: 2, network: 0, line: 0 },
            { offset: 2, length: 2, network: 0, line: 1 },
          ],
        },
      },
    }));
  });
  return { app, f };
}

describe("osservazione nell'editor del blocco", () => {
  it(
    'mostra i valori delle righe eseguite, grigia le altre; il tasto cambia il formato',
    async () => {
      await setup();
      expect(await screen.findByText(/Osservazione attiva/)).toBeTruthy();
      expect(document.querySelectorAll('.baa-mon-cell')).toHaveLength(1);
      expect(document.querySelector('.baa-mon-cell')!.textContent).toContain('0000002A');
      expect(document.querySelectorAll('.baa-mon-off')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Formato degli accumulatori' }));
      expect(document.querySelector('.baa-mon-cell')!.textContent).toContain('ACCU1 42');
    },
    T,
  );

  it(
    'indisponibile: messaggio con il motivo e nessun valore',
    async () => {
      const { app, f } = await setup();
      act(() =>
        app.store.getState().setSim({
          monitor: { deviceId: dev(app).id, blockId: f.id, reason: 'stale', edited: false },
        }),
      );
      expect(screen.getByRole('alert').textContent).toContain('non è compilato con le modifiche');
      expect(document.querySelector('.baa-mon-cell')).toBeNull();
    },
    T,
  );

  it(
    'testo in modifica: sospende finché non si conferma, con il suo messaggio',
    async () => {
      await setup();
      const cm = document.querySelector('.cm-editor') as HTMLElement;
      const view = EditorView.findFromDOM(cm)!;
      act(() => view.contentDOM.focus());
      act(() => view.dispatch({ changes: { from: 0, insert: '// ' } }));
      expect(screen.getByRole('alert').textContent).toContain('in modifica');
      expect(document.querySelector('.baa-mon-cell')).toBeNull();
    },
    T,
  );
});
