import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyNetwork, networkToAwl } from '@baaportal/ladfbd';
import type { LadNetwork } from '@baaportal/ladfbd';
import { FupNetworkView } from '../../src/editors/fbd/FupNetworkView';
import { LadNetworkEditor } from '../../src/editors/lad/LadNetworkEditor';
import type { LadInsertApi } from '../../src/editors/lad/LadNetworkEditor';
import { i18next, initI18n } from '../../src/i18n';
import { fakeDataTransfer } from '../blockFixtures';

beforeAll(async () => {
  await initI18n('it');
});

type Over = { callOfDrop?: (raw: string) => string | undefined; kop?: boolean };

/** Monta la vista FUP (o l'editor KOP) con uno stato locale che applica `onChange`. */
function setup(initial?: (id: () => string) => LadNetwork, over: Over = {}) {
  let n = 0;
  const newId = () => `n${++n}`;
  let net = initial ? initial(newId) : emptyNetwork(newId);
  let api: LadInsertApi | undefined;
  const onActive = (a: LadInsertApi, on: boolean) => void (api = on ? a : undefined);
  const onChange = vi.fn((next: LadNetwork) => {
    net = next;
    view.rerender(ui());
  });
  const ui = () => (
    <I18nextProvider i18n={i18next}>
      {over.kop ? (
        <LadNetworkEditor
          net={net}
          index={0}
          diagnostics={new Map()}
          readOnly={false}
          onChange={onChange}
          newId={newId}
          onActive={onActive}
        />
      ) : (
        <FupNetworkView
          net={net}
          diagnostics={new Map()}
          readOnly={false}
          onChange={onChange}
          newId={newId}
          onActive={onActive}
          callOfDrop={over.callOfDrop}
        />
      )}
    </I18nextProvider>
  );
  const view = render(ui());
  const group = screen.getByRole('group', {
    name: over.kop ? 'Segmento KOP 1' : 'Vista FUP del segmento',
  });
  return {
    onChange,
    user: userEvent.setup(),
    group,
    net: () => net,
    api: () => api,
    unmount: view.unmount,
  };
}

const awl = (net: LadNetwork) => networkToAwl(net, { tempEnd: 0, firstLabel: 1 }).source;

describe('FupNetworkView: inserimento', () => {
  it('F2 aggiunge entrate al riquadro &, F3 un’entrata negata; una onChange per tasto', async () => {
    const { onChange, user, group, net } = setup();
    group.focus();
    await user.keyboard('{F2}');
    expect(screen.getByRole('button', { name: 'Contatto NA ??.?' })).toHaveFocus();
    expect(screen.queryByText('&')).toBeNull();
    await user.keyboard('{F3}');
    expect(screen.getByText('&')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(2);
    // Il nuovo contatto va dopo quello selezionato, nella stessa serie.
    expect(net().root.series.map((e) => e.k === 'contact' && e.neg)).toEqual([false, true]);
  });

  it('F8 sull’entrata selezionata apre un riquadro >=1, F9 lo chiude dopo l’entrata che segue', async () => {
    const { user, group, net } = setup();
    group.focus();
    await user.keyboard('{F2}{Enter}I 0.0{Enter}');
    await user.keyboard('{F8}');
    expect(screen.getByText('>=1')).toBeInTheDocument();
    const par = net().root.series[0]!;
    expect(par.k).toBe('parallel');
    await user.click(screen.getByRole('button', { name: 'Contatto NA I 0.0' }));
    await user.keyboard('{F2}');
    // Il contatto nuovo è nello stesso ramo, dopo I 0.0; F9 senza parallelo prima segnala.
    await user.keyboard('{F9}');
    expect(screen.getByRole('status')).toHaveTextContent('Impossibile chiudere il ramo qui');
  });

  it('N nega: il contatto cambia NA/NC, la prima entrata di un box riceve il NOT, sul NOT lo toglie', async () => {
    const { user, group, net } = setup((id) => ({
      root: {
        id: id(),
        series: [{ id: 'b', k: 'cmp', fn: '==I', in1: 'MW 0', in2: 'MW 2' }],
        outs: [{ id: 'o', k: 'coil', op: 'Q 0.0' }],
      },
    }));
    group.focus();
    await user.keyboard('{F2}');
    await user.keyboard('n');
    expect(screen.getByRole('button', { name: 'Contatto NC ??.?' })).toHaveFocus();
    await user.keyboard('{Enter}I 0.0{Enter}');
    await user.click(screen.getByRole('button', { name: /^Confronto/ }));
    await user.keyboard('n');
    expect(net().root.series.map((e) => e.k)).toEqual(['cmp', 'not', 'contact']);
    expect(awl(net())).toContain('NOT');
    // Il NOT è fuso: un cerchietto sul pin del confronto, dentro il riquadro &.
    const not = screen.getByRole('button', { name: 'Negazione (NOT)' });
    expect(not.closest('.baa-fup-in')?.textContent).toContain('CMP ==I');
    await user.click(not);
    await user.keyboard('n');
    expect(net().root.series.map((e) => e.k)).toEqual(['cmp', 'contact']);
    // Un'uscita non si nega: messaggio e nessuna modifica.
    await user.click(screen.getByRole('button', { name: 'Bobina Q 0.0' }));
    await user.keyboard('n');
    expect(screen.getByRole('status')).toHaveTextContent('Qui non si nega');
    expect(net().root.series).toHaveLength(2);
  });

  it('N sulla prima entrata di un ramo a T che eredita logica: il contatto sì, il NOT no', async () => {
    const { user, group, net } = setup(() => ({
      root: {
        id: 'r',
        series: [{ id: 'a', k: 'contact', neg: false, op: 'I 0.0' }],
        outs: [
          {
            id: 't',
            series: [
              { id: 'b', k: 'cmp', fn: '==I', in1: 'MW 0', in2: 'MW 2' },
              { id: 'x', k: 'contact', neg: false, op: 'I 0.1' },
            ],
            outs: [{ id: 'o', k: 'coil', op: 'Q 0.0' }],
          },
          { id: 'o2', k: 'coil', op: 'Q 0.1' },
        ],
      },
    }));
    group.focus();
    // Un NOT dopo il confronto negherebbe anche I 0.0 (A L0.0, A(…), NOT): si rifiuta.
    await user.click(screen.getByRole('button', { name: /^Confronto/ }));
    await user.keyboard('n');
    expect(screen.getByRole('status')).toHaveTextContent('Qui non si nega');
    expect(awl(net())).not.toContain('NOT');
    await user.click(screen.getByRole('button', { name: 'Contatto NA I 0.1' }));
    await user.keyboard('n');
    expect(awl(net())).toContain('AN %I0.1');
    expect(awl(net())).not.toContain('NOT');
  });

  it('F7 seleziona la bobina vuota; la tavolozza aggiunge un’uscita S', async () => {
    const { user, group, net, api } = setup();
    group.focus();
    await user.keyboard('{F7}');
    expect(screen.getByRole('button', { name: 'Bobina ??.?' })).toHaveFocus();
    api()!.insertPalette('set');
    expect(screen.getByText('S')).toBeInTheDocument();
    expect(net().root.outs.map((o) => ('k' in o ? o.k : 'node'))).toEqual(['coil', 'set']);
    // Con due uscite la logica comune si ripete davanti a ognuna (limite noto della resa).
    api()!.insertBox('ADD_I');
    expect(screen.getAllByRole('button', { name: 'Box ADD_I' })).toHaveLength(2);
  });

  it('i pulsanti della barra inseriscono come i tasti', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Entrata &' }));
    await user.click(screen.getByRole('button', { name: 'Entrata >=1' }));
    expect(screen.getByText('>=1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Box vuoto/ }));
    await user.click(screen.getByRole('menuitem', { name: /^MOVE/ }));
    expect(screen.getByRole('button', { name: 'Box MOVE' })).toBeInTheDocument();
  });

  it('trascinare dalla tavolozza su un elemento inserisce dopo di lui; un FC dall’albero diventa CALL', () => {
    const callOfDrop = vi.fn((raw: string) => (raw === 'fc' ? 'FC 30' : undefined));
    const { net, group } = setup(
      (id) => ({
        root: {
          id: id(),
          series: [
            { id: 'a', k: 'contact', neg: false, op: 'I 0.0' },
            { id: 'z', k: 'contact', neg: false, op: 'I 0.9' },
          ],
          outs: [{ id: 'o', k: 'coil', op: 'Q 0.0' }],
        },
      }),
      { callOfDrop },
    );
    const dt = fakeDataTransfer();
    dt.setData('application/x-baaportal-lad', JSON.stringify({ palette: 'contactNc' }));
    fireEvent.dragOver(group, { dataTransfer: dt });
    fireEvent.drop(screen.getByText('I 0.0'), { dataTransfer: dt });
    expect(net().root.series.map((e) => e.id)).toEqual(['a', 'n2', 'z']);
    const tree = fakeDataTransfer();
    tree.setData('application/x-baaportal', 'fc');
    fireEvent.drop(group, { dataTransfer: tree });
    expect(screen.getByRole('button', { name: 'Box CALL FC 30' })).toBeInTheDocument();
    const bad = fakeDataTransfer();
    bad.setData('application/x-baaportal', 'altro');
    fireEvent.drop(group, { dataTransfer: bad });
    expect(net().root.series).toHaveLength(4);
  });

  it('le frecce passano da un elemento all’altro', async () => {
    const { user, group } = setup();
    group.focus();
    await user.keyboard('{F2}{F2}');
    const [first, second] = screen.getAllByRole('button', { name: 'Contatto NA ??.?' });
    expect(second).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Bobina ??.?' })).toHaveFocus();
  });

  it('gli stessi gesti in KOP e in FUP danno la stessa rete e lo stesso AWL', async () => {
    const steps =
      '{F2}{Enter}I 0.0{Enter}{F3}{Enter}I 0.1{Enter}{F8}{Enter}M 0.0{Enter}{F7}{Enter}Q 4.0{Enter}';
    const run = async (kop: boolean) => {
      const s = setup(undefined, { kop });
      s.group.focus();
      await s.user.keyboard(steps);
      s.api()!.insertPalette('reset');
      await s.user.keyboard('{Enter}M 1.0{Enter}');
      s.unmount();
      return s.net();
    };
    const kop = await run(true);
    const fup = await run(false);
    expect(fup).toEqual(kop);
    expect(awl(fup)).toBe(awl(kop));
    expect(awl(fup)).toContain('O %M0.0;');
  });
});
