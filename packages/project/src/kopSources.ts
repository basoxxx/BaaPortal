// Sorgenti AWL dei segmenti di un blocco: un segmento KOP con `lad` si traduce dal grafico, ogni
// altro segmento è la sua sorgente. Tutto ciò che compila, controlla, confronta o esporta le reti
// passa da qui (`blockSources`), così un blocco KOP si comporta come il suo AWL generato.
import type { AwlContext } from '@baaportal/awl';
import {
  blockToAwl,
  mapOperands,
  normalizeInstance,
  type LadDiag,
  type LadNetwork,
  type LineOwner,
} from '@baaportal/ladfbd';
import { tempEndByte } from '@baaportal/mc7';
import { sclToAwl, type SclAwl } from '@baaportal/scl';
import { formatType, sameName, type TypedMember } from '@baaportal/s7-types';
import { createAwlContext } from './awlContext';
import { toTypedMembers } from './members';
import { isGraphic, type CodeBlock, type PlcDevice } from './model';

/** Un parametro del blocco chiamato: direzione dall'interfaccia (RET_VAL è un'uscita). */
export type KopCallParam = { name: string; dir: 'in' | 'out' | 'inout'; type: string };
export type KopNetworkResult = {
  source: string;
  lines: LineOwner[];
  diagnostics: LadDiag[];
  /** Solo in un blocco SCL: errori SCL e corrispondenza riga AWL → riga SCL. */
  scl?: SclAwl;
};

const isKop = (block: CodeBlock, i: number): LadNetwork | undefined =>
  isGraphic(block.language) ? block.networks[i]?.lad : undefined;

/** Primo byte L libero dopo i TEMP dichiarati: stesso calcolo del compilatore (`codeEnvironment`). */
export function tempEnd(block: CodeBlock, dev: PlcDevice): number {
  return tempEndByte(
    toTypedMembers(block.interface.temp),
    createAwlContext(dev, block.id, undefined),
  );
}

/** Il blocco chiamato: `FC 1`, `SFB 3`, `"Nome"` o `Nome` (come scritto in un tipo). */
function calleeOf(ctx: AwlContext, ref: string) {
  const abs = /^%?\s*(SFC|SFB|FC|FB)\s*(\d+)$/i.exec(ref);
  return abs
    ? ctx.block({
        kind: abs[1]!.toUpperCase() as 'SFC' | 'SFB' | 'FC' | 'FB',
        number: Number(abs[2]),
      })
    : ctx.block({ name: ref.replace(/^"|"$/g, '') });
}

/**
 * Parametri del blocco chiamato da un box CALL, in ordine di dichiarazione (ingressi, RET_VAL,
 * uscite, ingressi/uscite). L'istanza è in forma canonica (`normalizeInstance`): `FC 1`, `SFC 6`,
 * `"Nome"`, `FB 1, DB 2`, `#multi` o `#"multi"` (multi-istanza: il tipo del dato statico, anche
 * scritto assoluto come `FB1`).
 */
function callParamsOf(
  ctx: AwlContext,
  block: CodeBlock,
  instance: string,
): KopCallParam[] | undefined {
  let callee = /^("[^"]*"|[^,]+)/.exec(instance)?.[1]?.trim() ?? '';
  if (callee.startsWith('#')) {
    const name = callee.slice(1).replace(/^"|"$/g, '');
    const member = block.interface.static.find((m) => sameName(m.name, name));
    if (!member) return undefined;
    callee = member.type.trim();
  }
  const i = calleeOf(ctx, callee)?.iface;
  if (!i) return undefined;
  const of = (ms: TypedMember[], dir: KopCallParam['dir']): KopCallParam[] =>
    ms.map((m) => ({ name: m.name, dir, type: formatType(m.type) }));
  const ret: KopCallParam[] =
    i.returnType && i.returnType.kind !== 'void'
      ? [{ name: 'RET_VAL', dir: 'out', type: formatType(i.returnType) }]
      : [];
  return [...of(i.input, 'in'), ...ret, ...of(i.output, 'out'), ...of(i.inOut, 'inout')];
}

/** Parametri del blocco chiamato da un box CALL, per l'editor KOP (`instance` come nell'editor). */
export function kopCallParams(
  block: CodeBlock,
  dev: PlcDevice,
): (instance: string) => KopCallParam[] | undefined {
  const ctx = createAwlContext(dev, block.id, undefined);
  return (instance) => callParamsOf(ctx, block, normalizeInstance(instance));
}

/** Un risultato per segmento, nell'ordine del blocco. */
export function kopSources(block: CodeBlock, dev: PlcDevice): KopNetworkResult[] {
  const nets = block.networks.map((_, i) => isKop(block, i) ?? null);
  const plain = (i: number): KopNetworkResult => ({
    source: block.networks[i]!.source,
    lines: [],
    diagnostics: [],
  });
  if (block.language === 'SCL') {
    const scl = sclToAwl(
      block.networks[0]?.source ?? '',
      createAwlContext(dev, block.id, undefined),
      tempEnd(block, dev),
    );
    // Un solo testo nel segmento 0; gli altri segmenti (non creati dall'app) restano come sono.
    return block.networks.map((_, i) =>
      i === 0 ? { source: scl.source, lines: [], diagnostics: [], scl } : plain(i),
    );
  }
  if (nets.every((n) => n === null)) return block.networks.map((_, i) => plain(i));
  const ctx = createAwlContext(dev, block.id, undefined);
  const { networks } = blockToAwl(nets, tempEnd(block, dev), {
    callParams: (instance) => callParamsOf(ctx, block, instance)?.map((p) => p.name),
  });
  return networks.map((r, i) =>
    r ? { source: r.source, lines: r.lines, diagnostics: r.diagnostics } : plain(i),
  );
}

/** L'AWL di ogni segmento, qualsiasi sia il linguaggio del blocco. */
export function blockSources(block: CodeBlock, dev: PlcDevice): string[] {
  return kopSources(block, dev).map((r) => r.source);
}

/**
 * L'elemento del grafico che ha prodotto la riga AWL `line` (da 1) del segmento `network` (da 1)
 * di un blocco KOP/FUP; `undefined` se il segmento non ha grafico o la riga non ha un proprietario.
 */
export function kopElemAt(
  block: CodeBlock,
  dev: PlcDevice,
  network: number,
  line: number,
): string | undefined {
  if (network < 1 || line < 1 || !isKop(block, network - 1)) return undefined;
  const lines = kopSources(block, dev)[network - 1]?.lines ?? [];
  return lines.filter((l) => l.line <= line - 1).at(-1)?.elemId;
}

/** Un intervallo dentro l'operando `field` dell'elemento `elemId` (offset nel testo dell'operando). */
export type KopOperandRef = { elemId: string; field: string; from: number; to: number };

/**
 * Per un risultato di Trova nel codice generato: se `len` caratteri da `col` (0, nella riga
 * `lineText` da 1 di `network`, da 0) cadono per intero dentro un solo operando dell'elemento che
 * ha prodotto la riga, dice quale e dove. `undefined` per il testo solo generato (mnemonici,
 * `:=`, etichette) o se la riga non scrive l'operando come nel grafico.
 */
export function kopOperandResolver(
  block: CodeBlock,
  dev: PlcDevice,
): (
  network: number,
  line: number,
  lineText: string,
  col: number,
  len: number,
) => KopOperandRef | undefined {
  const results = kopSources(block, dev);
  return (network, line, lineText, col, len) => {
    const lad = isKop(block, network);
    const elemId = results[network]?.lines.filter((l) => l.line <= line - 1).at(-1)?.elemId;
    if (!lad || !elemId) return undefined;
    const found = new Map<string, KopOperandRef>();
    mapOperands(lad, (value, _role, at) => {
      if (at.id !== elemId || value === '') return value;
      for (let i = lineText.indexOf(value); i >= 0; i = lineText.indexOf(value, i + 1)) {
        if (col >= i && col + len <= i + value.length) {
          found.set(at.field, { elemId, field: at.field, from: col - i, to: col - i + len });
        }
      }
      return value;
    });
    return found.size === 1 ? [...found.values()][0] : undefined;
  };
}
