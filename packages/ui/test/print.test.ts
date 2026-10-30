import { describe, expect, it } from 'vitest';
import {
  createCodeBlock,
  createProject,
  createTagTable,
  createWatchTable,
} from '@baaportal/project';
import { buildPrintDocument, type PrintOptions } from '../src/print/buildPrintDocument';
import { selectionFromNodes } from '../src/print/selection';
import { ids } from '../src/project/navigation/treeIds';
import { fb, globalDb, instanceDb, mem, plc, udt } from './blockFixtures';

const XSS = '<script>alert(1)</script>';
const opts = (over: Partial<PrintOptions> = {}): PrintOptions => ({
  t: (k, v) => (v ? `${k}${JSON.stringify(v)}` : k),
  lang: 'it',
  appVersion: '1.7.0',
  now: new Date(2026, 5, 1, 9, 30),
  mnemonic: 'international',
  includeComments: true,
  includeInterface: true,
  includeCode: true,
  includeXref: true,
  ...over,
});

function setup() {
  const project = createProject({ name: `Linea ${XSS}`, author: 'm', comment: '' }, new Date());
  const d = plc();
  d.name = `PLC ${XSS}`;
  const f = fb(`Motore${XSS}`, { input: [mem('Avvio', 'Bool', { comment: XSS })] });
  f.header.comment = XSS;
  f.networks[0]!.title = XSS;
  f.networks[0]!.comment = XSS;
  f.networks[0]!.source = 'A I 0.0\nL 5\n= Q 4.0';
  const k = createCodeBlock({ kind: 'FC', number: 2, name: 'Grafico', language: 'KOP' });
  k.networks[0]!.lad = {
    root: {
      id: 'n',
      series: [{ id: 'ea', k: 'contact', neg: false, op: 'I 0.0' }],
      outs: [{ id: 'eq', k: 'coil', op: 'M 1.0' }],
    },
  };
  const s = createCodeBlock({ kind: 'FC', number: 3, name: 'Testo', language: 'SCL' });
  s.networks[0]!.source = `x := 1; // ${XSS}`;
  const db = globalDb('Dati', [mem('Valore', 'Int', { initial: '7' })]);
  const idb = instanceDb('Ist', f.id);
  const u = udt('Tipo', [mem('A', 'Int')]);
  const tt = createTagTable(`Tab${XSS}`);
  tt.tags.push({ id: 't', name: 'Tag', type: 'Bool', address: '%I0.0', hmi: false, comment: XSS });
  const w = createWatchTable('Controllo');
  d.blocks.push(f, k, s, db, idb);
  d.udts.push(u);
  d.tagTables.push(tt);
  d.watchTables.push(w);
  project.devices.push(d);
  return { project, d };
}
const all = (d: ReturnType<typeof setup>['d']) => ({
  deviceId: d.id,
  blocks: d.blocks.map((b) => b.id),
  udts: d.udts.map((x) => x.id),
  tagTables: d.tagTables.map((x) => x.id),
  watchTables: d.watchTables.map((x) => x.id),
});

describe('buildPrintDocument', () => {
  it('struttura: copertina, indice e una sezione per oggetto di ogni tipo', () => {
    const { project, d } = setup();
    const html = buildPrintDocument(project, all(d), opts());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('class="cover"');
    expect(html).toContain('class="toc"');
    expect(html).toContain('BaaPortal 1.7.0');
    expect(html).toContain('2026-06-01 09:30');
    // oggetti selezionati + riferimenti incrociati
    expect(html.match(/<section class="obj"/g)).toHaveLength(
      d.blocks.length + d.udts.length + d.tagTables.length + d.watchTables.length + 1,
    );
    for (const x of [
      'Grafico',
      'Testo',
      'Dati',
      'Ist',
      'UDT1',
      'print.doc.tagTable',
      'print.doc.watchTable',
    ])
      expect(html).toContain(x);
    expect(html).toContain('<td>7</td>'); // valore iniziale del DB
    expect(html).toMatch(/<pre>[^<]*A\s+I\s+0\.0/); // AWL generato dal segmento KOP
  });

  it('il testo del progetto esce con escape, senza <script>', () => {
    const { project, d } = setup();
    const html = buildPrintDocument(project, all(d), opts());
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain("default-src 'none'");
  });

  it('i mnemonici tedeschi convertono l’AWL', () => {
    const { project, d } = setup();
    const html = buildPrintDocument(project, all(d), opts({ mnemonic: 'german' }));
    expect(html).toMatch(/\bU\s+E 0\.0/);
  });

  it('le opzioni tolgono commenti, interfaccia, codice e riferimenti', () => {
    const { project, d } = setup();
    const html = buildPrintDocument(
      project,
      all(d),
      opts({
        includeComments: false,
        includeInterface: false,
        includeCode: false,
        includeXref: false,
      }),
    );
    expect(html).not.toContain('<pre>');
    expect(html).not.toContain('print.doc.interface');
    expect(html).not.toContain('print.doc.xref');
  });

  it('selectionFromNodes: PLC, cartella e blocco singolo', () => {
    const { project, d } = setup();
    const whole = selectionFromNodes(project, [ids.plc(d.id)])!;
    expect(whole.blocks).toHaveLength(d.blocks.length);
    expect(whole.udts).toHaveLength(1);
    const one = selectionFromNodes(project, [ids.block(d.id, d.blocks[0]!.id)])!;
    expect(one.blocks).toEqual([d.blocks[0]!.id]);
    expect(selectionFromNodes(project, [ids.folder(d.id, 'types')])!.udts).toHaveLength(1);
    expect(selectionFromNodes(project, ['static'])).toBeNull();
  });
});
