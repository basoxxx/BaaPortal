// Conversione AWL → KOP/FUP di un blocco o di un segmento («Converti» di STEP 7). La rete si
// accetta solo se la sua traduzione dà le stesse istruzioni del testo AWL (`awlToLad`), con le
// stesse opzioni con cui `kopSources` la tradurrà dopo: bit L dopo i TEMP, etichette automatiche
// del blocco, ordine dei parametri delle CALL.
import {
  awlLabels,
  awlToLad,
  blockAwlToLad,
  blockToAwl,
  type AwlToLadFailure,
} from '@baaportal/ladfbd';
import { kopCallParams, kopSources, tempEnd } from './kopSources';
import { isGraphic, type CodeBlock, type PlcDevice } from './model';
import type { NewId } from './plc';

/** Un segmento (da 1) che resta AWL, col motivo. */
export type AwlConvertFailure = { network: number; reason: AwlToLadFailure };

function callParamsFor(block: CodeBlock, dev: PlcDevice) {
  const params = kopCallParams(block, dev);
  return (instance: string) => params(instance)?.map((p) => p.name);
}

/** Dopo un cambio dei grafici: le sorgenti di tutti i segmenti (le etichette sono per blocco). */
function refreshSources(block: CodeBlock, dev: PlcDevice): void {
  const sources = kopSources(block, dev);
  block.networks.forEach((n, i) => {
    n.source = sources[i]?.source ?? n.source;
  });
}

/**
 * Un blocco AWL diventa KOP o FUP solo se ogni segmento si converte: altrimenti non cambia niente
 * e il risultato elenca i segmenti che restano AWL. `dev` deve contenere il blocco (o un blocco
 * con lo stesso id e la stessa interfaccia) e i blocchi che chiama.
 */
export function convertBlockToGraphic(
  block: CodeBlock,
  dev: PlcDevice,
  language: 'KOP' | 'FUP',
  newId: NewId,
): AwlConvertFailure[] {
  if (block.language !== 'AWL') return [];
  const results = blockAwlToLad(
    block.networks.map((n) => n.source),
    { tempEnd: tempEnd(block, dev), callParams: callParamsFor(block, dev), newId },
  );
  // un segmento vuoto resta senza grafico: l'editor KOP lo mostra come rete vuota
  const blank = (i: number) => block.networks[i]!.source.trim() === '';
  const failed = results.flatMap((r, i) =>
    r.ok || blank(i) ? [] : [{ network: i + 1, reason: r.reason }],
  );
  if (failed.length > 0) return failed;
  block.language = language;
  block.networks.forEach((n, i) => {
    const r = results[i]!;
    if (r.ok) n.lad = r.network;
  });
  refreshSources(block, dev);
  return [];
}

/**
 * Il segmento AWL `index` (da 0) di un blocco KOP/FUP diventa grafico; `null` se è fatto,
 * altrimenti il motivo (il blocco non cambia).
 */
export function convertNetworkToGraphic(
  block: CodeBlock,
  dev: PlcDevice,
  index: number,
  newId: NewId,
): AwlToLadFailure | null {
  const n = block.networks[index];
  if (!n || n.lad || !isGraphic(block.language)) return { code: 'SHAPE' };
  const end = tempEnd(block, dev);
  const callParams = callParamsFor(block, dev);
  // le etichette automatiche dei segmenti grafici prima di questo
  const before = blockToAwl(
    block.networks.slice(0, index).map((x) => x.lad ?? null),
    end,
    { callParams },
  ).networks.filter((x) => x !== null);
  const sources = kopSources(block, dev);
  const foreignLabels = new Set(
    sources.flatMap((s, i) => (i === index ? [] : [...awlLabels(s.source)])),
  );
  const r = awlToLad(n.source, {
    tempEnd: end,
    firstLabel: before.at(-1)?.nextLabel ?? 1,
    callParams,
    foreignLabels,
    newId,
  });
  if (!r.ok) return r.reason;
  n.lad = r.network;
  refreshSources(block, dev);
  return null;
}
