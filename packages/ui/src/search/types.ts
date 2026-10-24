import type { ObjectRef } from '@baaportal/project';

export interface FindOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  mnemonic: 'de' | 'int';
  scope: { kind: 'project' } | { kind: 'object'; ref: ObjectRef };
}

export type HitLocation =
  | {
      kind: 'network';
      deviceId: string;
      blockId: string;
      networkIndex: number;
      from: number;
      to: number;
    }
  | { kind: 'source'; deviceId: string; sourceId: string; from: number; to: number }
  | {
      kind: 'blockTitle' | 'blockComment' | 'networkTitle' | 'networkComment';
      deviceId: string;
      blockId: string;
      networkIndex?: number;
      from: number;
      to: number;
    }
  | {
      kind: 'tag';
      field: 'name' | 'comment';
      deviceId: string;
      tableId: string;
      tagId: string;
      from: number;
      to: number;
    };

export interface Hit {
  loc: HitLocation;
  preview: string;
  editable: boolean;
  reason?: 'PROTETTO' | 'MC7_GREZZO';
}

export type FindError = { error: 'REGEX_NON_VALIDA'; detail: string };
