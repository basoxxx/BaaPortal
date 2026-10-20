import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
  blockToMc7File,
  createCodeBlock,
  createGlobalDb,
  createPlcDevice,
  createUdt,
  findDevice,
  mc7FidelityOf,
  sourceHashOf,
  type Block,
  type CodeBlock,
  type GlobalDb,
} from '@baaportal/project';
import { findCpu } from '@baaportal/catalog';
import { cell } from './blockFixtures';
import { renameNode } from '../src/project/navigation/objectCommands';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';
const GOOD = 'A %I0.0\n= %Q0.0';
const BAD = 'A %I0.0\nFOO %Q0.0';
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const tn = (id: string) => screen.getByTestId(`tree-node-${id}`);

function fc(n: number, source: string): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: n, name: `FC${n}`, language: 'AWL' });
  b.networks[0]!.source = source;
  return b;
}

/** Le impronte della regola F come le scrive l'importazione (blocco da solo nel dispositivo). */
function stampFidelity(b: Block): void {
  const d = createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC',
    texts: { defaultTagTable: 'T' },
  });
  d.blocks = [b];
  b.mc7!.fidelity = mc7FidelityOf(b, d);
}

async function setup(blocks: CodeBlock[] = []) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(...blocks);
    });
  });
  return app;
}

const rows = () => screen.queryAllByTestId('compile-row');
const rowOf = (name: string) => rows().find((r) => r.getAttribute('data-block') === name)!;

async function menu(app: RenderedApp, nodeId: string, item: string) {
  await app.user.pointer({ keys: '[MouseRight]', target: tn(nodeId) });
  await app.user.click(screen.getByRole('menuitem', { name: item }));
}

async function showTab() {
  fireEvent.click(screen.getByTestId('info-subtab-compile'));
}

describe('Compila', () => {
  it(
    'solo modifiche: ricompila solo il blocco cambiato',
    async () => {
      const app = await setup([fc(1, GOOD), fc(2, GOOD)]);
      const mode = 'Compila → Software (solo modifiche)';
      await menu(app, ids.plc(PLC), mode);
      // Prima volta: OB1, FC1 e FC2 non sono mai stati compilati.
      expect(rows().map((r) => r.getAttribute('data-block'))).toEqual(['Main', 'FC1', 'FC2']);
      expect(screen.getByTestId('compile-summary')).toHaveTextContent(
        'Compilazione terminata: 3 blocchi, 0 errori, 0 avvisi',
      );
      // Nessun cambiamento: niente da compilare, la scheda si è svuotata.
      await menu(app, ids.plc(PLC), mode);
      expect(rows()).toHaveLength(0);
      expect(screen.getByTestId('compile-summary')).toHaveTextContent('0 blocchi');
      // Cambia FC2: solo lui.
      const id2 = dev(app).blocks.find((b) => b.name === 'FC2')!.id;
      act(() => {
        app.store.getState().edit('history.editNetworkCode', (p) => {
          (findDevice(p, PLC)!.blocks.find((b) => b.id === id2) as CodeBlock).networks[0]!.source =
            'AN %I0.1\n= %Q0.1';
        });
      });
      await menu(app, ids.plc(PLC), mode);
      expect(rows().map((r) => r.getAttribute('data-block'))).toEqual(['FC2']);
      // Completa: tutto.
      await menu(app, ids.folder(PLC, 'blocks'), 'Compila → Software (compilazione completa)');
      expect(rows()).toHaveLength(3);
    },
    T,
  );

  it(
    'una compilazione fallita conserva l’ultimo file buono, che non vale per il contenuto nuovo',
    async () => {
      const app = await setup([fc(1, GOOD)]);
      const mode = 'Compila → Software (solo modifiche)';
      await menu(app, ids.plc(PLC), mode);
      const id = dev(app).blocks.find((b) => b.name === 'FC1')!.id;
      const kept = app.store.getState().compile.files[id];
      const hash = app.store.getState().compile.hashes[id];
      expect(kept).toBeDefined();
      act(() => {
        app.store.getState().edit('history.editNetworkCode', (p) => {
          (findDevice(p, PLC)!.blocks.find((b) => b.id === id) as CodeBlock).networks[0]!.source =
            BAD;
        });
      });
      await menu(app, ids.plc(PLC), mode);
      expect(rowOf('FC1').getAttribute('data-status')).toBe('error');
      // il file buono resta, con l'impronta di allora: non coincide con quella del contenuto nuovo
      expect(app.store.getState().compile.files[id]).toBe(kept);
      expect(app.store.getState().compile.hashes[id]).toBe(hash);
      // e il blocco resta "cambiato": la compilazione successiva lo riprova
      await menu(app, ids.plc(PLC), mode);
      expect(rows().map((r) => r.getAttribute('data-block'))).toEqual(['FC1']);
    },
    T,
  );

  it(
    'il pulsante della barra ha il comportamento "solo modifiche"',
    async () => {
      const app = await setup([fc(1, GOOD)]);
      await app.user.click(
        within(screen.getByTestId('toolbar')).getByRole('button', {
          name: 'Compila → Software (solo modifiche)',
        }),
      );
      expect(rows()).toHaveLength(2);
      expect(app.store.getState().inspectorTab).toBe('info');
    },
    T,
  );

  it(
    'su un blocco solo, Compila lo compila sempre',
    async () => {
      const app = await setup([fc(1, GOOD), fc(2, GOOD)]);
      const id1 = dev(app).blocks.find((b) => b.name === 'FC1')!.id;
      await menu(app, ids.block(PLC, id1), 'Compila');
      expect(rows().map((r) => r.getAttribute('data-block'))).toEqual(['FC1']);
      await menu(app, ids.block(PLC, id1), 'Compila');
      expect(rows().map((r) => r.getAttribute('data-block'))).toEqual(['FC1']);
    },
    T,
  );

  it(
    'un blocco con errori ha ✗, gli altri ✓, e il riepilogo conta giusto',
    async () => {
      const app = await setup([fc(1, GOOD), fc(2, BAD)]);
      await menu(app, ids.plc(PLC), 'Compila → Software (compilazione completa)');
      expect(rowOf('FC2')).toHaveAttribute('data-status', 'error');
      expect(rowOf('FC2')).toHaveTextContent('✗');
      expect(rowOf('FC1')).toHaveAttribute('data-status', 'ok');
      expect(rowOf('FC1')).toHaveTextContent('✓');
      expect(rowOf('Main')).toHaveAttribute('data-status', 'ok');
      expect(screen.getByTestId('compile-summary')).toHaveTextContent(
        'Compilazione terminata: 3 blocchi, 1 errori, 0 avvisi',
      );
      // Un blocco fallito resta da ricompilare con "solo modifiche".
      await menu(app, ids.plc(PLC), 'Compila → Software (solo modifiche)');
      expect(rows().map((r) => r.getAttribute('data-block'))).toEqual(['FC2']);
    },
    T,
  );

  it(
    'un clic sul messaggio apre l’editor del blocco alla rete e alla riga',
    async () => {
      const app = await setup([fc(2, BAD)]);
      await menu(app, ids.plc(PLC), 'Compila → Software (compilazione completa)');
      const msg = within(rowOf('FC2')).getAllByTestId('compile-message')[0]!;
      expect(msg).toHaveTextContent('Rete 1');
      expect(msg).toHaveTextContent('riga 2');
      await app.user.click(msg);
      const id2 = dev(app).blocks.find((b) => b.name === 'FC2')!.id;
      expect(app.store.getState().workArea.editors.map((e) => e.key)).toContain(
        `block:${PLC}:${id2}`,
      );
      await waitFor(() => {
        const cm = document.querySelector<HTMLElement>('.baa-network-source .cm-editor')!;
        const v = EditorView.findFromDOM(cm)!;
        const head = v.state.selection.main.head;
        expect(v.state.doc.lineAt(head).number).toBe(2);
      });
    },
    T,
  );

  it(
    'la scheda si svuota all’inizio di ogni compilazione',
    async () => {
      const app = await setup([fc(2, BAD)]);
      await menu(app, ids.plc(PLC), 'Compila → Software (compilazione completa)');
      expect(rows().length).toBeGreaterThan(0);
      act(() => app.store.getState().beginCompile());
      expect(rows()).toHaveLength(0);
    },
    T,
  );

  it(
    'un blocco importato non ricodificabile ma non modificato si compila con i byte originali',
    async () => {
      const b = fc(3, GOOD);
      b.mc7 = {
        exact: false,
        sourceHash: '',
        interfaceHash: '',
        headerRaw: '',
        addRaw: '',
        checksum: 0,
        original: '7070aabb',
        mc7Hash: '',
        footerRaw: '',
        times: { code: '', iface: '' },
      };
      b.mc7.sourceHash = sourceHashOf(b);
      stampFidelity(b);
      const app = await setup([b]);
      await menu(app, ids.block(PLC, b.id), 'Compila');
      expect(rowOf('FC3')).toHaveAttribute('data-status', 'ok');
      await showTab();
    },
    T,
  );
});

describe('Esporta blocco compilato', () => {
  it(
    'scrive il file con writeFileAtomic e propone <TIPO><n>.blk',
    async () => {
      const app = await setup([fc(5, GOOD)]);
      const b = dev(app).blocks.find((x) => x.name === 'FC5')!;
      app.bridge.saveFileResults.push('/out/FC5.blk');
      await menu(app, ids.block(PLC, b.id), 'Esporta blocco compilato (.blk)…');
      await waitFor(() => expect(app.bridge.files.has('/out/FC5.blk')).toBe(true));
      expect(app.bridge.saveFileCalls[0]!.defaultName).toBe('FC5.blk');
      expect(app.bridge.saveFileCalls[0]!.filters[0]!.extensions).toEqual(['blk']);
      const expected = blockToMc7File(b, dev(app), findCpu('cpu-315-2-pn-dp'), new Date());
      const written = app.bridge.files.get('/out/FC5.blk')!;
      expect(written.length).toBe(expected.file!.length);
      expect([written[0], written[1]]).toEqual([0x70, 0x70]);
    },
    T,
  );

  it(
    'con errori non salva: li mostra nella scheda Compila',
    async () => {
      const app = await setup([fc(6, BAD)]);
      const b = dev(app).blocks.find((x) => x.name === 'FC6')!;
      app.bridge.saveFileResults.push('/out/FC6.blk');
      await menu(app, ids.block(PLC, b.id), 'Esporta blocco compilato (.blk)…');
      expect(app.bridge.saveFileCalls).toHaveLength(0);
      expect(app.bridge.files.has('/out/FC6.blk')).toBe(false);
      expect(rowOf('FC6')).toHaveAttribute('data-status', 'error');
    },
    T,
  );
});

describe('editor di un blocco importato non ricodificabile', () => {
  function readOnlyBlock(source: string): CodeBlock {
    const b = fc(7, source);
    b.mc7 = {
      exact: false,
      sourceHash: '',
      interfaceHash: '',
      headerRaw: '',
      addRaw: '',
      checksum: 0,
      original: '7070',
      mc7Hash: '',
      footerRaw: '',
      times: { code: '', iface: '' },
    };
    b.mc7.sourceHash = sourceHashOf(b);
    return b;
  }

  it(
    'mostra il banner e l’editor in sola lettura',
    async () => {
      const b = readOnlyBlock(GOOD);
      const app = await setup([b]);
      act(() => app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: b.id }));
      expect(
        await screen.findByText(
          'Blocco importato che non si può ricodificare identico: in sola lettura.',
        ),
      ).toBeInTheDocument();
      const box = screen.getByRole('textbox', { name: 'Codice del segmento 1' });
      expect(box).toHaveAttribute('contenteditable', 'false');
    },
    T,
  );

  it(
    'un blocco normale non ha il banner e si modifica',
    async () => {
      const b = fc(8, GOOD);
      const app = await setup([b]);
      act(() => app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: b.id }));
      await screen.findByRole('textbox', { name: 'Codice del segmento 1' });
      expect(screen.queryByTestId('readonly-banner')).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Codice del segmento 1' })).toHaveAttribute(
        'contenteditable',
        'true',
      );
    },
    T,
  );

  it(
    'una rete con istruzioni MC7 grezze mostra il suggerimento',
    async () => {
      const b = fc(9, 'A %I0.0\n// MC7 grezzo: 1234\n= %Q0.0');
      const app = await setup([b]);
      act(() => app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: b.id }));
      expect(
        await screen.findByText(
          'Questa rete contiene istruzioni MC7 grezze: si può modificare solo togliendole o ripristinandola.',
        ),
      ).toBeInTheDocument();
    },
    T,
  );
});

describe('Compila solo modifiche: dipendenze', () => {
  const MODE = 'Compila → Software (solo modifiche)';
  const all = ['Main', 'FC1', 'FC2'];

  async function primed() {
    const app = await setup([fc(1, GOOD), fc(2, GOOD)]);
    await menu(app, ids.plc(PLC), MODE);
    expect(rows()).toHaveLength(3);
    await menu(app, ids.plc(PLC), MODE);
    expect(rows()).toHaveLength(0);
    return app;
  }
  const names = () => rows().map((r) => r.getAttribute('data-block'));

  it(
    'cambiando l’indirizzo di una variabile si ricompilano i chiamanti',
    async () => {
      const app = await primed();
      act(() => {
        app.store.getState().edit('history.addTag', (p) => {
          findDevice(p, PLC)!.tagTables[0]!.tags.push({
            id: 'tg1',
            name: 'Start',
            type: 'Bool',
            address: '%I0.0',
            hmi: true,
            comment: '',
          });
        });
      });
      await menu(app, ids.plc(PLC), MODE);
      expect(names()).toEqual(all);
      await menu(app, ids.plc(PLC), MODE);
      expect(rows()).toHaveLength(0);
      act(() => {
        app.store.getState().edit('history.editTag', (p) => {
          findDevice(p, PLC)!.tagTables[0]!.tags[0]!.address = '%I0.5';
        });
      });
      await menu(app, ids.plc(PLC), MODE);
      expect(names()).toEqual(all);
    },
    T,
  );

  it(
    'cambiando un parametro del chiamato si ricompilano i chiamanti',
    async () => {
      const app = await primed();
      act(() => {
        app.store.getState().edit('history.addRow', (p) => {
          (
            findDevice(p, PLC)!.blocks.find((b) => b.name === 'FC1') as CodeBlock
          ).interface.input.push({ id: 'm1', name: 'Avvio', type: 'Bool', comment: '' });
        });
      });
      await menu(app, ids.plc(PLC), MODE);
      expect(names()).toEqual(all);
    },
    T,
  );

  it(
    'cambiando un membro di un UDT si ricompilano i chiamanti',
    async () => {
      const app = await primed();
      act(() => {
        app.store.getState().edit('history.addUdt', (p) => {
          const u = createUdt({ name: 'Asse', number: 1 });
          u.members.push({ id: 'u1', name: 'X', type: 'Int', comment: '' });
          findDevice(p, PLC)!.udts.push(u);
        });
      });
      await menu(app, ids.plc(PLC), MODE);
      expect(names()).toEqual(all);
      await menu(app, ids.plc(PLC), MODE);
      act(() => {
        app.store.getState().edit('history.editCell', (p) => {
          findDevice(p, PLC)!.udts[0]!.members[0]!.type = 'Real';
        });
      });
      await menu(app, ids.plc(PLC), MODE);
      expect(names()).toEqual(all);
    },
    T,
  );

  it(
    'l’esportazione riusa il file della sessione se contenuto e contesto non sono cambiati',
    async () => {
      const app = await setup([fc(5, GOOD)]);
      const b = dev(app).blocks.find((x) => x.name === 'FC5')!;
      await menu(app, ids.block(PLC, b.id), 'Compila');
      const kept = app.store.getState().compile.files[b.id]!;
      expect(kept).toBeDefined();
      app.bridge.saveFileResults.push('/out/a.blk');
      await menu(app, ids.block(PLC, b.id), 'Esporta blocco compilato (.blk)…');
      await waitFor(() => expect(app.bridge.files.has('/out/a.blk')).toBe(true));
      expect(app.bridge.files.get('/out/a.blk')).toBe(kept);
    },
    T,
  );
});

describe('blocchi importati non ricodificabili: DB e rinomina', () => {
  const meta = (original: string) => ({
    exact: false,
    sourceHash: '',
    interfaceHash: '',
    headerRaw: '',
    addRaw: '',
    checksum: 0,
    original,
    mc7Hash: '',
    footerRaw: '',
    times: { code: '', iface: '' },
  });

  it(
    'un DB non ricodificabile mostra il banner e non si modifica',
    async () => {
      const d = createGlobalDb({ number: 9, name: 'Dati' });
      d.members.push({ id: 'dm1', name: 'x', type: 'Int', comment: '' });
      d.mc7 = meta('7070');
      d.mc7.sourceHash = sourceHashOf(d);
      const app = await setup();
      act(() => {
        app.store
          .getState()
          .edit('history.addBlock', (p) => void findDevice(p, PLC)!.blocks.push(d));
        app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: d.id });
      });
      expect(await screen.findByTestId('readonly-banner')).toBeInTheDocument();
      const before = app.store.getState().history.past.length;
      // Nessuna riga <Aggiungi> e nessun valore modificabile.
      expect(screen.queryByText('<Aggiungi>')).toBeNull();
      await app.user.click(cell('dm1', 'value'));
      await app.user.keyboard('5{Enter}');
      await app.user.click(cell('dm1', 'name'));
      await app.user.keyboard('Altro{Enter}');
      expect(app.store.getState().history.past.length).toBe(before);
      const db = dev(app).blocks.find((x) => x.id === d.id) as GlobalDb;
      expect(db.members[0]).toMatchObject({ name: 'x' });
      expect(db.members[0]!.initial).toBeUndefined();
    },
    T,
  );

  it(
    'un blocco protetto know-how mostra il banner dedicato',
    async () => {
      const d = createGlobalDb({ number: 9, name: 'Dati' });
      d.mc7 = meta('7070');
      d.mc7.knowHowLocked = true;
      d.mc7.sourceHash = sourceHashOf(d);
      const app = await setup();
      act(() => {
        app.store
          .getState()
          .edit('history.addBlock', (p) => void findDevice(p, PLC)!.blocks.push(d));
        app.store.getState().openEditor({ kind: 'block', deviceId: PLC, objectId: d.id });
      });
      expect(await screen.findByTestId('readonly-banner')).toHaveTextContent(
        "Blocco protetto know-how: si mostra solo l'interfaccia.",
      );
    },
    T,
  );

  it(
    'rinominare un blocco non ricodificabile non cambia i byte esportati',
    async () => {
      const b = fc(3, GOOD);
      b.mc7 = meta('7070aabb');
      b.mc7.sourceHash = sourceHashOf(b);
      stampFidelity(b);
      const app = await setup([b]);
      act(() => void renameNode(app.store, ids.block(PLC, b.id), 'Nuovo'));
      const renamed = dev(app).blocks.find((x) => x.id === b.id)!;
      expect(renamed.name).toBe('Nuovo');
      const out = blockToMc7File(renamed, dev(app), findCpu('cpu-315-2-pn-dp'));
      expect(out.diagnostics).toEqual([]);
      expect(Array.from(out.file!)).toEqual([0x70, 0x70, 0xaa, 0xbb]);
    },
    T,
  );
});
