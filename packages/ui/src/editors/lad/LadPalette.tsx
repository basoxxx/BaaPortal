// Tavolozza delle istruzioni KOP: un clic inserisce nella selezione dell'editor attivo, il
// trascinamento rilascia sul segmento.
import { useSyncExternalStore } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { BOX_CATALOG, PALETTE } from '@baaportal/ladfbd';
import { findDevice } from '@baaportal/project';
import type { BoxGroup, BoxKind } from '@baaportal/ladfbd';
import { LAD_DRAG_TYPE } from './LadNetworkEditor';
import { useAppStore } from '../../state/AppContext';
import { activeLad, subscribeLad } from './ladActive';

type Group =
  | 'bitLogic'
  | 'timers'
  | 'counters'
  | 'compare'
  | 'move'
  | 'math'
  | 'convert'
  | 'wordLogic'
  | 'shift'
  | 'jumps'
  | 'program';
const GROUPS: Group[] = [
  'bitLogic',
  'timers',
  'counters',
  'compare',
  'move',
  'math',
  'convert',
  'wordLogic',
  'shift',
  'jumps',
  'program',
];

const OF_PALETTE: Record<string, Group> = {
  bits: 'bitLogic',
  edge: 'bitLogic',
  outputs: 'bitLogic',
  compare: 'compare',
  timers: 'timers',
  counters: 'counters',
  call: 'program',
};
const OF_BOX: Record<BoxGroup, Group> = {
  bistable: 'bitLogic',
  timer: 'timers',
  counter: 'counters',
  move: 'move',
  math: 'math',
  convert: 'convert',
  wordLogic: 'wordLogic',
  shift: 'shift',
  call: 'program',
};
const JUMPS = new Set(['jmp', 'jmpn']);

type Item = { key: string; label: string; payload: { palette: string } | { box: BoxKind } };

function itemsByGroup(): Map<Group, Item[]> {
  const by = new Map<Group, Item[]>(GROUPS.map((g) => [g, []]));
  for (const p of PALETTE) {
    const g = JUMPS.has(p.id) ? 'jumps' : p.group === 'flow' ? 'program' : OF_PALETTE[p.group]!;
    by.get(g)!.push({ key: `p-${p.id}`, label: p.label, payload: { palette: p.id } });
  }
  for (const d of Object.values(BOX_CATALOG)) {
    by.get(OF_BOX[d.group])!.push({
      key: `b-${d.kind}`,
      label: `lad.box.${d.kind}`,
      payload: { box: d.kind },
    });
  }
  return by;
}
const ITEMS = itemsByGroup();

export function LadPalette() {
  const { t } = useTranslation();
  const active = useSyncExternalStore(subscribeLad, activeLad);
  // L'editor del blocco visibile nel riquadro con il focus: solo a lui si inserisce.
  const visible = useAppStore((s) => {
    const wa = s.workArea;
    const key = wa.panes[wa.focusedPane];
    const e = wa.editors.find((x) => x.key === key);
    return e?.kind === 'block' ? `${e.deviceId}/${e.objectId}` : null;
  });
  const fup = useAppStore((s) => {
    const wa = s.workArea;
    const e = wa.editors.find((x) => x.key === wa.panes[wa.focusedPane]);
    const b =
      e?.kind === 'block' && s.doc
        ? findDevice(s.doc.project, e.deviceId)?.blocks.find((x) => x.id === e.objectId)
        : undefined;
    return b !== undefined && b.kind !== 'DB' && b.kind !== 'IDB' && b.language === 'FUP';
  });
  const ready = active !== null && visible === `${active.deviceId}/${active.blockId}`;
  const click = (item: Item) => {
    const api = ready ? active.api : null;
    if (!api) return;
    if ('palette' in item.payload) api.insertPalette(item.payload.palette);
    else api.insertBox(item.payload.box);
  };
  const drag = (e: DragEvent<HTMLButtonElement>, item: Item) => {
    e.dataTransfer.setData(LAD_DRAG_TYPE, JSON.stringify(item.payload));
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div className="baa-lad-palette" data-testid="lad-palette">
      {GROUPS.map((g) => (
        <div key={g} role="group" aria-label={t(`lad.palettePanel.${g}`)}>
          <div className="baa-lad-palette-head">{t(`lad.palettePanel.${g}`)}</div>
          {ITEMS.get(g)!.map((item) => (
            <button
              key={item.key}
              type="button"
              draggable
              disabled={!ready}
              title={ready ? undefined : t(fup ? 'lad.fupHint' : 'lad.palettePanel.noTarget')}
              onClick={() => click(item)}
              onDragStart={(e) => drag(e, item)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
