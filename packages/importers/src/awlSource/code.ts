// Codice di un blocco: reti (NETWORK / TITLE / commento / istruzioni) e conversione al mnemonico internazionale.
import { convertMnemonics, formatNetwork, parseNetwork, type Mnemonic } from '@baaportal/awl';
import type { Network } from '@baaportal/project';
import { commentText } from './text';
import type { SourceError } from './types';

const NETWORK = /^\s*NETWORK\s*(\/\/.*)?$/i;
const TITLE = /^\s*TITLE\s*=(.*)$/i;

/** Una rete letta dal file, con il codice ancora nel mnemonico del file. */
export interface RawNetwork {
  network: Network;
  code: string;
  /** Riga (0-based) del file in cui comincia `code`. */
  startLine: number;
}

/** Divide le righe [from, to) in reti. */
export function splitNetworks(lines: string[], from: number, to: number): RawNetwork[] {
  interface Cur {
    title: string;
    comment: string[];
    code: string[];
    codeStart: number;
    stage: 'afterNetwork' | 'comment' | 'code';
  }
  const out: RawNetwork[] = [];
  let cur: Cur | undefined;
  const finish = (): void => {
    if (!cur) return;
    let a = 0;
    let b = cur.code.length;
    while (a < b && cur.code[a]!.trim() === '') a++;
    while (b > a && cur.code[b - 1]!.trim() === '') b--;
    out.push({
      network: {
        id: '',
        title: cur.title,
        comment: cur.comment.join('\n'),
        source: '',
      },
      code: cur.code.slice(a, b).join('\n'),
      startLine: cur.codeStart + a,
    });
    cur = undefined;
  };
  for (let idx = from; idx < to; idx++) {
    const line = lines[idx]!;
    if (NETWORK.test(line)) {
      finish();
      cur = { title: '', comment: [], code: [], codeStart: idx + 1, stage: 'afterNetwork' };
      continue;
    }
    if (!cur) {
      if (line.trim() === '') continue;
      cur = { title: '', comment: [], code: [], codeStart: idx, stage: 'code' };
    }
    if (cur.stage === 'afterNetwork') {
      const m = TITLE.exec(line);
      if (m) {
        cur.title = m[1]!.trim();
        cur.stage = 'comment';
        cur.codeStart = idx + 1;
        continue;
      }
      if (line.trim() === '') {
        cur.codeStart = idx + 1;
        continue;
      }
      cur.stage = 'code';
    } else if (cur.stage === 'comment') {
      if (line.startsWith('//')) {
        cur.comment.push(commentText(line));
        cur.codeStart = idx + 1;
        continue;
      }
      cur.stage = 'code';
    }
    cur.code.push(line);
  }
  finish();
  return out;
}

const errorCount = (code: string, m: Mnemonic): number => parseNetwork(code, m).errors.length;

/**
 * Sceglie il mnemonico del file: meno errori di analisi in tutto (istruzioni e operandi, perché il
 * codice tedesco può usare solo istruzioni comuni, `L`, `T`, `=`, con aree tedesche come `EW`), a
 * parità l'internazionale.
 */
export function detectMnemonic(nets: RawNetwork[]): Mnemonic {
  let intl = 0;
  let german = 0;
  for (const n of nets) {
    if (n.code === '') continue;
    intl += errorCount(n.code, 'international');
    german += errorCount(n.code, 'german');
  }
  return german < intl ? 'german' : 'international';
}

/** Controlla ogni rete, la converte in internazionale e la formatta; gli errori hanno righe del file. */
export function finishNetworks(nets: RawNetwork[], mnemonic: Mnemonic): SourceError[] {
  const errors: SourceError[] = [];
  for (const n of nets) {
    if (n.code === '') continue;
    const bad = parseNetwork(n.code, mnemonic).errors;
    for (const e of bad) {
      const err: SourceError = {
        line: n.startLine + e.range.from.line + 1,
        col: e.range.from.col + 1,
        code: e.code,
      };
      if (e.params) err.params = e.params;
      errors.push(err);
    }
    if (bad.length > 0) continue;
    const intl = convertMnemonics(n.code, mnemonic, 'international');
    n.network.source = formatNetwork(intl, 'international');
  }
  return errors;
}
