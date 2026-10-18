import type { FC, ReactNode } from 'react';
import { registerIcon, type IconName } from './index';

function make(children: ReactNode): FC<{ size: number }> {
  return function TreeSvg({ size }) {
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
  treeProject: <path d="M1.5 4.5h4.5l1.5 1.5h7v7.5h-13z" />,
  treeAddDevice: (
    <>
      <rect x="2" y="3" width="8" height="10" rx="1" />
      <path d="M4.5 6h3M4.5 8.5h3M13 6v5M10.5 8.5h5" />
    </>
  ),
  treeDevicesNetworks: (
    <>
      <rect x="1.5" y="2" width="5" height="4" />
      <rect x="9.5" y="2" width="5" height="4" />
      <rect x="5.5" y="10.5" width="5" height="4" />
      <path d="M4 6v2.5h8V6M8 8.5v2" />
    </>
  ),
  treeCommonData: (
    <>
      <ellipse cx="8" cy="4" rx="5.5" ry="2" />
      <path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
    </>
  ),
  treeDocSettings: (
    <>
      <path d="M3.5 1.5h6L12.5 4.5v10h-9z" />
      <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5" />
    </>
  ),
  treeLanguages: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c-2 2-2 11 0 13M8 1.5c2 2 2 11 0 13" />
    </>
  ),
  treeOnlineAccess: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7M2.5 2.5a8 8 0 0 0 0 11M13.5 2.5a8 8 0 0 1 0 11" />
    </>
  ),
};

for (const [name, node] of Object.entries(shapes) as [IconName, ReactNode][]) registerIcon(name, make(node));
