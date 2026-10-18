import type { FC, ReactNode } from 'react';
import { registerIcon, type IconName } from './index';

function make(children: ReactNode): FC<{ size: number }> {
  return function ToolbarSvg({ size }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
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

const shapes: Partial<Record<IconName, ReactNode>> = {
  new: (
    <>
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13M8.5 8v4M6.5 10h4" />
    </>
  ),
  open: <path d="M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />,
  save: (
    <>
      <path d="M2.5 2.5h9l2 2v9h-11z" />
      <path d="M5 2.5v3.5h5V2.5M5 13.5v-4h6v4" />
    </>
  ),
  print: (
    <>
      <path d="M4.5 5.5v-3h7v3M4.5 11.5h-2v-6h11v6h-2" />
      <path d="M4.5 9.5h7v4h-7z" />
    </>
  ),
  cut: (
    <>
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="11.5" cy="12" r="2" />
      <path d="M5.5 10.2L11 2M10.5 10.2L5 2" />
    </>
  ),
  copy: (
    <>
      <path d="M5.5 5.5h7v8h-7z" />
      <path d="M3.5 10.5v-8h7" />
    </>
  ),
  paste: (
    <>
      <path d="M4.5 3.5h-2v10h5M6 2.5h4v2H6z" />
      <path d="M8 6.5h5.5v7H8z" />
    </>
  ),
  delete: <path d="M3 3l10 10M13 3L3 13" />,
  undo: <path d="M6 3.5L2.5 7 6 10.5M2.5 7h6a4 4 0 0 1 0 8H7" />,
  redo: <path d="M10 3.5L13.5 7 10 10.5M13.5 7h-6a4 4 0 0 0 0 8H9" />,
  compile: (
    <>
      <path d="M5.5 2.5l-3.5 5.5 3.5 5.5M10.5 2.5L14 8l-3.5 5.5" />
      <path d="M9 3.5L7 12.5" />
    </>
  ),
  download: <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" />,
  upload: <path d="M8 10V2M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11" />,
  simulation: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 5.5l4 2.5-4 2.5z" />
    </>
  ),
  goOnline: (
    <>
      <path d="M2.5 8h11M10 4.5L13.5 8 10 11.5" />
      <path d="M2.5 4v8" />
    </>
  ),
  goOffline: (
    <>
      <path d="M2 8h4M10 8h4" />
      <path d="M6 5v6M10 5v6" />
    </>
  ),
  accessibleDevices: (
    <>
      <circle cx="6.5" cy="6.5" r="4" />
      <path d="M9.5 9.5l4 4" />
    </>
  ),
  startCpu: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <path d="M7 6l3 2-3 2z" />
    </>
  ),
  stopCpu: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <path d="M6.5 6.5h3v3h-3z" />
    </>
  ),
  splitWorkArea: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M8 2.5v11" />
    </>
  ),
  search: (
    <>
      <circle cx="6.5" cy="6.5" r="4" />
      <path d="M9.5 9.5l4 4" />
    </>
  ),
  pin: (
    <>
      <path d="M6 2.5h4l-.5 4 2 2.5H4.5l2-2.5z" />
      <path d="M8 9v5" />
    </>
  ),
};

for (const [name, children] of Object.entries(shapes)) registerIcon(name as IconName, make(children));
