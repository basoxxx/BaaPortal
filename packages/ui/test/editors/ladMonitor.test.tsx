// Osservazione dei segmenti KOP e FUP: gli stati per riga dell'AWL generato (simulatore o CPU)
// colorano gli elementi del grafico, con lo stato anche come testo.
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { networkStatus, type LadNetwork } from '@baaportal/ladfbd';
import { createCodeBlock, kopSources } from '@baaportal/project';
import { monitorLinesFromPlc, type LineMapRow } from '../../src/editors/awl/monitorExtension';
import { dev, openEditor } from '../blockFixtures';

const T = 30_000;

const nets = (): LadNetwork[] => [
  {
    root: {
      id: 'n0',
      series: [
        { id: 'a', k: 'contact', neg: false, op: 'I 0.0' },
        { id: 'b', k: 'contact', neg: false, op: 'I 0.1' },
      ],
      outs: [{ id: 'q', k: 'coil', op: 'Q 4.0' }],
    },
  },
  {
    root: {
      id: 'n1',
      series: [
        { id: 'c', k: 'contact', neg: false, op: 'I 0.2' },
        {
          id: 'mv',
          k: 'box',
          box: 'MOVE',
          instance: '',
          pins: { IN: 'MW 10', OUT: 'MW 12' },
          boolPins: {},
        },
      ],
      outs: [{ id: 'q1', k: 'coil', op: 'Q 4.1' }],
    },
  },
];

const offset = (net: number, line: number) => (net * 100 + line) * 2;

/** Blocco KOP osservato nel simulatore: `run` dice quali reti hanno passi (le altre non elaborate). */
async function setup(language: 'KOP' | 'FUP', run: number[]) {
  const f = createCodeBlock({ kind: 'FC', number: 9, name: 'Prova', language });
  f.networks = nets().map((lad, i) => ({ id: `s${i}`, title: '', comment: '', source: '', lad }));
  const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
  const deviceId = dev(app).id;
  const src = kopSources(f, dev(app));
  const map = src.flatMap((r, net) =>
    r.lines.map((l) => ({ offset: offset(net, l.line), length: 2, network: net, line: l.line })),
  );
  // I 0.1 a 0 (riga di «b»), tutto il resto a 1; ACCU1 = 7
  const steps = src.flatMap((r, net) =>
    run.includes(net)
      ? r.lines.map((l) => {
          const zero = l.elemId === 'b';
          return {
            offset: offset(net, l.line),
            rlo: !zero,
            sta: !zero,
            stw: 0,
            accu1: 7,
            accu2: 0,
            ar1: 0,
            db: 0,
            di: 0,
          };
        })
      : [],
  );
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
  return app;
}

const lad = (id: string) => document.querySelector<HTMLElement>(`[data-lad-id="${id}"]`)!;
const fup = (id: string) => document.querySelector<HTMLElement>(`[data-fup-id="${id}"]`)!;
const mons = (el: Element) =>
  [...el.querySelectorAll('[data-mon]')].map((x) => x.getAttribute('data-mon'));

describe('osservazione nei segmenti KOP', () => {
  it(
    'flusso a colori sugli elementi e sui fili, stato anche come testo',
    async () => {
      await setup('KOP', [0]);
      expect(await screen.findByText(/Osservazione attiva/)).toBeTruthy();
      expect(mons(lad('a'))).toEqual(['1', '1', '1', '1']);
      // entrata a 1, contatto aperto: uscita a 0
      expect(mons(lad('b'))).toEqual(['1', '0', '0', '0']);
      expect(lad('b').getAttribute('aria-label')).toContain('stato 0, operando 0');
      expect(mons(lad('q'))).not.toContain('1');
      // rete 1 senza passi: grigia, «non elaborato»
      expect(mons(lad('c'))).toEqual(['off', 'off', 'off', 'off']);
      expect(lad('mv').getAttribute('aria-label')).toContain('non elaborato');
      expect(lad('mv').querySelector('.baa-lad-val')).toBeNull();
    },
    T,
  );

  it(
    'valori accanto ai pin del box',
    async () => {
      await setup('KOP', [0, 1]);
      const vals = [...lad('mv').querySelectorAll('.baa-lad-val')].map((x) => x.textContent);
      expect(vals).toEqual(['7', '7']);
      expect(lad('mv').getAttribute('title')).toContain('IN 7, OUT 7');
    },
    T,
  );

  it(
    'senza osservazione nessun attributo',
    async () => {
      const app = await setup('KOP', [0]);
      act(() => app.store.getState().setSim({ monitor: null, monitorSteps: null }));
      expect(document.querySelector('.baa-lad [data-mon]')).toBeNull();
    },
    T,
  );
});

describe('osservazione nei segmenti FUP', () => {
  it(
    'entrate con il segnale dell’operando, uscite con il loro stato, valori dei pin',
    async () => {
      await setup('FUP', [0, 1]);
      expect(fup('a').getAttribute('data-mon')).toBe('1');
      expect(fup('b').getAttribute('data-mon')).toBe('0');
      expect(fup('q').getAttribute('data-mon')).toBe('0');
      expect(fup('q').getAttribute('aria-label')).toContain('stato 0');
      expect(fup('mv').textContent).toContain('7');
    },
    T,
  );
});

describe('dati della CPU', () => {
  it('stesso stato degli elementi dalle righe osservate online', () => {
    const net = nets()[0]!;
    const lines = [
      { line: 0, elemId: 'a' },
      { line: 1, elemId: 'b' },
      { line: 2, elemId: 'q' },
    ];
    const map: LineMapRow[] = lines.map((l) => ({
      offset: l.line * 2,
      length: 2,
      network: 0,
      line: l.line,
    }));
    // STW: RLO = bit 1, STA = bit 2; la riga di «q» è chiesta ma non elaborata
    const plc = [
      { offset: 0, regs: { stw: 0b110, accu1: 0 } },
      { offset: 2, regs: { stw: 0b000, accu1: 0 } },
      { offset: 4, regs: null },
    ];
    const cells = monitorLinesFromPlc(map, plc, false).get(0)!.cells;
    const st = networkStatus(net, lines, cells);
    expect(st.get('a')).toMatchObject({ out: true, sta: true });
    expect(st.get('b')).toMatchObject({ in: true, out: false, sta: false });
    expect(st.get('q')).toEqual({ notRun: true });
  });
});

/** Blocco KOP osservato sulla CPU: `regs` per elemento della rete 0 (`absent` = fuori finestra). */
async function setupPlc(
  regs: (elemId: string) => { stw: number; accu1: number } | null | 'absent',
  unsure: boolean,
  language: 'KOP' | 'FUP' = 'KOP',
) {
  const f = createCodeBlock({ kind: 'FC', number: 9, name: 'Prova', language });
  f.networks = nets().map((lad, i) => ({ id: `s${i}`, title: '', comment: '', source: '', lad }));
  const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
  const deviceId = dev(app).id;
  const src = kopSources(f, dev(app));
  const map = src.flatMap((r, net) =>
    r.lines.map((l) => ({ offset: offset(net, l.line), length: 2, network: net, line: l.line })),
  );
  const lines = src[0]!.lines.flatMap((l) => {
    const r = regs(l.elemId);
    return r === 'absent' ? [] : [{ offset: offset(0, l.line), regs: r }];
  });
  act(() => {
    app.store.setState((x) => ({
      online: {
        ...x.online,
        status: 'on',
        deviceId,
        monitor: { deviceId, blockId: f.id, reason: 'ok' },
        monitorLines: lines,
        monitorLinesUnsure: unsure,
      },
      compile: { ...x.compile, lines: { [f.id]: map } },
    }));
  });
  return app;
}

describe('osservazione sulla CPU: fuori finestra e non elaborato', () => {
  const one = { stw: 0b110, accu1: 0 };
  it(
    'righe fuori finestra: nessun colore e «fuori dalla finestra», non «non elaborato»',
    async () => {
      await setupPlc((id) => (id === 'a' ? one : 'absent'), false);
      expect(mons(lad('a'))).toEqual(['1', '1', '1', '1']);
      // entra il flusso di «a», l'uscita non si conosce
      expect(mons(lad('b'))).toEqual(['1']);
      expect(mons(lad('q'))).toEqual([]);
      for (const id of ['b', 'q']) {
        expect(lad(id).getAttribute('aria-label')).toContain('fuori dalla finestra');
        expect(lad(id).getAttribute('aria-label')).not.toContain('non elaborato');
      }
    },
    T,
  );

  it(
    'riga null dalla CPU: grigio e «non elaborato»',
    async () => {
      await setupPlc((id) => (id === 'a' ? one : null), false);
      expect(mons(lad('b'))).toEqual(['off', 'off', 'off', 'off']);
      expect(lad('q').getAttribute('aria-label')).toContain('non elaborato');
    },
    T,
  );

  it(
    'righe null di un segnaposto o di una risposta parziale: come fuori finestra',
    async () => {
      await setupPlc((id) => (id === 'a' ? one : null), true);
      expect(mons(lad('b'))).toEqual(['1']);
      expect(lad('q').getAttribute('aria-label')).toContain('fuori dalla finestra');
      expect(document.querySelector('.baa-lad [data-mon="off"]')).toBeNull();
    },
    T,
  );

  it(
    'FUP: stesso stato «fuori dalla finestra», senza bordo colorato',
    async () => {
      await setupPlc((id) => (id === 'a' ? one : 'absent'), false, 'FUP');
      expect(fup('a').getAttribute('data-mon')).toBe('1');
      expect(fup('b').hasAttribute('data-mon')).toBe(false);
      expect(fup('q').getAttribute('aria-label')).toContain('fuori dalla finestra');
    },
    T,
  );
});
