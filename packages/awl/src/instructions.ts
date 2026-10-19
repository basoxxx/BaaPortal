// Tabella delle istruzioni AWL (STL) dell'S7-300.
// Fonte: manuale Siemens "Statement List (STL) for S7-300 and S7-400 Programming"
// (appendice A, mnemonici tedeschi/internazionali) e "S7-300 Instruction List".

export type Mnemonic = 'international' | 'german';

export type InstructionCategory =
  | 'bitLogic'
  | 'comparison'
  | 'conversion'
  | 'counter'
  | 'db'
  | 'jump'
  | 'integer'
  | 'float'
  | 'loadTransfer'
  | 'control'
  | 'shift'
  | 'timer'
  | 'wordLogic'
  | 'accumulator';

export type OperandClass =
  | 'none'
  | 'bit'
  | 'status'
  | 'loadSource'
  | 'transferTarget'
  | 'timer'
  | 'counter'
  | 'label'
  | 'callTarget'
  | 'ucTarget'
  | 'dbOpen'
  | 'intConstant'
  | 'shiftCount'
  | 'byteConstant'
  | 'wordConstant'
  | 'dwordConstant'
  | 'pointerOrDword'
  | 'dwordLocation'
  | 'nopValue';

export interface InstructionDef {
  /** Mnemonico internazionale, come scritto in AWL. */
  id: string;
  german: string;
  category: InstructionCategory;
  /** Alternative ammesse; 'none' = senza operando. */
  operands: OperandClass[];
  opensBracket?: boolean;
  closesBracket?: boolean;
  endsBlock?: 'always' | 'conditional';
}

type Extra = Pick<InstructionDef, 'opensBracket' | 'closesBracket' | 'endsBlock'>;

function def(
  category: InstructionCategory,
  id: string,
  german: string,
  operands: OperandClass[],
  extra: Extra = {},
): InstructionDef {
  return { id, german, category, operands, ...extra };
}

// Istruzioni con lo stesso mnemonico nelle due lingue.
const same = (
  category: InstructionCategory,
  ids: string[],
  operands: OperandClass[],
): InstructionDef[] => ids.map((id) => def(category, id, id, operands));

const compare: InstructionDef[] = ['I', 'D', 'R'].flatMap((t) =>
  ['==', '<>', '>', '<', '>=', '<='].map((op) => def('comparison', op + t, op + t, ['none'])),
);

const bitOperand: OperandClass[] = ['bit', 'status'];

export const INSTRUCTIONS: readonly InstructionDef[] = [
  // Logica a bit
  def('bitLogic', 'A', 'U', bitOperand),
  def('bitLogic', 'AN', 'UN', bitOperand),
  def('bitLogic', 'O', 'O', [...bitOperand, 'none']), // 'O' solo = OR di blocchi AND
  def('bitLogic', 'ON', 'ON', bitOperand),
  def('bitLogic', 'X', 'X', bitOperand),
  def('bitLogic', 'XN', 'XN', bitOperand),
  def('bitLogic', 'A(', 'U(', ['none'], { opensBracket: true }),
  def('bitLogic', 'AN(', 'UN(', ['none'], { opensBracket: true }),
  def('bitLogic', 'O(', 'O(', ['none'], { opensBracket: true }),
  def('bitLogic', 'ON(', 'ON(', ['none'], { opensBracket: true }),
  def('bitLogic', 'X(', 'X(', ['none'], { opensBracket: true }),
  def('bitLogic', 'XN(', 'XN(', ['none'], { opensBracket: true }),
  def('bitLogic', ')', ')', ['none'], { closesBracket: true }),
  def('bitLogic', '=', '=', ['bit']),
  def('bitLogic', 'R', 'R', ['bit', 'timer', 'counter']),
  def('bitLogic', 'S', 'S', ['bit', 'timer', 'counter']),
  ...same('bitLogic', ['NOT', 'SET', 'CLR', 'SAVE'], ['none']),
  ...same('bitLogic', ['FN', 'FP'], ['bit']),

  // Confronto
  ...compare,

  // Conversione
  ...same(
    'conversion',
    ['BTI', 'ITB', 'BTD', 'ITD', 'DTB', 'DTR', 'INVI', 'INVD', 'NEGI', 'NEGD', 'NEGR'],
    ['none'],
  ),
  def('conversion', 'CAW', 'TAW', ['none']),
  def('conversion', 'CAD', 'TAD', ['none']),
  ...same('conversion', ['RND', 'TRUNC', 'RND+', 'RND-'], ['none']),

  // Contatori (FR e LC sono nella categoria dei temporizzatori)
  def('counter', 'CU', 'ZV', ['counter']),
  def('counter', 'CD', 'ZR', ['counter']),

  // Blocchi dati ('L DBLG' ecc. sono L con operando speciale)
  def('db', 'OPN', 'AUF', ['dbOpen']),
  def('db', 'CDB', 'TDB', ['none']),

  // Salti
  def('jump', 'JU', 'SPA', ['label']),
  def('jump', 'JL', 'SPL', ['label']),
  def('jump', 'JC', 'SPB', ['label']),
  def('jump', 'JCN', 'SPBN', ['label']),
  def('jump', 'JCB', 'SPBB', ['label']),
  def('jump', 'JNB', 'SPBNB', ['label']),
  def('jump', 'JBI', 'SPBI', ['label']),
  def('jump', 'JNBI', 'SPBIN', ['label']),
  def('jump', 'JO', 'SPO', ['label']),
  def('jump', 'JOS', 'SPS', ['label']),
  def('jump', 'JZ', 'SPZ', ['label']),
  def('jump', 'JN', 'SPN', ['label']),
  def('jump', 'JP', 'SPP', ['label']),
  def('jump', 'JM', 'SPM', ['label']),
  def('jump', 'JPZ', 'SPPZ', ['label']),
  def('jump', 'JMZ', 'SPMZ', ['label']),
  def('jump', 'JUO', 'SPU', ['label']),
  def('jump', 'LOOP', 'LOOP', ['label']),

  // Interi
  ...same('integer', ['+I', '-I', '*I', '/I', '+D', '-D', '*D', '/D', 'MOD'], ['none']),
  def('integer', '+', '+', ['intConstant']),

  // Virgola mobile
  ...same(
    'float',
    [
      '+R',
      '-R',
      '*R',
      '/R',
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
    ],
    ['none'],
  ),

  // Caricamento e trasferimento
  def('loadTransfer', 'L', 'L', ['loadSource']), // include L STW, L DBLG, L DBNO, L DILG, L DINO
  def('loadTransfer', 'T', 'T', ['transferTarget']), // include T STW
  def('loadTransfer', 'LAR1', 'LAR1', ['none', 'pointerOrDword']),
  def('loadTransfer', 'LAR2', 'LAR2', ['none', 'pointerOrDword']),
  def('loadTransfer', 'TAR1', 'TAR1', ['none', 'dwordLocation']),
  def('loadTransfer', 'TAR2', 'TAR2', ['none', 'dwordLocation']),
  def('loadTransfer', 'CAR', 'TAR', ['none']),

  // Controllo del programma
  def('control', 'BE', 'BE', ['none'], { endsBlock: 'always' }),
  def('control', 'BEU', 'BEA', ['none'], { endsBlock: 'always' }),
  // Il manuale internazionale usa BEC (non BEB) per la fine blocco condizionata.
  def('control', 'BEC', 'BEB', ['none'], { endsBlock: 'conditional' }),
  def('control', 'CALL', 'CALL', ['callTarget']),
  def('control', 'CC', 'CC', ['ucTarget']),
  def('control', 'UC', 'UC', ['ucTarget']),
  ...same('control', ['MCR(', ')MCR', 'MCRA', 'MCRD'], ['none']),

  // Scorrimento e rotazione
  ...same(
    'shift',
    ['SSI', 'SSD', 'SLW', 'SRW', 'SLD', 'SRD', 'RLD', 'RRD'],
    ['none', 'shiftCount'],
  ),
  ...same('shift', ['RLDA', 'RRDA'], ['none']),

  // Temporizzatori (FR e LC valgono anche per i contatori)
  def('timer', 'SP', 'SI', ['timer']),
  def('timer', 'SE', 'SV', ['timer']), // attenzione: SE tedesco e' SD internazionale
  def('timer', 'SD', 'SE', ['timer']),
  def('timer', 'SS', 'SS', ['timer']),
  def('timer', 'SF', 'SA', ['timer']),
  ...same('timer', ['FR', 'LC'], ['timer', 'counter']),

  // Logica a parola
  def('wordLogic', 'AW', 'UW', ['none', 'wordConstant']),
  def('wordLogic', 'OW', 'OW', ['none', 'wordConstant']),
  def('wordLogic', 'XOW', 'XOW', ['none', 'wordConstant']),
  def('wordLogic', 'AD', 'UD', ['none', 'dwordConstant']),
  def('wordLogic', 'OD', 'OD', ['none', 'dwordConstant']),
  def('wordLogic', 'XOD', 'XOD', ['none', 'dwordConstant']),

  // Accumulatori (ENT e LEAVE esistono solo sulle CPU a 4 ACCU, non sull'S7-300)
  ...same('accumulator', ['TAK', 'PUSH', 'POP'], ['none']),
  ...same('accumulator', ['INC', 'DEC', 'BLD'], ['byteConstant']),
  def('accumulator', 'NOP', 'NOP', ['nopValue']),
  ...same('accumulator', ['+AR1', '+AR2'], ['none', 'pointerOrDword']),
];

// Indici per mnemonico; Map (non oggetti) per evitare le chiavi del prototipo.
const byInternational = new Map<string, InstructionDef>();
const byGerman = new Map<string, InstructionDef>();
for (const i of INSTRUCTIONS) {
  byInternational.set(i.id.toUpperCase(), i);
  byGerman.set(i.german.toUpperCase(), i);
}

export function findInstruction(text: string, mnemonic: Mnemonic): InstructionDef | undefined {
  const key = text.toUpperCase();
  return (mnemonic === 'international' ? byInternational : byGerman).get(key);
}

// Prefissi di area (chiavi in maiuscolo: il chiamante normalizza). Ogni grafia (internazionale o tedesca) porta alla stessa coppia.
const AREAS: { international: string; german: string }[] = [
  ...['', 'B', 'W', 'D'].map((s) => ({ international: 'I' + s, german: 'E' + s })),
  ...['', 'B', 'W', 'D'].map((s) => ({ international: 'Q' + s, german: 'A' + s })),
  ...['B', 'W', 'D'].map((s) => ({ international: 'PI' + s, german: 'PE' + s })),
  ...['B', 'W', 'D'].map((s) => ({ international: 'PQ' + s, german: 'PA' + s })),
  { international: 'C', german: 'Z' },
  ...['M', 'MB', 'MW', 'MD', 'L', 'LB', 'LW', 'LD', 'T'].map((p) => ({
    international: p,
    german: p,
  })),
  ...['DB', 'DBX', 'DBB', 'DBW', 'DBD', 'DI', 'DIX', 'DIB', 'DIW', 'DID'].map((p) => ({
    international: p,
    german: p,
  })),
];

export const AREA_MNEMONICS: ReadonlyMap<string, { international: string; german: string }> =
  new Map(
    AREAS.flatMap((a) => [
      [a.international, a],
      [a.german, a],
    ]),
  );

export const STATUS_CONDITIONS: readonly { international: string; german: string }[] = [
  ...['==0', '<>0', '>0', '<0', '>=0', '<=0', 'OV', 'OS', 'UO'].map((c) => ({
    international: c,
    german: c,
  })),
  { international: 'BR', german: 'BIE' },
];
