import type { FC, ReactNode } from 'react';
import { registerIcon, type IconName } from './index';

function make(children: ReactNode): FC<{ size: number }> {
  return function PortalSvg({ size }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
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

const shapes: Record<
  | 'portalStart'
  | 'portalDevices'
  | 'portalPlc'
  | 'portalOnline'
  | 'actionOpen'
  | 'actionNew'
  | 'actionMigrate'
  | 'actionClose'
  | 'actionFirstSteps'
  | 'actionInstalled'
  | 'actionHelp'
  | 'actionLanguage',
  ReactNode
> = {
  portalStart: <path d="M16 4v10M9.5 8.5a9 9 0 1 0 13 0" />,
  portalDevices: (
    <>
      <rect x="4" y="5" width="10" height="9" rx="1" />
      <rect x="18" y="18" width="10" height="9" rx="1" />
      <path d="M14 9.5h4v13h0M9 14v4h9" />
    </>
  ),
  portalPlc: (
    <>
      <rect x="6" y="4" width="20" height="24" rx="2" />
      <path d="M11 11h10M11 16h10M11 21h6" />
    </>
  ),
  portalOnline: (
    <>
      <path d="M4 12a17 17 0 0 1 24 0M8 17a11 11 0 0 1 16 0M12 22a5 5 0 0 1 8 0" />
      <circle cx="16" cy="26" r="1" />
    </>
  ),
  actionOpen: (
    <path d="M4 9a2 2 0 0 1 2-2h7l3 3h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
  ),
  actionNew: (
    <>
      <path d="M8 4h11l6 6v18H8z" />
      <path d="M16 15v8M12 19h8" />
    </>
  ),
  actionMigrate: <path d="M5 16h20M18 9l7 7-7 7M5 7v18" />,
  actionClose: (
    <>
      <path d="M8 4h11l6 6v18H8z" />
      <path d="M13 15l6 6M19 15l-6 6" />
    </>
  ),
  actionFirstSteps: (
    <path d="M16 4l3.5 8 8.5.8-6.4 5.7 1.9 8.5L16 22.5 8.5 27l1.9-8.5L4 12.8l8.5-.8z" />
  ),
  actionInstalled: (
    <>
      <path d="M16 4l11 6v12l-11 6-11-6V10z" />
      <path d="M5 10l11 6 11-6M16 16v12" />
    </>
  ),
  actionHelp: (
    <>
      <circle cx="16" cy="16" r="12" />
      <path d="M12.5 12.5a3.5 3.5 0 1 1 5 3.2c-1 .6-1.5 1.2-1.5 2.3M16 22.5v.5" />
    </>
  ),
  actionLanguage: (
    <>
      <circle cx="16" cy="16" r="12" />
      <path d="M4 16h24M16 4c-4 4-4 20 0 24M16 4c4 4 4 20 0 24" />
    </>
  ),
};

for (const [name, children] of Object.entries(shapes))
  registerIcon(name as IconName, make(children));
