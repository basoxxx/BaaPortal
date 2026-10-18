export const FORMAT_VERSION = 1;

export interface ProjectMeta {
  name: string;
  author: string;
  comment: string;
  /** Data ISO 8601 UTC. */
  createdAt: string;
  /** Data ISO 8601 UTC. */
  modifiedAt: string;
}

export interface Project {
  formatVersion: 1;
  meta: ProjectMeta;
}

export function createProject(
  input: { name: string; author: string; comment: string },
  now: Date,
): Project {
  const iso = now.toISOString();
  return {
    formatVersion: FORMAT_VERSION,
    meta: {
      name: input.name,
      author: input.author,
      comment: input.comment,
      createdAt: iso,
      modifiedAt: iso,
    },
  };
}
