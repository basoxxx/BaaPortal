import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface Sheet {
  name: string;
  /** Celle già come testo; le celle vuote sono stringhe vuote. */
  rows: string[][];
}

export type XlsxErrorCode = 'NON_ZIP' | 'NON_XLSX' | 'FOGLIO_ILLEGGIBILE';

export class XlsxFormatError extends Error {
  readonly code: XlsxErrorCode;
  constructor(code: XlsxErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'XlsxFormatError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Parser XML minimo (niente DOMParser: il pacchetto gira anche in node)
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    return Object.hasOwn(ENTITIES, body) ? ENTITIES[body]! : m;
  });
}

/** Nome senza prefisso di namespace (`x:row` -> `row`). */
const local = (n: string): string => n.slice(n.indexOf(':') + 1);

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const top = (): XmlNode => stack[stack.length - 1]!;
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(xml)) !== null) {
    if (m.index !== consumed) throw new Error('XML non valido');
    consumed = re.lastIndex;
    const [, cdata, closing, tag, attrText, selfClose, text] = m;
    if (cdata !== undefined) top().children.push(cdata);
    else if (text !== undefined) top().children.push(decodeEntities(text));
    else if (tag !== undefined) {
      if (closing) {
        if (stack.length < 2 || top().name !== local(tag)) throw new Error('XML non valido');
        stack.pop();
      } else {
        const attrs: Record<string, string> = {};
        for (const a of (attrText ?? '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          attrs[local(a[1]!)] = decodeEntities(a[2] ?? a[3] ?? '');
        }
        const node: XmlNode = { name: local(tag), attrs, children: [] };
        top().children.push(node);
        if (!selfClose) stack.push(node);
      }
    }
  }
  if (consumed !== xml.length || stack.length !== 1) throw new Error('XML non valido');
  const el = root.children.find((c): c is XmlNode => typeof c !== 'string');
  if (!el) throw new Error('XML vuoto');
  return el;
}

const elements = (n: XmlNode, name?: string): XmlNode[] =>
  n.children.filter((c): c is XmlNode => typeof c !== 'string' && (!name || c.name === name));

/** `_x000D_` e simili (OOXML §22.4.2.4): i caratteri che l'XML non conserva, come il `\r`. */
const unescapeXlsx = (s: string): string =>
  s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Testo di un `<si>` o `<is>`: tutti i `<t>` (anche nei `<r>`), esclusa la fonetica `<rPh>`. */
function richText(n: XmlNode): string {
  let out = '';
  for (const c of n.children) {
    if (typeof c === 'string') continue;
    if (c.name === 't')
      out += unescapeXlsx(c.children.filter((x) => typeof x === 'string').join(''));
    else if (c.name !== 'rPh') out += richText(c);
  }
  return out;
}

const textOf = (n: XmlNode): string =>
  n.children.filter((x): x is string => typeof x === 'string').join('');

// ---------------------------------------------------------------------------
// Lettura
// ---------------------------------------------------------------------------

function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function numberText(v: string): string {
  const t = v.trim();
  return /^-?\d+\.0+$/.test(t) ? t.replace(/\.0+$/, '') : t;
}

function readSheetRows(sheet: XmlNode, shared: string[]): string[][] {
  const rows: string[][] = [];
  const data = elements(sheet, 'sheetData')[0];
  if (!data) return rows;
  let nextRow = 0;
  for (const row of elements(data, 'row')) {
    const rAttr = Number(row.attrs['r']);
    const rowIndex = Number.isInteger(rAttr) && rAttr > 0 ? rAttr - 1 : nextRow;
    if (rowIndex >= MAX_ROWS) throw new XlsxFormatError('FOGLIO_ILLEGGIBILE', 'riga fuori limite');
    nextRow = rowIndex + 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of elements(row, 'c')) {
      const ref = /^([A-Za-z]+)\d*$/.exec(c.attrs['r'] ?? '');
      const col = ref ? columnToIndex(ref[1]!) : nextCol;
      if (col >= MAX_COLS) throw new XlsxFormatError('FOGLIO_ILLEGGIBILE', 'colonna fuori limite');
      nextCol = col + 1;
      const type = c.attrs['t'] ?? 'n';
      const v = elements(c, 'v')[0];
      const vText = v ? textOf(v) : '';
      let value: string;
      if (type === 's') value = shared[Number(vText)] ?? '';
      else if (type === 'inlineStr') {
        const is = elements(c, 'is')[0];
        value = is ? richText(is) : '';
      } else if (type === 'b') value = vText.trim() === '1' ? 'True' : 'False';
      else if (type === 'n') value = numberText(vText);
      else value = vText;
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
  }
  return rows;
}

const normalizePath = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '' && seg !== '.') out.push(seg);
  }
  return out.join('/');
};

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** Tetto di ogni voce e, insieme, di tutto ciò che si gonfia. */
const MAX_INFLATED_TOTAL = 200 * 1024 * 1024;

/**
 * Gonfia solo le voci `names` (le altre restano compresse), rifiutando prima di gonfiare una voce
 * che dichiara più di quanto resta del tetto, e ricontrollando la misura reale dopo.
 * `budget.left` scende a ogni voce estratta.
 */
function inflateEntries(
  bytes: Uint8Array,
  names: ReadonlySet<string>,
  budget: { left: number },
): Record<string, Uint8Array> {
  let declared = 0;
  let tooBig = false;
  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(bytes, {
      filter: (f) => {
        if (!names.has(f.name) || tooBig) return false;
        declared += f.originalSize;
        if (f.originalSize > budget.left || declared > budget.left) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    throw new XlsxFormatError('NON_ZIP');
  }
  if (tooBig) throw new XlsxFormatError('NON_XLSX', 'troppo grande');
  let actual = 0;
  for (const v of Object.values(out)) actual += v.length;
  if (actual > budget.left) throw new XlsxFormatError('NON_XLSX', 'troppo grande');
  budget.left -= actual;
  return out;
}

const MAX_COLS = 16384;
const MAX_ROWS = 1048576;

export function readXlsx(bytes: Uint8Array): Sheet[] {
  if (bytes.length > MAX_ZIP_BYTES) throw new XlsxFormatError('NON_XLSX', 'file troppo grande');
  const budget = { left: MAX_INFLATED_TOTAL };
  const files: Record<string, Uint8Array> = inflateEntries(
    bytes,
    new Set([
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
    ]),
    budget,
  );
  const bookBytes = files['xl/workbook.xml'];
  if (!bookBytes) throw new XlsxFormatError('NON_XLSX');

  const xml = (path: string): XmlNode => {
    const f = files[path];
    if (!f) throw new XlsxFormatError('FOGLIO_ILLEGGIBILE', `${path} mancante`);
    try {
      return parseXml(strFromU8(f));
    } catch {
      throw new XlsxFormatError('FOGLIO_ILLEGGIBILE', path);
    }
  };

  let book: XmlNode;
  try {
    book = parseXml(strFromU8(bookBytes));
  } catch {
    throw new XlsxFormatError('NON_XLSX', 'workbook.xml');
  }
  const targets = new Map<string, string>();
  if (files['xl/_rels/workbook.xml.rels']) {
    for (const rel of elements(xml('xl/_rels/workbook.xml.rels'), 'Relationship')) {
      const id = rel.attrs['Id'];
      const target = rel.attrs['Target'];
      if (id && target) {
        targets.set(id, normalizePath(target.startsWith('/') ? target : `xl/${target}`));
      }
    }
  }
  // I fogli si gonfiano solo ora che si sa quali sono.
  const sheetPaths = new Set<string>();
  for (const t of targets.values()) sheetPaths.add(t);
  Object.assign(files, inflateEntries(bytes, sheetPaths, budget));
  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of elements(xml('xl/sharedStrings.xml'), 'si')) shared.push(richText(si));
  }

  const sheetsNode = elements(book, 'sheets')[0];
  const result: Sheet[] = [];
  for (const s of sheetsNode ? elements(sheetsNode, 'sheet') : []) {
    const path = targets.get(s.attrs['id'] ?? '');
    if (!path) throw new XlsxFormatError('FOGLIO_ILLEGGIBILE', s.attrs['name']);
    result.push({ name: s.attrs['name'] ?? '', rows: readSheetRows(xml(path), shared) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scrittura
// ---------------------------------------------------------------------------

// Caratteri di controllo non ammessi in XML 1.0 (restano \t \n \r).
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

const esc = (s: string): string =>
  s
    .replace(INVALID_XML, '')
    // Un `_x000D_` scritto davvero si protegge; il `\r` si scrive come lo vuole OOXML (l'XML lo perderebbe).
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/\r/g, '_x000D_')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Larghezza di ogni colonna in caratteri: la riga più lunga (le prime 200 righe), fra 8 e 60. */
function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const cells of rows.slice(0, 200)) {
    cells.forEach((v, c) => {
      const longest = Math.max(...v.split(/\r?\n/).map((l) => l.length));
      widths[c] = Math.max(widths[c] ?? 0, longest);
    });
  }
  return widths.map((w) => Math.min(60, Math.max(8, w + 2)));
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, r) => {
      // Prima riga: intestazione in grassetto (stile 1).
      const style = r === 0 ? ' s="1"' : '';
      const cs = cells
        .map((v, c) =>
          v === ''
            ? ''
            : `<c r="${columnName(c)}${r + 1}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
        )
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  const cols = columnWidths(rows)
    .map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  // Intestazione bloccata: la prima riga resta in vista scorrendo.
  const view =
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${rows.length > 0 ? view : ''}${cols === '' ? '' : `<cols>${cols}</cols>`}<sheetData>${body}</sheetData></worksheet>`;
}

export function writeXlsx(sheets: Sheet[]): Uint8Array {
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const files: Record<string, string> = {
    '[Content_Types].xml':
      head +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '</Types>',
    '_rels/.rels':
      head +
      `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':
      head +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_REL}"><sheets>` +
      sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      head +
      `<Relationships xmlns="${NS_PKG}">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
    'xl/styles.xml':
      head +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows);
  });
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
