// Schermate HMI di base (1.9): creazione degli oggetti e controllo delle variabili collegate.
import type { NewId } from './plc';
import type { HmiFormat, HmiObject, HmiObjectKind, HmiScreen, PlcDevice } from './model';
import type { WatchResolution, WatchTarget } from './watchOperand';

/** Dimensioni proposte per una schermata (pannelli da 7", 7" larghi e 10"). */
export const HMI_SCREEN_SIZES: readonly { width: number; height: number }[] = [
  { width: 800, height: 480 },
  { width: 1024, height: 600 },
  { width: 1280, height: 800 },
];
export const HMI_OBJECT_KINDS: readonly HmiObjectKind[] = [
  'text',
  'ioField',
  'button',
  'lamp',
  'bar',
  'screenButton',
];
export const HMI_FORMATS: readonly HmiFormat[] = ['INT', 'DINT', 'REAL', 'HEX', 'BOOL'];
/** Gli oggetti che leggono o scrivono una variabile. */
export const HMI_TAG_KINDS: ReadonlySet<HmiObjectKind> = new Set([
  'ioField',
  'button',
  'lamp',
  'bar',
]);
/** Passo della griglia dell'editor (px). */
export const HMI_GRID = 10;
/** Tetti di forma: difesa da file non fidati. */
export const HMI_MAX_SIZE = 4096;

const DEFAULT_SIZE: Record<HmiObjectKind, [number, number]> = {
  text: [120, 30],
  ioField: [100, 30],
  button: [100, 40],
  lamp: [40, 40],
  bar: [40, 120],
  screenButton: [120, 40],
};

export function createHmiScreen(name: string, newId: NewId): HmiScreen {
  return { id: newId(), name, width: 800, height: 480, background: '#d8dde3', objects: [] };
}

/** Un oggetto nuovo con le proprietà predefinite del suo tipo. */
export function createHmiObject(
  kind: HmiObjectKind,
  x: number,
  y: number,
  newId: NewId,
): HmiObject {
  const [w, h] = DEFAULT_SIZE[kind];
  const base: HmiObject = { id: newId(), kind, x, y, w, h, text: '' };
  switch (kind) {
    case 'text':
      return { ...base, text: 'Testo' };
    case 'ioField':
      return { ...base, tag: '', format: 'INT', input: false };
    case 'button':
      return { ...base, text: 'Pulsante', tag: '', action: 'set' };
    case 'lamp':
      return { ...base, tag: '', onColor: '#2ecc40', offColor: '#555555' };
    case 'bar':
      return { ...base, tag: '', min: 0, max: 100 };
    case 'screenButton':
      return { ...base, text: 'Schermata' };
  }
}

export const findHmiScreen = (d: PlcDevice, id: string): HmiScreen | undefined =>
  d.hmi?.screens.find((s) => s.id === id);

export function addHmiScreen(device: PlcDevice, screen: HmiScreen): void {
  (device.hmi ??= { screens: [] }).screens.push(screen);
}

/** Toglie la schermata; i pulsanti che la aprivano restano senza destinazione. */
export function deleteHmiScreen(device: PlcDevice, id: string): void {
  const screens = device.hmi?.screens;
  const at = screens?.findIndex((s) => s.id === id) ?? -1;
  if (!screens || at < 0) return;
  screens.splice(at, 1);
  for (const s of screens) for (const o of s.objects) if (o.screen === id) delete o.screen;
}

const FORMAT_SIZES: Record<HmiFormat, readonly WatchTarget['size'][]> = {
  INT: ['W'],
  DINT: ['D'],
  REAL: ['D'],
  HEX: ['B', 'W', 'D'],
  BOOL: ['X'],
};

/** Motivo per cui la variabile risolta non va bene per l'oggetto. */
export type HmiTagProblem = 'BIT_REQUIRED' | 'FORMAT_SIZE' | 'NUMBER_REQUIRED' | 'NOT_WRITABLE';

/**
 * Controlla la variabile risolta per il tipo di oggetto: lampade e pulsanti a bit vogliono un bit,
 * il campo di I/O una dimensione adatta al formato, la barra un numero. Timer, contatori e periferia
 * non si scrivono da un pulsante o da un campo di immissione.
 */
export function hmiTagProblem(
  o: Pick<HmiObject, 'kind' | 'format' | 'action' | 'input'>,
  r: Extract<WatchResolution, { ok: true }>,
): HmiTagProblem | null {
  const size = r.target.size;
  const writes = o.kind === 'button' || (o.kind === 'ioField' && o.input === true);
  if (writes && !['I', 'Q', 'M', 'DB'].includes(r.target.area)) return 'NOT_WRITABLE';
  switch (o.kind) {
    case 'lamp':
      return size === 'X' ? null : 'BIT_REQUIRED';
    case 'button':
      return o.action === 'write' || size === 'X' ? null : 'BIT_REQUIRED';
    case 'ioField':
      return FORMAT_SIZES[o.format ?? 'INT'].includes(size) ? null : 'FORMAT_SIZE';
    case 'bar':
      return size === 'X' ? 'NUMBER_REQUIRED' : null;
    default:
      return null;
  }
}
