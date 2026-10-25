// Sorgenti AWL dei segmenti di un blocco: un segmento KOP con `lad` si traduce dal grafico, ogni
// altro segmento è la sua sorgente. Tutto ciò che compila, controlla, confronta o esporta le reti
// passa da qui (`blockSources`), così un blocco KOP si comporta come il suo AWL generato.
import type { AwlContext } from '@baaportal/awl';
import { blockToAwl, type LadDiag, type LadNetwork, type LineOwner } from '@baaportal/ladfbd';
import { tempEndByte } from '@baaportal/mc7';
import { sameName } from '@baaportal/s7-types';
import { createAwlContext } from './awlContext';
import { toTypedMembers } from './members';
import type { CodeBlock, PlcDevice } from './model';

export type KopNetworkResult = { source: string; lines: LineOwner[]; diagnostics: LadDiag[] };

const isKop = (block: CodeBlock, i: number): LadNetwork | undefined =>
  block.language === 'KOP' ? block.networks[i]?.lad : undefined;

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
function callParamsOf(ctx: AwlContext, block: CodeBlock, instance: string): string[] | undefined {
  let callee = /^("[^"]*"|[^,]+)/.exec(instance)?.[1]?.trim() ?? '';
  if (callee.startsWith('#')) {
    const name = callee.slice(1).replace(/^"|"$/g, '');
    const member = block.interface.static.find((m) => sameName(m.name, name));
    if (!member) return undefined;
    callee = member.type.trim();
  }
  const i = calleeOf(ctx, callee)?.iface;
  if (!i) return undefined;
  const ret = i.returnType && i.returnType.kind !== 'void' ? [{ name: 'RET_VAL' }] : [];
  return [...i.input, ...ret, ...i.output, ...i.inOut].map((m) => m.name);
}

/** Un risultato per segmento, nell'ordine del blocco. */
export function kopSources(block: CodeBlock, dev: PlcDevice): KopNetworkResult[] {
  const nets = block.networks.map((_, i) => isKop(block, i) ?? null);
  const plain = (i: number): KopNetworkResult => ({
    source: block.networks[i]!.source,
    lines: [],
    diagnostics: [],
  });
  if (nets.every((n) => n === null)) return block.networks.map((_, i) => plain(i));
  const ctx = createAwlContext(dev, block.id, undefined);
  const { networks } = blockToAwl(nets, tempEnd(block, dev), {
    callParams: (instance) => callParamsOf(ctx, block, instance),
  });
  return networks.map((r, i) =>
    r ? { source: r.source, lines: r.lines, diagnostics: r.diagnostics } : plain(i),
  );
}

/** L'AWL di ogni segmento, qualsiasi sia il linguaggio del blocco. */
export function blockSources(block: CodeBlock, dev: PlcDevice): string[] {
  return kopSources(block, dev).map((r) => r.source);
}
