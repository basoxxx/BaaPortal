import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createUdt,
  type CodeBlock,
  type Member,
  type PlcDevice,
  type Tag,
} from '@baaportal/project';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addGroup,
  canRename,
  canRenameGroup,
  deleteGroup,
  deleteObjects,
  moveTags,
  moveToGroup,
  pasteObjects,
  renameGroup,
} from '../src/project/objectActions';
import {
  copyToClipboard,
  forgetClipboard,
  readClipboard,
  type ClipboardPayload,
} from '../src/services/clipboard';
import { FakeBridge } from './fakeBridge';

const cpu = findCpu('cpu-315-2-pn-dp')!;
let counter = 0;
const newId = () => `n${++counter}`;
const device = (name = 'PLC_1'): PlcDevice =>
  createPlcDevice({
    cpu,
    orderNumber: 'x',
    firmware: 'V3.3',
    name,
    texts: { defaultTagTable: 'Standard' },
    newId,
  });
const member = (name: string, children: Member[] = []): Member => ({
  id: newId(),
  name,
  type: 'Int',
  comment: '',
  ...(children.length ? { members: children } : {}),
});

function fbNastro(): CodeBlock {
  const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL', newId });
  fb.interface.static.push(member('Gruppo', [member('Velocita')]));
  return fb;
}
const payloadOf = (d: PlcDevice, blocks: CodeBlock[] = []) =>
  ({
    kind: 'objects',
    deviceId: d.id,
    items: blocks.map((block) => ({ type: 'block' as const, block })),
  }) satisfies ClipboardPayload;

beforeEach(() => {
  counter = 0;
  forgetClipboard();
});

describe('pasteObjects', () => {
  it('copia di un FB nello stesso PLC: nome _1, numero libero, id nuovi a ogni livello', () => {
    const d = device();
    const fb = fbNastro();
    d.blocks.push(fb);
    const refs = pasteObjects(d, payloadOf(d, [fb]), '', cpu, newId);
    expect(refs).toHaveLength(1);
    const copy = d.blocks.find((b) => b.name === 'Nastro_1') as CodeBlock;
    expect(copy).toMatchObject({ kind: 'FB', number: 2, group: '' });
    expect(refs[0]).toEqual({ kind: 'block', deviceId: d.id, id: copy.id });
    expect(copy.id).not.toBe(fb.id);
    expect(copy.networks[0]!.id).not.toBe(fb.networks[0]!.id);
    const inner = copy.interface.static[0]!.members![0]!;
    expect(inner.name).toBe('Velocita');
    expect(inner.id).not.toBe(fb.interface.static[0]!.members![0]!.id);
    // l'originale non cambia
    expect(fb.name).toBe('Nastro');
  });

  it('in un altro PLC conserva nome e numero se liberi, e il gruppo indicato', () => {
    const a = device('A');
    const b = device('B');
    const fb = fbNastro();
    a.blocks.push(fb);
    pasteObjects(b, payloadOf(a, [fb]), 'Linea', cpu, newId);
    expect(b.blocks.find((x) => x.name === 'Nastro')).toMatchObject({ number: 1, group: 'Linea' });
  });

  it('DB e DB di istanza condividono i numeri', () => {
    const d = device();
    const db = createGlobalDb({ number: 5, name: 'Dati', newId });
    const idb = createInstanceDb({ number: 5, name: 'Dati_1', instanceOf: 'X', newId });
    d.blocks.push(idb);
    pasteObjects(d, payloadOf(d, [db as unknown as CodeBlock]), '', cpu, newId);
    expect(d.blocks.find((x) => x.id !== idb.id && x.kind === 'DB')!.number).toBe(1);
  });

  it('un FB e il suo DB di istanza incollati insieme restano collegati', () => {
    const d = device();
    const fb = fbNastro();
    const idb = createInstanceDb({ number: 1, name: 'Nastro_DB', instanceOf: 'Nastro', newId });
    d.blocks.push(fb, idb);
    pasteObjects(d, payloadOf(d, [fb, idb as unknown as CodeBlock]), '', cpu, newId);
    const copy = d.blocks.find((b) => b.kind === 'IDB' && b.id !== idb.id);
    expect(copy).toMatchObject({ name: 'Nastro_DB_1', instanceOf: 'Nastro_1' });
  });

  it('senza numeri liberi il blocco viene saltato', () => {
    const d = device();
    const fb = fbNastro();
    d.blocks.push(fb);
    const tiny = { ...cpu, limits: { ...cpu.limits, maxFb: 1 } };
    const refs = pasteObjects(d, payloadOf(d, [fb]), '', tiny, newId);
    expect(refs).toEqual([]);
    expect(d.blocks).toHaveLength(2);
  });

  it('tabelle: nome unico fra le tabelle, tag con id nuovi e nomi liberi', () => {
    const d = device();
    const table = d.tagTables[0]!;
    const tag: Tag = {
      id: newId(),
      name: 'Motore',
      type: 'Bool',
      address: '%M0.0',
      hmi: false,
      comment: '',
    };
    table.tags.push(tag);
    const refs = pasteObjects(
      d,
      { kind: 'objects', deviceId: d.id, items: [{ type: 'tagTable', table }] },
      '',
      cpu,
      newId,
    );
    expect(refs).toHaveLength(1);
    const copy = d.tagTables[1]!;
    expect(copy.name).toBe('Standard_1');
    expect(copy.tags[0]!.id).not.toBe(tag.id);
    expect(copy.tags[0]!.name).toBe('Motore_1');
  });

  it('copia di una tabella con 1000 tag Variabile_1..1000 nello stesso PLC in meno di un secondo', () => {
    const d = device();
    const table = d.tagTables[0]!;
    for (let i = 1; i <= 1000; i++)
      table.tags.push({
        id: newId(),
        name: `Variabile_${i}`,
        type: 'Bool',
        address: `%M${(i - 1) >> 3}.${(i - 1) & 7}`,
        hmi: true,
        comment: '',
      });
    const t0 = performance.now();
    pasteObjects(
      d,
      { kind: 'objects', deviceId: d.id, items: [{ type: 'tagTable', table }] },
      '',
      cpu,
      newId,
    );
    const ms = performance.now() - t0;
    const copy = d.tagTables[1]!;
    expect(copy.tags.map((t) => t.name).slice(0, 2)).toEqual(['Variabile_1001', 'Variabile_1002']);
    expect(new Set(copy.tags.map((t) => t.name)).size).toBe(1000);
    expect(ms).toBeLessThan(1000);
  });

  it('UDT: nome unico nello spazio dei simboli e numero libero', () => {
    const d = device();
    const u = createUdt({ name: 'Motore', number: 1, newId });
    u.members.push(member('a'));
    d.udts.push(u);
    pasteObjects(
      d,
      { kind: 'objects', deviceId: d.id, items: [{ type: 'udt', udt: u }] },
      'G',
      cpu,
      newId,
    );
    expect(d.udts[1]).toMatchObject({ name: 'Motore_1', number: 2, group: 'G' });
    expect(d.udts[1]!.members[0]!.id).not.toBe(u.members[0]!.id);
  });
});

describe('eliminazione, spostamento e nomi', () => {
  it('deleteObjects toglie blocchi e UDT ma lascia la tabella standard', () => {
    const d = device();
    const fb = fbNastro();
    d.blocks.push(fb);
    const extra = { ...d.tagTables[0]!, id: 'extra', name: 'Altra' };
    d.tagTables.push(extra);
    const std = d.tagTables[0]!;
    deleteObjects(d, [
      { kind: 'block', deviceId: d.id, id: fb.id },
      { kind: 'tagTable', deviceId: d.id, id: std.id },
      { kind: 'tagTable', deviceId: d.id, id: 'extra' },
    ]);
    expect(d.blocks.map((b) => b.name)).toEqual(['Main']);
    expect(d.tagTables.map((t) => t.id)).toEqual([std.id]);
  });

  it('moveToGroup cambia il gruppo di blocchi, tabelle e UDT', () => {
    const d = device();
    const u = createUdt({ name: 'U', number: 1, newId });
    d.udts.push(u);
    moveToGroup(
      d,
      [
        { kind: 'block', deviceId: d.id, id: d.blocks[0]!.id },
        { kind: 'udt', deviceId: d.id, id: u.id },
        { kind: 'tagTable', deviceId: d.id, id: d.tagTables[0]!.id },
      ],
      'A/B',
    );
    expect([d.blocks[0]!.group, u.group, d.tagTables[0]!.group]).toEqual(['A/B', 'A/B', 'A/B']);
  });

  it('moveTags sposta i tag in coda alla tabella di arrivo', () => {
    const d = device();
    const from = d.tagTables[0]!;
    const to = { ...from, id: 'to', name: 'To', tags: [], constants: [] };
    d.tagTables.push(to);
    const mk = (name: string): Tag => ({
      id: newId(),
      name,
      type: 'Bool',
      address: '',
      hmi: false,
      comment: '',
    });
    from.tags.push(mk('a'), mk('b'), mk('c'));
    const [a, , c] = from.tags;
    moveTags(
      d,
      [a!, c!].map((t) => ({ kind: 'tag' as const, deviceId: d.id, tableId: from.id, id: t.id })),
      'to',
    );
    expect(from.tags.map((t) => t.name)).toEqual(['b']);
    expect(to.tags.map((t) => t.name)).toEqual(['a', 'c']);
  });

  it('canRename: INVALID, DUPLICATE (senza distinguere maiuscole), null con il nome proprio', () => {
    const d = device();
    const fb = fbNastro();
    d.blocks.push(fb);
    const ref = { kind: 'block' as const, deviceId: d.id, id: fb.id };
    expect(canRename(d, ref, '')).toBe('INVALID');
    expect(canRename(d, ref, 'a"b')).toBe('INVALID');
    expect(canRename(d, ref, 'main')).toBe('DUPLICATE');
    expect(canRename(d, ref, 'NASTRO')).toBeNull();
    expect(canRename(d, ref, 'Altro')).toBeNull();
    const tref = { kind: 'tagTable' as const, deviceId: d.id, id: d.tagTables[0]!.id };
    expect(canRename(d, tref, 'Nastro')).toBeNull(); // le tabelle non sono simboli
  });
});

describe('gruppi', () => {
  it('addGroup aggiunge il percorso; renameGroup e deleteGroup agiscono su tutto il sottoalbero', () => {
    const d = device();
    expect(addGroup(d, 'blocks', '', 'A')).toBe('A');
    expect(addGroup(d, 'blocks', 'A', 'B')).toBe('A/B');
    d.blocks[0]!.group = 'A/B';
    const fb = fbNastro();
    fb.group = 'A';
    d.blocks.push(fb);
    renameGroup(d, 'blocks', 'A', 'Z');
    expect(d.groups.blocks).toEqual(['Z', 'Z/B']);
    expect(d.blocks.map((b) => b.group)).toEqual(['Z/B', 'Z']);
    deleteGroup(d, 'blocks', 'Z');
    expect(d.groups.blocks).toEqual([]);
    expect(d.blocks).toEqual([]);
  });

  it('canRenameGroup: nome non valido o con "/" e duplicati fra fratelli', () => {
    const d = device();
    addGroup(d, 'tags', '', 'A');
    addGroup(d, 'tags', '', 'B');
    expect(canRenameGroup(d, 'tags', 'A', 'B')).toBe('DUPLICATE');
    expect(canRenameGroup(d, 'tags', 'A', 'a')).toBeNull();
    expect(canRenameGroup(d, 'tags', 'A', 'x/y')).toBe('INVALID');
    expect(canRenameGroup(d, 'tags', 'A', '')).toBe('INVALID');
  });
});

describe('appunti', () => {
  it('il payload torna solo se il testo di sistema è quello copiato', async () => {
    const bridge = new FakeBridge();
    const d = device();
    const payload = payloadOf(d, [fbNastro()]);
    copyToClipboard(bridge, 'Nastro', payload);
    expect(bridge.clipboard).toBe('Nastro');
    expect(await readClipboard(bridge)).toEqual({ text: 'Nastro', payload });
    bridge.clipboard = 'altro testo';
    expect(await readClipboard(bridge)).toEqual({ text: 'altro testo', payload: null });
  });
});
