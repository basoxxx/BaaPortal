// Catalogo dei box KOP e degli altri elementi della palette.
// Pin e tipi: docs/linguaggi/kop-awl.md §2.12, §2.13, §3.2, §3.4, §4.4–§4.8.
import type { BoxKind } from './model.js';

export type BoxGroup =
  'bistable' | 'timer' | 'counter' | 'move' | 'math' | 'convert' | 'wordLogic' | 'shift' | 'call';

export type PinDef = { name: string; type: string };

export type BoxDef = {
  kind: BoxKind;
  group: BoxGroup;
  /** Il box ha i pin EN/ENO (temporizzatori, contatori e flip-flop no). */
  en: boolean;
  /** Primo pin BOOL d'ingresso (sulla barra del box). '' se il box non ne ha (EN è l'ingresso). */
  firstPin: string;
  /** Altri pin BOOL d'ingresso, con logica propria, in ordine. */
  boolInputs: string[];
  /** Pin di dati d'ingresso, in ordine. */
  dataInputs: PinDef[];
  /** Pin d'uscita, in ordine. */
  outputs: PinDef[];
  /** Mnemonico AWL del corpo (nomi inglesi), null se il corpo è un L/T o una sequenza. */
  awl: string | null;
  /** Il corpo può dare errore (ENO = 0): colonna «errore» di §4.5–§4.6. */
  canFail: boolean;
  /** Pin presi dall'interfaccia del blocco chiamato (CALL). */
  dynamicPins?: boolean;
};

const p = (name: string, type: string): PinDef => ({ name, type });

type Partial_ = Partial<BoxDef> & Pick<BoxDef, 'kind' | 'group'>;
const def = (d: Partial_): BoxDef => ({
  en: true,
  firstPin: '',
  boolInputs: [],
  dataInputs: [],
  outputs: [],
  awl: null,
  canFail: false,
  ...d,
});

// Temporizzatori: pin e uscite uguali, cambia solo l'istruzione (§3.2).
const timer = (kind: BoxKind, awl: string): BoxDef =>
  def({
    kind,
    group: 'timer',
    en: false,
    firstPin: 'S',
    boolInputs: ['R'],
    dataInputs: [p('TV', 'S5TIME')],
    outputs: [p('BI', 'WORD'), p('BCD', 'WORD'), p('Q', 'BOOL')],
    awl,
  });

const counterOut = [p('CV', 'WORD'), p('CV_BCD', 'WORD'), p('Q', 'BOOL')];

// Operazioni con un solo operando IN e uscita OUT.
const unary = (
  kind: BoxKind,
  group: BoxGroup,
  inT: string,
  outT: string,
  awl: string,
  canFail: boolean,
) => def({ kind, group, dataInputs: [p('IN', inT)], outputs: [p('OUT', outT)], awl, canFail });

const binary = (kind: BoxKind, group: BoxGroup, t: string, awl: string, canFail: boolean) =>
  def({
    kind,
    group,
    dataInputs: [p('IN1', t), p('IN2', t)],
    outputs: [p('OUT', t)],
    awl,
    canFail,
  });

const shift = (kind: BoxKind, t: string, awl: string) =>
  def({
    kind,
    group: 'shift',
    dataInputs: [p('IN', t), p('N', 'WORD')],
    outputs: [p('OUT', t)],
    awl,
  });

const BOX_LIST: BoxDef[] = [
  // Flip-flop (§2.12): niente EN/ENO, istanza = bit di memoria. Q è l'unica uscita.
  def({
    kind: 'SR',
    group: 'bistable',
    en: false,
    firstPin: 'S',
    boolInputs: ['R'],
    outputs: [p('Q', 'BOOL')],
  }),
  def({
    kind: 'RS',
    group: 'bistable',
    en: false,
    firstPin: 'R',
    boolInputs: ['S'],
    outputs: [p('Q', 'BOOL')],
  }),
  timer('S_PULSE', 'SP'),
  timer('S_PEXT', 'SE'),
  timer('S_ODT', 'SD'),
  timer('S_ODTS', 'SS'),
  timer('S_OFFDT', 'SF'),
  // Contatori (§3.4)
  def({
    kind: 'S_CU',
    group: 'counter',
    en: false,
    firstPin: 'CU',
    boolInputs: ['S', 'R'],
    dataInputs: [p('PV', 'WORD')],
    outputs: counterOut,
    awl: 'CU',
  }),
  def({
    kind: 'S_CD',
    group: 'counter',
    en: false,
    firstPin: 'CD',
    boolInputs: ['S', 'R'],
    dataInputs: [p('PV', 'WORD')],
    outputs: counterOut,
    awl: 'CD',
  }),
  def({
    kind: 'S_CUD',
    group: 'counter',
    en: false,
    firstPin: 'CU',
    boolInputs: ['CD', 'S', 'R'],
    dataInputs: [p('PV', 'WORD')],
    outputs: counterOut,
  }),
  // MOVE (§4.4): BYTE, WORD o DWORD (8/16/32 bit)
  def({
    kind: 'MOVE',
    group: 'move',
    dataInputs: [p('IN', 'ANY8_16_32')],
    outputs: [p('OUT', 'ANY8_16_32')],
  }),
  // Matematica (§4.5)
  binary('ADD_I', 'math', 'INT', '+I', true),
  binary('SUB_I', 'math', 'INT', '-I', true),
  binary('MUL_I', 'math', 'INT', '*I', true),
  binary('DIV_I', 'math', 'INT', '/I', true),
  binary('ADD_DI', 'math', 'DINT', '+D', true),
  binary('SUB_DI', 'math', 'DINT', '-D', true),
  binary('MUL_DI', 'math', 'DINT', '*D', true),
  binary('DIV_DI', 'math', 'DINT', '/D', true),
  binary('MOD_DI', 'math', 'DINT', 'MOD', true),
  binary('ADD_R', 'math', 'REAL', '+R', true),
  binary('SUB_R', 'math', 'REAL', '-R', true),
  binary('MUL_R', 'math', 'REAL', '*R', true),
  binary('DIV_R', 'math', 'REAL', '/R', true),
  ...(['ABS', 'SQR', 'SQRT', 'EXP', 'LN', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN'] as const)
    // ABS non tocca la parola di stato (manuale AWL, «ABS»): niente errore da controllare, ENO = EN
    .map((k) => unary(k, 'math', 'REAL', 'REAL', k, k !== 'ABS')),
  // Conversioni (§4.6)
  unary('BCD_I', 'convert', 'WORD', 'INT', 'BTI', false),
  unary('I_BCD', 'convert', 'INT', 'WORD', 'ITB', true),
  unary('I_DINT', 'convert', 'INT', 'DINT', 'ITD', false),
  unary('BCD_DI', 'convert', 'DWORD', 'DINT', 'BTD', false),
  unary('DI_BCD', 'convert', 'DINT', 'DWORD', 'DTB', true),
  unary('DI_REAL', 'convert', 'DINT', 'REAL', 'DTR', false),
  unary('ROUND', 'convert', 'REAL', 'DINT', 'RND', true),
  unary('TRUNC', 'convert', 'REAL', 'DINT', 'TRUNC', true),
  unary('CEIL', 'convert', 'REAL', 'DINT', 'RND+', true),
  unary('FLOOR', 'convert', 'REAL', 'DINT', 'RND-', true),
  unary('INV_I', 'convert', 'INT', 'INT', 'INVI', false),
  unary('INV_DI', 'convert', 'DINT', 'DINT', 'INVD', false),
  unary('NEG_I', 'convert', 'INT', 'INT', 'NEGI', true),
  unary('NEG_DI', 'convert', 'DINT', 'DINT', 'NEGD', true),
  unary('NEG_R', 'convert', 'REAL', 'REAL', 'NEGR', false),
  // Logica a parola (§4.7)
  binary('WAND_W', 'wordLogic', 'WORD', 'AW', false),
  binary('WOR_W', 'wordLogic', 'WORD', 'OW', false),
  binary('WXOR_W', 'wordLogic', 'WORD', 'XOW', false),
  binary('WAND_DW', 'wordLogic', 'DWORD', 'AD', false),
  binary('WOR_DW', 'wordLogic', 'DWORD', 'OD', false),
  binary('WXOR_DW', 'wordLogic', 'DWORD', 'XOD', false),
  // Scorrimento e rotazione (§4.8)
  shift('SHR_I', 'INT', 'SSI'),
  shift('SHR_DI', 'DINT', 'SSD'),
  shift('SHL_W', 'WORD', 'SLW'),
  shift('SHR_W', 'WORD', 'SRW'),
  shift('SHL_DW', 'DWORD', 'SLD'),
  shift('SHR_DW', 'DWORD', 'SRD'),
  shift('ROL_DW', 'DWORD', 'RLD'),
  shift('ROR_DW', 'DWORD', 'RRD'),
  // Chiamata di blocco (§4.11): i pin si riempiono dall'interfaccia del blocco chiamato.
  def({ kind: 'CALL', group: 'call', dynamicPins: true }),
];

export const BOX_CATALOG: Record<BoxKind, BoxDef> = Object.fromEntries(
  BOX_LIST.map((d) => [d.kind, d]),
) as Record<BoxKind, BoxDef>;

// ---- palette degli altri elementi ----

export type PaletteGroup =
  'bits' | 'compare' | 'edge' | 'outputs' | 'timers' | 'counters' | 'flow' | 'call';

export type PaletteEntry = {
  id: string;
  /** Posizione: elemento in serie o uscita a fine linea. */
  where: 'elem' | 'out';
  group: PaletteGroup;
  /** Chiave i18n dell'etichetta. */
  label: string;
  /** Campi dell'elemento da creare (oltre a id e k). */
  preset: { k: string } & Record<string, unknown>;
};

const e = (id: string, group: PaletteGroup, preset: PaletteEntry['preset']): PaletteEntry => ({
  id,
  where: 'elem',
  group,
  label: `lad.palette.${id}`,
  preset,
});
const o = (id: string, group: PaletteGroup, preset: PaletteEntry['preset']): PaletteEntry => ({
  id,
  where: 'out',
  group,
  label: `lad.palette.${id}`,
  preset,
});

export const PALETTE: PaletteEntry[] = [
  e('contactNo', 'bits', { k: 'contact', neg: false, op: '' }),
  e('contactNc', 'bits', { k: 'contact', neg: true, op: '' }),
  e('not', 'bits', { k: 'not' }),
  e('midline', 'bits', { k: 'midline', op: '' }),
  e('cmp', 'compare', { k: 'cmp', fn: '==I', in1: '', in2: '' }),
  e('edgeP', 'edge', { k: 'edge', dir: 'P', mem: '' }),
  e('edgeN', 'edge', { k: 'edge', dir: 'N', mem: '' }),
  e('pos', 'edge', { k: 'posneg', dir: 'P', bit: '', mem: '' }),
  e('neg', 'edge', { k: 'posneg', dir: 'N', bit: '', mem: '' }),
  o('coil', 'outputs', { k: 'coil', op: '' }),
  o('set', 'outputs', { k: 'set', op: '' }),
  o('reset', 'outputs', { k: 'reset', op: '' }),
  o('timerSP', 'timers', { k: 'tcoil', fn: 'SP', timer: '', value: '' }),
  o('timerSE', 'timers', { k: 'tcoil', fn: 'SE', timer: '', value: '' }),
  o('timerSD', 'timers', { k: 'tcoil', fn: 'SD', timer: '', value: '' }),
  o('timerSS', 'timers', { k: 'tcoil', fn: 'SS', timer: '', value: '' }),
  o('timerSF', 'timers', { k: 'tcoil', fn: 'SF', timer: '', value: '' }),
  o('counterSC', 'counters', { k: 'ccoil', fn: 'SC', counter: '', value: '' }),
  o('counterCU', 'counters', { k: 'ccoil', fn: 'CU', counter: '', value: '' }),
  o('counterCD', 'counters', { k: 'ccoil', fn: 'CD', counter: '', value: '' }),
  o('jmp', 'flow', { k: 'jmp', label: '' }),
  o('jmpn', 'flow', { k: 'jmpn', label: '' }),
  o('ret', 'flow', { k: 'ret' }),
  o('save', 'flow', { k: 'save' }),
  o('mcrOpen', 'flow', { k: 'mcrOpen' }),
  o('mcrClose', 'flow', { k: 'mcrClose' }),
  o('mcra', 'flow', { k: 'mcra' }),
  o('mcrd', 'flow', { k: 'mcrd' }),
  o('callCoil', 'call', { k: 'callCoil', block: '' }),
  o('opn', 'call', { k: 'opn', db: '' }),
];
