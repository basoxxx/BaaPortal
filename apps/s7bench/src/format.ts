import {
  blockLanguageName,
  commFrom,
  decodeBlockInfo,
  decodeBlockInfoRequest,
  decodeBlockListOfTypeRequest,
  decodeUserdata,
  diagFrom,
  dissect,
  identityFrom,
  modeFrom,
  protectionFrom,
  type BlockInfo,
  type S7DateTime,
  type SzlList,
} from '@baaportal/s7comm';

const WEEKDAYS = ['', 'domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;

const p2 = (n: number | string, w = 2): string => String(n).padStart(w, '0');

export const hex2 = (b: Uint8Array): string => Array.from(b, (x) => p2(x.toString(16))).join(' ');

export const hexN = (n: number, w: number): string => `0x${n.toString(16).padStart(w, '0')}`;

/** Data e ora della CPU come stringa ISO senza fuso (la CPU non lo dà). */
export function isoOf(t: S7DateTime): string {
  return `${p2(t.year, 4)}-${p2(t.month)}-${p2(t.day)}T${p2(t.hour)}:${p2(t.minute)}:${p2(t.second)}.${p2(t.ms, 3)}`;
}

export function weekdayOf(t: S7DateTime): string {
  return WEEKDAYS[t.weekday ?? 0] || '—';
}

/** Dump esadecimale: 16 byte per riga, con offset (assoluto, da `base`) e colonna ASCII. */
export function hexDump(bytes: Uint8Array, base = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const left = Array.from(row, (x) => p2(x.toString(16))).join(' ');
    const ascii = Array.from(row, (x) =>
      x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.',
    ).join('');
    lines.push(`${p2((base + i).toString(16), 8)}  ${left.padEnd(47)}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** Forma leggibile di un valore decodificato: i byte diventano esadecimale. */
export function toPlain(v: unknown): unknown {
  if (v instanceof Uint8Array) return hex2(v);
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  }
  return v;
}

/** Forma decodificata di una SZL nota, o `undefined` se non c'è un parser tipizzato. */
export function decodeSzlList(l: SzlList): unknown {
  try {
    switch (l.id) {
      case 0x0011:
        return identityFrom(l);
      case 0x001c:
        return l.records.map((r) => ({
          indice: r.length >= 2 ? u16(r, 0) : -1,
          testo: new TextDecoder('latin1').decode(r.subarray(2)).replace(/[\0 ]+$/, ''),
        }));
      case 0x0131:
        return commFrom(l);
      case 0x0132:
      case 0x0232:
        return protectionFrom(l);
      case 0x0424:
        return { modo: modeFrom(l) };
      case 0x00a0:
        return diagFrom(l).map((e) => ({
          evento: hexN(e.eventId, 4),
          info: hex2(e.info),
          ora: e.time ? isoOf(e.time) : e.rawTime ? hex2(e.rawTime) : '—',
        }));
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Testo di una lista SZL: intestazione, record in esadecimale e forma decodificata. */
export function formatSzl(l: SzlList): string {
  const lines = [
    `SZL ${hexN(l.id, 4)} indice ${hexN(l.index, 4)}: ${l.records.length} record da ${l.recordLength} byte`,
  ];
  l.records.forEach((r, i) => lines.push(`  [${i}] ${hex2(r)}`));
  const d = decodeSzlList(l);
  if (d !== undefined) {
    lines.push('decodifica:');
    for (const row of JSON.stringify(toPlain(d), null, 2).split('\n')) lines.push(`  ${row}`);
  }
  return lines.join('\n');
}

/** Informazioni di blocco, una per riga, con le date come stringhe ISO. */
export function formatBlockInfo(i: BlockInfo): string {
  const rows: [string, string | undefined][] = [
    ['tipo', i.type ?? (i.typeCode !== undefined ? hexN(i.typeCode, 2) : undefined)],
    ['numero', i.number?.toString()],
    ['linguaggio', i.language !== undefined ? blockLanguageName(i.language) : undefined],
    ['flag', i.flags !== undefined ? hexN(i.flags, 2) : undefined],
    ['lunghezza di caricamento', i.loadLength?.toString()],
    ['protezione', i.security?.toString()],
    ['ora del codice', i.codeTime ? isoOf(i.codeTime) : undefined],
    ["ora dell'interfaccia", i.interfaceTime ? isoOf(i.interfaceTime) : undefined],
    ['lunghezza SSB', i.ssbLength?.toString()],
    ['lunghezza ADD', i.addLength?.toString()],
    ['dati locali', i.localDataLength?.toString()],
    ['lunghezza MC7', i.mc7Length?.toString()],
    ['autore', i.author],
    ['famiglia', i.family],
    ['nome', i.name],
    ['versione', i.version],
    ['checksum', i.checksum !== undefined ? hexN(i.checksum, 4) : undefined],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)} : ${v ?? '—'}`).join('\n');
}

/** Etichetta del tipo (categoria di `dissect`) e riga di sintesi di un frame TPKT (senza header). */
export interface SummaryState {
  /** Vero dopo una richiesta SZL nuova: la prossima risposta porta l'intestazione di lista. */
  szlFirst: boolean;
}

export function summarizeFrame(
  dir: 'tx' | 'rx',
  payload: Uint8Array,
  state: SummaryState = { szlFirst: false },
): { kind: string; summary: string } {
  const d = dissect(payload);
  const kind: string = d.kind;
  if (d.kind === 'malformed') return { kind, summary: d.error ?? 'frame malformato' };
  if (d.kind === 'connect') return { kind, summary: `COTP ${d.cotp?.type ?? '?'}` };
  const pdu = d.s7;
  if (!pdu) return { kind, summary: d.cotp ? `COTP ${d.cotp.type}` : '—' };
  const side = dir === 'tx' ? 'richiesta' : 'risposta';
  try {
    switch (d.kind) {
      case 'setup':
        return {
          kind,
          summary: pdu.param.length >= 8 ? `${side} PDU ${u16(pdu.param, 6)}` : side,
        };
      case 'readVar':
        return { kind, summary: `${side} elementi ${pdu.param[1] ?? '?'}` };
      case 'upload': {
        const name = { 0x1d: 'avvio', 0x1e: 'dati', 0x1f: 'fine' }[pdu.param[0] ?? 0] ?? '?';
        return { kind, summary: `${name} ${side}, ${pdu.data.length} byte di dati` };
      }
      case 'szl':
      case 'blockList':
      case 'blockInfo':
      case 'clock':
        return { kind, summary: userdataSummary(d.kind, dir, pdu.param, pdu.data, state) };
      default:
        return {
          kind,
          summary: `ROSCTR ${pdu.rosctr}, ${pdu.param.length}+${pdu.data.length} byte`,
        };
    }
  } catch (e) {
    return {
      kind,
      summary: `${side} (non decodificabile: ${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

function userdataSummary(
  kind: string,
  dir: 'tx' | 'rx',
  param: Uint8Array,
  data: Uint8Array,
  state: SummaryState,
): string {
  const u = decodeUserdata(param, data);
  const req = u.param.method === 'request';
  const err = u.hasData && u.returnCode !== 0xff ? ` errore dati ${hexN(u.returnCode, 2)}` : '';
  if ((u.param.errorCode ?? 0) !== 0) return `errore ${hexN(u.param.errorCode ?? 0, 4)}${err}`;
  const p = u.payload;
  if (kind === 'szl') {
    if (req) {
      state.szlFirst = p.length === 4;
      return p.length === 4
        ? `szl ${hexN(u16(p, 0), 4)}/${hexN(u16(p, 2), 4)} richiesta`
        : 'seguito richiesta';
    }
    if (state.szlFirst && p.length >= 8) {
      state.szlFirst = false;
      // Solo l'intestazione: la lista può continuare nei pezzi successivi.
      return `szl ${hexN(u16(p, 0), 4)}/${hexN(u16(p, 2), 4)} rec ${u16(p, 4)}×${u16(p, 6)}${err}`;
    }
    return `szl seguito, ${p.length} byte${err}`;
  }
  if (kind === 'blockList') {
    if (u.param.subfunction === 1)
      return req ? 'conteggio blocchi richiesta' : `conteggio blocchi${err}`;
    if (req)
      return p.length >= 2
        ? `elenco ${decodeBlockListOfTypeRequest(p)} richiesta`
        : 'elenco richiesta';
    return `elenco blocchi, ${Math.floor(p.length / 4)} voci${err}`;
  }
  if (kind === 'blockInfo') {
    if (req) {
      const r = decodeBlockInfoRequest(p);
      return `info ${r.type}${r.number} richiesta`;
    }
    if (u.hasData && u.returnCode === 0xff) {
      const i = decodeBlockInfo(p);
      return `info ${i.type ?? '?'}${i.number ?? '?'} risposta`;
    }
    return `info blocco risposta${err}`;
  }
  return dir === 'tx' ? 'orologio richiesta' : `orologio risposta${err}`;
}
