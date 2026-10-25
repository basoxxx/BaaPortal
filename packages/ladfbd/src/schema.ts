import { z } from 'zod';
import { BOX_KINDS, CMP_FNS } from './model.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from './model.js';

// looseObject: le chiavi sconosciute (di versioni future) si conservano.
const obj = z.looseObject;
const id = z.string().min(1);
const dir = z.enum(['P', 'N']);

export const ladBoxSchema = obj({
  id,
  k: z.literal('box'),
  box: z.enum(BOX_KINDS),
  instance: z.string(),
  pins: z.record(z.string(), z.string()),
  boolPins: z.record(
    z.string(),
    z.lazy(() => z.array(ladElemSchema)),
  ),
});

export const ladElemSchema: z.ZodType<LadElem> = z.lazy(() =>
  z.discriminatedUnion('k', [
    obj({ id, k: z.literal('contact'), neg: z.boolean(), op: z.string() }),
    obj({ id, k: z.literal('not') }),
    obj({ id, k: z.literal('cmp'), fn: z.enum(CMP_FNS), in1: z.string(), in2: z.string() }),
    obj({ id, k: z.literal('edge'), dir, mem: z.string() }),
    obj({ id, k: z.literal('posneg'), dir, bit: z.string(), mem: z.string() }),
    obj({ id, k: z.literal('midline'), op: z.string() }),
    obj({ id, k: z.literal('parallel'), branches: z.array(z.array(ladElemSchema)).min(2) }),
    ladBoxSchema,
  ]),
) as z.ZodType<LadElem>;

export const ladOutSchema: z.ZodType<LadOut> = z.discriminatedUnion('k', [
  obj({ id, k: z.enum(['coil', 'set', 'reset']), op: z.string() }),
  obj({
    id,
    k: z.literal('tcoil'),
    fn: z.enum(['SP', 'SE', 'SD', 'SS', 'SF']),
    timer: z.string(),
    value: z.string(),
  }),
  obj({
    id,
    k: z.literal('ccoil'),
    fn: z.enum(['SC', 'CU', 'CD']),
    counter: z.string(),
    value: z.string(),
  }),
  obj({ id, k: z.enum(['jmp', 'jmpn']), label: z.string() }),
  obj({ id, k: z.enum(['ret', 'save', 'mcrOpen', 'mcrClose', 'mcra', 'mcrd']) }),
  obj({ id, k: z.literal('callCoil'), block: z.string() }),
  obj({ id, k: z.literal('opn'), db: z.string() }),
]) as z.ZodType<LadOut>;

export const ladNodeSchema: z.ZodType<LadNode> = z.lazy(() =>
  obj({
    id,
    series: z.array(ladElemSchema),
    outs: z.array(z.union([ladNodeSchema, ladOutSchema])),
  }),
) as z.ZodType<LadNode>;

export const ladNetworkSchema: z.ZodType<LadNetwork> = obj({
  label: z.string().optional(),
  root: ladNodeSchema,
}) as z.ZodType<LadNetwork>;
