import { describe, expect, it } from 'vitest';
import {
  encodeReadResponse,
  encodeSzl,
  encodeUploadResponse,
  encodeUserdata,
  type S7Pdu,
} from '@baaportal/s7comm';
import { compareShape, errorOf } from '../src';

const NONE = new Uint8Array(0);

const ack = (param: Uint8Array, data: Uint8Array = NONE, errorClass = 0, errorCode = 0): S7Pdu => ({
  rosctr: 3,
  pduRef: 1,
  errorClass,
  errorCode,
  param,
  data,
});

const read = (...rs: Parameters<typeof encodeReadResponse>[0]): S7Pdu => {
  const { param, data } = encodeReadResponse(rs);
  return ack(param, data);
};

const szl = (
  index: number,
  recordLength: number,
  records: number,
  more: boolean,
  max = 1000,
  id = 0x0011,
): S7Pdu => {
  const list = {
    id,
    index,
    recordLength,
    records: Array.from({ length: records }, () => new Uint8Array(recordLength)),
  };
  const { param, data } = encodeUserdata(
    {
      method: 'response',
      group: 4,
      subfunction: 1,
      sequence: 0,
      dataUnitRef: 0,
      lastDataUnit: more,
      errorCode: 0,
    },
    encodeSzl(list, max)[0]!,
  );
  return { rosctr: 7, pduRef: 1, errorClass: 0, errorCode: 0, param, data };
};

const userdataError = (code: number): S7Pdu => {
  const { param, data } = encodeUserdata(
    {
      method: 'response',
      group: 4,
      subfunction: 1,
      sequence: 0,
      dataUnitRef: 0,
      lastDataUnit: false,
      errorCode: code,
    },
    NONE,
    0x0a,
  );
  return { rosctr: 7, pduRef: 1, errorClass: 0, errorCode: 0, param, data };
};

const okItem = (n: number, transportSize = 4) => ({
  ok: true as const,
  data: new Uint8Array(n),
  transportSize,
});
const badItem = { ok: false as const, returnCode: 0x0a, name: 'oggetto inesistente' };

describe('compareShape', () => {
  it('uguali = nessuna differenza, anche se i valori sono diversi', () => {
    const a = read({ ...okItem(2), data: Uint8Array.of(1, 2) });
    const b = read({ ...okItem(2), data: Uint8Array.of(9, 9) });
    expect(compareShape(a, b)).toEqual([]);
    expect(compareShape(szl(1, 28, 1, false), szl(1, 28, 1, false))).toEqual([]);
  });

  it('ROSCTR diverso', () => {
    expect(compareShape(read(okItem(2)), { ...read(okItem(2)), rosctr: 2 })[0]).toMatch(/ROSCTR/);
  });

  it('lettura: classe del return code e transport size per item, numero di item', () => {
    expect(compareShape(read(okItem(2), okItem(2)), read(okItem(2), badItem)).join('|')).toMatch(
      /item 1 classe/,
    );
    expect(compareShape(read(okItem(2, 4)), read(okItem(2, 9))).join('|')).toMatch(
      /transport size/,
    );
    expect(compareShape(read(okItem(2)), read(okItem(2), okItem(2))).join('|')).toMatch(
      /numero di item/,
    );
    // il codice esatto dell'errore non conta: solo la classe
    expect(
      compareShape(read(badItem), read({ ...badItem, returnCode: 0x05, name: 'indirizzo' })),
    ).toEqual([]);
  });

  it('un errore dovuto allo stato della CPU vera non è una differenza solo se richiesto', () => {
    const real = read(badItem, okItem(2));
    const fake = read(okItem(2), okItem(2));
    expect(compareShape(real, fake).join('|')).toMatch(/item 0 classe/);
    expect(compareShape(real, fake, { allowStateErrors: true })).toEqual([]);
    // ... ma l'inverso (la finta in errore, la vera no) lo è sempre
    expect(compareShape(fake, real, { allowStateErrors: true }).join('|')).toMatch(/item 0 classe/);
    const headerErr = ack(NONE, NONE, 0xd2, 0x41);
    const okAck = ack(Uint8Array.of(0x1f));
    expect(compareShape(headerErr, okAck).length).toBeGreaterThan(0);
    expect(compareShape(headerErr, okAck, { allowStateErrors: true })).toEqual([]);
  });

  it('SZL: id, indice e lunghezza del record', () => {
    expect(compareShape(szl(1, 28, 1, false), szl(6, 28, 1, false)).join('|')).toMatch(
      /SZL indice/,
    );
    expect(compareShape(szl(1, 28, 1, false), szl(1, 34, 1, false)).join('|')).toMatch(
      /lunghezza record/,
    );
    expect(
      compareShape(szl(1, 28, 1, false, 1000, 0x0011), szl(1, 28, 1, false, 1000, 0x0111)).join(
        '|',
      ),
    ).toMatch(/SZL id/);
  });

  it('SZL: la frammentazione conta solo se coerente con la lunghezza della lista', () => {
    // due liste di dimensione diversa: una sta in un pezzo, l'altra no. Ciascuna è coerente: vale
    const big = (): S7Pdu => {
      const list = {
        id: 0x0000,
        index: 0,
        recordLength: 2,
        records: Array.from({ length: 50 }, () => new Uint8Array(2)),
      };
      const { param, data } = encodeUserdata(
        {
          method: 'response',
          group: 4,
          subfunction: 1,
          sequence: 1,
          dataUnitRef: 1,
          lastDataUnit: true,
          errorCode: 0,
        },
        encodeSzl(list, 40)[0]!,
      );
      return { rosctr: 7, pduRef: 1, errorClass: 0, errorCode: 0, param, data };
    };
    expect(compareShape(big(), szl(0, 2, 10, false, 1000, 0x0000))).toEqual([]);
    // lo stesso numero di record, ma una dice "altri pezzi" senza averne: incoerente
    expect(compareShape(szl(1, 28, 2, false), szl(1, 28, 2, true)).join('|')).toMatch(
      /frammentazione/,
    );
  });

  it('userdata: errore nel parametro, return code e ROSCTR', () => {
    expect(compareShape(szl(1, 28, 1, false), userdataError(0xd402)).join('|')).toMatch(
      /errore nel parametro/,
    );
    // due errori userdata con codici diversi hanno la stessa forma
    expect(compareShape(userdataError(0xd402), userdataError(0xd209))).toEqual([]);
    expect(compareShape(userdataError(0xd402), userdataError(0xd402))).toEqual([]);
  });

  it('upload: il flag "altri pezzi" e le intestazioni', () => {
    const chunk = (more: boolean): S7Pdu => {
      const { param, data } = encodeUploadResponse(more, new Uint8Array(10));
      return ack(param, data);
    };
    expect(compareShape(chunk(true), chunk(true))).toEqual([]);
    expect(compareShape(chunk(true), chunk(false)).join('|')).toMatch(/altri pezzi/);
  });

  it('errorOf: descrive gli errori, non quelli parziali delle letture', () => {
    expect(errorOf(read(okItem(2)))).toBeUndefined();
    expect(errorOf(read(okItem(2), badItem))).toBeUndefined();
    expect(errorOf(read(badItem))).toMatch(/0xa/);
    expect(errorOf(ack(NONE, NONE, 0xd2, 0x41))).toMatch(/0xd2.*0x41/);
    expect(errorOf(userdataError(0xd402))).toMatch(/0xd402/);
    expect(errorOf(szl(1, 28, 1, false))).toBeUndefined();
  });
});
