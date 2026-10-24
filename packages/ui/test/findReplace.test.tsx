import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTagTable, type CodeBlock } from '@baaportal/project';
import { dev, fb, openEditor, PLC } from './blockFixtures';
import type { RenderedApp } from './renderApp';

function netBlock(name: string, sources: string[]): CodeBlock {
  const b = fb(name);
  b.networks = sources.map((source, i) => ({
    id: `${name}-n${i}`,
    title: '',
    comment: '',
    source,
  }));
  return b;
}

async function setup(): Promise<RenderedApp> {
  const a = netBlock('A', ['L MW10\nT MW12', 'NOP 0']);
  const b = netBlock('B', ['L MW10']);
  const c = netBlock('C', ['L MW10']);
  return openEditor('block', a.id, (d) => {
    d.blocks.push(a, b, c);
  });
}

const blocksText = (app: RenderedApp) =>
  dev(app).blocks.flatMap((b) =>
    b.kind === 'DB' || b.kind === 'IDB' ? [] : b.networks.map((n) => n.source),
  );

const findInput = () => screen.getByRole('textbox', { name: 'Trova' });

async function search(app: RenderedApp, text: string) {
  act(() => app.store.getState().setTaskCard('tasks'));
  await app.user.clear(findInput());
  await app.user.type(findInput(), text);
  await app.user.click(screen.getByRole('button', { name: 'Trova' }));
}

describe('Trova e sostituisci', () => {
  it('Ctrl+F apre la task card col fuoco su Trova', async () => {
    const app = await setup();
    expect(app.store.getState().taskCard).toBe('instructions');
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(findInput()).toHaveFocus());
    expect(app.store.getState().taskCard).toBe('tasks');
  });

  it('cerca "MW10" in tutto il progetto → 3 risultati raggruppati per blocco', async () => {
    const app = await setup();
    await search(app, 'MW10');
    expect(screen.getByText('3 risultati')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Risultati' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByText('A')).toBeInTheDocument();
    expect(within(list).getByText('B')).toBeInTheDocument();
    expect(within(list).getByText('C')).toBeInTheDocument();
  });

  it('clic su un risultato apre il blocco con la selezione sul testo', async () => {
    const app = await setup();
    act(() => app.store.getState().closeAllEditors());
    await search(app, 'MW10');
    const list = screen.getByRole('list', { name: 'Risultati' });
    await app.user.click(within(list).getAllByRole('button')[1]!);
    const ws = app.store.getState().workArea;
    expect(
      ws.editors.some((e) => e.objectId === dev(app).blocks.find((b) => b.name === 'B')!.id),
    ).toBe(true);
    await waitFor(() => expect(window.getSelection()?.toString()).toBe('MW10'));
  });

  it('Sostituisci tutto → testo cambiato in 3 blocchi; un Ctrl+Z ripristina tutti e 3', async () => {
    const app = await setup();
    const before = blocksText(app);
    const past = app.store.getState().history.past.length;
    await search(app, 'MW10');
    await app.user.type(screen.getByRole('textbox', { name: 'Sostituisci con' }), 'MW20');
    await app.user.click(screen.getByRole('button', { name: 'Sostituisci tutto' }));
    expect(blocksText(app).filter((s) => s.includes('MW20'))).toHaveLength(3);
    expect(blocksText(app).some((s) => s.includes('MW10'))).toBe(false);
    expect(app.store.getState().history.past.length).toBe(past + 1);
    expect(app.store.getState().messages.at(-1)?.params).toEqual({ replaced: '3', skipped: '0' });
    act(() => app.store.getState().undo());
    expect(blocksText(app)).toEqual(before);
  });

  it('casella Ricerca della barra + Invio apre la task card e cerca', async () => {
    const app = await setup();
    await app.user.type(screen.getByRole('searchbox', { name: 'Ricerca' }), 'MW10{Enter}');
    expect(app.store.getState().taskCard).toBe('tasks');
    expect(await screen.findByText('3 risultati')).toBeInTheDocument();
  });

  it('dopo una modifica i risultati sono segnati non aggiornati e Sostituisci è disattivato', async () => {
    const app = await setup();
    await search(app, 'MW10');
    expect(screen.getByRole('button', { name: 'Sostituisci' })).toBeEnabled();
    act(() => {
      app.store.getState().edit('history.addRow', (p) => {
        p.devices.find((d) => d.id === PLC)!.tagTables.push(createTagTable('Nuova'));
      });
    });
    expect(screen.getByText('Risultati non aggiornati, ripeti la ricerca')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sostituisci' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sostituisci tutto' })).toBeDisabled();
  });

  it('regex non valida → messaggio sotto il campo, nessuna eccezione', async () => {
    const app = await setup();
    act(() => app.store.getState().setTaskCard('tasks'));
    await app.user.click(screen.getByRole('checkbox', { name: 'Espressione regolare' }));
    await search(app, '(');
    expect(await screen.findByRole('alert')).toHaveTextContent('Espressione regolare non valida');
  });

  it('un risultato non modificabile è grigio con il motivo nel suggerimento', async () => {
    const prot = netBlock('P', ['NOP 0']);
    prot.knowHowProtected = true;
    prot.header.title = 'MW10 titolo';
    const a = netBlock('A', ['L MW10']);
    const app = await openEditor('block', a.id, (d) => {
      d.blocks.push(prot, a);
    });
    await search(app, 'MW10');
    const hit = screen.getByRole('button', { name: /MW10 titolo/ });
    expect(hit).toHaveClass('is-readonly');
    expect(hit).toHaveAttribute('title', 'Blocco protetto: il testo non si può modificare.');
  });

  it('sorgente con a capo CRLF: la selezione cade sui caratteri giusti', async () => {
    const app = await openEditor('block', 'none', (d) => {
      d.sources.push({ id: 'src1', name: 'S', text: 'riga uno\r\nriga MW10 due\r\nMW10' });
    });
    await search(app, 'MW10');
    const list = screen.getByRole('list', { name: 'Risultati' });
    await app.user.click(within(list).getAllByRole('button')[1]!);
    await waitFor(() => expect(window.getSelection()?.toString()).toBe('MW10'));
    const view = document.querySelector<HTMLElement>('.baa-source-editor .cm-content')!;
    expect([...view.querySelectorAll('.cm-line')].map((l) => l.textContent)).toEqual([
      'riga uno',
      'riga MW10 due',
      'MW10',
    ]);
    expect(window.getSelection()?.anchorNode?.parentElement?.textContent).toContain('MW10');
  });

  it('aprire un altro documento azzera la ricerca', async () => {
    const app = await setup();
    await search(app, 'MW10');
    expect(app.store.getState().find.outcome).not.toBeNull();
    act(() => app.store.getState().setDoc(null));
    const s = app.store.getState();
    expect(s.find.outcome).toBeNull();
    expect(s.find.query).toBe('');
    expect(s.findRequest).toBeNull();
    expect(s.tagReveal).toBeNull();
  });

  it("Ctrl+F dentro l'editor di codice dà il fuoco a Trova con il testo selezionato", async () => {
    await setup();
    const content = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLElement>('.cm-content')].find((c) =>
        c.textContent?.includes('MW10'),
      );
      expect(el).toBeDefined();
      return el!;
    });
    content.focus();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let textNode: Node | null = walker.nextNode();
    while (textNode && !textNode.textContent?.includes('MW10')) textNode = walker.nextNode();
    const at = textNode!.textContent!.indexOf('MW10');
    const range = document.createRange();
    range.setStart(textNode!, at);
    range.setEnd(textNode!, at + 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const picked = window.getSelection()!.toString();
    fireEvent.keyDown(content, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(findInput()).toHaveFocus());
    await new Promise((r) => setTimeout(r, 20));
    expect(findInput()).toHaveFocus();
    expect((findInput() as HTMLInputElement).value).toBe(picked);
  });

  it('Sostituisci sul risultato selezionato lo sostituisce e passa al successivo', async () => {
    const app = await setup();
    await search(app, 'MW10');
    const list = screen.getByRole('list', { name: 'Risultati' });
    await app.user.click(within(list).getAllByRole('button')[1]!);
    await app.user.type(screen.getByRole('textbox', { name: 'Sostituisci con' }), 'MW20');
    await app.user.click(screen.getByRole('button', { name: 'Sostituisci' }));
    const texts = blocksText(app);
    expect(texts.filter((x) => x.includes('MW20'))).toHaveLength(1);
    expect(texts.filter((x) => x.includes('MW10'))).toHaveLength(2);
    expect(app.store.getState().find.selected).toBe(1);
    expect(app.store.getState().find.outcome).toMatchObject({ hits: [{}, {}] });
  });

  it('Sostituisci su un risultato non modificabile lo salta e passa al successivo', async () => {
    const prot = netBlock('P', ['NOP 0']);
    prot.knowHowProtected = true;
    prot.header.title = 'MW10 titolo';
    const a = netBlock('A', ['L MW10']);
    const app = await openEditor('block', a.id, (d) => {
      d.blocks.push(prot, a);
    });
    await search(app, 'MW10');
    expect(app.store.getState().find.selected).toBe(0);
    await app.user.click(screen.getByRole('button', { name: 'Sostituisci' }));
    expect(app.store.getState().find.selected).toBe(1);
    expect(app.store.getState().messages.at(-1)?.params).toEqual({ replaced: '0', skipped: '1' });
  });

  it("l'ambito Editor attivo è disattivato senza editor aperto", async () => {
    const app = await setup();
    act(() => {
      app.store.getState().closeAllEditors();
      app.store.getState().setTaskCard('tasks');
    });
    expect(screen.getByRole('option', { name: 'Editor attivo' })).toBeDisabled();
  });
});
