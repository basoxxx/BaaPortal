import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LadNetwork } from '@baaportal/ladfbd';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { FupNetworkView } from '../../src/editors/fbd/FupNetworkView';
import { i18next, initI18n } from '../../src/i18n';
import { PLC, dev, fakeDataTransfer, openEditor } from '../blockFixtures';

beforeAll(async () => {
  await initI18n('it');
});

// A I0.0, AN I0.1, O(ramo M0.0), = Q0.0
const net = (): LadNetwork => ({
  root: {
    id: 'r',
    series: [
      { id: 'a', k: 'contact', neg: false, op: 'I 0.0' },
      {
        id: 'p',
        k: 'parallel',
        branches: [
          [{ id: 'b', k: 'contact', neg: true, op: 'I 0.1' }],
          [{ id: 'c', k: 'contact', neg: false, op: 'M 0.0' }],
        ],
      },
    ],
    outs: [{ id: 'o', k: 'coil', op: 'Q 0.0' }],
  },
});

function setup(readOnly = false, diag = new Map<string, string[]>()) {
  const onChange = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18next}>
      <FupNetworkView net={net()} diagnostics={diag} readOnly={readOnly} onChange={onChange} />
    </I18nextProvider>,
  );
  return { onChange, view };
}

describe('FupNetworkView', () => {
  it('mostra i riquadri & e >=1, la negazione e l’uscita = con Q 0.0', () => {
    const { view } = setup();
    expect(screen.getByText('&')).toBeInTheDocument();
    expect(screen.getByText('>=1')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.baa-fup-neg')).toHaveLength(1);
    expect(screen.getByText('=')).toBeInTheDocument();
    expect(screen.getByText('Q 0.0')).toBeInTheDocument();
  });

  it('doppio clic su un operando e Invio cambiano l’operando', () => {
    const { onChange } = setup();
    fireEvent.doubleClick(screen.getByText('I 0.0'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'I 5.0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as LadNetwork;
    expect(next.root.series[0]).toMatchObject({ id: 'a', op: 'I 5.0' });
  });

  it('Canc su un elemento selezionato lo toglie', () => {
    const { onChange } = setup();
    const el = screen.getByRole('button', { name: 'Bobina Q 0.0' });
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: 'Delete' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onChange.mock.calls[0]![0])).not.toContain('Q 0.0');
  });

  it('in sola lettura non chiama mai onChange', () => {
    const { onChange } = setup(true);
    fireEvent.doubleClick(screen.getByText('I 0.0'));
    expect(screen.queryByRole('textbox')).toBeNull();
    const el = screen.getByRole('button', { name: 'Bobina Q 0.0' });
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: 'Delete' });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('gli elementi sono raggiungibili da tastiera e mostrano le diagnostiche', () => {
    setup(false, new Map([['o', ['Operando mancante.']]]));
    const el = screen.getByRole('button', { name: 'Bobina Q 0.0' });
    expect(el).toHaveAttribute('tabindex', '0');
    expect(el).toHaveAttribute('title', 'Operando mancante.');
    expect(el).toHaveClass('baa-fup-el--error');
  });
});

describe('FupNetworkView: elementi che lavorano sulla logica davanti', () => {
  const show = (series: LadNetwork['root']['series']) =>
    render(
      <I18nextProvider i18n={i18next}>
        <FupNetworkView
          net={{ root: { id: 'r', series, outs: [{ id: 'o', k: 'coil', op: 'Q 0.0' }] } }}
          diagnostics={new Map()}
          readOnly={false}
          onChange={vi.fn()}
        />
      </I18nextProvider>,
    ).container;
  const c = (id: string, op: string) => ({ id, k: 'contact', neg: false, op }) as const;
  const el = (root: HTMLElement, id: string) => root.querySelector(`[data-fup-id="${id}"]`)!;

  it.each([
    ['(P)', { id: 'e', k: 'edge', dir: 'P', mem: 'M 0.0' } as const],
    ['#', { id: 'e', k: 'midline', op: 'M 0.0' } as const],
    [
      'MOVE',
      {
        id: 'e',
        k: 'box',
        box: 'MOVE',
        instance: '',
        pins: { IN: 'MW 0', OUT: 'MW 2' },
        boolPins: {},
      } as const,
    ],
  ])('%s prende come entrata ciò che lo precede, non è un’entrata del &', (_n, e) => {
    const root = show([c('a', 'I 0.0'), c('b', 'I 0.1'), e, c('d', 'I 0.2')]);
    const box = el(root, 'e');
    expect(box.contains(el(root, 'a'))).toBe(true);
    expect(box.contains(el(root, 'b'))).toBe(true);
    expect(box.contains(el(root, 'd'))).toBe(false);
    // Un & dentro il riquadro (A AND B) e uno fuori (… AND I 0.2).
    expect(within(box as HTMLElement).getAllByText('&')).toHaveLength(1);
    expect(screen.getAllByText('&')).toHaveLength(2);
  });

  it('il POS resta un’entrata del & (legge il suo bit, non la logica davanti)', () => {
    const root = show([
      c('a', 'I 0.0'),
      { id: 'e', k: 'posneg', dir: 'P', bit: 'I 1.0', mem: 'M 0.0' },
    ]);
    expect(el(root, 'e').contains(el(root, 'a'))).toBe(false);
  });
});

describe('NetworksView di un blocco FUP', () => {
  it('mostra la vista FUP, inserisce da tavolozza e albero, il pulsante cambia il linguaggio', async () => {
    const f = createCodeBlock({ kind: 'FC', number: 31, name: 'Fup', language: 'FUP' });
    f.networks[0]!.lad = net();
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(screen.getByRole('group', { name: 'Vista FUP del segmento' })).toBeInTheDocument();
    // La tavolozza inserisce nella vista FUP che ha il fuoco.
    const pal = await screen.findByTestId('lad-palette');
    act(() => screen.getByRole('button', { name: 'Bobina Q 0.0' }).focus());
    fireEvent.click(within(pal).getByRole('button', { name: 'Bobina RESET (R)' }));
    expect(screen.getByRole('button', { name: 'Bobina RESET (R) ??.?' })).toBeInTheDocument();
    const lad = () => (dev(app).blocks.find((b) => b.id === f.id) as CodeBlock).networks[0]!.lad!;
    expect(lad().root.outs.map((o) => ('k' in o ? o.k : 'node'))).toEqual(['coil', 'reset']);
    // Un FC dall'albero rilasciato sulla rete diventa un box CALL.
    const callee = createCodeBlock({ kind: 'FC', number: 30, name: 'Dest', language: 'AWL' });
    act(() =>
      app.store
        .getState()
        .edit('history.addBlock', (p) => void findDevice(p, PLC)!.blocks.push(callee)),
    );
    const tree = fakeDataTransfer();
    tree.setData(
      'application/x-baaportal',
      JSON.stringify({ deviceId: PLC, refs: [{ kind: 'block', deviceId: PLC, id: callee.id }] }),
    );
    fireEvent.drop(screen.getByRole('group', { name: 'Vista FUP del segmento' }), {
      dataTransfer: tree,
    });
    expect(screen.getAllByRole('button', { name: /Box CALL/ })[0]).toHaveTextContent('Dest');
    const lang = () => (dev(app).blocks.find((b) => b.id === f.id) as CodeBlock).language;
    fireEvent.click(screen.getByRole('button', { name: 'Passa a KOP' }));
    expect(lang()).toBe('KOP');
    expect(screen.queryByRole('group', { name: 'Vista FUP del segmento' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Passa a FUP' }));
    expect(lang()).toBe('FUP');
  }, 30_000);
});
