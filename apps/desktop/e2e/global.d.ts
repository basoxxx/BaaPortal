import type { BaaBridge } from '@baaportal/ui';

declare global {
  interface Window {
    baa: BaaBridge;
  }
}
