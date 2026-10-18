import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  findDevice,
  memberAllowed,
  renameMemberWithOverrides,
  uniqueName,
  type Member,
  type PlcDevice,
} from '@baaportal/project';
import { ELEMENTARY_TYPES, PARAMETER_TYPES, parseType, sameName } from '@baaportal/s7-types';
import { DataGrid, type DataGridProps, type GridColumn } from '../../grid/DataGrid';
import { parseTsv } from '../../grid/tsv';
import { peekDrag } from '../../project/navigation/objectCommands';
import { useAppStore, useServices } from '../../state/AppContext';
import {
  cellKey,
  diagnosticCells,
  diagnosticText,
  useDeviceDiagnostics,
} from '../../state/diagnostics';
import { normalizeType } from '../tags/tagRows';
import {
  applyType,
  cloneMembers,
  findMember,
  interfaceNames,
  isStructType,
  listOf,
  membersFromTsv,
  membersToTsv,
  newMember,
  removeMembers,
  setOverride,
  setRecord,
} from './interfaceEdit';
import {
  addSlots,
  defaultExpanded,
  interfaceRows,
  ownerOf,
  type InterfaceOwner,
  type InterfaceRow,
  type SectionId,
} from './interfaceRows';

export interface InterfaceTarget {
  kind: 'block' | 'udt';
  id: string;
}

type MemberOwnerKind = 'OB' | 'FB' | 'FC' | 'DB' | 'UDT';

const newId = () => globalThis.crypto.randomUUID();
const rowKey = (r: InterfaceRow) => r.key;
const isFbIn = (device: PlcDevice) => (name: string) =>
  device.blocks.some((b) => b.kind === 'FB' && sameName(b.name, name));

// Sezione in cui si incolla quando non c'è una riga attiva.
const DEFAULT_SECTION: Record<MemberOwnerKind, SectionId> = {
  OB: 'temp',
  FB: 'static',
  FC: 'input',
  DB: 'members',
  UDT: 'members',
};

function typeSuggestions(
  device: PlcDevice,
  kind: MemberOwnerKind,
  section: SectionId,
  nested: boolean,
  selfId: string,
): string[] {
  if (section === 'return') return ['Void', ...ELEMENTARY_TYPES];
  const isFb = isFbIn(device);
  const out: string[] = [
    ...ELEMENTARY_TYPES,
    'String',
    'Date_And_Time',
    'Array[0..1] of Bool',
    'Struct',
    ...device.udts.map((u) => `"${u.name}"`),
  ];
  if (nested) return out;
  if (kind === 'FB' && section === 'static')
    for (const b of device.blocks) if (b.kind === 'FB' && b.id !== selfId) out.push(`"${b.name}"`);
  for (const p of PARAMETER_TYPES)
    if (memberAllowed(kind, section, { kind: 'parameter', name: p }, isFb)) out.push(p);
  return out;
}

interface Props {
  deviceId: string;
  target: InterfaceTarget;
  label: string;
  /** Intestazione della colonna dei valori: "Valore predefinito" o, nei DB, "Valore iniziale". */
  valueHeaderKey: 'block.col.default' | 'block.col.initial';
}

export function InterfaceTable({ deviceId, target, label, valueHeaderKey }: Props) {
  const { t } = useTranslation();
  const { store } = useServices();
  const device = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const diagnostics = useDeviceDiagnostics(deviceId);
  const owner = useMemo(
    () => (device ? ownerOf(device, target) : undefined),
    [device, target.kind, target.id],
  );
  const ownerKind = owner?.kind;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(ownerKind ? defaultExpanded(ownerKind) : []),
  );
  const toggle = useCallback(
    (key: string) =>
      setExpanded((cur) => {
        const next = new Set(cur);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const expand = useCallback(
    (key: string) => setExpanded((cur) => (cur.has(key) ? cur : new Set(cur).add(key))),
    [],
  );

  const rows = useMemo(
    () => (owner && device ? interfaceRows(owner, device, expanded) : []),
    [owner, device, expanded],
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const slots = useMemo(
    () => (ownerKind ? addSlots(rows, ownerKind, expanded) : []),
    [rows, ownerKind, expanded],
  );

  const cellDiag = useMemo(() => {
    const mine = diagnostics.filter((d) => d.ref.kind === 'member' && d.ref.ownerId === target.id);
    return diagnosticCells(mine, 'member', t);
  }, [diagnostics, target.id, t]);
  const problems = useMemo(
    () =>
      diagnostics
        .filter(
          (d) =>
            (d.ref.kind === 'block' || d.ref.kind === 'udt') &&
            d.ref.id === target.id &&
            (d.field === 'type' || d.field === 'value') &&
            d.code !== 'INSTANCE_FB_MISSING',
        )
        .map((d) => {
          const path = d.params?.path;
          return {
            text: `${diagnosticText(d, t)}${path ? ` (${path})` : ''}`,
            // Un valore su un percorso che non porta più a un membro non ha riga: si toglie da qui.
            orphan: path !== undefined && d.params?.reason === 'PATH_NOT_FOUND' ? path : null,
          };
        }),
    [diagnostics, target.id, t],
  );

  const edit = useCallback(
    (labelKey: string, recipe: (dev: PlcDevice, owner: InterfaceOwner) => void) =>
      store.getState().edit(labelKey, (p) => {
        const dev = findDevice(p, deviceId);
        const o = dev && ownerOf(dev, target);
        if (dev && o) recipe(dev, o);
      }),
    [store, deviceId, target.kind, target.id],
  );

  const suggestOwner = ownerKind === 'IDB' ? undefined : ownerKind;
  const columns = useMemo<GridColumn<InterfaceRow>[]>(
    () => [
      {
        id: 'name',
        headerKey: 'block.col.name',
        width: 200,
        editor: 'text',
        get: (r) => r.name,
        readOnly: (r) => !r.editable.name,
      },
      {
        id: 'type',
        headerKey: 'block.col.type',
        width: 170,
        editor: 'type',
        get: (r) => r.type,
        readOnly: (r) => !r.editable.type,
        suggestions: (r) =>
          device && suggestOwner
            ? typeSuggestions(
                device,
                suggestOwner,
                r.section,
                r.parentKey !== null && !r.parentKey.startsWith('section:'),
                target.id,
              )
            : [],
      },
      {
        id: 'offset',
        headerKey: 'block.col.offset',
        width: 80,
        editor: 'none',
        get: (r) => r.offset,
      },
      {
        id: 'value',
        headerKey: valueHeaderKey,
        headerTitleKey:
          valueHeaderKey === 'block.col.default' ? 'block.col.defaultHint' : undefined,
        width: 150,
        editor: 'text',
        // Vuoto: si mostra in grigio il valore di partenza del tipo (non viene salvato).
        get: (r) => (r.initial !== '' ? r.initial : r.defaultValue),
        readOnly: (r) => !r.editable.initial,
      },
      {
        id: 'comment',
        headerKey: 'block.col.comment',
        width: 240,
        editor: 'text',
        get: (r) => r.comment,
        readOnly: (r) => !r.editable.comment,
      },
    ],
    [valueHeaderKey, device?.udts, device?.blocks, suggestOwner, target.id],
  );

  const onCommit = useCallback<DataGridProps<InterfaceRow>['onCommit']>(
    (key, columnId, value) => {
      const row = byKey.get(key);
      if (!row || typeof value !== 'string') return;
      const field = columnId === 'value' ? 'initial' : (columnId as 'name' | 'type' | 'comment');
      if (!row.editable[field]) return;
      edit('history.editCell', (dev, o) => {
        if (key === 'return') {
          if (o.kind === 'FC') o.block.interface.returnType = normalizeType(value);
          return;
        }
        if (field === 'initial') {
          if (o.kind === 'IDB') return setRecord(o.db.overrides, row.overridePath ?? '', value);
          const m = row.memberId ? findMember(o, row.memberId)?.member : undefined;
          if (!m) return;
          if (row.overridePath !== undefined) setOverride(m, row.overridePath, value);
          else if (value === '') delete m.initial;
          else m.initial = value;
          return;
        }
        const m = row.memberId ? findMember(o, row.memberId)?.member : undefined;
        if (!m) return;
        // I valori sostituiti altrove (DB di istanza, membri di questo tipo) seguono il nome.
        if (field === 'name')
          renameMemberWithOverrides(dev, { kind: target.kind, id: target.id }, m.id, value);
        else if (field === 'comment') m.comment = value;
        else applyType(m, value);
      });
      if (field === 'type' && isStructType(normalizeType(value))) expand(key);
    },
    [byKey, edit, expand, target.kind, target.id],
  );

  const removeOrphan = useCallback(
    (path: string) =>
      edit('history.removeOverride', (_dev, o) => {
        if (o.kind === 'IDB') delete o.db.overrides[path];
      }),
    [edit],
  );

  const addRow = useMemo<NonNullable<DataGridProps<InterfaceRow>['addRow']>>(
    () =>
      slots.map((slot) => ({
        afterKey: slot.afterKey,
        labelKey: 'grid.addRow',
        onAdd: (columnId, value) => {
          const id = newId();
          edit('history.addRow', (_dev, o) => {
            const list =
              slot.containerKey === null || slot.containerKey.startsWith('section:')
                ? listOf(o, slot.section)
                : (findMember(o, slot.containerKey)?.member.members ?? null);
            if (!list) return;
            const names = [...interfaceNames(o), ...list.map((m) => m.name)];
            const m = newMember(
              id,
              columnId === 'name' ? value : uniqueName(t('defaults.tag'), names),
            );
            if (columnId === 'type') {
              m.type = normalizeType(value);
              if (isStructType(m.type)) m.members = [];
            } else if (columnId === 'value') m.initial = value;
            else if (columnId === 'comment') m.comment = value;
            list.push(m);
          });
          if (columnId === 'type' && isStructType(normalizeType(value))) expand(id);
        },
      })),
    [slots, edit, expand, t],
  );

  const onDeleteRows = useCallback(
    (keys: string[]) => {
      const gone = new Set(
        keys.flatMap((k) => {
          const r = byKey.get(k);
          return r && r.kind === 'member' && r.memberId && r.editable.name ? [r.memberId] : [];
        }),
      );
      if (gone.size === 0) return;
      edit('history.deleteRows', (_dev, o) => removeMembers(o, gone));
    },
    [byKey, edit],
  );

  // Righe copiabili: membri veri; quelle dentro una struct copiata sono già nella copia.
  const copyable = useCallback(
    (keys: string[]): Member[] => {
      if (!owner) return [];
      const chosen = new Set(keys);
      const underChosen = (r: InterfaceRow): boolean => {
        for (let p = r.parentKey; p !== null; p = byKey.get(p)?.parentKey ?? null)
          if (chosen.has(p)) return true;
        return false;
      };
      return keys.flatMap((k) => {
        const r = byKey.get(k);
        if (!r || r.kind !== 'member' || !r.memberId || r.readOnly || underChosen(r)) return [];
        const m = findMember(owner, r.memberId)?.member;
        return m ? [m] : [];
      });
    },
    [owner, byKey],
  );
  const copyRows = useCallback<NonNullable<DataGridProps<InterfaceRow>['copyRows']>>(
    (keys) => {
      const members = copyable(keys);
      return {
        text: membersToTsv(members),
        payload: { kind: 'rows', rowKind: 'member', rows: members },
      };
    },
    [copyable],
  );

  const onPaste = useCallback<NonNullable<DataGridProps<InterfaceRow>['onPaste']>>(
    (text, payload, atKey) => {
      let make: (taken: string[]) => Member[];
      if (payload) {
        if (payload.kind !== 'rows' || payload.rowKind !== 'member') return;
        make = (taken) => cloneMembers(payload.rows, taken, newId);
      } else {
        if (text.trim() === '') return;
        const parsed = parseTsv(text);
        make = (taken) => membersFromTsv(parsed, taken, newId);
      }
      const at = atKey === null ? undefined : byKey.get(atKey);
      edit('history.pasteRows', (_dev, o) => {
        let list: Member[] | null = null;
        let index = -1;
        if (at?.kind === 'section') {
          list = listOf(o, at.section);
          index = 0;
        } else if (at?.memberId) {
          const found = findMember(o, at.memberId);
          if (found) {
            list = found.list;
            index = found.list.indexOf(found.member) + 1;
          }
        }
        if (!list) {
          list = listOf(o, DEFAULT_SECTION[o.kind as MemberOwnerKind]);
          index = list?.length ?? 0;
        }
        if (!list) return;
        const fresh = make(interfaceNames(o));
        if (fresh.length > 0) list.splice(index, 0, ...fresh);
      });
    },
    [byKey, edit],
  );

  // --- Trascinamento di UDT e FB dall'albero ---
  const dropInfo = useCallback(
    (key: string | null): { section: SectionId; name: string; isFb: boolean } | null => {
      const drag = peekDrag();
      const row = key === null ? undefined : byKey.get(key);
      if (!drag || !device || !suggestOwner || !row || drag.deviceId !== deviceId) return null;
      if (drag.refs.length !== 1) return null;
      const ref = drag.refs[0]!;
      let name: string | undefined;
      let isFb = false;
      if (ref.kind === 'udt') {
        const u = device.udts.find((x) => x.id === ref.id);
        if (u && !(target.kind === 'udt' && u.id === target.id)) name = u.name;
      } else if (ref.kind === 'block') {
        const b = device.blocks.find((x) => x.id === ref.id);
        if (b?.kind === 'FB' && !(target.kind === 'block' && b.id === target.id)) {
          name = b.name;
          isFb = true;
        }
      }
      if (name === undefined) return null;
      const type = parseType(`"${name}"`);
      if (!type.ok || !memberAllowed(suggestOwner, row.section, type.type, isFbIn(device)))
        return null;
      return { section: row.section, name, isFb };
    },
    [byKey, device, suggestOwner, deviceId, target.kind, target.id],
  );

  const onDragOverRow = useCallback<NonNullable<DataGridProps<InterfaceRow>['onDragOverRow']>>(
    (e, key) => {
      const ok = dropInfo(key) !== null;
      if (ok) e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
    },
    [dropInfo],
  );
  const onDropOnRow = useCallback<NonNullable<DataGridProps<InterfaceRow>['onDropOnRow']>>(
    (_e, key) => {
      const info = dropInfo(key);
      if (!info) return;
      edit('history.addMember', (_dev, o) => {
        const list = listOf(o, info.section);
        if (!list) return;
        const name = uniqueName(info.isFb ? `${info.name}_Instance` : `${info.name}_1`, [
          ...interfaceNames(o),
        ]);
        list.push({ ...newMember(newId(), name), type: `"${info.name}"` });
      });
    },
    [dropInfo, edit],
  );

  const rowSelectable = useCallback(
    (r: InterfaceRow) =>
      r.kind === 'member' && !r.readOnly && r.key !== 'return' && r.editable.name,
    [],
  );
  const diagnostic = useCallback(
    (key: string, columnId: string) => cellDiag.get(cellKey(key, columnId)),
    [cellDiag],
  );
  const depth = useCallback((r: InterfaceRow) => r.depth, []);
  const expandable = useCallback((r: InterfaceRow) => r.expandable, []);
  const rowClassName = useCallback(
    (r: InterfaceRow) =>
      r.kind === 'section' ? 'is-section' : r.readOnly ? 'is-muted' : undefined,
    [],
  );
  const cellClassName = useCallback(
    (r: InterfaceRow, col: string) =>
      col === 'value' && r.initial === '' && r.defaultValue !== '' ? 'is-placeholder' : undefined,
    [],
  );

  if (!owner) return null;
  const editable = owner.kind !== 'IDB';
  return (
    <>
      {problems.length > 0 ? (
        <ul className="baa-block-problems" aria-label={t('block.problems')}>
          {problems.map((p, i) => (
            <li key={i}>
              {p.text}
              {p.orphan !== null ? (
                <button
                  type="button"
                  className="baa-block-problem-action"
                  aria-label={t('block.removeOverrideLabel', { path: p.orphan })}
                  onClick={() => removeOrphan(p.orphan!)}
                >
                  {t('block.removeOverride')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <DataGrid<InterfaceRow>
        label={label}
        rows={rows}
        rowKey={rowKey}
        columns={columns}
        depth={depth}
        expandable={expandable}
        expanded={expanded}
        onToggleExpand={toggle}
        rowSelectable={rowSelectable}
        onCommit={onCommit}
        addRow={addRow}
        onDeleteRows={editable ? onDeleteRows : undefined}
        copyRows={copyRows}
        onPaste={editable ? onPaste : undefined}
        diagnostic={diagnostic}
        onDragOverRow={editable ? onDragOverRow : undefined}
        onDropOnRow={editable ? onDropOnRow : undefined}
        rowClassName={rowClassName}
        cellClassName={cellClassName}
      />
    </>
  );
}
