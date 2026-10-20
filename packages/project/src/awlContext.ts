// La vista di un dispositivo per il controllo, il completamento e la rinomina del codice AWL.
import type { AwlBlockInfo, AwlContext, AwlInterface, AwlSymbolInfo } from '@baaportal/awl';
import { SYSTEM_BLOCKS, type CpuType, type SystemBlock } from '@baaportal/catalog';
import { parseType, sameName, type DataType } from '@baaportal/s7-types';
import { toTypedMembers, typeResolver } from './members';
import type { Block, BlockInterface, PlcDevice } from './model';

const typeOrNull = (text: string): DataType | null => {
  const parsed = parseType(text);
  return parsed.ok ? parsed.type : null;
};

const emptyIface = (): AwlInterface => ({
  input: [],
  output: [],
  inOut: [],
  static: [],
  temp: [],
  returnType: null,
});

function ifaceOf(i: BlockInterface): AwlInterface {
  return {
    input: toTypedMembers(i.input),
    output: toTypedMembers(i.output),
    inOut: toTypedMembers(i.inOut),
    static: toTypedMembers(i.static),
    temp: toTypedMembers(i.temp),
    returnType: i.returnType === '' ? null : typeOrNull(i.returnType),
  };
}

function infoOf(b: Block): AwlBlockInfo {
  const base = { name: b.name, kind: b.kind, number: b.number };
  if (b.kind === 'DB') return { ...base, dbMembers: toTypedMembers(b.members) };
  if (b.kind === 'IDB') return { ...base, instanceOf: b.instanceOf };
  return { ...base, iface: ifaceOf(b.interface) };
}

function systemInfo(b: SystemBlock): AwlBlockInfo {
  const info: AwlBlockInfo = {
    name: b.name,
    kind: b.kind,
    number: b.number,
    iface: {
      input: b.input,
      output: b.output,
      inOut: b.inOut,
      static: b.static ?? [],
      temp: [],
      returnType: b.returnType === undefined ? null : typeOrNull(b.returnType),
    },
  };
  if (b.paramAliases) info.paramAliases = b.paramAliases;
  return info;
}

/** Il contesto del controllo AWL per il blocco `blockId` del dispositivo (un blocco non di codice ha un proprietario vuoto). */
export function createAwlContext(
  device: PlcDevice,
  blockId: string,
  cpu: CpuType | undefined,
): AwlContext {
  const symbols: AwlSymbolInfo[] = device.tagTables.flatMap((t) => [
    ...t.tags.map((x) => ({
      name: x.name,
      kind: 'tag' as const,
      type: typeOrNull(x.type),
      address: x.address,
    })),
    ...t.constants.map((x) => ({
      name: x.name,
      kind: 'constant' as const,
      type: typeOrNull(x.type),
      value: x.value,
    })),
  ]);
  // Prima i blocchi del progetto, poi SFC e SFB del catalogo.
  const blocks: AwlBlockInfo[] = [...device.blocks.map(infoOf), ...SYSTEM_BLOCKS.map(systemInfo)];

  const owner = device.blocks.find((b) => b.id === blockId);
  const ownerInfo: AwlContext['owner'] =
    owner && owner.kind !== 'DB' && owner.kind !== 'IDB'
      ? { kind: owner.kind, iface: ifaceOf(owner.interface) }
      : { kind: 'OB', iface: emptyIface() };

  const ctx: AwlContext = {
    owner: ownerInfo,
    symbol: (name) => symbols.find((s) => sameName(s.name, name)),
    block: (ref) =>
      'name' in ref
        ? blocks.find((b) => sameName(b.name, ref.name))
        : blocks.find((b) => b.kind === ref.kind && b.number === ref.number),
    resolve: typeResolver(device),
    allSymbols: () => symbols,
    allBlocks: () => blocks,
  };
  if (cpu) {
    const l = cpu.limits;
    ctx.limits = {
      timers: l.timers,
      counters: l.counters,
      mBytes: l.mBytes,
      inputBytes: l.inputBytes,
      outputBytes: l.outputBytes,
    };
  }
  return ctx;
}
