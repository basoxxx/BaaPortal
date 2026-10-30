import { z } from 'zod';

// Catalogo dei moduli S7-300 per la vista dispositivi (tappa 6A). Fonti pubbliche, solo numeri
// d'articolo, numero di canali e occupazione degli indirizzi; nessun testo copiato. Le descrizioni
// brevi sono scritte qui, in forma tecnica in inglese (canali, tensione), uguali in ogni lingua.

/** Tipo di posto: alimentatore (posto 1), interfaccia (posto 3), modulo di I/O, CP o FM (posti 4–11). */
export type ModuleKind = 'PS' | 'IM' | 'SM' | 'CP' | 'FM';
/** Area degli indirizzi con l'indirizzamento fisso per posto: digitale o analogica. */
export type ModuleAddressing = 'digital' | 'analog' | 'none';
/** IM 360 (rack 0) e IM 361 (rack 1–3) collegano fino a 3 rack; la coppia IM 365 solo un rack. */
export type ImRole = 'im360' | 'im361' | 'im365';

export interface ModuleType {
  orderNumber: string;
  name: string;
  /** Famiglia per il pannello del catalogo, es. «SM 321». */
  family: string;
  kind: ModuleKind;
  description: string;
  addressing: ModuleAddressing;
  /** Byte di ingresso e di uscita che il modulo occupa. */
  inputBytes: number;
  outputBytes: number;
  im?: ImRole;
  source: string;
}

export const moduleTypeSchema = z
  .object({
    orderNumber: z.string().regex(/^6(ES7|GK7) 3\d\d-[0-9A-Z]{5}-0[A-Z]{2}0$/),
    name: z.string().min(1),
    family: z.string().min(1),
    kind: z.enum(['PS', 'IM', 'SM', 'CP', 'FM']),
    description: z.string().min(1),
    addressing: z.enum(['digital', 'analog', 'none']),
    inputBytes: z.number().int().min(0).max(16),
    outputBytes: z.number().int().min(0).max(16),
    im: z.enum(['im360', 'im361', 'im365']).optional(),
    source: z.string().min(1),
  })
  .strict()
  // Digitale: al più i 4 byte del posto; analogico: al più i 16; PS e IM senza indirizzi.
  .refine((m) => {
    const used = Math.max(m.inputBytes, m.outputBytes);
    if (m.addressing === 'none') return used === 0;
    if (used === 0) return false;
    return m.addressing === 'digital' ? used <= 4 : used <= 16;
  }, 'Occupazione degli indirizzi incoerente con il tipo di indirizzamento')
  .refine((m) => (m.kind === 'IM') === (m.im !== undefined), 'Solo le IM hanno il ruolo IM')
  .refine(
    (m) => (m.kind === 'PS' || m.kind === 'IM') === (m.addressing === 'none'),
    'PS e IM non hanno indirizzi',
  );

// Fonti per famiglia.
const MODULE_DATA =
  'S7-300 Automation System, Module data, Manual 02/2013, A5E00105505-08 (https://support.industry.siemens.com/cs/document/8859629)';
const PS_SRC = `${MODULE_DATA}, cap. 2 (alimentatori PS 307)`;
const DI_SRC = `${MODULE_DATA}, cap. 3 (moduli di ingressi digitali SM 321)`;
const DO_SRC = `${MODULE_DATA}, cap. 3 (moduli di uscite digitali SM 322)`;
const DIO_SRC = `${MODULE_DATA}, cap. 3 (moduli di ingressi/uscite digitali SM 323)`;
const AI_SRC = `${MODULE_DATA}, cap. 6 (moduli di ingressi analogici SM 331)`;
const AO_SRC = `${MODULE_DATA}, cap. 6 (moduli di uscite analogiche SM 332)`;
const AIO_SRC = `${MODULE_DATA}, cap. 6 (moduli di ingressi/uscite analogici SM 334)`;
const IM_SRC = `${MODULE_DATA}, cap. 7 (moduli di interfaccia IM 360/361/365)`;
const CP_PTP_SRC =
  'CP 340 / CP 341 Point-to-Point Communication, Installation and Parameter Assignment, Manual (https://support.industry.siemens.com/cs/document/1117397, https://support.industry.siemens.com/cs/document/1117399)';
const CP_ETH_SRC =
  'SIMATIC NET S7-300 CP 343-1 Lean / CP 343-1, Manual Part B (https://support.industry.siemens.com/cs/document/22261695)';
const FM_SRC =
  'FM 350-1 Counter Module, Manual (https://support.industry.siemens.com/cs/document/1133974)';

type Row = Omit<ModuleType, 'source' | 'kind' | 'family' | 'addressing'>;
const family =
  (kind: ModuleKind, fam: string, addressing: ModuleAddressing, source: string) =>
  (rows: Row[]): ModuleType[] =>
    rows.map((r) => ({ ...r, kind, family: fam, addressing, source }));
const io = (inputBytes: number, outputBytes: number) => ({ inputBytes, outputBytes });

export const MODULE_CATALOG: readonly ModuleType[] = [
  ...family(
    'PS',
    'PS 307',
    'none',
    PS_SRC,
  )([
    {
      orderNumber: '6ES7 307-1BA01-0AA0',
      name: 'PS 307 2A',
      description: 'AC 120/230 V, DC 24 V / 2 A',
      ...io(0, 0),
    },
    {
      orderNumber: '6ES7 307-1EA01-0AA0',
      name: 'PS 307 5A',
      description: 'AC 120/230 V, DC 24 V / 5 A',
      ...io(0, 0),
    },
    {
      orderNumber: '6ES7 307-1KA02-0AA0',
      name: 'PS 307 10A',
      description: 'AC 120/230 V, DC 24 V / 10 A',
      ...io(0, 0),
    },
  ]),
  ...family(
    'IM',
    'IM 360/361/365',
    'none',
    IM_SRC,
  )([
    {
      orderNumber: '6ES7 360-3AA01-0AA0',
      name: 'IM 360',
      description: 'Interface in rack 0, up to 3 expansion racks',
      im: 'im360',
      ...io(0, 0),
    },
    {
      orderNumber: '6ES7 361-3CA01-0AA0',
      name: 'IM 361',
      description: 'Interface in racks 1–3, DC 24 V',
      im: 'im361',
      ...io(0, 0),
    },
    {
      orderNumber: '6ES7 365-0BA01-0AA0',
      name: 'IM 365',
      description: 'Interface pair, one expansion rack',
      im: 'im365',
      ...io(0, 0),
    },
  ]),
  ...family(
    'SM',
    'SM 321',
    'digital',
    DI_SRC,
  )([
    {
      orderNumber: '6ES7 321-1BH02-0AA0',
      name: 'DI 16x24VDC',
      description: '16 DI, DC 24 V',
      ...io(2, 0),
    },
    {
      orderNumber: '6ES7 321-7BH01-0AB0',
      name: 'DI 16x24VDC, Alarm',
      description: '16 DI, DC 24 V, diagnostics and hardware interrupts',
      ...io(2, 0),
    },
    {
      orderNumber: '6ES7 321-1BL00-0AA0',
      name: 'DI 32x24VDC',
      description: '32 DI, DC 24 V',
      ...io(4, 0),
    },
    {
      orderNumber: '6ES7 321-1FF01-0AA0',
      name: 'DI 8x120/230VAC',
      description: '8 DI, AC 120/230 V',
      ...io(1, 0),
    },
    {
      orderNumber: '6ES7 321-1FH00-0AA0',
      name: 'DI 16x120/230VAC',
      description: '16 DI, AC 120/230 V',
      ...io(2, 0),
    },
  ]),
  ...family(
    'SM',
    'SM 322',
    'digital',
    DO_SRC,
  )([
    {
      orderNumber: '6ES7 322-1BF01-0AA0',
      name: 'DO 8x24VDC/2A',
      description: '8 DO, DC 24 V / 2 A',
      ...io(0, 1),
    },
    {
      orderNumber: '6ES7 322-1BH01-0AA0',
      name: 'DO 16x24VDC/0.5A',
      description: '16 DO, DC 24 V / 0.5 A',
      ...io(0, 2),
    },
    {
      orderNumber: '6ES7 322-1BL00-0AA0',
      name: 'DO 32x24VDC/0.5A',
      description: '32 DO, DC 24 V / 0.5 A',
      ...io(0, 4),
    },
    {
      orderNumber: '6ES7 322-1FF01-0AA0',
      name: 'DO 8x120/230VAC/1A',
      description: '8 DO, AC 120/230 V / 1 A',
      ...io(0, 1),
    },
    {
      orderNumber: '6ES7 322-1HF01-0AA0',
      name: 'DO 8xRel. 230VAC/5A',
      description: '8 relay outputs, AC 230 V / 5 A',
      ...io(0, 1),
    },
    {
      orderNumber: '6ES7 322-1HH01-0AA0',
      name: 'DO 16xRel. 120/230VAC',
      description: '16 relay outputs, AC 120/230 V',
      ...io(0, 2),
    },
  ]),
  ...family(
    'SM',
    'SM 323',
    'digital',
    DIO_SRC,
  )([
    {
      orderNumber: '6ES7 323-1BH01-0AA0',
      name: 'DI 8/DO 8x24VDC/0.5A',
      description: '8 DI, 8 DO, DC 24 V / 0.5 A',
      ...io(1, 1),
    },
    {
      orderNumber: '6ES7 323-1BL00-0AA0',
      name: 'DI 16/DO 16x24VDC/0.5A',
      description: '16 DI, 16 DO, DC 24 V / 0.5 A',
      ...io(2, 2),
    },
  ]),
  ...family(
    'SM',
    'SM 331',
    'analog',
    AI_SRC,
  )([
    {
      orderNumber: '6ES7 331-7KB02-0AB0',
      name: 'AI 2x12Bit',
      description: '2 AI, 9–14 bit, U, I, R, TC',
      ...io(4, 0),
    },
    {
      orderNumber: '6ES7 331-7KF02-0AB0',
      name: 'AI 8x12Bit',
      description: '8 AI, 9–14 bit, U, I, R, TC',
      ...io(16, 0),
    },
    {
      orderNumber: '6ES7 331-7NF00-0AB0',
      name: 'AI 8x16Bit',
      description: '8 AI, 16 bit, U, I, isolated',
      ...io(16, 0),
    },
    {
      orderNumber: '6ES7 331-7PF01-0AB0',
      name: 'AI 8xRTD',
      description: '8 AI RTD, 16 bit',
      ...io(16, 0),
    },
    {
      orderNumber: '6ES7 331-7PF11-0AB0',
      name: 'AI 8xTC',
      description: '8 AI TC, 16 bit',
      ...io(16, 0),
    },
  ]),
  ...family(
    'SM',
    'SM 332',
    'analog',
    AO_SRC,
  )([
    {
      orderNumber: '6ES7 332-5HB01-0AB0',
      name: 'AO 2x12Bit',
      description: '2 AO, 12 bit, U, I',
      ...io(0, 4),
    },
    {
      orderNumber: '6ES7 332-5HD01-0AB0',
      name: 'AO 4x12Bit',
      description: '4 AO, 12 bit, U, I',
      ...io(0, 8),
    },
    {
      orderNumber: '6ES7 332-5HF00-0AB0',
      name: 'AO 8x12Bit',
      description: '8 AO, 12 bit, U, I',
      ...io(0, 16),
    },
  ]),
  ...family(
    'SM',
    'SM 334',
    'analog',
    AIO_SRC,
  )([
    {
      orderNumber: '6ES7 334-0CE01-0AA0',
      name: 'AI 4/AO 2x8Bit',
      description: '4 AI, 2 AO, 8 bit',
      ...io(8, 4),
    },
    {
      orderNumber: '6ES7 334-0KE00-0AB0',
      name: 'AI 4/AO 2x12Bit',
      description: '4 AI, 2 AO, 12 bit',
      ...io(8, 4),
    },
  ]),
  ...family(
    'CP',
    'CP 340/341',
    'analog',
    CP_PTP_SRC,
  )([
    {
      orderNumber: '6ES7 340-1AH02-0AE0',
      name: 'CP 340 RS232C',
      description: 'Point-to-point, RS 232C',
      ...io(16, 16),
    },
    {
      orderNumber: '6ES7 340-1CH02-0AE0',
      name: 'CP 340 RS422/485',
      description: 'Point-to-point, RS 422/485',
      ...io(16, 16),
    },
    {
      orderNumber: '6ES7 341-1AH02-0AE0',
      name: 'CP 341 RS232C',
      description: 'Point-to-point, RS 232C, loadable drivers',
      ...io(16, 16),
    },
    {
      orderNumber: '6ES7 341-1CH02-0AE0',
      name: 'CP 341 RS422/485',
      description: 'Point-to-point, RS 422/485, loadable drivers',
      ...io(16, 16),
    },
  ]),
  ...family(
    'CP',
    'CP 343-1',
    'analog',
    CP_ETH_SRC,
  )([
    {
      orderNumber: '6GK7 343-1CX10-0XE0',
      name: 'CP 343-1 Lean',
      description: 'Industrial Ethernet, S7 and open communication',
      ...io(16, 16),
    },
    {
      orderNumber: '6GK7 343-1EX30-0XE0',
      name: 'CP 343-1',
      description: 'Industrial Ethernet, PROFINET IO',
      ...io(16, 16),
    },
  ]),
  ...family(
    'FM',
    'FM 350-1',
    'analog',
    FM_SRC,
  )([
    {
      orderNumber: '6ES7 350-1AH03-0AE0',
      name: 'FM 350-1',
      description: 'Counter, 1 channel, up to 500 kHz',
      ...io(16, 16),
    },
  ]),
];

const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const BY_ORDER = new Map(MODULE_CATALOG.map((m) => [norm(m.orderNumber), m]));

export function findModule(orderNumber: string): ModuleType | undefined {
  return BY_ORDER.get(norm(orderNumber));
}

/** Posti del rack S7-300: 1 PS, 2 CPU, 3 IM, 4–11 moduli. */
export const RACK_SLOTS = 11;
export const FIRST_IO_SLOT = 4;
/** Rack 0 con la CPU e fino a 3 rack di ampliamento. */
export const MAX_RACKS = 4;

/** Tipi di modulo ammessi nel posto `slot` del rack `rack`. */
export function slotAccepts(m: ModuleType, rack: number, slot: number): boolean {
  if (slot === 1) return m.kind === 'PS';
  if (slot === 2) return false; // la CPU, solo nel rack 0
  if (slot === 3) {
    if (m.kind !== 'IM') return false;
    if (rack === 0) return m.im === 'im360' || m.im === 'im365';
    return m.im === 'im361' || (m.im === 'im365' && rack === 1);
  }
  return slot >= FIRST_IO_SLOT && slot <= RACK_SLOTS && m.kind !== 'PS' && m.kind !== 'IM';
}

/**
 * Indirizzo iniziale fisso per posto (manuale «S7-300 Installation», indirizzamento orientato al posto):
 * digitale 32·rack + 4·(posto−4), analogico 256 + 128·rack + 16·(posto−4).
 */
export function defaultStartAddress(m: ModuleType, rack: number, slot: number): number | undefined {
  const i = slot - FIRST_IO_SLOT;
  if (m.addressing === 'digital') return 32 * rack + 4 * i;
  if (m.addressing === 'analog') return 256 + 128 * rack + 16 * i;
  return undefined;
}
