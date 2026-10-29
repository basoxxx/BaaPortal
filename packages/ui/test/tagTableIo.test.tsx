import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseTagsCsv, parseTagsXlsx, tagsToXlsx } from '@baaportal/importers';
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
  it('"aggiornate" conta solo le righe che cambiano davvero', () => {
    const t: TagTable = {
      id: 'tb',
      name: 'T',
      group: '',
      tags: [tag('A', 'Int', '%MW2'), tag('B', 'Int', '%MW4')],
      constants: [],
    };
    const row = (name: string, address: string, line: number) => ({
      line,
      name,
      path: '',
      type: 'Int',
      address,
      comment: '',
      hmi: true,
    });
    const { summary } = applyTagImport(t, {
      tags: [row('A', '%MW2', 2), row('B', '%MW8', 3)],
      constants: [],
      errors: [],
    });
    expect(summary.updated).toBe(1);
  });

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

describe('applyTagImport: nomi unici per CPU', () => {
  const base: TagTable = { id: 'tb', name: 'T', group: '', tags: [], constants: [] };
  it("un nome presente in un'altra tabella non si crea: scartato con NOME_IN_ALTRA_TABELLA", () => {
    const row = (name: string, line: number) => ({
      line,
      name,
      path: '',
      type: 'Int',
      address: `%MW${line * 2}`,
      comment: '',
      hmi: true,
    });
    const crow = (name: string, line: number) => ({
      line,
      name,
      path: '',
      type: 'Int',
      value: '1',
      comment: '',
    });
    const { table, summary } = applyTagImport(
      base,
      { tags: [row('Dup', 2), row('Ok', 3)], constants: [crow('K', 2)], errors: [] },
      new Map([
        ['dup', 'Altra'],
        ['k', 'Costanti'],
      ]),
    );
    expect(table.tags.map((x) => x.name)).toEqual(['Ok']);
    expect(table.constants).toEqual([]);
    expect(summary.created).toBe(1);
    expect(summary.skipped).toEqual([
      { line: 2, code: 'NOME_IN_ALTRA_TABELLA', detail: 'Altra' },
      { line: 2, sheet: 'constants', code: 'NOME_IN_ALTRA_TABELLA', detail: 'Costanti' },
    ]);
  });

  it('maiuscole diverse: aggiorna il tag esistente, stesso id, nome del file', () => {
    const t: TagTable = { ...base, tags: [tag('motore', 'Int', '%MW2')] };
    const { table } = applyTagImport(t, {
      tags: [
        { line: 2, name: 'MOTORE', path: '', type: 'Int', address: '%MW4', comment: '', hmi: true },
      ],
      constants: [],
      errors: [],
    });
    expect(table.tags).toHaveLength(1);
    expect(table.tags[0]).toMatchObject({ id: 't-motore', name: 'MOTORE', address: '%MW4' });
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
      expect(dlg).toHaveTextContent('Riga 5: tipo di dati non valido: Foo');
      expect(table(app).tags.map((x) => x.name)).toEqual(['A', 'B', 'C']);
    },
    T,
  );

  it(
    'sulla cartella Variabili PLC: tabella nuova col nome del file; nome in collisione → _1; punto nel nome',
    async () => {
      const app = await setup();
      const folder = () =>
        app.user.pointer({ keys: '[MouseRight]', target: tn(ids.folder(PLC, 'tags')) });
      const run = async (file: string, tagName: string) => {
        app.bridge.files.set(file, csv(`${tagName};;Int;%MW2;;True;True;True`));
        app.bridge.openFileResults.push([file]);
        await folder();
        await app.user.click(screen.getByRole('menuitem', { name: 'Importa variabili…' }));
        await screen.findByTestId('import-tags-report');
        await app.user.click(screen.getByTestId('dialog-ok'));
      };
      const names = () => dev(app).tagTables.map((x) => x.name);
      await run('/in/Motori.csv', 'X');
      expect(names()).toEqual(['Tabella delle variabili standard', 'Motori']);
      expect(past(app)).toBeGreaterThan(0);
      await run('/in/Motori.csv', 'Y');
      expect(names()).toContain('Motori_1');
      await run('/in/tags.v2.csv', 'Z');
      expect(names()).toContain('tags.v2');
    },
    T,
  );

  it(
    'importa costanti da xlsx e le conta nel riepilogo',
    async () => {
      const app = await setup();
      const src: TagTable = {
        id: 's',
        name: 'S',
        group: '',
        tags: [tag('A', 'Int', '%MW2')],
        constants: [{ id: 'c1', name: 'Max', type: 'Int', value: '5', comment: 'm' }],
      };
      app.bridge.files.set('/in/v.xlsx', tagsToXlsx(src));
      app.bridge.openFileResults.push(['/in/v.xlsx']);
      await menu(app, 'Importa variabili…');
      const dlg = await screen.findByTestId('import-tags-report');
      expect(dlg).toHaveTextContent('Creati: 2');
      expect(table(app).constants).toMatchObject([{ name: 'Max', type: 'Int', value: '5' }]);
    },
    T,
  );

  it(
    'esporta csv: inizia col BOM e, senza estensione scelta, la aggiunge',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      app.bridge.saveFileResults.push('/out/T');
      await menu(app, 'Esporta variabili…');
      await waitFor(() => expect(app.bridge.files.has('/out/T.xlsx')).toBe(true));
      app.bridge.saveFileResults.push('/out/T2.csv');
      await menu(app, 'Esporta variabili…');
      await waitFor(() => expect(app.bridge.files.has('/out/T2.csv')).toBe(true));
      const head = [...app.bridge.files.get('/out/T2.csv')!.slice(0, 7)];
      expect(head).toEqual([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Name')]);
      expect(
        parseTagsCsv(new TextDecoder().decode(app.bridge.files.get('/out/T2.csv')!)).tags,
      ).toHaveLength(1);
    },
    T,
  );

  it(
    'esporta: un nome con altra estensione (x.txt) la sostituisce, un punto nel nome no',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      app.bridge.saveFileResults.push('/out/x.txt');
      await menu(app, 'Esporta variabili…');
      await waitFor(() => expect(app.bridge.files.has('/out/x.xlsx')).toBe(true));
      app.bridge.saveFileResults.push('/out/v1.2');
      await menu(app, 'Esporta variabili…');
      await waitFor(() => expect(app.bridge.files.has('/out/v1.2.xlsx')).toBe(true));
      expect(app.bridge.files.has('/out/x.txt.xlsx')).toBe(false);
    },
    T,
  );

  it(
    'reimportare un file identico: nessun passo di annullamento, progetto non modificato, 0 aggiornate',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2', 'c')]);
      const dirty = app.store.getState().doc!.dirty;
      const rev = app.store.getState().doc!.revision;
      app.bridge.files.set('/in/v.csv', csv('A;;Int;%MW2;c;True;True;True'));
      app.bridge.openFileResults.push(['/in/v.csv']);
      const n = past(app);
      await menu(app, 'Importa variabili…');
      await screen.findByTestId('import-tags-report');
      expect(past(app)).toBe(n);
      expect(app.store.getState().doc!.revision).toBe(rev);
      expect(app.store.getState().doc!.dirty).toBe(dirty);
      expect(app.store.getState().messages.at(-1)?.params).toMatchObject({ updated: '0' });
    },
    T,
  );

  it(
    'un file con sole righe errate: nessuna modifica, il report elenca gli errori',
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      const before = structuredClone(table(app));
      app.bridge.files.set('/in/v.csv', csv('D;;Foo;%MW10;;True;True;True'));
      app.bridge.openFileResults.push(['/in/v.csv']);
      const n = past(app);
      await menu(app, 'Importa variabili…');
      const dlg = await screen.findByTestId('import-tags-report');
      expect(dlg).toHaveTextContent('Riga 2: tipo di dati non valido: Foo');
      expect(dlg).toHaveTextContent('nella tabella "Tabella delle variabili standard"');
      expect(past(app)).toBe(n);
      expect(table(app)).toEqual(before);
    },
    T,
  );

  it(
    'su una nuova tabella senza righe valide il report mostra il nome che avrebbe avuto',
    async () => {
      const app = await setup();
      app.bridge.files.set('/in/Vuota.csv', csv('D;;Foo;%MW10;;True;True;True'));
      app.bridge.openFileResults.push(['/in/Vuota.csv']);
      await app.user.pointer({ keys: '[MouseRight]', target: tn(ids.folder(PLC, 'tags')) });
      await app.user.click(screen.getByRole('menuitem', { name: 'Importa variabili…' }));
      const dlg = await screen.findByTestId('import-tags-report');
      expect(dlg).toHaveTextContent('nella tabella "Vuota"');
      expect(dev(app).tagTables).toHaveLength(1);
    },
    T,
  );

  it(
    "un nome già in un'altra tabella non viene creato e il report lo spiega",
    async () => {
      const app = await setup([tag('A', 'Int', '%MW2')]);
      act(() => {
        app.store.getState().edit('history.addTagTable', (p) => {
          findDevice(p, PLC)!.tagTables.push({
            id: 'tb2',
            name: 'Altra',
            group: '',
            tags: [],
            constants: [],
          });
        });
      });
      app.bridge.files.set('/in/v.csv', csv('A;;Int;%MW8;;True;True;True'));
      app.bridge.openFileResults.push(['/in/v.csv']);
      await app.user.pointer({ keys: '[MouseRight]', target: tn(ids.tagTable(PLC, 'tb2')) });
      await app.user.click(screen.getByRole('menuitem', { name: 'Importa variabili…' }));
      const dlg = await screen.findByTestId('import-tags-report');
      expect(dlg).toHaveTextContent(
        'Riga 2: nome già usato nella tabella "Tabella delle variabili standard"',
      );
      expect(dev(app).tagTables[1]!.tags).toEqual([]);
    },
    T,
  );
});
