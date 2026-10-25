import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BOX_KINDS, PALETTE, emptyNetwork, insertElem, openBranch } from '@baaportal/ladfbd';
import type { CallParams } from '../../src/editors/lad/ladOps';
import type { LadElem, LadNetwork } from '@baaportal/ladfbd';
import { newBox } from '../../src/editors/lad/ladOps';
import { LadNetworkEditor } from '../../src/editors/lad/LadNetworkEditor';
import { i18next, initI18n } from '../../src/i18n';
import it_ from '../../src/i18n/it.json';
import en from '../../src/i18n/en.json';

beforeAll(async () => {
  await initI18n('it');
});

let n = 0;
const newId = () => `n${++n}`;

/** Monta l'editor con uno stato locale che applica `onChange`, come farà la vista dei segmenti. */
function setup(
  initial?: LadNetwork,
  over: { readOnly?: boolean; diag?: Map<string, string[]>; callParams?: CallParams } = {},
) {
  const calls: [LadNetwork, string][] = [];
  const onChange = vi.fn((next: LadNetwork, key: string) => {
    calls.push([next, key]);
    view.rerender(ui(next));
  });
  const ui = (net: LadNetwork) => (
    <I18nextProvider i18n={i18next}>
      <LadNetworkEditor
        net={net}
        index={0}
        diagnostics={over.diag ?? new Map()}
        readOnly={over.readOnly ?? false}
        onChange={onChange}
        callParams={over.callParams}
        newId={newId}
      />
    </I18nextProvider>
  );
  const view = render(ui(initial ?? emptyNetwork(newId)));
  return { onChange, calls, user: userEvent.setup(), canvas: screen.getByRole('group') };
}

const contacts = () => screen.queryAllByRole('button', { name: /^Contatto N[AC]/ });

describe('LadNetworkEditor', () => {
  it('F2 su una rete vuota inserisce un contatto NA con operando vuoto, una sola onChange', async () => {
    const { onChange, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}');
    expect(screen.getByRole('button', { name: 'Contatto NA ??.?' })).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![1]).toBe('history.editLad');
  });

  it("scrivere l'operando e Invio lo aggiorna; Esc annulla", async () => {
    const { onChange, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}');
    await user.keyboard('{Enter}');
    await user.keyboard('I 0.0{Enter}');
    expect(screen.getByRole('button', { name: 'Contatto NA I 0.0' })).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(2);
    await user.keyboard('{Enter}');
    await user.keyboard('X{Escape}');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it("il doppio clic apre il campo e l'uscita lo conferma", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('button', { name: /^Bobina / }));
    await user.dblClick(screen.getByRole('button', { name: /^Bobina / }));
    await user.keyboard('Q 4.0');
    fireEvent.blur(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: 'Bobina Q 4.0' })).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('F8 apre un ramo parallelo; Canc sul ramo nuovo lo toglie', async () => {
    const { onChange, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}');
    await user.keyboard('{F8}');
    const cs = contacts();
    expect(cs).toHaveLength(2);
    expect(parseInt(cs[1]!.style.top)).toBeGreaterThan(parseInt(cs[0]!.style.top));
    expect(onChange).toHaveBeenCalledTimes(2);
    await user.keyboard('{Delete}');
    expect(contacts()).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('F9 chiude il ramo aperto dopo un elemento successivo', async () => {
    const { onChange, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}{F2}'); // c1 c2
    await user.keyboard('{ArrowLeft}{F8}'); // ramo sotto c1
    await user.keyboard('{ArrowUp}{ArrowRight}'); // c2
    const before = onChange.mock.calls.length;
    await user.keyboard('{F9}');
    expect(onChange).toHaveBeenCalledTimes(before + 1);
    const root = onChange.mock.calls.at(-1)![0].root;
    expect(root.series).toHaveLength(1);
    const par = root.series[0]!;
    expect(par.k).toBe('parallel');
    // c2 è passato nel percorso principale (primo ramo), il ramo nuovo lo scavalca.
    if (par.k === 'parallel') {
      expect(par.branches[0]!.map((e) => e.k)).toEqual(['contact', 'contact']);
      expect(par.branches[1]).toHaveLength(1);
    }
  });

  it('F7 aggiunge una bobina, la seconda volta seleziona quella vuota', async () => {
    const { onChange, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F7}');
    expect(onChange).toHaveBeenCalledTimes(0); // la rete vuota ha già una bobina vuota
    expect(screen.getByRole('button', { name: /^Bobina / }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.keyboard('{Enter}Q 1.0{Enter}');
    await user.keyboard('{F7}');
    expect(screen.getAllByRole('button', { name: /^Bobina / })).toHaveLength(2);
  });

  it('un elemento con diagnostica ha il messaggio nel title', () => {
    const net = emptyNetwork(newId);
    const coilId = net.root.outs[0]!.id;
    setup(net, { diag: new Map([[coilId, ['Operando mancante.', 'Altro']]]) });
    const b = screen.getByRole('button', { name: /^Bobina / });
    expect(b.getAttribute('title')).toBe('Operando mancante.\nAltro');
    expect(b.className).toContain('error');
  });

  it('in sola lettura i tasti non modificano e la barra è disabilitata', async () => {
    const { onChange, user, canvas } = setup(undefined, { readOnly: true });
    canvas.focus();
    await user.keyboard('{F2}{F3}{F7}{F8}{Delete}{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'NA' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('la barra inserisce un contatto e il menu inserisce un box', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('button', { name: 'NC' }));
    expect(screen.getByRole('button', { name: 'Contatto NC ??.?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Box vuoto/ }));
    await user.click(screen.getByRole('menuitem', { name: /^ADD_I/ }));
    expect(screen.getByRole('button', { name: 'Box ADD_I' })).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('il trascinamento dalla tavolozza inserisce nello slot più vicino', () => {
    const { onChange, canvas } = setup();
    const data = { ['application/x-baaportal-lad']: JSON.stringify({ palette: 'contactNo' }) };
    const dataTransfer = { types: Object.keys(data), getData: (k: string) => data[k] ?? '' };
    fireEvent.drop(canvas, { dataTransfer, clientX: 0, clientY: 0 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Contatto NA ??.?' })).toBeTruthy();
  });

  it('onActive: il focus consegna l’api di inserimento, lo smontaggio la ritira', async () => {
    const onActive = vi.fn();
    const { unmount } = render(
      <I18nextProvider i18n={i18next}>
        <LadNetworkEditor
          net={emptyNetwork(newId)}
          index={0}
          diagnostics={new Map()}
          readOnly={false}
          onChange={vi.fn()}
          onActive={onActive}
          newId={newId}
        />
      </I18nextProvider>,
    );
    screen.getByRole('group').focus();
    expect(onActive).toHaveBeenCalledWith(
      expect.objectContaining({ insertPalette: expect.any(Function) }),
      true,
    );
    unmount();
    expect(onActive).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('le frecce spostano la selezione nella griglia', async () => {
    const { user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}{F2}');
    await user.keyboard('{ArrowLeft}');
    const sel = contacts().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(sel).toHaveLength(1);
    expect(parseInt(sel[0]!.style.left)).toBe(0);
  });
});

describe('LadNetworkEditor: ramo a T, barra, CALL, pin, F9, Tab', () => {
  const contact = (id: string): LadElem => ({ id, k: 'contact', neg: false, op: '' });
  const lines = (net: LadNetwork, at: { node: string; index: number }, e: LadElem) =>
    insertElem(net, at, e);

  it('Nuovo ramo a T (Maiusc+F7 e barra) costruisce un ramo a T da zero', async () => {
    const { calls, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}');
    await user.keyboard('{Shift>}{F7}{/Shift}');
    const root = calls.at(-1)![0].root;
    expect(root.outs).toHaveLength(2);
    const t = root.outs[1]!;
    expect('series' in t && t.series.map((e) => e.k)).toEqual(['contact']);
    expect('outs' in t && t.outs.map((o) => ('k' in o ? o.k : 'node'))).toEqual(['coil']);
    await user.click(screen.getByRole('button', { name: 'Nuovo ramo a T' }));
    // la selezione è nel ramo a T: il nuovo ramo si annida lì
    const t2 = calls.at(-1)![0].root.outs[1]!;
    expect('outs' in t2 && t2.outs).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Nuovo ramo a T' }).getAttribute('title')).toBe(
      'Nuovo ramo a T (Shift+F7)',
    );
  });

  it('ogni editor ha la sua barra, anche con index > 0', () => {
    render(
      <I18nextProvider i18n={i18next}>
        <LadNetworkEditor
          net={emptyNetwork(newId)}
          index={2}
          diagnostics={new Map()}
          readOnly={false}
          onChange={() => {}}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole('toolbar')).toBeTruthy();
  });

  it('un clic sullo sfondo deseleziona', async () => {
    const { user, canvas } = setup();
    await user.click(screen.getByRole('button', { name: /^Bobina / }));
    fireEvent.click(canvas);
    expect(screen.getByRole('button', { name: /^Bobina / }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('F9 si ricava dal modello e funziona dopo un nuovo montaggio', async () => {
    let net = emptyNetwork(newId);
    net = lines(net, { node: net.root.id, index: 0 }, contact('a'));
    net = lines(net, { node: net.root.id, index: 1 }, contact('b'));
    net = openBranch(net, 'a', newId);
    const { calls, user } = setup(net);
    await user.click(document.querySelector('[data-lad-id="b"]')!);
    await user.keyboard('{F9}');
    expect(calls).toHaveLength(1);
    const par = calls[0]![0].root.series[0]!;
    expect(par.k === 'parallel' && par.branches[0]!.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('senza ramo aperto prima, F9 mostra un messaggio e non cambia nulla', async () => {
    const { onChange, user, canvas } = setup();
    canvas.focus();
    await user.keyboard('{F2}{F9}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('Impossibile chiudere il ramo');
  });

  it('Tab conferma e passa al campo successivo con una sola modifica', async () => {
    let net = emptyNetwork(newId);
    net = insertElem(
      net,
      { node: net.root.id, index: 0 },
      { id: 'c', k: 'cmp', fn: '==I', in1: '', in2: '' },
    );
    const { onChange, user } = setup(net);
    await user.click(screen.getByRole('button', { name: /^Confronto/ }));
    await user.keyboard('{Enter}MW 0{Tab}');
    expect(onChange).toHaveBeenCalledTimes(1);
    const second = screen.getByRole('textbox', { name: 'Ingresso 2' });
    expect((second as HTMLInputElement).value).toBe('');
    await user.keyboard('MW 2{Enter}');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /^Confronto ==I MW 0 MW 2/ })).toBeTruthy();
  });

  it('il campo di un pin sta sulla riga del pin; il doppio clic sul pin lo apre', async () => {
    let net = emptyNetwork(newId);
    net = insertElem(net, { node: net.root.id, index: 0 }, newBox('ADD_I', 'bx'));
    const { onChange, user } = setup(net);
    const box = screen.getByRole('button', { name: 'Box ADD_I' });
    await user.dblClick(box.querySelector('[data-pin="IN2"]')!);
    const input = screen.getByRole('textbox', { name: 'IN2' });
    expect((input as HTMLInputElement).style.top).toBe('92px'); // riga 2: 2*40 + 12
    await user.keyboard('MW 4{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    const b = onChange.mock.calls[0]![0].root.series[0]!;
    expect(b.k === 'box' && b.pins).toEqual({ IN2: 'MW 4' });
  });

  it('un CALL prende i pin dai parametri: operandi per i dati, logica di pin per gli ingressi BOOL', async () => {
    const callParams: CallParams = (inst) =>
      inst === 'FC 1'
        ? [
            { name: 'start', dir: 'in', type: 'BOOL' },
            { name: 'speed', dir: 'in', type: 'INT' },
            { name: 'done', dir: 'out', type: 'BOOL' },
          ]
        : undefined;
    let net = emptyNetwork(newId);
    net = insertElem(net, { node: net.root.id, index: 0 }, newBox('CALL', 'cl'));
    const { onChange, user } = setup(net, { callParams });
    await user.click(screen.getByRole('button', { name: 'Box CALL' }));
    await user.keyboard('{Enter}FC 1{Tab}');
    expect(onChange).toHaveBeenCalledTimes(1);
    const b = onChange.mock.calls[0]![0].root.series[0]!;
    expect(b.k === 'box' && b.instance).toBe('FC 1');
    expect(b.k === 'box' && b.pins).toEqual({ speed: '', done: '' });
    expect(b.k === 'box' && Object.keys(b.boolPins)).toEqual(['start']);
    // il campo successivo è il primo dato (non l'ingresso BOOL)
    expect(screen.getByRole('textbox', { name: 'speed' })).toBeTruthy();
  });
});

describe('chiavi i18n lad.*', () => {
  const get = (o: unknown, path: string) =>
    path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
  it('ogni voce di palette e ogni box ha un testo in italiano e inglese', () => {
    for (const lang of [it_, en]) {
      for (const p of PALETTE) expect(get(lang, p.label), p.label).toBeTypeOf('string');
      for (const k of BOX_KINDS) expect(get(lang, `lad.box.${k}`), k).toBeTypeOf('string');
      for (const c of [
        'NO_OUTPUT',
        'EMPTY_OPERAND',
        'EMPTY_BRANCH',
        'MIDLINE_ON_RAIL',
        'RET_ON_RAIL',
        'EDGE_ON_RAIL',
        'NOT_ON_RAIL',
        'FLOW_IN_BRANCH',
        'BOX_IN_PARALLEL',
        'BOX_IN_TBRANCH',
        'BAD_LABEL',
        'BAD_INSTANCE',
        'MUST_BE_ALONE',
        'TOO_MANY_LABELS',
      ])
        expect(get(lang, `lad.diag.${c}`), c).toBeTypeOf('string');
    }
  });
});
