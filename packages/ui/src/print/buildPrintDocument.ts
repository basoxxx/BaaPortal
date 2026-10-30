// Documentazione del programma (tappa 7D): HTML autonomo per la stampa e il PDF. Funzione pura.
// Ogni testo che viene dal progetto passa da `esc`: un progetto altrui non è fidato. Il documento
// non contiene script e dichiara una CSP che li vieta; il processo principale lo carica comunque
// senza JavaScript e senza rete.
// shortcut: KOP e FUP escono come AWL generato (i componenti dell'editor sono interattivi e
// legati a i18n e contesto); un rendering SVG statico del grafico è il passo successivo.
import { convertMnemonics } from '@baaportal/awl';
import {
  blockSources,
  crossReferences,
  findDevice,
  isGraphic,
  type Block,
  type CodeBlock,
  type Member,
  type PlcDevice,
  type Project,
  type TagTable,
  type Udt,
  type WatchTable,
} from '@baaportal/project';

export interface PrintSelection {
  deviceId: string;
  blocks: string[];
  udts: string[];
  tagTables: string[];
  watchTables: string[];
}

export interface PrintOptions {
  /** Traduzione delle voci `print.doc.*`. */
  t(key: string, vars?: Record<string, string | number>): string;
  lang: string;
  appVersion: string;
  now: Date;
  mnemonic: 'international' | 'german';
  includeComments: boolean;
  includeInterface: boolean;
  includeCode: boolean;
  includeXref: boolean;
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const KIND_ORDER = { OB: 0, FB: 1, FC: 2, DB: 3, IDB: 4 } as const;

const CSS = `
@page { margin: 18mm 14mm; }
body { font: 10pt/1.35 system-ui, sans-serif; color: #000; }
h1 { font-size: 24pt; margin: 0 0 8mm; } h2 { font-size: 14pt; margin: 0 0 3mm; border-bottom: 1px solid #000; }
h3 { font-size: 11pt; margin: 5mm 0 2mm; }
.cover { page-break-after: always; padding-top: 30mm; } .cover td { padding: 1mm 6mm 1mm 0; border: 0; }
.toc { page-break-after: always; } .toc a { color: inherit; text-decoration: none; }
.obj { page-break-before: always; }
table { border-collapse: collapse; width: 100%; margin-bottom: 3mm; }
th, td { border: 1px solid #888; padding: 1px 4px; text-align: left; vertical-align: top; }
th { background: #e8e8e8; }
pre { font: 9pt/1.3 ui-monospace, Menlo, Consolas, monospace; margin: 1mm 0 3mm; white-space: pre-wrap; border-left: 2px solid #888; padding-left: 3mm; }
.net { page-break-inside: avoid; } .muted { color: #555; }
`;

type T = PrintOptions['t'];
const heads = (t: T, ks: string[]) =>
  `<tr>${ks.map((k) => `<th>${esc(t(`print.doc.col.${k}`))}</th>`).join('')}</tr>`;
const cells = (vs: unknown[]) => `<tr>${vs.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`;

const memberRows = (ms: Member[], depth: number): string =>
  ms
    .map(
      (m) =>
        `<tr><td style="padding-left:${4 + depth * 12}px">${esc(m.name)}</td><td>${esc(m.type)}</td>` +
        `<td>${esc(m.initial)}</td><td>${esc(m.comment)}</td></tr>` +
        memberRows(m.members ?? [], depth + 1),
    )
    .join('');

const memberTable = (ms: Member[], t: T) =>
  ms.length === 0
    ? ''
    : `<table>${heads(t, ['name', 'type', 'initial', 'comment'])}${memberRows(ms, 0)}</table>`;

function header(rows: [string, unknown][], t: T): string {
  const shown = rows.filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return shown.length === 0
    ? ''
    : `<table>${shown
        .map(([k, v]) => `<tr><th>${esc(t(`print.doc.${k}`))}</th><td>${esc(v)}</td></tr>`)
        .join('')}</table>`;
}

const blockLabel = (b: Block) => `${b.kind}${b.number}${b.name ? ` — ${b.name}` : ''}`;

function codeBlockHtml(b: CodeBlock, dev: PlcDevice, o: PrintOptions): string {
  const { t } = o;
  let out = '';
  if (o.includeInterface) {
    const i = b.interface;
    const sec: [string, Member[]][] = [
      ['input', i.input],
      ['output', i.output],
      ['inOut', i.inOut],
      ['static', i.static],
      ['temp', i.temp],
    ];
    const withData = sec.filter(([, ms]) => ms.length > 0);
    if (withData.length > 0) out += `<h3>${esc(t('print.doc.interface'))}</h3>`;
    if (i.returnType && i.returnType !== 'Void')
      out += `<p>${esc(t('print.doc.returnType'))}: ${esc(i.returnType)}</p>`;
    for (const [k, ms] of withData)
      out += `<h3 class="muted">${esc(t(`print.doc.sec.${k}`))}</h3>${memberTable(ms, t)}`;
  }
  if (!o.includeCode) return out;
  if (b.mc7?.knowHowLocked) return out + `<p class="muted">${esc(t('print.doc.protected'))}</p>`;
  if (b.language === 'SCL')
    return out + `<h3>${esc(t('print.doc.sclCode'))}</h3><pre>${esc(b.networks[0]?.source)}</pre>`;
  const srcs = blockSources(b, dev);
  out += `<h3>${esc(t('print.doc.networks'))}</h3>`;
  b.networks.forEach((n, i) => {
    const awl = convertMnemonics(srcs[i] ?? '', 'international', o.mnemonic);
    out +=
      `<div class="net"><h3>${esc(t('print.doc.network', { n: i + 1 }))}${n.title ? `: ${esc(n.title)}` : ''}</h3>` +
      (o.includeComments && n.comment ? `<p>${esc(n.comment)}</p>` : '') +
      `<pre>${esc(awl)}</pre></div>`;
  });
  if (isGraphic(b.language)) out += `<p class="muted">${esc(t('print.doc.graphicAsAwl'))}</p>`;
  return out;
}

function blockHtml(b: Block, dev: PlcDevice, o: PrintOptions): string {
  const { t } = o;
  let out = header(
    [
      ['number', `${b.kind}${b.number}`],
      ['name', b.name],
      ['language', b.kind === 'DB' || b.kind === 'IDB' ? 'DB' : b.language],
      ['title', b.header.title],
      ['author', b.header.author],
      ['family', b.header.family],
      ['version', b.header.version],
      ['comment', o.includeComments ? b.header.comment : ''],
    ],
    t,
  );
  if (b.kind === 'DB') {
    if (o.includeInterface)
      out += `<h3>${esc(t('print.doc.members'))}</h3>${memberTable(b.members, t)}`;
  } else if (b.kind === 'IDB') {
    const fb = dev.blocks.find((x) => x.id === b.instanceOf);
    out += `<p>${esc(t('print.doc.instanceOf'))}: ${esc(fb ? blockLabel(fb) : b.instanceOf)}</p>`;
    const ov = Object.entries(b.overrides);
    if (ov.length > 0)
      out += `<table>${heads(t, ['name', 'initial'])}${ov.map(([k, v]) => cells([k, v])).join('')}</table>`;
  } else out += codeBlockHtml(b, dev, o);
  return out;
}

function udtHtml(u: Udt, o: PrintOptions): string {
  return (
    header(
      [
        ['number', `UDT${u.number}`],
        ['name', u.name],
        ['title', u.title],
        ['author', u.author],
        ['version', u.version],
        ['comment', o.includeComments ? u.comment : ''],
      ],
      o.t,
    ) + (o.includeInterface ? memberTable(u.members, o.t) : '')
  );
}

function tagTableHtml(x: TagTable, t: T): string {
  let out = `<table>${heads(t, ['name', 'type', 'address', 'comment'])}${x.tags
    .map((g) => cells([g.name, g.type, g.address, g.comment]))
    .join('')}</table>`;
  if (x.constants.length > 0)
    out +=
      `<h3>${esc(t('print.doc.constants'))}</h3><table>${heads(t, ['name', 'type', 'value', 'comment'])}` +
      `${x.constants.map((c) => cells([c.name, c.type, c.value, c.comment])).join('')}</table>`;
  return out;
}

const watchHtml = (w: WatchTable, t: T) =>
  `<table>${heads(t, ['operand', 'format', 'modify', 'comment'])}${w.rows
    .map((r) => cells([r.operand, r.format, r.modify, r.comment]))
    .join('')}</table>`;

function xrefHtml(dev: PlcDevice, blockIds: Set<string>, t: T): string {
  const rows = crossReferences(dev).flatMap((x) => {
    const uses = x.uses.filter((u) => blockIds.has(u.blockId));
    if (uses.length === 0) return [];
    const list = uses
      .map((u) => esc(`${u.block} N${u.network}:${u.line} ${u.instruction} (${u.access})`))
      .join('<br>');
    return [
      `<tr><td>${esc(x.address)}</td><td>${esc(x.symbol)}</td><td>${esc(x.type)}</td><td>${list}</td></tr>`,
    ];
  });
  return `<table>${heads(t, ['address', 'symbol', 'type', 'uses'])}${rows.join('')}</table>`;
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function buildPrintDocument(project: Project, sel: PrintSelection, o: PrintOptions): string {
  const { t } = o;
  const dev = findDevice(project, sel.deviceId);
  if (!dev) throw new Error('PLC not found');
  const blocks = dev.blocks
    .filter((b) => sel.blocks.includes(b.id))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.number - b.number);
  const sections: { title: string; body: string }[] = [
    ...blocks.map((b) => ({ title: blockLabel(b), body: blockHtml(b, dev, o) })),
    ...dev.udts
      .filter((u) => sel.udts.includes(u.id))
      .map((u) => ({ title: `UDT${u.number} — ${u.name}`, body: udtHtml(u, o) })),
    ...dev.tagTables
      .filter((x) => sel.tagTables.includes(x.id))
      .map((x) => ({ title: `${t('print.doc.tagTable')}: ${x.name}`, body: tagTableHtml(x, t) })),
    ...dev.watchTables
      .filter((x) => sel.watchTables.includes(x.id))
      .map((x) => ({ title: `${t('print.doc.watchTable')}: ${x.name}`, body: watchHtml(x, t) })),
  ];
  if (o.includeXref)
    sections.push({
      title: t('print.doc.xref'),
      body: xrefHtml(dev, new Set(blocks.map((b) => b.id)), t),
    });
  const cover: [string, string][] = [
    ['project', project.meta.name],
    ['plc', dev.name],
    ['cpu', `${dev.cpu.typeId} ${dev.cpu.orderNumber}`.trim()],
    ['date', stamp(o.now)],
    ['version', `BaaPortal ${o.appVersion}`],
  ];
  return (
    `<!doctype html><html lang="${esc(o.lang)}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<title>${esc(project.meta.name)}</title><style>${CSS}</style></head><body>` +
    `<section class="cover"><h1>${esc(project.meta.name)}</h1><table>${cover
      .map(([k, v]) => `<tr><td>${esc(t(`print.doc.cover.${k}`))}</td><td>${esc(v)}</td></tr>`)
      .join('')}</table></section>` +
    `<section class="toc"><h2>${esc(t('print.doc.toc'))}</h2><ol>${sections
      .map((s, i) => `<li><a href="#o${i}">${esc(s.title)}</a></li>`)
      .join('')}</ol></section>` +
    sections
      .map((s, i) => `<section class="obj" id="o${i}"><h2>${esc(s.title)}</h2>${s.body}</section>`)
      .join('') +
    `</body></html>`
  );
}
