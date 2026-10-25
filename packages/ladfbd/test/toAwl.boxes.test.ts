// Traduzione KOP → AWL dei box: ogni test cita il paragrafo di docs/linguaggi/kop-awl.md da cui
// viene l'AWL atteso, o la regola del piano 4A per le ipotesi aperte (H12, H17, H18).
import { describe, expect, it } from 'vitest';
import { formatNetwork, parseNetwork } from '@baaportal/awl';
import { networkToAwl } from '../src/index.js';
import type {
  BoxKind,
  LadBox,
  LadElem,
  LadNetwork,
  LadNode,
  LadOut,
  NetworkAwlOpts,
} from '../src/index.js';

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;
const c = (op: string): LadElem => ({ id: nid('c'), k: 'contact', neg: false, op });
const coil = (op: string): LadOut => ({ id: nid('o'), k: 'coil', op });
const box = (
  kind: BoxKind,
  pins: Record<string, string> = {},
  instance = '',
  boolPins: Record<string, LadElem[]> = {},
): LadBox => ({ id: nid('b'), k: 'box', box: kind, instance, pins, boolPins });
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: nid('N'),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNetwork => ({
  root: node(series, outs),
});
const add = () => box('ADD_I', { IN1: 'MW 10', IN2: 'MW 12', OUT: 'MW 14' });
const move = (from = 'MW 10', to = 'MW 12') => box('MOVE', { IN: from, OUT: to });

const fmt = (...lines: string[]) => formatNetwork(lines.join('\n'), 'international');

/** Traduce e controlla gli invarianti comuni: niente diagnostiche, AWL valido e canonico, righe. */
function awl(n: LadNetwork, opts: Partial<NetworkAwlOpts> = {}): string {
  const r = networkToAwl(n, { tempEnd: 20, firstLabel: 1, ...opts });
  expect(r.diagnostics).toEqual([]);
  expect(parseNetwork(r.source, 'international').errors).toEqual([]);
  expect(formatNetwork(r.source, 'international')).toBe(r.source);
  expect(r.lines.map((l) => l.line)).toEqual(r.source.split('\n').map((_, i) => i));
  return r.source;
}

describe('flip-flop e fronti (§2.12, §2.13)', () => {
  it('§2.12 SR con Q collegato', () => {
    const sr = box('SR', {}, 'M 0.0', { R: [c('I 0.1')] });
    expect(awl(net([c('I 0.0'), sr], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'S M 0.0', 'A I 0.1', 'R M 0.0', 'A M 0.0', '= Q 4.0'),
    );
  });

  it('§2.12 RS: prima il reset, poi il set; Q libero non genera niente', () => {
    const rs = box('RS', {}, 'M 0.0', { S: [c('I 0.1')] });
    expect(awl(net([c('I 0.0'), rs], []))).toBe(fmt('A I 0.0', 'R M 0.0', 'A I 0.1', 'S M 0.0'));
  });

  it('§2.12 SR senza logica sul pin R e con S sulla barra: SET e solo la parte di S', () => {
    expect(awl(net([box('SR', {}, 'M 0.0')], [coil('Q 4.0')]))).toBe(
      fmt('SET', 'S M 0.0', 'A M 0.0', '= Q 4.0'),
    );
  });

  it('§2.12 pin R con un parallelo: la logica del pin parte da capo', () => {
    const r: LadElem = { id: nid('p'), k: 'parallel', branches: [[c('I 0.1')], [c('I 0.2')]] };
    const sr = box('SR', {}, 'M 0.0', { R: [r, c('I 0.3')] });
    expect(awl(net([c('I 0.0'), sr], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'S M 0.0',
        'A(',
        'O I 0.1',
        'O I 0.2',
        ')',
        'A I 0.3',
        'R M 0.0',
        'A M 0.0',
        '= Q 4.0',
      ),
    );
  });

  it('§2.13 box POS con logica davanti (H8)', () => {
    const pos: LadElem = { id: nid('f'), k: 'posneg', dir: 'P', bit: 'I 0.3', mem: 'M 0.0' };
    expect(awl(net([c('I 0.0'), pos, c('I 0.4')], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'A(', 'A I 0.3', 'FP M 0.0', ')', 'A I 0.4', '= Q 4.0'),
    );
  });
});

describe('temporizzatori e contatori a box (§3.2, §3.4)', () => {
  const odt = (pins: Record<string, string>, r?: LadElem[]) =>
    box('S_ODT', { TV: 'S5T#5S', ...pins }, 'T 1', r ? { R: r } : {});

  it('§3.2 S_ODT con tutti i pin', () => {
    const t = odt({ BI: 'MW 10', BCD: 'MW 12' }, [c('I 0.1')]);
    expect(awl(net([c('I 0.0'), t], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'L S5T#5S',
        'SD T 1',
        'A I 0.1',
        'R T 1',
        'L T 1',
        'T MW 10',
        'LC T 1',
        'T MW 12',
        'A T 1',
        '= Q 4.0',
      ),
    );
  });

  it('§3.2 pin non collegati: niente R, niente BCD, niente Q', () => {
    expect(awl(net([c('I 0.0'), odt({ BI: 'MW 10', BCD: '' })], []))).toBe(
      fmt('A I 0.0', 'L S5T#5S', 'SD T 1', 'L T 1', 'T MW 10'),
    );
  });

  it('§3.2 istruzione di ogni temporizzatore', () => {
    const map = { S_PULSE: 'SP', S_PEXT: 'SE', S_ODT: 'SD', S_ODTS: 'SS', S_OFFDT: 'SF' } as const;
    for (const [kind, ins] of Object.entries(map))
      expect(awl(net([c('I 0.0'), box(kind as BoxKind, { TV: 'S5T#1S' }, 'T 2')], []))).toBe(
        fmt('A I 0.0', 'L S5T#1S', `${ins} T 2`),
      );
  });

  it('§3.4 S_CUD con tutti i pin', () => {
    const z = box('S_CUD', { PV: 'C#5', CV: 'MW 10', CV_BCD: 'MW 12' }, 'C 10', {
      CD: [c('I 0.1')],
      S: [c('I 0.2')],
      R: [c('I 0.3')],
    });
    expect(awl(net([c('I 0.0'), z], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'CU C 10',
        'A I 0.1',
        'CD C 10',
        'A I 0.2',
        'L C#5',
        'S C 10',
        'A I 0.3',
        'R C 10',
        'L C 10',
        'T MW 10',
        'LC C 10',
        'T MW 12',
        'A C 10',
        '= Q 4.0',
      ),
    );
  });

  it('§3.4 S_CD: il primo pin è CD; S_CU senza S né uscite', () => {
    const cd = box('S_CD', { PV: 'C#3' }, 'C 1', { S: [c('I 0.1')] });
    expect(awl(net([c('I 0.0'), cd], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'CD C 1', 'A I 0.1', 'L C#3', 'S C 1', 'A C 1', '= Q 4.0'),
    );
    expect(awl(net([c('I 0.0'), box('S_CU', {}, 'C 2')], []))).toBe(fmt('A I 0.0', 'CU C 2'));
  });
});

describe('box con EN/ENO (§4.1–§4.9)', () => {
  it('§4.1 caso 1: logica davanti, ENO collegato', () => {
    expect(awl(net([c('I 0.0'), add()], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'JNB _001',
        'L MW 10',
        'L MW 12',
        '+I',
        'T MW 14',
        'AN OV',
        'SAVE',
        'CLR',
        '_001: A BR',
        '= Q 4.0',
      ),
    );
  });

  it('§4.1 caso 2: logica davanti, ENO libero', () => {
    expect(awl(net([c('I 0.0'), add()], []))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 10', 'L MW 12', '+I', 'T MW 14', '_001: NOP 0'),
    );
  });

  it('§4.1 caso 3: EN sulla barra, ENO collegato (nessuna etichetta)', () => {
    const r = networkToAwl(net([add()], [coil('Q 4.0')]), { tempEnd: 20, firstLabel: 4 });
    expect(r.nextLabel).toBe(4);
    expect(r.source).toBe(
      fmt('L MW 10', 'L MW 12', '+I', 'T MW 14', 'AN OV', 'SAVE', 'CLR', 'A BR', '= Q 4.0'),
    );
  });

  it('§4.1 caso 4: EN sulla barra, ENO libero', () => {
    expect(awl(net([add()], []))).toBe(fmt('L MW 10', 'L MW 12', '+I', 'T MW 14', 'NOP 0'));
  });

  it('§4.3 box senza errore con ENO collegato: _001: A BR subito dopo il corpo (H12)', () => {
    expect(awl(net([c('I 0.0'), move()], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 10', 'T MW 12', '_001: A BR', '= Q 4.0'),
    );
  });

  it('§4.3 box senza errore, EN sulla barra ed ENO collegato: SET; SAVE; CLR; A BR', () => {
    expect(awl(net([move()], [coil('Q 4.0')]))).toBe(
      fmt('L MW 10', 'T MW 12', 'SET', 'SAVE', 'CLR', 'A BR', '= Q 4.0'),
    );
  });

  it('§4.4 MOVE con ENO libero', () => {
    expect(awl(net([c('I 0.0'), move()], []))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 10', 'T MW 12', '_001: NOP 0'),
    );
  });

  it('§4.5 MUL_R e SQRT: controllo AN OV (H13)', () => {
    const mul = box('MUL_R', { IN1: 'MD 0', IN2: 'MD 4', OUT: 'MD 8' });
    expect(awl(net([c('I 0.0'), mul], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'JNB _001',
        'L MD 0',
        'L MD 4',
        '*R',
        'T MD 8',
        'AN OV',
        'SAVE',
        'CLR',
        '_001: A BR',
        '= Q 4.0',
      ),
    );
    const sqrt = box('SQRT', { IN: 'MD 0', OUT: 'MD 8' });
    expect(awl(net([c('I 0.0'), sqrt], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'JNB _001',
        'L MD 0',
        'SQRT',
        'T MD 8',
        'AN OV',
        'SAVE',
        'CLR',
        '_001: A BR',
        '= Q 4.0',
      ),
    );
  });

  it('§4.6 BCD_I non sbaglia (H12), ROUND sì', () => {
    const bcd = box('BCD_I', { IN: 'MW 0', OUT: 'MW 2' });
    expect(awl(net([c('I 0.0'), bcd], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 0', 'BTI', 'T MW 2', '_001: A BR', '= Q 4.0'),
    );
    const rnd = box('ROUND', { IN: 'MD 0', OUT: 'MD 4' });
    expect(awl(net([c('I 0.0'), rnd], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'JNB _001',
        'L MD 0',
        'RND',
        'T MD 4',
        'AN OV',
        'SAVE',
        'CLR',
        '_001: A BR',
        '= Q 4.0',
      ),
    );
  });

  it('§4.7 logica a parola', () => {
    const w = box('WAND_W', { IN1: 'MW 0', IN2: 'W#16#FF', OUT: 'MW 2' });
    expect(awl(net([c('I 0.0'), w], []))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 0', 'L W#16#FF', 'AW', 'T MW 2', '_001: NOP 0'),
    );
  });

  it('§4.8 scorrimento: N in ACCU2, IN in ACCU1 (H14)', () => {
    const s = box('SHL_W', { IN: 'MW 10', N: 'MW 20', OUT: 'MW 12' });
    expect(awl(net([c('I 0.0'), s], []))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 20', 'L MW 10', 'SLW', 'T MW 12', '_001: NOP 0'),
    );
  });

  it('§4.9 cascata ADD_I → MOVE', () => {
    expect(awl(net([c('I 0.0'), add(), move('MW 14', 'MW 16')], []))).toBe(
      fmt(
        'A I 0.0',
        'JNB _001',
        'L MW 10',
        'L MW 12',
        '+I',
        'T MW 14',
        'AN OV',
        'SAVE',
        'CLR',
        '_001: A BR',
        'JNB _002',
        'L MW 14',
        'T MW 16',
        '_002: NOP 0',
      ),
    );
  });

  it('box seguito da altra logica e da una bobina: ENO collegato', () => {
    expect(awl(net([c('I 0.0'), move(), c('I 0.1')], [coil('Q 4.0')]))).toBe(
      fmt('A I 0.0', 'JNB _001', 'L MW 10', 'T MW 12', '_001: A BR', 'A I 0.1', '= Q 4.0'),
    );
  });

  it('§4.10 box in un ramo a T: il nodo si salva in un bit L', () => {
    expect(awl(net([c('I 0.0')], [node([move()], []), coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        '= L 20.0',
        'A L 20.0',
        '= Q 4.0',
        'A L 20.0',
        'JNB _001',
        'L MW 10',
        'T MW 12',
        '_001: NOP 0',
      ),
    );
  });

  it('due box sulla barra in due rami a T: ognuno con EN sulla barra', () => {
    expect(awl(net([], [node([move()], []), node([add()], [coil('Q 4.0')])]))).toBe(
      fmt(
        'L MW 10',
        'T MW 12',
        'NOP 0',
        'L MW 10',
        'L MW 12',
        '+I',
        'T MW 14',
        'AN OV',
        'SAVE',
        'CLR',
        'A BR',
        '= Q 4.0',
      ),
    );
  });

  it('le righe del box appartengono al box', () => {
    const b = move();
    const r = networkToAwl(net([c('I 0.0'), b], []), { tempEnd: 20, firstLabel: 1 });
    expect(r.lines.slice(1).every((l) => l.elemId === b.id)).toBe(true);
  });
});

describe('chiamate di blocco (§4.11)', () => {
  const fc = (pins: Record<string, string>, boolPins: Record<string, LadElem[]> = {}) =>
    box('CALL', pins, 'FC 1', boolPins);

  it('FC con ENO collegato: niente fra la CALL e _001 (H17)', () => {
    expect(awl(net([c('I 0.0'), fc({ IN1: 'MW 10', OUT1: 'MW 12' })], [coil('Q 4.0')]))).toBe(
      fmt(
        'A I 0.0',
        'JNB _001',
        'CALL FC 1',
        '(',
        'IN1 := MW 10,',
        'OUT1 := MW 12',
        ');',
        '_001: A BR',
        '= Q 4.0',
      ),
    );
  });

  it('FB con DB, ENO libero; i pin vuoti si omettono', () => {
    const b = box('CALL', { Avvio: 'I 0.1', Valore: '' }, 'FB 1, DB 1');
    expect(awl(net([c('I 0.0'), b], []))).toBe(
      fmt('A I 0.0', 'JNB _001', 'CALL FB 1, DB 1', '(', 'Avvio := I 0.1', ');', '_001: NOP 0'),
    );
  });

  it('senza parametri, sulla barra con ENO collegato: CALL; A BR', () => {
    expect(awl(net([box('CALL', {}, 'FC 3')], [coil('Q 4.0')]))).toBe(
      fmt('CALL FC 3', 'A BR', '= Q 4.0'),
    );
    expect(awl(net([box('CALL', {}, '#Motore')], []))).toBe(fmt('CALL #Motore', 'NOP 0'));
  });

  it('pin BOOL con logica: = L b prima della logica di EN e pin := L b (H18, senza BLD)', () => {
    const b = fc({ OUT1: 'MW 12' }, { START: [c('I 0.1')], STOP: [] });
    expect(awl(net([c('I 0.0'), b], []))).toBe(
      fmt(
        'A I 0.1',
        '= L 20.0',
        'A I 0.0',
        'JNB _001',
        'CALL FC 1',
        '(',
        'OUT1 := MW 12,',
        'START := L 20.0',
        ');',
        '_001: NOP 0',
      ),
    );
  });

  it('ordine dei parametri dall’interfaccia del blocco chiamato', () => {
    const b = fc({ OUT1: 'MW 12', IN1: 'MW 10' }, { START: [c('I 0.1')] });
    const callParams = (inst: string) => (inst === 'FC 1' ? ['START', 'IN1', 'OUT1'] : undefined);
    expect(awl(net([c('I 0.0'), b], []), { callParams })).toBe(
      fmt(
        'A I 0.1',
        '= L 20.0',
        'A I 0.0',
        'JNB _001',
        'CALL FC 1',
        '(',
        'START := L 20.0,',
        'IN1 := MW 10,',
        'OUT1 := MW 12',
        ');',
        '_001: NOP 0',
      ),
    );
  });

  it('pin BOOL con logica in un ramo a T: prima di A L b; in un ramo unico: prima della serie', () => {
    const b1 = fc({}, { START: [c('I 0.1')] });
    expect(awl(net([c('I 0.0')], [coil('Q 4.0'), node([b1], [])]))).toBe(
      fmt(
        'A I 0.0',
        '= L 20.0',
        'A L 20.0',
        '= Q 4.0',
        'A I 0.1',
        '= L 20.1',
        'A L 20.0',
        'JNB _001',
        'CALL FC 1',
        '(',
        'START := L 20.1',
        ');',
        '_001: NOP 0',
      ),
    );
    const b2 = fc({}, { START: [c('I 0.1')] });
    expect(awl(net([c('I 0.0')], [node([b2], [coil('Q 4.0')])]))).toBe(
      fmt(
        'A I 0.1',
        '= L 20.0',
        'A I 0.0',
        'JNB _001',
        'CALL FC 1',
        '(',
        'START := L 20.0',
        ');',
        '_001: A BR',
        '= Q 4.0',
      ),
    );
  });
});

describe('etichette automatiche (§4.2, H11)', () => {
  it('partono da firstLabel e nextLabel dice la prossima', () => {
    const r = networkToAwl(net([c('I 0.0'), add(), move('MW 14', 'MW 16')], []), {
      tempEnd: 20,
      firstLabel: 7,
    });
    expect(r.source).toContain('JNB _007');
    expect(r.source).toContain('JNB _008');
    expect(r.nextLabel).toBe(9);
  });

  it('_999 è l’ultima; oltre: TOO_MANY_LABELS sul box e nessun AWL', () => {
    const ok = networkToAwl(net([c('I 0.0'), move()], []), { tempEnd: 20, firstLabel: 999 });
    expect(ok.source).toContain('_999');
    expect(ok.nextLabel).toBe(1000);
    const second = move('MW 14', 'MW 16');
    const r = networkToAwl(net([c('I 0.0'), add(), second], []), { tempEnd: 20, firstLabel: 999 });
    expect(r).toEqual({
      source: '',
      lines: [],
      diagnostics: [{ elemId: second.id, code: 'TOO_MANY_LABELS' }],
      nextLabel: 999,
    });
  });
});
