import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseTagsXlsx } from '@baaportal/importers';
import { findDevice, type Tag, type TagTable } from '@baaportal/project';
import { applyTagImport } from '../src/project/navigation/tagTableIo';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';
const dev = (app: RenderedApp) => findDevice(app.store.getState().doc!.project, PLC)!;
const table = (app: RenderedApp) => dev(app).tagTables[0]!;
const past = (app: RenderedApp) => app.store.getState().history.past.length;
const tn = (id: string) => screen.getByTestId(`tree-node-${id}`);
const tag = (name: string, type: string, address: string, comment = ''): Tag => ({
  id: `t-${name}`,
  name,
  type,
  address,
  hmi: true,
  comment,
});
const csv = (...lines: string[]) =>
  new TextEncoder().encode(
    ['Name;Path;Data Type;Logical Address;Comment;Hmi Visible;Hmi Accessible;Hmi Writeable']
      .concat(lines)
      .join('\n'),
  );

async function setup(tags: Tag[] = []) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => {
    app.store.getState().edit('history.addRow', (p) => {
      findDevice(p, PLC)!.tagTables[0]!.tags.push(...tags);
    });
  });
  return app;
}
const menu = async (app: RenderedApp, name: string) => {
  await app.user.pointer({
    keys: '[MouseRight]',
    target: tn(ids.tagTable(PLC, table(app).id)),
  });
  await app.user.click(screen.getByRole('menuitem', { name }));
};

describe('applyTagImport', () => {
  it('applyTagImport: nome esistente aggiornato con stesso id, nome nuovo creato, riga errata in skipped', () => {
    const t: TagTable = {
      id: 'tb',
      name: 'T',
      group: '',
      tags: [tag('A', 'Int', '%MW2')],
      constants: [],
    };
    const before = structuredClone(t);
    const row = (name: string, address: string, comment: string, line: number) => ({
      line,
      name,
      path: '',
      type: 'Int',
      address,
      comment,
      hmi: false,
    });
    const { table: out, summary } = applyTagImport(t, {
      tags: [row('A', '%MW4', 'nuovo', 2), row('B', '%MW6', '', 3)],
      constants: [],
      errors: [{ line: 4, code: 'TIPO_NON_VALIDO', detail: 'Foo' }],
    });
    expect(t).toEqual(before);
    expect(out.tags).toHaveLength(2);
    expect(out.tags[0]).toEqual({
      id: 't-A',
      name: 'A',
      type: 'Int',
      address: '%MW4',
      comment: 'nuovo',
      hmi: false,
    });
    expect(out.tags[1]!.id).not.toBe('t-A');
    expect(summary).toMatchObject({ created: 1, updated: 1 });
    expect(summary.skipped).toEqual([{ line: 4, code: 'TIPO_NON_VALIDO', detail: 'Foo' }]);
  });
});

describe('tagTableIo', () => {
  it(
    'importa csv da menu contestuale → tag nella tabella; un Ctrl+Z ripristina la tabella identica',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      const before = structuredClone(table(app));
      app.bridge.files.set(
        '/in/v.csv',
        csv('A;;Int;%MW4;ciao;True;True;True', 'B;;Bool;%M10.0;;True;True;True'),
      );
      app.bridge.openFileResults.push(['/in/v.csv']);
      const n = past(app);
      await menu(app, 'Importa variabili…');
      await waitFor(() => expect(table(app).tags.map((x) => x.name)).toEqual(['A', 'B']));
      expect(table(app).tags[0]).toMatchObject({ id: 't-A', address: '%MW4', comment: 'ciao' });
      expect(past(app)).toBe(n + 1);
      act(() => app.store.getState().undo());
      expect(table(app)).toEqual(before);
    },
    T,
  );

  it(
    'esporta xlsx → i byte scritti su FakeBridge si rileggono con parseTagsXlsx uguali alla tabella',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2', 'x'), tag('B', 'Bool', '%M10.0')]);
      app.bridge.saveFileResults.push('/out/T.xlsx');
      await menu(app, 'Esporta variabili…');
      await waitFor(() => expect(app.bridge.files.has('/out/T.xlsx')).toBe(true));
      const parsed = parseTagsXlsx(app.bridge.files.get('/out/T.xlsx')!);
      expect(parsed.errors).toEqual([]);
      expect(
        parsed.tags.map(({ name, type, address, comment, hmi }) => ({
          id: `t-${name}`,
          name,
          type,
          address,
          hmi,
          comment,
        })),
      ).toEqual(table(app).tags);
    },
    T,
  );

  it(
    "importa un file non xlsx con estensione .xlsx → messaggio d'errore, progetto invariato",
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      const before = structuredClone(table(app));
      app.bridge.files.set('/in/v.xlsx', new TextEncoder().encode('non sono uno zip'));
      app.bridge.openFileResults.push(['/in/v.xlsx']);
      const n = past(app);
      await menu(app, 'Importa variabili…');
      await waitFor(() =>
        expect(app.store.getState().messages.some((m) => m.severity === 'error')).toBe(true),
      );
      expect(past(app)).toBe(n);
      expect(table(app)).toEqual(before);
      expect(app.store.getState().dialog).toBeNull();
    },
    T,
  );

  it(
    'il riepilogo mostra 2 creati, 1 aggiornato, 1 scartato con motivo',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      app.bridge.files.set(
        '/in/v.csv',
        csv(
          'A;;Int;%MW4;;True;True;True',
          'B;;Int;%MW6;;True;True;True',
          'C;;Int;%MW8;;True;True;True',
          'D;;Foo;%MW10;;True;True;True',
        ),
      );
      app.bridge.openFileResults.push(['/in/v.csv']);
      await menu(app, 'Importa variabili…');
      const dlg = await screen.findByTestId('import-tags-report');
      expect(dlg).toHaveTextContent('Creati: 2');
      expect(dlg).toHaveTextContent('Aggiornati: 1');
      expect(dlg).toHaveTextContent('Scartati: 1');
      expect(dlg).toHaveTextContent('Riga 5');
      expect(dlg).toHaveTextContent('Foo');
      expect(table(app).tags.map((x) => x.name)).toEqual(['A', 'B', 'C']);
    },
    T,
  );
});
