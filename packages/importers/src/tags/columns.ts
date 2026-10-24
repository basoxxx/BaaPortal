// Colonne compatibili con l'esportazione delle variabili PLC di TIA Portal (documentazione pubblica).
export const TAG_COLUMNS = [
  'Name',
  'Path',
  'Data Type',
  'Logical Address',
  'Comment',
  'Hmi Visible',
  'Hmi Accessible',
  'Hmi Writeable',
] as const;

export const CONSTANT_COLUMNS = ['Name', 'Path', 'Data Type', 'Value', 'Comment'] as const;
