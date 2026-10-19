export type ConnectionType = 'pg' | 'op' | 'basic';

export const LOCAL_TSAP_PG = 0x0100;

const TYPE_CODE: Record<ConnectionType, number> = { pg: 1, op: 2, basic: 3 };

/** Proto §2.3: (tipo << 8) | (rack*32 + slot). */
export function remoteTsap(type: ConnectionType, rack: number, slot: number): number {
  if (!Number.isInteger(rack) || rack < 0 || rack > 7)
    throw new RangeError(`rack ${rack} fuori 0-7`);
  if (!Number.isInteger(slot) || slot < 0 || slot > 31)
    throw new RangeError(`slot ${slot} fuori 0-31`);
  return (TYPE_CODE[type] << 8) | (rack * 32 + slot);
}
