import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

// Permette di far fallire `applySource` come ultima difesa contro un numero doppio.
const guard = vi.hoisted(() => ({ calls: 0, failAt: 0 }));
vi.mock('@baaportal/importers', async (orig) => {
  const mod = await orig<typeof import('@baaportal/importers')>();
  return {
    ...mod,
    applySource: (...a: Parameters<typeof mod.applySource>) => {
      if (++guard.calls === guard.failAt) throw new Error('numero doppio');
      return mod.applySource(...a);
    },
  };
});
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { generateSourceFromNodes } from '../src/project/navigation/sourceActions';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const past = (app: RenderedApp) => app.store.getState().history.past.length;
const tn = (id: string) => screen.getByTestId(`tree-node-${id}`);
const bytes = (s: string) => new TextEncoder().encode(s);

const SRC = [
  'TYPE "Asse"',
  'STRUCT',
  '  X : Int;',
  'END_STRUCT;',
  'END_TYPE',
  '',
  'FUNCTION_BLOCK "Motore"',
  'VAR_INPUT',
  '  Avvio : Bool;',
  'END_VAR',
  'BEGIN',
  'NETWORK',
  'TITLE =',
  '  A #Avvio;',
  '  = %Q0.0;',
  'END_FUNCTION_BLOCK',
  '',
  'DATA_BLOCK "Dati"',
  'STRUCT',
  '  Giri : Int;',
  'END_STRUCT;',
  'BEGIN',
  'END_DATA_BLOCK',
  '',
].join('\n');

const BAD = [
  'FUNCTION_BLOCK "Prova"',
  'TITLE =',
  'VERSION : 0.1',
  '',
  'VAR_INPUT',
  '  Avvio : Bool;',
  'END_VAR',
  '',
  'BEGIN',
  'NETWORK',
  'TITLE =',
  '    FOO %I0.0;',
  '    A %I0.2;',
  'END_FUNCTION_BLOCK',
  '',
].join('\n');

async function setup(sources: { name: string; text: string }[] = []) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addSource', (p) => {
      const d = findDevice(p, PLC)!;
      sources.forEach((s, i) => d.sources.push({ id: `src${i}`, name: s.name, text: s.text }));
    });
  });
  // La cronologia riparte da zero: i passi contati sono solo quelli dell'operazione.
  act(() => app.store.getState().setDoc(app.store.getState().doc));
  return app;
}
const menuOf = async (app: RenderedApp, nodeId: string) => {
  await app.user.pointer({ keys: '[MouseRight]', target: tn(nodeId) });
};
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name });

describe('Sorgenti esterne: aggiungere file', () => {
  it(
    'Aggiungi nuovo file esterno: due file, Windows-1252 decodificato, un passo di annulla',
    async () => {
      const app = await setup();
      // "è" in Windows-1252 è il solo byte 0xE8 (non UTF-8 valido).
      app.bridge.files.set('/f/Uno.awl', new Uint8Array([0x63, 0x61, 0x66, 0x66, 0xe8]));
      app.bridge.files.set('/f/Due.awl', bytes('// due\r\n'));
      app.bridge.openFileResults.push(['/f/Uno.awl', '/f/Due.awl']);
      await app.user.dblClick(tn(ids.folder(PLC, 'sources-add')));
      await waitFor(() => expect(dev(app).sources).toHaveLength(2));
      expect(app.bridge.openFileCalls).toEqual([
        { filters: [{ name: 'Sorgente AWL (*.awl)', extensions: ['awl'] }], multi: true },
      ]);
      expect(dev(app).sources.map((s) => [s.name, s.text])).toEqual([
        ['Uno.awl', 'caffè'],
        ['Due.awl', '// due\r\n'],
      ]);
      expect(past(app)).toBe(1);
      expect(tn(ids.source(PLC, dev(app).sources[0]!.id))).toHaveTextContent('Uno.awl');
      act(() => app.store.getState().undo());
      expect(dev(app).sources).toHaveLength(0);
    },
    T,
  );

  it(
    'un nome già presente diventa Uno_1.awl; un file illeggibile è saltato con un errore in Informazioni',
    async () => {
      const app = await setup([{ name: 'Uno.awl', text: 'x' }]);
      app.bridge.files.set('/f/Uno.awl', bytes('y'));
      app.bridge.files.set('/f/Tre.awl', bytes('z'));
      app.bridge.openFileResults.push(['/f/Uno.awl', '/f/Manca.awl', '/f/Tre.awl']);
      await app.user.dblClick(tn(ids.folder(PLC, 'sources-add')));
      await waitFor(() => expect(dev(app).sources).toHaveLength(3));
      expect(dev(app).sources.map((s) => s.name)).toEqual(['Uno.awl', 'Uno_1.awl', 'Tre.awl']);
      const errs = app.store.getState().messages.filter((m) => m.severity === 'error');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.params!['name']).toBe('Manca.awl');
      expect(past(app)).toBe(1);
    },
    T,
  );

  it(
    'la finestra di scelta dei file fallisce: errore in Informazioni, niente cambia',
    async () => {
      const app = await setup();
      app.bridge.showOpenFileDialog = () => Promise.reject(new Error('IPC rotto'));
      await app.user.dblClick(tn(ids.folder(PLC, 'sources-add')));
      await waitFor(() =>
        expect(app.store.getState().messages.map((m) => [m.severity, m.textKey])).toContainEqual([
          'error',
          'messages.fileDialogFailed',
        ]),
      );
      expect(app.store.getState().messages.at(-1)!.params).toMatchObject({ message: 'IPC rotto' });
      expect(dev(app).sources).toHaveLength(0);
      expect(past(app)).toBe(0);
    },
    T,
  );

  it(
    'dialogo annullato: niente cambia',
    async () => {
      const app = await setup();
      await app.user.dblClick(tn(ids.folder(PLC, 'sources-add')));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(dev(app).sources).toHaveLength(0);
      expect(past(app)).toBe(0);
    },
    T,
  );
});

describe('Sorgenti esterne: albero', () => {
  it(
    "rinomina ed eliminazione con le operazioni dell'albero; copia, taglia e incolla disattivati",
    async () => {
      const app = await setup([
        { name: 'A.awl', text: '' },
        { name: 'B.awl', text: '' },
      ]);
      const a = ids.source(PLC, 'src0');
      await app.user.click(tn(a));
      await menuOf(app, a);
      expect(item('Taglia')).toHaveAttribute('aria-disabled', 'true');
      expect(item('Copia')).toHaveAttribute('aria-disabled', 'true');
      expect(item('Incolla')).toHaveAttribute('aria-disabled', 'true');
      expect(item('Rinomina')).not.toHaveAttribute('aria-disabled', 'true');
      expect(item('Elimina')).not.toHaveAttribute('aria-disabled', 'true');
      await app.user.keyboard('{Escape}');
      // Non si trascina.
      expect(tn(a)).not.toHaveAttribute('draggable');
      // Rinomina in linea; un nome già usato non è accettato.
      await app.user.click(tn(a));
      await app.user.keyboard('{F2}');
      const input = await within(tn(a)).findByRole('textbox');
      await app.user.clear(input);
      await app.user.type(input, 'b.awl{Enter}');
      expect(dev(app).sources[0]!.name).toBe('A.awl');
      expect(screen.getByText('Il nome è già in uso.')).toBeInTheDocument();
      await app.user.clear(input);
      await app.user.type(input, 'Nuova.awl{Enter}');
      expect(dev(app).sources[0]!.name).toBe('Nuova.awl');
      expect(past(app)).toBe(1);
      // Eliminazione con conferma.
      await app.user.click(tn(a));
      await app.user.keyboard('{Delete}');
      await waitFor(() => expect(dev(app).sources.map((s) => s.name)).toEqual(['B.awl']));
      expect(app.bridge.questions.at(-1)!.message).toContain('Nuova.awl');
      expect(past(app)).toBe(2);
    },
    T,
  );

  it(
    'Mod+A seleziona anche le sorgenti: si eliminano tutte insieme',
    async () => {
      const app = await setup([
        { name: 'A.awl', text: 'a' },
        { name: 'B.awl', text: 'b' },
      ]);
      await app.user.click(tn(ids.source(PLC, 'src0')));
      await app.user.keyboard('{Control>}a{/Control}');
      await app.user.keyboard('{Delete}');
      await waitFor(() => expect(dev(app).sources).toHaveLength(0));
      const msg = app.bridge.questions.at(-1)!.message;
      expect(msg).toContain('A.awl');
      expect(msg).toContain('B.awl');
      expect(past(app)).toBe(1);
    },
    T,
  );

  it(
    "doppio clic su una sorgente apre l'editor con il testo",
    async () => {
      const app = await setup([{ name: 'A.awl', text: 'FUNCTION_BLOCK "X"\nBEGIN\n' }]);
      await app.user.dblClick(tn(ids.source(PLC, 'src0')));
      const box = await screen.findByRole('textbox', { name: 'Sorgente A.awl' });
      const view = EditorView.findFromDOM(box.closest('.cm-editor') as HTMLElement)!;
      expect(view.state.doc.toString()).toBe('FUNCTION_BLOCK "X"\nBEGIN\n');
      // Parole chiave della sorgente evidenziate.
      expect(view.dom.querySelector('.baa-awl-keyword')?.textContent).toBe('FUNCTION_BLOCK');
    },
    T,
  );
});

describe('Genera blocchi dalla sorgente', () => {
  it(
    'crea UDT, FB e DB in un solo passo; la seconda volta chiede conferma, sostituisce e riassume',
    async () => {
      const app = await setup([{ name: 'M.awl', text: SRC }]);
      const s = ids.source(PLC, 'src0');
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(dev(app).blocks.some((b) => b.name === 'Motore')).toBe(true));
      expect(dev(app).udts.map((u) => u.name)).toEqual(['Asse']);
      expect(dev(app).blocks.filter((b) => b.name === 'Dati')).toHaveLength(1);
      expect(past(app)).toBe(1);
      expect(app.store.getState().history.past[0]!.labelKey).toBe('history.applySource');
      act(() => app.store.getState().undo());
      expect(dev(app).blocks.some((b) => b.name === 'Motore')).toBe(false);
      expect(dev(app).udts).toHaveLength(0);
      act(() => app.store.getState().redo());
      expect(app.bridge.questions).toHaveLength(0);
      const last = app.store.getState().messages.at(-1)!;
      expect(last.textKey).toBe('messages.sourceApplied');
      expect(last.params).toMatchObject({ name: 'M.awl', created: '3', replaced: '0' });
      const idMotore = dev(app).blocks.find((b) => b.name === 'Motore')!.id;

      // Seconda volta: sostituisce, dopo domanda con l'elenco.
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(app.bridge.questions).toHaveLength(1));
      const msg = app.bridge.questions[0]!.message;
      for (const n of ['Asse', 'Motore', 'Dati']) expect(msg).toContain(n);
      await waitFor(() => expect(past(app)).toBe(2));
      expect(dev(app).blocks.find((b) => b.name === 'Motore')!.id).toBe(idMotore);
      expect(app.store.getState().messages.at(-1)!.params).toMatchObject({
        created: '0',
        replaced: '3',
      });
      // Un solo passo: un annulla toglie la sostituzione, non la creazione.
      act(() => app.store.getState().undo());
      expect(past(app)).toBe(1);
      expect(dev(app).blocks.some((b) => b.name === 'Motore')).toBe(true);
    },
    T,
  );

  it(
    "il progetto cambia mentre si conferma: se cambia l'elenco da sostituire non si applica",
    async () => {
      const app = await setup([{ name: 'M.awl', text: SRC }]);
      const s = ids.source(PLC, 'src0');
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(past(app)).toBe(1));
      const ask = app.bridge.askQuestion.bind(app.bridge);
      app.bridge.askQuestion = async (q) => {
        // Durante la domanda il DB "Dati" sparisce (ad esempio da un'altra finestra).
        app.store.getState().edit('history.delete', (p) => {
          const d = findDevice(p, PLC)!;
          d.blocks = d.blocks.filter((b) => b.name !== 'Dati');
        });
        return ask(q);
      };
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() =>
        expect(app.store.getState().messages.at(-1)!.textKey).toBe('messages.sourceReplaceChanged'),
      );
      // Solo la cancellazione fatta durante la domanda: la sorgente non è applicata.
      expect(past(app)).toBe(2);
      expect(dev(app).blocks.some((b) => b.name === 'Dati')).toBe(false);
      expect(app.store.getState().history.past.at(-1)!.labelKey).toBe('history.delete');
    },
    T,
  );

  it(
    'una sorgente che non crea e non sostituisce niente: nessun passo e nessun riepilogo',
    async () => {
      const app = await setup([{ name: 'Vuota.awl', text: '// solo un commento\n' }]);
      await menuOf(app, ids.source(PLC, 'src0'));
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(past(app)).toBe(0);
      expect(
        app.store.getState().messages.some((m) => m.textKey === 'messages.sourceApplied'),
      ).toBe(false);
    },
    T,
  );

  it(
    'risposta "no": niente cambia',
    async () => {
      const app = await setup([{ name: 'M.awl', text: SRC }]);
      const s = ids.source(PLC, 'src0');
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(past(app)).toBe(1));
      const before = app.store.getState().doc!.project;
      app.bridge.questionAnswers.push(false);
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(app.bridge.questions).toHaveLength(1));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(app.store.getState().doc!.project).toBe(before);
      expect(past(app)).toBe(1);
    },
    T,
  );

  it(
    'sorgente con errore: niente cambia, gli errori vanno in Informazioni con riga e colonna e un clic apre la sorgente nel punto',
    async () => {
      const app = await setup([{ name: 'Prova.awl', text: BAD }]);
      const s = ids.source(PLC, 'src0');
      const before = app.store.getState().doc!.project;
      await menuOf(app, s);
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() =>
        expect(app.store.getState().messages.some((m) => m.severity === 'error')).toBe(true),
      );
      expect(app.store.getState().doc!.project).toBe(before);
      expect(past(app)).toBe(0);
      await app.user.click(screen.getByTestId('inspector-tab-info'));
      const row = screen
        .getAllByTestId('info-row')
        .find((r) => within(r).queryByTestId('severity-error'))!;
      expect(row).toHaveTextContent(
        /^.*Sorgente Prova\.awl, riga 12, colonna \d+: Istruzione sconosciuta/,
      );
      await app.user.click(within(row).getByRole('button'));
      const box = await screen.findByRole('textbox', { name: 'Sorgente Prova.awl' });
      const view = EditorView.findFromDOM(box.closest('.cm-editor') as HTMLElement)!;
      await waitFor(() => expect(view.hasFocus).toBe(true));
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(12);
      expect(view.state.doc.sliceString(head, head + 3)).toBe('FOO');
    },
    T,
  );

  it(
    "la bozza nell'editor conta: si conferma prima di generare",
    async () => {
      const app = await setup([{ name: 'M.awl', text: '' }]);
      await app.user.dblClick(tn(ids.source(PLC, 'src0')));
      const box = await screen.findByRole('textbox', { name: 'Sorgente M.awl' });
      const view = EditorView.findFromDOM(box.closest('.cm-editor') as HTMLElement)!;
      act(() => view.contentDOM.focus());
      act(() => view.dispatch({ changes: { from: 0, insert: SRC } }));
      expect(dev(app).sources[0]!.text).toBe('');
      await menuOf(app, ids.source(PLC, 'src0'));
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(dev(app).blocks.some((b) => b.name === 'Motore')).toBe(true));
      expect(dev(app).sources[0]!.text).toBe(SRC);
    },
    T,
  );

  it(
    'un OB che porta il nome di un OB rinominato lo sostituisce senza errori',
    async () => {
      const app = await setup([
        {
          name: 'O.awl',
          text: 'ORGANIZATION_BLOCK "Zyx"\nBEGIN\nNETWORK\nTITLE =\n  NOP 0;\nEND_ORGANIZATION_BLOCK\n',
        },
      ]);
      act(() =>
        app.store.getState().edit('history.rename', (p) => {
          const ob = findDevice(p, PLC)!.blocks.find((b) => b.kind === 'OB')!;
          ob.name = 'Zyx';
        }),
      );
      act(() => app.store.getState().setDoc(app.store.getState().doc));
      await menuOf(app, ids.source(PLC, 'src0'));
      await app.user.click(item('Genera blocchi dalla sorgente'));
      await waitFor(() => expect(app.bridge.questions).toHaveLength(1));
      await waitFor(() => expect(past(app)).toBe(1));
      expect(dev(app).blocks.filter((b) => b.kind === 'OB')).toHaveLength(1);
    },
    T,
  );
});

describe('Genera blocchi: ultima difesa', () => {
  it(
    "se applySource lancia, il progetto resta com'era e compare un errore (nessun crash)",
    async () => {
      const app = await setup([{ name: 'M.awl', text: SRC }]);
      const before = app.store.getState().doc!.project;
      // La prima chiamata è la prova a vuoto, la seconda è la vera applicazione.
      guard.calls = 0;
      guard.failAt = 2;
      try {
        await menuOf(app, ids.source(PLC, 'src0'));
        await app.user.click(item('Genera blocchi dalla sorgente'));
        await waitFor(() =>
          expect(app.store.getState().messages.some((m) => m.severity === 'error')).toBe(true),
        );
      } finally {
        guard.failAt = 0;
      }
      expect(app.store.getState().doc!.project).toBe(before);
      expect(past(app)).toBe(0);
      expect(app.store.getState().messages.at(-1)!.textKey).toBe('messages.sourceApplyFailed');
    },
    T,
  );
});

describe('Genera sorgente dai blocchi ed Esporta', () => {
  it(
    'dal blocco: Nastro.awl nuova, selezionata e aperta, un passo; poi Esporta scrive BOM e CRLF',
    async () => {
      const app = await setup();
      let id = '';
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          const b = createCodeBlock({ kind: 'FC', number: 3, name: 'Nastro', language: 'AWL' });
          (b as CodeBlock).networks[0]!.source = 'A I 0.0\n= Q 0.0';
          findDevice(p, PLC)!.blocks.push(b);
          id = b.id;
        });
      });
      act(() => app.store.getState().setDoc(app.store.getState().doc));
      await menuOf(app, ids.block(PLC, id));
      await app.user.click(item('Genera sorgente dai blocchi'));
      await waitFor(() => expect(dev(app).sources).toHaveLength(1));
      const src = dev(app).sources[0]!;
      expect(src.name).toBe('Nastro.awl');
      expect(src.text).toContain('FUNCTION "Nastro"');
      expect(past(app)).toBe(1);
      expect(app.store.getState().history.past[0]!.labelKey).toBe('history.generateSource');
      expect(app.store.getState().selection).toBe(ids.source(PLC, src.id));
      expect(
        app.store
          .getState()
          .workArea.editors.some((e) => e.kind === 'source' && e.objectId === src.id),
      ).toBe(true);

      // Una seconda generazione non sovrascrive: Nastro_1.awl.
      await menuOf(app, ids.block(PLC, id));
      await app.user.click(item('Genera sorgente dai blocchi'));
      await waitFor(() => expect(dev(app).sources).toHaveLength(2));
      expect(dev(app).sources[1]!.name).toBe('Nastro_1.awl');

      app.bridge.saveFileResults.push('/out/Nastro.awl');
      await menuOf(app, ids.source(PLC, src.id));
      await app.user.click(item('Esporta…'));
      await waitFor(() => expect(app.bridge.files.has('/out/Nastro.awl')).toBe(true));
      expect(app.bridge.saveFileCalls).toEqual([
        {
          defaultName: 'Nastro.awl',
          filters: [{ name: 'Sorgente AWL (*.awl)', extensions: ['awl'] }],
        },
      ]);
      const out = app.bridge.files.get('/out/Nastro.awl')!;
      expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(out.subarray(3));
      expect(text).toContain('\r\n');
      expect(text.replace(/\r\n/g, '\n')).toBe(src.text.replace(/\r\n/g, '\n'));
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    },
    T,
  );

  it(
    'dalla cartella "Blocchi di programma" tutti i blocchi, dalla cartella dei tipi tutti gli UDT',
    async () => {
      const app = await setup();
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          findDevice(p, PLC)!.blocks.push(
            createCodeBlock({ kind: 'FC', number: 3, name: 'Zeta', language: 'AWL' }),
          );
        });
      });
      act(() => app.store.getState().setDoc(app.store.getState().doc));
      await menuOf(app, ids.folder(PLC, 'blocks'));
      await app.user.click(item('Genera sorgente dai blocchi'));
      await waitFor(() => expect(dev(app).sources).toHaveLength(1));
      const text = dev(app).sources[0]!.text;
      expect(text).toContain('FUNCTION "Zeta"');
      expect(text).toContain('ORGANIZATION_BLOCK');
      // La cartella dei tipi è vuota: la voce c'è ma è disattivata.
      await menuOf(app, ids.folder(PLC, 'types'));
      expect(item('Genera sorgente dai blocchi')).toHaveAttribute('aria-disabled', 'true');
    },
    T,
  );

  it(
    'avvisi in Informazioni: valori iniziali composti non scritti e blocchi non AWL non esportati',
    async () => {
      const app = await setup();
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          const fb = createCodeBlock({ kind: 'FB', number: 4, name: 'Misura', language: 'AWL' });
          fb.interface.static.push(
            { id: 's1', name: 'T1', type: '"TON"', comment: '', overrides: { '.PT': 'T#5S' } },
            {
              id: 's2',
              name: 'Lista',
              type: 'Array[1..3] of Int',
              comment: '',
              overrides: { '[1]': '7' },
            },
          );
          const scl = createCodeBlock({ kind: 'FC', number: 5, name: 'Calcolo', language: 'FUP' });
          findDevice(p, PLC)!.blocks.push(fb, scl);
        });
      });
      act(() => app.store.getState().setDoc(app.store.getState().doc));
      await menuOf(app, ids.folder(PLC, 'blocks'));
      await app.user.click(item('Genera sorgente dai blocchi'));
      await waitFor(() => expect(dev(app).sources).toHaveLength(1));
      expect(dev(app).sources[0]!.text).not.toContain('"Calcolo"');
      const warnings = app.store.getState().messages.filter((m) => m.severity === 'warning');
      expect(warnings.map((m) => [m.textKey, m.params])).toEqual([
        ['messages.sourceStartValuesSkipped', { name: 'Misura', members: 'T1, Lista' }],
        ['messages.sourceLanguageSkipped', { name: 'Calcolo', language: 'FUP' }],
      ]);
      expect(app.store.getState().inspectorTab).toBe('info');
    },
    T,
  );

  it(
    'la bozza nel codice di un segmento conta: si conferma prima di generare la sorgente',
    async () => {
      const app = await setup();
      let id = '';
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          const b = createCodeBlock({ kind: 'FC', number: 3, name: 'Nastro', language: 'AWL' });
          (b as CodeBlock).networks[0]!.source = 'NOP 0';
          findDevice(p, PLC)!.blocks.push(b);
          id = b.id;
        });
      });
      act(() => app.store.getState().setDoc(app.store.getState().doc));
      await app.user.dblClick(tn(ids.block(PLC, id)));
      const box = await screen.findByRole('textbox', { name: 'Codice del segmento 1' });
      const view = EditorView.findFromDOM(box.closest('.cm-editor') as HTMLElement)!;
      act(() => view.contentDOM.focus());
      act(() =>
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'NOP 1' } }),
      );
      const stored = () =>
        (dev(app).blocks.find((b) => b.id === id) as CodeBlock).networks[0]!.source;
      expect(stored()).toBe('NOP 0');
      // Senza passare dal menu (che sposta il focus): il fuoco resta nell'editor.
      expect(view.hasFocus).toBe(true);
      act(() => {
        generateSourceFromNodes(
          { store: app.store, bridge: app.bridge },
          [ids.block(PLC, id)],
          'international',
        );
      });
      await waitFor(() => expect(dev(app).sources).toHaveLength(1));
      expect(stored()).toBe('NOP 1');
      expect(dev(app).sources[0]!.text).toContain('\tNOP 1;');
    },
    T,
  );

  it(
    'Esporta con la finestra annullata o con un errore di scrittura',
    async () => {
      const app = await setup([{ name: 'A.awl', text: 'x' }]);
      const a = ids.source(PLC, 'src0');
      await menuOf(app, a);
      await app.user.click(item('Esporta…'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(app.bridge.files.has('/out/A.awl')).toBe(false);
      expect(app.store.getState().messages.some((m) => m.severity === 'error')).toBe(false);
      app.bridge.saveFileResults.push('/out/A.awl');
      app.bridge.failNextWrite('EACCES');
      await menuOf(app, a);
      await app.user.click(item('Esporta…'));
      await waitFor(() =>
        expect(app.store.getState().messages.some((m) => m.severity === 'error')).toBe(true),
      );
    },
    T,
  );
});

describe('Blocchi di sistema', () => {
  it(
    'elenca TON e READ_CLK richiamati, in sola lettura, con Nome, Numero e Tipo',
    async () => {
      const app = await setup();
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          const b = createCodeBlock({ kind: 'FC', number: 3, name: 'Orologio', language: 'AWL' });
          (b as CodeBlock).networks = [
            { id: 'n1', title: '', comment: '', source: 'CALL "TON", DB1\n  IN := M0.0' },
            { id: 'n2', title: '', comment: '', source: 'CALL SFC 1' },
          ];
          findDevice(p, PLC)!.blocks.push(b);
        });
      });
      act(() => app.store.getState().setDoc(app.store.getState().doc));
      const folder = ids.folder(PLC, 'system-blocks');
      const ton = ids.sysBlock(PLC, 'SFB4');
      const clk = ids.sysBlock(PLC, 'SFC1');
      expect(tn(ton)).toHaveTextContent('TON [SFB4]');
      expect(tn(clk)).toHaveTextContent('READ_CLK [SFC1]');
      await app.user.click(tn(folder));
      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Nome',
        'Numero',
        'Tipo',
      ]);
      const rows = screen.getAllByTestId('details-row').map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent?.trim()),
      );
      expect(rows).toEqual([
        ['READ_CLK', '1', 'SFC'],
        ['TON', '4', 'SFB'],
      ]);
      // Sola lettura: nessuna rinomina, eliminazione o copia; aprirlo non fa nulla.
      await app.user.click(tn(ton));
      await menuOf(app, ton);
      for (const n of ['Taglia', 'Copia', 'Incolla', 'Elimina', 'Rinomina'])
        expect(item(n)).toHaveAttribute('aria-disabled', 'true');
      await app.user.keyboard('{Escape}');
      await app.user.dblClick(tn(ton));
      expect(app.store.getState().workArea.editors).toHaveLength(0);
      expect(past(app)).toBe(0);
    },
    T,
  );

  it(
    'cresce con il codice: una chiamata in più compare, una tolta sparisce',
    async () => {
      const app = await setup();
      let id = '';
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          const b = createCodeBlock({ kind: 'FC', number: 3, name: 'Orologio', language: 'AWL' });
          id = b.id;
          findDevice(p, PLC)!.blocks.push(b);
        });
      });
      const ton = ids.sysBlock(PLC, 'SFB4');
      expect(screen.queryByTestId(`tree-node-${ton}`)).toBeNull();
      act(() =>
        app.store.getState().edit('history.editNetworkCode', (p) => {
          (findDevice(p, PLC)!.blocks.find((b) => b.id === id) as CodeBlock).networks[0]!.source =
            'CALL "TON", DB1';
        }),
      );
      expect(tn(ton)).toBeInTheDocument();
      act(() => app.store.getState().undo());
      expect(screen.queryByTestId(`tree-node-${ton}`)).toBeNull();
    },
    T,
  );
});

describe('Un passo di annulla per azione', () => {
  it(
    'modifica nell\'editor: un passo, "Modifica sorgente"',
    async () => {
      const app = await setup([{ name: 'A.awl', text: 'a' }]);
      await app.user.dblClick(tn(ids.source(PLC, 'src0')));
      const box = await screen.findByRole('textbox', { name: 'Sorgente A.awl' });
      const view = EditorView.findFromDOM(box.closest('.cm-editor') as HTMLElement)!;
      act(() => view.contentDOM.focus());
      act(() => view.dispatch({ changes: { from: 1, insert: 'b' } }));
      act(() => view.dispatch({ changes: { from: 2, insert: 'c' } }));
      act(() => view.contentDOM.blur());
      expect(dev(app).sources[0]!.text).toBe('abc');
      expect(past(app)).toBe(1);
      expect(app.store.getState().history.past[0]!.labelKey).toBe('history.editSource');
      fireEvent.focus(view.contentDOM);
    },
    T,
  );
});
