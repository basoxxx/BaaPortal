import { readU16 } from '../bytes';
import { S7Error } from '../errors';
import { type BlockType } from './blocks';
import { blockFileName, parseBlockFileName, type BlockFilesystem } from './upload';

/**
 * Codec PLC control `0x28` e stop `0x29` (proto §10.4, §11).
 *
 * Allowlist: `P_PROGRAM` (stop e warm restart), `_INSE` (attivazione blocco), `_DELE` (cancella
 * blocco), `_MODU` (copia RAM in ROM) e `_GARB` (comprimi memoria). Il cold restart NON è
 * implementato: in decodifica risulta "non ammesso" (`service` assente). Nessuna gestione
 * password (proto §14).
 */
export type PiService = 'P_PROGRAM' | '_INSE' | '_DELE' | '_MODU' | '_GARB';

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `control: ${msg}`);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function text(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]!);
  return s;
}

// ---- richieste -------------------------------------------------------------------------------

/** Stop (proto §11.1): `29` + 5 zero + len2 `0x09` + `"P_PROGRAM"`. */
export function encodePlcStop(): Uint8Array {
  return Uint8Array.from([0x29, 0, 0, 0, 0, 0, 9, ...ascii('P_PROGRAM')]);
}

/** Warm restart (proto §11.2): `28` + 7 ignoti (ultimo `0xFD`) + len1 `0x0000` + len2 `0x09` + `"P_PROGRAM"`. */
export function encodeWarmRestart(): Uint8Array {
  return Uint8Array.from([0x28, 0, 0, 0, 0, 0, 0, 0xfd, 0, 0, 9, ...ascii('P_PROGRAM')]);
}

/**
 * `_INSE` (proto §10.4): `28` + 7 ignoti (ultimo `0xFD`) + len1 `0x000A` + conteggio blocchi `01` + `00`
 * + nome senza il trattino (tipo ASCII a 2 caratteri, numero a 5 cifre, filesystem) + len2 `0x05` + `"_INSE"`.
 */
export function encodeInsertBlock(
  type: BlockType,
  number: number,
  fs: BlockFilesystem,
): Uint8Array {
  const name = blockFileName(type, number, fs).slice(1); // 8 caratteri
  return Uint8Array.from([
    ...[0x28, 0, 0, 0, 0, 0, 0, 0xfd],
    ...[0, 2 + name.length, 1, 0],
    ...ascii(name),
    5,
    ...ascii('_INSE'),
  ]);
}

/**
 * `_DELE` (proto §10.5): stessa struttura di `_INSE` con servizio `"_DELE"`. L'argomento è il
 * nome del blocco come in `_INSE` (tipo, numero, filesystem); la "subfun" 0x42 del proto è il filesystem `B`. Non verificato su CPU reale;
 * provato contro il server di prova.
 */
export function encodeDeleteBlock(
  type: BlockType,
  number: number,
  fs: BlockFilesystem,
): Uint8Array {
  const name = blockFileName(type, number, fs).slice(1); // 8 caratteri
  return Uint8Array.from([
    ...[0x28, 0, 0, 0, 0, 0, 0, 0xfd],
    ...[0, 2 + name.length, 1, 0],
    ...ascii(name),
    5,
    ...ascii('_DELE'),
  ]);
}

/** `_MODU`, copia RAM in ROM (proto §11.3, §17.11): argomento `"EP"`, len1 `0x0002`. */
export function encodeCopyRamToRom(): Uint8Array {
  return Uint8Array.from([
    0x28,
    0,
    0,
    0,
    0,
    0,
    0,
    0xfd,
    0,
    2,
    ...ascii('EP'),
    5,
    ...ascii('_MODU'),
  ]);
}

/** `_GARB`, comprimi la memoria (proto §11.3, §17.11): nessun argomento, len1 `0x0000`. */
export function encodeCompressMemory(): Uint8Array {
  return Uint8Array.from([0x28, 0, 0, 0, 0, 0, 0, 0xfd, 0, 0, 5, ...ascii('_GARB')]);
}

// ---- risposte --------------------------------------------------------------------------------

export interface ControlResult {
  code: number;
  name: string;
}

const RESULT_NAMES: Record<number, string> = {
  0x00: 'ok',
  0x07: 'già STOP',
  0x03: 'già RUN',
  0x02: 'non eseguibile',
};

/**
 * Risposta ack-data: param = eco del codice funzione, opzionalmente seguito dal byte `para`
 * (proto §11.4). Le catture reali hanno il solo eco (esito "ok"): `para` assente vale 0.
 */
export function decodeControlResponse(param: Uint8Array): ControlResult {
  if (param.length < 1 || param.length > 2) throw bad(`risposta di ${param.length} byte`);
  const fn = param[0]!;
  if (fn !== 0x28 && fn !== 0x29) throw bad(`risposta con funzione 0x${fn.toString(16)}`);
  const code = param.length === 2 ? param[1]! : 0;
  return {
    code,
    name: RESULT_NAMES[code] ?? `sconosciuto 0x${code.toString(16).padStart(2, '0')}`,
  };
}

export function encodeControlResponse(fn: 0x28 | 0x29, code: number): Uint8Array {
  if (!Number.isInteger(code) || code < 0 || code > 0xff) throw new RangeError(`codice ${code}`);
  return code === 0 ? Uint8Array.from([fn]) : Uint8Array.from([fn, code]);
}

// ---- decodifica lato finto PLC ---------------------------------------------------------------

export function decodePlcControlRequest(param: Uint8Array): {
  function: 0x28 | 0x29;
  service?: PiService;
  block?: { type: BlockType; number: number };
} {
  const fn = param[0];
  if (fn === 0x29) {
    // 29 + 5 zero + len2 + servizio
    if (param.length < 7) throw bad('stop troncato');
    const len2 = param[6]!;
    if (param.length !== 7 + len2) throw bad('stop: lunghezza del servizio incoerente');
    const svc = text(param, 7, len2);
    return svc === 'P_PROGRAM' ? { function: 0x29, service: 'P_PROGRAM' } : { function: 0x29 };
  }
  if (fn !== 0x28) throw bad(`funzione 0x${(fn ?? 0).toString(16)} non è 0x28/0x29`);
  // 28 + 7 ignoti + len1(2) + argomenti(len1) + len2(1) + servizio
  if (param.length < 11) throw bad('control troncato');
  const len1 = readU16(param, 8);
  const l2 = 10 + len1;
  if (param.length < l2 + 1) throw bad('control: argomenti oltre la fine');
  const len2 = param[l2]!;
  if (param.length !== l2 + 1 + len2) throw bad('control: lunghezza del servizio incoerente');
  const svc = text(param, l2 + 1, len2);
  if (svc === 'P_PROGRAM' && len1 === 0) return { function: 0x28, service: 'P_PROGRAM' };
  if ((svc === '_INSE' || svc === '_DELE') && len1 === 10 && param[10] === 1 && param[11] === 0) {
    try {
      const f = parseBlockFileName('_' + text(param, 12, 8));
      return { function: 0x28, service: svc, block: { type: f.type, number: f.number } };
    } catch {
      return { function: 0x28 };
    }
  }
  if (svc === '_GARB' && len1 === 0) return { function: 0x28, service: '_GARB' };
  if (svc === '_MODU' && len1 === 2 && text(param, 10, 2) === 'EP') {
    return { function: 0x28, service: '_MODU' };
  }
  // cold restart (argomento "C "), altri servizi, varianti con argomenti diversi: non ammessi
  return { function: 0x28 };
}
