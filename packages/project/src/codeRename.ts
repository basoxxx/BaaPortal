// Rinomina nel codice salvato: aggiorna i `source` delle reti AWL e gli operandi del grafico (`lad`)
// di quelle KOP/FUP. Il testo salvato usa i mnemonici internazionali. Le sorgenti esterne non si
// toccano (sono file indipendenti).
import { renameInSource, renumberInSource, type RenameTarget, type Renumber } from '@baaportal/awl';
import { mapOperands, type OperandRole } from '@baaportal/ladfbd';
import {
  renameInScl,
  renumberInScl,
  sclRenameSkipped,
  type SclRenameOptions,
} from '@baaportal/scl';
import { parseType, sameName, validateS7Name, type DataType } from '@baaportal/s7-types';
import { kopSources } from './kopSources';
import { isGraphic, type CodeBlock, type Member, type PlcDevice, type Udt } from './model';

// Stessa chiave di sameName.
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();
const MAX_DEPTH = 24;

// AWL, KOP, FUP e SCL (il testo SCL si riscrive sui token del lexer SCL, non come AWL).
const codeBlocks = (device: PlcDevice): CodeBlock[] =>
  device.blocks.filter(
    (b): b is CodeBlock =>
      b.kind !== 'DB' &&
      b.kind !== 'IDB' &&
      (b.language === 'AWL' || b.language === 'SCL' || isGraphic(b.language)),
  );

// Un operando del grafico si riscrive come operando di un'istruzione AWL, cosi valgono le stesse
// regole sui token (`"Motore"` non e `"Motore2"`, `#a` non e un simbolo).
const PREFIX: Record<OperandRole, string> = { op: 'L ', call: 'CALL ', db: 'OPN ' };

function renameOperand(
  value: string,
  role: OperandRole,
  target: RenameTarget,
  newName: string,
): string {
  const out = renameInSource(PREFIX[role] + value, target, newName, 'international');
  return out.slice(PREFIX[role].length);
}

/** Nome di un parametro di CALL dopo la rinomina: lo stesso test di `renameInSource` sulla chiamata. */
function renamePin(instance: string, name: string, target: RenameTarget, newName: string): string {
  const out = renameInSource(
    `CALL ${instance}\n(\n${name} := 0\n);`,
    target,
    newName,
    'international',
  );
  return /\(\n([\s\S]*) := 0\n\);$/.exec(out)?.[1] ?? name;
}

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

/**
 * Applica `target` alle reti dei blocchi indicati. Restituisce i blocchi SCL lasciati come sono
 * perché il nome nuovo non si può scrivere lì (vedi `sclRenameSkipped`).
 */
function rewrite(
  device: PlcDevice,
  blocks: CodeBlock[],
  target: RenameTarget,
  newName: string,
): string[] {
  const skipped: string[] = [];
  const key = nameKey(target.oldName);
  // In SCL un FB si chiama col suo DB di istanza: `"Inst_DB"(in := …)`.
  const sclOpts: SclRenameOptions =
    target.kind === 'callParam'
      ? {
          instanceDbs: device.blocks
            .filter((d) => d.kind === 'IDB' && sameName(d.instanceOf, target.block))
            .map((d) => d.name),
        }
      : {};
  for (const b of blocks) {
    let lad = false;
    for (const n of b.networks) {
      if (n.lad && isGraphic(b.language)) {
        // Scorciatoia: se il nome vecchio non compare nel grafico non c'e niente da fare.
        if (!nameKey(JSON.stringify(n.lad)).includes(key)) continue;
        n.lad = mapOperands(
          n.lad,
          (v, role) => renameOperand(v, role, target, newName),
          target.kind === 'callParam'
            ? (box, name) =>
                box.box === 'CALL' ? renamePin(box.instance, name, target, newName) : name
            : undefined,
        );
        lad = true;
        continue;
      }
      // Scorciatoia: se il nome vecchio non compare nel testo non c'e niente da fare.
      if (!nameKey(n.source).includes(key)) continue;
      if (b.language === 'SCL' && sclRenameSkipped(n.source, target, newName, sclOpts)) {
        if (!skipped.includes(b.name)) skipped.push(b.name);
        continue;
      }
      n.source =
        b.language === 'SCL'
          ? renameInScl(n.source, target, newName, sclOpts)
          : renameInSource(n.source, target, newName, 'international');
    }
    // La sorgente generata segue il grafico (come dopo ogni modifica dell'editor).
    if (lad) {
      const sources = kopSources(b, device);
      b.networks.forEach((n, i) => {
        n.source = sources[i]?.source ?? n.source;
      });
    }
  }
  return skipped;
}

const usable = (oldName: string, newName: string): boolean =>
  oldName !== newName && validateS7Name(newName).ok;

/** Tag, costante, blocco o DB: i riferimenti simbolici `"Nome"`. */
export function renameSymbolInCode(device: PlcDevice, oldName: string, newName: string): void {
  if (!usable(oldName, newName)) return;
  rewrite(device, codeBlocks(device), { kind: 'symbol', oldName }, newName);
}

/**
 * Righe delle tabelle di controllo il cui operando comincia con il simbolo `"Nome"` (da solo, o
 * seguito da `.membro` / `[indice]`): il simbolo viene riscritto con il nome nuovo.
 */
export function renameSymbolInWatchRows(device: PlcDevice, oldName: string, newName: string): void {
  if (!usable(oldName, newName)) return;
  const key = nameKey(oldName);
  for (const w of device.watchTables) {
    for (const r of w.rows) {
      const m = /^(\s*)"([^"]*)"(?=$|[.\[\s])/.exec(r.operand);
      if (m && nameKey(m[2]!) === key) {
        r.operand = `${m[1]}"${newName}"${r.operand.slice(m[0].length)}`;
      }
    }
  }
}

/**
 * Riferimenti assoluti ai blocchi (`CALL FC 1`, `OPN DB 2`, `DB2.DBW 0`, `FC1(…)`) nel codice e nelle
 * tabelle di controllo del dispositivo, con i numeri nuovi di `renumber`. Restituisce i nomi dei
 * blocchi con riferimenti che non si possono riscrivere (indiretti, o codice non analizzabile).
 */
export function renumberInCode(device: PlcDevice, renumber: Renumber): string[] {
  const unsafe = new Set<string>();
  for (const b of codeBlocks(device)) {
    let lad = false;
    for (const n of b.networks) {
      if (n.lad && isGraphic(b.language)) {
        let changed = false;
        const net = mapOperands(n.lad, (v, role) => {
          if (v.trim() === '') return v;
          const r = renumberInSource(PREFIX[role] + v, renumber, 'international');
          if (r.unsafe) unsafe.add(b.name);
          const out = r.source.slice(PREFIX[role].length);
          if (out !== v) changed = true;
          return out;
        });
        // Solo se cambia qualcosa: senza numeri nuovi il dispositivo resta com'è.
        if (changed) {
          n.lad = net;
          lad = true;
        }
        continue;
      }
      const r =
        b.language === 'SCL'
          ? renumberInScl(n.source, renumber)
          : renumberInSource(n.source, renumber, 'international');
      if (r.unsafe) unsafe.add(b.name);
      if (r.source !== n.source) n.source = r.source;
    }
    if (lad) {
      const sources = kopSources(b, device);
      b.networks.forEach((n, i) => {
        n.source = sources[i]?.source ?? n.source;
      });
    }
  }
  for (const w of device.watchTables) {
    for (const r of w.rows) {
      if (r.operand.trim() === '') continue;
      const out = renumberInSource(`L ${r.operand}`, renumber, 'international').source.slice(2);
      if (out !== r.operand) r.operand = out;
    }
  }
  return [...unsafe];
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
 * Restituisce i blocchi SCL non aggiornati perché il nome nuovo non è un identificatore SCL.
 */
export function renameMemberInCode(
  device: PlcDevice,
  owner: { kind: 'block' | 'udt'; id: string },
  memberId: string,
  oldName: string,
  newName: string,
): string[] {
  if (!usable(oldName, newName)) return [];
  if (owner.kind === 'udt') {
    const udt = device.udts.find((u) => u.id === owner.id);
    const chain = udt && chainTo(udt.members, memberId);
    if (udt && chain) renameUdtMember(device, udt, chain, newName);
    return [];
  }
  const block = device.blocks.find((b) => b.id === owner.id);
  if (!block || block.kind === 'IDB') return [];
  if (block.kind === 'DB') {
    const chain = chainTo(block.members, memberId);
    if (!chain) return [];
    const path = chain.slice(0, -1).map((m) => m.name);
    rewrite(
      device,
      codeBlocks(device),
      { kind: 'member', root: 'symbol', rootName: block.name, path, oldName },
      newName,
    );
    return [];
  }
  for (const section of SECTIONS) {
    if (block.kind === 'OB' && section !== 'temp') continue;
    const chain = chainTo(block.interface[section], memberId);
    if (chain) return renameInterfaceMember(device, block, section, chain, newName);
  }
  return [];
}

function renameInterfaceMember(
  device: PlcDevice,
  block: CodeBlock,
  section: Section,
  chain: Member[],
  newName: string,
): string[] {
  const target = chain[chain.length - 1]!;
  const oldName = target.name;
  const parents = chain.slice(0, -1).map((m) => m.name);
  // Dentro il blocco stesso: locale (o percorso con radice locale se e annidato).
  const skipped = rewrite(
    device,
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
  if (block.kind === 'OB') return skipped;
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
      const s = rewrite(
        device,
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
      for (const n of s) if (!skipped.includes(n)) skipped.push(n);
    }
  }
  if (block.kind !== 'FB' || section === 'temp') return skipped;
  // DB di istanza ("Istanza".membro) e multi-istanze (#istanza.membro), anche annidate: anche
  // attraverso il DB di istanza o le multi-istanze di un FB che contiene questo FB.
  renameNestedMember(device, { kind: 'fb', name: block.name }, parents, oldName, newName);
  return skipped;
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
  renameNestedMember(device, { kind: 'udt', name: udt.name }, parents, oldName, newName);
}

/**
 * Il membro `parents.oldName` del tipo `owner` (un UDT o un FB): ogni percorso del dispositivo il cui
 * tipo risolto e quel tipo prende il nome nuovo. Si parte da tag, membri di DB, DB di istanza e
 * locali dei blocchi e si scende per struct, UDT e FB (multi-istanze), con un limite di profondita e
 * senza girare in tondo.
 */
function renameNestedMember(
  device: PlcDevice,
  owner: { kind: 'udt' | 'fb'; name: string },
  parents: string[],
  oldName: string,
  newName: string,
): void {
  const udts = new Map<string, Udt>();
  for (const u of device.udts) if (!udts.has(nameKey(u.name))) udts.set(nameKey(u.name), u);
  const fbs = new Map<string, CodeBlock>();
  for (const b of device.blocks) {
    if (b.kind === 'FB' && !fbs.has(nameKey(b.name))) fbs.set(nameKey(b.name), b);
  }
  const ownerKey = nameKey(owner.name);
  // Come nella risoluzione dei tipi: un UDT ha la precedenza su un FB con lo stesso nome.
  const isOwner = (key: string): boolean =>
    key === ownerKey && (owner.kind === 'udt' || !udts.has(key));
  const all = codeBlocks(device);

  const emit = (root: Root, prefix: string[], scope: CodeBlock[]) => {
    rewrite(
      device,
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

  /** Un valore del tipo nominato `name`, raggiunto da `root` con il percorso `prefix`. */
  const walkNamed = (
    name: string,
    root: Root,
    prefix: string[],
    scope: CodeBlock[],
    stack: string[],
  ) => {
    const key = nameKey(name);
    if (isOwner(key)) {
      emit(root, prefix, scope);
      return;
    }
    if (stack.includes(key) || stack.length >= MAX_DEPTH) return;
    const children = udts.get(key)?.members ?? (fbs.has(key) ? fbMembers(fbs.get(key)!) : []);
    for (const c of children) walk(c, root, [...prefix, c.name], scope, [...stack, key]);
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
    if (base.kind === 'struct') {
      for (const c of m.members ?? []) walk(c, root, [...prefix, c.name], scope, stack);
    } else if (base.kind === 'named') walkNamed(base.name, root, prefix, scope, stack);
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
      // Il DB di istanza ha il tipo del suo FB: "Istanza".membro, "Istanza".multi.membro, ...
      walkNamed(b.instanceOf, { kind: 'symbol', name: b.name }, [], all, []);
    } else {
      // I locali valgono solo nel codice del loro blocco.
      for (const s of SECTIONS) {
        for (const m of b.interface[s]) walk(m, { kind: 'local', name: m.name }, [], [b], []);
      }
    }
  }
}
