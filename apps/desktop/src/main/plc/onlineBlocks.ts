import type { BlockType } from '@baaportal/s7comm';
import type { OnlineBlock, PlcBlocksResult } from '@baaportal/ui';
import type { PlcOwner, PlcService } from './plcService';

/** Tipi che si elencano dalla CPU: SFC, SFB e SDB non si confrontano. */
const LISTED: BlockType[] = ['OB', 'FB', 'FC', 'DB'];

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Elenco dei blocchi OB, FB, FC e DB della CPU collegata alla finestra, con lunghezze e checksum
 * (una richiesta di informazioni per blocco). Solo letture, sul collegamento del 3A e in coda alla
 * sorveglianza; senza collegamento dà `{ ok: false, error }`.
 */
export async function listOnlineBlocks(
  service: PlcService,
  owner: PlcOwner,
): Promise<PlcBlocksResult> {
  const r = await service.read(owner, async (client) => {
    const blocks: OnlineBlock[] = [];
    for (const type of LISTED) {
      for (const entry of await client.listBlocks(type)) {
        const info = await client.blockInfo(type, entry.number);
        const t = info.codeTime;
        blocks.push({
          type: type as OnlineBlock['type'],
          number: entry.number,
          loadLength: info.loadLength ?? 0,
          mc7Length: info.mc7Length ?? 0,
          checksum: info.checksum ?? 0,
          ...(t
            ? {
                codeTime: `${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}`,
              }
            : {}),
        });
      }
    }
    return blocks;
  });
  return r.ok ? { ok: true, blocks: r.value } : { ok: false, error: r.error };
}
