import { describe, expect, it } from 'vitest';
import { createProject } from '../src/index';

const now = new Date('2026-10-18T10:00:00.000Z');

describe('createProject', () => {
  it('createProject imposta i metadati e crea un progetto formato 2 senza dispositivi', () => {
    expect(createProject({ name: 'Linea 3', author: 'Mario', comment: '' }, now)).toEqual({
      formatVersion: 2,
      meta: {
        name: 'Linea 3',
        author: 'Mario',
        comment: '',
        createdAt: '2026-10-18T10:00:00.000Z',
        modifiedAt: '2026-10-18T10:00:00.000Z',
      },
      devices: [],
    });
  });
});
