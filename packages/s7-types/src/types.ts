export type ElementaryTypeName =
  | 'Bool'
  | 'Byte'
  | 'Word'
  | 'DWord'
  | 'Int'
  | 'DInt'
  | 'Real'
  | 'S5Time'
  | 'Time'
  | 'Date'
  | 'Time_Of_Day'
  | 'Char';

export type ParameterTypeName =
  'Timer' | 'Counter' | 'Block_FB' | 'Block_FC' | 'Block_DB' | 'Block_SDB' | 'Pointer' | 'Any';

export const ELEMENTARY_TYPES: readonly ElementaryTypeName[] = [
  'Bool',
  'Byte',
  'Word',
  'DWord',
  'Int',
  'DInt',
  'Real',
  'S5Time',
  'Time',
  'Date',
  'Time_Of_Day',
  'Char',
];

export const PARAMETER_TYPES: readonly ParameterTypeName[] = [
  'Timer',
  'Counter',
  'Block_FB',
  'Block_FC',
  'Block_DB',
  'Block_SDB',
  'Pointer',
  'Any',
];

export interface TypedMember {
  name: string;
  type: DataType;
}

export interface ArrayDim {
  lo: number;
  hi: number;
}

export type DataType =
  | { kind: 'elementary'; name: ElementaryTypeName }
  | { kind: 'string'; length: number }
  | { kind: 'dateAndTime' }
  | { kind: 'parameter'; name: ParameterTypeName }
  | { kind: 'array'; dims: ArrayDim[]; element: DataType }
  | { kind: 'struct'; members: TypedMember[] }
  | { kind: 'named'; name: string }
  | { kind: 'void' };
