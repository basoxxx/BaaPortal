import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findDevice, type HmiScreen } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { addHmiScreenTo } from '../../src/project/navigation/addActions';
import { renderApp, type RenderedApp } from '../renderApp';

const PLC = 'id1';

async function openEditor() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => addHmiScreenTo(app.store, PLC));
  await screen.findByTestId('hmi-canvas');
  return app;
}

const screenOf = (app: RenderedApp): HmiScreen =>
  findDevice(app.store.getState().doc!.project, PLC)!.hmi!.screens[0]!;
const ctx = (app: RenderedApp) => ({ store: app.store, service: app.service, bridge: app.bridge });

describe('editor delle schermate HMI', () => {
  it('nuova schermata: nell’albero sotto «Schermate HMI», 800 × 480', async () => {
    const app = await openEditor();
    const sc = screenOf(app);
    expect(sc).toMatchObject({ name: 'Schermata_1', width: 800, height: 480, objects: [] });
    expect(screen.getByRole('treeitem', { name: /Schermata_1/ })).toBeInTheDocument();
    // le dimensioni si scelgono fra quelle proposte
    await app.user.selectOptions(screen.getByLabelText('Dimensioni'), '1');
    expect(screenOf(app)).toMatchObject({ width: 1024, height: 600 });
  });

  it('tavolozza → oggetto selezionato; trascinare sposta sulla griglia, la maniglia ridimensiona', async () => {
    const app = await openEditor();
    await app.user.click(screen.getByTestId('hmi-tool-button'));
    const o = screenOf(app).objects[0]!;
    expect(o).toMatchObject({ kind: 'button', x: 20, y: 20, w: 100, h: 40, text: 'Pulsante' });
    const el = screen.getByTestId(`hmi-obj-${o.id}`);
    expect(el).toHaveAttribute('aria-selected', 'true');
    const canvas = screen.getByTestId('hmi-canvas');
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 133, clientY: 147, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 133, clientY: 147, pointerId: 1 });
    expect(screenOf(app).objects[0]).toMatchObject({ x: 50, y: 70 }); // 20+33 → 50, 20+47 → 70
    fireEvent.pointerDown(screen.getByTestId('hmi-resize'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(canvas, { clientX: 21, clientY: -9 });
    fireEvent.pointerUp(canvas, { clientX: 21, clientY: -9 });
    expect(screenOf(app).objects[0]).toMatchObject({ w: 120, h: 30 });
    // un passo di annulla per gesto
    act(() => app.store.getState().undo());
    expect(screenOf(app).objects[0]).toMatchObject({ w: 100, h: 40, x: 50 });
    act(() => app.store.getState().undo());
    expect(screenOf(app).objects[0]).toMatchObject({ x: 20, y: 20 });
  });

  it('frecce: spostano di un passo di griglia, Alt di 1 px, Maiusc ridimensiona', async () => {
    const app = await openEditor();
    await app.user.click(screen.getByTestId('hmi-tool-lamp'));
    const canvas = screen.getByTestId('hmi-canvas');
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    expect(screenOf(app).objects[0]).toMatchObject({ x: 30, y: 21, w: 50, h: 40 });
  });

  it('proprietà: variabile con completamento ed errore, colore, formato', async () => {
    const app = await openEditor();
    act(() => {
      app.store.getState().edit('t', (p) => {
        findDevice(p, PLC)!.tagTables[0]!.tags.push({
          id: 't1',
          name: 'Motore',
          type: 'Bool',
          address: '%Q4.0',
          hmi: true,
          comment: '',
        });
      });
    });
    await app.user.click(screen.getByTestId('hmi-tool-lamp'));
    const props = within(screen.getByTestId('hmi-props'));
    const tag = props.getByLabelText('Variabile');
    await app.user.click(tag);
    await app.user.type(tag, '"Mo');
    const options = [
      ...document.querySelectorAll(`#${CSS.escape(tag.getAttribute('list')!)} option`),
    ];
    expect(options.map((o) => o.getAttribute('value'))).toContain('"Motore"');
    await app.user.clear(tag);
    await app.user.type(tag, 'MW 10{Enter}');
    expect(screenOf(app).objects[0]!.tag).toBe('MW 10');
    expect(props.getByText('Serve un bit')).toBeInTheDocument();
    await app.user.clear(tag);
    await app.user.type(tag, '"Motore"{Enter}');
    expect(props.queryByText('Serve un bit')).toBeNull();
    fireEvent.change(props.getByLabelText('Colore acceso'), { target: { value: '#ff0000' } });
    expect(screenOf(app).objects[0]!.onColor).toBe('#ff0000');

    await app.user.click(screen.getByTestId('hmi-tool-ioField'));
    await app.user.selectOptions(props.getByLabelText('Formato'), 'REAL');
    expect(screenOf(app).objects[1]!.format).toBe('REAL');
  });

  it('testo e variabile oltre il limite del file non si salvano', async () => {
    const app = await openEditor();
    await app.user.click(screen.getByTestId('hmi-tool-button'));
    const props = within(screen.getByTestId('hmi-props'));
    const text = props.getByLabelText('Testo');
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: 'x'.repeat(1001) } });
    fireEvent.blur(text);
    expect(screenOf(app).objects[0]!.text).toBe('Pulsante');
    expect(props.getByLabelText('Variabile')).toHaveAttribute('maxLength', '1000');
  });

  it('copia, incolla ed elimina con i comandi di Modifica; annulla rimette tutto', async () => {
    const app = await openEditor();
    await app.user.click(screen.getByTestId('hmi-tool-text'));
    const canvas = screen.getByTestId('hmi-canvas');
    act(() => canvas.focus());
    await waitFor(() => expect(app.store.getState().editTarget?.can.copy).toBe(true));
    await act(async () => {
      await commands['edit.copy'].run(ctx(app));
    });
    await waitFor(() => expect(app.store.getState().editTarget?.can.paste).toBe(true));
    await act(async () => {
      await commands['edit.paste'].run(ctx(app));
    });
    const objs = screenOf(app).objects;
    expect(objs).toHaveLength(2);
    expect(objs[1]).toMatchObject({ kind: 'text', x: 30, y: 30 });
    expect(objs[1]!.id).not.toBe(objs[0]!.id);
    await act(async () => {
      await commands['edit.delete'].run(ctx(app));
    });
    expect(screenOf(app).objects).toHaveLength(1);
    act(() => app.store.getState().undo());
    expect(screenOf(app).objects).toHaveLength(2);
  });

  it('senza simulazione né collegamento il runtime non parte', async () => {
    await openEditor();
    expect(screen.getByRole('button', { name: 'Avvia runtime HMI' })).toBeDisabled();
    expect(screen.getByLabelText('Consenti scritture nella CPU')).toBeDisabled();
  });
});
