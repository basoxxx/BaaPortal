import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CommitInput } from '../src/components/CommitField';
import { Dialog } from '../src/components/Dialog';
import { i18next, initI18n } from '../src/i18n';

beforeAll(async () => {
  await initI18n('it');
});

function setup(over: { okDisabled?: boolean } = {}) {
  const onClose = vi.fn();
  const onOk = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18next}>
      <button type="button">Fuori</button>
      <Dialog title="Titolo" onClose={onClose} onOk={onOk} {...over}>
        <input aria-label="Primo" />
        <CommitInput aria-label="Confermato" value="x" onCommit={() => {}} />
        <textarea aria-label="Note" />
      </Dialog>
    </I18nextProvider>,
  );
  return { onClose, onOk, user };
}

describe('Dialog', () => {
  it('è modale, etichettata dal titolo e dà il focus al primo campo', () => {
    setup();
    const dlg = screen.getByRole('dialog', { name: 'Titolo' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Primo')).toHaveFocus();
  });

  it("il focus resta dentro: Tab dall'ultimo va al primo e Maiusc+Tab dal primo all'ultimo", async () => {
    const { user } = setup();
    const ok = screen.getByRole('button', { name: 'OK' });
    const cancel = screen.getByRole('button', { name: 'Annulla' });
    cancel.focus();
    await user.tab();
    expect(screen.getByLabelText('Primo')).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(ok).toHaveFocus();
  });

  it("Esc chiude, Invio conferma se OK è attivo e non dentro un'area di testo", async () => {
    const { user, onClose, onOk } = setup();
    await user.keyboard('{Enter}');
    expect(onOk).toHaveBeenCalledTimes(1);
    await user.click(screen.getByLabelText('Note'));
    await user.keyboard('{Enter}');
    expect(onOk).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('con OK disattivato Invio non conferma', async () => {
    const { user, onOk } = setup({ okDisabled: true });
    await user.keyboard('{Enter}');
    expect(onOk).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
  });

  it('Esc in un campo a conferma modificato ripristina il campo e non chiude; il secondo Esc chiude', async () => {
    const { user, onClose } = setup();
    const field = screen.getByLabelText('Confermato');
    await user.click(field);
    await user.type(field, 'yy');
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('x');
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Invio in un campo a conferma non conferma il dialogo', async () => {
    const { user, onOk } = setup();
    await user.click(screen.getByLabelText('Confermato'));
    await user.keyboard('{Enter}');
    expect(onOk).not.toHaveBeenCalled();
  });

  it('alla chiusura il focus torna a ciò che lo aveva prima', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { unmount } = render(
      <I18nextProvider i18n={i18next}>
        <Dialog title="T" onClose={() => {}} onOk={() => {}}>
          <input aria-label="A" />
        </Dialog>
      </I18nextProvider>,
    );
    expect(screen.getByLabelText('A')).toHaveFocus();
    unmount();
    expect(before).toHaveFocus();
    before.remove();
  });
});
