import { sameName } from '@baaportal/s7-types';
import type { PlcDevice } from '@baaportal/project';

/** Il blocco trascinato dall'albero come istanza di un box CALL: simbolo, con il suo DB per un FB. */
export function callInstanceOf(dev: PlcDevice | undefined, raw: string): string | undefined {
  let ref: { deviceId?: string; refs?: { kind?: string; id?: string }[] } | null;
  try {
    ref = JSON.parse(raw) as typeof ref;
  } catch {
    return undefined;
  }
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref.refs?.length === 1 ? ref.refs[0] : undefined;
  const b = r?.kind === 'block' ? dev?.blocks.find((x) => x.id === r.id) : undefined;
  if (!dev || ref.deviceId !== dev.id || !b || (b.kind !== 'FC' && b.kind !== 'FB'))
    return undefined;
  if (b.kind === 'FC') return `"${b.name}"`;
  const idb = dev.blocks.find((x) => x.kind === 'IDB' && sameName(x.instanceOf, b.name));
  // Senza DB di istanza la parte del DB resta vuota: il controllo KOP segnala BAD_INSTANCE finché non si compila.
  return `"${b.name}", ${idb ? `"${idb.name}"` : ''}`;
}
