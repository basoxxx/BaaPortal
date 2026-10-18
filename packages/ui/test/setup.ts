import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { initI18n } from '../src/i18n';

await initI18n('it');
afterEach(() => cleanup());
