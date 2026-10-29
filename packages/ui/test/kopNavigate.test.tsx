import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { blockSources, createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import type { LadElem, LadNetwork, LadOut } from '@baaportal/ladfbd';
import { getProgress } from '../src/project/progress';
import { openHit } from '../src/search/findActions';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';
const contact = (id: string, op: string): LadElem => ({ id, k: 'contact', neg: false, op });
const coil = (id: string, op: string): LadOut => ({ id, k: 'coil', op });
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;

/** FC in KOP: i contatti `ea` e `eb` in serie con la bobina `eq` (Q 4.0). */
async function setup(a: string, b: string) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  const blk = createCodeBlock({ kind: 'FC', number: 20, name: 'Kop20', language: 'KOP' });
  const lad: LadNetwork = {
    root: { id: 'n', series: [contact('ea', a), contact('eb', b)], outs: [coil('eq', 'Q 4.0')] },
  };
  blk.networks[0]!.lad = lad;
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(blk);
    });
  });
  return { app, blk: dev(app).blocks.find((x) => x.name === 'Kop20') as CodeBlock };
}

const pressed = () =>
  screen
    .queryAllByRole('button', { pressed: true })
    .map((e) => e.getAttribute('data-lad-id'))
    .filter((id) => id !== null);

/** Compila il dispositivo e fa clic sul primo messaggio del blocco Kop20. */
async function clickFirstMessage(app: RenderedApp) {
  await app.user.pointer({
    keys: '[MouseRight]',
    target: screen.getByTestId(`tree-node-${ids.plc(PLC)}`),
  });
  await app.user.click(
    screen.getByRole('menuitem', { name: 'Compila → Software (compilazione completa)' }),
  );
  await waitFor(() => expect(getProgress()).toBeNull());
  fireEvent.click(screen.getByTestId('info-subtab-compile'));
  const row = screen
    .getAllByTestId('compile-row')
    .find((r) => r.getAttribute('data-block') === 'Kop20')!;
  await app.user.click(within(row).getAllByTestId('compile-message')[0]!);
}

describe('KOP: i messaggi portano all’elemento', () => {
  it(
    'un messaggio di compilazione del grafico seleziona l’elemento',
    async () => {
      const { app } = await setup('I 0.0', '');
      await clickFirstMessage(app);
      await waitFor(() => expect(pressed()).toEqual(['eb']));
    },
    T,
  );

  it(
    'un messaggio sull’AWL generato torna all’elemento che ha scritto la riga',
    async () => {
      const { app } = await setup('I 0.0', '"Nope"');
      await clickFirstMessage(app);
      await waitFor(() => expect(pressed()).toEqual(['eb']));
    },
    T,
  );

  it(
    'una voce di Problemi seleziona l’elemento',
    async () => {
      const { app, blk } = await setup('', 'I 0.1');
      app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: blk.id });
      const panel = await screen.findByRole('region', { name: 'Problemi' });
      await app.user.click(within(panel).getAllByRole('button', { name: /Operando mancante/ })[0]!);
      await waitFor(() => expect(pressed()).toEqual(['ea']));
    },
    T,
  );

  it(
    'un risultato di Trova nel codice generato seleziona l’elemento',
    async () => {
      const { app, blk } = await setup('I 0.0', 'I 0.1');
      // Il segmento salvato porta l'AWL generato (qui lo si scrive come fa l'editor).
      const src = blockSources(blk, dev(app))[0]!;
      act(() => {
        app.store.getState().edit('history.editLad', (p) => {
          const b = findDevice(p, PLC)!.blocks.find((x) => x.id === blk.id) as CodeBlock;
          b.networks[0]!.source = src;
        });
      });
      const from = src.indexOf('%I0.1');
      openHit(app.store, {
        loc: {
          kind: 'network',
          deviceId: PLC,
          blockId: blk.id,
          networkIndex: 0,
          from,
          to: from + 5,
        },
        match: '%I0.1',
        preview: '',
        editable: false,
        reason: 'KOP',
      });
      await waitFor(() => expect(pressed()).toEqual(['eb']));
    },
    T,
  );
});
