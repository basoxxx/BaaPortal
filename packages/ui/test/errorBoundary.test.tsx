import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ErrorBoundary } from '../src/ErrorBoundary';
import { FakeBridge } from './fakeBridge';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function Bomb(): never {
  throw new RangeError('Invalid time value');
}

it("ErrorBoundary mostra un messaggio invece di una finestra vuota", () => {
  render(
    <ErrorBoundary>
      <Bomb />
    </ErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Si è verificato un errore');
});

it("App mostra un errore se l'avvio fallisce", async () => {
  const bridge = new FakeBridge();
  bridge.appVersion = async () => {
    throw new Error('preload mancante');
  };
  render(<App bridge={bridge} />);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
});
