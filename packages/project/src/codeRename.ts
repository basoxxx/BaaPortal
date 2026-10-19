// Rinomina nel codice AWL salvato: aggiorna i `source` delle reti di tutti i blocchi di codice.
// Il testo salvato usa i mnemonici internazionali. Le sorgenti esterne non si toccano (sono file indipendenti).
import { renameInSource, type RenameTarget } from '@baaportal/awl';
import { parseType, sameName, validateS7Name, type DataType } from '@baaportal/s7-types';
import type { CodeBlock, Member, PlcDevice, Udt } from './model';

// Stessa chiave di sameName.
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();
const MAX_DEPTH = 24;

const codeBlocks = (device: PlcDevice): CodeBlock[] =>
  device.blocks.filter((b): b is CodeBlock => b.kind !== 'DB' && b.kind !== 'IDB');

type Section = 'input' | 'output' | 'inOut' | 'static' | 'temp';
const SECTIONS: Section[] = ['input', 'output', 'inOut', 'static', 'temp'];
/** Le sezioni visibili dall'esterno (DB di istanza, multi-istanze). */
const EXTERNAL: Section[] = ['input', 'output', 'inOut', 'static'];

const fbMembers = (fb: CodeBlock): Member[] => EXTERNAL.flatMap((s) => fb.interface[s]);

const baseType = (t: DataType): DataType => (t.kind === 'array' ? baseType(t.element) : t);

/** Il nome del tipo nominato (anche come elemento di un array) di un membro, se c'e. */
function namedTypeOf(m: Member): string | undefined {
  const parsed = parseType(m.type);
  if (!parsed.ok) return undefined;
  const base = baseType(parsed.type);
  return base.kind === 'named' ? base.name : undefined;
}

/** Applica `target` alle reti dei blocchi indicati. */
function rewrite(blocks: CodeBlock[], target: RenameTarget, newName: string): void {
  const key = nameKey(target.oldName);
  for (const b of blocks) {
    for (const n of b.networks) {
      // Scorciatoia: se il nome vecchio non compare nel testo non c'e niente da fare.
      if (!nameKey(n.source).includes(key)) continue;
      n.source = renameInSource(n.source, target, newName, 'international');
    }
  }
}

const usable = (oldName: string, newName: string): boolean =>
  oldName !== newName && validateS7Name(newName).ok;

/** Tag, costante, blocco o DB: i riferimenti simbolici `"Nome"`. */
export function renameSymbolInCode(device: PlcDevice, oldName: string, newName: string): void {
  if (!usable(oldName, newName)) return;
  rewrite(codeBlocks(device), { kind: 'symbol', oldName }, newName);
}

/** Il membro con `id` e la catena dei suoi antenati (dal livello superiore al membro). */
function chainTo(list: Member[], id: string): Member[] | undefined {
  for (const m of list) {
    if (m.id === id) return [m];
    const inner = m.members ? chainTo(m.members, id) : undefined;
    if (inner) return [m, ...inner];
  }
  return undefined;
}

/**
 * Rinomina di un membro (chiamare prima di cambiargli il nome): aggiorna il codice che lo usa.
 * Dove non si puo stabilire con certezza a cosa si riferisce un percorso, il codice resta com'e.
 */
export function renameMemberInCode(
  device: PlcDevice,
  owner: { kind: 'block' | 'udt'; id: string },
  memberId: string,
  oldName: string,
  newName: string,
): void {
  if (!usable(oldName, newName)) return;
  if (owner.kind === 'udt') {
    const udt = device.udts.find((u) => u.id === owner.id);
    const chain = udt && chainTo(udt.members, memberId);
    if (udt && chain) renameUdtMember(device, udt, chain, newName);
    return;
  }
  const block = device.blocks.find((b) => b.id === owner.id);
  if (!block || block.kind === 'IDB') return;
  if (block.kind === 'DB') {
    const chain = chainTo(block.members, memberId);
    if (!chain) return;
    const path = chain.slice(0, -1).map((m) => m.name);
    rewrite(
      codeBlocks(device),
      { kind: 'member', root: 'symbol', rootName: block.name, path, oldName },
      newName,
    );
    return;
  }
  for (const section of SECTIONS) {
    if (block.kind === 'OB' && section !== 'temp') continue;
    const chain = chainTo(block.interface[section], memberId);
    if (chain) {
      renameInterfaceMember(device, block, section, chain, newName);
      return;
    }
  }
}

function renameInterfaceMember(
  device: PlcDevice,
  block: CodeBlock,
  section: Section,
  chain: Member[],
  newName: string,
): void {
  const target = chain[chain.length - 1]!;
  const oldName = target.name;
  const parents = chain.slice(0, -1).map((m) => m.name);
  // Dentro il blocco stesso: locale (o percorso con radice locale se e annidato).
  rewrite(
    [block],
    parents.length === 0
      ? { kind: 'local', oldName }
      : {
          kind: 'member',
          root: 'local',
          rootName: chain[0]!.name,
          path: parents.slice(1),
          oldName,
        },
    newName,
  );
  if (block.kind === 'OB') return;
  const all = codeBlocks(device);
  const isParam =
    parents.length === 0 && (section === 'input' || section === 'output' || section === 'inOut');
  // Per un FC o un FB: i parametri nei CALL (per nome, per numero e per multi-istanza).
  if (isParam) {
    for (const caller of all) {
      const instances =
        block.kind === 'FB'
          ? caller.interface.static
              .filter((m) => {
                const t = namedTypeOf(m);
                return t !== undefined && sameName(t, block.name);
              })
              .map((m) => m.name)
          : [];
      rewrite(
        [caller],
        {
          kind: 'callParam',
          block: block.name,
          oldName,
          number: { kind: block.kind, number: block.number },
          ...(instances.length > 0 ? { instances } : {}),
        },
        newName,
      );
    }
  }
  if (block.kind !== 'FB' || section === 'temp') return;
  // I DB di istanza: "Istanza".membro.
  for (const idb of device.blocks) {
    if (idb.kind !== 'IDB' || !sameName(idb.instanceOf, block.name)) continue;
    rewrite(
      all,
      { kind: 'member', root: 'symbol', rootName: idb.name, path: parents, oldName },
      newName,
    );
  }
  // Le multi-istanze negli altri FB: #istanza.membro.
  for (const caller of all) {
    if (caller.kind !== 'FB') continue;
    for (const inst of caller.interface.static) {
      const t = namedTypeOf(inst);
      if (t === undefined || !sameName(t, block.name)) continue;
      rewrite(
        [caller],
        { kind: 'member', root: 'local', rootName: inst.name, path: parents, oldName },
        newName,
      );
    }
  }
}

interface Root {
  kind: 'symbol' | 'local';
  name: string;
}

/**
 * Membro di un UDT: un riferimento esatto per ogni percorso del dispositivo il cui tipo risolto e
 * quell'UDT (tag, membri di DB, DB di istanza, locali dei blocchi), anche attraverso struct, altri UDT
 * e FB annidati.
 */
function renameUdtMember(device: PlcDevice, udt: Udt, chain: Member[], newName: string): void {
  const oldName = chain[chain.length - 1]!.name;
  const parents = chain.slice(0, -1).map((m) => m.name);
  const udts = new Map<string, Udt>();
  for (const u of device.udts) if (!udts.has(nameKey(u.name))) udts.set(nameKey(u.name), u);
  const fbs = new Map<string, CodeBlock>();
  for (const b of device.blocks) {
    if (b.kind === 'FB' && !fbs.has(nameKey(b.name))) fbs.set(nameKey(b.name), b);
  }
  const all = codeBlocks(device);

  const emit = (root: Root, prefix: string[], scope: CodeBlock[]) => {
    rewrite(
      scope,
      {
        kind: 'member',
        root: root.kind,
        rootName: root.name,
        path: [...prefix, ...parents],
        oldName,
      },
      newName,
    );
  };

  const walk = (
    m: Pick<Member, 'type' | 'members'>,
    root: Root,
    prefix: string[],
    scope: CodeBlock[],
    stack: string[],
  ) => {
    if (stack.length > MAX_DEPTH) return;
    const parsed = parseType(m.type);
    if (!parsed.ok) return;
    const base = baseType(parsed.type);
    const into = (children: Member[], via: string[]) => {
      for (const c of children) walk(c, root, [...prefix, c.name], scope, via);
    };
    if (base.kind === 'struct') {
      into(m.members ?? [], stack);
    } else if (base.kind === 'named') {
      const key = nameKey(base.name);
      if (key === nameKey(udt.name)) {
        // Prima gli UDT, come nella risoluzione dei tipi.
        emit(root, prefix, scope);
        return;
      }
      if (stack.includes(key)) return;
      const inner = udts.get(key);
      if (inner) into(inner.members, [...stack, key]);
      else {
        const fb = fbs.get(key);
        if (fb) into(fbMembers(fb), [...stack, key]);
      }
    }
  };

  for (const table of device.tagTables) {
    for (const tag of table.tags) {
      walk({ type: tag.type }, { kind: 'symbol', name: tag.name }, [], all, []);
    }
  }
  for (const b of device.blocks) {
    if (b.kind === 'DB') {
      for (const m of b.members) walk(m, { kind: 'symbol', name: b.name }, [m.name], all, []);
    } else if (b.kind === 'IDB') {
      const fb = fbs.get(nameKey(b.instanceOf));
      if (!fb) continue;
      for (const m of fbMembers(fb)) walk(m, { kind: 'symbol', name: b.name }, [m.name], all, []);
    } else {
      // I locali valgono solo nel codice del loro blocco.
      for (const s of SECTIONS) {
        for (const m of b.interface[s]) walk(m, { kind: 'local', name: m.name }, [], [b], []);
      }
    }
  }
}
