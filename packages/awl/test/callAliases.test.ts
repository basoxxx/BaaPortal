import { describe, expect, it } from 'vitest';
import { checkBlockCode, completeAt, type AwlBlockInfo, type AwlContext } from '../src';
import { emptyIface, el, m, makeCtx } from './ctx';

const rdsysst: AwlBlockInfo = {
  name: 'RDSYSST',
  kind: 'SFC',
  number: 51,
  paramAliases: { SZL_ID: 'SSL_ID', SZL_HEADER: 'SSL_HEADER' },
  iface: emptyIface({
    input: [m('REQ', el('Bool')), m('SSL_ID', el('Word')), m('INDEX', el('Word'))],
    output: [
      m('BUSY', el('Bool')),
      m('SSL_HEADER', { kind: 'struct', members: [] }),
      m('DR', { kind: 'parameter', name: 'Any' }),
    ],
    returnType: el('Int'),
  }),
};

function withRd(): AwlContext {
  const base = makeCtx('FB');
  return {
    ...base,
    block: (ref) =>
      ('name' in ref && ref.name.toUpperCase() === 'RDSYSST') ||
      ('kind' in ref && ref.kind === 'SFC' && ref.number === 51)
        ? rdsysst
        : base.block(ref),
  };
}
const check = (net: string) => checkBlockCode([net], withRd(), 'international');
const codes = (net: string) => check(net).map((d) => d.code);

describe('alias dei parametri (SFC 51)', () => {
  it('SZL_ID e SZL_HEADER valgono come SSL_ID e SSL_HEADER', () => {
    const net =
      'CALL "RDSYSST"\n(REQ := M 0.0, SZL_ID := W#16#1C, INDEX := W#16#0, RET_VAL := MW 4, BUSY := M 0.1, SZL_HEADER := #Cplx, DR := P#M 10.0 BYTE 8)';
    expect(codes(net)).toEqual([]);
  });

  it('i nomi canonici valgono ancora', () => {
    const net =
      'CALL "RDSYSST"\n(REQ := M 0.0, SSL_ID := W#16#1C, INDEX := W#16#0, RET_VAL := MW 4, BUSY := M 0.1, SSL_HEADER := #Cplx, DR := P#M 10.0 BYTE 8)';
    expect(codes(net)).toEqual([]);
  });

  it("l'alias conta come il parametro: non risulta mancante", () => {
    const net = 'CALL "RDSYSST"\n(REQ := M 0.0, SZL_ID := W#16#1C, INDEX := W#16#0)';
    expect(codes(net)).toEqual([
      'CALL_PARAM_MISSING',
      'CALL_PARAM_MISSING',
      'CALL_PARAM_MISSING',
      'CALL_PARAM_MISSING',
    ]);
  });

  it("il tipo dell'alias si controlla come quello del canonico", () => {
    const net =
      'CALL "RDSYSST"\n(REQ := M 0.0, SZL_ID := 1.5, INDEX := W#16#0, RET_VAL := MW 4, BUSY := M 0.1, SSL_HEADER := #Cplx, DR := P#M 10.0 BYTE 8)';
    expect(codes(net)).toEqual(['CALL_PARAM_TYPE']);
  });

  it('alias e nome canonico insieme sono un doppione (CALL_PARAM_UNKNOWN sul secondo)', () => {
    const net =
      'CALL "RDSYSST"\n(REQ := M 0.0, SZL_ID := W#16#1C, SSL_ID := W#16#1C, INDEX := W#16#0, RET_VAL := MW 4, BUSY := M 0.1, SSL_HEADER := #Cplx, DR := P#M 10.0 BYTE 8)';
    const d = check(net);
    expect(d.map((x) => x.code)).toEqual(['CALL_PARAM_UNKNOWN']);
    expect(net.slice(d[0]!.range.from.offset, d[0]!.range.to.offset)).toBe('SSL_ID');
  });
});

describe('parametro Struct senza membri', () => {
  it('accetta un locale Struct o di tipo UDT, rifiuta gli altri', () => {
    const base =
      'CALL "RDSYSST"\n(REQ := M 0.0, SSL_ID := W#16#1C, INDEX := W#16#0, RET_VAL := MW 4, BUSY := M 0.1, DR := P#M 10.0 BYTE 8, SSL_HEADER := ';
    expect(codes(`${base}#Cplx)`)).toEqual([]);
    expect(codes(`${base}"Macchina")`)).toEqual([]); // tag di tipo UDT "Tipo"
    expect(codes(`${base}#Pos)`)).toEqual(['CALL_PARAM_TYPE']); // Real
    expect(codes(`${base}"Avvio")`)).toEqual(['CALL_PARAM_TYPE']); // Bool
  });
});

describe('alias dei parametri nel completamento', () => {
  it('un parametro scritto con il suo alias conta come già assegnato', () => {
    const net = 'CALL "RDSYSST"\n(REQ := M 0.0, SZL_ID := W#16#1C, ';
    const labels = completeAt([net], 0, net.length, withRd(), 'international').options.map(
      (o) => o.label,
    );
    expect(labels).not.toContain('SSL_ID');
    expect(labels).not.toContain('REQ');
    expect(labels).toContain('INDEX');
    expect(labels).toContain('SSL_HEADER');
  });
});
