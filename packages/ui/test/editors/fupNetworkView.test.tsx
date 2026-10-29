import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LadNetwork } from '@baaportal/ladfbd';
import { createCodeBlock, type CodeBlock } from '@baaportal/project';
import { FupNetworkView } from '../../src/editors/fbd/FupNetworkView';
import { i18next, initI18n } from '../../src/i18n';
import { openEditor, dev } from '../blockFixtures';

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

describe('NetworksView di un blocco FUP', () => {
  it('mostra la vista FUP e il pulsante cambia il linguaggio', async () => {
    const f = createCodeBlock({ kind: 'FC', number: 31, name: 'Fup', language: 'FUP' });
    f.networks[0]!.lad = net();
    const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
    expect(screen.getByRole('group', { name: 'Vista FUP del segmento' })).toBeInTheDocument();
    expect(screen.getByText('Per aggiungere elementi passa a KOP')).toBeInTheDocument();
    const lang = () => (dev(app).blocks.find((b) => b.id === f.id) as CodeBlock).language;
    fireEvent.click(screen.getByRole('button', { name: 'Passa a KOP' }));
    expect(lang()).toBe('KOP');
    expect(screen.queryByRole('group', { name: 'Vista FUP del segmento' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Passa a FUP' }));
    expect(lang()).toBe('FUP');
  });
});
