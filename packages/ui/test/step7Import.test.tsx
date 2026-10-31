import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, findDevice, type PlcDevice } from '@baaportal/project';
import {
  applyStep7Plan,
  defaultSelection,
  planStep7Import,
} from '../src/project/navigation/step7Import';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';
const enc = (s: string) => new TextEncoder().encode(s);
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;

const UDT = 'TYPE "Axis"\nSTRUCT\n Pos : INT;\nEND_STRUCT;\nEND_TYPE\n';
const DB = 'DATA_BLOCK "AxisData"\n "Axis"\nBEGIN\n Pos := 3;\nEND_DATA_BLOCK\n';
const SCL = [
  'FUNCTION_BLOCK "Conveyor"',
  "TITLE = 'Nastro'",
  'VAR_INPUT',
  '  Start : BOOL;',
  'END_VAR',
  'VAR_OUTPUT',
  '  Run : BOOL;',
  'END_VAR',
  'BEGIN',
  '  Run := Start;',
  '  Ghost := 1;',
  'END_FUNCTION_BLOCK',
].join('\n');
const SDF = [
  '"Start","I 0.0","BOOL","Avvio"',
  '"Conveyor","FB 10","FB 10",""',
  '"Main","OB 1","OB 1",""',
  '"Old","FC 5","FC 5",""',
].join('\r\n');
const files = () => [
  { name: 'b.awl', bytes: enc(DB) },
  { name: 'a.awl', bytes: enc(UDT) },
  { name: 'nastro.scl', bytes: enc(SCL) },
  { name: 'Simboli.sdf', bytes: enc(SDF) },
];

function withFc5(d: PlcDevice): PlcDevice {
  d.blocks.push(createCodeBlock({ kind: 'FC', number: 5, name: 'FC5', language: 'AWL' }));
  return d;
}

describe('planStep7Import e applyStep7Plan', () => {
  it('UDT prima del DB anche da file diversi, FB col numero del simbolo, nomi e simboli', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const d = withFc5(structuredClone(dev(app)));
    const plan = planStep7Import(d, files());
    const keys = plan.items.map((i) => [i.kind, i.name, i.replaces]);
    expect(keys).toContainEqual(['DB', 'AxisData', undefined]);
    expect(keys).toContainEqual(['UDT', 'Axis', undefined]);
    expect(keys).toContainEqual(['FB', 'Conveyor', undefined]);
    expect(keys).toContainEqual(['rename', 'Old', 'FC5']);
    expect(keys).toContainEqual(['tags', 'Simboli', undefined]);
    // Il testo SCL con una variabile sconosciuta si importa comunque, con gli errori.
    const fb = plan.items.find((i) => i.name === 'Conveyor')!;
    expect(fb.sclErrors?.length).toBeGreaterThan(0);

    const res = applyStep7Plan(d, plan, defaultSelection(plan));
    expect(res).toMatchObject({ created: 3, replaced: 0, renamed: 1 });
    expect(d.udts.map((u) => u.name)).toEqual(['Axis']);
    const db = d.blocks.find((b) => b.name === 'AxisData');
    expect(db?.kind).toBe('DB');
    if (db?.kind === 'DB') expect(db.members[0]).toMatchObject({ name: 'Pos', initial: '3' });
    const conv = d.blocks.find((b) => b.name === 'Conveyor');
    expect(conv).toMatchObject({ kind: 'FB', number: 10, language: 'SCL' });
    expect(d.blocks.find((b) => b.kind === 'FC' && b.number === 5)?.name).toBe('Old');
    expect(d.tagTables.find((t) => t.name === 'Simboli')?.tags).toMatchObject([
      { name: 'Start', address: '%I0.0', type: 'Bool', comment: 'Avvio' },
    ]);
  });

  it('un oggetto esistente con lo stesso nome non si sostituisce se non lo si sceglie', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const d = structuredClone(dev(app));
    planAndApply(d, [{ name: 'a.awl', bytes: enc(UDT) }]);
    const plan = planStep7Import(d, [
      { name: 'a.awl', bytes: enc(UDT.replace('Pos : INT', 'Pos : DINT')) },
    ]);
    expect(plan.items[0]).toMatchObject({ kind: 'UDT', replaces: 'Axis' });
    expect(defaultSelection(plan).has(plan.items[0]!.key)).toBe(false);
    applyStep7Plan(d, plan, defaultSelection(plan));
    expect(d.udts[0]!.members[0]!.type).toBe('Int');
    applyStep7Plan(d, plan, new Set([plan.items[0]!.key]));
    expect(d.udts[0]!.members[0]!.type).toBe('DInt');
  });

  it('Rinomina e Rinumera importano accanto all\u2019oggetto esistente', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const d = structuredClone(dev(app));
    planAndApply(d, [{ name: 'a.awl', bytes: enc(UDT) }]);
    const plan = planStep7Import(d, [
      { name: 'a.awl', bytes: enc(UDT.replace('Pos : INT', 'Pos : DINT')) },
    ]);
    const key = plan.items[0]!.key;
    applyStep7Plan(d, plan, new Set([key]), new Map([[key, 'rename']]));
    expect(d.udts.map((u) => [u.name, u.members[0]!.type])).toEqual([
      ['Axis', 'Int'],
      ['Axis_1', 'DInt'],
    ]);
    expect(new Set(d.udts.map((u) => u.number)).size).toBe(2);
  });

  it('un oggetto nuovo col nome di un altro blocco è bloccato nell\u2019anteprima', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const d = structuredClone(dev(app));
    d.blocks.push(createCodeBlock({ kind: 'FC', number: 3, name: 'Motore', language: 'AWL' }));
    const plan = planStep7Import(d, [
      {
        name: 'a.awl',
        bytes: enc('FUNCTION "Motore" : VOID\nBEGIN\nNETWORK\nTITLE =\nEND_FUNCTION\n'),
      },
      { name: 's.sdf', bytes: enc('"Motore","FC 10","FC 10",""\r\n') },
    ]);
    const item = plan.items.find((i) => i.kind === 'FC')!;
    expect(item).toMatchObject({ number: 10, nameTakenBy: 'FC3' });
    expect(defaultSelection(plan).has(item.key)).toBe(false);
    const before = d.blocks.length;
    expect(applyStep7Plan(d, plan, new Set([item.key]))).toMatchObject({ created: 0 });
    expect(d.blocks).toHaveLength(before);
  });
});

function planAndApply(d: PlcDevice, f: { name: string; bytes: Uint8Array }[]) {
  const plan = planStep7Import(d, f);
  applyStep7Plan(d, plan, defaultSelection(plan));
}

describe('finestra Importa da STEP 7', () => {
  it(
    'dal menu del PLC: scelta dei file, anteprima, importazione in un solo passo',
    async () => {
      const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
      for (const f of files()) app.bridge.files.set(`/in/${f.name}`, f.bytes);
      app.bridge.openFileResults.push(files().map((f) => `/in/${f.name}`));
      await app.user.pointer({
        keys: '[MouseRight]',
        target: screen.getByTestId(`tree-node-${ids.plc(PLC)}`),
      });
      await app.user.click(screen.getByRole('menuitem', { name: 'Importa da STEP 7…' }));
      const dlg = await screen.findByTestId('step7-import');
      await app.user.click(within(dlg).getByTestId('step7-pick'));
      const table = await within(dlg).findByTestId('step7-items');
      expect(within(table).getByText('Conveyor')).toBeTruthy();
      expect(app.bridge.openFileCalls[0]?.multi).toBe(true);
      const before = app.store.getState().history.past.length;
      await app.user.click(within(dlg).getByTestId('dialog-ok'));
      await waitFor(() => expect(screen.queryByTestId('step7-import')).toBeNull());
      expect(app.store.getState().history.past.length).toBe(before + 1);
      expect(dev(app).blocks.some((b) => b.name === 'Conveyor' && b.number === 10)).toBe(true);
      act(() => app.store.getState().undo());
      expect(dev(app).blocks.some((b) => b.name === 'Conveyor')).toBe(false);
    },
    T,
  );
});
