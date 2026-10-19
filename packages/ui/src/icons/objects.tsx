import type { FC, ReactNode } from 'react';
import { registerIcon, type IconName } from './index';

function make(children: ReactNode): FC<{ size: number }> {
  return function ObjectSvg({ size }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
    );
  };
}

// Colori per tipo di oggetto (spec §8.2).
const COLOR = {
  ob: '#7b4fbf',
  fb: '#2f6fd0',
  fc: '#2e9a4f',
  db: '#b07a2a',
  udt: '#1e8c8c',
  table: '#d9822b',
  folder: '#7d8a91',
  cpu: '#3d4f5a',
};

/** Pagina con angolo piegato nel colore dato e una sigla di due tratti al centro. */
const page = (color: string, mark: ReactNode): ReactNode => (
  <>
    <path d="M3.5 1.5h6l3 3v10h-9z" stroke={color} fill={color} fillOpacity={0.14} />
    <path d="M9.5 1.5v3h3" stroke={color} />
    {mark}
  </>
);

const shapes: Partial<Record<IconName, ReactNode>> = {
  objCpu: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="1" stroke={COLOR.cpu} />
      <rect x="6" y="6" width="4" height="4" fill={COLOR.cpu} stroke="none" />
      <path
        d="M6 1.5v1.5M10 1.5v1.5M6 13v1.5M10 13v1.5M1.5 6h1.5M1.5 10h1.5M13 6h1.5M13 10h1.5"
        stroke={COLOR.cpu}
      />
    </>
  ),
  objOb: page(COLOR.ob, <circle cx="8" cy="10" r="2" stroke={COLOR.ob} />),
  objFb: page(COLOR.fb, <path d="M6 8.5h3M6 8.5v3M6 10h2" stroke={COLOR.fb} />),
  objFc: page(COLOR.fc, <path d="M9.5 8.5h-3v3M6.5 10h2" stroke={COLOR.fc} />),
  objDb: page(COLOR.db, <path d="M6 8.5v3M6 8.5h1.5a1.5 1.5 0 0 1 0 3H6" stroke={COLOR.db} />),
  objIdb: page(
    COLOR.db,
    <>
      <path d="M5.5 8.5v3M5.5 8.5h1.5a1.5 1.5 0 0 1 0 3H5.5" stroke={COLOR.db} />
      <circle cx="10.5" cy="10" r="0.9" fill={COLOR.db} stroke="none" />
    </>,
  ),
  objUdt: page(COLOR.udt, <path d="M6 8.5v2a1.5 1.5 0 0 0 3 0v-2" stroke={COLOR.udt} />),
  objSource: page(
    COLOR.folder,
    <path d="M7 8.2 5.8 9.6 7 11M9 8.2l1.2 1.4L9 11" stroke={COLOR.folder} />,
  ),
  objTagTable: (
    <>
      <rect
        x="2"
        y="3"
        width="12"
        height="10"
        rx="1"
        stroke={COLOR.table}
        fill={COLOR.table}
        fillOpacity={0.14}
      />
      <path d="M2 6.5h12M2 9.8h12M6 3v10" stroke={COLOR.table} />
    </>
  ),
  objGroup: (
    <path
      d="M1.5 4h4.5l1.5 1.5h7v7.5h-13z"
      stroke={COLOR.folder}
      fill={COLOR.folder}
      fillOpacity={0.2}
    />
  ),
};

// Cartelle del PLC: la stessa cartella con un segno distintivo.
const folder = (mark: ReactNode): ReactNode => (
  <>
    <path
      d="M1.5 4h4.5l1.5 1.5h7v7.5h-13z"
      stroke={COLOR.folder}
      fill={COLOR.folder}
      fillOpacity={0.2}
    />
    {mark}
  </>
);
const m = { stroke: '#4a5860' } as const;
shapes.treeBlocks = folder(<path d="M5 9h6M5 11.2h4" {...m} />);
shapes.treeTags = folder(<path d="M5 8.2h6M5 10.2h6M8 7v4" {...m} />);
shapes.treeTypes = folder(<path d="M6 8v2a2 2 0 0 0 4 0V8" {...m} />);
shapes.treeDeviceConfig = folder(<rect x="5.5" y="8" width="5" height="3.5" {...m} />);
shapes.treeOnlineDiag = folder(<path d="M5 10.5h1.5l1-2.5 1.5 4 1-1.5H11" {...m} />);
shapes.treeSources = folder(<path d="M7 8.2 5.5 9.7 7 11.2M9 8.2l1.5 1.5L9 11.2" {...m} />);
shapes.treeWatch = folder(<path d="M4.8 9.8c1.5-2 4.9-2 6.4 0-1.5 2-4.9 2-6.4 0z" {...m} />);
shapes.treeBackup = folder(<path d="M8 8v3.2M6.5 9.7 8 11.2l1.5-1.5" {...m} />);
shapes.treeProgInfo = folder(<path d="M8 11V9M8 7.6v.1" {...m} />);
shapes.treeAdd = (
  <>
    <circle cx="8" cy="8" r="6" stroke="#2e9a4f" fill="#2e9a4f" fillOpacity={0.14} />
    <path d="M8 5v6M5 8h6" stroke="#2e9a4f" />
  </>
);
shapes.editorWindow = (
  <>
    <rect x="2" y="3" width="12" height="10" rx="1" stroke="#4a5860" />
    <path d="M2 6h12" stroke="#4a5860" />
  </>
);

for (const [name, node] of Object.entries(shapes) as [IconName, ReactNode][])
  registerIcon(name, make(node));
