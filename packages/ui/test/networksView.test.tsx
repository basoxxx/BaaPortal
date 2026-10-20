import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { setDiagnostics } from '@codemirror/lint';
import { createCodeBlock, readBaap, type CodeBlock } from '@baaportal/project';
import { dev, fb, mem, openEditor, past } from './blockFixtures';
import { PROJECT_PATH, type RenderedApp } from './renderApp';

// Conta quante volte un editor riapplica le diagnostiche.
vi.mock('@codemirror/lint', async (orig) => {
  const real = await orig<typeof import('@codemirror/lint')>();
  return { ...real, setDiagnostics: vi.fn(real.setDiagnostics) };
});

const T = 30_000;
const block = (app: RenderedApp, id: string) =>
  dev(app).blocks.find((b) => b.id === id) as CodeBlock;
const textbox = (n = 1) => screen.getByRole('textbox', { name: `Codice del segmento ${n}` });
const viewOf = (n = 1) => EditorView.findFromDOM(textbox(n).closest('.cm-editor') as HTMLElement)!;
const set = (view: EditorView, text: string) =>
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
const focus = (view: EditorView) => act(() => view.contentDOM.focus());
async function app_deleteFirst() {
  fireEvent.click(screen.getByRole('button', { name: 'Menu del segmento 1' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Elimina segmento' }));
}
const mnemonicSelect = () => screen.getByRole('combobox', { name: 'Mnemonica' });
// Aspetta che le diagnostiche iniziali siano finite: il conteggio resta fermo per `quiet` ms.
// Un'attesa fissa non basta sui runner lenti (Windows nella CI).
async function diagnosticsSettled(quiet = 500, max = 15_000) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < max) {
    const n = vi.mocked(setDiagnostics).mock.calls.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, quiet));
  }
}

describe("segmenti AWL con l'editor CodeMirror", () => {
  it(
    "conferma all'uscita dal focus: un solo passo di annulla, testo salvato in internazionale",
    async () => {
      const f = fb('Nastro');
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      await app.user.selectOptions(mnemonicSelect(), 'german');
      const before = past(app);
      const v = viewOf();
      focus(v);
      set(v, 'U E 0.0');
      set(v, 'U E 0.1');
      expect(block(app, f.id).networks[0]!.source).toBe('');
      act(() => v.contentDOM.blur());
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.1');
      expect(past(app)).toBe(before + 1);
      expect(app.store.getState().history.past.at(-1)!.labelKey).toBe('history.editNetworkCode');
      act(() => app.store.getState().undo());
      expect(block(app, f.id).networks[0]!.source).toBe('');
      // L'annullamento del progetto aggiorna l'editor, che non ha il focus.
      expect(viewOf().state.doc.toString()).toBe('');
    },
    T,
  );

  it(
    "Mod+S dentro l'editor salva il testo appena scritto",
    async () => {
      const f = fb('Nastro');
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const v = viewOf();
      focus(v);
      set(v, 'A I 0.0');
      fireEvent.keyDown(v.contentDOM, { key: 's', ctrlKey: true });
      await waitFor(() => expect(app.store.getState().doc!.dirty).toBe(false));
      const saved = readBaap(app.bridge.files.get(PROJECT_PATH)!);
      const b = saved.devices[0]!.blocks.find((x) => x.id === f.id) as CodeBlock;
      expect(b.networks[0]!.source).toBe('A I 0.0');
    },
    T,
  );

  it(
    'chiudere la scheda con una bozza non la perde',
    async () => {
      const f = fb('Nastro');
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const v = viewOf();
      focus(v);
      set(v, 'A I 0.0');
      act(() => app.store.getState().closeEditor(app.store.getState().workArea.editors[0]!.key));
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.0');
    },
    T,
  );

  it(
    "Mod+Z dentro l'editor non annulla il progetto",
    async () => {
      const f = fb('Nastro');
      f.networks[0]!.source = 'A I 0.0';
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const v = viewOf();
      focus(v);
      set(v, 'A I 0.0\nA I 0.1');
      const before = past(app);
      fireEvent.keyDown(v.contentDOM, { key: 'z', ctrlKey: true });
      expect(past(app)).toBe(before);
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.0');
      // L'annulla è di CodeMirror: toglie la modifica del testo, il progetto non si muove.
      expect(v.state.doc.toString()).toBe('A I 0.0');
    },
    T,
  );

  it(
    'errori sottolineati ed elenco Problemi con clic che porta al punto',
    async () => {
      const f = fb('Nastro');
      f.networks[0]!.source = 'A I 0.0';
      f.networks.push({ id: 'n2', title: '', comment: '', source: '' });
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const v = viewOf(2);
      focus(v);
      set(v, 'A I 0.0\nA "Nope"');
      // Il controllo parte 250 ms dopo l'ultima modifica, sul testo non ancora confermato.
      const list = await screen.findByRole('list', { name: 'Problemi' });
      const row = await within(list).findByRole('button', {
        name: /Segmento 2, riga 2: Il simbolo "Nope" non esiste/,
      });
      expect(block(app, f.id).networks[1]!.source).toBe('');
      expect(viewOf(2).dom.querySelector('.cm-lintRange-error')!.textContent).toBe('"Nope"');
      act(() => viewOf(1).contentDOM.focus());
      await app.user.click(row);
      expect(viewOf(2).state.selection.main.head).toBe(10);
      expect(document.activeElement).toBe(viewOf(2).contentDOM);
    },
    T,
  );

  it(
    'cambio di mnemonica: la bozza si conferma e il codice salvato non cambia',
    async () => {
      const f = fb('Nastro');
      f.networks[0]!.source = 'A I 0.0';
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const before = past(app);
      await app.user.selectOptions(mnemonicSelect(), 'german');
      expect(viewOf().state.doc.toString()).toBe('U E 0.0');
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.0');
      expect(past(app)).toBe(before);
      expect(localStorage.getItem('baa.mnemonic')).toBe('german');
      const v = viewOf();
      focus(v);
      set(v, 'U E 0.5');
      await app.user.selectOptions(mnemonicSelect(), 'international');
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.5');
      expect(past(app)).toBe(before + 1);
      expect(viewOf().state.doc.toString()).toBe('A I 0.5');
      await app.user.selectOptions(mnemonicSelect(), 'german');
      expect(past(app)).toBe(before + 1);
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.5');
    },
    T,
  );

  it(
    'completamento dopo #',
    async () => {
      const f = fb('Nastro', { input: [mem('Motore', 'Bool')] });
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const v = viewOf();
      focus(v);
      set(v, 'A ');
      act(() =>
        v.dispatch({
          changes: { from: 2, insert: '#' },
          selection: { anchor: 3 },
          userEvent: 'input.type',
        }),
      );
      const opt = await waitFor(
        () => {
          const el = document.querySelector('.cm-tooltip-autocomplete li');
          expect(el).not.toBeNull();
          return el!;
        },
        { timeout: 5000 },
      );
      expect(opt.textContent).toContain('Motore');
      // Il completamento non tocca il progetto finché non si esce dal campo.
      expect(block(app, f.id).networks[0]!.source).toBe('');
    },
    T,
  );

  it(
    "i blocchi non AWL tengono l'area di testo del piano 1B",
    async () => {
      const k = createCodeBlock({ kind: 'FC', number: 5, name: 'Kop', language: 'KOP' });
      await openEditor('block', k.id, (d) => void d.blocks.push(k));
      expect(textbox().tagName).toBe('TEXTAREA');
      expect(textbox().parentElement).toHaveAttribute(
        'title',
        expect.stringContaining('blocchi AWL'),
      );
      expect(screen.queryByRole('combobox', { name: 'Mnemonica' })).toBeNull();
    },
    T,
  );

  it(
    'CRLF: gli errori cadono sui caratteri giusti',
    async () => {
      const f = fb('Nastro');
      f.networks[0]!.source = 'A I 0.0\r\nA "Nope"';
      await openEditor('block', f.id, (d) => void d.blocks.push(f));
      await waitFor(() => expect(viewOf().dom.querySelector('.cm-lintRange-error')).not.toBeNull());
      expect(viewOf().dom.querySelector('.cm-lintRange-error')!.textContent).toBe('"Nope"');
    },
    T,
  );

  it(
    'togliendo un segmento, la sottolineatura non passa al segmento che prende il suo posto',
    async () => {
      const f = fb('Nastro');
      f.networks = [
        { id: 'n0', title: '', comment: '', source: 'A "Nope"' },
        { id: 'n1', title: '', comment: '', source: 'A I 0.0\nA I 0.1' },
      ];
      await openEditor('block', f.id, (d) => void d.blocks.push(f));
      await waitFor(() =>
        expect(viewOf(1).dom.querySelector('.cm-lintRange-error')).not.toBeNull(),
      );
      await app_deleteFirst();
      // Subito, senza attendere il nuovo controllo: il segmento n1 non ha errori.
      expect(viewOf(1).state.doc.toString()).toBe('A I 0.0\nA I 0.1');
      expect(viewOf(1).dom.querySelector('.cm-lintRange-error')).toBeNull();
      expect(screen.queryByText(/Segmento 1, riga 1/)).toBeNull();
    },
    T,
  );

  it(
    'con 50 segmenti, scrivere in uno non rifà le diagnostiche negli altri',
    async () => {
      const f = fb('Nastro');
      f.networks = Array.from({ length: 50 }, (_, i) => ({
        id: `n${i}`,
        title: '',
        comment: '',
        source: 'A I 0.0',
      }));
      await openEditor('block', f.id, (d) => void d.blocks.push(f));
      await new Promise((r) => setTimeout(r, 400));
      await diagnosticsSettled();
      vi.mocked(setDiagnostics).mockClear();
      const v = viewOf(7);
      focus(v);
      for (let i = 0; i < 5; i++) set(v, `A I 0.${i}`);
      // Cinque tasti: nessun editor riapplica le diagnostiche.
      expect(vi.mocked(setDiagnostics)).not.toHaveBeenCalled();
      set(v, 'A "Nope"');
      await waitFor(() => expect(v.dom.querySelector('.cm-lintRange-error')).not.toBeNull());
      await new Promise((r) => setTimeout(r, 400));
      // Dopo il controllo si aggiorna il solo segmento con errori, non i 49 senza.
      expect(vi.mocked(setDiagnostics).mock.calls.length).toBeLessThanOrEqual(2);
    },
    T,
  );

  it(
    "un blocco eliminato con una bozza nell'editor: nessun errore",
    async () => {
      const f = fb('Nastro');
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const v = viewOf();
      focus(v);
      set(v, 'A I 0.0');
      act(() =>
        app.store.getState().edit('history.deleteBlock', (p) => {
          const d = p.devices[0]!;
          d.blocks = d.blocks.filter((b) => b.id !== f.id);
        }),
      );
      expect(dev(app).blocks.find((b) => b.id === f.id)).toBeUndefined();
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    },
    T,
  );

  it(
    'cambiare il linguaggio con una bozza la conferma prima',
    async () => {
      const f = fb('Nastro');
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      const v = viewOf();
      focus(v);
      set(v, 'A I 0.0');
      act(() =>
        app.store.getState().edit('history.editBlockHeader', (p) => {
          (p.devices[0]!.blocks.find((b) => b.id === f.id) as CodeBlock).language = 'KOP';
        }),
      );
      expect(block(app, f.id).networks[0]!.source).toBe('A I 0.0');
      expect(textbox().tagName).toBe('TEXTAREA');
    },
    T,
  );
});
