import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { expect, it } from 'vitest';
import { App } from '../src/App';
import { FakeBridge } from './fakeBridge';

it('App attende la versione, poi si registra una sola volta anche in StrictMode', async () => {
  const bridge = new FakeBridge();
  const { unmount } = render(<StrictMode><App bridge={bridge} /></StrictMode>);
  expect(screen.queryByTestId('app-root')).toBeNull();
  expect(await screen.findByTestId('app-root')).toBeInTheDocument();
  expect(bridge.listenerCount).toBe(2);
  unmount();
  expect(bridge.listenerCount).toBe(0);
});
