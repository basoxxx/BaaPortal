import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, findDevice } from '@baaportal/project';
import { initI18n } from '../src/i18n';
import { updateSettings } from '../src/settings/settings';
import { renderApp, type RenderedApp } from './renderApp';

const PLC = 'id1';

const openBlockDialog = async (app: RenderedApp) => {
  await app.user.click(screen.getByRole('menuitem', { name: 'Inserisci' }));
  await app.user.click(screen.getByRole('menuitem', { name: 'Nuovo blocco…' }));
  return screen.getByRole('dialog', { name: 'Aggiungi nuovo blocco' });
};
const blocks = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!.blocks;
const addBlock = (app: RenderedApp, b: ReturnType<typeof createCodeBlock>) =>
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(b);
    });
  });

describe('Aggiungi nuovo blocco', () => {
  it('FB: numero automatico 1, nome Blocco_1; con FB1 esistente → FB2, Blocco_2', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    let dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Blocco funzionale/ }));
    expect(within(dlg).getByLabelText('Nome')).toHaveValue('Blocco_1');
    expect(within(dlg).getByLabelText('Numero')).toHaveValue(1);
    expect(within(dlg).getByLabelText('Numero')).toBeDisabled();
    await app.user.click(within(dlg).getByTestId('dialog-ok'));

    const fb = blocks(app).find((b) => b.kind === 'FB')!;
    expect(fb).toMatchObject({ number: 1, name: 'Blocco_1', language: 'AWL' });
    expect(app.store.getState().selection).toBe(`plc:${PLC}:block:${fb.id}`);
    expect(app.store.getState().history.past).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Blocco funzionale/ }));
    expect(within(dlg).getByLabelText('Nome')).toHaveValue('Blocco_2');
    expect(within(dlg).getByLabelText('Numero')).toHaveValue(2);
  });

  it.each([false, true])('FUP e SCL sono abilitati solo con experimental (%s)', async (exp) => {
    try {
      const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
      act(() => updateSettings({ online: { experimental: exp } }));
      const dlg = await openBlockDialog(app);
      const lang = within(dlg).getByLabelText('Linguaggio') as HTMLSelectElement;
      expect([...lang.options].map((o) => [o.value, o.disabled])).toEqual([
        ['AWL', false],
        ['KOP', false],
        ['FUP', !exp],
        ['SCL', !exp],
      ]);
    } finally {
      updateSettings({ online: { experimental: false } });
    }
  });

  it("OB: elenco senza OB1 già presente e solo OB della CPU; il nome viene dall'evento", async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Blocco organizzativo/ }));
    const ev = within(dlg).getByLabelText('Evento') as HTMLSelectElement;
    const nums = [...ev.options].map((o) => Number(o.value));
    // 315-2 PN/DP: 1, 10, 20, 35, 40, 80, 82, 85, 86, 100, 121, 122; OB1 c'è già.
    expect(nums).toEqual([10, 20, 35, 40, 80, 82, 85, 86, 100, 121, 122]);
    expect(within(dlg).getByLabelText('Nome')).toHaveValue("Allarme dall'orologio");
    await app.user.selectOptions(ev, '35');
    expect(within(dlg).getByLabelText('Nome')).toHaveValue('Schedulazione orologio');
    expect(within(dlg).getByLabelText('Numero')).toHaveValue(35);
    await app.user.click(within(dlg).getByTestId('dialog-ok'));
    expect(blocks(app).find((b) => b.kind === 'OB' && b.number === 35)).toMatchObject({
      name: 'Schedulazione orologio',
    });
  });

  it("con l'interfaccia in inglese il nome predefinito dell'OB è inglese", async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await act(async () => {
      await initI18n('en');
    });
    await app.user.click(screen.getByRole('menuitem', { name: 'Insert' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'New block…' }));
    const dlg = screen.getByRole('dialog');
    await app.user.click(within(dlg).getByRole('radio', { name: /Organization block/ }));
    expect(within(dlg).getByLabelText('Name')).toHaveValue('Time of day');
    await app.user.click(within(dlg).getByTestId('dialog-ok'));
    expect(blocks(app).find((b) => b.number === 10)).toMatchObject({ name: 'Time of day' });
    await initI18n('it');
  });

  it('numero manuale doppio: messaggio e OK disattivato; fuori limite pure', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    addBlock(app, createCodeBlock({ kind: 'FC', number: 1, name: 'Calcolo', language: 'AWL' }));
    const dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Funzione/ }));
    await app.user.click(within(dlg).getByLabelText('Automatico'));
    const num = within(dlg).getByLabelText('Numero');
    expect(num).toHaveValue(2);
    await app.user.clear(num);
    await app.user.type(num, '1');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Questo numero è già in uso.');
    expect(within(dlg).getByTestId('dialog-ok')).toBeDisabled();
    await app.user.clear(num);
    await app.user.type(num, '99999');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('compreso tra 1 e');
    expect(within(dlg).getByTestId('dialog-ok')).toBeDisabled();
    await app.user.clear(num);
    await app.user.type(num, '7');
    expect(within(dlg).queryByRole('alert')).not.toBeInTheDocument();
    await app.user.click(within(dlg).getByTestId('dialog-ok'));
    expect(blocks(app).find((b) => b.name === 'Blocco_1')).toMatchObject({ kind: 'FC', number: 7 });
  });

  it('DB globale e DB di istanza: i DB e gli IDB condividono la numerazione', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    addBlock(app, createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL' }));
    let dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Blocco dati/ }));
    expect(within(dlg).queryByLabelText('Linguaggio')).not.toBeInTheDocument();
    expect(within(dlg).getByLabelText('Nome')).toHaveValue('Blocco_dati_1');
    await app.user.click(within(dlg).getByTestId('dialog-ok'));
    expect(blocks(app).find((b) => b.kind === 'DB')).toMatchObject({ number: 1 });

    dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Blocco dati/ }));
    await app.user.click(within(dlg).getByRole('radio', { name: 'DB di istanza di' }));
    expect(within(dlg).getByLabelText('Blocco funzionale')).toHaveValue('Nastro');
    expect(within(dlg).getByLabelText('Nome')).toHaveValue('Nastro_DB');
    expect(within(dlg).getByLabelText('Numero')).toHaveValue(2);
    await app.user.click(within(dlg).getByTestId('dialog-ok'));
    expect(blocks(app).find((b) => b.kind === 'IDB')).toMatchObject({
      name: 'Nastro_DB',
      instanceOf: 'Nastro',
      number: 2,
    });
  });

  it('DB di istanza senza FB: messaggio e OK disattivato', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByRole('radio', { name: /Blocco dati/ }));
    await app.user.click(within(dlg).getByRole('radio', { name: 'DB di istanza di' }));
    expect(within(dlg).getByRole('alert')).toHaveTextContent('nessun FB');
    expect(within(dlg).getByTestId('dialog-ok')).toBeDisabled();
  });

  it('un nome già usato da un simbolo disattiva OK; "Aggiungi e apri" è attivo per default', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const dlg = await openBlockDialog(app);
    expect(within(dlg).getByLabelText('Aggiungi e apri')).toBeChecked();
    const name = within(dlg).getByLabelText('Nome');
    await app.user.clear(name);
    await app.user.type(name, 'MAIN');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Il nome è già in uso.');
    expect(within(dlg).getByTestId('dialog-ok')).toBeDisabled();
  });

  it('con il dialogo aperto le scorciatoie globali non agiscono (Mod+Z non annulla, Mod+S non salva)', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    addBlock(app, createCodeBlock({ kind: 'FC', number: 1, name: 'Calcolo', language: 'AWL' }));
    const saved = app.bridge.files.get('/doc/BaaPortal/Linea 3.baap');
    const dlg = await openBlockDialog(app);
    await app.user.click(within(dlg).getByTestId('dialog-cancel'));
    const again = await openBlockDialog(app);
    act(() => within(again).getByTestId('dialog-cancel').focus());
    await app.user.keyboard('{Control>}z{/Control}');
    expect(blocks(app)).toHaveLength(2);
    act(() => within(again).getByLabelText('Nome').focus());
    await app.user.keyboard('{Control>}s{/Control}');
    await new Promise((r) => setTimeout(r, 20));
    expect(app.bridge.files.get('/doc/BaaPortal/Linea 3.baap')).toBe(saved);
    expect(app.store.getState().doc!.dirty).toBe(true);
    // Chiuso il dialogo tornano a funzionare.
    await app.user.click(within(again).getByTestId('dialog-cancel'));
    await app.user.keyboard('{Control>}z{/Control}');
    expect(blocks(app)).toHaveLength(1);
  });

  it('un nome non valido (con le virgolette) disattiva OK con il messaggio della rinomina', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const dlg = await openBlockDialog(app);
    const name = within(dlg).getByLabelText('Nome');
    await app.user.clear(name);
    await app.user.type(name, 'a"b');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Il nome non è valido.');
    expect(within(dlg).getByTestId('dialog-ok')).toBeDisabled();
    await app.user.keyboard('{Enter}');
    expect(blocks(app)).toHaveLength(1);
  });

  it("dal nodo Aggiungi nuovo blocco dell'albero il blocco va nel PLC di quel nodo", async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await app.user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:blocks-add`));
    const dlg = screen.getByRole('dialog', { name: 'Aggiungi nuovo blocco' });
    await app.user.click(within(dlg).getByTestId('dialog-ok'));
    expect(blocks(app)).toHaveLength(2);
    const added = blocks(app)[1]!;
    expect(screen.getByTestId(`tree-node-plc:${PLC}:block:${added.id}`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('Esc chiude senza modifiche', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await openBlockDialog(app);
    await app.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(blocks(app)).toHaveLength(1);
  });
});
