import { act, screen, waitFor } from '@testing-library/react';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  blockToMc7File,
  createCodeBlock,
  createInstanceDb,
  createPlcDevice,
  findDevice,
  type CodeBlock,
} from '@baaportal/project';
import { kitZip, type KitResult } from '@baaportal/s7comm';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const past = (app: RenderedApp) => app.store.getState().history.past.length;
const tn = (id: string) => screen.getByTestId(`tree-node-${id}`);
const IMPORT = 'Importa blocchi (.blk o raccolta del kit)…';

function fc(n: number, source: string): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: n, name: `FC${n}`, language: 'AWL' });
  b.networks[0]!.source = source;
  return b;
}

/** Un .blk sintetico: compilato dal compilatore MC7 (nessun blocco di terzi nel repository). */
function blkOf(n: number, source: string): Uint8Array {
  const cpu = findCpu('cpu-315-2-pn-dp')!;
  const d = createPlcDevice({
    cpu,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.3',
    name: 'PLC_X',
    texts: { defaultTagTable: 'Tabella' },
    newId: () => globalThis.crypto.randomUUID(),
  });
  const b = fc(n, source);
  d.blocks.push(b);
  const r = blockToMc7File(b, d, cpu, new Date('2026-10-20T10:00:00Z'));
  expect(r.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  return r.file!;
}

/** FB 30 {z: INT} e il suo DB di istanza 30, compilati dal compilatore MC7. */
function fbAndInstance(): { fb: Uint8Array; db: Uint8Array } {
  const cpu = findCpu('cpu-315-2-pn-dp')!;
  const newId = () => globalThis.crypto.randomUUID();
  const d = createPlcDevice({
    cpu,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.3',
    name: 'PLC_X',
    texts: { defaultTagTable: 'Tabella' },
    newId,
  });
  const fb = createCodeBlock({ kind: 'FB', number: 30, name: 'Linea', language: 'AWL' });
  fb.interface.static.push({ id: newId(), name: 'z', type: 'Int', comment: '' });
  fb.networks[0]!.source = 'L #z\nT %MW2';
  const db = createInstanceDb({ number: 30, name: 'Linea_DB', instanceOf: 'Linea', newId });
  d.blocks.push(fb, db);
  const at = new Date('2026-10-20T10:00:00Z');
  const [f, g] = [blockToMc7File(fb, d, cpu, at), blockToMc7File(db, d, cpu, at)];
  expect([...f.diagnostics, ...g.diagnostics].filter((x) => x.severity === 'error')).toEqual([]);
  return { fb: f.file!, db: g.file! };
}

async function setup() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  return app;
}

async function runImport(app: RenderedApp) {
  await app.user.pointer({ keys: '[MouseRight]', target: tn(ids.folder(PLC, 'blocks')) });
  await app.user.click(screen.getByRole('menuitem', { name: IMPORT }));
}

const infoTexts = (app: RenderedApp) =>
  app.store
    .getState()
    .messages.map((m) => `${m.severity}: ${m.textKey} ${JSON.stringify(m.params ?? {})}`);

describe('Importa blocchi', () => {
  it(
    'due .blk: uno sostituisce dopo conferma, un solo passo di annulla',
    async () => {
      const f1 = blkOf(11, 'A %I0.0\n= %Q0.0');
      const f2 = blkOf(12, 'AN %I0.1\n= %Q0.1');
      const app = await setup();
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          findDevice(p, PLC)!.blocks.push(fc(12, 'A %I9.9'));
        });
      });
      app.bridge.files.set('/in/FC11.blk', f1);
      app.bridge.files.set('/in/FC12.blk', f2);
      app.bridge.openFileResults.push(['/in/FC11.blk', '/in/FC12.blk']);
      const before = past(app);
      await runImport(app);
      await waitFor(() => expect(dev(app).blocks.map((b) => b.name)).toContain('FC11'));
      // Il dialogo ha i filtri .blk e .zip e la scelta multipla.
      expect(app.bridge.openFileCalls[0]!.multi).toBe(true);
      expect(app.bridge.openFileCalls[0]!.filters.flatMap((f) => f.extensions).sort()).toEqual([
        'blk',
        'zip',
      ]);
      // La conferma elenca il blocco sostituito.
      expect(app.bridge.questions).toHaveLength(1);
      expect(app.bridge.questions[0]!.message).toContain('FC12');
      expect(past(app)).toBe(before + 1);
      const fc12 = dev(app).blocks.find((b) => b.name === 'FC12') as CodeBlock;
      expect(fc12.networks[0]!.source).toContain('AN');
      // Il primo nuovo blocco è selezionato.
      const fc11 = dev(app).blocks.find((b) => b.name === 'FC11')!;
      expect(app.store.getState().selection).toBe(ids.block(PLC, fc11.id));
      // Riepilogo in Informazioni → Generale.
      expect(infoTexts(app).some((m) => m.includes('messages.blocksImported'))).toBe(true);
      act(() => app.store.getState().undo());
      expect(dev(app).blocks.map((b) => b.name)).not.toContain('FC11');
      expect(
        (dev(app).blocks.find((b) => b.name === 'FC12') as CodeBlock).networks[0]!.source,
      ).toBe('A %I9.9');
    },
    T,
  );

  it(
    'rispondendo No alla sostituzione il progetto resta identico',
    async () => {
      const f2 = blkOf(12, 'AN %I0.1\n= %Q0.1');
      const app = await setup();
      act(() => {
        app.store.getState().edit('history.addBlock', (p) => {
          findDevice(p, PLC)!.blocks.push(fc(12, 'A %I9.9'));
        });
      });
      app.bridge.files.set('/in/FC12.blk', f2);
      app.bridge.openFileResults.push(['/in/FC12.blk']);
      app.bridge.questionAnswers.push(false);
      const project = app.store.getState().doc!.project;
      const before = past(app);
      await runImport(app);
      await waitFor(() => expect(app.bridge.questions).toHaveLength(1));
      expect(app.store.getState().doc!.project).toBe(project);
      expect(past(app)).toBe(before);
    },
    T,
  );

  it(
    'da uno zip del kit prende blocchi/*; uno zip non valido dà un errore e si continua',
    async () => {
      const f1 = blkOf(21, 'A %I0.0\n= %Q0.0');
      const kit: KitResult = {
        summary: {
          kitFormat: 1,
          baaportalVersion: 'dev',
          startedAt: '2026-10-20T10:00:00.000Z',
          finishedAt: '2026-10-20T10:00:05.000Z',
          host: '10.0.0.5',
          szlRead: 0,
          blocksListed: 1,
          blocksUploaded: 1,
          refusedCount: 0,
          warnings: [],
          errors: [],
        },
        files: {
          'capture.jsonl': new TextEncoder().encode(''),
          'blocchi/FC21.blk': f1,
        },
      };
      const app = await setup();
      app.bridge.files.set('/in/kit.zip', kitZip(kit));
      app.bridge.files.set('/in/rotto.zip', zipSync({ 'x.txt': new Uint8Array([1]) }));
      app.bridge.openFileResults.push(['/in/rotto.zip', '/in/kit.zip']);
      await runImport(app);
      await waitFor(() => expect(dev(app).blocks.map((b) => b.name)).toContain('FC21'));
      expect(infoTexts(app).some((m) => m.startsWith('error: messages.importZipInvalid'))).toBe(
        true,
      );
    },
    T,
  );

  it(
    'un DB importato prima del suo FB diventa DB di istanza senza conferma; il riepilogo conta i metadati aggiornati',
    async () => {
      const { fb, db } = fbAndInstance();
      const app = await setup();
      app.bridge.files.set('/in/DB30.blk', db);
      app.bridge.files.set('/in/FB30.blk', fb);
      app.bridge.openFileResults.push(['/in/DB30.blk']);
      await runImport(app);
      await waitFor(() => expect(dev(app).blocks.map((b) => b.name)).toContain('DB30'));
      expect(dev(app).blocks.find((b) => b.number === 30)!.kind).toBe('DB');
      app.bridge.openFileResults.push(['/in/FB30.blk', '/in/DB30.blk']);
      await runImport(app);
      await waitFor(() =>
        expect(dev(app).blocks.find((b) => b.kind === 'IDB' && b.number === 30)).toBeDefined(),
      );
      // stessi byte: nessuna domanda di sostituzione
      expect(app.bridge.questions).toHaveLength(0);
      expect(
        infoTexts(app).some(
          (m) =>
            m.includes('messages.blocksImported') &&
            m.includes('"created":"1"') &&
            m.includes('"refreshed":"1"') &&
            m.includes('"skipped":"0"'),
        ),
      ).toBe(true);
    },
    T,
  );

  it(
    'un file illeggibile come blocco finisce tra i saltati con il motivo',
    async () => {
      const app = await setup();
      app.bridge.files.set('/in/x.blk', new Uint8Array([1, 2, 3]));
      app.bridge.openFileResults.push(['/in/x.blk']);
      const project = app.store.getState().doc!.project;
      await runImport(app);
      await waitFor(() =>
        expect(infoTexts(app).some((m) => m.includes('messages.blocksImported'))).toBe(true),
      );
      expect(app.store.getState().doc!.project).toBe(project);
      expect(infoTexts(app).some((m) => m.includes('messages.importSkipped'))).toBe(true);
    },
    T,
  );
});
