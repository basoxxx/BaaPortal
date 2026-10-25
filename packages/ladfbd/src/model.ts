// Modello delle reti KOP (docs/linguaggi/kop-awl.md §1): albero serie-parallelo con uscite.
// Contiene solo i dati salvati; ciò che si deduce (ad esempio se ENO è collegato) lo calcola
// la traduzione.

export const CMP_FNS = [
  '==I',
  '<>I',
  '>I',
  '<I',
  '>=I',
  '<=I',
  '==D',
  '<>D',
  '>D',
  '<D',
  '>=D',
  '<=D',
  '==R',
  '<>R',
  '>R',
  '<R',
  '>=R',
  '<=R',
] as const;
export type CmpFn = (typeof CMP_FNS)[number];

export const BOX_KINDS = [
  'SR',
  'RS',
  'S_PULSE',
  'S_PEXT',
  'S_ODT',
  'S_ODTS',
  'S_OFFDT',
  'S_CU',
  'S_CD',
  'S_CUD',
  'MOVE',
  'ADD_I',
  'SUB_I',
  'MUL_I',
  'DIV_I',
  'ADD_DI',
  'SUB_DI',
  'MUL_DI',
  'DIV_DI',
  'MOD_DI',
  'ADD_R',
  'SUB_R',
  'MUL_R',
  'DIV_R',
  'ABS',
  'SQR',
  'SQRT',
  'EXP',
  'LN',
  'SIN',
  'COS',
  'TAN',
  'ASIN',
  'ACOS',
  'ATAN',
  'BCD_I',
  'I_BCD',
  'I_DINT',
  'BCD_DI',
  'DI_BCD',
  'DI_REAL',
  'ROUND',
  'TRUNC',
  'CEIL',
  'FLOOR',
  'INV_I',
  'INV_DI',
  'NEG_I',
  'NEG_DI',
  'NEG_R',
  'WAND_W',
  'WOR_W',
  'WXOR_W',
  'WAND_DW',
  'WOR_DW',
  'WXOR_DW',
  'SHR_I',
  'SHR_DI',
  'SHL_W',
  'SHR_W',
  'SHL_DW',
  'SHR_DW',
  'ROL_DW',
  'ROR_DW',
  'CALL',
] as const;
export type BoxKind = (typeof BOX_KINDS)[number];

export type LadBox = {
  id: string;
  k: 'box';
  box: BoxKind;
  /** T 1, C 10, M 0.0 (SR/RS), FC 1, FB 1 / DB 1 → "FB 1, DB 1"; '' se non serve. */
  instance: string;
  /** Pin di dati: nome → operando ('' = non collegato). */
  pins: Record<string, string>;
  /** Pin BOOL d'ingresso con logica propria, esclusi EN e il primo pin. */
  boolPins: Record<string, LadElem[]>;
};

export type LadElem =
  | { id: string; k: 'contact'; neg: boolean; op: string } // NA / NC
  | { id: string; k: 'not' }
  | { id: string; k: 'cmp'; fn: CmpFn; in1: string; in2: string }
  | { id: string; k: 'edge'; dir: 'P' | 'N'; mem: string } // (P) / (N) in linea
  | { id: string; k: 'posneg'; dir: 'P' | 'N'; bit: string; mem: string } // box POS / NEG
  | { id: string; k: 'midline'; op: string } // (#)
  | { id: string; k: 'parallel'; branches: LadElem[][] } // almeno 2 rami
  | LadBox;

export type LadOut =
  | { id: string; k: 'coil' | 'set' | 'reset'; op: string }
  | { id: string; k: 'tcoil'; fn: 'SP' | 'SE' | 'SD' | 'SS' | 'SF'; timer: string; value: string }
  | { id: string; k: 'ccoil'; fn: 'SC' | 'CU' | 'CD'; counter: string; value: string } // value solo per SC
  | { id: string; k: 'jmp' | 'jmpn'; label: string }
  | { id: string; k: 'ret' | 'save' | 'mcrOpen' | 'mcrClose' | 'mcra' | 'mcrd' }
  | { id: string; k: 'callCoil'; block: string } // "FC 11" / "SFC 46"
  | { id: string; k: 'opn'; db: string }; // "DB 10" / "DI 5"

export type LadNode = { id: string; series: LadElem[]; outs: (LadOut | LadNode)[] };
export type LadNetwork = { label?: string; root: LadNode };

export function isNode(x: LadOut | LadNode): x is LadNode {
  return 'series' in x;
}
