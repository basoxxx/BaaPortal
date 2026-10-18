import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { initI18n } from '../src/i18n';

await initI18n('it');
afterEach(() => cleanup());

// jsdom non implementa ResizeObserver, richiesto da react-resizable-panels: basta una versione inerte
// (in jsdom non esiste layout da misurare).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// In jsdom ogni rettangolo è 0×0 in (0,0): react-resizable-panels crederebbe che ogni clic (coordinate 0,0)
// cada su un divisore e gli darebbe il focus, rubandolo a campi e nodi. Teniamo i divisori lontano dal puntatore.
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  if (this instanceof HTMLElement && this.hasAttribute('data-separator')) {
    return new DOMRect(-10000, -10000, 0, 0);
  }
  return realRect.call(this);
};
