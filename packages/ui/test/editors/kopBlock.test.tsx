import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { setLadActive } from '../../src/editors/lad/ladActive';
import { fakeDataTransfer, PLC } from '../blockFixtures';
import { renderApp, type RenderedApp } from '../renderApp';

const T = 30_000;
const kopBlocks = (app: RenderedApp) =>
  findDevice(app.store.getState().doc!.project, PLC)!.blocks.filter(
    (b) => b.kind !== 'DB' && b.kind !== 'IDB' && b.language === 'KOP',
  ) as CodeBlock[];
const canvas = (n = 1) => screen.getByRole('group', { name: `Segmento KOP ${n}` });

const kopBlocksOf = (p: Parameters<typeof findDevice>[0]) =>
  findDevice(p, PLC)!.blocks.filter(
    (b) => b.kind !== 'DB' && b.kind !== 'IDB' && b.language === 'KOP',
  ) as CodeBlock[];

/** Crea un FC in KOP dal dialogo e lo apre. */
async function newKopFc() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await app.user.click(screen.getByRole('menuitem', { name: 'Inserisci' }));
  await app.user.click(screen.getByRole('menuitem', { name: 'Nuovo blocco…' }));
  const dlg = screen.getByRole('dialog', { name: 'Aggiungi nuovo blocco' });
  await app.user.click(within(dlg).getByRole('radio', { name: /Funzione/ }));
  await app.user.selectOptions(within(dlg).getByLabelText('Linguaggio'), 'KOP');
  await app.user.click(within(dlg).getByTestId('dialog-ok'));
  await waitFor(() => expect(canvas()).toBeInTheDocument());
  return app;
}

/** NA `I 0.0` in serie e bobina `Q 4.0` (quella della rete vuota). */
async function fillRung(app: RenderedApp) {
  canvas().focus();
  await app.user.keyboard('{F2}{Enter}I 0.0{Enter}');
  await app.user.dblClick(within(canvas()).getByRole('button', { name: /^Bobina / }));
  await app.user.keyboard('Q 4.0{Enter}');
}

describe('blocchi KOP nell’editor dei blocchi', () => {
  it(
    'FC in KOP dal dialogo: rete vuota, NA e bobina, Mostra AWL, annulla',
    async () => {
      const app = await newKopFc();
      expect(kopBlocks(app)).toHaveLength(1);
      expect(kopBlocks(app)[0]!.networks[0]!.lad).toBeDefined();
      expect(within(canvas()).getByRole('button', { name: /^Bobina / })).toBeInTheDocument();
      expect(within(canvas()).queryByRole('button', { name: /^Contatto / })).toBeNull();

      await fillRung(app);
      expect(screen.getByRole('button', { name: 'Contatto NA I 0.0' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Bobina Q 4.0' })).toBeInTheDocument();
      expect(kopBlocks(app)[0]!.networks[0]!.source).toContain('%I0.0');
      expect(app.store.getState().history.past.at(-1)!.labelKey).toBe('history.editLad');

      await app.user.click(screen.getByRole('button', { name: 'Mostra AWL' }));
      const awl = screen.getByRole('textbox', { name: 'Codice del segmento 1' });
      // Il generatore scrive gli operandi in forma assoluta con `%`.
      expect(awl).toHaveTextContent('A %I0.0');
      expect(awl).toHaveTextContent('= %Q4.0');

      // Ctrl+Z toglie l'ultima modifica sia dal KOP sia dall'AWL.
      act(() => app.store.getState().undo());
      expect(screen.getByRole('button', { name: 'Bobina ??.?' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Codice del segmento 1' })).not.toHaveTextContent(
        '= %Q4.0',
      );
    },
    T,
  );

  it(
    'un operando vuoto compare in Problemi come «Segmento 1: …»',
    async () => {
      const app = await newKopFc();
      canvas().focus();
      await app.user.keyboard('{F2}');
      const panel = screen.getByRole('region', { name: 'Problemi' });
      // Il contatto appena inserito e la bobina della rete vuota.
      expect(within(panel).getAllByText('Segmento 1: Operando mancante.')).toHaveLength(2);
    },
    T,
  );

  it(
    'la tavolozza compare con un blocco KOP attivo e un clic inserisce nell’editor attivo',
    async () => {
      const app = await newKopFc();
      const pal = await screen.findByTestId('lad-palette');
      expect(within(pal).getByRole('group', { name: 'Logica a bit' })).toBeInTheDocument();
      canvas().focus();
      await app.user.click(within(pal).getByRole('button', { name: 'Contatto NC' }));
      expect(screen.getByRole('button', { name: 'Contatto NC ??.?' })).toBeInTheDocument();
    },
    T,
  );

  it(
    'trascinare dalla tavolozza o un FC dall’albero inserisce; Inserisci segmento crea una rete vuota',
    async () => {
      const app = await newKopFc();
      const callee = createCodeBlock({ kind: 'FC', number: 30, name: 'Dest', language: 'AWL' });
      callee.interface.input.push({ id: 'i1', name: 'Zeta', type: 'Int', comment: '' });
      act(() =>
        app.store.getState().edit('history.addBlock', (p) => {
          findDevice(p, PLC)!.blocks.push(callee);
        }),
      );
      const dt = fakeDataTransfer();
      dt.setData('application/x-baaportal-lad', JSON.stringify({ palette: 'contactNo' }));
      fireEvent.drop(canvas(), { dataTransfer: dt, clientX: 0, clientY: 0 });
      expect(screen.getByRole('button', { name: 'Contatto NA ??.?' })).toBeInTheDocument();

      const tree = fakeDataTransfer();
      tree.setData(
        'application/x-baaportal',
        JSON.stringify({
          deviceId: PLC,
          refs: [{ kind: 'block', deviceId: PLC, id: callee.id }],
        }),
      );
      fireEvent.drop(canvas(), { dataTransfer: tree, clientX: 0, clientY: 0 });
      const box = screen.getByRole('button', { name: /Box CALL/ });
      expect(box).toHaveTextContent('Dest');

      // Un payload «null» non è un oggetto dell'albero: niente CALL, niente errori.
      const bad = fakeDataTransfer();
      bad.setData('application/x-baaportal', 'null');
      fireEvent.drop(canvas(), { dataTransfer: bad, clientX: 0, clientY: 0 });
      expect(screen.getAllByRole('button', { name: /Box CALL/ })).toHaveLength(1);

      await app.user.click(screen.getByRole('button', { name: 'Inserisci segmento' }));
      const nets = kopBlocks(app)[0]!.networks;
      expect(nets).toHaveLength(2);
      expect(nets[1]!.lad).toBeDefined();
      expect(canvas(2)).toBeInTheDocument();
    },
    T,
  );

  it(
    'un segmento KOP senza grafico e con sorgente si vede in AWL con il messaggio',
    async () => {
      const app = await newKopFc();
      act(() =>
        app.store.getState().edit('history.editLad', (p) => {
          const b = findDevice(p, PLC)!.blocks.find(
            (x) => x.kind === 'FC' && x.name === 'Blocco_1',
          );
          const n = (b as CodeBlock).networks[0]!;
          delete n.lad;
          n.source = 'A I 0.0\n= Q 4.0';
        }),
      );
      expect(screen.getByTestId('kop-awl-hint')).toHaveTextContent(
        'Segmento in AWL: la conversione arriva con il piano 4C',
      );
      expect(screen.getByRole('textbox', { name: 'Codice del segmento 1' })).toHaveTextContent(
        'A I 0.0',
      );
    },
    T,
  );

  it(
    'senza editor attivo i pulsanti della tavolozza sono disattivati',
    async () => {
      await newKopFc();
      const pal = await screen.findByTestId('lad-palette');
      const b = within(pal).getByRole('button', { name: 'Contatto NA' });
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', 'Seleziona un punto in un segmento KOP');
    },
    T,
  );

  it(
    'un editor attivo di un altro blocco non riceve gli inserimenti',
    async () => {
      const app = await newKopFc();
      const other = { insertPalette: vi.fn(), insertBox: vi.fn() };
      act(() => setLadActive(other, true, { deviceId: PLC, blockId: 'altro-blocco' }));
      const pal = await screen.findByTestId('lad-palette');
      const b = within(pal).getByRole('button', { name: 'Contatto NA' });
      expect(b).toBeDisabled();
      await app.user.click(b);
      expect(other.insertPalette).not.toHaveBeenCalled();
      act(() => setLadActive(other, false, { deviceId: PLC, blockId: 'altro-blocco' }));
    },
    T,
  );

  it(
    'un blocco KOP importato non ricodificabile è in sola lettura',
    async () => {
      const app = await newKopFc();
      act(() =>
        app.store.getState().edit('history.editLad', (p) => {
          const b = kopBlocksOf(p)[0]!;
          b.mc7 = { exact: false } as never;
        }),
      );
      const before = app.store.getState().history.past.length;
      canvas().focus();
      await app.user.keyboard('{F2}');
      for (const name of ['NA', 'NC']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
      expect(screen.getByRole('button', { name: 'Inserisci segmento' })).toBeDisabled();
      const pal = screen.getByTestId('lad-palette');
      await app.user.click(within(pal).getByRole('button', { name: 'Contatto NA' }));
      expect(app.store.getState().history.past.length).toBe(before);
      expect(within(canvas()).queryByRole('button', { name: /^Contatto / })).toBeNull();
    },
    T,
  );
});
