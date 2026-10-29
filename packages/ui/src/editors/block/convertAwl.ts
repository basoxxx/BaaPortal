// «Converti in KOP/FUP»: un blocco AWL intero (solo se ogni segmento si converte) o i segmenti AWL
// di un blocco KOP/FUP. La prova gira su una copia: il progetto cambia, con un solo passo di
// annullamento, solo se almeno un segmento diventa grafico; ogni segmento che resta AWL ha il suo
// messaggio col motivo.
import type { StoreApi } from 'zustand/vanilla';
import type { AwlToLadFailure } from '@baaportal/ladfbd';
import {
  convertBlockToGraphic,
  convertNetworkToGraphic,
  findDevice,
  isGraphic,
  type CodeBlock,
  type PlcDevice,
  type Project,
} from '@baaportal/project';
import type { AppState } from '../../state/store';
import { isLockedImport } from './readOnlyImport';

const newId = () => globalThis.crypto.randomUUID();

/** Il blocco di codice modificabile `blockId`, se il suo codice (tutto o in parte) è AWL. */
function target(p: Project, deviceId: string, blockId: string) {
  const dev = findDevice(p, deviceId);
  const b = dev?.blocks.find((x) => x.id === blockId);
  if (!dev || !b || b.kind === 'DB' || b.kind === 'IDB' || isLockedImport(b)) return undefined;
  return b.language === 'AWL' || (isGraphic(b.language) && awlNetworks(b).length > 0)
    ? { dev, b }
    : undefined;
}

/** Indici dei segmenti AWL di un blocco KOP/FUP (con codice e senza grafico). */
const awlNetworks = (b: CodeBlock): number[] =>
  b.networks.flatMap((n, i) => (!n.lad && n.source.trim() !== '' ? [i] : []));

/** C'è qualcosa da convertire nel blocco. */
export const canConvertAwl = (s: AppState, deviceId: string, blockId: string): boolean =>
  !!s.doc && target(s.doc.project, deviceId, blockId) !== undefined;

/** Converte nel blocco i segmenti `only` (indici; tutti se manca). Restituisce i segmenti rimasti AWL. */
function apply(
  b: CodeBlock,
  dev: PlcDevice,
  only: number[] | undefined,
  id: () => string,
): { network: number; reason: AwlToLadFailure }[] {
  if (b.language === 'AWL') return convertBlockToGraphic(b, dev, 'KOP', id);
  return (only ?? awlNetworks(b)).flatMap((i) => {
    const reason = convertNetworkToGraphic(b, dev, i, id);
    return reason ? [{ network: i + 1, reason }] : [];
  });
}

/**
 * Converte il blocco (AWL: tutto o niente, diventa KOP) o i suoi segmenti AWL (`network`: solo
 * quello, da 0). Gli id dei nuovi elementi sono quelli della prova, così la modifica è la stessa.
 */
export function convertAwl(
  store: StoreApi<AppState>,
  deviceId: string,
  blockId: string,
  network?: number,
): void {
  const s = store.getState();
  const t = s.doc ? target(s.doc.project, deviceId, blockId) : undefined;
  if (!t) return;
  const only = network === undefined ? undefined : [network];
  const ids: string[] = [];
  const trial = structuredClone(t.b);
  const failed = apply(trial, t.dev, only, () => {
    const x = newId();
    ids.push(x);
    return x;
  });
  const before = t.b.language === 'AWL' ? 0 : awlNetworks(t.b).length;
  const changed = t.b.language === 'AWL' ? failed.length === 0 : awlNetworks(trial).length < before;
  for (const f of failed) {
    s.pushMessage({
      severity: 'warning',
      textKey: `messages.awlConvert.${f.reason.code}`,
      params: { block: t.b.name, network: String(f.network), line: String(f.reason.line ?? 1) },
    });
  }
  if (!changed) return;
  let k = 0;
  s.edit('history.convertToGraphic', (p) => {
    const d = target(p, deviceId, blockId);
    if (d) apply(d.b, d.dev, only, () => ids[k++] ?? newId());
  });
}
