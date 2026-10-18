import { describe, expect, it } from 'vitest';
import { validateProjectName } from '../src/index';

describe('validateProjectName', () => {
  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['a'.repeat(129), 'TOO_LONG'],
    ['Linea/3', 'INVALID_CHARS'],
    ['a\\b', 'INVALID_CHARS'],
    ['a:b', 'INVALID_CHARS'],
    ['a*b', 'INVALID_CHARS'],
    ['a?b', 'INVALID_CHARS'],
    ['a"b', 'INVALID_CHARS'],
    ['a<b', 'INVALID_CHARS'],
    ['a|b', 'INVALID_CHARS'],
    ['a\u0007b', 'INVALID_CHARS'],
    ['CON', 'RESERVED'],
    ['nul', 'RESERVED'],
    ['COM1', 'RESERVED'],
    ['lpt9', 'RESERVED'],
    ['Linea 3.', 'TRAILING_DOT_OR_SPACE'],
    ['Linea 3 ', 'TRAILING_DOT_OR_SPACE'],
  ])('validateProjectName(%j) → %s', (name, reason) => {
    expect(validateProjectName(name)).toEqual({ ok: false, reason });
  });

  it.each(['Linea 3', 'Pressa àèìòù 日本', 'a'.repeat(128), 'CONSOLE'])(
    'validateProjectName(%j) ok',
    (name) => {
      expect(validateProjectName(name)).toEqual({ ok: true });
    },
  );
});
