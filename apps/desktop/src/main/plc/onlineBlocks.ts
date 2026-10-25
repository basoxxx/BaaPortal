import { S7Error, type BlockType, type S7Client } from '@baaportal/s7comm';
import type { OnlineBlock, PlcBlocksResult, PlcUploadBlockResult } from '@baaportal/ui';
import type { PlcOwner, PlcService } from './plcService';

/** Tipi che si elencano dalla CPU: SFC, SFB e SDB non si confrontano. */
const LISTED: BlockType[] = ['OB', 'FB', 'FC', 'DB'];
/** Informazioni lette per posto in coda: tra un lotto e l'altro gira la sorveglianza. */
export const BATCH = 10;
/** Oltre questo numero di blocchi l'elenco non si fa. */
export const MAX_BLOCKS = 2000;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Elenco dei blocchi OB, FB, FC e DB della CPU collegata alla finestra, con lunghezze e checksum
 * (una richiesta di informazioni per blocco, a lotti). Solo letture, sul collegamento del 3A e in
 * coda alla sorveglianza. Un errore della CPU su un blocco lo segna `unreadable` senza far
 * fallire il resto; gli errori di collegamento (chiuso, senza risposta) fanno fallire tutto.
 */
export async function listOnlineBlocks(
  service: PlcService,
  owner: PlcOwner,
  deadlineMs?: number,
): Promise<PlcBlocksResult> {
  const r = await service.read(
    owner,
    async (run) => {
      const todo: { type: BlockType; number: number }[] = [];
      for (const type of LISTED) {
        for (const e of await run((c) => c.listBlocks(type))) todo.push({ type, number: e.number });
        if (todo.length > MAX_BLOCKS) {
          throw new Error(`Troppi blocchi nella CPU (oltre ${MAX_BLOCKS}): confronto non eseguito`);
        }
      }
      const blocks: OnlineBlock[] = [];
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        blocks.push(
          ...(await run(async (c) => {
            const out: OnlineBlock[] = [];
            for (const { type, number } of batch) out.push(await infoOf(c, type, number));
            return out;
          })),
        );
      }
      return blocks;
    },
    deadlineMs,
  );
  return r.ok ? { ok: true, blocks: r.value } : { ok: false, error: r.error };
}

async function infoOf(
  c: Pick<S7Client, 'blockInfo'>,
  type: BlockType,
  number: number,
): Promise<OnlineBlock> {
  const bad: OnlineBlock = {
    type: type as OnlineBlock['type'],
    number,
    loadLength: 0,
    mc7Length: 0,
    checksum: 0,
    unreadable: true,
  };
  let info;
  try {
    info = await c.blockInfo(type, number);
  } catch (e) {
    if (e instanceof S7Error && e.code === 'CPU_ERROR') return bad;
    throw e;
  }
  if (info.checksum === undefined || info.mc7Length === undefined) return bad;
  const t = info.codeTime;
  return {
    type: type as OnlineBlock['type'],
    number,
    loadLength: info.loadLength ?? 0,
    mc7Length: info.mc7Length,
    checksum: info.checksum,
    ...(t
      ? {
          codeTime: `${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}`,
        }
      : {}),
  };
}

export const isUploadableType = (v: unknown): v is 'OB' | 'FB' | 'FC' | 'DB' =>
  typeof v === 'string' && (LISTED as string[]).includes(v);

/** Carica un solo blocco dal collegamento della finestra (sola lettura, in coda alla sorveglianza). */
export async function uploadOneBlock(
  service: PlcService,
  owner: PlcOwner,
  type: BlockType,
  number: number,
): Promise<PlcUploadBlockResult> {
  const r = await service.read(owner, (run) => run((c) => c.uploadWithInfo(type, number)));
  return r.ok ? { ok: true, bytes: r.value.bytes } : { ok: false, error: r.error };
}
