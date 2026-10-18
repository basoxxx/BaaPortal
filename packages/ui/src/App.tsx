import type { BaaBridge } from './bridge';

export interface AppProps {
  bridge: BaaBridge;
}

export function App({ bridge }: AppProps) {
  return <div>BaaPortal ({bridge.platform})</div>;
}
