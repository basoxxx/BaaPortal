// Traduzione KOP → AWL di un blocco intero: le etichette automatiche `_001`, `_002`… crescono
// nel blocco nell'ordine dei segmenti (ipotesi H11), così non si ripetono fra segmenti diversi.
import type { LadNetwork } from './model.js';
import { networkToAwl } from './toAwl.js';
import type { NetworkAwl, NetworkAwlOpts } from './toAwl.js';

export type BlockAwlOpts = Pick<NetworkAwlOpts, 'callParams'>;

/**
 * Traduce i segmenti di un blocco. `null` = segmento senza KOP (resta la sua sorgente): il
 * risultato è `null` nella stessa posizione e non consuma etichette. `tempEnd`: primo byte L
 * libero dopo i TEMP dichiarati.
 */
export function blockToAwl(
  nets: (LadNetwork | null)[],
  tempEnd: number,
  opts: BlockAwlOpts = {},
): { networks: (NetworkAwl | null)[] } {
  let firstLabel = 1;
  const networks = nets.map((net) => {
    if (!net) return null;
    const r = networkToAwl(net, { ...opts, tempEnd, firstLabel });
    firstLabel = r.nextLabel;
    return r;
  });
  return { networks };
}
