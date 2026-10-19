// Contesto di prova costruito a mano (nessuna dipendenza dal catalogo o dal progetto).
import type { DataType, TypedMember, TypeResolver } from '@baaportal/s7-types';
import { sameName } from '@baaportal/s7-types';
import type { AwlBlockInfo, AwlContext, AwlInterface } from '../src';

export const el = (name: string): DataType => ({ kind: 'elementary', name }) as DataType;
export const m = (name: string, type: DataType): TypedMember => ({ name, type });
const named = (name: string): DataType => ({ kind: 'named', name });
const struct = (...members: TypedMember[]): DataType => ({ kind: 'struct', members });

export const emptyIface = (over: Partial<AwlInterface> = {}): AwlInterface => ({
  input: [],
  output: [],
  inOut: [],
  static: [],
  temp: [],
  returnType: null,
  ...over,
});

export const nastroIface = emptyIface({
  input: [m('Vel', el('Int'))],
  output: [m('Ok', el('Bool'))],
  inOut: [m('Buf', struct(m('a', el('Int'))))],
  static: [m('Cnt', el('Int'))],
  temp: [m('Loc', el('Int'))],
});

export const blocks: AwlBlockInfo[] = [
  {
    name: 'Calcola',
    kind: 'FC',
    number: 1,
    iface: emptyIface({
      input: [m('A', el('Int'))],
      output: [m('R', el('Int'))],
      returnType: { kind: 'void' },
    }),
  },
  { name: 'Nastro', kind: 'FB', number: 2, iface: nastroIface },
  { name: 'Nastro_DB', kind: 'IDB', number: 3, instanceOf: 'Nastro' },
  {
    name: 'Dati',
    kind: 'DB',
    number: 1,
    dbMembers: [
      m('Asse', struct(m('Pos', el('Real')))),
      m('Cnt', el('Int')),
      m('Altro valore', el('Word')),
      m('Vet', { kind: 'array', dims: [{ lo: 0, hi: 3 }], element: el('Int') }),
    ],
  },
  { name: 'Motore', kind: 'FB', number: 5, iface: emptyIface() },
  { name: 'Motore_DB', kind: 'IDB', number: 5, instanceOf: 'Motore' },
  {
    name: 'ConRet',
    kind: 'FC',
    number: 6,
    iface: emptyIface({ input: [m('X', el('Real'))], returnType: el('Int') }),
  },
  {
    name: 'READ_CLK',
    kind: 'SFC',
    number: 1,
    iface: emptyIface({ output: [m('CDT', { kind: 'dateAndTime' })], returnType: el('Int') }),
  },
  {
    name: 'Prese',
    kind: 'FC',
    number: 7,
    iface: emptyIface({
      input: [
        m('T1', { kind: 'parameter', name: 'Timer' }),
        m('P', { kind: 'parameter', name: 'Pointer' }),
        m('Q', { kind: 'parameter', name: 'Any' }),
        m('Blk', { kind: 'parameter', name: 'Block_FC' }),
        m('Tx', { kind: 'string', length: 10 }),
        m('Tp', named('Tipo')),
        m('B', el('Bool')),
        m('W', el('Word')),
      ],
      returnType: { kind: 'void' },
    }),
  },
  { name: 'Ob1', kind: 'OB', number: 1 },
];

const tipo = [m('X', el('Int'))];
export const resolve: TypeResolver = (name) => {
  if (sameName(name, 'Tipo')) return { kind: 'udt', members: tipo };
  if (sameName(name, 'Nastro')) {
    const { input, output, inOut, static: st } = nastroIface;
    return { kind: 'fb', sections: { input, output, inOut, static: st } };
  }
  return null;
};

const symbols = [
  { name: 'Avvio', kind: 'tag' as const, type: el('Bool') },
  { name: 'Velocità nastro', kind: 'tag' as const, type: el('Int') },
  { name: 'Reale', kind: 'tag' as const, type: el('Real') },
  {
    name: 'Temporizzatore',
    kind: 'tag' as const,
    type: { kind: 'parameter', name: 'Timer' } as DataType,
  },
  { name: 'Macchina', kind: 'tag' as const, type: named('Tipo') },
  { name: 'Ignoto', kind: 'tag' as const, type: null },
  { name: 'MAXV', kind: 'constant' as const, type: el('Int') },
];

export const fbIface = emptyIface({
  input: [m('Start', el('Bool')), m('Valore', el('Int'))],
  output: [m('Fatto', el('Bool'))],
  inOut: [m('Buffer', struct(m('a', el('Int'))))],
  static: [
    m('Contatore', el('DInt')),
    m('Sub', named('Nastro')),
    m('Pos', el('Real')),
    m('a b', el('Word')),
  ],
  temp: [m('Tmp', el('Word')), m('Cplx', struct(m('z', el('Int'))))],
});

export function makeCtx(
  kind: 'OB' | 'FB' | 'FC' = 'FB',
  iface: AwlInterface = fbIface,
  limits?: AwlContext['limits'],
): AwlContext {
  return {
    owner: { kind, iface },
    symbol: (name) => symbols.find((s) => sameName(s.name, name)),
    block: (ref) =>
      'name' in ref
        ? blocks.find((b) => sameName(b.name, ref.name))
        : blocks.find((b) => b.kind === ref.kind && b.number === ref.number),
    resolve,
    allSymbols: () => symbols,
    allBlocks: () => blocks,
    ...(limits ? { limits } : {}),
  };
}
