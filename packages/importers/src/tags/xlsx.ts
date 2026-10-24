import type { TagTable } from '@baaportal/project';
import { readXlsx, writeXlsx, type Sheet } from '../xlsx/ooxml';
import { CONSTANT_COLUMNS, TAG_COLUMNS } from './columns';
import {
  buildConstantRows,
  buildTagRows,
  toLogicalAddress,
  type ParsedTags,
  type RawRecord,
} from './rows';

const TAGS_SHEET = 'PLC Tags';
const CONSTANTS_SHEET = 'User Constants';

export function tagsToXlsx(table: TagTable): Uint8Array {
  const flag = (b: boolean): string => (b ? 'True' : 'False');
  return writeXlsx([
    {
      name: TAGS_SHEET,
      rows: [
        [...TAG_COLUMNS],
        ...table.tags.map((t) => [
          t.name,
          table.name,
          t.type,
          toLogicalAddress(t.address),
          t.comment,
          flag(t.hmi),
          flag(t.hmi),
          flag(t.hmi),
        ]),
      ],
    },
    {
      name: CONSTANTS_SHEET,
      rows: [
        [...CONSTANT_COLUMNS],
        ...table.constants.map((c) => [c.name, table.name, c.type, c.value, c.comment]),
      ],
    },
  ]);
}

const key = (s: Sheet): string => s.name.trim().toLowerCase();
const isConstants = (s: Sheet): boolean => key(s) === 'user constants' || key(s) === 'constants';

const toRecords = (rows: string[][]): RawRecord[] =>
  rows.slice(1).map((cells, i) => ({ line: i + 2, cells }));

/** Legge variabili e costanti da un xlsx; lancia `XlsxFormatError` se il file non è un xlsx leggibile. */
export function parseTagsXlsx(bytes: Uint8Array): ParsedTags {
  const sheets = readXlsx(bytes);
  const tagSheet = sheets.find((s) => key(s) === 'plc tags') ?? sheets.find((s) => !isConstants(s));
  const constSheet = sheets.find(isConstants);
  const result: ParsedTags = { tags: [], constants: [], errors: [] };
  if (tagSheet && tagSheet.rows[0]) {
    const p = buildTagRows(tagSheet.rows[0], toRecords(tagSheet.rows));
    result.tags = p.tags;
    result.errors.push(...p.errors);
  }
  if (constSheet && constSheet.rows[0]) {
    const p = buildConstantRows(constSheet.rows[0], toRecords(constSheet.rows));
    result.constants = p.constants;
    result.errors.push(...p.errors);
  }
  return result;
}
