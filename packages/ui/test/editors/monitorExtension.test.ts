import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MonitorStep } from '@baaportal/sim';
import {
  formatAccu,
  formatStw,
  monitorExtension,
  monitorLinesByNetwork,
  monitorLinesFromPlc,
  setMonitorLines,
  type LineMapRow,
} from '../../src/editors/awl/monitorExtension';

const step = (offset: number, over: Partial<MonitorStep> = {}): MonitorStep => ({
  offset,
  rlo: false,
  sta: false,
  stw: 0,
  accu1: 0,
  accu2: 0,
  ar1: 0,
  db: 0,
  di: 0,
  ...over,
});

describe('formati', () => {
  it('ACCU in esadecimale o in decimale con segno', () => {
    expect(formatAccu(0x2a, true)).toBe('0000002A');
    expect(formatAccu(0xffffffff, true)).toBe('FFFFFFFF');
    expect(formatAccu(0xffffffff, false)).toBe('-1');
    expect(formatAccu(42, false)).toBe('42');
  });
  it('parola di stato in 9 bit, BR a sinistra', () => {
    expect(formatStw(0)).toBe('000000000');
    expect(formatStw(0b1_0000_0110)).toBe('100000110');
    expect(formatStw(0xffff)).toBe('111111111');
  });
});

describe('monitorLinesByNetwork', () => {
  const map: LineMapRow[] = [
    { offset: 0, length: 2, network: 0, line: 0 },
    { offset: 2, length: 2, network: 0, line: 1 },
    // CALL espansa: tre istruzioni sulla stessa riga
    { offset: 4, length: 2, network: 0, line: 3 },
    { offset: 6, length: 2, network: 0, line: 3 },
    { offset: 8, length: 2, network: 0, line: 3 },
    { offset: 10, length: 2, network: 1, line: 0 },
  ];

  it('una riga con più voci mostra lo stato dopo l ultima istruzione eseguita', () => {
    const r = monitorLinesByNetwork(
      map,
      [step(0, { accu1: 1 }), step(4, { accu1: 4 }), step(6, { accu1: 6 }), step(8, { accu1: 8 })],
      true,
    );
    expect(r.get(0)!.cells.get(3)!.accu1).toBe(8);
    expect(r.get(0)!.cells.get(0)!.accu1).toBe(1);
  });

  it('una riga è eseguita se lo è una qualsiasi delle sue voci; usa l ultima registrata', () => {
    const r = monitorLinesByNetwork(map, [step(4, { accu1: 4 }), step(6, { accu1: 6 })], true);
    expect(r.get(0)!.cells.get(3)!.accu1).toBe(6);
  });

  it('le righe senza passi sono non eseguite (null); i commenti non compaiono', () => {
    const r = monitorLinesByNetwork(map, [step(0)], false);
    const c = r.get(0)!.cells;
    expect(c.get(1)).toBeNull();
    expect(c.has(2)).toBe(false);
    expect(c.get(0)).not.toBeNull();
    // rete 1 mai eseguita
    expect(r.get(1)!.cells.get(0)).toBeNull();
    expect(r.get(0)!.hex).toBe(false);
  });
});

describe('estensione CodeMirror', () => {
  const make = (doc: string) => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [monitorExtension()] }),
    });
    return view;
  };
  const lines = (hex: boolean, cells: [number, ReturnType<typeof cell> | null][]) => ({
    hex,
    cells: new Map(cells),
  });
  const cell = (accu1: number, over: Record<string, unknown> = {}) => ({
    rlo: true,
    sta: false,
    stw: 0b110,
    accu1,
    accu2: 0,
    ...over,
  });

  it('mostra i valori a fine riga e fa grigie le righe non eseguite', () => {
    const v = make('A I0.0\n= Q0.0\n// c');
    v.dispatch({
      effects: setMonitorLines.of(
        lines(true, [
          [0, cell(0x2a)],
          [1, null],
        ]),
      ),
    });
    const cells = v.dom.querySelectorAll('.baa-mon-cell');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.textContent).toContain('0000002A');
    expect(cells[0]!.textContent).toContain('000000110');
    const off = v.dom.querySelectorAll('.baa-mon-off');
    expect(off).toHaveLength(1);
    expect(off[0]!.textContent).toBe('= Q0.0');
    v.destroy();
  });

  it('decimale, e null toglie tutto', () => {
    const v = make('L 5');
    v.dispatch({ effects: setMonitorLines.of(lines(false, [[0, cell(0xfffffffe)]])) });
    expect(v.dom.querySelector('.baa-mon-cell')!.textContent).toContain('-2');
    v.dispatch({ effects: setMonitorLines.of(null) });
    expect(v.dom.querySelector('.baa-mon-cell')).toBeNull();
    v.destroy();
  });

  it('modificare il testo toglie i valori (le righe si sono spostate)', () => {
    const v = make('A I0.0\n= Q0.0');
    v.dispatch({
      effects: setMonitorLines.of(
        lines(true, [
          [0, cell(1)],
          [1, cell(2)],
        ]),
      ),
    });
    expect(v.dom.querySelectorAll('.baa-mon-cell')).toHaveLength(2);
    v.dispatch({ changes: { from: 0, insert: 'NOP 0\n' } });
    expect(v.dom.querySelector('.baa-mon-cell')).toBeNull();
    expect(v.dom.querySelector('.baa-mon-off')).toBeNull();
    v.destroy();
  });

  it('una riga oltre la fine del testo si ignora', () => {
    const v = make('L 1');
    v.dispatch({
      effects: setMonitorLines.of(
        lines(true, [
          [0, cell(1)],
          [7, cell(2)],
        ]),
      ),
    });
    expect(v.dom.querySelectorAll('.baa-mon-cell')).toHaveLength(1);
    v.destroy();
  });
});

describe('monitorLinesFromPlc', () => {
  const map: LineMapRow[] = [
    { offset: 0, length: 2, network: 0, line: 0 },
    { offset: 2, length: 2, network: 0, line: 1 },
    // CALL espansa su 3 offset
    { offset: 4, length: 2, network: 0, line: 3 },
    { offset: 6, length: 2, network: 0, line: 3 },
    { offset: 8, length: 2, network: 0, line: 3 },
    { offset: 10, length: 2, network: 1, line: 0 },
  ];
  const regs = (accu1: number) => ({ stw: 0x0106, accu1 });

  it('CALL espansa su 3 offset → valori dell ultimo eseguito', () => {
    const r = monitorLinesFromPlc(
      map,
      [
        { offset: 4, regs: regs(4) },
        { offset: 6, regs: regs(6) },
        { offset: 8, regs: null },
      ],
      true,
    );
    expect(r.get(0)!.cells.get(3)!.accu1).toBe(6);
  });

  it('riga chiesta e non elaborata → null; riga non chiesta → assente', () => {
    const r = monitorLinesFromPlc(
      map,
      [
        { offset: 0, regs: null },
        { offset: 2, regs: regs(2) },
      ],
      false,
    );
    expect(r.get(0)!.cells.get(0)).toBeNull();
    expect(r.get(0)!.cells.get(1)!.accu1).toBe(2);
    expect(r.get(0)!.cells.has(3)).toBe(false);
    expect(r.has(1)).toBe(false);
    expect(r.get(0)!.hex).toBe(false);
  });

  it('accu2 e ar1 compaiono solo se chiesti', () => {
    const r = monitorLinesFromPlc(
      map,
      [
        { offset: 0, regs: { stw: 0, accu1: 1, accu2: 2, ar1: 3 } },
        { offset: 2, regs: regs(1) },
      ],
      true,
    );
    expect(r.get(0)!.cells.get(0)).toMatchObject({ accu2: 2, ar1: 3 });
    expect(r.get(0)!.cells.get(1)!.accu2).toBeUndefined();
  });
});

describe('cella della CPU', () => {
  it('STW 0x0106 → RLC 1, STA 1, suggerimento con OR 0 OS 0 OV 0 A0 0 A1 0; senza ACCU2 e AR1', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const v = new EditorView({
      parent,
      state: EditorState.create({ doc: 'L 5', extensions: [monitorExtension()] }),
    });
    const m = monitorLinesFromPlc(
      [{ offset: 0, length: 2, network: 0, line: 0 }],
      [{ offset: 0, regs: { stw: 0x0106, accu1: 5 } }],
      true,
    );
    v.dispatch({ effects: setMonitorLines.of(m.get(0)!) });
    const cell = v.dom.querySelector('.baa-mon-cell') as HTMLElement;
    expect(cell.textContent).toContain('RLC 1');
    expect(cell.textContent).toContain('STA 1');
    expect(cell.textContent).toContain('STW 100000110');
    expect(cell.textContent).not.toContain('ACCU2');
    expect(cell.title).toBe('OR 0 OS 0 OV 0 A0 0 A1 0');
    v.destroy();
  });
});
