import { parseType, type DataType, type TypedMember, type TypeResolver } from '@baaportal/s7-types';
import { sameName } from '@baaportal/s7-types';
import type { Member, PlcDevice } from './model';

function withStructMembers(type: DataType, members: Member[] | undefined): DataType {
  if (type.kind === 'struct') return { kind: 'struct', members: toTypedMembers(members ?? []) };
  if (type.kind === 'array') {
    return { ...type, element: withStructMembers(type.element, members) };
  }
  return type;
}

/** Converte i membri in membri tipizzati; salta quelli con tipo non valido. */
export function toTypedMembers(members: Member[]): TypedMember[] {
  const out: TypedMember[] = [];
  for (const m of members) {
    const parsed = parseType(m.type);
    if (!parsed.ok) continue;
    out.push({ name: m.name, type: withStructMembers(parsed.type, m.members) });
  }
  return out;
}

/** Risolve i tipi con nome: prima gli UDT, poi gli FB. */
export function typeResolver(device: PlcDevice): TypeResolver {
  return (name) => {
    const udt = device.udts.find((u) => sameName(u.name, name));
    if (udt) return { kind: 'udt', members: toTypedMembers(udt.members) };
    const fb = device.blocks.find((b) => b.kind === 'FB' && sameName(b.name, name));
    if (fb && fb.kind === 'FB') {
      const i = fb.interface;
      return {
        kind: 'fb',
        sections: {
          input: toTypedMembers(i.input),
          output: toTypedMembers(i.output),
          inOut: toTypedMembers(i.inOut),
          static: toTypedMembers(i.static),
        },
      };
    }
    return null;
  };
}

export function memberPath(parent: string, child: string | number[]): string {
  if (typeof child === 'string') return parent === '' ? child : `${parent}.${child}`;
  return `${parent}[${child.join(',')}]`;
}
