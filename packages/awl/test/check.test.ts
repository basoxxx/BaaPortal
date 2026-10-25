import { describe, expect, it } from 'vitest';
import { checkBlockCode, type AwlContext, type AwlDiagnostic } from '../src';
import { emptyIface, el, m, makeCtx } from './ctx';

const ctx = makeCtx();
const check = (nets: string[], c: AwlContext = ctx) => checkBlockCode(nets, c, 'international');
const codes = (d: AwlDiagnostic[]) => d.map((x) => x.code);
/** Il testo coperto da una diagnostica, nella sua rete. */
const at = (nets: string[], d: AwlDiagnostic) =>
  nets[d.network]!.slice(d.range.from.offset, d.range.to.offset);
const summary = (nets: string[], c: AwlContext = ctx) =>
  check(nets, c).map((d) => `${d.code}@${d.network}:${at(nets, d)}`);

describe('etichette', () => {
  it('salti tra segmenti, etichette doppie e mancanti', () => {
    expect(codes(check(['JU M1', 'M1: NOP 0', 'JC M2\nM1: NOP 0']))).toEqual([
      'UNKNOWN_LABEL',
      'DUPLICATE_LABEL',
      'DUPLICATE_LABEL',
    ]);
    const nets = ['JU M1', 'M1: NOP 0', 'JC M2\nM1: NOP 0'];
    expect(summary(nets)).toEqual([
      'UNKNOWN_LABEL@2:M2',
      'DUPLICATE_LABEL@1:M1',
      'DUPLICATE_LABEL@2:M1',
    ]);
  });

  it('confronto senza maiuscole, valide in tutto il blocco, oltre 4 caratteri', () => {
    expect(check(['JU m1', 'NOP 0', 'M1: NOP 0'])).toEqual([]);
    expect(summary(['M1: NOP 0\nm1: NOP 0'])).toEqual([
      'DUPLICATE_LABEL@0:M1',
      'DUPLICATE_LABEL@0:m1',
    ]);
    expect(summary(['JU LUNGA\nLUNGA: NOP 0'])).toEqual([
      'LABEL_TOO_LONG@0:LUNGA',
      'LABEL_TOO_LONG@0:LUNGA',
    ]);
  });
});

describe('parentesi', () => {
  it('non chiusa, inattesa, oltre 7 livelli', () => {
    expect(summary(['A(\nA M0.0'])).toEqual(['BRACKET_UNCLOSED@0:A(']);
    expect(summary(['A M0.0\n)'])).toEqual(['BRACKET_UNEXPECTED@0:)']);
    const open = (n: number) => Array(n).fill('A(').join('\n');
    const close = (n: number) => Array(n).fill(')').join('\n');
    expect(check([`${open(7)}\nA M0.0\n${close(7)}`])).toEqual([]);
    const nets = [`${open(8)}\nA M0.0\n${close(8)}`];
    const d = check(nets);
    expect(codes(d)).toEqual(['BRACKET_DEPTH']);
    expect(d[0]!.range.from.line).toBe(7);
    expect(at(nets, d[0]!)).toBe('A(');
  });

  it('la profondita vale per segmento', () => {
    const seven = `${Array(7).fill('O(').join('\n')}\nA M0.0\n${Array(7).fill(')').join('\n')}`;
    expect(check([seven, seven])).toEqual([]);
    expect(codes(check(['A(\nA M0.0', ')']))).toEqual(['BRACKET_UNCLOSED', 'BRACKET_UNEXPECTED']);
  });

  it('MCR: massimo 8 livelli, )MCR senza apertura', () => {
    expect(
      check([`${Array(8).fill('MCR(').join('\n')}\n${Array(8).fill(')MCR').join('\n')}`]),
    ).toEqual([]);
    const nets = [Array(9).fill('MCR(').join('\n')];
    expect(summary(nets)).toEqual(['MCR_DEPTH@0:MCR(']);
    expect(codes(check([')MCR']))).toEqual(['BRACKET_UNEXPECTED']);
    // MCR( e )MCR possono stare in segmenti diversi
    expect(check(['MCR(', 'A M0.0', ')MCR'])).toEqual([]);
  });
});

describe('classi di operando', () => {
  it('L di un Bool, T di una costante, A di una parola', () => {
    expect(summary(['L "Avvio"'])).toEqual(['TYPE_MISMATCH@0:"Avvio"']);
    expect(summary(['T 5'])).toEqual(['OPERAND_NOT_ALLOWED@0:5']);
    expect(summary(['A "Velocità nastro"'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Velocità nastro"']);
    expect(summary(['A MW 0'])).toEqual(['OPERAND_NOT_ALLOWED@0:MW 0']);
    expect(summary(['L I0.0'])).toEqual(['OPERAND_NOT_ALLOWED@0:I0.0']);
  });

  it('tipi complessi come L/T', () => {
    expect(summary(['L #Cplx\nT #Buffer\nL "Macchina"\nL "Dati".Vet'])).toEqual([
      'TYPE_MISMATCH@0:#Cplx',
      'TYPE_MISMATCH@0:#Buffer',
      'TYPE_MISMATCH@0:"Macchina"',
      'TYPE_MISMATCH@0:"Dati".Vet',
    ]);
    expect(check(['L "Dati".Vet[2]', 'L "Macchina".X'])).toEqual([]);
  });

  it('operandi ammessi', () => {
    const ok = [
      'A I0.0',
      'AN "Avvio"',
      'A #Start',
      'A #Fatto',
      'A T 1',
      'A C 2',
      '= Q4.0',
      '= #Fatto',
      'L MW 0',
      'L "Velocità nastro"',
      'L #Contatore',
      'L #Tmp',
      'L 5',
      'L T#2s',
      'L P#M0.0',
      'L STW',
      'L DBLG',
      'L T 1',
      'L C 1',
      'T MD 4',
      'T "Reale"',
      'T STW',
      'T #Pos',
      'L "Dati".Cnt',
      'A OV',
      'AN ==0',
      'S T 1',
      'R C 1',
      'S Q 0.0',
      'SP T 3',
      'CU C 1',
      'FR T 2',
      'OPN DB 1',
      'OPN "Dati"',
      'OPN "Nastro_DB"',
      'UC FC 1',
      'UC "Calcola"',
      'CC "Calcola"',
      'NOP 0',
      'INC 255',
      'SLW 15',
      'SLD 31',
      'SLW',
      'AW',
      'AW W#16#FFFF',
      'AD DW#16#FFFFFFFF',
      'LAR1',
      'LAR1 P#M2.0',
      'LAR1 AR2',
      'LAR1 MD 4',
      'TAR1 AR2',
      'TAR1 #Contatore',
      '+AR1 P#1.0',
      '+ 5',
      '+ L#100000',
      'L W [AR1, P#2.0]',
      'A [AR1, P#0.0]',
      'T B [AR1, P#0.0]',
      'A M [MD 10]',
      'L MW [MD 10]',
      'A M[AR2, P#0.3]',
      'BE',
      'O',
      'O M0.0',
    ];
    for (const line of ok) expect(summary([line]), line).toEqual([]);
  });

  it('operandi non ammessi o mancanti', () => {
    expect(summary(['A\nL'])).toEqual(['OPERAND_MISSING@0:A', 'OPERAND_MISSING@0:L']);
    expect(summary(['= T 1'])).toEqual(['OPERAND_NOT_ALLOWED@0:T 1']);
    expect(summary(['T DBLG'])).toEqual(['OPERAND_NOT_ALLOWED@0:DBLG']);
    expect(summary(['SP MW 0'])).toEqual(['OPERAND_NOT_ALLOWED@0:MW 0']);
    expect(summary(['OPN "Avvio"'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Avvio"']);
    expect(summary(['UC "Dati"'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Dati"']);
    expect(summary(['T "MAXV"'])).toEqual(['OPERAND_NOT_ALLOWED@0:"MAXV"']);
    expect(summary(['L "Dati"'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Dati"']);
    expect(summary(['AW 1.5'])).toEqual(['OPERAND_NOT_ALLOWED@0:1.5']);
    expect(summary(['TAR1 P#M0.0'])).toEqual(['OPERAND_NOT_ALLOWED@0:P#M0.0']);
    expect(summary(['A L [AR1, P#0.0]\nL B [AR1, P#0.0]\nT W [AR1, P#0.0]'])).toEqual([]);
  });

  it('indiretti: area incrociata senza dimensione e` un bit, con B/W/D un valore', () => {
    expect(summary(['L [AR1, P#0.0]'])).toEqual(['OPERAND_NOT_ALLOWED@0:[AR1, P#0.0]']);
    expect(summary(['A W [AR1, P#0.0]'])).toEqual(['OPERAND_NOT_ALLOWED@0:W [AR1, P#0.0]']);
    // il bersaglio di un accesso in memoria indiretta non e` controllato nel tipo
    expect(check(['A M [#Contatore]', 'L MW [#Start]'])).toEqual([]);
    expect(summary(['A M [#Nope]'])).toEqual(['UNKNOWN_LOCAL@0:Nope']);
  });
});

describe('costanti', () => {
  it('fuori intervallo per l istruzione', () => {
    expect(summary(['INC 300'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:300']);
    expect(summary(['DEC 256'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:256']);
    expect(summary(['SLW 20'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:20']);
    expect(summary(['SLD 32'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:32']);
    expect(summary(['NOP 2'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:2']);
    expect(summary(['+ 40000'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:40000']);
    expect(summary(['AW 70000'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:70000']);
    expect(summary(['AD 5000000000'])).toEqual(['CONSTANT_OUT_OF_RANGE@0:5000000000']);
  });
});

describe('simboli e locali', () => {
  it('simboli con spazi e accenti, maiuscole diverse, membri di DB', () => {
    // L di un Int e T su un Real sono ammessi (AWL non controlla la larghezza tra L e T): resta solo il membro sbagliato
    expect(
      check(['L "VELOCITÀ NASTRO"\nT "Dati".Asse.Pos\nL "Dati".Asse.Manca']).map((d) => d.code),
    ).toEqual(['UNKNOWN_MEMBER']);
    const nets = ['L "VELOCITÀ NASTRO"\nT "Dati".Asse.Pos\nL "Dati".Asse.Manca'];
    const [d] = check(nets);
    expect(at(nets, d!)).toBe('Manca');
    expect(d!.range.from.line).toBe(2);
    expect(d!.range.from.col).toBe(14);
  });

  it('simbolo sconosciuto, membro su tipo elementare, UDT', () => {
    expect(summary(['A "Nulla"'])).toEqual(['UNKNOWN_SYMBOL@0:"Nulla"']);
    expect(summary(['A "Avvio".x'])).toEqual(['UNKNOWN_MEMBER@0:x']);
    expect(summary(['L "Macchina".Y'])).toEqual(['UNKNOWN_MEMBER@0:Y']);
    expect(check(['L "Macchina".x', 'L "Ignoto"', 'L "Ignoto".qualsiasi'])).toEqual([]);
  });

  it('DB di istanza: membri dell FB, Temp non accessibile', () => {
    expect(check(['L "Nastro_DB".Cnt', 'A "Nastro_DB".Ok', 'L "Nastro_DB".Vel'])).toEqual([]);
    expect(summary(['L "Nastro_DB".Loc'])).toEqual(['LOCAL_NOT_ACCESSIBLE@0:Loc']);
    expect(summary(['L "Nastro_DB".Manca'])).toEqual(['UNKNOWN_MEMBER@0:Manca']);
  });

  it('DB simbolico con indirizzo assoluto', () => {
    expect(check(['L "Dati".DBW 4', 'A "Dati".DBX 4.0', 'T "Nastro_DB".DBD 2'])).toEqual([]);
    expect(summary(['L "Avvio".DBW 4'])).toEqual(['UNKNOWN_SYMBOL@0:"Avvio"']);
    expect(summary(['L "Nulla".DBW 4'])).toEqual(['UNKNOWN_SYMBOL@0:"Nulla"']);
    expect(summary(['A "Dati".DBW 4'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Dati".DBW 4']);
    expect(summary(['L "Dati".DBX 4.0'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Dati".DBX 4.0']);
  });

  it('locali di un FB, anche a catena', () => {
    expect(
      check(['A #Start', 'L #Valore', 'A #Fatto', 'L #Contatore', 'L #Tmp', 'L #"a b"']),
    ).toEqual([]);
    expect(check(['L #Sub.Vel', 'A #Sub.Ok', 'L #Buffer.a', 'L #Cplx.z'])).toEqual([]);
    expect(summary(['L #Nope\nL #Sub.Nope'])).toEqual([
      'UNKNOWN_LOCAL@0:Nope',
      'UNKNOWN_MEMBER@0:Nope',
    ]);
    expect(summary(['L #Start.x'])).toEqual(['UNKNOWN_MEMBER@0:x']);
  });

  it('FC: niente Static, RET_VAL raggiungibile se non Void', () => {
    const fc = makeCtx(
      'FC',
      emptyIface({
        input: [m('In1', el('Int'))],
        static: [m('Vecchio', el('Int'))],
        temp: [m('Tmp', el('Int'))],
        returnType: el('Int'),
      }),
    );
    expect(check(['L #In1', 'L #Tmp', 'T #RET_VAL'], fc)).toEqual([]);
    expect(summary(['L #Vecchio'], fc)).toEqual(['UNKNOWN_LOCAL@0:Vecchio']);
    const fcVoid = makeCtx('FC', emptyIface({ returnType: { kind: 'void' } }));
    expect(summary(['T #RET_VAL'], fcVoid)).toEqual(['UNKNOWN_LOCAL@0:RET_VAL']);
  });

  it('OB: solo Temp', () => {
    const ob = makeCtx(
      'OB',
      emptyIface({ temp: [m('T0', el('Int'))], input: [m('X', el('Int'))] }),
    );
    expect(check(['L #T0'], ob)).toEqual([]);
    expect(summary(['L #X'], ob)).toEqual(['UNKNOWN_LOCAL@0:X']);
  });
});

describe('limiti', () => {
  it('T, C e aree oltre i limiti della CPU', () => {
    const lim = makeCtx('FB', undefined, {
      timers: 128,
      counters: 64,
      mBytes: 256,
      inputBytes: 128,
      outputBytes: 128,
    });
    expect(check(['A T 127', 'A C 63', 'L MW 254', 'A M255.7', 'A I127.0'], lim)).toEqual([]);
    expect(
      summary(['A T 128\nSP T 200\nCU C 64\nL MW 255\nT MD 253\nA I128.0\nA Q200.1'], lim),
    ).toEqual([
      'ADDRESS_OUT_OF_RANGE@0:T 128',
      'ADDRESS_OUT_OF_RANGE@0:T 200',
      'ADDRESS_OUT_OF_RANGE@0:C 64',
      'ADDRESS_OUT_OF_RANGE@0:MW 255',
      'ADDRESS_OUT_OF_RANGE@0:MD 253',
      'ADDRESS_OUT_OF_RANGE@0:I128.0',
      'ADDRESS_OUT_OF_RANGE@0:Q200.1',
    ]);
    expect(check(['A T 9999'])).toEqual([]);
  });
});

describe('CALL', () => {
  it('FC: tutto corretto, parametro mancante, sconosciuto, tipo e direzione sbagliati', () => {
    expect(check(['CALL "Calcola"\n(A := #Valore, R := #Valore)'])).toEqual([]);
    expect(check(['CALL FC 1 (A := 5, R := MW 0)'])).toEqual([]);
    let nets = ['CALL "Calcola"\n(A := 5)'];
    expect(summary(nets)).toEqual(['CALL_PARAM_MISSING@0:CALL']);
    expect(check(nets)[0]!.params).toEqual({ name: 'R' });
    nets = ['CALL "Calcola" (A := 5, R := MW 0, Z := 1)'];
    expect(summary(nets)).toEqual(['CALL_PARAM_UNKNOWN@0:Z']);
    nets = ['CALL "Calcola" (A := "Reale", R := MW 0)'];
    expect(summary(nets)).toEqual(['CALL_PARAM_TYPE@0:"Reale"']);
    nets = ['CALL "Calcola" (A => 5, R := MW 0)'];
    expect(summary(nets)).toEqual(['CALL_PARAM_DIRECTION@0:A']);
    nets = ['CALL "Calcola" (A := 1.5, R := MW 0)'];
    expect(summary(nets)).toEqual(['CALL_PARAM_TYPE@0:1.5']);
  });

  it('FC con RET_VAL non Void: obbligatorio', () => {
    expect(summary(['CALL "ConRet" (X := 1.5)'])).toEqual(['CALL_PARAM_MISSING@0:CALL']);
    expect(check(['CALL "ConRet" (X := 1.5, RET_VAL := MW 4)'])).toEqual([]);
  });

  it('bersaglio inesistente o non chiamabile', () => {
    expect(summary(['CALL "Nulla"'])).toEqual(['UNKNOWN_BLOCK@0:"Nulla"']);
    expect(summary(['CALL FC 99'])).toEqual(['UNKNOWN_BLOCK@0:FC 99']);
    expect(summary(['CALL "Dati"'])).toEqual(['OPERAND_NOT_ALLOWED@0:"Dati"']);
  });

  it('FB: istanza mancante, sbagliata, corretta, multi-istanza; parametri facoltativi', () => {
    expect(summary(['CALL "Nastro"'])).toEqual(['CALL_INSTANCE_MISSING@0:"Nastro"']);
    expect(summary(['CALL "Nastro", "Motore_DB"'])).toEqual(['CALL_INSTANCE_WRONG@0:"Motore_DB"']);
    expect(summary(['CALL "Nastro", "Dati"'])).toEqual(['CALL_INSTANCE_WRONG@0:"Dati"']);
    expect(summary(['CALL "Nastro", "Nulla"'])).toEqual(['UNKNOWN_SYMBOL@0:"Nulla"']);
    expect(check(['CALL "Nastro", "Nastro_DB"', 'CALL FB 2, DB 3 (Vel := 5)'])).toEqual([]);
    expect(check(['CALL "Nastro", "Nastro_DB" (Vel := #Valore, Ok => #Fatto)'])).toEqual([]);
    expect(check(['CALL #Sub (Vel := 3)'])).toEqual([]);
    expect(summary(['CALL #Sub, "Nastro_DB"'])).toEqual(['CALL_INSTANCE_WRONG@0:"Nastro_DB"']);
    expect(summary(['CALL "Nastro", "Nastro_DB" (Cnt := 1)'])).toEqual([
      'CALL_PARAM_UNKNOWN@0:Cnt',
    ]);
    expect(summary(['CALL "Nastro", "Nastro_DB" (Vel := 1, Vel => #Valore)'])).toEqual([
      'CALL_PARAM_DIRECTION@0:Vel',
    ]);
  });

  it('FC con istanza: sbagliata', () => {
    expect(summary(['CALL "Calcola", "Nastro_DB" (A := 1, R := MW 0)'])).toEqual([
      'CALL_INSTANCE_WRONG@0:"Nastro_DB"',
    ]);
  });

  it('TRUE/FALSE: valide per un parametro Bool, CALL_PARAM_TYPE per un Int', () => {
    const base =
      'T1 := T 1, P := P#M0.0, Q := MW 0, Blk := FC 1, Tx := \'abc\', Tp := "Macchina", W := MW 2';
    expect(check([`CALL "Prese" (${base}, B := TRUE)`])).toEqual([]);
    expect(check([`CALL "Prese" (${base}, B := false)`])).toEqual([]);
    expect(summary(['CALL "Calcola" (A := TRUE, R := MW 0)'])).toEqual(['CALL_PARAM_TYPE@0:TRUE']);
  });

  it('tipi dei parametri: Timer, Pointer, Any, Block, complessi, costanti', () => {
    const ok = (v: string) => check([`CALL "Prese" (${v})`]);
    const all = (over: Record<string, string> = {}) => {
      const base: Record<string, string> = {
        T1: 'T 1',
        P: 'P#M0.0',
        Q: 'MW 0',
        Blk: 'FC 1',
        Tx: "'abc'",
        Tp: '"Macchina"',
        B: 'M0.0',
        W: 'MW 2',
      };
      return Object.entries({ ...base, ...over })
        .map(([k, v]) => `${k} := ${v}`)
        .join(', ');
    };
    expect(ok(all())).toEqual([]);
    expect(
      ok(all({ T1: '"Temporizzatore"', Blk: '"Calcola"', Q: 'P#DB1.DBX 0.0', P: 'MD 0' })),
    ).toEqual([]);
    expect(
      ok(all({ Q: '"Dati".Asse', B: 'M0.1', W: 'W#16#FF', Tx: '#Fatto' })).map((d) => d.code),
    ).toEqual(['CALL_PARAM_TYPE']);
    for (const bad of <Record<string, string>[]>[
      { T1: 'C 1' },
      { T1: 'MW 0' },
      { Blk: 'FB 2' },
      { Blk: '"Nastro"' },
      { Tp: '"Reale"' },
      { Tx: '5' },
      { B: 'MW 0' },
      { W: 'M0.0' },
      { P: '5' },
      { W: '"Avvio"' },
      { W: '300000' },
    ]) {
      expect(codes(ok(all(bad))), JSON.stringify(bad)).toEqual(['CALL_PARAM_TYPE']);
    }
  });

  it('SFC dal contesto: CALL "READ_CLK" valido con tutti i parametri', () => {
    expect(check(['CALL "READ_CLK" (RET_VAL := MW 10, CDT := "Dati".Asse)'])).toEqual([
      expect.objectContaining({ code: 'CALL_PARAM_TYPE' }),
    ]);
    expect(check(['CALL "READ_CLK" (RET_VAL := MW 10, CDT := #Cplx)'])).toEqual([
      expect.objectContaining({ code: 'CALL_PARAM_TYPE' }),
    ]);
    expect(check(['CALL SFC 1 (RET_VAL := #Valore, CDT := "Dati".Vet)'])).toEqual([
      expect.objectContaining({ code: 'CALL_PARAM_TYPE' }),
    ]);
    // un locale di tipo Date_And_Time sarebbe valido
    const dt = makeCtx('FB', emptyIface({ temp: [m('Ora', { kind: 'dateAndTime' })] }));
    expect(check(['CALL "READ_CLK" (RET_VAL := MW 10, CDT := #Ora)'], dt)).toEqual([]);
    expect(summary(['CALL "READ_CLK"\n(CDT := #Ora)'], dt)).toEqual(['CALL_PARAM_MISSING@0:CALL']);
  });

  it('simboli dentro i parametri vengono controllati', () => {
    expect(summary(['CALL "Calcola" (A := "Nulla", R := #Nope)'])).toEqual([
      'UNKNOWN_SYMBOL@0:"Nulla"',
      'UNKNOWN_LOCAL@0:Nope',
    ]);
  });
});

describe('errori del parser e posizioni', () => {
  it('gli errori del parser diventano diagnostica con lo stesso codice', () => {
    const nets = ['A M0.0', 'XYZ M1.0\nA I0.9\nA "x\nL', 'CALL "Calcola" (A := 1'];
    const d = check(nets);
    expect(d.map((x) => [x.code, x.network, x.severity])).toEqual([
      ['UNKNOWN_INSTRUCTION', 1, 'error'],
      ['BAD_OPERAND', 1, 'error'],
      ['UNCLOSED_STRING', 1, 'error'],
      ['OPERAND_MISSING', 1, 'error'],
      ['UNCLOSED_PARAMS', 2, 'error'],
      ['CALL_PARAM_MISSING', 2, 'error'],
    ]);
  });

  it('range relativi alla rete, corretti con CRLF', () => {
    const nets = ['A M0.0', 'A M0.0\r\nL "Nulla"\r\nT "Zero"'];
    const d = check(nets);
    expect(d.map((x) => [x.network, x.range.from.line, x.range.from.col])).toEqual([
      [1, 1, 2],
      [1, 2, 2],
    ]);
    expect(d.map((x) => at(nets, x))).toEqual(['"Nulla"', '"Zero"']);
    expect(d.every((x) => x.severity === 'error')).toBe(true);
  });
});

describe('prestazioni', () => {
  it('controllo di un blocco di 100 segmenti x 20 righe', { timeout: 30_000 }, () => {
    const lines = [
      'A "Avvio"',
      'L "Velocità nastro"',
      'T "Dati".Asse.Pos',
      'A #Start',
      '= #Fatto',
      'L #Valore',
      'CALL "Calcola" (A := #Valore, R := #Valore)',
      'JU M1',
      'A I0.0',
      'AN Q0.0',
      'L MW 0',
      'T MW 2',
      'SP T 1',
      'A T 1',
      '= M0.1',
      'L 5',
      'T "Nastro_DB".Cnt',
      'A(',
      'O M0.0',
      ')',
    ];
    const net = lines.join('\n');
    const nets = Array.from({ length: 100 }, (_, i) => (i === 0 ? `M1: NOP 0\n${net}` : net));
    check(nets); // riscaldamento
    const t0 = performance.now();
    const d = check(nets);
    const ms = performance.now() - t0;
    expect(d).toEqual([]);
    // obiettivo 100 ms; soglia larga perche' le CI Windows sono lente
    expect(ms).toBeLessThan(2000);
  });
});

describe('puntatore a un locale: P##nome', () => {
  it('il nome si cerca nell interfaccia del blocco; vale dove vale un puntatore', () => {
    expect(summary(['L P##Tmp\nLAR1 P##"Tmp"\nL P##Sub.Vel\nLAR2 P##Pos'])).toEqual([]);
    expect(summary(['L P##Nessuno\nL P##Sub.Zzz'])).toEqual([
      'UNKNOWN_LOCAL@0:Nessuno',
      'UNKNOWN_MEMBER@0:Zzz',
    ]);
    // Dove un puntatore non vale non vale nemmeno P##.
    expect(summary(['A P##Tmp'])).toEqual(['OPERAND_NOT_ALLOWED@0:P##Tmp']);
  });

  it('come parametro Pointer di un CALL', () => {
    const call = (p: string) =>
      `CALL "Prese"\n(T1 := T 1, P := ${p}, Q := MW 0, Blk := FC 1, Tx := 'a', Tp := "Macchina", B := TRUE, W := MW 2)`;
    expect(summary([call('P##Tmp')])).toEqual([]);
    expect(summary([call('P##Boh')])).toEqual(['UNKNOWN_LOCAL@0:Boh']);
  });

  it('etichette che iniziano con _: valide fino a 4 caratteri, oltre sono troppo lunghe', () => {
    expect(check(['A I 0.0\nJNB _001\nL MW 10\nT MW 12\n_001: NOP 0'])).toEqual([]);
    expect(summary(['_ABCD: NOP 0'])).toEqual(['LABEL_TOO_LONG@0:_ABCD']);
    expect(summary(['JU _ABCD\n_ABCD: NOP 0'])).toEqual([
      'LABEL_TOO_LONG@0:_ABCD',
      'LABEL_TOO_LONG@0:_ABCD',
    ]);
    expect(codes(check(['1AB: NOP 0']))).not.toEqual([]);
  });
});
