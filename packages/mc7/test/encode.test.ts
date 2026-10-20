import { describe, expect, it } from 'vitest';
import {
  RAW_PLACEHOLDER,
  decodeCode,
  encodeCode,
  emptyAdd,
  type Mc7Add,
  type Mc7Diagnostic,
} from '../src';
import { fromHex, hex } from './decodeHelpers';

const add = (networks: number[], jumps: number[] = [], rest: number[] = []): Mc7Add => ({
  networks,
  jumps,
  rest: Uint8Array.from(rest),
});
const codes = (d: Mc7Diagnostic[], severity?: 'error' | 'warning'): string[] =>
  d.filter((x) => !severity || x.severity === severity).map((x) => x.code);

describe('encodeCode: casi sintetici', () => {
  it('rete semplice: A M0.0 ; = M0.1 con BE finale; ADD con la lunghezza della rete', () => {
    const r = encodeCode(['\tA %M0.0;\n\t= %M0.1;']);
    expect(r.diagnostics).toEqual([]);
    expect(r.add.networks).toEqual([r.mc7.length - 2]);
    expect(hex(r.mc7.slice(-2))).toBe('65 00');
    const d = decodeCode(r.mc7, r.add);
    expect(d.networks).toEqual(['\tA %M0.0;\n\t= %M0.1;']);
  });

  it('un salto in avanti e uno all’indietro tra segmenti: offset giusti', () => {
    const nets = [
      '\tJU M001;\n\tA %M0.0;\n\tA %M0.0;\nM001:\tNOP 0;',
      'M002:\tA %M0.1;\n\tJU M002;',
    ];
    const r = encodeCode(nets);
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.mc7)).toBe(hex(fromHex('70 0b 00 04 80 00 80 00 00 00 81 00 70 0b ff ff 65 00')));
    expect(r.add.networks).toEqual([10, 6]);
    expect(r.add.jumps).toEqual([0, 6]);
    expect(decodeCode(r.mc7, r.add).networks).toEqual(nets);
  });

  it('JL con due voci', () => {
    const r = encodeCode(['\tJL M001;\n\tJU M001;\n\tJU M001;\nM001:\tA %M0.0;']);
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.mc7)).toBe(hex(fromHex('70 09 00 02 70 0b 00 04 70 0b 00 02 80 00 65 00')));
    expect(r.add.jumps).toEqual([0, 2, 4]);
  });

  it('etichetta mai definita, definita due volte, salto troppo lontano', () => {
    expect(codes(encodeCode(['\tJU M009;']).diagnostics, 'error')).toEqual(['UNKNOWN_LABEL']);
    const dup = encodeCode(['M001:\tA %M0.0;\nM001:\tA %M0.1;\n\tJU M001;']);
    expect(codes(dup.diagnostics, 'error')).toEqual(['DUPLICATE_LABEL']);
    const far = '\tJU M001;\n' + '\tA %M0.0;\n'.repeat(33000) + 'M001:\tNOP 0;';
    const f = encodeCode([far]);
    expect(codes(f.diagnostics, 'error')).toContain('JUMP_TOO_FAR');
    expect(f.mc7.length).toBe(0);
  });

  it('salto tra reti: JU a un’etichetta della rete successiva, nessun errore, il salto arriva alla rete 2', () => {
    const nets = ['\tA %M0.0;\n\tJU M001;', 'M001:\tNOP 0;\n\t= %M0.1;'];
    const r = encodeCode(nets);
    expect(r.diagnostics).toEqual([]);
    // la JU sta al byte 2 e il suo offset è in parole: (6 - 2) / 2 = 2, cioè la NOP 0 della rete 2
    expect(hex(r.mc7)).toBe(hex(fromHex('80 00 70 0b 00 02 00 00 99 00 65 00')));
    const d = decodeCode(r.mc7, r.add);
    // il salto è un'etichetta anche nella decodifica: sta sulla prima istruzione della rete 2
    expect(d.networks[0]).toBe('\tA %M0.0;\n\tJU M001;');
    expect(d.networks[1]).toBe('M001:\tNOP 0;\n\t= %M0.1;');
    expect(d.meta.raws).toEqual([]);
    expect(decodeCode(r.mc7, r.add).networks).toEqual(d.networks);
    expect(encodeCode(d.networks, d.meta).mc7).toEqual(r.mc7);
  });

  it('stessa etichetta in due reti diverse: DUPLICATE_LABEL, nessun byte', () => {
    const r = encodeCode(['M001:\tA %M0.0;', '\tJU M001;\nM001:\tA %M0.1;']);
    expect(codes(r.diagnostics, 'error')).toEqual(['DUPLICATE_LABEL']);
    expect(r.mc7).toHaveLength(0);
    expect(r.add).toEqual(emptyAdd());
  });

  it('errore di sintassi: nessun byte, errore con rete e riga (1-based)', () => {
    const r = encodeCode(['\tA %M0.0;', '\tA %M0.1;\n\tFOO %M0.0;']);
    expect(r.mc7).toHaveLength(0);
    expect(r.add).toEqual(emptyAdd());
    const e = r.diagnostics.filter((d) => d.severity === 'error');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ network: 2, line: 2 });
    // istruzione senza forma MC7: UNSUPPORTED con rete e riga
    const u = encodeCode(['\tA %M0.0;\n\tA "Simbolo";']);
    expect(u.mc7).toHaveLength(0);
    expect(u.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'UNSUPPORTED',
      network: 1,
      line: 2,
    });
  });

  it('CALL: errore senza hook, espansa con il hook', () => {
    const net = '\tCALL FC1;';
    const r = encodeCode([net]);
    expect(codes(r.diagnostics, 'error')).toEqual(['CALL_NEEDS_COMPILER']);
    expect(r.mc7).toHaveLength(0);
    let seen = 0;
    const ok = encodeCode([net], undefined, {
      expandCall: (stmt, n) => {
        seen = n;
        expect(stmt.instruction.def?.id).toBe('CALL');
        return [];
      },
    });
    expect(ok.diagnostics).toEqual([]);
    expect(seen).toBe(1);
    const bad = encodeCode([net], undefined, {
      expandCall: (_s, n) => ({
        error: { severity: 'error', code: 'X', network: n, line: 1, message: 'no' },
      }),
    });
    expect(codes(bad.diagnostics, 'error')).toEqual(['X']);
  });

  it('parametro formale senza mappa: FORMAL_UNKNOWN', () => {
    const r = encodeCode(['\tA #PAR1;']);
    expect(codes(r.diagnostics, 'error')).toEqual(['FORMAL_UNKNOWN']);
    expect(r.mc7).toHaveLength(0);
  });
});

describe('sicurezza di modifica (per rete)', () => {
  // rete 0: A ; grezzo ; A    rete 1: A M0.2 ; = M0.3
  const code = fromHex('80 00 fb ca 00 05 81 00 82 00 b3 00 65 00');
  const a = add([8, 4]);
  const dec = decodeCode(code, a);
  const lines = dec.networks[0]!.split('\n');
  const rawLine = lines.findIndex((l) => l.includes(RAW_PLACEHOLDER));

  it('senza modifiche: byte e ADD identici', () => {
    const r = encodeCode(dec.networks, dec.meta);
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.mc7)).toBe(hex(code));
    expect(r.add.networks).toEqual(a.networks);
  });

  it('modifica di una rete senza grezzi: le altre reti tengono i byte', () => {
    const nets = [dec.networks[0]!, dec.networks[1]!.replace('A %M0.2', 'A %M5.0')];
    const r = encodeCode(nets, dec.meta);
    expect(codes(r.diagnostics, 'error')).toEqual([]);
    expect(hex(r.mc7.slice(0, 8))).toBe(hex(code.slice(0, 8)));
    expect(decodeCode(r.mc7, r.add).networks).toEqual(nets);
  });

  it('una rete modificata che contiene un grezzo: RAW_IN_CHANGED_NETWORK', () => {
    const nets = [dec.networks[0]! + '\n\tA %M9.1;', dec.networks[1]!];
    const r = encodeCode(nets, dec.meta);
    const e = r.diagnostics.filter((d) => d.severity === 'error');
    expect(e.map((d) => d.code)).toEqual(['RAW_IN_CHANGED_NETWORK']);
    expect(e[0]!.network).toBe(1);
    expect(e[0]!.message).toBe(
      'Rete 1 modificata: contiene istruzioni MC7 grezze. Ripristinare la rete o rimuovere le righe grezze.',
    );
    expect(r.mc7).toHaveLength(0);
  });

  it('cancellare il segnaposto: RAW_REMOVED (avviso), i byte della chiamata spariscono', () => {
    const l = lines.filter((_, i) => i !== rawLine && !l_isText(lines[i]!));
    const r = encodeCode([l.join('\n'), dec.networks[1]!], dec.meta);
    expect(codes(r.diagnostics, 'error')).toEqual([]);
    expect(codes(r.diagnostics, 'warning')).toContain('RAW_REMOVED');
    expect(hex(r.mc7)).toBe(hex(fromHex('80 00 81 00 82 00 b3 00 65 00')));
    expect(r.add.networks).toEqual([4, 4]);
  });

  it('duplicare il segnaposto: la rete è modificata, errore bloccante', () => {
    const l = [...lines];
    l.splice(rawLine, 0, lines[rawLine]!);
    const r = encodeCode([l.join('\n'), dec.networks[1]!], dec.meta);
    expect(codes(r.diagnostics, 'error')).toEqual(['RAW_IN_CHANGED_NETWORK']);
    expect(r.mc7).toHaveLength(0);
  });

  it('i byte del segnaposto vengono dalla riga, con spazi attorno; esadecimale non valido', () => {
    // la rete resta "invariata" se è uguale dopo la formattazione
    const spaced = dec.networks.map((n) => n.replace(RAW_PLACEHOLDER, '//   MC7 grezzo:   '));
    const r = encodeCode(spaced, dec.meta);
    expect(r.diagnostics).toEqual([]);
    expect(hex(r.mc7)).toBe(hex(code));
    const bad = encodeCode(
      [dec.networks[0]!.replace('fb ca 00 05', 'zz'), dec.networks[1]!],
      dec.meta,
    );
    expect(bad.mc7).toHaveLength(0);
    expect(codes(bad.diagnostics, 'error').length).toBeGreaterThan(0);
  });

  it('una costante con byte di tipo perso in una rete modificata: avviso e codifica di base', () => {
    const c = fromHex('30 00 12 34 65 00');
    const d = decodeCode(c, add([4]));
    expect(Object.keys(d.meta.constantTypes)).toHaveLength(1);
    const same = encodeCode(d.networks, d.meta);
    expect(hex(same.mc7)).toBe(hex(c));
    const edited = encodeCode([d.networks[0]! + '\n\tA %M0.0;'], d.meta);
    expect(codes(edited.diagnostics, 'error')).toEqual([]);
    expect(codes(edited.diagnostics, 'warning')).toEqual(['CONSTANT_TYPE_LOST']);
    expect(hex(edited.mc7)).toBe(hex(fromHex('30 07 12 34 80 00 65 00')));
  });

  it('ADD: ordine dei salti e resto solo se nessuna rete è cambiata', () => {
    const c = fromHex('70 0b 00 02 70 0b 00 02 80 00 65 00');
    const a2 = add([10], [2, 0], [1, 2, 3]);
    const d = decodeCode(c, a2);
    const same = encodeCode(d.networks, d.meta);
    expect(same.add.jumps).toEqual([2, 0]);
    expect(Array.from(same.add.rest)).toEqual([1, 2, 3]);
    const edited = encodeCode([d.networks[0]! + '\n\tA %M0.1;'], d.meta);
    expect(edited.add.jumps).toEqual([0, 2]);
    expect(edited.add.rest).toHaveLength(0);
    expect(codes(edited.diagnostics, 'warning')).toContain('ADD_REST_DROPPED');
    expect(codes(same.diagnostics)).not.toContain('ADD_REST_DROPPED');
  });
});

function l_isText(line: string): boolean {
  return line.includes('// MC7 testo:');
}

describe('salti grezzi che attraversano reti', () => {
  // rete 0: salto grezzo verso la rete 2, nel mezzo di una sua istruzione (L 0x1234, byte 6..10,
  // destinazione 8) ; rete 1 ; rete 2. Un salto su un inizio di istruzione è un'etichetta.
  const code = fromHex('70 0b 00 04 80 00 30 00 12 34 65 00');
  const a = add([4, 2, 4]);
  const d = decodeCode(code, a);
  it('rete tra salto e destinazione modificata: RAW_JUMP_ACROSS_CHANGED', () => {
    expect(d.meta.raws).toHaveLength(1);
    const nets = [d.networks[0]!, d.networks[1]! + '\n\tA %M5.0;', d.networks[2]!];
    const r = encodeCode(nets, d.meta);
    expect(r.diagnostics.map((x) => x.code)).toEqual(['RAW_JUMP_ACROSS_CHANGED']);
    expect(r.diagnostics[0]!.message).toBe(
      'Rete 1: un salto MC7 grezzo attraversa la rete 2 modificata. Ripristinare la rete 2 o rimuovere il salto grezzo.',
    );
    expect(r.mc7).toHaveLength(0);
    const own = encodeCode(
      [d.networks[0]!, d.networks[1]!, d.networks[2]! + '\n\tA %M5.0;'],
      d.meta,
    );
    expect(codes(own.diagnostics, 'error')).toEqual(['RAW_JUMP_ACROSS_CHANGED']);
  });
  it('rete fuori da ogni salto: va bene', () => {
    // salto della rete 1 verso se stessa non c'è: aggiungo una rete 3 dopo
    const c2 = fromHex('70 0b 00 04 80 00 30 00 12 34 82 00 83 00 65 00');
    const d2 = decodeCode(c2, add([4, 2, 4, 2, 2]));
    const nets = [...d2.networks];
    nets[4] = nets[4]!.replace('%M0.3', '%M7.0');
    const r = encodeCode(nets, d2.meta);
    expect(codes(r.diagnostics, 'error')).toEqual([]);
    expect(decodeCode(r.mc7, r.add).networks).toEqual(nets);
  });
});

describe('reti aggiunte o tolte, allineamento e metadati incoerenti', () => {
  const code = fromHex('70 0b 00 04 80 00 30 00 12 34 65 00');
  const d = decodeCode(code, add([4, 2, 4]));
  const msg =
    'Il numero di reti è cambiato e il blocco contiene salti MC7 grezzi. Ripristinare le reti o rimuovere i salti grezzi.';
  it('togliere o aggiungere una rete con un salto grezzo: errore bloccante', () => {
    const del = encodeCode(d.networks.slice(0, 2), d.meta);
    expect(codes(del.diagnostics, 'error')).toEqual(['RAW_JUMP_ACROSS_CHANGED']);
    expect(del.diagnostics[0]!.message).toBe(msg);
    expect(del.mc7).toHaveLength(0);
    const ins = encodeCode([...d.networks, '\tA %M3.0;'], d.meta);
    expect(codes(ins.diagnostics, 'error')).toEqual(['RAW_JUMP_ACROSS_CHANGED']);
    // senza salti grezzi, cambiare il numero di reti va bene
    const c = fromHex('80 00 81 00 65 00');
    const e = decodeCode(c, add([2, 2]));
    expect(codes(encodeCode(e.networks.slice(0, 1), e.meta).diagnostics, 'error')).toEqual([]);
  });
  it('senza layout originale: tutto il blocco conta', () => {
    const c = fromHex('70 0b 00 04 80 00 30 00 12 34 82 00 83 00 65 00');
    const e = decodeCode(c, add([4, 2, 4, 2, 2]));
    const nets = [...e.networks];
    expect(nets[4]).toContain('%M0.3');
    nets[4] = nets[4]!.replace('%M0.3', '%M7.0');
    expect(codes(encodeCode(nets, e.meta).diagnostics, 'error')).toEqual([]);
    const meta = { ...e.meta };
    delete meta.networkLengths;
    expect(codes(encodeCode(nets, meta).diagnostics, 'error')).toEqual(['RAW_JUMP_ACROSS_CHANGED']);
  });
  const metaFor = (text: string) => ({ raws: [], constantTypes: {}, networkTexts: [text] });
  it('JUMP_ALIGN, JL_TARGET e RAW_META_MISMATCH', () => {
    const odd = '\tJU M001;\n\t// MC7 grezzo: 80\nM001:\tA %M0.0;';
    const a = encodeCode([odd], metaFor(odd));
    expect(codes(a.diagnostics, 'error')).toEqual(['JUMP_ALIGN']);
    const jl = 'M001:\tA %M0.0;\n\tJL M001;';
    expect(codes(encodeCode([jl]).diagnostics, 'error')).toEqual(['JL_TARGET']);
    const raw = '\t// MC7 grezzo: 80 00';
    const m = encodeCode([raw], metaFor(raw));
    expect(codes(m.diagnostics, 'error')).toEqual([]);
    expect(codes(m.diagnostics, 'warning')).toEqual(['RAW_META_MISMATCH']);
    expect(hex(m.mc7)).toBe(hex(fromHex('80 00 65 00')));
  });
});
