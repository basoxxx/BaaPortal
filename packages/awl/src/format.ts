// Forma canonica AWL: un tab iniziale, mnemonico maiuscolo, indirizzi nel formato TIA, ';' finale.
import type { CallParam, Operand, Statement } from './ast';
import type { Mnemonic } from './instructions';
import { AREA_MNEMONICS } from './instructions';
import { parseDetailed } from './parser';

// Prefisso internazionale (area + dimensione) -> mnemonico richiesto.
function areaPrefix(area: string, size: string | null, mnemonic: Mnemonic): string {
  let key: string;
  if (area === 'T' || area === 'C') key = area;
  else if (area === 'DB' || area === 'DI') key = size ? area + size : area;
  else key = area + (size === 'X' || size === null ? '' : size);
  return AREA_MNEMONICS.get(key)?.[mnemonic] ?? key;
}

function formatOperand(source: string, op: Operand, mnemonic: Mnemonic): string {
  switch (op.kind) {
    case 'address': {
      const at = op.bit === undefined ? `${op.byte}` : `${op.byte}.${op.bit}`;
      if (op.dbSymbol) {
        const sym = source.slice(op.dbSymbol.range.from.offset, op.dbSymbol.range.to.offset);
        return `${sym}.${areaPrefix(op.area, op.size, mnemonic)}${at}`;
      }
      if (op.db !== undefined) {
        // DB qualificato: il nome del blocco resta DB/DI, il membro porta la dimensione
        return `%${op.area}${op.db}.${areaPrefix(op.area, op.size, mnemonic)}${at}`;
      }
      return `%${areaPrefix(op.area, op.size, mnemonic)}${at}`;
    }
    case 'timerCounter':
      return `%${areaPrefix(op.area, null, mnemonic)}${op.number}`;
    case 'block':
      return `%${op.blockKind}${op.number}`;
    case 'indirect': {
      const head =
        op.area === null
          ? `%${op.size === 'X' ? '' : op.size}`
          : `%${areaPrefix(op.area, op.size, mnemonic)}`;
      const inner =
        op.via.kind === 'register'
          ? `AR${op.via.ar},${op.via.offset}`
          : formatOperand(source, op.via.location, mnemonic).replace(/^%/, '');
      return `${head}[${inner}]`;
    }
    case 'labelRef':
      return op.name;
    case 'status':
    case 'special':
      return op.kind === 'status' ? op.condition : op.name;
    default:
      // simboli, locali e costanti: come scritti
      return source.slice(op.range.from.offset, op.range.to.offset);
  }
}

function formatStatement(source: string, st: Statement, mnemonic: Mnemonic): string[] {
  const def = st.instruction.def;
  const ownLine = st.label && st.label.range.from.line === st.instruction.range.from.line;
  const head = ownLine ? `${st.label!.name}:\t` : '\t';
  const name = def ? (mnemonic === 'international' ? def.id : def.german) : st.instruction.text;
  let text = name;
  if (st.operand) text += ' ' + formatOperand(source, st.operand, mnemonic);
  if (st.instanceDb) text += ', ' + formatOperand(source, st.instanceDb, mnemonic);
  const comment = st.comment === undefined ? '' : st.comment === '' ? ' //' : ` // ${st.comment}`;
  if (!st.params) return [`${head}${text};${comment}`];

  const width = Math.max(0, ...st.params.map((p) => p.name.length));
  const lines = st.params.map((p: CallParam, n) => {
    const value = p.value ? ' ' + formatOperand(source, p.value, mnemonic) : '';
    const sep = n < st.params!.length - 1 ? ',' : '';
    return `\t   ${p.name.padEnd(width)} ${p.arrow}${value}${sep}`;
  });
  return [`${head}${text}`, '\t(', ...lines, `\t);${comment}`];
}

export function formatNetwork(source: string, mnemonic: Mnemonic): string {
  const r = parseDetailed(source, mnemonic);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  for (const u of r.units) {
    if (u.hasError || u.innerComments) {
      for (let l = u.startLine; l <= u.endLine; l++) {
        out.push(source.slice(r.index.starts[l], r.index.ends[l]));
      }
    } else if (u.kind === 'blank') out.push('');
    else if (u.kind === 'comment') out.push(u.text ? `\t// ${u.text}` : '\t//');
    else if (u.kind === 'label') out.push(`${u.text}:`);
    else if (u.statement) out.push(...formatStatement(source, u.statement, mnemonic));
  }
  return out.join(eol);
}
