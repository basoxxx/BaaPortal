import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  createCodeBlock,
  createPlcDevice,
  createUdt,
  findDevice,
  type CodeBlock,
  type Tag,
} from '@baaportal/project';
import { findCpu } from '@baaportal/catalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Un tetto ai numeri FB permette di esaurirli senza creare migliaia di blocchi.
const cap = vi.hoisted(() => ({ maxFb: 0 }));
vi.mock('@baaportal/catalog', async (orig) => {
  const mod = await orig<typeof import('@baaportal/catalog')>();
  return {
    ...mod,
    findCpu: (id: string) => {
      const c = mod.findCpu(id);
      return c && cap.maxFb ? { ...c, limits: { ...c.limits, maxFb: cap.maxFb } } : c;
    },
  };
});
import { commands } from '../src/commands/commands';
import { ids } from '../src/project/navigation/treeIds';
import { forgetClipboard } from '../src/services/clipboard';
import { renderApp, type RenderedApp } from './renderApp';

const PLC = 'id1';
let n = 0;
const newId = () => `t${++n}`;

beforeEach(() => {
  n = 0;
  cap.maxFb = 0;
  forgetClipboard();
});

/** DataTransfer minimale: jsdom non lo implementa. */
function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none' as string,
    effectAllowed: 'all',
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    get types() {
      return [...data.keys()];
    },
  };
}

const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const history = (app: RenderedApp) => app.store.getState().history.past.length;

async function setup(extra?: (d: ReturnType<typeof dev>) => void) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  let fb!: CodeBlock;
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      const d = findDevice(p, PLC)!;
      fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL', newId });
      d.blocks.push(fb);
      extra?.(d);
    });
  });
  // La cronologia parte da zero: i passi contati nei test sono solo quelli dell'operazione.
  act(() => app.store.getState().setDoc(app.store.getState().doc));
  return { app, fbId: fb.id, node: ids.block(PLC, fb.id) };
}
const tn = (id: string) => screen.getByTestId(`tree-node-${id}`);
const blocksFolder = ids.folder(PLC, 'blocks');
const ctrl = (key: string) => `{Control>}${key}{/Control}`;

describe('copia e incolla', () => {
  it('Mod+C scrive i nomi negli appunti; Mod+V su Blocchi di programma crea Nastro_1 con numero libero (un passo di annulla)', async () => {
    const { app, node } = await setup();
    await app.user.click(tn(node));
    await app.user.keyboard(ctrl('c'));
    expect(app.bridge.clipboard).toBe('Nastro');
    await app.user.click(tn(blocksFolder));
    await app.user.keyboard(ctrl('v'));
    await waitFor(() => expect(dev(app).blocks).toHaveLength(3));
    const copy = dev(app).blocks.find((b) => b.name === 'Nastro_1')!;
    expect(copy).toMatchObject({ kind: 'FB', number: 2 });
    expect(history(app)).toBe(1);
    act(() => app.store.getState().undo());
    expect(dev(app).blocks).toHaveLength(2);
  });

  it('più oggetti selezionati con Ctrl+clic: un nome per riga', async () => {
    const { app, node } = await setup((d) => {
      d.blocks.push(
        createCodeBlock({ kind: 'FC', number: 1, name: 'Calcolo', language: 'AWL', newId }),
      );
    });
    await app.user.click(tn(node));
    await app.user.keyboard('{Control>}');
    await app.user.click(tn(ids.block(PLC, dev(app).blocks[2]!.id)));
    await app.user.keyboard('{/Control}');
    await app.user.keyboard(ctrl('c'));
    expect(app.bridge.clipboard).toBe('Nastro\nCalcolo');
  });

  it('Maiusc+clic seleziona un intervallo di nodi visibili', async () => {
    const { app, node } = await setup((d) => {
      d.blocks.push(
        createCodeBlock({ kind: 'FC', number: 1, name: 'Calcolo', language: 'AWL', newId }),
      );
    });
    // L'albero ordina per nome: Calcolo, Main, Nastro.
    await app.user.click(tn(ids.block(PLC, dev(app).blocks[2]!.id)));
    await app.user.keyboard('{Shift>}');
    await app.user.click(tn(node));
    await app.user.keyboard('{/Shift}');
    expect(
      screen.getByTestId(`tree-node-${ids.block(PLC, dev(app).blocks[0]!.id)}`),
    ).toHaveAttribute('aria-selected', 'true');
    await app.user.keyboard(ctrl('c'));
    expect(app.bridge.clipboard).toBe('Calcolo\nMain\nNastro');
  });

  it('un testo estraneo negli appunti non incolla nulla', async () => {
    const { app, node } = await setup();
    await app.user.click(tn(node));
    await app.user.keyboard(ctrl('c'));
    app.bridge.clipboard = 'qualcos altro';
    await app.user.click(tn(blocksFolder));
    await app.user.keyboard(ctrl('v'));
    await act(async () => {});
    expect(dev(app).blocks).toHaveLength(2);
  });

  it("taglia e incolla in un gruppo sposta l'oggetto (stesso id) in un solo passo", async () => {
    const { app, node, fbId } = await setup((d) => void d.groups.blocks.push('Linea'));
    await app.user.click(tn(node));
    await app.user.keyboard(ctrl('x'));
    await app.user.click(tn(ids.group(PLC, 'blocks', 'Linea')));
    await app.user.keyboard(ctrl('v'));
    await waitFor(() => expect(dev(app).blocks.find((b) => b.id === fbId)!.group).toBe('Linea'));
    expect(dev(app).blocks).toHaveLength(2);
    expect(history(app)).toBe(1);
  });
});

describe('fra due PLC', () => {
  it("taglia e incolla in un altro PLC copia ed elimina l'origine in un solo passo; trascinare copia", async () => {
    const { app, node } = await setup();
    act(() => {
      app.store.getState().edit('history.addDevice', (p) => {
        p.devices.push(
          createPlcDevice({
            cpu: findCpu('cpu-315-2-pn-dp')!,
            orderNumber: 'x',
            firmware: 'V3.3',
            name: 'PLC_2',
            texts: { defaultTagTable: 'Standard' },
            newId: () => 'p2',
          }),
        );
      });
    });
    act(() => app.store.getState().setDoc(app.store.getState().doc));
    await app.user.click(tn(node));
    await app.user.keyboard(ctrl('x'));
    await app.user.click(tn(ids.folder('p2', 'blocks')));
    await app.user.keyboard(ctrl('v'));
    const other = () => findDevice(app.store.getState().doc!.project, 'p2')!;
    await waitFor(() => expect(other().blocks.map((b) => b.name)).toContain('Nastro'));
    expect(other().blocks.find((b) => b.name === 'Nastro')).toMatchObject({ number: 1 });
    expect(dev(app).blocks.map((b) => b.name)).toEqual(['Main']);
    expect(history(app)).toBe(1);

    // Trascinare dal PLC_2 al PLC_1 copia e lascia l'origine.
    const copyNode = ids.block('p2', other().blocks.find((b) => b.name === 'Nastro')!.id);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(tn(copyNode), { dataTransfer: dt });
    const target = tn(ids.folder(PLC, 'blocks'));
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe('copy');
    fireEvent.drop(target, { dataTransfer: dt });
    expect(dev(app).blocks.map((b) => b.name)).toEqual(['Main', 'Nastro']);
    expect(other().blocks.map((b) => b.name)).toContain('Nastro');
    expect(history(app)).toBe(2);
  });
});

describe('taglia fra PLC senza perdite', () => {
  const addPlc2 = (app: RenderedApp, extra?: (d: ReturnType<typeof dev>) => void) => {
    act(() => {
      app.store.getState().edit('history.addDevice', (p) => {
        const d2 = createPlcDevice({
          cpu: findCpu('cpu-315-2-pn-dp')!,
          orderNumber: 'x',
          firmware: 'V3.3',
          name: 'PLC_2',
          texts: { defaultTagTable: 'Standard' },
          newId: () => 'p2',
        });
        extra?.(d2);
        p.devices.push(d2);
      });
    });
    act(() => app.store.getState().setDoc(app.store.getState().doc));
    return () => findDevice(app.store.getState().doc!.project, 'p2')!;
  };

  it("l'origine senza numero libero nella destinazione non viene eliminata", async () => {
    cap.maxFb = 2;
    const { app, node } = await setup((d) => {
      d.blocks.push(
        createCodeBlock({ kind: 'FB', number: 2, name: 'Rullo', language: 'AWL', newId }),
      );
    });
    const other = addPlc2(app, (d) => {
      d.blocks.push(
        createCodeBlock({ kind: 'FB', number: 1, name: 'Altro', language: 'AWL', newId }),
      );
    });
    await app.user.click(tn(node));
    await app.user.keyboard('{Control>}');
    await app.user.click(tn(ids.block(PLC, dev(app).blocks[2]!.id)));
    await app.user.keyboard('{/Control}');
    await app.user.keyboard(ctrl('x'));
    await app.user.click(tn(ids.folder('p2', 'blocks')));
    await app.user.keyboard(ctrl('v'));
    await waitFor(() => expect(other().blocks.map((b) => b.name)).toContain('Nastro'));
    expect(other().blocks.map((b) => b.name)).not.toContain('Rullo');
    expect(dev(app).blocks.map((b) => b.name)).toEqual(['Main', 'Rullo']);
    expect(app.store.getState().messages.at(-1)).toMatchObject({
      textKey: 'messages.pasteNoNumber',
      params: { count: '1' },
    });
    expect(history(app)).toBe(1);
    act(() => app.store.getState().undo());
    expect(dev(app).blocks).toHaveLength(3);
    expect(other().blocks.map((b) => b.name)).toEqual(['Main', 'Altro']);
  });

  it("le modifiche all'origine fra taglio e incolla non si perdono", async () => {
    const { app, node, fbId } = await setup();
    const other = addPlc2(app);
    await app.user.click(tn(node));
    await app.user.keyboard(ctrl('x'));
    act(() => {
      app.store.getState().edit('history.rename', (p) => {
        const fb = findDevice(p, PLC)!.blocks.find((b) => b.id === fbId) as CodeBlock;
        fb.interface.input.push({ id: 'in1', name: 'Start', type: 'Bool', comment: '' });
      });
    });
    const before = history(app);
    await app.user.click(tn(ids.folder('p2', 'blocks')));
    await app.user.keyboard(ctrl('v'));
    await waitFor(() => expect(other().blocks.map((b) => b.name)).toContain('Nastro'));
    const copy = other().blocks.find((b) => b.name === 'Nastro') as CodeBlock;
    expect(copy.interface.input.map((m) => m.name)).toEqual(['Start']);
    expect(dev(app).blocks.map((b) => b.name)).toEqual(['Main']);
    expect(history(app)).toBe(before + 1);
    act(() => app.store.getState().undo());
    expect(dev(app).blocks.map((b) => b.name)).toEqual(['Main', 'Nastro']);
    expect(other().blocks.map((b) => b.name)).toEqual(['Main']);
  });

  it('una origine eliminata dopo il taglio non viene incollata e gli appunti si svuotano', async () => {
    const { app, node, fbId } = await setup();
    const other = addPlc2(app);
    await app.user.click(tn(node));
    await app.user.keyboard(ctrl('x'));
    act(() => {
      app.store.getState().edit('history.delete', (p) => {
        const d = findDevice(p, PLC)!;
        d.blocks = d.blocks.filter((b) => b.id !== fbId);
      });
    });
    await app.user.click(tn(ids.folder('p2', 'blocks')));
    await app.user.keyboard(ctrl('v'));
    await act(async () => {});
    expect(other().blocks.map((b) => b.name)).toEqual(['Main']);
    expect(commands['edit.paste'].isEnabled(app.store.getState())).toBe(false);
  });

  it('la tabella standard non si taglia', async () => {
    const { app } = await setup();
    await app.user.click(tn(ids.tagTable(PLC, dev(app).tagTables[0]!.id)));
    expect(app.store.getState().editTarget?.can).toMatchObject({ cut: false, copy: true });
  });
});

describe('elimina', () => {
  it('chiede conferma: con no non cambia nulla, con sì elimina (un passo di annulla)', async () => {
    const { app, node } = await setup();
    app.bridge.questionAnswers.push(false, true);
    await app.user.click(tn(node));
    await app.user.keyboard('{Delete}');
    await waitFor(() => expect(app.bridge.questions).toHaveLength(1));
    expect(app.bridge.questions[0]).toMatchObject({
      title: 'Elimina',
      message: expect.stringContaining('Nastro'),
    });
    expect(dev(app).blocks).toHaveLength(2);
    await app.user.keyboard('{Delete}');
    await waitFor(() => expect(dev(app).blocks).toHaveLength(1));
    expect(history(app)).toBe(1);
  });

  it('la tabella standard resta, con un messaggio; le altre selezionate si eliminano', async () => {
    const { app } = await setup((d) => {
      d.tagTables.push({ id: 'T2', name: 'Altra', group: '', tags: [], constants: [] });
    });
    const std = dev(app).tagTables[0]!.id;
    await app.user.click(tn(ids.tagTable(PLC, std)));
    await app.user.keyboard('{Control>}');
    await app.user.click(tn(ids.tagTable(PLC, 'T2')));
    await app.user.keyboard('{/Control}{Delete}');
    await waitFor(() => expect(dev(app).tagTables).toHaveLength(1));
    expect(dev(app).tagTables[0]!.id).toBe(std);
    expect(app.store.getState().messages.at(-1)).toMatchObject({
      severity: 'warning',
      textKey: 'messages.standardTableLocked',
    });
  });

  it('solo la tabella standard: messaggio senza domanda', async () => {
    const { app } = await setup();
    await app.user.click(tn(ids.tagTable(PLC, dev(app).tagTables[0]!.id)));
    await app.user.keyboard('{Delete}');
    await act(async () => {});
    expect(app.bridge.questions).toHaveLength(0);
    expect(dev(app).tagTables).toHaveLength(1);
    expect(app.store.getState().messages.at(-1)?.textKey).toBe('messages.standardTableLocked');
  });
});

describe('rinomina in linea', () => {
  it("F2: nome doppio mostra l'errore e resta; Esc annulla; nome valido aggiorna i riferimenti", async () => {
    const { app, node } = await setup((d) => {
      const u = createUdt({ name: 'Motore', number: 1, newId });
      d.udts.push(u);
      const fb = d.blocks.find((b) => b.name === 'Nastro') as CodeBlock;
      fb.interface.static.push({ id: 'm1', name: 'm', type: '"Nastro"', comment: '' });
    });
    await app.user.click(tn(node));
    await app.user.keyboard('{F2}');
    const input = within(tn(node)).getByRole('textbox');
    expect(input).toHaveValue('Nastro');
    expect(input).toHaveFocus();
    await app.user.clear(input);
    await app.user.type(input, 'main{Enter}');
    expect(within(tn(node)).getByRole('alert')).toHaveTextContent('Il nome è già in uso.');
    expect(within(tn(node)).getByRole('textbox')).toBeInTheDocument();
    expect(dev(app).blocks[1]!.name).toBe('Nastro');
    expect(history(app)).toBe(0);
    await app.user.keyboard('{Escape}');
    expect(within(tn(node)).queryByRole('textbox')).not.toBeInTheDocument();
    expect(dev(app).blocks[1]!.name).toBe('Nastro');

    await app.user.keyboard('{F2}');
    const again = within(tn(node)).getByRole('textbox');
    await app.user.clear(again);
    await app.user.type(again, 'Rullo{Enter}');
    expect(dev(app).blocks[1]!.name).toBe('Rullo');
    expect((dev(app).blocks[1] as CodeBlock).interface.static[0]!.type).toBe('"Rullo"');
    expect(history(app)).toBe(1);
    expect(tn(node)).toHaveTextContent('Rullo [FB1]');
  });

  it("un nome non valido (vuoto) mostra l'errore; il blur con un nome valido conferma", async () => {
    const { app, node } = await setup();
    await app.user.click(tn(node));
    await app.user.keyboard('{F2}');
    const input = within(tn(node)).getByRole('textbox');
    await app.user.clear(input);
    await app.user.keyboard('{Enter}');
    expect(within(tn(node)).getByRole('alert')).toHaveTextContent('Il nome non è valido.');
    await app.user.type(input, 'Nuovo');
    await app.user.tab();
    expect(dev(app).blocks[1]!.name).toBe('Nuovo');
  });

  it('la tabella standard non si rinomina', async () => {
    const { app } = await setup();
    await app.user.click(tn(ids.tagTable(PLC, dev(app).tagTables[0]!.id)));
    expect(app.store.getState().editTarget?.can.rename).toBe(false);
  });
});

describe('gruppi e menu contestuale', () => {
  it('Aggiungi nuovo gruppo dal menu: Gruppo_1 e rinomina subito in linea', async () => {
    const { app } = await setup();
    await app.user.pointer({ keys: '[MouseRight]', target: tn(blocksFolder) });
    await app.user.click(screen.getByRole('menuitem', { name: 'Aggiungi nuovo gruppo' }));
    expect(dev(app).groups.blocks).toEqual(['Gruppo_1']);
    const input = await within(tn(ids.group(PLC, 'blocks', 'Gruppo_1'))).findByRole('textbox');
    expect(input).toHaveValue('Gruppo_1');
    await app.user.clear(input);
    await app.user.type(input, 'Linea{Enter}');
    expect(dev(app).groups.blocks).toEqual(['Linea']);
    expect(tn(ids.group(PLC, 'blocks', 'Linea'))).toBeInTheDocument();
    expect(history(app)).toBe(2);
  });

  it('un secondo gruppo riceve Gruppo_2', async () => {
    const { app } = await setup((d) => void d.groups.blocks.push('Gruppo_1'));
    await app.user.pointer({ keys: '[MouseRight]', target: tn(blocksFolder) });
    await app.user.click(screen.getByRole('menuitem', { name: 'Aggiungi nuovo gruppo' }));
    expect(dev(app).groups.blocks).toEqual(['Gruppo_1', 'Gruppo_2']);
  });

  it('menu da tastiera: Maiusc+F10, frecce, Invio esegue; Esc chiude e il focus torna al nodo', async () => {
    const { app, node } = await setup();
    await app.user.click(tn(node));
    await app.user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Apri',
      'Taglia',
      'Copia',
      'Incolla',
      'Elimina',
      'Rinomina',
      'Aggiungi nuovo gruppo',
      'Proprietà',
    ]);
    expect(items[0]).toHaveAttribute('aria-disabled', 'true'); // Apri: dal Task 10
    expect(items[6]).toHaveAttribute('aria-disabled', 'true'); // non è una cartella
    expect(items[3]).toHaveAttribute('aria-disabled', 'true'); // nessun oggetto copiato
    expect(items[1]).toHaveFocus();
    await app.user.keyboard('{ArrowDown}');
    expect(items[2]).toHaveFocus();
    await app.user.keyboard('{Enter}');
    expect(app.bridge.clipboard).toBe('Nastro');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(tn(node)).toHaveFocus();

    await app.user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await app.user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(tn(node)).toHaveFocus();
  });

  it('Proprietà seleziona il nodo e porta alla scheda Proprietà', async () => {
    const { app, node } = await setup();
    act(() => app.store.getState().setInspectorTab('info'));
    await app.user.pointer({ keys: '[MouseRight]', target: tn(node) });
    await app.user.click(screen.getByRole('menuitem', { name: 'Proprietà' }));
    expect(app.store.getState().selection).toBe(node);
    expect(app.store.getState().inspectorTab).toBe('properties');
    expect(screen.getByTestId('inspector-tab-properties')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Modifica e destinazione', () => {
  it("Taglia è disattivato senza destinazione e si attiva con il focus sull'albero", async () => {
    const { app, node } = await setup();
    expect(app.store.getState().editTarget).toBeNull();
    expect(commands['edit.cut'].isEnabled(app.store.getState())).toBe(false);
    await app.user.click(tn(node));
    expect(commands['edit.cut'].isEnabled(app.store.getState())).toBe(true);
    expect(commands['edit.paste'].isEnabled(app.store.getState())).toBe(false);
    await app.user.click(screen.getByTestId('panel-inspector'));
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    expect(app.store.getState().editTarget).toBeNull();
  });

  it('il menu Modifica > Copia usa la destinazione anche se il menu prende il focus', async () => {
    const { app, node } = await setup();
    await app.user.click(tn(node));
    await app.user.click(screen.getByRole('menuitem', { name: 'Modifica' }));
    await app.user.click(screen.getByRole('menuitem', { name: /^Copia/ }));
    expect(app.bridge.clipboard).toBe('Nastro');
  });
});

describe('trascinamento', () => {
  it("un blocco su un gruppo lo sposta; su una cartella di un'altra area il rilascio è vietato", async () => {
    const { app, node, fbId } = await setup((d) => void d.groups.blocks.push('Linea'));
    const dt = fakeDataTransfer();
    fireEvent.dragStart(tn(node), { dataTransfer: dt });
    expect(JSON.parse(dt.getData('application/x-baaportal'))).toEqual({
      deviceId: PLC,
      refs: [{ kind: 'block', deviceId: PLC, id: fbId }],
    });
    expect(dt.getData('text/plain')).toBe('Nastro');

    const bad = fireEvent.dragOver(tn(ids.folder(PLC, 'tags')), { dataTransfer: dt });
    expect(bad).toBe(true); // non annullato: il rilascio non è permesso
    expect(dt.dropEffect).toBe('none');

    const group = tn(ids.group(PLC, 'blocks', 'Linea'));
    const ok = fireEvent.dragOver(group, { dataTransfer: dt });
    expect(ok).toBe(false);
    expect(dt.dropEffect).toBe('move');
    expect(group).toHaveClass('baa-drop-target');
    fireEvent.drop(group, { dataTransfer: dt });
    expect(dev(app).blocks.find((b) => b.id === fbId)!.group).toBe('Linea');
    expect(history(app)).toBe(1);
    expect(group).not.toHaveClass('baa-drop-target');
    act(() => app.store.getState().undo());
    expect(dev(app).blocks.find((b) => b.id === fbId)!.group).toBe('');
  });

  it("un tag dalla vista dettagli su un'altra tabella lo sposta", async () => {
    const tag: Tag = {
      id: 'g1',
      name: 'Motore',
      type: 'Bool',
      address: '%M0.0',
      hmi: false,
      comment: '',
    };
    const { app } = await setup((d) => {
      d.tagTables[0]!.tags.push(tag);
      d.tagTables.push({ id: 'T2', name: 'Altra', group: '', tags: [], constants: [] });
    });
    const from = dev(app).tagTables[0]!.id;
    await app.user.click(tn(ids.tagTable(PLC, from)));
    const row = screen.getAllByTestId('details-row')[0]!;
    expect(row).toHaveAttribute('draggable', 'true');
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    const target = tn(ids.tagTable(PLC, 'T2'));
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe('move');
    fireEvent.drop(target, { dataTransfer: dt });
    expect(dev(app).tagTables[0]!.tags).toHaveLength(0);
    expect(dev(app).tagTables[1]!.tags.map((t) => t.id)).toEqual(['g1']);
    expect(history(app)).toBe(1);
  });
});
