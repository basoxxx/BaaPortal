// Osservazione di un blocco SCL nell'editor: valori a fine riga dal simulatore o dalla CPU,
// righe non elaborate in grigio, righe senza dati con «?» e il testo «fuori dalla finestra».
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { createCodeBlock, kopSources } from '@baaportal/project';
import type { SclLine } from '@baaportal/scl';
import { dev, openEditor } from '../blockFixtures';

const T = 30_000;
const TEXT = 'MW10 := 5;\nIF M0.0 THEN\n  MW12 := 1;\nEND_IF;\nMD20 := 1.5;';

async function block() {
  const f = createCodeBlock({ kind: 'FC', number: 9, name: 'Prova', language: 'SCL' });
  f.networks[0]!.source = TEXT;
  const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
  const deviceId = dev(app).id;
  const src = kopSources(f, dev(app))[0]!;
  const awl = src.source.split('\n').map((s) => s.trim());
  const lines = src.scl!.lines;
  const map = lines.map((l) => ({ offset: l.line * 2, length: 2, network: 0, line: l.line }));
  return { app, f, deviceId, awl, lines, map };
}

/** ACCU1 della riga: 5 alla T di MW10, 1.5 alla T di MD20, 99 altrove. */
const accuOf = (awl: string) =>
  awl.startsWith('T MW 10') || awl.startsWith('T %MW10')
    ? 5
    : /MD ?20/.test(awl) && awl.startsWith('T')
      ? 0x3fc00000
      : 99;

const cells = () =>
  [...document.querySelectorAll<HTMLElement>('.baa-scl-mon')].map((x) => x.textContent);

describe('osservazione di un blocco SCL nel simulatore', () => {
  it(
    'valori a fine riga, ramo non eseguito grigio, testo modificato: valori via',
    async () => {
      const { app, f, deviceId, awl, lines, map } = await block();
      // il corpo dell'IF (riga 3) non è eseguito
      const steps = lines
        .filter((l: SclLine) => l.sclLine !== 3)
        .map((l) => ({
          offset: l.line * 2,
          rlo: false,
          sta: false,
          stw: 0,
          accu1: accuOf(awl[l.line]!),
          accu2: 0,
          ar1: 0,
          db: 0,
          di: 0,
        }));
      act(() => {
        app.store.getState().setSim({
          phase: 'on',
          deviceId,
          loaded: {},
          monitor: { deviceId, blockId: f.id, reason: 'ok', edited: false },
          monitorSteps: steps,
          monitorHex: false,
        });
        app.store.setState((x) => ({ compile: { ...x.compile, lines: { [f.id]: map } } }));
      });
      expect(cells()).toEqual(['MW10 = 5', 'FALSE', 'non elaborato', 'MD20 = 1.5']);
      expect(document.querySelectorAll('.baa-mon-off')).toHaveLength(1);
      expect(document.querySelector('.baa-scl-mon')!.getAttribute('title')).toBe('MW10 = 5');
      // esadecimale
      act(() => app.store.getState().setSim({ monitorHex: true }));
      expect(cells()[0]).toBe('MW10 = 16#0005');
      // il testo cambia: i valori spariscono e l'osservazione è sospesa
      const cm = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
      act(() => cm.dispatch({ changes: { from: 0, insert: ' ' }, userEvent: 'input.type' }));
      expect(cells()).toEqual([]);
      expect(app.store.getState().sim.monitor!.edited).toBe(true);
    },
    T,
  );
});

describe('osservazione di un blocco SCL sulla CPU', () => {
  async function plc(
    regsOf: (l: SclLine) => { stw: number; accu1: number } | null | 'absent',
    unsure = false,
  ) {
    const { app, f, deviceId, lines, map } = await block();
    const monitorLines = lines.flatMap((l) => {
      const r = regsOf(l);
      return r === 'absent' ? [] : [{ offset: l.line * 2, regs: r }];
    });
    act(() => {
      app.store.setState((x) => ({
        online: {
          ...x.online,
          status: 'on',
          deviceId,
          monitor: { deviceId, blockId: f.id, reason: 'ok' },
          monitorLines,
          monitorLinesUnsure: unsure,
        },
        sim: { ...x.sim, monitorHex: false },
        compile: { ...x.compile, lines: { [f.id]: map } },
      }));
    });
  }

  it(
    'righe fuori dalla finestra: «?» e «fuori dalla finestra», non «non elaborato»',
    async () => {
      // solo la prima riga SCL nella finestra
      await plc((l) => (l.sclLine === 1 ? { stw: 0, accu1: 5 } : 'absent'));
      expect(cells()).toEqual(['MW10 = 5', '?', '?', '?']);
      const q = document.querySelectorAll('.baa-scl-mon')[1]!;
      expect(q.getAttribute('aria-label')).toContain('fuori dalla finestra');
      expect(document.querySelector('.baa-mon-off')).toBeNull();
    },
    T,
  );

  it(
    'righe null: non elaborate, in grigio',
    async () => {
      await plc((l) => (l.sclLine === 1 ? { stw: 0, accu1: 5 } : null));
      expect(cells()).toEqual(['MW10 = 5', 'non elaborato', 'non elaborato', 'non elaborato']);
      expect(document.querySelectorAll('.baa-mon-off')).toHaveLength(3);
    },
    T,
  );

  it(
    'risposta incerta (parziale, in attesa): le righe null sono sconosciute',
    async () => {
      await plc((l) => (l.sclLine === 1 ? { stw: 0, accu1: 5 } : null), true);
      expect(cells()).toEqual(['MW10 = 5', '?', '?', '?']);
      expect(document.querySelector('.baa-mon-off')).toBeNull();
    },
    T,
  );
});
